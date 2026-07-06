// scripts/pull-md-workshop-map.ts
//
// Daily GitHub Actions worker for the Workshop Map & Conversion report
// (Reports → Map & conversion). MD has no open API, so this:
//
//   1. Logs into MechanicDesk (Playwright — shared login helper)
//   2. Downloads the FULL Invoices report + FULL Quotes report as legacy .xls
//      (direct HTTP with the session cookies, same approach as the job-report
//      worker) — complete dataset every run, not incremental, so status
//      changes / late edits / back-dated records self-heal.
//   3. Parses every sheet (xlsx/SheetJS reads CDFV2 .xls), joins line items,
//      classifies each record's vehicle series + geocodes postcode→lat/lng
//      (lib/workshop-map — the authoritative business logic; do NOT re-derive)
//   4. Validates (§7: zero First-Job-Type chassis mismatches)
//   5. POSTs fact rows (batched upserts) + one prebuilt dashboard payload per
//      FY to /api/workshop/map/ingest.
//
// Env: MECHANICDESK_WORKSHOP_ID / _USERNAME / _PASSWORD,
//      JA_PORTAL_BASE_URL, JA_PORTAL_API_KEY (stocktake:write),
//      FROM (default 2025-07-01), RUN_ID / REQUESTED_BY (from dispatch),
//      MD_INVOICE_REPORT_PATH / MD_QUOTE_REPORT_PATH (optional overrides when
//      MD's export routes differ from the candidates below).

import { readFileSync } from 'fs'
import { join } from 'path'
import * as XLSX from 'xlsx'
import { loginToMechanicDesk, MdClient } from '../lib/mechanicdesk-stocktake'
import {
  classifyVehicle, buildIdSeriesMaps, isNoiseInvoice, isWon, geocode,
  monthKey, fyOf, fyMonthIndex, LatLng,
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
// Pull everything from FY2026 onward by default (full refresh, not incremental).
const FROM = (process.env.FROM || '2025-07-01').trim()

// MD's export endpoints follow the /reports/<name>/download pattern (the job
// report worker uses /reports/job/download). First candidate that returns a
// workbook with the expected sheets wins; override via env if MD renames them.
const INVOICE_PATHS = process.env.MD_INVOICE_REPORT_PATH
  ? [process.env.MD_INVOICE_REPORT_PATH]
  : ['/reports/invoice/download', '/reports/invoices/download', '/reports/invoice_summary/download', '/reports/invoice_listing/download']
const QUOTE_PATHS = process.env.MD_QUOTE_REPORT_PATH
  ? [process.env.MD_QUOTE_REPORT_PATH]
  : ['/reports/quote/download', '/reports/quotation/download', '/reports/quotes/download', '/reports/quote_listing/download']

// Scrape MD's report pages/bundles for /reports/<name> route names so the
// worker can self-discover the export endpoints (candidates above are guesses;
// MD's route names aren't documented anywhere).
async function discoverReportNames(client: MdClient): Promise<string[]> {
  const names = new Set<string>()
  const sources = ['/reports', '/auto_workshop/app', '/']
  for (const src of sources) {
    try {
      const r = await fetch(`${MD_BASE}${src}`, {
        headers: { 'Cookie': client.cookieHeader, 'Accept': 'text/html,*/*' },
        redirect: 'follow',
      })
      const text = await r.text()
      for (const m of text.matchAll(/\breports\/([a-z0-9_]+)/gi)) {
        const n = m[1].toLowerCase()
        if (n !== 'download') names.add(n)
      }
      // Angular bundles carry the route strings — scan any referenced JS too.
      if (src !== '/reports') {
        const jsRefs = [...text.matchAll(/src="([^"]+\.js[^"]*)"/g)].map(x => x[1]).slice(0, 8)
        for (const ref of jsRefs) {
          try {
            const jr = await fetch(ref.startsWith('http') ? ref : `${MD_BASE}${ref}`, { headers: { 'Cookie': client.cookieHeader } })
            const js = await jr.text()
            for (const m of js.matchAll(/\breports\/([a-z0-9_]+)/gi)) {
              const n = m[1].toLowerCase()
              if (n !== 'download') names.add(n)
            }
          } catch { /* skip bundle */ }
        }
      }
    } catch (e: any) {
      log(`discover: ${src} → ${e?.message || e}`)
    }
  }
  const list = [...names].sort()
  log(`discover: found ${list.length} report route name(s): ${list.join(', ') || '(none)'}`)
  return list
}

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

// ── MD report download ──────────────────────────────────────────────────

// MD's report endpoints take JS-toString-style dates (same as the job report).
function mdDateParam(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${days[dt.getUTCDay()]} ${months[dt.getUTCMonth()]} ${String(dt.getUTCDate()).padStart(2, '0')} ${dt.getUTCFullYear()} 00:00:00 GMT+1000 (Australian Eastern Standard Time)`
}

async function downloadWorkbook(
  client: MdClient, label: string, paths: string[], from: string, to: string, expectSheet: RegExp,
): Promise<XLSX.WorkBook> {
  const params = new URLSearchParams({ from: mdDateParam(from), to: mdDateParam(to) })
  let lastErr = ''
  for (const path of paths) {
    const url = `${MD_BASE}${path}?${params.toString()}`
    log(`${label}: trying ${path}`)
    try {
      const r = await fetch(url, {
        headers: {
          'Cookie': client.cookieHeader,
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/vnd.ms-excel, */*',
          'Referer': `${MD_BASE}/auto_workshop/app`,
        },
        redirect: 'follow',
      })
      const buf = Buffer.from(await r.arrayBuffer())
      log(`${label}: ${path} → ${r.status}, ${buf.length} bytes, ct=${r.headers.get('content-type')}`)
      if (!r.ok) { lastErr = `${path} → HTTP ${r.status}`; continue }
      const head = buf.slice(0, 200).toString('utf8').toLowerCase()
      if (head.includes('<!doctype html') || head.includes('<html')) { lastErr = `${path} → HTML (wrong route or session)`; continue }
      if (buf.length < 512) { lastErr = `${path} → too small (${buf.length}B): ${buf.toString('utf8').slice(0, 120)}`; continue }
      const wb = XLSX.read(buf, { cellDates: true })
      if (!wb.SheetNames.some(n => expectSheet.test(n))) {
        lastErr = `${path} → sheets [${wb.SheetNames.join(', ')}] missing ${expectSheet}`
        continue
      }
      log(`${label}: OK via ${path} — sheets: ${wb.SheetNames.join(', ')}`)
      return wb
    } catch (e: any) {
      lastErr = `${path} → ${e?.message || e}`
    }
  }
  throw new Error(`${label}: no candidate export URL worked. Last error: ${lastErr}. ` +
    `Set MD_${label.toUpperCase()}_REPORT_PATH to the correct /reports/<name>/download route.`)
}

// ── Cell coercion ───────────────────────────────────────────────────────

const S = (v: any): string | null => {
  if (v == null) return null
  const s = String(v).trim()
  return s && s.toLowerCase() !== 'nan' ? s : null
}
const N = (v: any): number => {
  if (v == null) return 0
  if (typeof v === 'number') return isFinite(v) ? v : 0
  const n = parseFloat(String(v).replace(/[$,\s]/g, ''))
  return isFinite(n) ? n : 0
}
// Dates arrive as Date (cellDates), 'DD/MM/YYYY' text, or an Excel serial.
function D(v: any): Date | null {
  if (v == null || v === '') return null
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v
  if (typeof v === 'number' && v > 20000 && v < 60000) return new Date(Math.round((v - 25569) * 86400_000))
  const m = String(v).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/)
  if (m) return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]))
  const d = new Date(String(v))
  return isNaN(d.getTime()) ? null : d
}
const ymd = (d: Date | null): string | null =>
  d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : null

function sheetRows(wb: XLSX.WorkBook, name: string): any[] {
  const ws = wb.Sheets[name]
  return ws ? XLSX.utils.sheet_to_json(ws, { defval: null }) : []
}

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  const wsId = process.env.MECHANICDESK_WORKSHOP_ID
  const username = process.env.MECHANICDESK_USERNAME
  const password = process.env.MECHANICDESK_PASSWORD
  if (!wsId || !username || !password) throw new Error('MECHANICDESK_WORKSHOP_ID/USERNAME/PASSWORD required')

  const started = await ingest({ action: 'start', requested_by: REQUESTED_BY, run_id: PRECREATED_RUN_ID || undefined })
  const runId = started.run_id as string
  log(`run ${runId} started`)

  try {
    // Export window: FROM → tomorrow (full dataset).
    const to = ymd(new Date(Date.now() + 86400_000))!
    log(`Pulling MD invoices + quotes ${FROM} … ${to}`)

    log('Launching headless Chromium for MD login')
    const { chromium } = await import('playwright')
    const browser = await chromium.launch({ headless: true })
    let invWb: XLSX.WorkBook, qWb: XLSX.WorkBook
    try {
      const { client } = await loginToMechanicDesk(browser, wsId, username, password)
      log('Logged in — discovering report routes')
      const discovered = await discoverReportNames(client)
      const invPaths = [...INVOICE_PATHS, ...discovered.filter(n => /invoice|sale/.test(n)).map(n => `/reports/${n}/download`)]
      const qPaths = [...QUOTE_PATHS, ...discovered.filter(n => /quot/.test(n)).map(n => `/reports/${n}/download`)]
      log('Downloading reports')
      invWb = await downloadWorkbook(client, 'invoice', [...new Set(invPaths)], FROM, to, /invoices summary/i)
      qWb = await downloadWorkbook(client, 'quote', [...new Set(qPaths)], FROM, to, /^quotes$/i)
    } finally {
      await browser.close().catch(() => undefined)
    }

    // ── Parse invoices ──────────────────────────────────────────────────
    const invSummary = sheetRows(invWb, invWb.SheetNames.find(n => /invoices summary/i.test(n))!)
    const invItemSheets = invWb.SheetNames.filter(n => /^invoice items/i.test(n))
    const invItems = invItemSheets.flatMap(n => sheetRows(invWb, n))
    log(`Invoices: ${invSummary.length} summary rows, ${invItems.length} item rows (${invItemSheets.length} sheet(s))`)

    // Per-invoice itemsText + first non-empty Vehicle Model from line items.
    const invItemsByNo: Record<string, string[]> = {}
    const invModelByNo: Record<string, string> = {}
    for (const it of invItems) {
      const no = S(it['Invoice Number'])
      if (!no) continue
      const bits = [S(it['Description']), S(it['Details']), S(it['Stock Name']), S(it['Stock Number'])].filter(Boolean) as string[]
      if (bits.length) (invItemsByNo[no] ||= []).push(bits.join(' '))
      const model = S(it['Vehicle Model'])
      if (model && !invModelByNo[no]) invModelByNo[no] = model
    }

    interface RawInv {
      invoiceNumber: string; customerId: string | null; customerName: string | null
      suburb: string | null; state: string | null; postcode: string | null
      vehicleId: string | null; rego: string | null; jobTypeText: string | null
      model: string | null; descText: string | null; itemsText: string | null
      issueDate: Date | null; totalAmount: number
    }
    const rawInvoices: RawInv[] = []
    for (const r of invSummary) {
      const no = S(r['Invoice Number'])
      if (!no) continue
      rawInvoices.push({
        invoiceNumber: no,
        customerId: S(r['Customer ID']),
        customerName: S(r['Customer Name']),
        suburb: S(r['Customer Suburb']),
        state: S(r['Customer State']),
        postcode: S(r['Customer Postcode']),
        vehicleId: S(r['Vehicle ID']),
        rego: S(r['Vehicle Registration Number']),
        jobTypeText: S(r['First Job Type']),
        model: invModelByNo[no] || null,
        descText: S(r['Description']),
        itemsText: (invItemsByNo[no] || []).join(' ').slice(0, 8000) || null,
        issueDate: D(r['Issue Date']),
        totalAmount: N(r['Total Amount']),
      })
    }

    // ── Parse quotes (line items span up to 6 paginated sheets) ────────
    const quotesSheet = sheetRows(qWb, qWb.SheetNames.find(n => /^quotes$/i.test(n))!)
    const qItemSheets = qWb.SheetNames.filter(n => /^quote items/i.test(n))
    const qItems = qItemSheets.flatMap(n => sheetRows(qWb, n))
    log(`Quotes: ${quotesSheet.length} rows, ${qItems.length} item rows (${qItemSheets.length} sheet(s))`)

    const qItemsByNo: Record<string, string[]> = {}
    const qRegoByNo: Record<string, string> = {}
    for (const it of qItems) {
      const no = S(it['Quote Number'])
      if (!no) continue
      const bits = [S(it['Description']), S(it['Details']), S(it['Stock Name']), S(it['Stock Number']), S(it['Category'])].filter(Boolean) as string[]
      if (bits.length) (qItemsByNo[no] ||= []).push(bits.join(' '))
      const rego = S(it['Vehicle Registration Number'])
      if (rego && !qRegoByNo[no]) qRegoByNo[no] = rego
    }

    interface RawQuote {
      quoteNumber: string; customerId: string | null; customerName: string | null
      suburb: string | null; state: string | null; postcode: string | null
      rego: string | null; model: string | null; descText: string | null
      itemsText: string | null; quoteDate: Date | null; totalAmount: number; status: string | null
    }
    const rawQuotes: RawQuote[] = []
    for (const r of quotesSheet) {
      const no = S(r['Quote Number'])
      if (!no) continue
      const make = S(r['Vehicle Make']), model = S(r['Vehicle Model'])
      rawQuotes.push({
        quoteNumber: no,
        customerId: S(r['Customer ID']),
        customerName: S(r['Customer Name']),
        suburb: S(r['Suburb']),
        state: S(r['State']),
        postcode: S(r['Postcode']),
        rego: qRegoByNo[no] || null,
        model: [make, model].filter(Boolean).join(' ') || null,
        descText: S(r['Description']),
        itemsText: (qItemsByNo[no] || []).join(' ').slice(0, 8000) || null,
        quoteDate: D(r['Date']),
        totalAmount: N(r['Total Amount']),
        status: S(r['Status']),
      })
    }

    // ── Classify + geocode ──────────────────────────────────────────────
    const pcData = JSON.parse(readFileSync(join(__dirname, '..', 'lib', 'workshop-map', 'au-postcodes.json'), 'utf8'))
    const postcodeMap: Record<string, LatLng> = {}, suburbMap: Record<string, LatLng> = {}
    for (const [k, v] of Object.entries<any>(pcData.pc)) postcodeMap[k] = { lat: v[0], lng: v[1], locality: v[2] }
    for (const [k, v] of Object.entries<any>(pcData.sub)) suburbMap[k] = { lat: v[0], lng: v[1], locality: v[2] }

    // vehicleId/rego → series maps come from the INVOICE set and backfill quotes too.
    const { vehicleIdMap, regoMap } = buildIdSeriesMaps(rawInvoices)
    log(`Series maps: ${Object.keys(vehicleIdMap).length} vehicle ids, ${Object.keys(regoMap).length} regos`)

    const invoices: MapInvoiceRow[] = rawInvoices.map(r => {
      const cls = classifyVehicle(r, vehicleIdMap, regoMap)
      const geo = geocode(r.postcode, r.suburb, postcodeMap, suburbMap)
      const d = r.issueDate
      return {
        invoiceNumber: r.invoiceNumber,
        customerId: r.customerId, customerName: r.customerName,
        suburb: r.suburb, state: r.state, postcode: r.postcode,
        vehicleId: r.vehicleId, rego: r.rego,
        jobTypeText: r.jobTypeText, descText: r.descText, itemsText: r.itemsText,
        issueDate: ymd(d), totalAmount: r.totalAmount,
        group: cls.group, inferred: cls.inferred,
        isNoise: isNoiseInvoice(r),
        lat: geo?.lat ?? null, lng: geo?.lng ?? null, locality: geo?.locality ?? null,
        month: d ? monthKey(d) : null,
        monthIndex: d && !isNaN(d.getTime()) ? fyMonthIndex(d) : null,
        fy: d ? fyOf(d) : null,
      }
    })

    const quotes: MapQuoteRow[] = rawQuotes.map(r => {
      const cls = classifyVehicle({ ...r, jobTypeText: null, vehicleId: null }, vehicleIdMap, regoMap)
      const geo = geocode(r.postcode, r.suburb, postcodeMap, suburbMap)
      const d = r.quoteDate
      return {
        quoteNumber: r.quoteNumber,
        customerId: r.customerId, customerName: r.customerName,
        suburb: r.suburb, state: r.state, postcode: r.postcode,
        rego: r.rego, model: r.model, descText: r.descText, itemsText: r.itemsText,
        quoteDate: ymd(d), totalAmount: r.totalAmount,
        status: r.status, won: isWon(r.status),
        group: cls.group, inferred: cls.inferred,
        lat: geo?.lat ?? null, lng: geo?.lng ?? null, locality: geo?.locality ?? null,
        month: d ? monthKey(d) : null,
        monthIndex: d && !isNaN(d.getTime()) ? fyMonthIndex(d) : null,
        fy: d ? fyOf(d) : null,
      }
    })

    // ── §7 validation: zero First-Job-Type chassis mismatches ──────────
    const bad = chassisMismatches(invoices.map(r => ({ jobTypeText: r.jobTypeText, group: r.group, ref: r.invoiceNumber })))
    if (bad.length) {
      throw new Error(`VALIDATION FAILED: ${bad.length} chassis mismatch(es), e.g. ` +
        bad.slice(0, 5).map(b => `#${b.ref} job-type says ${b.jobChassis} but classified ${b.group}`).join('; '))
    }
    const invGeo = invoices.filter(r => r.lat != null).length
    const qGeo = quotes.filter(r => r.lat != null).length
    log(`Classified ${invoices.length} invoices / ${quotes.length} quotes. ` +
      `Geocoded ${invGeo}/${invoices.length} (${(100 * invGeo / Math.max(1, invoices.length)).toFixed(1)}%) jobs, ` +
      `${qGeo}/${quotes.length} (${(100 * qGeo / Math.max(1, quotes.length)).toFixed(1)}%) quotes. Chassis mismatches: 0`)

    // ── Upload fact rows ────────────────────────────────────────────────
    const invDbRows = invoices.map(r => ({
      invoice_number: r.invoiceNumber, customer_id: r.customerId, customer_name: r.customerName,
      suburb: r.suburb, state: r.state, postcode: r.postcode, vehicle_id: r.vehicleId, rego: r.rego,
      first_job_type: r.jobTypeText, description: r.descText, items_text: r.itemsText,
      issue_date: r.issueDate, total_amount: r.totalAmount,
      vehicle_group: r.group, inferred: r.inferred, is_noise: r.isNoise,
      lat: r.lat, lng: r.lng, locality: r.locality, month: r.month, fy: r.fy,
    }))
    const qDbRows = quotes.map(r => ({
      quote_number: r.quoteNumber, customer_id: r.customerId, customer_name: r.customerName,
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

    // ── Build + upload per-FY payloads ──────────────────────────────────
    const fys = [...new Set([...invoices, ...quotes].map(r => r.fy).filter((f): f is number => f != null && f >= 2026))].sort()
    const fySummaries: Record<string, any> = {}
    for (const fy of fys) {
      const payload = buildFyPayload(fy, invoices, quotes)
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
        from: FROM, to,
        geocode: { invoices: invGeo, quotes: qGeo },
        chassis_mismatches: 0,
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
