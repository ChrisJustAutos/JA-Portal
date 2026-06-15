// pages/api/b2b/admin/reorder/sync.ts
// POST — refresh every reorder row from MYOB (JAWS) via the CData PowerBI feed:
//   • on-hand / committed / available / on-order  (Items)
//   • total sales qty over the settings date range (SaleInvoices × SaleInvoiceItems)
// Permission: edit:b2b_catalogue.

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../../lib/authServer'
import { cdataQuery } from '../../../../../lib/cdata'

export const config = { maxDuration: 60 }

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  _sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  return _sb
}

function rowsToObjects(raw: any): any[] {
  if (!raw?.results?.[0]) return []
  const cols: string[] = (raw.results[0].schema || []).map((c: any) => c.columnName)
  const rows: any[][] = raw.results[0].rows || []
  return rows.map(r => { const o: any = {}; cols.forEach((c, i) => { o[c] = r[i] }); return o })
}
const num = (v: any) => Number(v) || 0
const sqlList = (vals: string[]) => vals.map(v => `'${String(v).replace(/'/g, "''")}'`).join(',')

export default withAuth('edit:b2b_catalogue', async (req, res) => {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }) }
  const db = sb()

  const { data: settings } = await db.from('b2b_reorder_settings').select('*').eq('id', 'singleton').maybeSingle()
  const { data: items } = await db.from('b2b_reorder_items').select('id, sku')
  const skus = (items || []).map((i: any) => String(i.sku)).filter(Boolean)
  if (!skus.length) return res.status(200).json({ ok: true, updated: 0, message: 'No items on the sheet yet — add some first.' })

  const inList = sqlList(skus)
  const warnings: string[] = []

  // ── Stock levels ──
  const stockBySku: Record<string, { on_hand: number; committed: number; available: number; on_order: number }> = {}
  try {
    let stockRows: any[] = []
    try {
      const r = await cdataQuery('JAWS', `SELECT [Number],[QuantityOnHand],[QuantityCommitted],[QuantityAvailable],[QuantityOnOrder] FROM [MYOB_POWERBI_JAWS].[MYOB].[Items] WHERE [Number] IN (${inList})`)
      stockRows = rowsToObjects(r)
    } catch {
      // Some files don't expose QuantityOnOrder — retry without it.
      const r = await cdataQuery('JAWS', `SELECT [Number],[QuantityOnHand],[QuantityCommitted],[QuantityAvailable] FROM [MYOB_POWERBI_JAWS].[MYOB].[Items] WHERE [Number] IN (${inList})`)
      stockRows = rowsToObjects(r)
    }
    for (const s of stockRows) {
      const sku = String(s.Number || '').trim(); if (!sku) continue
      stockBySku[sku] = {
        on_hand: num(s.QuantityOnHand), committed: num(s.QuantityCommitted),
        available: s.QuantityAvailable != null ? num(s.QuantityAvailable) : num(s.QuantityOnHand) - num(s.QuantityCommitted),
        on_order: num(s.QuantityOnOrder),
      }
    }
  } catch (e: any) { warnings.push(`Stock pull failed: ${e?.message || e}`) }

  // ── Sales qty over the range ──
  const salesBySku: Record<string, number> = {}
  if (settings?.from_date && settings?.to_date) {
    try {
      const inv = rowsToObjects(await cdataQuery('JAWS', `SELECT [SaleInvoiceId] FROM [MYOB_POWERBI_JAWS].[MYOB].[SaleInvoices] WHERE [Date] >= '${settings.from_date}' AND [Date] <= '${settings.to_date}'`))
      const invIds = new Set(inv.map((r: any) => String(r.SaleInvoiceId)))
      const lines = rowsToObjects(await cdataQuery('JAWS', `SELECT [SaleInvoiceId],[ItemNumber],[Quantity] FROM [MYOB_POWERBI_JAWS].[MYOB].[SaleInvoiceItems] WHERE [ItemNumber] IN (${inList})`))
      for (const l of lines) {
        if (!invIds.has(String(l.SaleInvoiceId))) continue
        const sku = String(l.ItemNumber || '').trim(); if (!sku) continue
        salesBySku[sku] = (salesBySku[sku] || 0) + num(l.Quantity)
      }
    } catch (e: any) { warnings.push(`Sales pull failed: ${e?.message || e}`) }
  } else {
    warnings.push('Set a date range to pull sales totals.')
  }

  // ── Write back ──
  const nowIso = new Date().toISOString()
  let updated = 0
  for (const it of (items as any[]) || []) {
    const st = stockBySku[it.sku]
    const patch: any = { synced_at: nowIso, sales_qty: salesBySku[it.sku] || 0 }
    if (st) { patch.on_hand = st.on_hand; patch.committed = st.committed; patch.available = st.available; patch.on_order = st.on_order }
    const { error } = await db.from('b2b_reorder_items').update(patch).eq('id', it.id)
    if (!error) updated++
  }

  return res.status(200).json({ ok: true, updated, warnings })
})
