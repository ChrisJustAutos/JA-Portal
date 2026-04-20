// pages/api/backfill/runs/[id]/execute.ts
// POST — process up to `batchSize` pending matches, link each via Monday API,
// update execute_status. Returns counters so the client can loop/show progress.
//
// Why batches: 599 mutations at ~1s each = 10 min, which exceeds the 300s function limit.
// The client polls by calling this endpoint repeatedly until { remaining: 0 }.
//
// Admin only. Respects `skipIds` (array of match ids to skip this run).

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { withAuth, audit } from '../../../../../lib/authServer'
import { linkQuoteToOrder } from '../../../../../lib/backfill/monday'

export const config = { maxDuration: 300 }

function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!
  return createClient(url, key, { auth: { persistSession: false } })
}

async function handler(req: NextApiRequest, res: NextApiResponse, user: any) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
  const { id } = req.query
  if (typeof id !== 'string') return res.status(400).json({ error: 'id required' })

  const { batchSize = 25, skipIds = [] } = req.body || {}

  const sb = getServiceClient()

  // Check run state
  const { data: run } = await sb.from('backfill_runs').select('id, status').eq('id', id).single()
  if (!run) return res.status(404).json({ error: 'Run not found' })
  if (run.status !== 'ready' && run.status !== 'executing') {
    return res.status(409).json({ error: `Cannot execute run in status "${run.status}"` })
  }

  // Mark as executing (idempotent — okay to set every time)
  await sb.from('backfill_runs').update({ status: 'executing' }).eq('id', id).eq('status', 'ready')

  // Mark any requested skips
  if (Array.isArray(skipIds) && skipIds.length > 0) {
    await sb.from('backfill_matches')
      .update({ execute_status: 'skipped', executed_at: new Date().toISOString() })
      .eq('run_id', id)
      .in('id', skipIds.map(Number))
      .eq('execute_status', 'pending')
  }

  // Pull the next batch of pending matches
  const { data: pending, error: pErr } = await sb
    .from('backfill_matches')
    .select('id, order_id, matched_quote_id, order_name, matched_quote_name')
    .eq('run_id', id)
    .eq('execute_status', 'pending')
    .not('matched_quote_id', 'is', null)
    .order('id', { ascending: true })
    .limit(Number(batchSize) || 25)

  if (pErr) return res.status(500).json({ error: pErr.message })

  let success = 0, failed = 0
  const errors: Array<{ id: number; error: string }> = []

  for (const row of pending || []) {
    const { ok, error } = await linkQuoteToOrder(row.order_id, row.matched_quote_id!)
    if (ok) {
      success++
      await sb.from('backfill_matches').update({
        execute_status: 'success',
        execute_error: null,
        executed_at: new Date().toISOString(),
      }).eq('id', row.id)
    } else {
      failed++
      errors.push({ id: row.id, error: error || 'unknown' })
      await sb.from('backfill_matches').update({
        execute_status: 'failed',
        execute_error: error || 'unknown',
        executed_at: new Date().toISOString(),
      }).eq('id', row.id)
    }
    // Small delay to stay under Monday's complexity/rate limits (10k per minute default)
    await new Promise(r => setTimeout(r, 100))
  }

  // Count remaining
  const { count: remaining } = await sb
    .from('backfill_matches')
    .select('*', { count: 'exact', head: true })
    .eq('run_id', id)
    .eq('execute_status', 'pending')

  // Count totals for this run
  const { data: totals } = await sb
    .from('backfill_matches')
    .select('execute_status')
    .eq('run_id', id)
  const totalSuccess = (totals || []).filter(r => r.execute_status === 'success').length
  const totalFailed = (totals || []).filter(r => r.execute_status === 'failed').length
  const totalSkipped = (totals || []).filter(r => r.execute_status === 'skipped').length

  // If done, flip run status + update summary
  if ((remaining ?? 0) === 0) {
    const { data: runNow } = await sb.from('backfill_runs').select('summary').eq('id', id).single()
    const updatedSummary = {
      ...(runNow?.summary || {}),
      executeSuccess: totalSuccess,
      executeFailed: totalFailed,
      executeSkipped: totalSkipped,
    }
    await sb.from('backfill_runs').update({
      status: 'executed',
      executed_at: new Date().toISOString(),
      summary: updatedSummary,
    }).eq('id', id)
    await audit(user, 'backfill.executed', {
      run_id: id,
      total_success: totalSuccess,
      total_failed: totalFailed,
      total_skipped: totalSkipped,
    })
  }

  return res.status(200).json({
    batchProcessed: (pending || []).length,
    success,
    failed,
    errors,
    remaining: remaining ?? 0,
    totals: { success: totalSuccess, failed: totalFailed, skipped: totalSkipped },
  })
}

export default withAuth('admin:settings', handler)
