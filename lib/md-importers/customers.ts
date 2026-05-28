// lib/md-importers/customers.ts
//
// Customers importer for the MD migration UI.
//
// Pipeline:
//   1. Client maps source columns → portal field ids using ImportField.aliases.
//   2. Server calls normalize(mappedRows) — drops third-party + nameless rows,
//      composes the address from line/suburb/state/postcode/country.
//   3. Server calls run(db, normalized) — merges by mobile → email → name,
//      stamps md_id, fills empty fields, preserves myob_uid + curated name.

import { SupabaseClient } from '@supabase/supabase-js'
import { ImportField, ImportTypeConfig, MappedRow } from './types'

const str = (v: any) => (v == null ? '' : String(v).trim())
export function normMobile(v: any): string {
  const digits = String(v || '').replace(/\D/g, '')
  if (digits.length < 7) return ''
  return digits.slice(-9)
}
const normEmail = (v: any) => String(v || '').trim().toLowerCase()
const normName = (v: any) => String(v || '').trim().toLowerCase().replace(/\s+/g, ' ')

const FIELDS: ImportField[] = [
  { id: 'md_id',          label: 'MD Customer ID',  aliases: ['Customer ID', 'CustomerID', 'MD ID'], required: true },
  { id: 'name',           label: 'Name',            aliases: ['Name', 'Customer Name', 'Full Name'], required: true, hint: 'Falls back to First + Last if blank' },
  { id: 'first_name',     label: 'First name',      aliases: ['First Name', 'FirstName', 'Given Name'] },
  { id: 'last_name',      label: 'Last name',       aliases: ['Last Name', 'LastName', 'Surname', 'Family Name'] },
  { id: 'mobile',         label: 'Mobile',          aliases: ['Mobile', 'Mobile Phone', 'Cell'] },
  { id: 'phone',          label: 'Phone',           aliases: ['Phone', 'Landline', 'Telephone'] },
  { id: 'email',          label: 'Email',           aliases: ['Email', 'Email Address', 'E-mail'] },
  { id: 'address_line',   label: 'Address line',    aliases: ['Address', 'Street Address', 'Address Line', 'Address Line 1'] },
  { id: 'suburb',         label: 'Suburb',          aliases: ['Suburb', 'City', 'Town', 'Street Address Suburb'] },
  { id: 'state',          label: 'State',           aliases: ['State', 'Street Address State', 'Region'] },
  { id: 'postcode',       label: 'Postcode',        aliases: ['Postcode', 'Zip', 'Postal Code', 'Street Address Postcode'] },
  { id: 'country',        label: 'Country',         aliases: ['Country'] },
  { id: 'is_company',     label: 'Is company',      aliases: ['Is Company', 'Company', 'IsCompany'], hint: 'Y/N → company vs individual' },
  { id: 'is_third_party', label: 'Is third-party',  aliases: ['Is Third Party', 'Third Party', 'IsThirdParty'], hint: 'Y rows are skipped' },
  { id: 'customer_number', label: 'Customer #',     aliases: ['Customer Number', 'Customer No', 'CustNo'] },
]

function buildAddress(r: MappedRow): string | null {
  const parts: string[] = []
  if (str(r.address_line)) parts.push(str(r.address_line))
  const loc = [str(r.suburb), str(r.state), str(r.postcode)].filter(Boolean).join(' ')
  if (loc) parts.push(loc)
  if (str(r.country) && str(r.country).toLowerCase() !== 'australia') parts.push(str(r.country))
  return parts.length ? parts.join(', ') : null
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

function normalize(rows: MappedRow[]) {
  let skippedThirdParty = 0
  let skippedNoName = 0
  const out: MappedRow[] = []
  for (const r of rows) {
    if (String(r.is_third_party || '').toUpperCase() === 'Y') { skippedThirdParty++; continue }
    const name = str(r.name) || [str(r.first_name), str(r.last_name)].filter(Boolean).join(' ')
    if (!name) { skippedNoName++; continue }
    const mdId = str(r.md_id)
    if (!mdId) { skippedNoName++; continue }
    const isCompany = String(r.is_company || '').toUpperCase() === 'Y'
    out.push({
      md_id: mdId,
      name,
      first_name: str(r.first_name) || null,
      last_name: str(r.last_name) || null,
      mobile: str(r.mobile) || null,
      phone: str(r.phone) || null,
      email: str(r.email) || null,
      address: buildAddress(r),
      company: isCompany ? name : null,
      customer_type: isCompany ? 'company' : 'individual',
      customer_number: str(r.customer_number) || null,
    })
  }
  return {
    rows: out,
    summary: {
      total_in_file: rows.length,
      skipped_third_party: skippedThirdParty,
      skipped_no_name: skippedNoName,
      total_to_import: out.length,
    },
  }
}

async function run(db: SupabaseClient, rows: MappedRow[]): Promise<any> {
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

  const updates: any[] = []
  const inserts: any[] = []
  const summary = { matched_by_mobile: 0, matched_by_email: 0, matched_by_name: 0, already_linked: 0, inserted: 0, updated: 0, errors: 0 }

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
        name: match.name,
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

export const CUSTOMERS_CONFIG: ImportTypeConfig = {
  id: 'customers',
  label: 'Customers',
  sheets: ['Customers', 'Customer'],
  fields: FIELDS,
  normalize,
  run,
  blurb: 'Customers are merged with existing rows by mobile → email → name. Unmatched rows are inserted. Third-party rows are skipped. Preserves MYOB UIDs.',
}
