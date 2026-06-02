// pages/api/b2b/admin/dropship-calibration.ts
// Read-only: mine a supplier's MYOB purchase history (default MPI) to derive
// drop-ship freight rates from real freight charges + delivery postcodes.
//
//   GET ?supplierUid=&supplierName=MPI&sinceMonths=24
//   → {
//       supplier: { uid, name } | null,
//       totals:   { billsFetched, withFreight, withPostcode, withZone, singleProduct, multiProduct, noProductMatch },
//       zones:    [{ id, name }],
//       products: [{ catalogue_id, sku, name }],            // drop-ship products seen
//       rows:     [{ number, date, shipTo, postcode, zoneId, zoneName, freight_ex_gst, products:[{catalogue_id,name}], multiProduct }],
//       perProductZone: { [catalogue_id]: { [zone_id]: { max, count } } },  // single-product bills only
//       perZone:        { [zone_id]: { max, count } },                      // fallback (all bills)
//     }
//
// Freight is the bill's FreightAmount (normalised to ex-GST). A bill's freight
// can only be attributed to a product when the bill has exactly ONE drop-ship
// product line; multi-product bills feed the per-zone fallback only.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../lib/authServer'
import { getConnection, myobFetch } from '../../../../lib/myob'
import { searchSuppliers } from '../../../../lib/ap-myob-lookup'
import { postcodeMatches } from '../../../../lib/b2b-freight'

export const config = { maxDuration: 60 }

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

// Last 4-digit token in an address string → the AU postcode (state/postcode sit last).
function extractPostcode(addr: string | null | undefined): string | null {
  if (!addr) return null
  const matches = String(addr).match(/\b(\d{4})\b/g)
  if (!matches || matches.length === 0) return null
  return matches[matches.length - 1]
}

export default withAuth('admin:b2b', async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'GET only' }) }

  const supplierUidParam = String(req.query.supplierUid || '').trim()
  const supplierName = String(req.query.supplierName || 'MPI').trim()
  const sinceMonths = Math.min(120, Math.max(1, parseInt(String(req.query.sinceMonths || '24'), 10) || 24))

  const conn = await getConnection('JAWS')
  if (!conn?.company_file_id) return res.status(503).json({ error: 'MYOB JAWS not connected' })

  // ── Resolve supplier ──
  let supplier: { uid: string; name: string } | null = null
  if (supplierUidParam) {
    supplier = { uid: supplierUidParam, name: supplierName || 'Supplier' }
  } else {
    const hits = await searchSuppliers('JAWS', supplierName)
    if (hits.length > 0) supplier = { uid: hits[0].uid, name: hits[0].name }
  }
  if (!supplier) return res.status(404).json({ error: `No MYOB supplier matching "${supplierName}" — pass supplierUid explicitly.` })

  // ── Load our zones (first-match by sort_order) + drop-ship catalogue map ──
  const [{ data: zoneRows }, { data: catRows }] = await Promise.all([
    sb().from('b2b_freight_zones').select('id, name, postcode_ranges, sort_order, is_active').eq('is_active', true).order('sort_order', { ascending: true }),
    sb().from('b2b_catalogue').select('id, sku, name, myob_item_uid, is_drop_ship').eq('is_drop_ship', true),
  ])
  const zones = (zoneRows || []) as any[]
  const byItemUid = new Map<string, { id: string; sku: string; name: string }>()
  for (const c of (catRows || []) as any[]) {
    if (c.myob_item_uid) byItemUid.set(String(c.myob_item_uid).toLowerCase(), { id: c.id, sku: c.sku, name: c.name })
  }
  const matchZone = (pc: string): { id: string; name: string } | null => {
    for (const z of zones) {
      if (postcodeMatches(pc, Array.isArray(z.postcode_ranges) ? z.postcode_ranges : [])) return { id: z.id, name: z.name }
    }
    return null
  }

  // ── Page through the supplier's Item bills ──
  const sinceDate = new Date()
  sinceDate.setMonth(sinceDate.getMonth() - sinceMonths)
  const sinceIso = sinceDate.toISOString().slice(0, 19)   // yyyy-mm-ddThh:mm:ss
  const filter = `Supplier/UID eq guid'${supplier.uid}' and Date ge datetime'${sinceIso}'`
  const base = `/accountright/${conn.company_file_id}/Purchase/Bill/Item`

  const rows: any[] = []
  const totals = { billsFetched: 0, withFreight: 0, withPostcode: 0, withZone: 0, singleProduct: 0, multiProduct: 0, noProductMatch: 0 }
  const seenProducts = new Map<string, { id: string; sku: string; name: string }>()

  let skip = 0
  const PAGE = 400
  for (let guard = 0; guard < 30; guard++) {   // up to 12,000 bills
    const r = await myobFetch(conn.id, base, { query: { '$filter': filter, '$top': PAGE, '$skip': skip, '$orderby': 'Date desc' } })
    if (r.status !== 200) return res.status(502).json({ error: `MYOB Purchase/Bill fetch failed (HTTP ${r.status}): ${(r.raw || '').slice(0, 200)}` })
    const items: any[] = Array.isArray(r.data?.Items) ? r.data.Items : []
    for (const b of items) {
      totals.billsFetched++
      const incTax = b.IsTaxInclusive === true
      const freightRaw = Number(b.Freight ?? b.FreightAmount ?? 0)
      const freightEx = freightRaw > 0 ? Math.round((incTax ? freightRaw / 1.1 : freightRaw) * 100) / 100 : 0
      if (freightEx > 0) totals.withFreight++
      const shipTo = b.ShipToAddress || null
      const postcode = extractPostcode(shipTo)
      if (postcode) totals.withPostcode++
      const zone = postcode ? matchZone(postcode) : null
      if (zone) totals.withZone++

      // Drop-ship product lines on this bill.
      const lines: any[] = Array.isArray(b.Lines) ? b.Lines : []
      const prods: { catalogue_id: string; name: string }[] = []
      for (const ln of lines) {
        const uid = ln?.Item?.UID ? String(ln.Item.UID).toLowerCase() : null
        if (!uid) continue
        const cat = byItemUid.get(uid)
        if (cat) { prods.push({ catalogue_id: cat.id, name: cat.name }); seenProducts.set(cat.id, cat) }
      }
      if (prods.length === 0) totals.noProductMatch++
      else if (prods.length === 1) totals.singleProduct++
      else totals.multiProduct++

      rows.push({
        number: b.Number || b.DisplayID || null,
        date: b.Date ? String(b.Date).slice(0, 10) : null,
        shipTo, postcode,
        zoneId: zone?.id || null, zoneName: zone?.name || null,
        freight_ex_gst: freightEx,
        products: prods, multiProduct: prods.length > 1,
      })
    }
    if (items.length < PAGE) break
    skip += PAGE
  }

  // ── Aggregate (MAX freight) ──
  const perProductZone: Record<string, Record<string, { max: number; count: number }>> = {}
  const perZone: Record<string, { max: number; count: number }> = {}
  for (const row of rows) {
    if (!row.zoneId || row.freight_ex_gst <= 0) continue
    // Per-zone fallback uses every freighted, zoned bill.
    const pz = perZone[row.zoneId] || { max: 0, count: 0 }
    pz.max = Math.max(pz.max, row.freight_ex_gst); pz.count++
    perZone[row.zoneId] = pz
    // Per-product only when the bill has exactly one drop-ship product.
    if (row.products.length === 1) {
      const cid = row.products[0].catalogue_id
      perProductZone[cid] = perProductZone[cid] || {}
      const cell = perProductZone[cid][row.zoneId] || { max: 0, count: 0 }
      cell.max = Math.max(cell.max, row.freight_ex_gst); cell.count++
      perProductZone[cid][row.zoneId] = cell
    }
  }

  return res.status(200).json({
    supplier,
    totals,
    zones: zones.map(z => ({ id: z.id, name: z.name })),
    products: Array.from(seenProducts.values()).map(p => ({ catalogue_id: p.id, sku: p.sku, name: p.name })),
    rows: rows.slice(0, 500),   // cap payload; aggregates use the full set
    perProductZone,
    perZone,
  })
})
