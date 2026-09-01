// pages/api/b2b/admin/reorder/sync.ts
// POST — refresh every reorder row from MYOB (JAWS) over the portal's direct
// OAuth connection (no CData):
//   • on-hand / committed / available / on-order  — /Inventory/Item
//   • total sales qty over the settings date range — sale-invoice lines across
//     ALL invoice types, via lib/myob-reporting (see the note on the sales pull)
// Permission: edit:b2b_catalogue.

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../../lib/authServer'
import { getConnection, myobFetch } from '../../../../../lib/myob'
import { fetchSaleInvoicesWithLines } from '../../../../../lib/myob-reporting'

export const config = { maxDuration: 120 }

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  _sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  return _sb
}
const num = (v: any) => Number(v) || 0

export default withAuth('edit:b2b_catalogue', async (req, res, user) => {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }) }
  const db = sb()

  const { data: settings } = await db.from('b2b_reorder_settings').select('*').eq('id', 'singleton').maybeSingle()
  const { data: items } = await db.from('b2b_reorder_items').select('id, sku')
  if (!items || !items.length) return res.status(200).json({ ok: true, updated: 0, message: 'No items on the sheet yet — add some first.' })

  const conn = await getConnection('JAWS')
  if (!conn || !conn.company_file_id) return res.status(400).json({ error: 'No active JAWS MYOB connection. Connect via Settings → Connections.' })
  const cf = `/accountright/${conn.company_file_id}`
  const wantSku = new Set(items.map((i: any) => String(i.sku)))
  const warnings: string[] = []

  // ── Stock levels: page all Inventory/Item, keep the ones on the sheet ──
  const stockBySku: Record<string, { on_hand: number; committed: number; available: number; on_order: number }> = {}
  try {
    for (let skip = 0, page = 0; page < 80; page++, skip += 400) {
      // $orderby with $skip - same trap the sales pull above hit. Without it
      // pages can drop items, understating on-hand and on-order and so the
      // suggested order quantity.
      const r = await myobFetch(conn.id, `${cf}/Inventory/Item`, { query: { '$orderby': 'Number', '$top': 400, '$skip': skip }, performedBy: user.id })
      if (r.status !== 200) { warnings.push(`Stock pull HTTP ${r.status}`); break }
      const rows: any[] = Array.isArray(r.data?.Items) ? r.data.Items : []
      for (const it of rows) {
        const sku = String(it.Number || '').trim()
        if (!sku || !wantSku.has(sku)) continue
        const onHand = num(it.QuantityOnHand)
        const committed = num(it.QuantityCommitted)
        stockBySku[sku] = {
          on_hand: onHand, committed,
          available: it.QuantityAvailable != null ? num(it.QuantityAvailable) : onHand - committed,
          on_order: num(it.QuantityOnOrder),
        }
      }
      if (rows.length < 400) break
    }
  } catch (e: any) { warnings.push(`Stock pull failed: ${e?.message || e}`) }

  // ── Sales qty over the range ──────────────────────────────────────────
  //
  // Via lib/myob-reporting, NOT a hand-rolled pull, because this used to page
  // `Sale/Invoice/Item` itself and got two documented traps wrong at once
  // (Chris 2026-09-01: SKU 3070010 read 598 in the sheet against 829 in MYOB):
  //
  //   1. ONLY the Item layout. JAWS raises some sales on other invoice types,
  //      so an Item-only pull undercounts — the exact reason
  //      myob-reporting queries all five (Item, Service, Professional,
  //      Miscellaneous, TimeBilling) and merges them.
  //   2. NO $orderby. Skip-based paging without a deterministic order can drop
  //      rows at page boundaries, which silently loses whole invoices.
  //
  // fetchSaleInvoicesWithLines fixes both, propagates mid-pagination errors
  // instead of swallowing them (the 2026-07-21 EOFY bug), and its end bound is
  // EXCLUSIVE — so to_date is pushed one day forward to keep the last day in.
  const salesBySku: Record<string, number> = {}
  if (settings?.from_date && settings?.to_date) {
    try {
      const endExclusive = new Date(`${settings.to_date}T00:00:00Z`)
      endExclusive.setUTCDate(endExclusive.getUTCDate() + 1)
      const { lines } = await fetchSaleInvoicesWithLines('JAWS', {
        start: settings.from_date,
        endExclusive: endExclusive.toISOString().slice(0, 10),
      })
      for (const l of lines) {
        const sku = String(l.ItemNumber || '').trim()
        if (!sku || !wantSku.has(sku)) continue
        salesBySku[sku] = (salesBySku[sku] || 0) + num(l.ShipQuantity)
      }
    } catch (e: any) { warnings.push(`Sales pull failed: ${e?.message || e}`) }
  } else {
    warnings.push('Set a date range to pull sales totals.')
  }

  // ── Write back ──
  const nowIso = new Date().toISOString()
  let updated = 0
  for (const it of (items as any[])) {
    const st = stockBySku[it.sku]
    const patch: any = { synced_at: nowIso, sales_qty: salesBySku[it.sku] || 0 }
    if (st) { patch.on_hand = st.on_hand; patch.committed = st.committed; patch.available = st.available; patch.on_order = st.on_order }
    const { error } = await db.from('b2b_reorder_items').update(patch).eq('id', it.id)
    if (!error) updated++
  }

  return res.status(200).json({ ok: true, updated, warnings })
})
