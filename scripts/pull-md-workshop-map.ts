// scripts/pull-md-workshop-map.ts
//
// Daily GitHub Actions worker for the Workshop Map & Conversion report
// (Reports → Map & conversion). MD has no open API, so this:
//
//   1. Logs into MechanicDesk (Playwright — shared login helper)
//   2. Pages the old-app JSON endpoints for the COMPLETE datasets
//      (/invoices.json, /quotes.json, /customers.json — same pattern as the
//      stock sync; the "reports" xls exports turned out not to exist as
//      routes, but these JSON records are richer anyway: vehicle.series,
//      full job-type text, customer ids). Full refresh every run, not
//      incremental, so status changes / late edits / back-dates self-heal.
//   3. Classifies each record's vehicle series + geocodes postcode→lat/lng
//      (lib/workshop-map — the authoritative business logic; do NOT re-derive)
//   4. Validates (§7 of the handoff: zero job-type chassis mismatches)
//   5. POSTs fact rows (batched upserts) + one prebuilt dashboard payload per
//      FY to /api/workshop/map/ingest.
//
// Env: MECHANICDESK_WORKSHOP_ID / _USERNAME / _PASSWORD,
//      JA_PORTAL_BASE_URL, JA_PORTAL_API_KEY (stocktake:write),
//      FROM (default 2025-07-01), RUN_ID / REQUESTED_BY (from dispatch).

import { readFileSync } from 'fs'
import { join } from 'path'
import { loginToMechanicDesk, MdClient } from '../lib/mechanicdesk-stocktake'
import {
  classifyVehicle, buildIdSeriesMaps, isNoiseInvoice, isWon, geocode,
  LatLng, VehicleGroup,
} from '../lib/workshop-map/vehicle-classification'
import { buildFyPayload, chassisMismatches, MapInvoiceRow, MapQuoteRow } from '../lib/workshop-map/build-payload'

function log(...args: any[]) { console.log(`[${new Date().toISOString()}]`, ...args) }

const MD_BASE = 'https://www.mechanicdesk.com.au'
const PORTAL_BASE = process.env.JA_PORTAL_BASE_URL || ''
const PORTAL_TOKEN = process.env.JA_PORTAL_API_KEY || ''
if (!PORTAL_BASE) throw new Error('JA_PORTAL_BASE_URL required')
if (!PORTAL_TOKEN) throw new Error('JA_PORTAL_API_KEY required')

const REQUESTED_BY = (process.env.REQUESTED_BY || 'scheduled').trim()
const PRECREATED_RUN_ID = (process.env.RUN_ID || '').trim()
// Keep everything from FY2026 onward (full refresh, not incremental).
const FROM = (process.env.FROM || '2025-07-01').trim()
// MD's server is slow (~10-15s per 200-row invoice page) and 504s on fat
// pages — quote records embed huge vehicle objects, so they page smaller.
const CONCURRENCY = Math.max(1, Number(process.env.MD_MAP_CONCURRENCY) || 3)
const QUOTES_PER_PAGE = Math.max(25, Number(process.env.MD_MAP_QUOTES_PER_PAGE) || 50)

// ── Portal ingest ───────────────────────────────────────────────────────

async function ingest(body: Record<string, any>): Promise<any> {
  const r = await fetch(`${PORTAL_BASE}/api/workshop/map/ingest`, {
    method: 'POST',
    headers: { 'X-Service-Token': PORTAL_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(`ingest ${body.action} → ${r.status}: ${(await r.text().catch(() => '')).slice(0, 300)}`)
  return r.json()
}

// ── MD session (with re-login on single-session kicks) ─────────────────
//
// MD enforces one session per employee login, and other workers (the 30-min
// stock sync, prepick, …) share this account — a mid-pull login elsewhere
// 401s every subsequent request ("logged in from a different computer").
// Rather than dying 40 minutes in, re-login and resume, with a global cap.

let mdSession: MdClient | null = null
let reloginCount = 0
let reloginInFlight: Promise<void> | null = null
const MAX_RELOGINS = 8

async function mdLogin(): Promise<void> {
  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ headless: true })
  try {
    const { client } = await loginToMechanicDesk(
      browser,
      process.env.MECHANICDESK_WORKSHOP_ID!,
      process.env.MECHANICDESK_USERNAME!,
      process.env.MECHANICDESK_PASSWORD!,
    )
    mdSession = client
  } finally {
    await browser.close().catch(() => undefined)
  }
}

// Single-flight: concurrent page fetches that all 401 share one re-login.
function relogin(): Promise<void> {
  if (!reloginInFlight) {
    reloginInFlight = (async () => {
      if (++reloginCount > MAX_RELOGINS) {
        throw new Error(`MD session kicked ${MAX_RELOGINS}+ times this run (another worker shares this login) — giving up`)
      }
      log(`MD session kicked by another login — re-logging in (${reloginCount}/${MAX_RELOGINS})`)
      await new Promise(r => setTimeout(r, 5000))
      await mdLogin()
    })().finally(() => { reloginInFlight = null })
  }
  return reloginInFlight
}

// ── MD JSON paging ──────────────────────────────────────────────────────

async function mdJson(path: string): Promise<any> {
  if (!mdSession) throw new Error('not logged in')
  const r = await fetch(`${MD_BASE}${path}`, {
    headers: {
      'Cookie': mdSession.cookieHeader,
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': `${MD_BASE}/auto_workshop/app`,
    },
    redirect: 'follow',
  })
  if (!r.ok) throw new Error(`MD GET ${path} → ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`)
  const text = await r.text()
  try { return JSON.parse(text) } catch { throw new Error(`MD GET ${path} → non-JSON (${text.slice(0, 120)})`) }
}

// Retries: 401 session-kick → re-login and go again (global MAX_RELOGINS cap);
// transient gateway errors (MD 502/503/504 under load) → backoff, per-request cap.
async function mdJsonRetry(path: string, tries = 3): Promise<any> {
  let transientAttempts = 0
  for (;;) {
    try {
      return await mdJson(path)
    } catch (e: any) {
      const msg = String(e?.message || e)
      if (/→ 401:/.test(msg)) { await relogin(); continue }
      const transient = /→ 50[234]:/.test(msg)
      if (!transient || ++transientAttempts >= tries) throw e
      log(`retrying (${transientAttempts}/${tries - 1}) after: ${msg.slice(0, 100)}`)
      await new Promise(r => setTimeout(r, 8000 * transientAttempts))
    }
  }
}

/**
 * Page a /<resource>.json endpoint to completion, `concurrency` pages at a
 * time. If page 1 persistently 504s the page size halves (fat resources).
 * `stopWhenOlderThan` enables an early stop for newest-first feeds (quotes):
 * once a whole batch sits more than 30 days below the cutoff, later pages
 * can't matter — backdated edits stay inside that safety margin.
 */
async function fetchAll(resource: string, opts: { perPage?: number; stopWhenOlderThan?: string } = {}): Promise<any[]> {
  let perPage = opts.perPage ?? 200
  const cutoff = opts.stopWhenOlderThan ? new Date(opts.stopWhenOlderThan).getTime() - 30 * 86400_000 : null
  const pageUrl = (p: number) => `/${resource}.json?page=${p}&per_page=${perPage}`

  // Page 1 — with adaptive page-size shrink on persistent gateway timeouts.
  let first: any
  for (;;) {
    try { first = await mdJsonRetry(pageUrl(1), 2); break }
    catch (e: any) {
      if (/→ 50[24]:/.test(String(e?.message || e)) && perPage > 25) {
        perPage = Math.max(25, Math.floor(perPage / 2))
        log(`${resource}: page too heavy, shrinking to per_page=${perPage}`)
      } else throw e
    }
  }
  const out: any[] = [...(Array.isArray(first[resource]) ? first[resource] : [])]
  const totalPages = Number(first?.meta?.total_pages) || 1
  log(`${resource}: page 1/${totalPages} (+${out.length}, per_page=${perPage})`)

  const newestOf = (arr: any[]) => arr.length ? Math.max(...arr.map(r => new Date(r.issue_date || r.created_at || 0).getTime() || 0)) : 0
  if (cutoff != null && newestOf(out) < cutoff && out.length) return out

  for (let start = 2; start <= totalPages; start += CONCURRENCY) {
    const pages = Array.from({ length: Math.min(CONCURRENCY, totalPages - start + 1) }, (_, i) => start + i)
    const results = await Promise.all(pages.map(p => mdJsonRetry(pageUrl(p))))
    let batchNewest = 0
    for (const j of results) {
      const arr: any[] = Array.isArray(j[resource]) ? j[resource] : []
      out.push(...arr)
      batchNewest = Math.max(batchNewest, newestOf(arr))
    }
    const last = pages[pages.length - 1]
    if (last % 10 < CONCURRENCY || last === totalPages) {
      log(`${resource}: page ${last}/${totalPages} (total ${out.length})`)
    }
    if (cutoff != null && batchNewest < cutoff) {
      log(`${resource}: early stop after page ${last} (batch is >30d below ${opts.stopWhenOlderThan})`)
      break
    }
  }
  return out
}

// ── Field helpers ───────────────────────────────────────────────────────

const S = (v: any): string | null => {
  if (v == null) return null
  const s = String(v).trim()
  return s ? s : null
}
// MD emits +10:00 local ISO strings — the date part IS the Brisbane date.
const isoYmd = (v: any): string | null => {
  const s = String(v || '')
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null
}
const STATES: Record<string, string> = {
  'QLD': 'QLD', 'QUEENSLAND': 'QLD', 'NSW': 'NSW', 'NEW SOUTH WALES': 'NSW',
  'VIC': 'VIC', 'VICTORIA': 'VIC', 'SA': 'SA', 'SOUTH AUSTRALIA': 'SA',
  'WA': 'WA', 'WESTERN AUSTRALIA': 'WA', 'TAS': 'TAS', 'TASMANIA': 'TAS',
  'NT': 'NT', 'NORTHERN TERRITORY': 'NT', 'ACT': 'ACT', 'AUSTRALIAN CAPITAL TERRITORY': 'ACT',
}
/** "Tallai Queensland 4213" / "Croydon VIC 3136" → { suburb, state, postcode } */
function parseSuburbBlob(blob: string | null): { suburb: string | null; state: string | null; postcode: string | null } {
  if (!blob) return { suburb: null, state: null, postcode: null }
  let s = blob.trim()
  let postcode: string | null = null
  const pm = s.match(/(\d{4})\s*$/)
  if (pm) { postcode = pm[1]; s = s.slice(0, pm.index).trim() }
  let state: string | null = null
  for (const [k, v] of Object.entries(STATES)) {
    const re = new RegExp(`\\b${k}\\.?$`, 'i')
    if (re.test(s)) { state = v; s = s.replace(re, '').trim(); break }
  }
  return { suburb: s || null, state, postcode }
}

interface Addr { suburb: string | null; state: string | null; postcode: string | null }

// ── Month/FY from a Brisbane-local YYYY-MM-DD ───────────────────────────
function calParts(ymd: string | null): { month: string | null; monthIndex: number | null; fy: number | null } {
  if (!ymd) return { month: null, monthIndex: null, fy: null }
  const y = Number(ymd.slice(0, 4)), m = Number(ymd.slice(5, 7))
  return { month: ymd.slice(0, 7), monthIndex: (m + 12 - 7) % 12, fy: m >= 7 ? y + 1 : y }
}

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  const wsId = process.env.MECHANICDESK_WORKSHOP_ID
  const username = process.env.MECHANICDESK_USERNAME
  const password = process.env.MECHANICDESK_PASSWORD
  if (!wsId || !username || !password) throw new Error('MECHANICDESK_WORKSHOP_ID/USERNAME/PASSWORD required')

  const started = await ingest({ action: 'start', requested_by: REQUESTED_BY, run_id: PRECREATED_RUN_ID || undefined })
  const runId = started.run_id as string
  log(`run ${runId} started (from ${FROM})`)

  try {
    log('Logging into MD (headless Chromium)')
    await mdLogin()
    log('Logged in — paging MD JSON endpoints')
    let rawInvoices = await fetchAll('invoices')
    let rawQuotes = await fetchAll('quotes', { perPage: QUOTES_PER_PAGE, stopWhenOlderThan: FROM })
    let rawCustomers = await fetchAll('customers')
    // A live feed shifts across pages while we pull (new quotes push rows
    // down) so concurrent paging can capture a record twice — dedupe by id.
    const uniqueById = (rows: any[]) => {
      const seen = new Set<string>()
      return rows.filter(r => {
        const id = String(r?.id ?? '')
        if (!id || seen.has(id)) return false
        seen.add(id); return true
      })
    }
    rawInvoices = uniqueById(rawInvoices)
    rawQuotes = uniqueById(rawQuotes)
    rawCustomers = uniqueById(rawCustomers)
    log(`Fetched ${rawInvoices.length} invoices, ${rawQuotes.length} quotes, ${rawCustomers.length} customers (deduped)`)

    // Customer id → address (quotes carry no address inline). MD customers
    // expose `address` (full formatted string, possibly an object) plus
    // `street_address` (street line) — strip the street prefix and parse the
    // "Suburb State 4213" remainder.
    const customerAddr = (c: any): Addr => {
      const a = c?.address
      if (a && typeof a === 'object') {
        const suburb = S(a.suburb) ?? S(a.city)
        // MD's state field is free text ("Queensland", "Cairns"…) — normalise
        // to the short code so QLD isn't split across three labels downstream.
        const rawState = S(a.state)
        const state = rawState ? (STATES[rawState.toUpperCase().replace(/\.$/, '')] ?? rawState) : null
        const postcode = S(a.postcode) ?? S(a.post_code)
        if (suburb || postcode) return { suburb, state, postcode }
      }
      let s = typeof a === 'string' ? a.trim() : ''
      const street = S(c?.street_address)
      if (s && street && s.toUpperCase().startsWith(street.toUpperCase())) {
        s = s.slice(street.length).replace(/^[\s,]+/, '')
      }
      // Even unstripped, parseSuburbBlob still extracts postcode + state —
      // and postcode is what the geocoder tries first.
      return s ? parseSuburbBlob(s) : { suburb: null, state: null, postcode: null }
    }
    const custAddr: Record<string, Addr> = {}
    let custAddrHits = 0
    for (const c of rawCustomers) {
      if (!c?.id) continue
      const addr = customerAddr(c)
      if (addr.suburb || addr.postcode) { custAddr[String(c.id)] = addr; custAddrHits++ }
    }
    log(`Customer address map: ${custAddrHits}/${rawCustomers.length} customers have suburb/postcode`)
    if (rawCustomers.length && !custAddrHits) {
      log(`WARNING: no usable addresses on customers.json — sample: ${JSON.stringify(rawCustomers[0]?.address ?? null).slice(0, 200)}`)
    }

    // ── Normalise ───────────────────────────────────────────────────────
    interface RawInv {
      id: string; displayNumber: string; customerId: string | null; customerName: string | null
      suburb: string | null; state: string | null; postcode: string | null
      vehicleId: string | null; rego: string | null; jobTypeText: string | null
      model: string | null; descText: string | null; itemsText: string | null
      issueYmd: string | null; totalAmount: number
    }
    const invoicesRaw: RawInv[] = []
    for (const r of rawInvoices) {
      if (!r || r.deleted) continue
      const veh = r.job?.vehicle || r.vehicle || null
      const cust = r.customer || null
      const custId = cust?.id != null ? String(cust.id) : null
      const addr = (custId && custAddr[custId]) || parseSuburbBlob(S(r.customer_suburb))
      // "First Job Type" = the FIRST name in the job-type list — this is what
      // the noise rules + classification step 1 key on. Feeding the FULL list
      // here false-flagged ~85% of invoices as deposits/diagnostics (big jobs
      // routinely carry a Deposit/Pre-Payment job type alongside the work).
      // The full list still reaches the classifier via itemsText (step 5/7).
      const jobTypesTitle = S(r.job?.booking?.job_types_title) || S(r.job?.job_types_title)
      const firstJobType = jobTypesTitle ? S(jobTypesTitle.split(',')[0]) : null
      invoicesRaw.push({
        id: String(r.id),
        displayNumber: S(r.number) || String(r.id),
        customerId: custId,
        customerName: S(r.customer_name) || S(cust?.name),
        suburb: addr.suburb, state: addr.state, postcode: addr.postcode,
        vehicleId: veh?.id != null ? String(veh.id) : null,
        rego: S(veh?.registration_number),
        jobTypeText: firstJobType,
        model: [S(veh?.make), S(veh?.model), S(veh?.series)].filter(Boolean).join(' ') || null,
        descText: S(r.description),
        // full_description = job description + EVERY job-type name — keeps all
        // chassis codes + the clutch/1300NM tell visible to the classifier.
        itemsText: [S(r.job?.title), S(r.job?.full_description), S(r.job?.booking?.description)].filter(Boolean).join(' ').slice(0, 8000) || null,
        issueYmd: isoYmd(r.issue_date),
        totalAmount: Number(r.total_amount) || 0,
      })
    }

    interface RawQuote {
      id: string; displayNumber: string; customerId: string | null; customerName: string | null
      suburb: string | null; state: string | null; postcode: string | null
      vehicleId: string | null; rego: string | null; jobTypeText: string | null
      model: string | null; descText: string | null; itemsText: string | null
      issueYmd: string | null; totalAmount: number; status: string | null
    }
    const quotesRaw: RawQuote[] = []
    for (const r of rawQuotes) {
      if (!r || r.deleted) continue
      const veh = r.vehicle || null
      const cust = r.customer || null
      const custId = cust?.id != null ? String(cust.id) : null
      const addr = (custId && custAddr[custId]) || { suburb: null, state: null, postcode: null }
      quotesRaw.push({
        id: String(r.id),
        displayNumber: S(r.number) || String(r.id),
        customerId: custId,
        customerName: S(cust?.name),
        suburb: addr.suburb, state: addr.state, postcode: addr.postcode,
        vehicleId: veh?.id != null ? String(veh.id) : null,
        rego: S(veh?.registration_number),
        jobTypeText: S(r.job_types_title),
        model: [S(veh?.make), S(veh?.model), S(veh?.series)].filter(Boolean).join(' ') || null,
        descText: S(r.description),
        itemsText: S(r.details)?.slice(0, 8000) || null,
        issueYmd: isoYmd(r.issue_date),
        totalAmount: Number(r.total_amount) || 0,
        status: S(r.status),
      })
    }

    // ── Classify + geocode ──────────────────────────────────────────────
    const pcData = JSON.parse(readFileSync(join(__dirname, '..', 'lib', 'workshop-map', 'au-postcodes.json'), 'utf8'))
    const postcodeMap: Record<string, LatLng> = {}, suburbMap: Record<string, LatLng> = {}
    for (const [k, v] of Object.entries<any>(pcData.pc)) postcodeMap[k] = { lat: v[0], lng: v[1], locality: v[2] }
    for (const [k, v] of Object.entries<any>(pcData.sub)) suburbMap[k] = { lat: v[0], lng: v[1], locality: v[2] }

    // vehicleId/rego → series maps come from the INVOICE set (full history —
    // better backfill than the FY-only prototype) and backfill quotes too.
    const { vehicleIdMap, regoMap } = buildIdSeriesMaps(invoicesRaw)
    log(`Series maps: ${Object.keys(vehicleIdMap).length} vehicle ids, ${Object.keys(regoMap).length} regos`)

    const toInvoiceRow = (r: RawInv): MapInvoiceRow => {
      const cls = classifyVehicle(r, vehicleIdMap, regoMap)
      const geo = geocode(r.postcode, r.suburb, postcodeMap, suburbMap)
      const cal = calParts(r.issueYmd)
      return {
        invoiceNumber: r.id,
        customerId: r.customerId, customerName: r.customerName,
        suburb: r.suburb, state: r.state, postcode: r.postcode,
        vehicleId: r.vehicleId, rego: r.rego,
        jobTypeText: r.jobTypeText, descText: r.descText, itemsText: r.itemsText,
        issueDate: r.issueYmd, totalAmount: r.totalAmount,
        group: cls.group, inferred: cls.inferred,
        isNoise: isNoiseInvoice(r),
        lat: geo?.lat ?? null, lng: geo?.lng ?? null, locality: geo?.locality ?? null,
        ...cal,
        displayNumber: r.displayNumber,
      } as MapInvoiceRow & { displayNumber: string }
    }
    const toQuoteRow = (r: RawQuote): MapQuoteRow => {
      const cls = classifyVehicle(r, vehicleIdMap, regoMap)
      const geo = geocode(r.postcode, r.suburb, postcodeMap, suburbMap)
      const cal = calParts(r.issueYmd)
      return {
        quoteNumber: r.id,
        customerId: r.customerId, customerName: r.customerName,
        suburb: r.suburb, state: r.state, postcode: r.postcode,
        rego: r.rego, model: r.model, descText: r.descText, itemsText: r.itemsText,
        quoteDate: r.issueYmd, totalAmount: r.totalAmount,
        status: r.status, won: isWon(r.status),
        group: cls.group, inferred: cls.inferred,
        lat: geo?.lat ?? null, lng: geo?.lng ?? null, locality: geo?.locality ?? null,
        ...cal,
        displayNumber: r.displayNumber,
      } as MapQuoteRow & { displayNumber: string }
    }

    // Only persist rows from FROM onward (we page full history for the series
    // maps, but the dashboard + fact tables only cover FY2026+).
    const invoices = invoicesRaw.filter(r => r.issueYmd && r.issueYmd >= FROM).map(toInvoiceRow)
    const quotes = quotesRaw.filter(r => r.issueYmd && r.issueYmd >= FROM).map(toQuoteRow)

    // ── §7 validation: zero job-type chassis mismatches ────────────────
    const bad = chassisMismatches(invoices.map(r => ({ jobTypeText: r.jobTypeText, group: r.group, ref: r.invoiceNumber })))
      .concat(chassisMismatches(quotes.map(r => ({ jobTypeText: r.jobTypeText, group: r.group, ref: `Q${r.quoteNumber}` }))))
    if (bad.length) {
      throw new Error(`VALIDATION FAILED: ${bad.length} chassis mismatch(es), e.g. ` +
        bad.slice(0, 5).map(b => `#${b.ref} job-type says ${b.jobChassis} but classified ${b.group}`).join('; '))
    }
    const invGeo = invoices.filter(r => r.lat != null).length
    const qGeo = quotes.filter(r => r.lat != null).length
    const groupShare = (rows: { group: VehicleGroup }[]) => {
      const m: Record<string, number> = {}
      rows.forEach(r => { m[r.group] = (m[r.group] || 0) + 1 })
      return Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}:${n}`).join(' ')
    }
    log(`Kept ${invoices.length} invoices / ${quotes.length} quotes since ${FROM}. Chassis mismatches: 0`)
    log(`Geocoded ${invGeo}/${invoices.length} (${(100 * invGeo / Math.max(1, invoices.length)).toFixed(1)}%) invoices, ` +
      `${qGeo}/${quotes.length} (${(100 * qGeo / Math.max(1, quotes.length)).toFixed(1)}%) quotes`)
    log(`Invoice groups: ${groupShare(invoices)}`)
    log(`Quote groups:   ${groupShare(quotes)}`)

    // ── Upload fact rows ────────────────────────────────────────────────
    const invDbRows = invoices.map((r: any) => ({
      invoice_number: r.invoiceNumber, display_number: r.displayNumber,
      customer_id: r.customerId, customer_name: r.customerName,
      suburb: r.suburb, state: r.state, postcode: r.postcode, vehicle_id: r.vehicleId, rego: r.rego,
      first_job_type: r.jobTypeText, description: r.descText, items_text: r.itemsText,
      issue_date: r.issueDate, total_amount: r.totalAmount,
      vehicle_group: r.group, inferred: r.inferred, is_noise: r.isNoise,
      lat: r.lat, lng: r.lng, locality: r.locality, month: r.month, fy: r.fy,
    }))
    const qDbRows = quotes.map((r: any) => ({
      quote_number: r.quoteNumber, display_number: r.displayNumber,
      customer_id: r.customerId, customer_name: r.customerName,
      suburb: r.suburb, state: r.state, postcode: r.postcode, rego: r.rego,
      vehicle_model: r.model, description: r.descText, items_text: r.itemsText,
      quote_date: r.quoteDate, total_amount: r.totalAmount, status: r.status, won: r.won,
      vehicle_group: r.group, inferred: r.inferred,
      lat: r.lat, lng: r.lng, locality: r.locality, month: r.month, fy: r.fy,
    }))
    const BATCH = 800
    for (let i = 0; i < invDbRows.length; i += BATCH) {
      await ingest({ action: 'invoices', run_id: runId, rows: invDbRows.slice(i, i + BATCH) })
      log(`invoices ${Math.min(i + BATCH, invDbRows.length)}/${invDbRows.length}`)
    }
    for (let i = 0; i < qDbRows.length; i += BATCH) {
      await ingest({ action: 'quotes', run_id: runId, rows: qDbRows.slice(i, i + BATCH) })
      log(`quotes ${Math.min(i + BATCH, qDbRows.length)}/${qDbRows.length}`)
    }

    // ── Build + upload per-FY payloads (point `i` = human invoice/quote #) ─
    const fys = [...new Set([...invoices, ...quotes].map(r => r.fy).filter((f): f is number => f != null && f >= 2026))].sort()
    const withDisplay = (rows: any[], key: string) => rows.map(r => ({ ...r, [key]: r.displayNumber || r[key] }))
    const fySummaries: Record<string, any> = {}
    for (const fy of fys) {
      const payload = buildFyPayload(fy, withDisplay(invoices, 'invoiceNumber'), withDisplay(quotes, 'quoteNumber'))
      await ingest({ action: 'payload', run_id: runId, fy, payload })
      fySummaries[fy] = {
        clean_jobs: payload.jobs.meta.customers,
        jobs_mapped: payload.jobs.meta.mapped,
        quotes: payload.quotes.meta.total_quotes,
        quotes_mapped: payload.quotes.meta.mapped,
        quoted_value: payload.quotes.meta.total_value,
      }
      log(`FY${fy}: ${JSON.stringify(fySummaries[fy])}`)
    }

    await ingest({
      action: 'finish', run_id: runId,
      invoice_count: invoices.length, quote_count: quotes.length,
      meta: {
        from: FROM,
        geocode: { invoices: invGeo, quotes: qGeo },
        chassis_mismatches: 0,
        customers_with_address: custAddrHits,
        fys: fySummaries,
      },
    })
    log('Done')
  } catch (e: any) {
    const msg = e?.message || String(e)
    log('FAILED:', msg)
    if (e?.stack) log(e.stack)
    try { await ingest({ action: 'error', run_id: runId, error: msg.slice(0, 1000) }) } catch { /* */ }
    process.exit(1)
  }
}

main().catch(e => { log('FATAL:', e?.message || e); process.exit(1) })
