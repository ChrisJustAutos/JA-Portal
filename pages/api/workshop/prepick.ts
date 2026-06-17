// pages/api/workshop/prepick.ts
// GET ?from=YYYY-MM-DD&to=YYYY-MM-DD — "Pre Pick" stock demand for a date range.
// Sums the parts (workshop_booking_lines, line_type='part', linked to inventory)
// across all jobs whose starts_at falls in the range (excluding cancelled /
// no-show / already-invoiced jobs), and returns each inventory item's demand
// alongside its current on-hand stock. The client computes green/orange/red
// status + the to-order shortfall (so the low-stock threshold is adjustable live).
//
// Gated view:diary.

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../lib/authServer'

export const config = { maxDuration: 30 }

function sb(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase not configured')
  return createClient(url, key, { auth: { persistSession: false } })
}

// Jobs in these states either won't be picked or have already consumed stock.
const EXCLUDED_STATUSES = ['cancelled', 'no_show', 'invoiced', 'paid']

export default withAuth('view:diary', async (req, res) => {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'GET only' }) }
  const from = String(req.query.from || '').trim()
  const to = String(req.query.to || '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return res.status(400).json({ error: 'from and to (YYYY-MM-DD) required' })
  }
  // Brisbane day bounds (AEST, no DST) → timestamptz comparison on starts_at.
  const fromIso = `${from}T00:00:00+10:00`
  const toIso = `${to}T23:59:59.999+10:00`

  const db = sb()

  // 1. Jobs in the window we'd pick for.
  const { data: bookings, error: bErr } = await db.from('workshop_bookings')
    .select('id, status')
    .gte('starts_at', fromIso).lte('starts_at', toIso)
    .not('status', 'in', `(${EXCLUDED_STATUSES.join(',')})`)
  if (bErr) return res.status(500).json({ error: bErr.message })
  const bookingIds = (bookings || []).map((b: any) => b.id)
  if (bookingIds.length === 0) {
    return res.status(200).json({ items: [], jobs_count: 0, from, to, generated_at: new Date().toISOString() })
  }

  // 2. Part lines on those jobs, linked to an inventory item. Page through in
  //    case a busy range has many lines (the .in() list is the booking set).
  const demand = new Map<string, number>()   // inventory_id → qty to pick
  const PAGE = 1000
  for (let offset = 0; ; offset += PAGE) {
    const { data: lines, error: lErr } = await db.from('workshop_booking_lines')
      .select('inventory_id, qty')
      .in('booking_id', bookingIds)
      .eq('line_type', 'part')
      .not('inventory_id', 'is', null)
      .range(offset, offset + PAGE - 1)
    if (lErr) return res.status(500).json({ error: lErr.message })
    for (const l of (lines || []) as any[]) {
      demand.set(l.inventory_id, (demand.get(l.inventory_id) || 0) + (Number(l.qty) || 0))
    }
    if (!lines || lines.length < PAGE) break
  }

  if (demand.size === 0) {
    return res.status(200).json({ items: [], jobs_count: bookingIds.length, from, to, generated_at: new Date().toISOString() })
  }

  // 3. Current stock + metadata for the demanded items.
  const invIds = Array.from(demand.keys())
  const { data: inv, error: iErr } = await db.from('workshop_inventory')
    .select('id, sku, part_name, brand, supplier, location, bin, buy_price, quantity, alert_qty')
    .in('id', invIds)
  if (iErr) return res.status(500).json({ error: iErr.message })

  const items = (inv || []).map((it: any) => ({
    id: it.id,
    sku: it.sku || '',
    part_name: it.part_name || '',
    brand: it.brand || null,
    supplier: it.supplier || null,
    location: it.location || it.bin || null,
    buy_price: it.buy_price != null ? Number(it.buy_price) : null,
    alert_qty: it.alert_qty != null ? Number(it.alert_qty) : null,
    to_pick: Math.round((demand.get(it.id) || 0) * 100) / 100,
    current_stock: it.quantity != null ? Number(it.quantity) : 0,
  }))
  // Biggest demand first.
  items.sort((a, b) => b.to_pick - a.to_pick)

  return res.status(200).json({ items, jobs_count: bookingIds.length, from, to, generated_at: new Date().toISOString() })
})
