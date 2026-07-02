// pages/api/parts-bot/md-stock-ingest.ts
//
// Service-token endpoint the MD stock-cache worker (scripts/pull-md-stock.ts)
// POSTs to. Mirrors MechanicDesk's full catalogue into md_stock_cache so the
// Slack bot's search_md_stock tool answers parts queries instantly.
//
//   POST { action: 'start', requested_by? }        → { run_id } (status 'running')
//   POST { action: 'finish', run_id, items[] }     → replaces the cache, marks 'done'
//   POST { action: 'error',  run_id, error }        → marks 'error'
//
// Auth: X-Service-Token with the stocktake:write scope (same token the other
// MechanicDesk workers use).

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { validateServiceToken } from '../../../lib/service-auth'

export const config = { maxDuration: 30, api: { bodyParser: { sizeLimit: '16mb' } } }

function sb(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

const num = (v: any): number => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
const numOrNull = (v: any): number | null => { if (v == null) return null; const n = Number(v); return Number.isFinite(n) ? n : null }
const strOrNull = (v: any): string | null => { const s = v == null ? '' : String(v).trim(); return s ? s : null }

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
    const { data, error } = await db.from('md_stock_sync_runs')
      .insert({ status: 'running', requested_by: String(body.requested_by || 'worker').slice(0, 120) })
      .select('id').single()
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ run_id: data.id })
  }

  const runId = String(body.run_id || '')
  if (!runId) return res.status(400).json({ error: 'run_id required' })

  if (action === 'error') {
    await db.from('md_stock_sync_runs').update({ status: 'error', error: String(body.error || 'unknown').slice(0, 1000), completed_at: new Date().toISOString() }).eq('id', runId)
    return res.status(200).json({ ok: true })
  }

  if (action === 'finish') {
    const items = Array.isArray(body.items) ? body.items : []
    if (items.length === 0) {
      // Refuse to wipe the cache on an empty pull — almost always a broken
      // scrape (session died / MD glitch), and a blank cache means the bot
      // answers "we have none" for everything. Leave the last good cache in place.
      await db.from('md_stock_sync_runs').update({ status: 'error', error: 'Empty item list — kept previous cache', completed_at: new Date().toISOString() }).eq('id', runId)
      return res.status(400).json({ error: 'Empty item list — cache left unchanged' })
    }

    const syncedAt = new Date().toISOString()
    // Dedupe by SKU (MD can list the same stock_number twice); last wins.
    const bySku = new Map<string, any>()
    for (const it of items) {
      const sku = String(it.stock_number || '').trim()
      if (!sku) continue
      bySku.set(sku, {
        stock_number: sku,
        md_stock_id: it.stock_id != null ? Number(it.stock_id) : null,
        name: it.name ? String(it.name).slice(0, 500) : '',
        on_hand: num(it.on_hand),
        available: num(it.available),
        allocated: num(it.allocated),
        on_order: numOrNull(it.on_order),
        alert_qty: numOrNull(it.alert_qty),
        buy_price: numOrNull(it.buy_price),
        sell_price: numOrNull(it.sell_price),
        bin: strOrNull(it.bin),
        location: strOrNull(it.location),
        synced_at: syncedAt,
      })
    }
    const rows = Array.from(bySku.values())

    try {
      // Upsert the fresh snapshot, then delete anything not in it (SKUs removed
      // from MD). Upsert-then-prune keeps the cache readable throughout — no
      // window where the table is empty.
      for (let i = 0; i < rows.length; i += 500) {
        const { error } = await db.from('md_stock_cache').upsert(rows.slice(i, i + 500), { onConflict: 'stock_number' })
        if (error) throw new Error(error.message)
      }
      const { error: delErr } = await db.from('md_stock_cache').delete().lt('synced_at', syncedAt)
      if (delErr) throw new Error(`prune: ${delErr.message}`)
    } catch (e: any) {
      await db.from('md_stock_sync_runs').update({ status: 'error', error: String(e?.message || e).slice(0, 1000), completed_at: new Date().toISOString() }).eq('id', runId)
      return res.status(500).json({ error: String(e?.message || e) })
    }

    await db.from('md_stock_sync_runs').update({ status: 'done', item_count: rows.length, error: null, completed_at: syncedAt }).eq('id', runId)
    return res.status(200).json({ ok: true, items: rows.length })
  }

  return res.status(400).json({ error: `Unknown action "${action}"` })
}
