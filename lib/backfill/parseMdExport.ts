// lib/backfill/parseMdExport.ts
// Parse an uploaded Mechanics Desk export into MdJobRow rows.
// Accepts XLS, XLSX, or CSV. Uses the existing xlsx dependency.

import * as XLSX from 'xlsx'
import type { MdJobRow } from './matcher'
import { normaliseEmail, normalisePhone } from './normalise'

// MD export column headers we care about. Exact match, case-insensitive.
const COL_JOB_NUMBER = 'job number'
const COL_CUSTOMER_EMAIL = 'customer email'
const COL_CUSTOMER_PHONE = 'customer phone'
const COL_CREATED_BY = 'created by'
const COL_CREATED_DATE = 'created date'

// Parse a bytes buffer (from uploaded file). Returns (rows, warnings[]).
export function parseMdExport(buffer: Buffer, filename: string): { rows: MdJobRow[]; warnings: string[] } {
  const warnings: string[] = []

  // Read with xlsx — handles .xls, .xlsx, .csv transparently
  let wb: XLSX.WorkBook
  try {
    wb = XLSX.read(buffer, { type: 'buffer', cellDates: true })
  } catch (e: any) {
    throw new Error(`Could not parse uploaded file: ${e.message || e}`)
  }
  const sheetName = wb.SheetNames[0]
  if (!sheetName) throw new Error('Uploaded file has no sheets.')
  const sheet = wb.Sheets[sheetName]
  const rows = XLSX.utils.sheet_to_json<any>(sheet, { defval: null, raw: false })
  if (!rows.length) throw new Error('Uploaded file has no data rows.')

  // Map first row's keys case-insensitively
  const firstRow = rows[0]
  const keyMap = new Map<string, string>()
  for (const k of Object.keys(firstRow)) {
    keyMap.set(String(k).trim().toLowerCase(), k)
  }

  const kJob    = keyMap.get(COL_JOB_NUMBER)
  const kEmail  = keyMap.get(COL_CUSTOMER_EMAIL)
  const kPhone  = keyMap.get(COL_CUSTOMER_PHONE)
  const kRep    = keyMap.get(COL_CREATED_BY)
  const kDate   = keyMap.get(COL_CREATED_DATE)

  if (!kJob) throw new Error('Could not find "Job Number" column in the upload.')
  if (!kEmail) warnings.push('No "Customer Email" column found — all rows will fail to match.')

  const out: MdJobRow[] = []
  let missingEmail = 0
  for (const row of rows) {
    const jobNumber = String(row[kJob] ?? '').trim()
    if (!jobNumber) continue
    const email = kEmail ? normaliseEmail(row[kEmail]) : null
    const phone = kPhone ? normalisePhone(row[kPhone]) : null
    if (!email) missingEmail++

    let createdDate: string | null = null
    if (kDate && row[kDate]) {
      const raw = row[kDate]
      // xlsx returns strings with cellDates + raw:false; if it's a Date, convert
      if (raw instanceof Date && !isNaN(raw.getTime())) {
        createdDate = raw.toISOString().slice(0, 10)
      } else {
        // Try parsing DD/MM/YYYY, DD-MM-YYYY, YYYY-MM-DD
        const s = String(raw).trim()
        const mDMY = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/)
        const mYMD = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
        if (mDMY) {
          let year = Number(mDMY[3])
          if (year < 100) year += 2000
          const month = Number(mDMY[2]).toString().padStart(2, '0')
          const day = Number(mDMY[1]).toString().padStart(2, '0')
          createdDate = `${year}-${month}-${day}`
        } else if (mYMD) {
          createdDate = `${mYMD[1]}-${mYMD[2].padStart(2, '0')}-${mYMD[3].padStart(2, '0')}`
        }
      }
    }

    out.push({
      job_number: jobNumber,
      customer_email_norm: email,
      customer_phone_norm: phone,
      created_by: kRep ? (row[kRep] ?? null) : null,
      created_date: createdDate,
    })
  }

  if (missingEmail > 0) {
    warnings.push(`${missingEmail} row(s) have no email — these will match as "no_email_in_md".`)
  }
  if (!out.length) {
    throw new Error('No job rows parsed from the upload.')
  }
  return { rows: out, warnings }
}
