// pages/api/workshop/map/ingest.ts
// Service-token endpoint the MechanicDesk Workshop Map worker POSTs to
// (scripts/pull-md-workshop-map.ts, daily GH Action). The worker does all the
// heavy lifting (xls parse, classification, geocoding, payload build) — this
// endpoint just persists.
//
//   POST { action:'start', requested_by?, run_id? }            → { run_id }
//   POST { action:'invoices', run_id, rows:[md_invoices rows] }→ upsert batch
//   POST { action:'quotes',   run_id, rows:[md_quotes rows] }  → upsert batch
//   POST { action:'payload',  run_id, fy, payload }            → cache per-FY dashboard JSON
//   POST { action:'finish',   run_id, invoice_count, quote_count, meta? }
//        → marks run done + soft-flags rows that vanished from the MD export
//   POST { action:'error',    run_id, error }                  → marks 'error'
//
// Auth: X-Service-Token with the stocktake:write scope (same token the other
// MechanicDesk workers use).

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { validateServiceToken } from '../../../../lib/service-auth'

export const config = { maxDuration: 60, api: { bodyParser: { sizeLimit: '8mb' } } }

function sb(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

const INVOICE_COLS = new Set([
  'invoice_number', 'customer_id', 'customer_name', 'suburb', 'state', 'postcode',
  'vehicle_id', 'rego', 'first_job_type', 'description', 'items_text', 'issue_date',
  'total_amount', 'vehicle_group', 'inferred', 'is_noise', 'lat', 'lng', 'locality', 'month', 'fy',
])
const QUOTE_COLS = new Set([
  'quote_number', 'customer_id', 'customer_name', 'suburb', 'state', 'postcode',
  'rego', 'vehicle_model', 'description', 'items_text', 'quote_date',
  'total_amount', 'status', 'won', 'vehicle_group', 'inferred', 'lat', 'lng', 'locality', 'month', 'fy',
])

function cleanRows(rows: any[], cols: Set<string>, keyCol: string): any[] {
  const now = new Date().toISOString()
  const out: any[] = []
  for (const r of rows) {
    if (!r || typeof r !== 'object' || !String(r[keyCol] || '').trim()) continue
    const row: any = {}
    for (const [k, v] of Object.entries(r)) if (cols.has(k)) row[k] = v
    row[keyCol] = String(r[keyCol]).trim()
    row.last_seen_at = now
    row.missing = false
    row.updated_at = now
    out.push(row)
  }
  return out
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
    const requestedBy = String(body.requested_by || 'worker').slice(0, 120)
    const existingId = String(body.run_id || '')
    if (existingId) {
      const { data, error } = await db.from('md_workshop_map_runs')
        .update({ status: 'running' })
        .eq('id', existingId).select('id').maybeSingle()
      if (error) return res.status(500).json({ error: error.message })
      if (data) return res.status(200).json({ run_id: data.id })
      // Row vanished — fall through to insert a fresh one.
    }
    const { data, error } = await db.from('md_workshop_map_runs')
      .insert({ status: 'running', requested_by: requestedBy })
      .select('id').single()
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ run_id: data.id })
  }

  const runId = String(body.run_id || '')
  if (!runId) return res.status(400).json({ error: 'run_id required' })

  if (action === 'invoices' || action === 'quotes') {
    const table = action === 'invoices' ? 'md_invoices' : 'md_quotes'
    const keyCol = action === 'invoices' ? 'invoice_number' : 'quote_number'
    const rows = cleanRows(Array.isArray(body.rows) ? body.rows : [], action === 'invoices' ? INVOICE_COLS : QUOTE_COLS, keyCol)
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await db.from(table).upsert(rows.slice(i, i + 500), { onConflict: keyCol })
      if (error) return res.status(500).json({ error: `${table}: ${error.message}` })
    }
    return res.status(200).json({ ok: true, upserted: rows.length })
  }

  if (action === 'payload') {
    const fy = Number(body.fy)
    if (!Number.isInteger(fy) || fy < 2000 || fy > 2100) return res.status(400).json({ error: 'fy (e.g. 2026) required' })
    if (!body.payload || typeof body.payload !== 'object') return res.status(400).json({ error: 'payload object required' })
    const { error } = await db.from('md_workshop_map_cache')
      .upsert({ fy, payload: body.payload, run_id: runId, synced_at: new Date().toISOString() }, { onConflict: 'fy' })
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true, fy })
  }

  if (action === 'error') {
    await db.from('md_workshop_map_runs')
      .update({ status: 'error', error: String(body.error || 'unknown').slice(0, 1000), completed_at: new Date().toISOString() })
      .eq('id', runId)
    return res.status(200).json({ ok: true })
  }

  if (action === 'finish') {
    // Soft-flag rows the full refresh no longer saw (deleted in MD) — the run's
    // upserts stamped everything it DID see with a fresh last_seen_at.
    const { data: run } = await db.from('md_workshop_map_runs').select('started_at').eq('id', runId).maybeSingle()
    if (run?.started_at) {
      await db.from('md_invoices').update({ missing: true }).lt('last_seen_at', run.started_at).eq('missing', false)
      await db.from('md_quotes').update({ missing: true }).lt('last_seen_at', run.started_at).eq('missing', false)
    }
    const { error } = await db.from('md_workshop_map_runs').update({
      status: 'done',
      invoice_count: Number(body.invoice_count) || 0,
      quote_count: Number(body.quote_count) || 0,
      meta: body.meta && typeof body.meta === 'object' ? body.meta : null,
      completed_at: new Date().toISOString(),
    }).eq('id', runId)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  return res.status(400).json({ error: `Unknown action "${action}"` })
}
