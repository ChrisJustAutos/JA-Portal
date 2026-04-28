// pages/api/cron/sync-followups.ts
// Vercel Cron worker — drives the follow-up sync pipeline end-to-end.
//
// SCHEDULE: every 5 minutes (configured in vercel.json). Aligns with the
// existing FreePBX CDR sync cadence so summaries appear in Monday/AC within
// ~10 min of a call ending.
//
// PIPELINE per call:
//   1. Find call_analysis rows where follow_up_summary IS NULL and a
//      transcript exists → ENQUEUE in follow_up_sync_jobs (idempotent
//      via call_id unique-ish enforcement at insert time).
//   2. Claim N pending jobs (skipping any already 'processing' for >15 min
//      — those are stuck and we'll retry).
//   3. For each job:
//      a. Generate follow_up_summary via Claude → write to call_analysis
//      b. Push to Monday via syncFollowUpToMonday → write monday_* fields
//      c. Push to AC via syncFollowUpToActiveCampaign → write ac_* fields
//      d. Mark job done.
//      Any stage failure: mark job failed with error message; ops can
//      requeue manually if needed.
//
// SAFETY:
//   - Bearer token gate (CRON_SECRET) — same pattern as refresh-cache.ts
//   - FOLLOWUP_SYNC_ENABLED env var — set to 'false' to make this a no-op
//     without redeploying. Circuit breaker for emergencies.
//   - Per-run job cap (FOLLOWUP_SYNC_BATCH_SIZE) so a backlog doesn't
//     timeout the function.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { generateFollowUpSummary, renderSummaryAsNote } from '../../../lib/anthropic-followup'
import { syncFollowUpToMonday } from '../../../lib/monday-followup'
import { syncFollowUpToActiveCampaign } from '../../../lib/activecampaign'

export const config = { maxDuration: 300 }   // 5 min Vercel cron max

const BATCH_SIZE = Number(process.env.FOLLOWUP_SYNC_BATCH_SIZE || 10)
const STUCK_AFTER_MIN = 15

interface CronResult {
  startedAt: string
  enabled: boolean
  enqueued: number
  claimed: number
  results: Array<{
    jobId: string
    callId: string
    stage: string
    ok: boolean
    durationMs: number
    error?: string
    monday?: { action: string; itemId: string | null; boardName: string | null }
    ac?: { action: string; contactId: number | null }
  }>
  durationMs: number
  note?: string                              // optional human-readable note (e.g. "circuit breaker tripped")
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const t0 = Date.now()

  // ── Auth: only Vercel Cron / authenticated callers ────────────────────
  const expected = process.env.CRON_SECRET
  const auth = req.headers.authorization || ''
  if (!expected) {
    return res.status(500).json({ error: 'CRON_SECRET not configured' })
  }
  if (auth !== `Bearer ${expected}`) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const enabled = (process.env.FOLLOWUP_SYNC_ENABLED ?? 'true') !== 'false'
  if (!enabled) {
    return res.status(200).json({
      startedAt: new Date(t0).toISOString(),
      enabled: false,
      enqueued: 0,
      claimed: 0,
      results: [],
      durationMs: Date.now() - t0,
      note: 'FOLLOWUP_SYNC_ENABLED is false — circuit breaker tripped',
    } satisfies CronResult)
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    return res.status(500).json({ error: 'Supabase env vars not configured' })
  }
  const sb = createClient(url, key, { auth: { persistSession: false } })

  // ── 1. Enqueue any newly-eligible call_analysis rows ──────────────────
  // Eligible = analysed, has transcript, no follow_up_summary yet, and no
  // existing job. We avoid creating duplicates by checking against the
  // job table via NOT EXISTS.
  const enqueued = await enqueueNewJobs(sb)

  // ── 2. Reset stuck 'processing' jobs back to pending ──────────────────
  await sb
    .from('follow_up_sync_jobs')
    .update({ status: 'pending', claimed_at: null, claimed_by: null })
    .eq('status', 'processing')
    .lt('claimed_at', new Date(Date.now() - STUCK_AFTER_MIN * 60_000).toISOString())

  // ── 3. Claim a batch of pending jobs ──────────────────────────────────
  const workerId = `vercel-${process.env.VERCEL_REGION || 'local'}-${Date.now()}`
  const { data: claimed, error: claimErr } = await sb.rpc('claim_followup_jobs', {
    p_batch_size: BATCH_SIZE,
    p_worker: workerId,
  })

  if (claimErr) {
    // RPC doesn't exist yet — fall back to a simpler claim. The migration
    // file ships the RPC, but if a deploy happens before the migration
    // runs we want graceful behaviour.
    console.warn('[cron-followups] claim_followup_jobs RPC missing, using fallback')
    const fallback = await fallbackClaim(sb, BATCH_SIZE, workerId)
    return processClaimed(sb, fallback, t0, enqueued, res)
  }

  return processClaimed(sb, claimed || [], t0, enqueued, res)
}

// ── Enqueue helpers ────────────────────────────────────────────────────

async function enqueueNewJobs(sb: any): Promise<number> {
  // SQL-level upsert: insert one job per analysed call lacking follow_up_summary,
  // skipping any call that already has a queued/active/done job. The unique
  // index on (call_id, status) is permissive (we allow many jobs per call
  // for retries), so we use a NOT EXISTS subquery instead.
  const { data, error } = await sb.rpc('enqueue_pending_followup_jobs')
  if (error) {
    console.warn('[cron-followups] enqueue RPC failed, skipping enqueue this run:', error.message)
    return 0
  }
  return Number(data) || 0
}

async function fallbackClaim(sb: any, batchSize: number, workerId: string) {
  // Best-effort claim without the RPC. Race-prone but acceptable as a
  // temporary fallback during the deploy window.
  const { data: pending } = await sb
    .from('follow_up_sync_jobs')
    .select('id, call_id, analysis_id, stage, retry_count')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(batchSize)

  if (!pending || pending.length === 0) return []

  const ids = pending.map((p: any) => p.id)
  await sb
    .from('follow_up_sync_jobs')
    .update({ status: 'processing', claimed_at: new Date().toISOString(), claimed_by: workerId })
    .in('id', ids)

  return pending
}

// ── Per-job processor ──────────────────────────────────────────────────

async function processClaimed(
  sb: any,
  claimed: any[],
  t0: number,
  enqueued: number,
  res: NextApiResponse,
) {
  const results: CronResult['results'] = []

  for (const job of claimed) {
    const jobT0 = Date.now()
    const result: CronResult['results'][number] = {
      jobId: job.id,
      callId: job.call_id,
      stage: job.stage || 'summary',
      ok: false,
      durationMs: 0,
    }

    try {
      // Load call + transcript + analysis row
      const { data: ctx, error: ctxErr } = await sb
        .from('calls')
        .select(`
          id, linkedid, call_date, direction, external_number, caller_name,
          agent_name, agent_ext, duration_seconds, effective_advisor_name,
          call_transcripts!inner(full_text),
          call_analysis!inner(id, follow_up_summary)
        `)
        .eq('id', job.call_id)
        .single()

      if (ctxErr || !ctx) {
        throw new Error(`Failed to load call context: ${ctxErr?.message || 'not found'}`)
      }

      const transcript = ctx.call_transcripts?.[0]?.full_text || ctx.call_transcripts?.full_text
      const analysis = ctx.call_analysis?.[0] || ctx.call_analysis
      if (!transcript) throw new Error('Transcript not available')
      if (!analysis) throw new Error('call_analysis row missing')

      // Stage A: generate summary if not already present
      let summary = analysis.follow_up_summary
      if (!summary) {
        const gen = await generateFollowUpSummary(transcript, {
          direction: ctx.direction,
          agent_name: ctx.effective_advisor_name || ctx.agent_name,
          caller_name: ctx.caller_name,
          external_number: ctx.external_number,
          duration_seconds: ctx.duration_seconds,
          call_date: ctx.call_date,
        })
        summary = gen.summary
        await sb.from('call_analysis')
          .update({
            follow_up_summary: summary,
            follow_up_generated_at: new Date().toISOString(),
            follow_up_model: gen.model,
          })
          .eq('id', analysis.id)
      }

      const noteBody = renderSummaryAsNote(summary, {
        agentName: ctx.effective_advisor_name || ctx.agent_name || undefined,
        callDate: ctx.call_date,
        durationSec: ctx.duration_seconds,
      })

      // Stage B: Monday push
      let mondayOk = true
      let mondayErr: string | undefined
      try {
        const monday = await syncFollowUpToMonday({
          agentName: ctx.effective_advisor_name || ctx.agent_name,
          callerName: ctx.caller_name,
          phone: ctx.external_number,
          email: null,                 // No email on calls; AC has it but we'd need to fetch
          sentiment: summary.sentiment,
          noteBody,
          callDate: ctx.call_date,
        })
        await sb.from('call_analysis')
          .update({
            monday_item_id: monday.itemId,
            monday_board_id: monday.boardId,
            monday_action: monday.action,
            monday_synced_at: new Date().toISOString(),
            monday_sync_error: monday.action === 'skipped' ? monday.reason : null,
          })
          .eq('id', analysis.id)
        result.monday = { action: monday.action, itemId: monday.itemId, boardName: monday.boardName }
      } catch (e: any) {
        mondayOk = false
        mondayErr = e?.message || String(e)
        await sb.from('call_analysis')
          .update({ monday_sync_error: mondayErr, monday_synced_at: new Date().toISOString() })
          .eq('id', analysis.id)
      }

      // Stage C: AC push (independent of Monday outcome — both should run)
      let acOk = true
      let acErr: string | undefined
      try {
        const ac = await syncFollowUpToActiveCampaign({
          phone: ctx.external_number,
          noteBody,
          agentName: ctx.effective_advisor_name || ctx.agent_name,
          whoWhat: summary.who_what || null,
        })
        await sb.from('call_analysis')
          .update({
            ac_contact_id: ac.contactId,
            ac_synced_at: new Date().toISOString(),
            ac_sync_error: ac.action === 'skipped' ? ac.reason : null,
          })
          .eq('id', analysis.id)
        result.ac = { action: ac.action, contactId: ac.contactId }
      } catch (e: any) {
        acOk = false
        acErr = e?.message || String(e)
        await sb.from('call_analysis')
          .update({ ac_sync_error: acErr, ac_synced_at: new Date().toISOString() })
          .eq('id', analysis.id)
      }

      // Mark job done — even if Monday or AC failed, we treat it as terminal.
      // Errors are visible via call_analysis.{monday,ac}_sync_error and
      // ops can manually requeue if needed. We don't auto-retry pushes
      // because they're not idempotent (would create duplicate notes).
      await sb.from('follow_up_sync_jobs')
        .update({
          status: 'done',
          completed_at: new Date().toISOString(),
          stage: 'done',
          error_message: !mondayOk || !acOk
            ? `Monday: ${mondayOk ? 'ok' : mondayErr || '?'} | AC: ${acOk ? 'ok' : acErr || '?'}`
            : null,
        })
        .eq('id', job.id)

      result.ok = mondayOk && acOk
      result.error = result.ok ? undefined : `monday=${mondayOk ? 'ok' : 'FAIL'}, ac=${acOk ? 'ok' : 'FAIL'}`
    } catch (e: any) {
      const errMsg = e?.message || String(e)
      console.error(`[cron-followups] job ${job.id} failed:`, errMsg)
      await sb.from('follow_up_sync_jobs')
        .update({
          status: 'failed',
          failed_at: new Date().toISOString(),
          error_message: errMsg.substring(0, 1000),
          retry_count: (job.retry_count || 0) + 1,
        })
        .eq('id', job.id)
      result.error = errMsg
    } finally {
      result.durationMs = Date.now() - jobT0
      results.push(result)
    }
  }

  const ok = results.filter(r => r.ok).length
  const failed = results.filter(r => !r.ok).length
  console.log(`[cron-followups] enqueued=${enqueued} claimed=${claimed.length} ok=${ok} failed=${failed}`)

  return res.status(200).json({
    startedAt: new Date(t0).toISOString(),
    enabled: true,
    enqueued,
    claimed: claimed.length,
    results,
    durationMs: Date.now() - t0,
  } satisfies CronResult)
}
