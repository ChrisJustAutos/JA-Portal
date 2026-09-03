// pages/api/admin/inspect-ac-source-breakdown.ts
//
// READ-ONLY analysis: of the AC deals raised in the last N months, how many
// came from a Mechanics Desk quote versus everything else (web forms, Make,
// manual entry)?
//
// WHY IT HAS TO BE AN ENDPOINT: AC deals live only in ActiveCampaign — the
// portal keeps no mirror — and the AC credentials exist only in Vercel, so
// this cannot be answered from a local script or a SQL query. Open the URL
// while signed in to the portal as an admin.
//
// Usage:
//   https://justautos.app/api/admin/inspect-ac-source-breakdown
//   https://justautos.app/api/admin/inspect-ac-source-breakdown?months=12
//   ...&debug=1    also returns 40 sample titles per class, to sanity-check
//                  the classifier before trusting the split
//
// HOW ORIGIN IS DECIDED, and why it is inference rather than fact:
// The provenance marker (Source = "Mechanics Desk") only started on
// 2026-09-04, so for history we fall back to the convention Pipeline A and
// the Zapier zap before it both followed — a "Q<number>" title prefix — and
// then CONFIRM it by looking the quote number up in md_quotes.
//
// ⚠ The join column is md_quotes.DISPLAY_NUMBER, not quote_number.
// `quote_number` is MechanicDesk's internal row id (4750477); the number
// printed on the quote and carried in the deal title is `display_number`
// (61235). Joining on the wrong one matches ZERO rows and reads as "no MD
// deals exist" rather than as an error — which is exactly what it did on
// the first run. A title that
// parses AND resolves to a real MD quote is as close to proof as the old
// data gets. A title that parses but doesn't resolve is reported separately
// rather than being quietly counted as either.
//
// The Pipeline A cutover was 29 Apr 2026. Deals before that came through
// Zapier from the SAME Mechanics Desk emails, so they are still MD-origin —
// the monthly table is there so you can see whether the title convention
// holds across the boundary rather than assuming it.

import { withAuth } from '../../../lib/authServer'
import { createClient } from '@supabase/supabase-js'

export const config = { maxDuration: 300 }

const AC_PIPELINE_GROUPS_OF_INTEREST = new Set(['4', '5', '6'])

function acFetch(path: string) {
  const baseUrl = process.env.ACTIVECAMPAIGN_API_URL
  const apiKey = process.env.ACTIVECAMPAIGN_API_KEY
  if (!baseUrl || !apiKey) throw new Error('ACTIVECAMPAIGN_API_URL / ACTIVECAMPAIGN_API_KEY not set')
  return fetch(`${baseUrl.replace(/\/$/, '')}/api/3${path}`, {
    headers: { 'Api-Token': apiKey, Accept: 'application/json' },
  })
}

async function acJson<T = any>(path: string): Promise<T> {
  const r = await acFetch(path)
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

// A deal title can carry several quote numbers once the recency rule has
// appended to it: "Q61288 · Land Cruiser · ABC123 | Q61294". Pull them all.
// NOTE: this project targets ES5 — no matchAll, and no spreading an
// iterator. Exec loop and Array.from only.
function quoteNumbersFromTitle(title: string): string[] {
  const out: string[] = []
  const re = /\bQ\s?(\d{3,8})\b/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(String(title || ''))) !== null) {
    if (out.indexOf(m[1]) === -1) out.push(m[1])
  }
  return out
}

type Klass = 'mechanics_desk' | 'q_title_unmatched' | 'other'

export default withAuth(['view:reports', 'admin:settings'], async (req, res) => {
  const months = Math.min(Math.max(Number(req.query.months) || 12, 1), 36)
  const debug = req.query.debug === '1'

  const cutoff = new Date()
  cutoff.setMonth(cutoff.getMonth() - months)
  const cutoffMs = cutoff.getTime()

  // ── 1. Page AC deals newest-first until we cross the cutoff ──────────
  // Paging by cdate DESC avoids depending on AC's date-filter parameter
  // names, which differ between resources and are easy to get silently
  // wrong (a bad filter is ignored, not rejected).
  const deals: Array<{ id: string; title: string; cdate: string; group: string; stage: string; status: string; value: string; contact: string }> = []
  let offset = 0
  let pages = 0
  let hitEnd = false
  while (pages < 200) {
    const data = await acJson<{ deals: any[] }>(`/deals?orders[cdate]=DESC&limit=100&offset=${offset}`)
    const page = data.deals || []
    pages++
    if (page.length === 0) { hitEnd = true; break }
    let crossed = false
    for (const d of page) {
      const t = new Date(d.cdate).getTime()
      if (Number.isFinite(t) && t < cutoffMs) { crossed = true; continue }
      deals.push(d)
    }
    if (crossed) { hitEnd = true; break }
    offset += 100
  }

  // ── 2. Confirm the parsed quote numbers against Mechanics Desk ───────
  const allQuoteNos = new Set<string>()
  for (const d of deals) quoteNumbersFromTitle(d.title).forEach(q => allQuoteNos.add(q))

  const knownQuotes = new Set<string>()
  const quoteList = Array.from(allQuoteNos)
  for (let i = 0; i < quoteList.length; i += 500) {
    const chunk = quoteList.slice(i, i + 500)
    const { data, error } = await sb().from('md_quotes').select('display_number').in('display_number', chunk)
    if (error) throw new Error(`md_quotes lookup failed: ${error.message}`)
    for (const row of data || []) knownQuotes.add(String(row.display_number))
  }

  // ── 3. Classify ──────────────────────────────────────────────────────
  const byMonth = new Map<string, Record<Klass, { deals: number; value: number }>>()
  const totals: Record<Klass, { deals: number; value: number; contacts: Set<string> }> = {
    mechanics_desk: { deals: 0, value: 0, contacts: new Set() },
    q_title_unmatched: { deals: 0, value: 0, contacts: new Set() },
    other: { deals: 0, value: 0, contacts: new Set() },
  }
  const samples: Record<Klass, string[]> = { mechanics_desk: [], q_title_unmatched: [], other: [] }
  const byGroup: Record<string, number> = {}
  const wonLostByClass: Record<Klass, { open: number; won: number; lost: number }> = {
    mechanics_desk: { open: 0, won: 0, lost: 0 },
    q_title_unmatched: { open: 0, won: 0, lost: 0 },
    other: { open: 0, won: 0, lost: 0 },
  }

  for (const d of deals) {
    const qs = quoteNumbersFromTitle(d.title)
    const klass: Klass = qs.length === 0
      ? 'other'
      : (qs.some(q => knownQuotes.has(q)) ? 'mechanics_desk' : 'q_title_unmatched')

    const month = String(d.cdate || '').substring(0, 7)
    const dollars = (Number(d.value) || 0) / 100

    if (!byMonth.has(month)) {
      byMonth.set(month, {
        mechanics_desk: { deals: 0, value: 0 },
        q_title_unmatched: { deals: 0, value: 0 },
        other: { deals: 0, value: 0 },
      })
    }
    const m = byMonth.get(month)!
    m[klass].deals++
    m[klass].value += dollars

    totals[klass].deals++
    totals[klass].value += dollars
    if (d.contact) totals[klass].contacts.add(String(d.contact))

    const st = String(d.status)
    if (st === '1') wonLostByClass[klass].won++
    else if (st === '2') wonLostByClass[klass].lost++
    else wonLostByClass[klass].open++

    byGroup[String(d.group)] = (byGroup[String(d.group)] || 0) + 1

    if (debug && samples[klass].length < 40) samples[klass].push(`${month}  ${d.title}`)
  }

  // ── 4. What Pipeline A itself recorded, as a cross-check ─────────────
  // quote_events only covers the Pipeline A era (from ~29 Apr 2026), but
  // within it, it is FACT rather than inference — so the two should agree
  // over that window. If they don't, trust this and fix the classifier.
  const { data: peRows } = await sb()
    .from('quote_events')
    .select('ac_action, ac_deal_id, ac_contact_id, created_at')
    .not('ac_deal_id', 'is', null)
    .gte('created_at', cutoff.toISOString())
    .limit(20000)

  const pipelineADealsCreated = new Set<number>()
  const pipelineAContacts = new Set<number>()
  for (const r of peRows || []) {
    if (r.ac_action === 'deal_created' && r.ac_deal_id) pipelineADealsCreated.add(r.ac_deal_id)
    if (r.ac_contact_id) pipelineAContacts.add(r.ac_contact_id)
  }

  const fmt = (t: { deals: number; value: number; contacts: Set<string> }) => ({
    deals: t.deals,
    distinctContacts: t.contacts.size,
    totalValueIncGst: Math.round(t.value * 100) / 100,
  })

  return res.status(200).json({
    windowMonths: months,
    since: cutoff.toISOString().substring(0, 10),
    scannedDeals: deals.length,
    pagesFetched: pages,
    reachedWindowStart: hitEnd,   // false = hit the 200-page guard, numbers are a floor
    warning: hitEnd ? null : 'Paging guard hit before reaching the window start — treat every figure as a LOWER BOUND.',

    classification: {
      method: 'deal title carries a Q<number> that resolves to a real md_quotes row',
      markerNote: 'The explicit Source="Mechanics Desk" field only exists from 2026-09-04, so this window is inference, not the marker.',
      mechanics_desk: fmt(totals.mechanics_desk),
      other: fmt(totals.other),
      q_title_unmatched: {
        ...fmt(totals.q_title_unmatched),
        meaning: 'Title looks like a quote but the number is not in md_quotes — could be an older quote aged out of the MD cache, or a hand-typed title. NOT counted as either side.',
      },
    },

    outcomeByClass: wonLostByClass,
    dealsByPipelineGroup: byGroup,
    pipelineGroupsOfInterest: Array.from(AC_PIPELINE_GROUPS_OF_INTEREST),

    pipelineACrossCheck: {
      note: 'Fact, not inference — but only covers the Pipeline A era (from ~29 Apr 2026).',
      dealsCreated: pipelineADealsCreated.size,
      distinctContactsTouched: pipelineAContacts.size,
    },

    byMonth: Array.from(byMonth.entries())
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))
      .map(([month, v]) => ({
        month,
        mechanicsDesk: v.mechanics_desk.deals,
        other: v.other.deals,
        qTitleUnmatched: v.q_title_unmatched.deals,
        mechanicsDeskValue: Math.round(v.mechanics_desk.value),
        otherValue: Math.round(v.other.value),
      })),

    ...(debug ? { samples } : {}),
  })
})
