// lib/job-report-parser.ts
// Parse a Mechanics Desk job report export (CSV or XLSX) into normalised rows.
//
// Mechanics Desk column names vary between exports; we do fuzzy header
// matching so the same parser works whether the export is "Job Number" or
// "JobNo" or "Job #".

import * as XLSX from 'xlsx'

export interface ParsedJob {
  job_number: string
  customer_name: string | null
  vehicle: string | null
  status: string | null
  opened_date: string | null        // YYYY-MM-DD
  closed_date: string | null
  job_type: string | null
  estimated_total: number | null    // dollars, inc GST (stored as parsed)
  raw: Record<string, any>
}

export interface ParsedJobReport {
  jobs: ParsedJob[]
  warnings: string[]
  detectedFormat: 'csv' | 'xlsx'
  headerMap: Record<string, string>  // our-key -> detected-column
}

// Header aliases — lowercased. Add more as we see exports.
// The matcher tries aliases in order, so put MORE SPECIFIC ones first:
// "quoted total" before "total" because Mechanics Desk has both columns.
const HEADER_ALIASES: Record<string, string[]> = {
  job_number:      ['job number', 'job no.', 'job no', 'job#', 'job #', 'jobno', 'jobnumber', 'job', 'job id'],
  customer_name:   ['customer', 'customer name', 'client', 'client name'],
  vehicle:         ['vehicle', 'rego', 'registration', 'make/model', 'make model', 'vehicle details'],
  status:          ['status', 'job status', 'state'],
  // "job date" must come before generic "date" aliases. In Mechanics Desk
  // "Booking Created At" is often null — "Job Date" is populated for all rows.
  opened_date:     ['job date', 'opened', 'opened date', 'date opened', 'booking created at', 'created', 'date created', 'booking date', 'start date'],
  closed_date:     ['finished date', 'closed', 'closed date', 'date closed', 'completed', 'completed date', 'end date', 'finished'],
  // "job types" (plural) is what Mechanics Desk uses — put it first so it wins.
  job_type:        ['job types', 'job type', 'service type', 'work type', 'service category', 'category', 'type'],
  // "quoted total" wins over "total" so we get the pre-job estimate rather
  // than the actual invoiced amount.
  estimated_total: ['quoted total', 'estimated total', 'estimate total', 'estimated value', 'quote total', 'quote value', 'quoted amount', 'quoted', 'estimate', 'total estimated', 'total value', 'job total', 'invoice total', 'total'],
}

// Noise tags in Mechanics Desk "Job Types" that we strip when deriving the
// primary type. These appear on nearly every job and carry no reporting value.
const JOB_TYPE_NOISE = [
  'all vehicle check-in process',
  'da - deposit applied',
  'bd - booking deposit',
  'sub job (internal booking/no invoice)',
  'additional work approved',
]

// Given the raw "Job Types" string (e.g. "Remap, All Vehicle Check-In Process"),
// return the primary (non-noise) type. If all are noise, return the first.
function primaryJobType(raw: any): string | null {
  if (raw === null || raw === undefined) return null
  const parts = String(raw).split(',').map(s => s.trim()).filter(Boolean)
  if (parts.length === 0) return null
  const signal = parts.filter(p => !JOB_TYPE_NOISE.includes(p.toLowerCase()))
  return signal[0] || parts[0]
}

// Parse a value that might be "$1,234.56" / "1234.56" / 1234.56 / "" into a number or null.
function parseMoney(v: any): number | null {
  if (v === null || v === undefined || v === '') return null
  if (typeof v === 'number' && !isNaN(v)) return v
  const s = String(v).trim().replace(/[$,\s]/g, '')
  if (!s) return null
  const n = parseFloat(s)
  return isNaN(n) ? null : n
}

function findColumn(headers: string[], aliases: string[]): string | null {
  const lower = headers.map(h => String(h || '').trim().toLowerCase())
  for (const alias of aliases) {
    const idx = lower.indexOf(alias)
    if (idx >= 0) return headers[idx]
  }
  // partial match fallback
  for (const alias of aliases) {
    const idx = lower.findIndex(h => h.includes(alias))
    if (idx >= 0) return headers[idx]
  }
  return null
}

// Best-effort date normaliser. Handles: Excel serials, ISO strings, DD/MM/YYYY,
// MM/DD/YYYY (detected by impossible day/month combos), DD-MM-YY, etc.
function normDate(v: any): string | null {
  if (v === null || v === undefined || v === '') return null
  if (typeof v === 'number') {
    // Excel serial date
    const d = XLSX.SSF.parse_date_code(v)
    if (d) return `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`
  }
  const s = String(v).trim()
  if (!s) return null

  // ISO already
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.substring(0, 10)

  // DD/MM/YYYY or DD-MM-YYYY
  const m = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})/)
  if (m) {
    let [, a, b, y] = m
    let day = parseInt(a, 10), month = parseInt(b, 10)
    // If the first number is >12, it's definitely the day (AU format)
    // Otherwise assume DD/MM (AU default)
    if (day > 12 && month <= 12) { /* already day/month */ }
    else if (day <= 12 && month > 12) { [day, month] = [month, day] }
    const yr = y.length === 2 ? (parseInt(y, 10) < 50 ? 2000 + parseInt(y, 10) : 1900 + parseInt(y, 10)) : parseInt(y, 10)
    return `${yr}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  }

  return null
}

export function parseJobReport(buf: Buffer, filename: string): ParsedJobReport {
  const lower = filename.toLowerCase()
  const isCSV = lower.endsWith('.csv') || lower.endsWith('.txt')
  const format: 'csv' | 'xlsx' = isCSV ? 'csv' : 'xlsx'
  const warnings: string[] = []

  const workbook = XLSX.read(buf, { type: 'buffer', cellDates: false })
  const firstSheetName = workbook.SheetNames[0]
  if (!firstSheetName) throw new Error('File has no sheets')

  // Convert to array of objects using first row as headers
  const rows = XLSX.utils.sheet_to_json<Record<string, any>>(workbook.Sheets[firstSheetName], { defval: null, raw: true })
  if (rows.length === 0) {
    warnings.push('No data rows found')
    return { jobs: [], warnings, detectedFormat: format, headerMap: {} }
  }

  const headers = Object.keys(rows[0])
  const headerMap: Record<string, string> = {}
  for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
    const col = findColumn(headers, aliases)
    if (col) headerMap[key] = col
  }

  if (!headerMap.job_number) {
    throw new Error(`Could not find a "Job Number" column. Headers were: ${headers.join(', ')}`)
  }

  const jobs: ParsedJob[] = []
  for (const row of rows) {
    const jobNumberRaw = row[headerMap.job_number]
    if (jobNumberRaw === null || jobNumberRaw === undefined || String(jobNumberRaw).trim() === '') continue

    const closedDate = headerMap.closed_date ? normDate(row[headerMap.closed_date]) : null
    let status: string | null = null
    if (headerMap.status) {
      status = row[headerMap.status] ?? null
    } else {
      // No explicit status column (Mechanics Desk export doesn't have one).
      // Derive it from closed_date: if the job has a finished/closed date,
      // it's "Completed", otherwise "Open".
      status = closedDate ? 'Completed' : 'Open'
    }

    jobs.push({
      job_number: String(jobNumberRaw).trim(),
      customer_name:   headerMap.customer_name   ? (row[headerMap.customer_name] ?? null) : null,
      vehicle:         headerMap.vehicle         ? (row[headerMap.vehicle] ?? null) : null,
      status,
      opened_date:     headerMap.opened_date     ? normDate(row[headerMap.opened_date]) : null,
      closed_date:     closedDate,
      job_type:        headerMap.job_type        ? primaryJobType(row[headerMap.job_type]) : null,
      estimated_total: headerMap.estimated_total ? parseMoney(row[headerMap.estimated_total]) : null,
      raw: row,
    })
  }

  if (jobs.length === 0) warnings.push('Header row matched but no data rows had valid job numbers')
  if (!headerMap.status && headerMap.closed_date) {
    warnings.push('No explicit Status column — deriving Open/Completed from Finished Date')
  }

  return { jobs, warnings, detectedFormat: format, headerMap }
}
