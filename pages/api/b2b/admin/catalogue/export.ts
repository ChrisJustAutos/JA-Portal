// pages/api/b2b/admin/catalogue/export.ts
// GET — download the whole B2B catalogue as an .xlsx for bulk editing
// (dimensions, weights, trade price, visibility, etc.). Re-import via
// /api/b2b/admin/catalogue/import. Columns + types are defined once in
// lib/b2b-catalogue-port so export and import stay in lockstep.
//
// Permission: edit:b2b_catalogue.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import * as XLSX from 'xlsx'
import { withAuth } from '../../../../../lib/authServer'
import { CATALOGUE_COLUMNS, CATALOGUE_SELECT, catalogueRowToExport } from '../../../../../lib/b2b-catalogue-port'

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  _sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  return _sb
}

export const config = { maxDuration: 60 }

export default withAuth('edit:b2b_catalogue', async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'GET only' }) }
  const c = sb()
  // Page through so we get every item (Supabase caps a single select).
  const all: any[] = []
  const PAGE = 1000
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await c.from('b2b_catalogue').select(CATALOGUE_SELECT).order('sku', { ascending: true }).range(from, from + PAGE - 1)
    if (error) return res.status(500).json({ error: error.message })
    all.push(...(data || []))
    if (!data || data.length < PAGE) break
  }

  const ws = XLSX.utils.json_to_sheet(all.map(catalogueRowToExport), { header: CATALOGUE_COLUMNS.map(col => col.header) })
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Catalogue')
  const buf: Buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })

  const today = new Date().toISOString().slice(0, 10)
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  res.setHeader('Content-Disposition', `attachment; filename="b2b-catalogue-${today}.xlsx"`)
  return res.status(200).send(buf)
})
