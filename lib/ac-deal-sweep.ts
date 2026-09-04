// lib/ac-deal-sweep.ts
// Nightly reconciliation of the ActiveCampaign quote pipeline against what
// actually happened in Mechanics Desk.
//
// Two passes, in this order and for a reason:
//
//   1. WON  — a quote that produced a FINALISED INVOICE in MD closes its
//             deal as Quote Won (stage 39, status 1).
//   2. LOST — a deal nobody has touched for 90 days closes as Quote Lost
//             (stage 40, status 2).
//
// Won runs first so a deal that was invoiced on day 100 is recorded as the
// win it is rather than being swept Lost the same night for going quiet.
//
// ── HOW A DEAL IS TIED TO AN INVOICE ─────────────────────────────────────
// Chris chose (2026-09-04) that only a REAL FINALISED INVOICE marks a deal
// won — deliberately NOT MD's own "won" flag, which flips at job creation,
// well before anything is invoiced.
//
// MD invoices carry no quote number, so the naive version of this is a fuzzy
// name/rego text match. We don't do that. Instead we walk MD's own keys:
//
//     AC deal  --Q<number> in the title-->  md_quotes.DISPLAY_NUMBER (exact)
//     md_quotes --customer_id + rego-->     md_invoices (MD's own IDs)
//
// ⚠ It is display_number, NOT quote_number. `quote_number` is MD's internal
// row id (4750477); `display_number` is the number printed on the quote and
// carried in the deal title (61235). The first cut joined on quote_number,
// matched exactly zero rows, and reported that as "no MD-sourced deals"
// rather than as a fault. A join that silently returns nothing is worse
// than one that throws.
//
// Only the last hop is an inference, and it is over MD's internal customer
// and vehicle identifiers rather than free text. Both hops are recorded on
// the deal note so any match can be audited after the fact.
//
// ── THE GUARDS, AND WHY EACH ONE EXISTS ──────────────────────────────────
//   - issue_date >= quote_date        an invoice predating the quote is not
//                                     evidence for it
//   - issue_date <= quote_date + N    otherwise a routine service 14 months
//                                     later marks an ancient quote Won
//   - invoice total within a RATIO BAND of the quote (0.5x - 3x). The floor
//     stops a $90 oil change closing a $12k build; the ceiling stops a $50
//     quote being closed by an unrelated $11k job on the same car. Partial
//     work is real, so this is a band and not equality, and near-misses are
//     REPORTED rather than silently dropped so the band can be tuned.
//
// ── SAFETY ───────────────────────────────────────────────────────────────
// Both passes are DRY BY DEFAULT. They report precisely what they would do
// and change nothing until AC_SWEEP_WON_LIVE / AC_SWEEP_LOST_LIVE are set
// to 'true'. The first live run of the Lost pass will close the entire
// historical backlog in one go and AC has no undo for that, so it does not
// get to happen by accident.

import { createClient } from '@supabase/supabase-js'
import { getIntegration } from './integration-config'

// ── AC pipeline geometry. Group 6 only — groups 4 and 5 are legacy and are
// deliberately never touched (group 4 has no Won/Lost stage to move to).
export const AC_GROUP = '6'
export const STAGE_QUOTE_REQUIRED = '35'
export const STAGE_QUOTE_SENT = '38'
export const STAGE_QUOTE_WON = '39'
export const STAGE_QUOTE_LOST = '40'
const DEAL_STATUS_OPEN = 0
const DEAL_STATUS_WON = 1
const DEAL_STATUS_LOST = 2

export const LOST_AFTER_DAYS = Number(process.env.AC_SWEEP_LOST_AFTER_DAYS || 90)
export const INVOICE_WINDOW_DAYS = Number(process.env.AC_SWEEP_INVOICE_WINDOW_DAYS || 180)
export const MIN_INVOICE_RATIO = Number(process.env.AC_SWEEP_MIN_INVOICE_RATIO || 0.5)
// Ceiling added 2026-09-04 after the first dry run. The floor alone let
// through invoices 35x, 83x and 230x the quote — a tiny quote and a big
// unrelated job on the same car, not the quoted work. Across the open
// pipeline only one deal sits above 3x, so this costs almost nothing and
// removes the whole class of false win.
export const MAX_INVOICE_RATIO = Number(process.env.AC_SWEEP_MAX_INVOICE_RATIO || 3)

// Read DB-first via integration-config so they can be flipped in the portal
// without a redeploy — and, more importantly, flipped OFF in seconds. The
// Lost pass has no undo; an arming switch that needs a Vercel edit and a
// rebuild is not a usable emergency stop.
export async function wonPassIsLive(): Promise<boolean> {
  return (await getIntegration('AC_SWEEP_WON_LIVE')).toLowerCase() === 'true'
}
export async function lostPassIsLive(): Promise<boolean> {
  return (await getIntegration('AC_SWEEP_LOST_LIVE')).toLowerCase() === 'true'
}
export async function sweepIsEnabled(): Promise<boolean> {
  return (await getIntegration('AC_SWEEP_ENABLED')).toLowerCase() !== 'false'
}

function acFetch(path: string, opts: RequestInit = {}) {
  const baseUrl = process.env.ACTIVECAMPAIGN_API_URL
  const apiKey = process.env.ACTIVECAMPAIGN_API_KEY
  if (!baseUrl || !apiKey) throw new Error('ACTIVECAMPAIGN_API_URL / ACTIVECAMPAIGN_API_KEY not set')
  return fetch(`${baseUrl.replace(/\/$/, '')}/api/3${path}`, {
    ...opts,
    headers: {
      'Api-Token': apiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(opts.headers || {}),
    },
  })
}

async function acJson<T = any>(path: string, opts: RequestInit = {}): Promise<T> {
  const r = await acFetch(path, opts)
  if (!r.ok) throw new Error(`AC ${r.status} on ${path}: ${(await r.text()).substring(0, 300)}`)
  return r.json()
}

function sb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  )
}

// ── Placeholder regos ────────────────────────────────────────────────────
// 2,667 MD quotes carry the rego "TBA", plus ~130 more as N/A, TBC or NA —
// 12% of every rego in the system. They are the ABSENCE of a rego written
// as text, and treating them as a value is actively harmful:
//   - the win match requires both regos equal, so "TBA" == "TBA" reads as
//     "same vehicle" and would let one of a customer's cars close the
//     other's quote — exactly the failure the rego check exists to prevent
//   - the backfill would write "TBA" into a Rego field, which is worse than
//     leaving it empty because it looks like data
// Normalise them to null everywhere instead.
const PLACEHOLDER_REGOS = ['TBA', 'TBC', 'NA', 'N/A', 'NONE', 'UNKNOWN', 'PENDING', 'X', 'XX', 'XXX', '0', '00', '-', '--', '?']

/**
 * COMPARISON key: upper-cased, spaces removed, placeholders null. Use this
 * for matching a quote's vehicle to an invoice's — "MRM 40" and "MRM40" are
 * the same plate and must compare equal.
 */
export function normaliseRego(raw: string | null | undefined): string | null {
  const r = String(raw || '').toUpperCase().replace(/\s+/g, '')
  if (!r) return null
  if (PLACEHOLDER_REGOS.indexOf(r) !== -1) return null
  if (r.replace(/[^A-Z0-9]/g, '').length < 3) return null   // too short to identify a vehicle
  return r
}

/**
 * DISPLAY form: the rego as it actually reads, with inner spacing kept —
 * "MRM 40", not "MRM40". Same validity rules as normaliseRego (placeholders
 * and stubs are still null), but never write the comparison key into a field
 * a human reads: the stripped form is an artefact of matching, not the plate.
 */
export function regoForDisplay(raw: string | null | undefined): string | null {
  if (!normaliseRego(raw)) return null
  return String(raw || '').toUpperCase().replace(/\s+/g, ' ').trim()
}

// ES5 target: no matchAll, no spreading iterators.
export function quoteNumbersFromTitle(title: string): string[] {
  const out: string[] = []
  const re = /\bQ\s?(\d{3,8})\b/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(String(title || ''))) !== null) {
    if (out.indexOf(m[1]) === -1) out.push(m[1])
  }
  return out
}

export interface OpenDeal {
  id: string
  title: string
  cdate: string
  mdate: string
  value: number        // dollars
  contact: string
  stage: string
}

/**
 * Every OPEN deal in group 6. Pages until exhausted.
 *
 * `filters[status]` is applied client-side as well as in the query: an AC
 * filter that it doesn't recognise is IGNORED rather than rejected, so a
 * server-side-only filter can silently return everything. Re-checking here
 * is what stops that turning into a mass close of won deals.
 */
export async function listOpenGroupDeals(maxPages = 200): Promise<{ deals: OpenDeal[]; complete: boolean }> {
  const out: OpenDeal[] = []
  let offset = 0
  let pages = 0
  let complete = false

  while (pages < maxPages) {
    const data = await acJson<{ deals: any[] }>(
      `/deals?filters[group]=${AC_GROUP}&filters[status]=${DEAL_STATUS_OPEN}&orders[cdate]=DESC&limit=100&offset=${offset}`,
    )
    const page = data.deals || []
    pages++
    if (page.length === 0) { complete = true; break }

    for (const d of page) {
      if (String(d.group) !== AC_GROUP) continue           // belt
      if (Number(d.status) !== DEAL_STATUS_OPEN) continue  // and braces
      out.push({
        id: String(d.id),
        title: String(d.title || ''),
        cdate: String(d.cdate || ''),
        mdate: String(d.mdate || d.cdate || ''),
        value: (Number(d.value) || 0) / 100,
        contact: String(d.contact || ''),
        stage: String(d.stage || ''),
      })
    }
    offset += 100
  }
  return { deals: out, complete }
}

async function moveDeal(dealId: string, stage: string, status: number, note: string, live: boolean): Promise<void> {
  if (!live) return
  await acJson(`/deals/${dealId}`, {
    method: 'PUT',
    body: JSON.stringify({ deal: { stage, status } }),
  })
  try {
    await acJson(`/notes`, {
      method: 'POST',
      body: JSON.stringify({ note: { note, relid: Number(dealId), reltype: 'Deal' } }),
    })
  } catch (e: any) {
    // The stage move is the deliverable; the audit note is not worth
    // failing the run over.
    console.warn(`[ac-sweep] note failed on deal ${dealId}:`, e?.message)
  }
}

// ── WON PASS ─────────────────────────────────────────────────────────────

export interface WonMatch {
  dealId: string
  dealTitle: string
  dealValue: number
  quoteNumber: string
  quoteDate: string
  quoteTotal: number
  invoiceNumber: string
  invoiceDate: string
  invoiceTotal: number
  ratio: number
}

export interface WonPassReport {
  live: boolean
  openDealsScanned: number
  dealsWithQuoteNumber: number
  quotesResolved: number
  matched: WonMatch[]
  rejectedByRatio: WonMatch[]
  rejectedByWindow: number
  rejectedNoRego: number
  moved: number
  errors: string[]
}

export async function runWonPass(deals: OpenDeal[], live: boolean): Promise<WonPassReport> {
  const report: WonPassReport = {
    live,
    openDealsScanned: deals.length,
    dealsWithQuoteNumber: 0,
    quotesResolved: 0,
    matched: [],
    rejectedByRatio: [],
    rejectedByWindow: 0,
    rejectedNoRego: 0,
    moved: 0,
    errors: [],
  }

  // Deal -> its quote numbers
  const dealQuotes: Array<{ deal: OpenDeal; quotes: string[] }> = []
  const allQuoteNos: string[] = []
  for (const d of deals) {
    const qs = quoteNumbersFromTitle(d.title)
    if (qs.length === 0) continue
    report.dealsWithQuoteNumber++
    dealQuotes.push({ deal: d, quotes: qs })
    for (const q of qs) if (allQuoteNos.indexOf(q) === -1) allQuoteNos.push(q)
  }
  if (allQuoteNos.length === 0) return report

  // Quote number -> MD quote (customer_id, rego, date, total)
  const quoteById = new Map<string, { customer_id: string; rego: string; quote_date: string; total_amount: number }>()
  for (let i = 0; i < allQuoteNos.length; i += 500) {
    const chunk = allQuoteNos.slice(i, i + 500)
    const { data, error } = await sb()
      .from('md_quotes')
      .select('display_number, customer_id, rego, quote_date, total_amount')
      .in('display_number', chunk)
    if (error) throw new Error(`md_quotes lookup failed: ${error.message}`)
    for (const r of data || []) {
      quoteById.set(String(r.display_number), {
        customer_id: String(r.customer_id || ''),
        rego: normaliseRego(r.rego) || '',
        quote_date: String(r.quote_date || ''),
        total_amount: Number(r.total_amount) || 0,
      })
    }
  }
  report.quotesResolved = quoteById.size

  // Candidate invoices: everything for the customers we care about.
  const customerIds: string[] = []
  quoteById.forEach(q => { if (q.customer_id && customerIds.indexOf(q.customer_id) === -1) customerIds.push(q.customer_id) })

  // Oldest quote in play, minus the match window — nothing older can ever
  // qualify, so it is safe (and much cheaper) to exclude it.
  let oldestQuoteMs = Date.now()
  quoteById.forEach(q => {
    const t = new Date(q.quote_date).getTime()
    if (Number.isFinite(t) && t < oldestQuoteMs) oldestQuoteMs = t
  })
  const invoiceFloor = new Date(oldestQuoteMs - 7 * 24 * 60 * 60 * 1000)
    .toISOString()
    .substring(0, 10)

  const invoicesByCustomer = new Map<string, Array<{ invoice_number: string; rego: string; issue_date: string; total_amount: number }>>()
  for (let i = 0; i < customerIds.length; i += 300) {
    const chunk = customerIds.slice(i, i + 300)
    // BOUNDED DELIBERATELY. PostgREST caps an unbounded select at 1000 rows
    // and TRUNCATES SILENTLY — a dropped invoice here reads as "no match",
    // i.e. a real win quietly missed. We never need an invoice older than
    // the oldest quote any open deal could carry, so floor the read by date
    // and page it rather than trusting one request to return everything.
    const { data, error } = await sb()
      .from('md_invoices')
      .select('invoice_number, display_number, customer_id, rego, issue_date, total_amount')
      .in('customer_id', chunk)
      .eq('missing', false)
      .gte('issue_date', invoiceFloor)
      .order('issue_date', { ascending: false })
      .range(0, 9999)
    if (error) throw new Error(`md_invoices lookup failed: ${error.message}`)
    if ((data || []).length >= 10000) {
      throw new Error('md_invoices page hit 10000 rows — the read is truncating; narrow the chunk size')
    }
    for (const r of data || []) {
      const key = String(r.customer_id)
      if (!invoicesByCustomer.has(key)) invoicesByCustomer.set(key, [])
      invoicesByCustomer.get(key)!.push({
        invoice_number: String(r.display_number || r.invoice_number || ''),
        rego: normaliseRego(r.rego) || '',
        issue_date: String(r.issue_date || ''),
        total_amount: Number(r.total_amount) || 0,
      })
    }
  }

  const DAY = 24 * 60 * 60 * 1000

  for (const { deal, quotes } of dealQuotes) {
    let best: WonMatch | null = null
    let sawWindowReject = false
    let sawNoRego = false

    for (const qn of quotes) {
      const q = quoteById.get(qn)
      if (!q || !q.customer_id) continue
      const invs = invoicesByCustomer.get(q.customer_id) || []
      const qTime = new Date(q.quote_date).getTime()
      if (!Number.isFinite(qTime)) continue

      for (const inv of invs) {
        // Same vehicle, and BOTH sides must actually carry a rego. The
        // earlier version passed when either was blank, which quietly fell
        // back to matching on customer alone — precisely the "customer's
        // other car closes the wrong quote" failure this is meant to stop.
        // Rego-less rows are counted, not silently widened into a match.
        if (!q.rego || !inv.rego) { sawNoRego = true; continue }
        if (q.rego !== inv.rego) continue
        const iTime = new Date(inv.issue_date).getTime()
        if (!Number.isFinite(iTime)) continue
        if (iTime < qTime) continue
        if (iTime > qTime + INVOICE_WINDOW_DAYS * DAY) { sawWindowReject = true; continue }

        const ratio = q.total_amount > 0 ? inv.total_amount / q.total_amount : 0
        const cand: WonMatch = {
          dealId: deal.id,
          dealTitle: deal.title,
          dealValue: deal.value,
          quoteNumber: qn,
          quoteDate: q.quote_date,
          quoteTotal: q.total_amount,
          invoiceNumber: inv.invoice_number,
          invoiceDate: inv.issue_date,
          invoiceTotal: inv.total_amount,
          ratio: Math.round(ratio * 1000) / 1000,
        }
        // Prefer the earliest qualifying invoice — the one most likely to
        // be the work the quote described.
        if (ratio >= MIN_INVOICE_RATIO && ratio <= MAX_INVOICE_RATIO) {
          if (!best || new Date(cand.invoiceDate).getTime() < new Date(best.invoiceDate).getTime()) best = cand
        } else if (!best) {
          report.rejectedByRatio.push(cand)
        }
      }
    }

    if (sawWindowReject && !best) report.rejectedByWindow++
    if (sawNoRego && !best) report.rejectedNoRego++
    if (!best) continue

    report.matched.push(best)
    const note = [
      'Quote Won — set automatically by the nightly MD reconciliation.',
      `Quote ${best.quoteNumber} (${best.quoteDate}, $${best.quoteTotal.toFixed(2)})`,
      `matched finalised MD invoice ${best.invoiceNumber} (${best.invoiceDate}, $${best.invoiceTotal.toFixed(2)}).`,
      `Invoice/quote ratio ${best.ratio}. Matched on MD customer id + rego.`,
    ].join('\n')

    try {
      await moveDeal(best.dealId, STAGE_QUOTE_WON, DEAL_STATUS_WON, note, live)
      if (live) report.moved++
    } catch (e: any) {
      report.errors.push(`deal ${best.dealId}: ${e?.message || String(e)}`)
    }
  }

  return report
}

// ── LOST PASS ────────────────────────────────────────────────────────────

// Deals whose STAGE is already Won or Lost while their STATUS is still open.
// 56 of these exist in the live pipeline — someone moved the card without
// the status following. They are already decided, so the Lost sweep must
// leave them alone rather than "closing" a deal that reads as Won.
const DECIDED_STAGES = [STAGE_QUOTE_WON, STAGE_QUOTE_LOST]

export interface LostCandidate {
  dealId: string
  dealTitle: string
  dealValue: number
  lastTouched: string
  daysSinceTouch: number
}

export interface LostPassReport {
  live: boolean
  openDealsScanned: number
  cutoffDays: number
  candidates: LostCandidate[]
  totalValue: number
  oldestTouch: string | null
  skippedAlreadyDecided: number
  moved: number
  errors: string[]
}

export async function runLostPass(
  deals: OpenDeal[],
  live: boolean,
  excludeDealIds: string[],
): Promise<LostPassReport> {
  const DAY = 24 * 60 * 60 * 1000
  const now = Date.now()
  const report: LostPassReport = {
    live,
    openDealsScanned: deals.length,
    cutoffDays: LOST_AFTER_DAYS,
    candidates: [],
    totalValue: 0,
    oldestTouch: null,
    skippedAlreadyDecided: 0,
    moved: 0,
    errors: [],
  }

  for (const d of deals) {
    // Anything the Won pass just closed is no longer ours to close.
    if (excludeDealIds.indexOf(d.id) !== -1) continue

    // Already sitting at Quote Won / Quote Lost, status just never followed.
    if (DECIDED_STAGES.indexOf(d.stage) !== -1) { report.skippedAlreadyDecided++; continue }

    const touched = new Date(d.mdate).getTime()
    if (!Number.isFinite(touched)) continue
    const days = Math.floor((now - touched) / DAY)
    if (days < LOST_AFTER_DAYS) continue

    report.candidates.push({
      dealId: d.id,
      dealTitle: d.title,
      dealValue: d.value,
      lastTouched: d.mdate,
      daysSinceTouch: days,
    })
    report.totalValue += d.value
    if (!report.oldestTouch || d.mdate < report.oldestTouch) report.oldestTouch = d.mdate
  }

  report.totalValue = Math.round(report.totalValue * 100) / 100

  for (const c of report.candidates) {
    const note = [
      'Quote Lost — set automatically by the nightly sweep.',
      `No activity on this deal for ${c.daysSinceTouch} days (last touched ${c.lastTouched.substring(0, 10)});`,
      `the threshold is ${LOST_AFTER_DAYS} days. Reopen it if the customer comes back.`,
    ].join('\n')
    try {
      await moveDeal(c.dealId, STAGE_QUOTE_LOST, DEAL_STATUS_LOST, note, live)
      if (live) report.moved++
    } catch (e: any) {
      report.errors.push(`deal ${c.dealId}: ${e?.message || String(e)}`)
    }
  }

  return report
}
