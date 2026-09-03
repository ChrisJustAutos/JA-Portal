// lib/ac-deal-enrich.ts
// Backfill Mechanics Desk detail onto ActiveCampaign deals that predate the
// provenance marker.
//
// From 2026-09-04 Pipeline A stamps Source / MD Quote Number / Vehicle / Rego
// as it writes each deal. Everything raised before that carries the detail
// only inside its TITLE ("Q61288 · 2020 Toyota Land Cruiser · CE20WZ"), which
// is free text a rep can edit away and which nothing can filter or group by.
// This pass reads the quote back out of Mechanics Desk and writes it into
// fields.
//
// WHAT IT DOES NOT DO: fill in deal VALUE. That was the original ask, and
// measuring it first showed there is nothing to fill — on the open pipeline
// every deal carrying a quote number already has a value (1,126 of 1,126),
// and every deal without a value has no quote number to look one up with.
// The code still fills a missing value when it legitimately finds one, but
// the expected count is zero and that is the correct result, not a bug.
//
// JOIN: deal title "Q<number>" -> md_quotes.DISPLAY_NUMBER. Not
// quote_number, which is MechanicDesk's internal row id — see the warning in
// lib/ac-deal-sweep.ts. That mistake matched zero rows and read as "no data".
//
// SAFETY: dry by default; writes only when `live` is passed. It never
// overwrites a field that already holds a value and never touches the title,
// the stage or the status — this pass adds information, it does not make
// decisions. Deals are processed newest-first and capped per run.

import { createClient } from '@supabase/supabase-js'
import {
  mechanicsDeskDealFields,
  tagContactAsMechanicsDesk,
  SOURCE_FIELD_LABEL,
  ensureDealFieldId,
} from './activecampaign-source'
import { quoteNumbersFromTitle, AC_GROUP, regoForDisplay } from './ac-deal-sweep'

function acFetch(path: string, opts: RequestInit = {}) {
  const baseUrl = process.env.ACTIVECAMPAIGN_API_URL
  const apiKey = process.env.ACTIVECAMPAIGN_API_KEY
  if (!baseUrl || !apiKey) throw new Error('ACTIVECAMPAIGN_API_URL / ACTIVECAMPAIGN_API_KEY not set')
  return fetch(`${baseUrl.replace(/\/$/, '')}/api/3${path}`, {
    ...opts,
    headers: {
      'Api-Token': apiKey, 'Content-Type': 'application/json', Accept: 'application/json',
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

interface EnrichDeal {
  id: string
  title: string
  value: number
  contact: string
  cdate: string
}

/** Every deal in group 6, any status — historical reporting wants the closed ones too. */
async function listGroupDeals(maxPages: number): Promise<{ deals: EnrichDeal[]; complete: boolean }> {
  const out: EnrichDeal[] = []
  let offset = 0
  let pages = 0
  let complete = false
  while (pages < maxPages) {
    const data = await acJson<{ deals: any[] }>(
      `/deals?filters[group]=${AC_GROUP}&orders[cdate]=DESC&limit=100&offset=${offset}`,
    )
    const page = data.deals || []
    pages++
    if (page.length === 0) { complete = true; break }
    for (const d of page) {
      // Re-verify group client-side: AC ignores a filter it doesn't know
      // rather than rejecting it, so a server-side-only filter can quietly
      // hand back the entire account.
      if (String(d.group) !== AC_GROUP) continue
      out.push({
        id: String(d.id),
        title: String(d.title || ''),
        value: (Number(d.value) || 0) / 100,
        contact: String(d.contact || ''),
        cdate: String(d.cdate || ''),
      })
    }
    offset += 100
  }
  return { deals: out, complete }
}

/** Deal IDs that already carry a Source value — cheap way to skip done work. */
async function alreadyStamped(): Promise<Set<string>> {
  const out = new Set<string>()
  const fieldId = await ensureDealFieldId(SOURCE_FIELD_LABEL)
  if (!fieldId) return out
  let offset = 0
  while (offset < 50000) {
    try {
      const data = await acJson<{ dealCustomFieldData: any[] }>(
        `/dealCustomFieldData?filters[dealCustomFieldMetumId]=${fieldId}&limit=100&offset=${offset}`,
      )
      const page = data.dealCustomFieldData || []
      if (page.length === 0) break
      for (const r of page) if (String(r.fieldValue || '').trim()) out.add(String(r.dealId))
      if (page.length < 100) break
      offset += 100
    } catch (e: any) {
      // Not fatal: without this list we simply re-stamp deals that already
      // have the field, which is idempotent — just slower.
      console.warn('[ac-enrich] could not list stamped deals:', e?.message)
      break
    }
  }
  return out
}

export interface EnrichReport {
  live: boolean
  dealsScanned: number
  pagingComplete: boolean
  withQuoteNumber: number
  alreadyStamped: number
  quotesResolved: number
  quoteNotInMd: number
  skippedNoFieldsResolved: number
  enriched: number
  valuesFilled: number
  contactsTagged: number
  capped: boolean
  samples: Array<{ dealId: string; quote: string; vehicle: string | null; rego: string | null; filledValue: number | null }>
  errors: string[]
}

export async function runDealEnrichment(opts: {
  live: boolean
  limit?: number
  maxPages?: number
}): Promise<EnrichReport> {
  const limit = opts.limit ?? 250
  const report: EnrichReport = {
    live: opts.live,
    dealsScanned: 0,
    pagingComplete: false,
    withQuoteNumber: 0,
    alreadyStamped: 0,
    quotesResolved: 0,
    quoteNotInMd: 0,
    skippedNoFieldsResolved: 0,
    enriched: 0,
    valuesFilled: 0,
    contactsTagged: 0,
    capped: false,
    samples: [],
    errors: [],
  }

  const { deals, complete } = await listGroupDeals(opts.maxPages ?? 60)
  report.dealsScanned = deals.length
  report.pagingComplete = complete

  const candidates: Array<{ deal: EnrichDeal; quote: string }> = []
  for (const d of deals) {
    const qs = quoteNumbersFromTitle(d.title)
    if (qs.length === 0) continue
    report.withQuoteNumber++
    // Latest quote number wins, matching what Pipeline A stamps live.
    candidates.push({ deal: d, quote: qs[qs.length - 1] })
  }
  if (candidates.length === 0) return report

  const stamped = await alreadyStamped()

  const todo = candidates.filter(c => !stamped.has(c.deal.id))
  report.alreadyStamped = candidates.length - todo.length

  // Resolve every quote in one batched read before touching AC.
  const nums: string[] = []
  for (const c of todo) if (nums.indexOf(c.quote) === -1) nums.push(c.quote)

  const quoteById = new Map<string, { vehicle: string | null; rego: string | null; total: number; date: string }>()
  for (let i = 0; i < nums.length; i += 500) {
    const chunk = nums.slice(i, i + 500)
    const { data, error } = await sb()
      .from('md_quotes')
      .select('display_number, vehicle_model, rego, total_amount, quote_date')
      .in('display_number', chunk)
    if (error) throw new Error(`md_quotes lookup failed: ${error.message}`)
    for (const r of data || []) {
      quoteById.set(String(r.display_number), {
        vehicle: (r.vehicle_model || '').trim() || null,
        // DISPLAY form — this is written into a field a rep reads.
        rego: regoForDisplay(r.rego),   // 'TBA' and friends become null, not data
        total: Number(r.total_amount) || 0,
        date: String(r.quote_date || ''),
      })
    }
  }
  report.quotesResolved = quoteById.size

  let done = 0
  for (const c of todo) {
    if (done >= limit) { report.capped = true; break }
    const q = quoteById.get(c.quote)
    if (!q) { report.quoteNotInMd++; continue }

    try {
      const fields = await mechanicsDeskDealFields(c.quote, q.vehicle, q.rego)
      if (fields.length === 0) {
        // COUNT THIS. An earlier version just `continue`d, so when the field
        // lookup was broken every single deal fell through here and the run
        // reported "enriched: 0, errors: []" — indistinguishable from having
        // no work to do. A silent zero is the worst possible failure shape.
        report.skippedNoFieldsResolved++
        continue
      }

      // Only fill a value that is genuinely absent — never restate or
      // change one a rep has set.
      const fillValue = (!c.deal.value && q.total > 0) ? q.total : null

      if (report.samples.length < 25) {
        report.samples.push({
          dealId: c.deal.id, quote: c.quote, vehicle: q.vehicle, rego: q.rego, filledValue: fillValue,
        })
      }

      if (opts.live) {
        const payload: any = {
          deal: {},
          dealCustomFieldData: fields.map(f => ({ customFieldId: f.fieldId, fieldValue: f.value })),
        }
        if (fillValue !== null) {
          payload.deal.value = Math.round(fillValue * 100)
          payload.deal.currency = 'aud'
        }
        await acJson(`/deals/${c.deal.id}`, { method: 'PUT', body: JSON.stringify(payload) })
        if (fillValue !== null) report.valuesFilled++

        if (c.deal.contact) {
          const t = await tagContactAsMechanicsDesk(Number(c.deal.contact))
          if (t.tagged) report.contactsTagged++
        }
      }

      report.enriched++
      done++
    } catch (e: any) {
      report.errors.push(`deal ${c.deal.id}: ${e?.message || String(e)}`)
    }
  }

  return report
}
