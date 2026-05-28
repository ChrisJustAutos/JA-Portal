// lib/md-importers/customers.ts
//
// MechanicDesk "Customers" sheet importer. Two phases:
//   • normalizeCustomerRows(rawRows) — pure, runs at upload time. Filters out
//     third-party + no-name rows and returns the cleaned import rows + a
//     summary count. No DB hit.
//   • runCustomersImport(db, rows)  — runs at confirm time. Pulls existing
//     workshop_customers, matches each MD row by mobile → email → name, and
//     either merges (fills missing fields, stamps md_id) or inserts new.
//
// Match strategy:
//   1. Mobile  — digits-only, last 9 chars (handles 0458... vs +6145...)
//   2. Email   — trimmed lowercase
//   3. Name    — full name, lowercase + whitespace collapsed
//
// Idempotent — md_id has a unique index, so re-running stamps anything not
// yet linked without producing duplicates.

import { SupabaseClient } from '@supabase/supabase-js'

const str = (v: any) => (v == null ? '' : String(v).trim())
export function normMobile(v: any): string {
  const digits = String(v || '').replace(/\D/g, '')
  if (digits.length < 7) return ''
  return digits.slice(-9)
}
const normEmail = (v: any) => String(v || '').trim().toLowerCase()
const normName = (v: any) => String(v || '').trim().toLowerCase().replace(/\s+/g, ' ')

export interface MdCustomerRow {
  md_id: string
  name: string
  first_name: string | null
  last_name: string | null
  mobile: string | null
  phone: string | null
  email: string | null
  address: string | null
  company: string | null
  customer_type: 'company' | 'individual'
  customer_number: string | null
}

export interface CustomerParseSummary {
  total_in_file: number
  skipped_third_party: number
  skipped_no_name: number
  total_to_import: number
}

function buildAddress(r: any): string | null {
  const parts: string[] = []
  if (str(r['Address'])) parts.push(str(r['Address']))
  const loc = [str(r['Suburb']), str(r['State']), str(r['Postcode'])].filter(Boolean).join(' ')
  if (loc) parts.push(loc)
  if (str(r['Country']) && str(r['Country']).toLowerCase() !== 'australia') parts.push(str(r['Country']))
  return parts.length ? parts.join(', ') : null
}

/**
 * Normalise raw "Customers" sheet rows into clean MdCustomerRow records.
 * Skips third-party rows and rows that have nothing usable at all.
 */
export function normalizeCustomerRows(rawRows: any[]): { rows: MdCustomerRow[]; summary: CustomerParseSummary } {
  let skippedThirdParty = 0
  let skippedNoName = 0
  const out: MdCustomerRow[] = []
  for (const r of rawRows) {
    if (String(r['Is Third Party'] || '').toUpperCase() === 'Y') { skippedThirdParty++; continue }
    const name = str(r['Name']) || [str(r['First Name']), str(r['Last Name'])].filter(Boolean).join(' ')
    if (!name) { skippedNoName++; continue }
    const mdId = str(r['Customer ID'])
    if (!mdId) { skippedNoName++; continue }
    const isCompany = String(r['Is Company'] || '').toUpperCase() === 'Y'
    out.push({
      md_id: mdId,
      name,
      first_name: str(r['First Name']) || null,
      last_name: str(r['Last Name']) || null,
      mobile: str(r['Mobile']) || null,
      phone: str(r['Phone']) || null,
      email: str(r['Email']) || null,
      address: buildAddress(r),
      company: isCompany ? name : null,
      customer_type: isCompany ? 'company' : 'individual',
      customer_number: str(r['Customer Number']) || null,
    })
  }
  return {
    rows: out,
    summary: {
      total_in_file: rawRows.length,
      skipped_third_party: skippedThirdParty,
      skipped_no_name: skippedNoName,
      total_to_import: out.length,
    },
  }
}

export interface CustomerRunSummary {
  matched_by_mobile: number
  matched_by_email: number
  matched_by_name: number
  already_linked: number
  inserted: number
  updated: number
  errors: number
}

interface Existing {
  id: string
  name: string | null
  first_name: string | null
  last_name: string | null
  mobile: string | null
  phone: string | null
  email: string | null
  address: string | null
  company: string | null
  customer_type: string | null
  customer_number: string | null
  md_id: string | null
}

/**
 * Apply a normalised batch of MD customer rows to workshop_customers, merging
 * with existing rows by mobile/email/name and inserting new where unmatched.
 * Returns counts. Errors are caught per batch so partial progress is preserved.
 */
export async function runCustomersImport(db: SupabaseClient, rows: MdCustomerRow[]): Promise<CustomerRunSummary> {
  // 1. Pull existing customers + build lookup maps.
  const existing: Existing[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from('workshop_customers')
      .select('id, name, first_name, last_name, mobile, phone, email, address, company, customer_type, customer_number, md_id')
      .range(from, from + 999)
    if (error) throw new Error('load existing: ' + error.message)
    if (!data || data.length === 0) break
    for (const r of data) existing.push(r as Existing)
    if (data.length < 1000) break
  }

  const byMobile = new Map<string, Existing>()
  const byEmail = new Map<string, Existing>()
  const byName = new Map<string, Existing>()
  const alreadyLinked = new Set<string>()
  for (const e of existing) {
    if (e.md_id) alreadyLinked.add(e.md_id)
    const m = normMobile(e.mobile) || normMobile(e.phone)
    if (m && !byMobile.has(m)) byMobile.set(m, e)
    const em = normEmail(e.email)
    if (em && !byEmail.has(em)) byEmail.set(em, e)
    const nm = normName(e.name)
    if (nm && !byName.has(nm)) byName.set(nm, e)
  }

  // 2. Classify each MD row.
  const updates: any[] = []
  const inserts: any[] = []
  const summary: CustomerRunSummary = {
    matched_by_mobile: 0, matched_by_email: 0, matched_by_name: 0,
    already_linked: 0, inserted: 0, updated: 0, errors: 0,
  }

  for (const r of rows) {
    if (alreadyLinked.has(r.md_id)) { summary.already_linked++; continue }

    const nMobile = normMobile(r.mobile) || normMobile(r.phone)
    const nEmail = normEmail(r.email)
    const nName = normName(r.name)

    let match: Existing | undefined
    let how: 'mobile' | 'email' | 'name' | null = null
    if (nMobile && byMobile.get(nMobile)) { match = byMobile.get(nMobile)!; how = 'mobile' }
    else if (nEmail && byEmail.get(nEmail)) { match = byEmail.get(nEmail)!; how = 'email' }
    else if (nName && byName.get(nName)) { match = byName.get(nName)!; how = 'name' }

    if (match && how) {
      if (how === 'mobile') summary.matched_by_mobile++
      else if (how === 'email') summary.matched_by_email++
      else summary.matched_by_name++

      updates.push({
        id: match.id,
        name: match.name,  // preserve user-curated name
        first_name: match.first_name || r.first_name,
        last_name: match.last_name || r.last_name,
        mobile: match.mobile || r.mobile,
        phone: match.phone || r.phone,
        email: match.email || r.email,
        address: match.address || r.address,
        company: match.company || r.company,
        customer_type: match.customer_type || r.customer_type,
        customer_number: match.customer_number || r.customer_number,
        md_id: r.md_id,
      })
      // Prevent two MD rows mapping to the same existing customer.
      const mm = normMobile(match.mobile) || normMobile(match.phone)
      const em = normEmail(match.email)
      const nm = normName(match.name)
      if (mm) byMobile.delete(mm)
      if (em) byEmail.delete(em)
      if (nm) byName.delete(nm)
      alreadyLinked.add(r.md_id)
    } else {
      inserts.push(r)
    }
  }

  // 3. Apply updates (upsert on id) and inserts in chunks.
  for (let i = 0; i < updates.length; i += 500) {
    const batch = updates.slice(i, i + 500)
    const { error } = await db.from('workshop_customers').upsert(batch, { onConflict: 'id' })
    if (error) { summary.errors += batch.length; continue }
    summary.updated += batch.length
  }
  for (let i = 0; i < inserts.length; i += 500) {
    const batch = inserts.slice(i, i + 500)
    const { error } = await db.from('workshop_customers').insert(batch)
    if (error) { summary.errors += batch.length; continue }
    summary.inserted += batch.length
  }

  return summary
}
