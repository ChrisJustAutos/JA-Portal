// pages/api/b2b/admin/reorder/export.ts
// GET — download the reorder sheet as .xlsx with LIVE FORMULAS (mirrors the JAWS
// Stock Order master): editable Growth %, Cover months, Months-in-range and
// per-row MOQ / Morgan's Judgment all recalculate in Excel.
// Permission: edit:b2b_catalogue.

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import * as XLSX from 'xlsx'
import { withAuth } from '../../../../../lib/authServer'
import { monthsInRange } from '../../../../../lib/b2b-reorder'

export const config = { maxDuration: 20 }

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  _sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  return _sb
}
const num = (v: any) => Number(v) || 0

export default withAuth('edit:b2b_catalogue', async (req, res) => {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'GET only' }) }
  const db = sb()
  const [{ data: s }, { data: items }] = await Promise.all([
    db.from('b2b_reorder_settings').select('*').eq('id', 'singleton').maybeSingle(),
    db.from('b2b_reorder_items').select('*').order('sort_order', { ascending: true }).order('sku', { ascending: true }),
  ])
  const growth = Number(s?.growth_pct) || 0
  const coverMonths = Number(s?.forecast_months) || 0
  const months = monthsInRange(s?.from_date, s?.to_date)

  const ws: XLSX.WorkSheet = {}
  const set = (addr: string, cell: XLSX.CellObject) => { ws[addr] = cell }

  // ── Editable parameters block (top-left) ──
  set('A1', { t: 's', v: 'JAWS Stock Order' })
  set('C1', { t: 's', v: s?.from_date && s?.to_date ? `Sales ${s.from_date} → ${s.to_date}` : 'Sales range not set' })
  set('A2', { t: 's', v: 'Growth %' }); set('B2', { t: 'n', v: growth, z: '0%' })
  set('A3', { t: 's', v: 'Cover months' }); set('B3', { t: 'n', v: coverMonths })
  set('A4', { t: 's', v: 'Months in range' }); set('B4', { t: 'n', v: months })

  // ── Header row (row 6) ──
  const headers = ['Stock No.', 'Name', 'On Hand', 'Committed', 'Available', 'On Order', 'Total Sales', 'Monthly Avg', 'Monthly Round Up', '+Growth', 'Projected', 'Shortfall', 'Suggested', 'MOQ', "Morgan's Judgment", 'Final Order', 'Notes']
  headers.forEach((h, c) => set(XLSX.utils.encode_cell({ r: 5, c }), { t: 's', v: h }))

  // ── Data rows (from row 7), with live formulas ──
  const list = items || []
  list.forEach((it: any, i: number) => {
    const R = 7 + i  // 1-based Excel row
    set(`A${R}`, { t: 's', v: String(it.sku || '') })
    set(`B${R}`, { t: 's', v: String(it.name || '') })
    set(`C${R}`, { t: 'n', v: num(it.on_hand) })          // On Hand
    set(`D${R}`, { t: 'n', v: num(it.committed) })          // Committed
    set(`E${R}`, { t: 'n', f: `C${R}-D${R}` })              // Available
    set(`F${R}`, { t: 'n', v: num(it.on_order) })          // On Order
    set(`G${R}`, { t: 'n', v: num(it.sales_qty) })          // Total Sales
    set(`H${R}`, { t: 'n', f: `IF($B$4=0,0,G${R}/$B$4)` })  // Monthly Avg
    set(`I${R}`, { t: 'n', f: `ROUNDUP(H${R},0)` })         // Monthly Round Up
    set(`J${R}`, { t: 'n', f: `ROUNDUP(I${R}*(1+$B$2),0)` })// +Growth
    set(`K${R}`, { t: 'n', f: `J${R}*$B$3` })               // Projected
    set(`L${R}`, { t: 'n', f: `K${R}-(E${R}+F${R})` })      // Shortfall
    set(`M${R}`, { t: 'n', f: `IF(MAX(L${R},0)=0,0,IF(N${R}>0,CEILING(MAX(L${R},0),N${R}),IF(MAX(L${R},0)<=5,CEILING(MAX(L${R},0),5),CEILING(MAX(L${R},0),15))))` }) // Suggested
    if (it.moq != null) set(`N${R}`, { t: 'n', v: Number(it.moq) })                          // MOQ
    if (it.morgans_judgment != null) set(`O${R}`, { t: 'n', v: Number(it.morgans_judgment) })// Morgan's Judgment
    set(`P${R}`, { t: 'n', f: `IF(O${R}="",M${R},O${R})` }) // Final Order
    if (it.notes) set(`Q${R}`, { t: 's', v: String(it.notes) })
  })

  const lastRow = Math.max(6, 6 + list.length)
  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: lastRow, c: 16 } })
  ws['!cols'] = [{ wch: 16 }, { wch: 34 }, { wch: 9 }, { wch: 10 }, { wch: 9 }, { wch: 9 }, { wch: 11 }, { wch: 11 }, { wch: 13 }, { wch: 9 }, { wch: 10 }, { wch: 9 }, { wch: 10 }, { wch: 7 }, { wch: 16 }, { wch: 11 }, { wch: 30 }]

  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Stock Order')
  const buf: Buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  res.setHeader('Content-Disposition', `attachment; filename="JAWS-stock-order-${new Date().toISOString().slice(0, 10)}.xlsx"`)
  return res.status(200).send(buf)
})
