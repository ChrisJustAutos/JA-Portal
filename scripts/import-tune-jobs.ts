// scripts/import-tune-jobs.ts
//
// Tune jobs → MechanicDesk customers (GH Actions, nightly — tune-jobs-md.yml).
// Pulls submitted tune jobs from the portal (distributor filled in the
// customer details), dedups against the workshop_customers mirror + live MD
// name search (same two-layer approach as import-monday-leads.ts — MD search
// CANNOT match phone numbers), creates the MD customer, and reports outcomes
// back so the portal marks the job 'synced'.
//
// After the customer, the worker attempts (non-fatal — failures land as a
// note on the job while the customer still counts):
//   1. the vehicle: POST /vehicles (proven live 2026-07-24), and
//   2. a customer-file note: several Rails shapes attempted, and success is
//      VERIFIED by re-fetching the customer and checking the note text is
//      present — MD silently ignores unknown payloads while returning 200,
//      so response shape is never trusted (first live run's lesson).
// Dedup guards: deleted customers never match; name search needs 2+ words.
//
// Env: MECHANICDESK_WORKSHOP_ID, MECHANICDESK_USERNAME, MECHANICDESK_PASSWORD,
//      JA_PORTAL_BASE_URL, JA_PORTAL_API_KEY, DRY_RUN=1 for a no-write pass.

import {
  loginToMechanicDesk, searchMdCustomers, createMdCustomer, mdRequest,
  type MdClient,
} from '../lib/mechanicdesk-stocktake'

const WS_ID = process.env.MECHANICDESK_WORKSHOP_ID || ''
const MD_USER = process.env.MECHANICDESK_USERNAME || ''
const MD_PASS = process.env.MECHANICDESK_PASSWORD || ''
const PORTAL_BASE = (process.env.JA_PORTAL_BASE_URL || 'https://justautos.app').replace(/\/$/, '')
const PORTAL_TOKEN = process.env.JA_PORTAL_API_KEY || ''
const DRY_RUN = process.env.DRY_RUN === '1'

const digits = (s: any) => String(s || '').replace(/\D/g, '')
const normName = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()

interface TuneJob {
  id: string
  vin: string | null
  tune_details: string | null
  invoice_number: string | null
  amount: number | null
  customer_name: string
  customer_first_name: string | null
  customer_phone: string | null
  customer_email: string | null
  customer_postcode: string | null
  vehicle_rego: string | null
  vehicle_description: string | null
  job_notes: string | null
  distributor_name: string | null
}

async function getMdCustomer(client: MdClient, id: string | number): Promise<any | null> {
  try { return await mdRequest<any>(client, `/customers/${id}.json`) } catch { /* fall through */ }
  try { return await mdRequest<any>(client, `/customers/${id}`) } catch { return null }
}

// MD soft-deletes customers in more ways than one flag — treat ANY deletion
// signal as deleted (first live run matched a search hit whose page said
// DELETED even though the search row didn't say so).
function looksDeleted(c: any): boolean {
  if (!c) return false
  return c.deleted === true || c.is_deleted === true || !!c.deleted_at ||
    String(c.status || '').toLowerCase() === 'deleted'
}

// Vehicle create — proven live 2026-07-24 (POST /vehicles, run 30053923797).
async function tryCreateVehicle(client: MdClient, customerId: string | number, job: TuneJob): Promise<string | null> {
  if (!job.vin && !job.vehicle_rego) return null
  try {
    const r = await mdRequest<any>(client, '/vehicles', {
      method: 'POST',
      body: JSON.stringify({
        customer_id: customerId,
        ...(job.vehicle_rego ? { registration_number: job.vehicle_rego } : {}),
        ...(job.vin ? { vin: job.vin } : {}),
        ...(job.vehicle_description ? { model: job.vehicle_description } : {}),
      }),
    })
    if (r?.id) { console.log(`  + vehicle #${r.id} (${job.vehicle_rego || job.vin})`); return null }
    return `vehicle create returned no id: ${JSON.stringify(r).slice(0, 200)}`
  } catch (e: any) {
    return `vehicle create failed: ${String(e?.message || e).slice(0, 200)}`
  }
}

function composeCustomerNote(job: TuneJob): string {
  const bits = [
    `Distributor tune — ${new Date().toISOString().slice(0, 10)}: ${job.tune_details || 'tune'}`,
    job.vin ? `VIN ${job.vin}` : '',
    job.vehicle_rego ? `Rego ${job.vehicle_rego}` : '',
    job.invoice_number ? `Stripe inv ${job.invoice_number}` : '',
    job.amount ? `$${Number(job.amount).toFixed(2)}` : '',
    job.distributor_name ? `by ${job.distributor_name}` : '',
  ].filter(Boolean).join(' · ')
  return job.job_notes ? `${bits}
${job.job_notes}` : bits
}

// Customer-file note. The first live run proved MD silently IGNORES payloads
// it doesn't recognise while echoing a 200 — so success here is NEVER inferred
// from the response: after every attempt the customer is re-fetched and the
// note text must actually be present. Attempts are ordered by Rails idiom
// (attributes nested under the model key first).
async function tryAddCustomerNote(client: MdClient, customerId: string | number, job: TuneJob): Promise<string | null> {
  const content = composeCustomerNote(job)
  const marker = content.slice(0, 40)
  const hasNote = (cust: any) => {
    const notes = Array.isArray(cust?.notes) ? cust.notes : []
    return notes.some((n: any) => String(n?.content || n?.body || n?.description || '').includes(marker))
  }
  const attempts: Array<{ label: string; path: string; body: any; method?: string }> = [
    { label: 'PUT /customers/{id} customer[notes_attributes]', path: `/customers/${customerId}`, method: 'PUT', body: { customer: { notes_attributes: [{ content }] } } },
    { label: 'POST /notes note{}', path: '/notes', body: { note: { content, notable_id: customerId, notable_type: 'Customer' } } },
    { label: 'POST /notes flat', path: '/notes', body: { content, notable_id: customerId, notable_type: 'Customer' } },
    { label: 'POST /customers/{id}/notes', path: `/customers/${customerId}/notes`, body: { note: { content } } },
  ]
  const errors: string[] = []
  for (const a of attempts) {
    let respNote = ''
    try {
      const r = await mdRequest<any>(client, a.path, { method: a.method || 'POST', body: JSON.stringify(a.body) })
      respNote = `resp ${JSON.stringify(r).slice(0, 150)}`
    } catch (e: any) {
      errors.push(`${a.label}: ${String(e?.message || e).slice(0, 150)}`)
      continue
    }
    // Authoritative check: is the note actually on the customer now?
    const after = await getMdCustomer(client, customerId)
    if (after && hasNote(after)) {
      console.log(`  + customer note via ${a.label}`)
      return null
    }
    errors.push(`${a.label}: accepted but note not present (${respNote})`)
  }
  return `customer note failed (${errors.join(' | ')})`.slice(0, 700)
}

async function fetchPending(): Promise<TuneJob[]> {
  const r = await fetch(`${PORTAL_BASE}/api/workshop/tune-jobs-md`, {
    headers: { 'X-Service-Token': PORTAL_TOKEN },
  })
  if (!r.ok) throw new Error(`portal pending fetch failed: ${r.status}`)
  const data = await r.json()
  return data.jobs || []
}

async function report(outcomes: any[]): Promise<void> {
  if (!outcomes.length) return
  const r = await fetch(`${PORTAL_BASE}/api/workshop/tune-jobs-md`, {
    method: 'POST',
    headers: { 'X-Service-Token': PORTAL_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ outcomes }),
  })
  if (!r.ok) throw new Error(`portal report failed: ${r.status} ${await r.text().catch(() => '')}`)
}

// Two-layer dedup mirroring import-monday-leads: portal mirror by phone
// tail / email (carries md_id), then live MD search by name.
async function findExisting(client: MdClient, job: TuneJob): Promise<{ id: number | string; via: string } | null> {
  const tail = digits(job.customer_phone).slice(-8)
  const params = new URLSearchParams({ check: '1' })
  if (tail.length === 8) params.set('phone_tail', tail)
  if (job.customer_email) params.set('email', job.customer_email)
  if (params.has('phone_tail') || params.has('email')) {
    const r = await fetch(`${PORTAL_BASE}/api/workshop/monday-md-import?${params.toString()}`, {
      headers: { 'X-Service-Token': PORTAL_TOKEN },
    })
    if (r.ok) {
      const { candidates } = await r.json()
      const hit = (candidates || []).find((cand: any) =>
        cand.md_id && (
          (tail.length === 8 && (digits(cand.mobile).endsWith(tail) || digits(cand.phone).endsWith(tail))) ||
          (job.customer_email && (cand.email || '').toLowerCase() === job.customer_email.toLowerCase())
        ))
      if (hit) {
        const live = await getMdCustomer(client, hit.md_id)
        if (live && !looksDeleted(live)) return { id: hit.md_id, via: 'portal mirror' }
      }
    }
  }
  // Name-search fallback ONLY for multi-word names: the first live run
  // (2026-07-24) matched a test job's single name "Callum" onto an unrelated
  // real MD customer — a first name alone is not identity.
  const words = job.customer_name.trim().split(/\s+/)
  if (job.customer_name.trim().length >= 5 && words.length >= 2) {
    const hits = await searchMdCustomers(client, job.customer_name.trim())
    const hit = hits.find(h => normName(h.name) === normName(job.customer_name))
    if (hit) {
      const live = await getMdCustomer(client, hit.id)
      if (live && !looksDeleted(live)) return { id: hit.id, via: 'MD name search' }
    }
  }
  return null
}

function splitName(full: string): { first: string; last: string } {
  const parts = full.trim().split(/\s+/)
  if (parts.length === 1) return { first: parts[0], last: '' }
  return { first: parts[0], last: parts.slice(1).join(' ') }
}

async function main() {
  const jobs = await fetchPending()
  console.log(`${jobs.length} submitted tune job(s) pending MD creation`)
  if (!jobs.length) return

  const { chromium } = await import('playwright')
  const browser = await chromium.launch()
  const outcomes: any[] = []
  try {
    const login = await loginToMechanicDesk(browser, WS_ID, MD_USER, MD_PASS)
    const client = login.client
    console.log('MD login ok')

    for (const job of jobs) {
      try {
        const existing = await findExisting(client, job)
        if (existing) {
          console.log(`= ${job.customer_name}: already in MD (#${existing.id} via ${existing.via})`)
          const notes: string[] = []
          if (!DRY_RUN) {
            const v = await tryCreateVehicle(client, existing.id, job); if (v) notes.push(v)
            const n = await tryAddCustomerNote(client, existing.id, job); if (n) notes.push(n)
          }
          outcomes.push({ job_id: job.id, md_customer_id: String(existing.id), ...(notes.length ? { note: notes.join(' | ').slice(0, 800) } : {}) })
          continue
        }
        if (DRY_RUN) {
          console.log(`~ DRY RUN: would create ${job.customer_name} (${job.customer_phone || 'no phone'})`)
          continue
        }
        const { first, last } = splitName(job.customer_name)
        const created = await createMdCustomer(client, {
          firstName: first, lastName: last,
          mobile: job.customer_phone || undefined,
          email: job.customer_email || undefined,
          postcode: job.customer_postcode || undefined,
        })
        console.log(`+ created MD customer #${created.id} for ${job.customer_name} (tune: ${job.tune_details || '—'}, VIN ${job.vin || '—'}, distributor ${job.distributor_name || '—'})`)
        const notes: string[] = []
        const v = await tryCreateVehicle(client, created.id, job); if (v) notes.push(v)
        const n = await tryAddCustomerNote(client, created.id, job); if (n) notes.push(n)
        outcomes.push({ job_id: job.id, md_customer_id: String(created.id), ...(notes.length ? { note: notes.join(' | ').slice(0, 800) } : {}) })
      } catch (e: any) {
        console.error(`! ${job.customer_name}: ${e?.message || e}`)
        outcomes.push({ job_id: job.id, error: String(e?.message || e).slice(0, 400) })
      }
    }
  } finally {
    await browser.close()
  }

  if (!DRY_RUN) await report(outcomes)
  const failed = outcomes.filter(o => o.error).length
  console.log(`done: ${outcomes.length - failed} ok, ${failed} failed`)
  if (failed) process.exitCode = 1
}

main().catch(e => { console.error(e); process.exit(1) })
