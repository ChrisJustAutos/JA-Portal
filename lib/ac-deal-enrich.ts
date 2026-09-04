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
  applyDealCustomFields,
  SOURCE_FIELD_LABEL,
  ensureDealFieldId,
} from './activecampaign-source'
import { quoteNumbersFromTitle, AC_GROUP, regoForDisplay, STAGE_QUOTE_REQUIRED, STAGE_QUOTE_SENT } from './ac-deal-sweep'

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
  stage: string
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
        stage: String(d.stage || ''),
      })
    }
    offset += 100
  }
  return { deals: out, complete }
}

/**
 * Deal IDs that already carry a Source value, so a re-run skips them.
 *
 * ⚠ TWO AC QUIRKS, both of which silently produced an EMPTY set:
 *   1. `/dealCustomFieldData?filters[dealCustomFieldMetumId]=N` is a 422
 *      "Invalid attribute" — that filter does not exist. Values for one
 *      field are listed at /dealCustomFieldMeta/{id}/dealCustomFieldData.
 *   2. That endpoint returns its rows under the key `dealCustomFieldMeta`,
 *      not `dealCustomFieldData` — so even a 200 parsed as zero rows.
 *
 * An empty set here does not mean "nothing done", it means "re-do
 * everything", so a failed lookup makes every run repeat the same batch
 * forever and never reach the rest of the backlog. That is why this reports
 * failure instead of quietly returning nothing.
 */
async function alreadyStamped(): Promise<{ ids: Set<string>; ok: boolean; error: string | null }> {
  const out = new Set<string>()
  const fieldId = await ensureDealFieldId(SOURCE_FIELD_LABEL)
  if (!fieldId) return { ids: out, ok: false, error: 'Source field could not be resolved' }

  let offset = 0
  while (offset < 100000) {
    try {
      const data = await acJson<any>(
        `/dealCustomFieldMeta/${fieldId}/dealCustomFieldData?limit=100&offset=${offset}`,
      )
      const page: any[] = data.dealCustomFieldData || data.dealCustomFieldMeta || []
      if (page.length === 0) break
      for (const r of page) if (String(r.fieldValue || '').trim()) out.add(String(r.dealId))
      if (page.length < 100) break
      offset += 100
    } catch (e: any) {
      return { ids: out, ok: false, error: e?.message || String(e) }
    }
  }
  return { ids: out, ok: true, error: null }
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
  fieldValuesWritten: number
  stagesAdvanced: number
  valuesFilled: number
  contactsTagged: number
  capped: boolean
  timeBudgetHit: boolean
  elapsedMs: number
  concurrency: number
  stampedLookupOk: boolean
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
    fieldValuesWritten: 0,
    stagesAdvanced: 0,
    valuesFilled: 0,
    contactsTagged: 0,
    capped: false,
    timeBudgetHit: false,
    elapsedMs: 0,
    concurrency: 0,
    stampedLookupOk: false,
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
  report.stampedLookupOk = stamped.ok
  if (!stamped.ok) report.errors.push(`already-stamped lookup failed: ${stamped.error}`)

  // A deal is work if it still needs STAMPING **or** if it is stranded at
  // Quote Required. Gating the stage fix behind "needs stamping" meant that
  // once a deal was stamped it was skipped entirely — wrong stage and all —
  // so the 464 stranded deals were reported as "no correction needed" while
  // sitting exactly where they were. Two independent jobs, two independent
  // reasons to touch a deal.
  report.alreadyStamped = candidates.filter(c => stamped.ids.has(c.deal.id)).length
  const todo = candidates.filter(c =>
    !stamped.ids.has(c.deal.id) || c.deal.stage === STAGE_QUOTE_REQUIRED,
  )

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

  // ── Writing ────────────────────────────────────────────────────────────
  // Each deal costs ~4 field writes plus a contact tag, so 250 deals is well
  // over a thousand sequential round trips — comfortably past the 300s
  // function limit. Two things keep this inside it:
  //   1. CONCURRENCY. Deals are written in small parallel groups. AC is fine
  //      with this; the ceiling is deliberately low to stay well clear of
  //      rate limiting, which would fail far more confusingly than slowness.
  //   2. A TIME BUDGET. We stop cleanly before the limit and say how far we
  //      got, rather than being killed mid-write and returning a 504 with no
  //      report at all. Every deal is written independently, so stopping
  //      early is always safe and the next run simply carries on.
  const CONCURRENCY = Number(process.env.AC_ENRICH_CONCURRENCY || 6)
  const BUDGET_MS = Number(process.env.AC_ENRICH_BUDGET_MS || 230000)
  const startedAt = Date.now()
  report.concurrency = CONCURRENCY

  const stampedIds = stamped.ids
  const queue = todo.slice(0, limit)
  report.capped = todo.length > limit

  let done = 0
  for (let i = 0; i < queue.length; i += CONCURRENCY) {
    if (Date.now() - startedAt > BUDGET_MS) {
      report.timeBudgetHit = true
      break
    }
    const group = queue.slice(i, i + CONCURRENCY)
    await Promise.all(group.map(async c => {
      const q = quoteById.get(c.quote)
      if (!q) { report.quoteNotInMd++; return }

      try {
        const fields = await mechanicsDeskDealFields(c.quote, q.vehicle, q.rego)
        if (fields.length === 0) {
          // COUNT THIS. An earlier version just returned here, so when the
          // field lookup was broken every deal fell through and the run
          // reported "enriched: 0, errors: []" — indistinguishable from
          // having no work to do. A silent zero is the worst failure shape.
          report.skippedNoFieldsResolved++
          return
        }

        const fillValue = (!c.deal.value && q.total > 0) ? q.total : null

        if (report.samples.length < 25) {
          report.samples.push({
            dealId: c.deal.id, quote: c.quote, vehicle: q.vehicle, rego: q.rego, filledValue: fillValue,
          })
        }

        if (opts.live) {
          // Values cannot ride on the deal PUT — AC accepts that and
          // discards it. They go through POST /dealCustomFieldData.
          const applied = await applyDealCustomFields(c.deal.id, fields)
          report.fieldValuesWritten += applied.written
          for (const err of applied.errors) report.errors.push(`deal ${c.deal.id}: ${err}`)

          // A deal carrying a quote number cannot still be at "Quote
          // Required" — that stage means no quote has gone out. Pipeline A
          // now advances it on update, but everything quoted before that fix
          // is stranded, so correct it here while we are on the deal.
          // 35 -> 38 ONLY: any other stage is somebody's decision.
          const dealPatch: any = {}
          if (fillValue !== null) {
            dealPatch.value = Math.round(fillValue * 100)
            dealPatch.currency = 'aud'
          }
          const advancing = c.deal.stage === STAGE_QUOTE_REQUIRED
          if (advancing) dealPatch.stage = STAGE_QUOTE_SENT

          if (Object.keys(dealPatch).length > 0) {
            await acJson(`/deals/${c.deal.id}`, {
              method: 'PUT',
              body: JSON.stringify({ deal: dealPatch }),
            })
            if (fillValue !== null) report.valuesFilled++
            if (advancing) report.stagesAdvanced++
          }

          if (c.deal.contact) {
            const t = await tagContactAsMechanicsDesk(Number(c.deal.contact))
            if (t.tagged) report.contactsTagged++
          }
        }

        // Only count it as enriched if it actually needed stamping — a deal
        // pulled in purely for the stage fix is not new enrichment.
        if (!stampedIds.has(c.deal.id)) report.enriched++
        done++
      } catch (e: any) {
        report.errors.push(`deal ${c.deal.id}: ${e?.message || String(e)}`)
      }
    }))
  }

  report.elapsedMs = Date.now() - startedAt
  return report
}
