// pages/api/b2b/admin/catalogue/export.ts
// GET — download the whole B2B catalogue as an .xlsx for bulk editing (every
// editable field: pricing, visibility, freight, packaging, over-limit handling,
// promos, etc.). Re-import via /api/b2b/admin/catalogue/import. Columns + types
// are defined once in lib/b2b-catalogue-port so export and import stay in
// lockstep. Option fields (Packaging, Over-limit action, the TRUE/FALSE
// booleans) are written as in-cell DROPDOWNS so re-imports stay valid.
//
// Permission: edit:b2b_catalogue.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import ExcelJS from 'exceljs'
import { withAuth } from '../../../../../lib/authServer'
import { CATALOGUE_COLUMNS, CATALOGUE_SELECT, catalogueRowToExport } from '../../../../../lib/b2b-catalogue-port'

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  _sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  return _sb
}

export const config = { maxDuration: 60 }

// Roomier columns for free-text; everything else gets a sensible default.
function colWidth(header: string): number {
  if (['Name', 'Description', 'ID', 'Instructions URL', 'Image URL'].includes(header)) return 32
  if (['Promo Starts At', 'Promo Ends At', 'Inbound Freight Cost ex GST', 'Below Stock Call For Order', 'Call For Order When Zero'].includes(header)) return 22
  return 16
}

export default withAuth('edit:b2b_catalogue', async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'GET only' }) }
  const c = sb()
  // Page through so we get every item. Model + Product Type aren't plain
  // catalogue columns — embed the fitment join + the product-type name and
  // flatten them into the shape the shared exporter reads.
  const SELECT = `${CATALOGUE_SELECT}, model_links:b2b_catalogue_models ( b2b_models ( name ) ), product_type:b2b_product_types ( name )`
  const all: any[] = []
  const PAGE = 1000
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await c.from('b2b_catalogue').select(SELECT).order('sku', { ascending: true }).range(from, from + PAGE - 1)
    if (error) return res.status(500).json({ error: error.message })
    for (const row of (data || [])) {
      const it = row as any
      const models = (Array.isArray(it.model_links) ? it.model_links : [])
        .map((l: any) => l.b2b_models).filter((m: any) => m && m.name)
      const ptype = Array.isArray(it.product_type) ? it.product_type[0] : it.product_type
      it.product_type_name = ptype?.name || ''
      delete it.model_links
      delete it.product_type
      all.push({ ...it, models })
    }
    if (!data || data.length < PAGE) break
  }

  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Catalogue')
  ws.columns = CATALOGUE_COLUMNS.map(col => ({ header: col.header, key: col.header, width: colWidth(col.header) }))
  for (const item of all) ws.addRow(catalogueRowToExport(item))

  // Bold, frozen header row.
  ws.getRow(1).font = { bold: true }
  ws.views = [{ state: 'frozen', ySplit: 1 }]

  // In-cell dropdowns for option fields (enums + TRUE/FALSE booleans), applied
  // to every data row so edits + re-imports stay within the valid set.
  const lastRow = all.length + 1
  if (all.length > 0) {
    CATALOGUE_COLUMNS.forEach((col, idx) => {
      let formula: string | null = null
      if (col.kind === 'enum') formula = `"${col.enumValues!.join(',')}"`
      else if (col.kind === 'bool') formula = '"TRUE,FALSE"'
      if (!formula) return
      for (let r = 2; r <= lastRow; r++) {
        ws.getCell(r, idx + 1).dataValidation = { type: 'list', allowBlank: true, formulae: [formula] }
      }
    })
  }

  // Reference sheet: the valid model names, so the (now editable) Model column
  // uses exact spellings — anything unknown is rejected on import.
  const { data: modelRows } = await c.from('b2b_models').select('name').order('name', { ascending: true })
  const refs = wb.addWorksheet('Valid models')
  refs.columns = [{ header: 'Model name — use these (comma-separated) in the Model column', key: 'name', width: 56 }]
  refs.getRow(1).font = { bold: true }
  refs.views = [{ state: 'frozen', ySplit: 1 }]
  for (const m of (modelRows || [])) refs.addRow({ name: m.name })

  const buf = await wb.xlsx.writeBuffer()
  const today = new Date().toISOString().slice(0, 10)
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  res.setHeader('Content-Disposition', `attachment; filename="b2b-catalogue-${today}.xlsx"`)
  return res.status(200).send(Buffer.from(buf))
})
