// pages/api/b2b/admin/reorder/export.ts
// GET — styled .xlsx export of the reorder sheet with LIVE FORMULAS (mirrors the
// JAWS Stock Order master). Editable Growth % / Cover months / Months-in-range
// param cells + per-row formulas; built with ExcelJS so it carries header fills,
// borders, banding, frozen header, autofilter and number formats.
// Permission: edit:b2b_catalogue.

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import ExcelJS from 'exceljs'
import { withAuth } from '../../../../../lib/authServer'
import { monthsInRange, computeReorder, ReorderSettings } from '../../../../../lib/b2b-reorder'

export const config = { maxDuration: 30 }

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  _sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  return _sb
}
const num = (v: any) => Number(v) || 0
const r2 = (n: number) => Math.round(n * 100) / 100

// Palette
const NAVY = 'FF1F3A5F', NAVY_TXT = 'FFFFFFFF', BAND = 'FFF4F7FB', BORDER = 'FFD1D5DB'
const GREEN_FILL = 'FFE3F6E9', AMBER_FILL = 'FFFCEFD6', PARAM_FILL = 'FFEAF1FB'

// Find a Just Autos logo (B2B email logo first, else any portal company logo)
// and download it. Returns null on anything unsupported so the export never fails.
async function loadLogo(db: SupabaseClient): Promise<{ buffer: Buffer; extension: 'png' | 'jpeg' | 'gif' } | null> {
  try {
    let url = ''
    const { data: bs } = await db.from('b2b_settings').select('email_logo_url').eq('id', 'singleton').maybeSingle()
    url = String((bs as any)?.email_logo_url || '').trim()
    if (!url) {
      const { data: pref } = await db.from('user_preferences').select('company_logo_url').not('company_logo_url', 'is', null).limit(1).maybeSingle()
      url = String((pref as any)?.company_logo_url || '').trim()
    }
    if (!url) return null
    const resp = await fetch(url)
    if (!resp.ok) return null
    const ct = (resp.headers.get('content-type') || '').toLowerCase()
    const lower = url.toLowerCase()
    const ext: 'png' | 'jpeg' | 'gif' | null =
      ct.includes('png') || lower.endsWith('.png') ? 'png'
      : ct.includes('jpeg') || ct.includes('jpg') || /\.jpe?g($|\?)/.test(lower) ? 'jpeg'
      : ct.includes('gif') || lower.endsWith('.gif') ? 'gif'
      : null
    if (!ext) return null   // webp/svg not supported by ExcelJS images
    return { buffer: Buffer.from(await resp.arrayBuffer()), extension: ext }
  } catch { return null }
}

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
  const settings: ReorderSettings = { from_date: s?.from_date || null, to_date: s?.to_date || null, growth_pct: growth, forecast_months: coverMonths }
  const list = items || []

  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Stock Order', { views: [{ state: 'frozen', ySplit: 6 }] })

  // ── Just Autos logo (top-right of the header area) ──
  const logo = await loadLogo(db)
  if (logo) {
    try {
      const imgId = wb.addImage({ buffer: logo.buffer as any, extension: logo.extension })
      ws.addImage(imgId, { tl: { col: 11, row: 0 } as any, ext: { width: 220, height: 64 } })
    } catch { /* logo is best-effort */ }
  }

  // ── Title + editable parameter block (rows 1–4) ──
  ws.getCell('A1').value = 'JAWS Stock Order'
  ws.getCell('A1').font = { bold: true, size: 14 }
  ws.getCell('C1').value = s?.from_date && s?.to_date ? `Sales ${s.from_date} → ${s.to_date}` : 'Sales range not set'
  ws.getCell('C1').font = { italic: true, color: { argb: 'FF6B7280' } }
  const params: Array<[string, string, any, string?]> = [
    ['A2', 'Growth %', growth, '0%'],
    ['A3', 'Cover months', coverMonths],
    ['A4', 'Months in range', months],
  ]
  for (const [addr, label, val, fmt] of params) {
    ws.getCell(addr).value = label
    ws.getCell(addr).font = { bold: true, color: { argb: 'FF374151' } }
    const valCell = ws.getCell(addr.replace('A', 'B'))
    valCell.value = val
    if (fmt) valCell.numFmt = fmt
    for (const c of [ws.getCell(addr), valCell]) {
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PARAM_FILL } }
      c.border = { top: { style: 'thin', color: { argb: BORDER } }, bottom: { style: 'thin', color: { argb: BORDER } }, left: { style: 'thin', color: { argb: BORDER } }, right: { style: 'thin', color: { argb: BORDER } } }
    }
  }

  // ── Header row (row 6) ──
  const headers = [
    'Stock No.', 'Name', 'On Hand', 'Committed', 'Available', 'On Order', 'Total Sales',
    'Monthly Avg', 'Monthly Round Up', '+Growth', 'Projected',
    'Estiamted On Hand After 3 Months', 'Adjusted Proposed New Order Volume', 'MOQ',
    'Commited - New Order Volume', "Morgan's Judgment", 'Proposed New Order Volume', 'Notes',
  ]
  const HEAD_ROW = 6
  headers.forEach((h, i) => {
    const cell = ws.getCell(HEAD_ROW, i + 1)
    cell.value = h
    cell.font = { bold: true, color: { argb: NAVY_TXT }, size: 10 }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } }
    cell.alignment = { vertical: 'middle', horizontal: i <= 1 ? 'left' : 'center', wrapText: true }
    cell.border = { top: { style: 'thin', color: { argb: NAVY } }, bottom: { style: 'thin', color: { argb: NAVY } }, left: { style: 'thin', color: { argb: NAVY } }, right: { style: 'thin', color: { argb: NAVY } } }
  })
  ws.getRow(HEAD_ROW).height = 42

  const thin = { style: 'thin' as const, color: { argb: BORDER } }
  const allBorders = { top: thin, bottom: thin, left: thin, right: thin }

  // ── Data rows (formulas + cached results) ──
  list.forEach((it: any, i: number) => {
    const R = HEAD_ROW + 1 + i
    const c = computeReorder(it, settings, months)
    const adjusted = Math.max(c.shortfall, 0)
    const row = ws.getRow(R)
    const cells: Record<string, any> = {
      A: String(it.sku || ''),
      B: String(it.name || ''),
      C: num(it.on_hand),
      D: num(it.committed),
      E: { formula: `C${R}-D${R}`, result: r2(c.available) },
      F: num(it.on_order),
      G: num(it.sales_qty),
      H: { formula: `IF($B$4=0,0,G${R}/$B$4)`, result: r2(c.monthlyAvg) },
      I: { formula: `ROUNDUP(H${R},0)`, result: c.monthlyRound },
      J: { formula: `ROUNDUP(I${R}*(1+$B$2),0)`, result: c.withGrowth },
      K: { formula: `J${R}*$B$3`, result: c.projected },
      L: { formula: `K${R}-(E${R}+F${R})`, result: r2(c.shortfall) },
      M: { formula: `MAX(L${R},0)`, result: adjusted },
      N: it.moq != null ? Number(it.moq) : null,
      O: { formula: `IF(M${R}=0,0,IF(N${R}>0,CEILING(M${R},N${R}),IF(M${R}<=5,CEILING(M${R},5),CEILING(M${R},15))))`, result: c.suggested },
      P: it.morgans_judgment != null ? Number(it.morgans_judgment) : null,
      Q: { formula: `IF(P${R}="",O${R},P${R})`, result: c.finalOrder },
      R: String(it.notes || ''),
    }
    for (const [col, val] of Object.entries(cells)) {
      const cell = ws.getCell(`${col}${R}`)
      if (val !== null) cell.value = val
      cell.border = allBorders
      cell.font = { size: 10 }
      if (col === 'A') cell.font = { size: 10, name: 'Consolas' }
      if (!['A', 'B', 'R'].includes(col)) cell.alignment = { horizontal: 'right' }
      if (i % 2 === 1) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BAND } }
    }
    // Highlights
    if (c.shortfall > 0) ws.getCell(`L${R}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: AMBER_FILL } }
    const finalCell = ws.getCell(`Q${R}`)
    finalCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GREEN_FILL } }
    finalCell.font = { size: 10, bold: true, color: { argb: 'FF1B7A3D' } }
    if (it.morgans_judgment != null) ws.getCell(`P${R}`).font = { size: 10, bold: true, color: { argb: 'FFB7791F' } }
    row.height = 16
  })

  // Number format for the numeric columns
  const lastRow = HEAD_ROW + list.length
  for (let col = 3; col <= 17; col++) {
    if (col === 14 || col === 16) continue // MOQ / Morgan's keep plain
    ws.getColumn(col).numFmt = col === 8 ? '#,##0.0' : '#,##0'
  }

  // Column widths
  const widths = [16, 34, 9, 10, 9, 9, 11, 11, 13, 9, 10, 16, 16, 7, 16, 13, 16, 30]
  widths.forEach((w, i) => { ws.getColumn(i + 1).width = w })

  // Autofilter on the header row
  if (list.length) ws.autoFilter = { from: { row: HEAD_ROW, column: 1 }, to: { row: lastRow, column: 18 } }

  const buf = await wb.xlsx.writeBuffer()
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  res.setHeader('Content-Disposition', `attachment; filename="JAWS-stock-order-${new Date().toISOString().slice(0, 10)}.xlsx"`)
  return res.status(200).send(Buffer.from(buf))
})
