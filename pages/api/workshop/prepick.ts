// pages/api/workshop/prepick.ts
// GET — the latest MechanicDesk "Pre Pick" snapshot for the workshop screen.
// Data is pulled LIVE from MechanicDesk by a GitHub Action worker (jobs in a
// date range → invoice parts → live on-hand) and stored as md_prepick_runs +
// md_prepick_items. This endpoint returns the most recent run's items in the
// shape the page renders (client computes green/orange/red). To refresh, the
// page calls /api/workshop/prepick/refresh which kicks the worker.
//
// Gated view:diary.

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../lib/authServer'

export const config = { maxDuration: 15 }

function sb(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase not configured')
  return createClient(url, key, { auth: { persistSession: false } })
}

export default withAuth('view:diary', async (req, res) => {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'GET only' }) }
  const db = sb()

  // Most recent run (any status — so the UI can show 'running'/'error' too).
  const { data: run, error: rErr } = await db.from('md_prepick_runs')
    .select('id, from_date, to_date, status, jobs_count, items_count, error, created_at, completed_at')
    .order('created_at', { ascending: false }).limit(1).maybeSingle()
  if (rErr) return res.status(500).json({ error: rErr.message })
  if (!run) {
    return res.status(200).json({ items: [], jobs_count: 0, from: null, to: null, status: 'none', synced_at: null, source: 'mechanicdesk' })
  }

  const { data: rows, error: iErr } = await db.from('md_prepick_items')
    .select('id, md_stock_id, sku, name, to_pick, on_hand, alert_qty, reorder_point, buy_price, location')
    .eq('run_id', run.id).order('to_pick', { ascending: false })
  if (iErr) return res.status(500).json({ error: iErr.message })

  const items = (rows || []).map((it: any) => ({
    id: it.id,
    sku: it.sku || '',
    part_name: it.name || '',
    brand: null,
    supplier: null,
    location: it.location || null,
    buy_price: it.buy_price != null ? Number(it.buy_price) : null,
    alert_qty: it.alert_qty != null ? Number(it.alert_qty) : (it.reorder_point != null ? Number(it.reorder_point) : null),
    to_pick: Number(it.to_pick) || 0,
    current_stock: Number(it.on_hand) || 0,
  }))

  return res.status(200).json({
    items,
    jobs_count: run.jobs_count || 0,
    from: run.from_date,
    to: run.to_date,
    status: run.status,
    error: run.error || null,
    synced_at: run.completed_at || run.created_at,
    source: 'mechanicdesk',
  })
})
