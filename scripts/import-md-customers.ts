// scripts/import-md-customers.ts
//
// Import the MechanicDesk "Customers" export into workshop_customers, merging
// with existing rows (most of which came from the MYOB sync) so we don't end
// up with two cards for the same person.
//
//   npx tsx scripts/import-md-customers.ts "C:/path/to/export-....xls"
//
// Match strategy (first one wins per MD row):
//   1. Mobile  — digits-only, last 9 chars (handles 0458... vs +6145...)
//   2. Email   — trimmed lowercase
//   3. Name    — full name, lowercase + whitespace collapsed
//
// When a MD row matches an existing customer:
//   • stamp md_id (always) + customer_number (if blank).
//   • fill mobile/phone/email/first_name/last_name/address/company/customer_type
//     only when the existing field is empty. Never overwrite name or notes.
//   • preserves myob_uid untouched.
//
// When nothing matches: insert a new customer with md_id set.
//
// Idempotent — re-running stamps md_id wherever it's missing without
// re-inserting matched rows (md_id has a unique index).

import * as fs from 'fs'
import * as path from 'path'
import * as XLSX from 'xlsx'
import { createClient } from '@supabase/supabase-js'

// ── env from .env.local ─────────────────────────────────────────────────────
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
if (!FILE) { console.error('Usage: tsx scripts/import-md-customers.ts <export.xls>'); process.exit(1) }
const URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!URL || !KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY (set them in .env.local).')
  process.exit(1)
}
const db = createClient(URL, KEY, { auth: { persistSession: false } })

// ── helpers ─────────────────────────────────────────────────────────────────
const str = (v: any) => (v == null ? '' : String(v).trim())
function normMobile(v: any): string {
  const digits = String(v || '').replace(/\D/g, '')
  if (digits.length < 7) return ''
  return digits.slice(-9)  // last 9 (drops 0/61 prefix; matches both 0458... and +6145...)
}
const normEmail = (v: any) => String(v || '').trim().toLowerCase()
const normName = (v: any) => String(v || '').trim().toLowerCase().replace(/\s+/g, ' ')
function buildAddress(r: any): string | null {
  const parts: string[] = []
  if (str(r['Address'])) parts.push(str(r['Address']))
  const loc = [str(r['Suburb']), str(r['State']), str(r['Postcode'])].filter(Boolean).join(' ')
  if (loc) parts.push(loc)
  if (str(r['Country']) && str(r['Country']).toLowerCase() !== 'australia') parts.push(str(r['Country']))
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

async function main() {
  // ── 1. Parse the MD export ────────────────────────────────────────────────
  console.log(`Reading ${FILE}…`)
  const wb = XLSX.readFile(FILE)
  const sheet = wb.Sheets['Customers']
  if (!sheet) throw new Error('No "Customers" sheet')
  const raw: any[] = XLSX.utils.sheet_to_json(sheet, { defval: null })
  console.log(`MD rows: ${raw.length}`)

  // Skip third-party (delivery partners etc.) + rows with NO identifier at all.
  let skippedThirdParty = 0
  let skippedNoName = 0
  const mdRows = raw.filter(r => {
    if (String(r['Is Third Party'] || '').toUpperCase() === 'Y') { skippedThirdParty++; return false }
    if (!str(r['Name']) && !str(r['First Name']) && !str(r['Last Name'])) { skippedNoName++; return false }
    return true
  })
  console.log(`Kept ${mdRows.length} MD customers (skipped: ${skippedThirdParty} third-party, ${skippedNoName} no-name)`)

  // ── 2. Pull existing portal customers + build lookup maps ─────────────────
  console.log('Loading existing portal customers…')
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
  console.log(`Loaded ${existing.length} existing customers`)

  const byMobile = new Map<string, Existing>()
  const byEmail = new Map<string, Existing>()
  const byName = new Map<string, Existing>()
  const alreadyLinkedMdIds = new Set<string>()
  for (const e of existing) {
    if (e.md_id) alreadyLinkedMdIds.add(e.md_id)
    const m = normMobile(e.mobile) || normMobile(e.phone)
    if (m && !byMobile.has(m)) byMobile.set(m, e)
    const em = normEmail(e.email)
    if (em && !byEmail.has(em)) byEmail.set(em, e)
    const nm = normName(e.name)
    if (nm && !byName.has(nm)) byName.set(nm, e)
  }

  // ── 3. Classify each MD row: skip already-linked, match, or new ───────────
  const updates: any[] = []  // upsert rows (full state) for matched existing customers
  const inserts: any[] = []  // brand-new rows
  let mMobile = 0, mEmail = 0, mName = 0, mAlready = 0
  for (const r of mdRows) {
    const mdId = str(r['Customer ID'])
    if (!mdId) continue
    if (alreadyLinkedMdIds.has(mdId)) { mAlready++; continue }

    const name = str(r['Name']) || [str(r['First Name']), str(r['Last Name'])].filter(Boolean).join(' ') || 'Unknown'
    const firstName = str(r['First Name']) || null
    const lastName = str(r['Last Name']) || null
    const mobile = str(r['Mobile']) || null
    const phone = str(r['Phone']) || null
    const email = str(r['Email']) || null
    const address = buildAddress(r)
    const isCompany = String(r['Is Company'] || '').toUpperCase() === 'Y'
    const customerNumber = str(r['Customer Number']) || null

    const nMobile = normMobile(mobile) || normMobile(phone)
    const nEmail = normEmail(email)
    const nName = normName(name)

    const match = (nMobile && byMobile.get(nMobile))
      || (nEmail && byEmail.get(nEmail))
      || (nName && byName.get(nName))

    if (match) {
      if (nMobile && byMobile.get(nMobile) === match) mMobile++
      else if (nEmail && byEmail.get(nEmail) === match) mEmail++
      else mName++

      // Fill missing fields; never overwrite name; always stamp md_id.
      updates.push({
        id: match.id,
        name: match.name,  // preserve
        first_name: match.first_name || firstName,
        last_name: match.last_name || lastName,
        mobile: match.mobile || mobile,
        phone: match.phone || phone,
        email: match.email || email,
        address: match.address || address,
        company: match.company || (isCompany ? name : null),
        customer_type: match.customer_type || (isCompany ? 'company' : 'individual'),
        customer_number: match.customer_number || customerNumber,
        md_id: mdId,
      })
      // Mark this existing row as taken so two MD rows don't map to the same
      // existing customer (would cause an upsert conflict / lose md_id).
      const m = normMobile(match.mobile) || normMobile(match.phone)
      const em = normEmail(match.email)
      const nm = normName(match.name)
      if (m) byMobile.delete(m)
      if (em) byEmail.delete(em)
      if (nm) byName.delete(nm)
      alreadyLinkedMdIds.add(mdId)
    } else {
      inserts.push({
        name,
        first_name: firstName,
        last_name: lastName,
        mobile,
        phone,
        email,
        address,
        company: isCompany ? name : null,
        customer_type: isCompany ? 'company' : 'individual',
        customer_number: customerNumber,
        md_id: mdId,
      })
    }
  }
  console.log(`Matched: ${mMobile} by mobile, ${mEmail} by email, ${mName} by name (already linked: ${mAlready}). New: ${inserts.length}`)

  // ── 4. Apply updates (upsert on id) + inserts ─────────────────────────────
  let updatedOk = 0
  for (let i = 0; i < updates.length; i += 500) {
    const batch = updates.slice(i, i + 500)
    const { error } = await db.from('workshop_customers').upsert(batch, { onConflict: 'id' })
    if (error) throw new Error(`update batch ${i}: ${error.message}`)
    updatedOk += batch.length
    if ((i / 500) % 10 === 0) console.log(`  updates: ${updatedOk}/${updates.length}`)
  }
  console.log(`Updates applied: ${updatedOk}`)

  let insertedOk = 0
  for (let i = 0; i < inserts.length; i += 500) {
    const batch = inserts.slice(i, i + 500)
    const { error } = await db.from('workshop_customers').insert(batch)
    if (error) throw new Error(`insert batch ${i}: ${error.message}`)
    insertedOk += batch.length
    if ((i / 500) % 10 === 0) console.log(`  inserts: ${insertedOk}/${inserts.length}`)
  }
  console.log(`Inserts applied: ${insertedOk}`)

  console.log(`\nDone. ${updatedOk} merged into existing, ${insertedOk} new, ${mAlready} already linked.`)
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1) })
