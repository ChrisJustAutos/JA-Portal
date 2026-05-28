// One-off: parse the MD job-types export and emit SQL ready for execute_sql.
//
//   node scripts/_gen-md-job-types-sql.cjs "<path>" scripts/_md-job-types.sql
//
// Sections written, each on its own line so we can read & run them individually:
//   -- @SECTION: jobtypes
//   <INSERT INTO workshop_job_types ... VALUES (...) ON CONFLICT (code) DO UPDATE ...>
//   -- @SECTION: delete-lines
//   <DELETE FROM workshop_job_type_lines WHERE job_type_id IN (SELECT id FROM workshop_job_types WHERE code IN (...))>
//   -- @SECTION: lines-1
//   <INSERT ... lines batch 1>
//   -- @SECTION: lines-2
//   ...

const fs = require('fs')
const XLSX = require('xlsx')

const FILE = process.argv[2]
const OUT = process.argv[3] || 'scripts/_md-job-types.sql'
if (!FILE) { console.error('Usage: node _gen-md-job-types-sql.cjs <xls> [out.sql]'); process.exit(1) }

const q = (v) => v == null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`
const n = (v, d = null) => { const x = Number(v); return isFinite(x) ? x : (d == null ? 'NULL' : d) }
const round = (x, p = 4) => Math.round(x * 10 ** p) / 10 ** p

function lineType(stock, desc) {
  const s = (String(stock || '') + ' ' + String(desc || '')).toUpperCase()
  if (/^LAB\b/.test(String(stock || '').toUpperCase()) || s.includes('LABOUR')) return 'labour'
  if (s.includes('SUBLET')) return 'sublet'
  if (s.includes('MISC') || s.includes('ENVIRO') || s.includes('FREIGHT') || s.includes('DISPOSAL')) return 'fee'
  return 'part'
}

const wb = XLSX.readFile(FILE)
const summaries = XLSX.utils.sheet_to_json(wb.Sheets['Job Type Summaries'], { defval: null })
const items = XLSX.utils.sheet_to_json(wb.Sheets['Job Type Invoice Items'], { defval: null })

// Build job types (dedup on uppercased name)
const seen = new Set()
const jts = []
summaries.forEach((r, i) => {
  const name = String(r['Job Type'] || '').trim()
  if (!name) return
  const key = name.toUpperCase()
  if (seen.has(key)) return
  seen.add(key)
  const estHr = Number(r['Estimated hour'])
  jts.push({
    name,
    code: name,
    md_id: name,
    description: r['Description'] ? String(r['Description']) : null,
    default_duration_min: isFinite(estHr) && estHr > 0 ? Math.round(estHr * 60) : null,
    sort_order: i * 10,
  })
})

// Build lines, keyed by job-type-code (uppercase) for the SQL join
const sortByCode = new Map()
const lines = []
let skippedUnknownJT = 0
for (const r of items) {
  const code = String(r['Job Type'] || '').trim()
  if (!code) continue
  if (!seen.has(code.toUpperCase())) { skippedUnknownJT++; continue }
  const stock = r['Stock Number'] ? String(r['Stock Number']).trim() : null
  const desc = r['Description'] ? String(r['Description']) : null
  const incGst = String(r['Included GST'] || '').trim().toUpperCase() === 'Y'
  const price = Number(r['Unit Price']) || 0
  const ex = incGst ? round(price / 1.1) : price
  const so = sortByCode.get(code) || 0
  sortByCode.set(code, so + 1)
  lines.push({
    code,
    line_type: lineType(stock, desc),
    description: desc,
    part_number: stock,
    qty: Number(r['Quantity']) || 1,
    unit_price_ex_gst: ex,
    gst_rate: incGst ? 0.10 : 0,
    sort_order: so,
  })
}

// ─── Emit SQL ─────────────────────────────────────────────────────────────

const out = []

// Section: job types — chunk to keep each statement readable via the editor.
const JT_CHUNK = 40
for (let i = 0; i < jts.length; i += JT_CHUNK) {
  const slice = jts.slice(i, i + JT_CHUNK)
  out.push(`-- @SECTION: jobtypes-${Math.floor(i / JT_CHUNK) + 1}`)
  const values = slice.map(j =>
    `(${q(j.name)}, ${q(j.code)}, ${q(j.md_id)}, ${q(j.description)}, ${j.default_duration_min == null ? 'NULL' : j.default_duration_min}, true, ${j.sort_order})`
  ).join(',\n  ')
  out.push(
    `INSERT INTO workshop_job_types (name, code, md_id, description, default_duration_min, active, sort_order) VALUES\n  ${values}\n` +
    `ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name, md_id=EXCLUDED.md_id, description=EXCLUDED.description, default_duration_min=EXCLUDED.default_duration_min, sort_order=EXCLUDED.sort_order, active=true, updated_at=now();`
  )
}

// Section: delete old lines for these codes
out.push('-- @SECTION: delete-lines')
{
  const codes = jts.map(j => q(j.code)).join(', ')
  out.push(`DELETE FROM workshop_job_type_lines WHERE job_type_id IN (SELECT id FROM workshop_job_types WHERE code IN (${codes}));`)
}

// Section: lines — chunk to keep each statement well under any payload limit
const CHUNK = 150
for (let i = 0; i < lines.length; i += CHUNK) {
  const slice = lines.slice(i, i + CHUNK)
  const sec = `lines-${Math.floor(i / CHUNK) + 1}`
  out.push(`-- @SECTION: ${sec}`)
  const values = slice.map(l =>
    `(${q(l.code)}, ${q(l.line_type)}, ${q(l.description)}, ${q(l.part_number)}, ${l.qty}, ${l.unit_price_ex_gst}, ${l.gst_rate}, ${l.sort_order})`
  ).join(',\n  ')
  out.push(
    `WITH src AS (\n  SELECT * FROM (VALUES\n  ${values}\n  ) AS t(job_type_code, line_type, description, part_number, qty, unit_price_ex_gst, gst_rate, sort_order)\n)\n` +
    `INSERT INTO workshop_job_type_lines (job_type_id, line_type, description, part_number, qty, unit_price_ex_gst, gst_rate, inventory_id, sort_order)\n` +
    `SELECT jt.id, s.line_type, s.description, s.part_number, s.qty, s.unit_price_ex_gst, s.gst_rate,\n` +
    `       (SELECT id FROM workshop_inventory wi WHERE upper(wi.sku) = upper(s.part_number) LIMIT 1),\n` +
    `       s.sort_order\n` +
    `FROM src s JOIN workshop_job_types jt ON jt.code = s.job_type_code;`
  )
}

fs.writeFileSync(OUT, out.join('\n\n') + '\n', 'utf8')
const bytes = fs.statSync(OUT).size
console.log(`Wrote ${OUT}: job_types=${jts.length}, lines=${lines.length} (skipped unknown jt=${skippedUnknownJT}), ${bytes} bytes`)
