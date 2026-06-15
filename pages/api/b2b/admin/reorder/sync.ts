// pages/api/b2b/admin/reorder/sync.ts
// POST — refresh every reorder row from MYOB (JAWS) over the portal's direct
// OAuth connection (no CData):
//   • on-hand / committed / available / on-order  — /Inventory/Item
//   • total sales qty over the settings date range — /Sale/Invoice/Item lines
// Permission: edit:b2b_catalogue.

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../../lib/authServer'
import { getConnection, myobFetch } from '../../../../../lib/myob'

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
      const r = await myobFetch(conn.id, `${cf}/Inventory/Item`, { query: { '$top': 400, '$skip': skip }, performedBy: user.id })
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

  // ── Sales qty over the range: page Item-layout invoices, sum line ShipQuantity ──
  const salesBySku: Record<string, number> = {}
  if (settings?.from_date && settings?.to_date) {
    try {
      const filter = `Date ge datetime'${settings.from_date}T00:00:00' and Date le datetime'${settings.to_date}T23:59:59'`
      for (let skip = 0, page = 0; page < 120; page++, skip += 400) {
        const r = await myobFetch(conn.id, `${cf}/Sale/Invoice/Item`, { query: { '$filter': filter, '$top': 400, '$skip': skip }, performedBy: user.id })
        if (r.status !== 200) { warnings.push(`Sales pull HTTP ${r.status}: ${(r.raw || '').slice(0, 120)}`); break }
        const invoices: any[] = Array.isArray(r.data?.Items) ? r.data.Items : []
        for (const inv of invoices) {
          for (const l of (inv.Lines || [])) {
            const sku = String(l.Item?.Number || '').trim()
            if (!sku || !wantSku.has(sku)) continue
            salesBySku[sku] = (salesBySku[sku] || 0) + num(l.ShipQuantity)
          }
        }
        if (invoices.length < 400) break
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
