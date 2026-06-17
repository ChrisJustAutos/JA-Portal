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

  // Newest run of any status — drives the live status / loading indicator.
  const { data: latest, error: lErr } = await db.from('md_prepick_runs')
    .select('id, from_date, to_date, status, jobs_count, error, created_at, completed_at')
    .order('created_at', { ascending: false }).limit(1).maybeSingle()
  if (lErr) return res.status(500).json({ error: lErr.message })
  if (!latest) {
    return res.status(200).json({ items: [], jobs_count: 0, from: null, to: null, status: 'none', synced_at: null, in_flight: false, source: 'mechanicdesk' })
  }

  const inFlight = latest.status === 'pending' || latest.status === 'running'

  // The snapshot we DISPLAY always comes from the newest *done* run, so an
  // in-flight pull never blanks the current numbers. If the newest run is the
  // done one, that's the same row.
  let snapRun = latest
  if (latest.status !== 'done') {
    const { data: lastDone } = await db.from('md_prepick_runs')
      .select('id, from_date, to_date, status, jobs_count, error, created_at, completed_at')
      .eq('status', 'done').order('completed_at', { ascending: false }).limit(1).maybeSingle()
    if (lastDone) snapRun = lastDone
  }

  let items: any[] = []
  if (snapRun.status === 'done') {
    const { data: rows, error: iErr } = await db.from('md_prepick_items')
      .select('id, md_stock_id, sku, name, to_pick, on_hand, alert_qty, reorder_point, buy_price, location')
      .eq('run_id', snapRun.id).order('to_pick', { ascending: false })
    if (iErr) return res.status(500).json({ error: iErr.message })
    items = (rows || []).map((it: any) => ({
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
  }

  return res.status(200).json({
    items,
    jobs_count: snapRun.status === 'done' ? (snapRun.jobs_count || 0) : 0,
    from: snapRun.status === 'done' ? snapRun.from_date : null,
    to: snapRun.status === 'done' ? snapRun.to_date : null,
    synced_at: snapRun.status === 'done' ? (snapRun.completed_at || snapRun.created_at) : null,
    // Live status of the newest run (may be a fresh pull over an old snapshot).
    status: latest.status,
    error: latest.error || null,
    in_flight: inFlight,
    run_id: latest.id,
    pending_from: inFlight ? latest.from_date : null,
    pending_to: inFlight ? latest.to_date : null,
    started_at: inFlight ? latest.created_at : null,
    source: 'mechanicdesk',
  })
})
