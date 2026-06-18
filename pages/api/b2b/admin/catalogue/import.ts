// pages/api/b2b/admin/catalogue/import.ts
// POST { file: <base64 .xlsx> } — bulk-update catalogue items from an edited
// export (dimensions, weights, trade price, visibility, packaging, etc.).
// Rows match on the ID column (falls back to SKU). Blank cells are left
// unchanged. Validation is all-or-nothing: a bad VALUE anywhere rejects the
// whole file so nothing is half-applied; rows whose SKU/ID can't be found are
// reported but don't block the rest.
//
// Permission: edit:b2b_catalogue.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import * as XLSX from 'xlsx'
import { withAuth } from '../../../../../lib/authServer'
import { catalogueRowToPatch } from '../../../../../lib/b2b-catalogue-port'

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  _sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  return _sb
}

export const config = { maxDuration: 120, api: { bodyParser: { sizeLimit: '20mb' } } }

export default withAuth('edit:b2b_catalogue', async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }) }
  const body = (req.body && typeof req.body === 'object') ? req.body : {}
  const fileB64 = String(body.file || '')
  if (!fileB64) return res.status(400).json({ error: 'No file provided' })

  let rows: any[]
  try {
    const buf = Buffer.from(fileB64.replace(/^data:[^,]*,/, ''), 'base64')
    const wb = XLSX.read(buf, { type: 'buffer' })
    const ws = wb.Sheets[wb.SheetNames[0]]
    if (!ws) return res.status(400).json({ error: 'Spreadsheet has no sheets' })
    rows = XLSX.utils.sheet_to_json(ws, { defval: '' })
  } catch (e: any) {
    return res.status(400).json({ error: `Could not read spreadsheet: ${e?.message || e}` })
  }
  if (!rows.length) return res.status(400).json({ error: 'Spreadsheet has no data rows' })
  if (rows.length > 10000) return res.status(400).json({ error: 'Too many rows (max 10000)' })

  // Parse + validate everything first; any bad VALUE rejects the whole file.
  const parsed: Array<{ id?: string; sku?: string; patch: Record<string, any>; modelNames?: string[]; rowNum: number }> = []
  const errors: string[] = []
  rows.forEach((r, i) => {
    const p = catalogueRowToPatch(r)
    if ('error' in p) { errors.push(`Row ${i + 2}: ${p.error}`); return }
    // Keep a row if it changes any catalogue field OR the model fitment.
    if (Object.keys(p.patch).length > 0 || p.modelNames !== undefined) parsed.push({ ...p, rowNum: i + 2 })
  })
  if (errors.length) return res.status(400).json({ error: 'Validation failed — nothing was changed.', details: errors.slice(0, 50) })
  if (parsed.length === 0) return res.status(200).json({ ok: true, updated: 0, failed: 0, totalRows: rows.length, note: 'No changes detected (all editable cells were blank/unchanged).' })

  const c = sb()
  // Resolve SKU-only rows to ids in one batch.
  const skuOnly = Array.from(new Set(parsed.filter(p => !p.id && p.sku).map(p => p.sku!)))
  const skuToId: Record<string, string> = {}
  if (skuOnly.length) {
    const { data } = await c.from('b2b_catalogue').select('id, sku').in('sku', skuOnly)
    for (const row of data || []) skuToId[String(row.sku)] = row.id
  }

  // Resolve Model names → ids (fitment lives in the b2b_catalogue_models join,
  // not a catalogue column). Match case-insensitively on name; any unknown name
  // rejects the WHOLE file so nothing is half-applied.
  const nameToId = new Map<string, string>()
  const allModelNames = Array.from(new Set(parsed.flatMap(p => p.modelNames || [])))
  if (allModelNames.length) {
    const { data: models, error: mErr } = await c.from('b2b_models').select('id, name')
    if (mErr) return res.status(500).json({ error: `Could not load models: ${mErr.message}` })
    for (const m of models || []) nameToId.set(String(m.name).trim().toLowerCase(), m.id)
    const unknown = Array.from(new Set(allModelNames.filter(n => !nameToId.has(n.trim().toLowerCase()))))
    if (unknown.length) {
      return res.status(400).json({ error: `Validation failed — nothing was changed. Unknown model name(s): ${unknown.join(', ')}. Add them under Models first, or fix the spelling.` })
    }
  }

  let updated = 0
  const failures: Array<{ row: number; error: string }> = []
  for (const p of parsed) {
    const id = p.id || (p.sku ? skuToId[p.sku] : undefined)
    if (!id) { failures.push({ row: p.rowNum, error: `no catalogue item found for SKU "${p.sku || ''}"` }); continue }
    // Catalogue column updates (skip if this row only changed the model fitment).
    if (Object.keys(p.patch).length > 0) {
      const { error } = await c.from('b2b_catalogue').update(p.patch).eq('id', id)
      if (error) { failures.push({ row: p.rowNum, error: error.message }); continue }
    }
    // Model fitment: replace the join rows with the resolved ids.
    if (p.modelNames !== undefined) {
      const ids = Array.from(new Set(p.modelNames.map(n => nameToId.get(n.trim().toLowerCase())).filter((x): x is string => !!x)))
      const { error: delErr } = await c.from('b2b_catalogue_models').delete().eq('catalogue_id', id)
      if (delErr) { failures.push({ row: p.rowNum, error: `model link: ${delErr.message}` }); continue }
      if (ids.length) {
        const { error: insErr } = await c.from('b2b_catalogue_models').insert(ids.map(m => ({ catalogue_id: id, model_id: m })))
        if (insErr) { failures.push({ row: p.rowNum, error: `model link: ${insErr.message}` }); continue }
      }
    }
    updated++
  }

  return res.status(200).json({ ok: failures.length === 0, updated, failed: failures.length, failures: failures.slice(0, 50), totalRows: rows.length })
})
