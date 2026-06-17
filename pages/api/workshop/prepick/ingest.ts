// pages/api/workshop/prepick/ingest.ts
// Service-token endpoint the MechanicDesk Pre Pick worker POSTs to.
//   POST { action: 'start',  from, to, requested_by? }      → { run_id } (status 'running')
//   POST { action: 'finish', run_id, jobs_count, items[] }  → marks 'done' + stores items
//   POST { action: 'error',  run_id, error }                → marks 'error'
// Auth: X-Service-Token with the stocktake:write scope (same token the other
// MechanicDesk workers use).

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { validateServiceToken } from '../../../../lib/service-auth'

export const config = { maxDuration: 30, api: { bodyParser: { sizeLimit: '8mb' } } }

function sb(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }) }
  const svc = await validateServiceToken(req, 'stocktake:write')
  if (!svc) return res.status(401).json({ error: 'Unauthorised — service token required' })

  let body: any = {}
  try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
  catch { return res.status(400).json({ error: 'Bad JSON body' }) }

  const db = sb()
  const action = String(body.action || '')

  if (action === 'start') {
    const from = String(body.from || ''); const to = String(body.to || '')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return res.status(400).json({ error: 'from/to (YYYY-MM-DD) required' })
    // If the refresh endpoint already created a pending row, flip it to running
    // instead of creating a second row. Otherwise (e.g. a scheduled run with no
    // pre-created row), insert a fresh one.
    const existingId = String(body.run_id || '')
    if (existingId) {
      const { data, error } = await db.from('md_prepick_runs')
        .update({ status: 'running', from_date: from, to_date: to })
        .eq('id', existingId).select('id').maybeSingle()
      if (error) return res.status(500).json({ error: error.message })
      if (data) return res.status(200).json({ run_id: data.id })
      // Row vanished — fall through to insert a new one.
    }
    const { data, error } = await db.from('md_prepick_runs')
      .insert({ from_date: from, to_date: to, status: 'running', requested_by: String(body.requested_by || 'worker').slice(0, 120) })
      .select('id').single()
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ run_id: data.id })
  }

  const runId = String(body.run_id || '')
  if (!runId) return res.status(400).json({ error: 'run_id required' })

  if (action === 'error') {
    await db.from('md_prepick_runs').update({ status: 'error', error: String(body.error || 'unknown').slice(0, 1000), completed_at: new Date().toISOString() }).eq('id', runId)
    return res.status(200).json({ ok: true })
  }

  if (action === 'finish') {
    const items = Array.isArray(body.items) ? body.items : []
    // Idempotent: clear any prior items for this run, then insert.
    await db.from('md_prepick_items').delete().eq('run_id', runId)
    if (items.length) {
      const rows = items.map((it: any) => ({
        run_id: runId,
        md_stock_id: it.md_stock_id != null ? Number(it.md_stock_id) : null,
        sku: it.sku ? String(it.sku) : null,
        name: it.name ? String(it.name) : null,
        to_pick: Number(it.to_pick) || 0,
        on_hand: Number(it.on_hand) || 0,
        alert_qty: it.alert_qty != null ? Number(it.alert_qty) : null,
        reorder_point: it.reorder_point != null ? Number(it.reorder_point) : null,
        buy_price: it.buy_price != null ? Number(it.buy_price) : null,
        location: it.location ? String(it.location) : null,
      }))
      // Chunked insert to stay well within limits.
      for (let i = 0; i < rows.length; i += 500) {
        const { error } = await db.from('md_prepick_items').insert(rows.slice(i, i + 500))
        if (error) return res.status(500).json({ error: error.message })
      }
    }
    await db.from('md_prepick_runs').update({
      status: 'done', jobs_count: Number(body.jobs_count) || 0, items_count: items.length,
      error: null, completed_at: new Date().toISOString(),
    }).eq('id', runId)
    return res.status(200).json({ ok: true, items: items.length })
  }

  return res.status(400).json({ error: `Unknown action "${action}"` })
}
