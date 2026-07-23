// scripts/import-tune-jobs.ts
//
// Tune jobs → MechanicDesk customers (GH Actions, nightly — tune-jobs-md.yml).
// Pulls submitted tune jobs from the portal (distributor filled in the
// customer details), dedups against the workshop_customers mirror + live MD
// name search (same two-layer approach as import-monday-leads.ts — MD search
// CANNOT match phone numbers), creates the MD customer, and reports outcomes
// back so the portal marks the job 'synced'.
//
// After the customer, the worker ATTEMPTS the vehicle (VIN/rego/description)
// via POST /vehicles — the endpoint is unproven, so a failure is recorded as
// a non-fatal note on the job (customer still counts as synced) and the
// response is logged for diagnosis. Job notes stay on the portal record.
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
  customer_name: string
  customer_first_name: string | null
  customer_phone: string | null
  customer_email: string | null
  customer_postcode: string | null
  vehicle_rego: string | null
  vehicle_description: string | null
  distributor_name: string | null
}

// Unproven endpoint — attempted per job, non-fatal on failure. Field names
// mirror MD's read side (registration_number / vin / model).
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
      if (hit) return { id: hit.md_id, via: 'portal mirror' }
    }
  }
  if (job.customer_name.trim().length >= 5) {
    const hits = await searchMdCustomers(client, job.customer_name.trim())
    const hit = hits.find(h => normName(h.name) === normName(job.customer_name))
    if (hit) return { id: hit.id, via: 'MD name search' }
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
          const note = DRY_RUN ? null : await tryCreateVehicle(client, existing.id, job)
          outcomes.push({ job_id: job.id, md_customer_id: String(existing.id), ...(note ? { note } : {}) })
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
        const note = await tryCreateVehicle(client, created.id, job)
        outcomes.push({ job_id: job.id, md_customer_id: String(created.id), ...(note ? { note } : {}) })
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
