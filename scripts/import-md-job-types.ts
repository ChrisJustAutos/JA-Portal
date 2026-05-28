// scripts/import-md-job-types.ts
//
// Import MechanicDesk's "Job Types" export into the portal workshop tables.
//
//   npx tsx scripts/import-md-job-types.ts "C:/path/to/export-....xls"
//
// The MD export is a workbook with three sheets:
//   • Job Type Summaries     — one row per job type (name, description, est. hrs)
//   • Job Type Checklists     — work-checklist items (NOT imported yet — no
//                                checklist table in the portal)
//   • Job Type Invoice Items  — the template line items (labour + parts) that
//                                make up each preset job
//
// Job types upsert on `code` (= the MD job-type name, which is unique), so the
// import is idempotent — re-running updates rather than duplicating. Each job
// type's lines are replaced wholesale on every run. Line items are linked to
// workshop_inventory by SKU where a match exists.
//
// Needs Supabase service-role creds. Reads them from the environment, falling
// back to a local .env.local (NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY).

import * as fs from 'fs'
import * as path from 'path'
import * as XLSX from 'xlsx'
import { createClient } from '@supabase/supabase-js'

// ---- env -------------------------------------------------------------------
function loadEnvLocal() {
  const p = path.join(process.cwd(), '.env.local')
  if (!fs.existsSync(p)) return
  for (const raw of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = raw.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/)
    if (!m) continue
    let v = m[2].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    if (process.env[m[1]] === undefined) process.env[m[1]] = v
  }
}
loadEnvLocal()

const FILE = process.argv[2]
if (!FILE) { console.error('Usage: tsx scripts/import-md-job-types.ts <export.xls>'); process.exit(1) }
const URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!URL || !KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY (set them in .env.local).')
  process.exit(1)
}
const db = createClient(URL, KEY, { auth: { persistSession: false } })

// ---- helpers ---------------------------------------------------------------
const str = (v: any): string => (v == null ? '' : String(v).trim())
const numOr = (v: any, d: number): number => { const n = Number(v); return isFinite(n) ? n : d }
const round = (n: number, d = 4): number => Math.round(n * 10 ** d) / 10 ** d

function lineType(stock: string, desc: string): 'labour' | 'part' | 'sublet' | 'fee' {
  const s = (stock + ' ' + desc).toUpperCase()
  if (/^LAB\b/.test(stock.toUpperCase()) || s.includes('LABOUR')) return 'labour'
  if (s.includes('SUBLET')) return 'sublet'
  if (s.includes('MISC') || s.includes('ENVIRO') || s.includes('FREIGHT') || s.includes('DISPOSAL')) return 'fee'
  return 'part'
}

async function main() {
  const wb = XLSX.readFile(FILE)
  const sumSheet = wb.Sheets['Job Type Summaries']
  const itemSheet = wb.Sheets['Job Type Invoice Items']
  if (!sumSheet) throw new Error('No "Job Type Summaries" sheet in workbook')
  const summaries: any[] = XLSX.utils.sheet_to_json(sumSheet, { defval: null })
  const items: any[] = itemSheet ? XLSX.utils.sheet_to_json(itemSheet, { defval: null }) : []

  // 1) Upsert job types (idempotent on code = MD name) -----------------------
  const seen = new Set<string>()
  const jtRows = summaries.map((r, i) => {
    const name = str(r['Job Type'])
    if (!name || seen.has(name.toUpperCase())) return null
    seen.add(name.toUpperCase())
    const estHr = numOr(r['Estimated hour'], 0)
    return {
      name,
      code: name,
      md_id: name,
      description: r['Description'] ? String(r['Description']) : null,
      default_duration_min: estHr > 0 ? Math.round(estHr * 60) : null,
      active: true,
      sort_order: i * 10,
    }
  }).filter(Boolean) as any[]

  const idByCode = new Map<string, string>()
  for (let i = 0; i < jtRows.length; i += 200) {
    const { data, error } = await db
      .from('workshop_job_types')
      .upsert(jtRows.slice(i, i + 200), { onConflict: 'code' })
      .select('id, code')
    if (error) throw new Error('job_types upsert: ' + error.message)
    for (const row of data || []) idByCode.set(str(row.code).toUpperCase(), row.id)
  }
  console.log(`Job types upserted: ${jtRows.length}`)

  // 2) SKU -> inventory id map ----------------------------------------------
  const invBySku = new Map<string, string>()
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from('workshop_inventory').select('id, sku').range(from, from + 999)
    if (error) throw new Error('inventory: ' + error.message)
    for (const r of data || []) { const k = str(r.sku).toUpperCase(); if (k) invBySku.set(k, r.id) }
    if (!data || data.length < 1000) break
  }
  console.log(`Inventory items available for linking: ${invBySku.size}`)

  // 3) Replace each imported job type's lines --------------------------------
  const ids = Array.from(idByCode.values())
  for (let i = 0; i < ids.length; i += 100) {
    const { error } = await db.from('workshop_job_type_lines').delete().in('job_type_id', ids.slice(i, i + 100))
    if (error) throw new Error('lines delete: ' + error.message)
  }

  const sortByType = new Map<string, number>()
  let linked = 0, skippedNoType = 0
  const lineRows = items.map((r) => {
    const code = str(r['Job Type']).toUpperCase()
    const jtId = idByCode.get(code)
    if (!jtId) { skippedNoType++; return null }
    const stock = str(r['Stock Number'])
    const desc = r['Description'] ? String(r['Description']) : ''
    const incGst = str(r['Included GST']).toUpperCase() === 'Y'
    const price = numOr(r['Unit Price'], 0)
    const ex = incGst ? round(price / 1.1) : price
    const invId = stock ? invBySku.get(stock.toUpperCase()) || null : null
    if (invId) linked++
    const so = sortByType.get(jtId) || 0
    sortByType.set(jtId, so + 1)
    return {
      job_type_id: jtId,
      line_type: lineType(stock, desc),
      description: desc || null,
      part_number: stock || null,
      qty: numOr(r['Quantity'], 1),
      unit_price_ex_gst: ex,
      gst_rate: incGst ? 0.1 : 0,
      inventory_id: invId,
      sort_order: so,
    }
  }).filter(Boolean) as any[]

  for (let i = 0; i < lineRows.length; i += 500) {
    const { error } = await db.from('workshop_job_type_lines').insert(lineRows.slice(i, i + 500))
    if (error) throw new Error('lines insert: ' + error.message)
  }
  console.log(`Job-type lines inserted: ${lineRows.length} (linked to inventory: ${linked}, skipped — unknown job type: ${skippedNoType})`)
  console.log('Done.')
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1) })
