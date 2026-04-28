// pages/api/cron/sync-followups.ts
// Vercel Cron worker — drives the follow-up sync pipeline end-to-end.
//
// SCHEDULE: every 5 minutes (configured in vercel.json). Aligns with the
// existing FreePBX CDR sync cadence so summaries appear in Monday/AC within
// ~10 min of a call ending.
//
// PIPELINE per call (REVISED — AC drives Monday):
//   1. Find call_analysis rows where follow_up_summary IS NULL → ENQUEUE.
//   2. Claim N pending jobs (FOR UPDATE SKIP LOCKED via RPC).
//   3. For each job:
//      a. Generate follow_up_summary via Claude → write to call_analysis
//         (now includes structured `email` field if mentioned in transcript)
//      b. Resolve AC contact: search by phone → email → name. If found,
//         pull full profile (name, email, phone, postcode from custom field)
//         and backfill missing fields. If not found, create with rep as owner.
//      c. Push to Monday using AC profile data (preferred over call data)
//      d. Post note + apply tag to AC contact
//      e. Mark job done.
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
import { resolveContactForCall, postNoteAndTag } from '../../../lib/activecampaign'

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
    console.warn('[cron-followups] claim_followup_jobs RPC missing, using fallback')
    const fallback = await fallbackClaim(sb, BATCH_SIZE, workerId)
    return processClaimed(sb, fallback, t0, enqueued, res)
  }

  return processClaimed(sb, claimed || [], t0, enqueued, res)
}

// ── Enqueue helpers ────────────────────────────────────────────────────

async function enqueueNewJobs(sb: any): Promise<number> {
  const { data, error } = await sb.rpc('enqueue_pending_followup_jobs')
  if (error) {
    console.warn('[cron-followups] enqueue RPC failed, skipping enqueue this run:', error.message)
    return 0
  }
  return Number(data) || 0
}

async function fallbackClaim(sb: any, batchSize: number, workerId: string) {
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

      const repName = ctx.effective_advisor_name || ctx.agent_name

      // ── Stage A: generate summary if not already present ──
      let summary = analysis.follow_up_summary
      if (!summary) {
        const gen = await generateFollowUpSummary(transcript, {
          direction: ctx.direction,
          agent_name: repName,
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
        agentName: repName || undefined,
        callDate: ctx.call_date,
        durationSec: ctx.duration_seconds,
      })

      // ── Stage B: Resolve AC contact (find or create, with profile) ──
      // This MUST happen before Monday so we can populate Monday with
      // proper customer name/email/postcode from AC.
      let acContact: any = null
      let acAction = 'unknown'
      let acReason: string | undefined

      try {
        const resolved = await resolveContactForCall({
          phone: ctx.external_number,
          email: summary.email || null,
          whoWhat: summary.who_what || null,
          agentName: repName,
        })

        if (resolved.contact) {
          acContact = resolved.contact
          acAction = resolved.action
        } else {
          acAction = resolved.action
          acReason = resolved.reason
        }

        await sb.from('call_analysis')
          .update({
            ac_contact_id: resolved.contact?.id || null,
            ac_synced_at: new Date().toISOString(),
            ac_sync_error: resolved.action === 'skipped' ? resolved.reason : null,
          })
          .eq('id', analysis.id)
      } catch (e: any) {
        acReason = e?.message || String(e)
        await sb.from('call_analysis')
          .update({ ac_sync_error: acReason, ac_synced_at: new Date().toISOString() })
          .eq('id', analysis.id)
      }

      // ── Stage C: Monday push (with AC profile data preferred) ──
      let mondayOk = true
      let mondayErr: string | undefined
      try {
        const monday = await syncFollowUpToMonday({
          agentName: repName,
          callerName: ctx.caller_name,
          phone: acContact?.phone || ctx.external_number,
          customerFirstName: acContact?.firstName || null,
          customerLastName: acContact?.lastName || null,
          email: acContact?.email || summary.email || null,
          postcode: acContact?.postcode || null,
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

      // ── Stage D: Post note + tag on AC contact (if we have one) ──
      let acNoteOk = true
      let acNoteErr: string | undefined
      if (acContact) {
        try {
          await postNoteAndTag(acContact.id, noteBody)
          result.ac = { action: acAction, contactId: acContact.id }
        } catch (e: any) {
          acNoteOk = false
          acNoteErr = e?.message || String(e)
          await sb.from('call_analysis')
            .update({ ac_sync_error: `note+tag failed: ${acNoteErr}` })
            .eq('id', analysis.id)
        }
      } else {
        // No AC contact — already recorded skip reason in Stage B
        result.ac = { action: acAction, contactId: null }
      }

      // ── Mark job done ──
      // Even if Monday or AC failed, terminal — errors visible via
      // call_analysis.{monday,ac}_sync_error. Don't auto-retry pushes
      // because they're not idempotent (would create dupes).
      await sb.from('follow_up_sync_jobs')
        .update({
          status: 'done',
          completed_at: new Date().toISOString(),
          stage: 'done',
          error_message: !mondayOk || !acNoteOk
            ? `Monday: ${mondayOk ? 'ok' : mondayErr || '?'} | AC note: ${acNoteOk ? 'ok' : acNoteErr || '?'}`
            : null,
        })
        .eq('id', job.id)

      result.ok = mondayOk && acNoteOk
      result.error = result.ok ? undefined : `monday=${mondayOk ? 'ok' : 'FAIL'}, ac=${acNoteOk ? 'ok' : 'FAIL'}`
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
