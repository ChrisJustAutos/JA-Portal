// pages/api/backfill/dry-run.ts
// POST { runId, startDate?, endDate? } → fetches Monday orders in window and all
// quotes across the 5 rep boards, runs the matcher, writes the plan to backfill_matches,
// updates the run's status+summary. Admin only.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../lib/authServer'
import { fetchOrdersInWindow, fetchAllQuotes } from '../../../lib/backfill/monday'
import { buildMatchPlan, type MdJobRow } from '../../../lib/backfill/matcher'
import { DEFAULT_BACKFILL_START, DEFAULT_BACKFILL_END, type BackfillSummary, type MatchStatus } from '../../../lib/backfill/types'

export const config = { maxDuration: 300 }

function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!
  return createClient(url, key, { auth: { persistSession: false } })
}

async function handler(req: NextApiRequest, res: NextApiResponse, user: any) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  const { runId, startDate = DEFAULT_BACKFILL_START, endDate = DEFAULT_BACKFILL_END } = req.body || {}
  if (!runId) return res.status(400).json({ error: 'runId is required' })

  const sb = getServiceClient()

  // Verify run exists and is in a state we can re-match
  const { data: run, error: runErr } = await sb
    .from('backfill_runs')
    .select('id, status')
    .eq('id', runId)
    .single()
  if (runErr || !run) return res.status(404).json({ error: 'Run not found' })
  if (run.status === 'executing' || run.status === 'executed') {
    return res.status(409).json({ error: `Cannot re-match a run in status "${run.status}".` })
  }

  // Mark as matching
  await sb.from('backfill_runs').update({ status: 'matching', error_message: null }).eq('id', runId)

  // Clear any previous matches (in case of re-run)
  await sb.from('backfill_matches').delete().eq('run_id', runId)

  try {
    // Load MD jobs for this run
    const { data: mdJobs, error: jobsErr } = await sb
      .from('backfill_jobs')
      .select('job_number, customer_email_norm, customer_phone_norm, created_by, created_date')
      .eq('run_id', runId)
    if (jobsErr || !mdJobs) throw new Error(`Could not load MD jobs: ${jobsErr?.message}`)

    // Pull Monday data in parallel (big calls — run them concurrently)
    const [orders, quotes] = await Promise.all([
      fetchOrdersInWindow(startDate, endDate),
      fetchAllQuotes(),
    ])

    // Tally quote board counts for the summary
    const quotesByBoard: Record<string, number> = {}
    for (const q of quotes) quotesByBoard[q.boardId] = (quotesByBoard[q.boardId] ?? 0) + 1

    // Build the match plan
    const plan = buildMatchPlan(orders, quotes, mdJobs as MdJobRow[])

    // Write plan in batches
    const insertBatch = 500
    for (let i = 0; i < plan.length; i += insertBatch) {
      const batch = plan.slice(i, i + insertBatch).map(row => ({
        run_id: runId,
        order_id: row.order_id,
        order_name: row.order_name,
        order_date: row.order_date,
        order_status: row.order_status,
        already_linked: row.already_linked,
        job_number: row.job_number,
        md_email_norm: row.md_email_norm,
        md_rep: row.md_rep,
        match_status: row.match_status,
        matched_quote_id: row.matched_quote_id,
        matched_quote_name: row.matched_quote_name,
        matched_quote_board_id: row.matched_quote_board_id,
        matched_quote_date: row.matched_quote_date,
        matched_quote_status: row.matched_quote_status,
        days_before_order: row.days_before_order,
        alternatives_count: row.alternatives_count,
        execute_status: row.match_status === 'matched' || row.match_status === 'matched_ambiguous' ? 'pending' : 'skipped',
      }))
      const { error } = await sb.from('backfill_matches').insert(batch)
      if (error) throw new Error(`Insert failed at batch ${i}: ${error.message}`)
    }

    // Compute summary
    const byMatchStatus: Record<MatchStatus, number> = {
      matched: 0, matched_ambiguous: 0, no_quote_for_email: 0, no_email_in_md: 0,
      job_not_in_md: 0, no_job_in_name: 0, already_linked: 0, skipped_invoice: 0,
    }
    for (const row of plan) byMatchStatus[row.match_status]++

    const summary: BackfillSummary = {
      ordersTotal: orders.length,
      ordersInPeriod: orders.length,  // already filtered by query
      quotesTotalByBoard: quotesByBoard,
      byMatchStatus,
      executeEligible: byMatchStatus.matched + byMatchStatus.matched_ambiguous,
    }

    await sb.from('backfill_runs').update({
      status: 'ready',
      matched_at: new Date().toISOString(),
      summary,
    }).eq('id', runId)

    return res.status(200).json({ runId, summary })
  } catch (e: any) {
    await sb.from('backfill_runs').update({
      status: 'failed',
      error_message: e.message || String(e),
    }).eq('id', runId)
    return res.status(500).json({ error: e.message || String(e) })
  }
}

export default withAuth('admin:settings', handler)
