// lib/calls-insights.ts
// SERVER-ONLY. Aggregation engine behind the Calls page insight tabs
// (Sentiment, Coaching, Words & Objections, Conversion).
//
// Pulls calls + their transcripts + AI analysis for a date range / advisor, then
// computes the aggregates that the /api/calls/insights route returns. Heavy
// numbers are pure JS over data we already store; the narrative bits (coaching
// tips, "why people don't book", sentiment story) are produced separately by
// /api/calls/insights/summary using Claude over these same aggregates.
//
// Client components import ONLY the exported types from here (type-only import,
// erased at build) — never the functions — so the Supabase dependency stays
// server-side.

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { parseAgentKey } from './calls-advisor'

// ── Row shapes (subset of columns we read) ─────────────────────────────────

export interface InsightCall {
  id: string
  call_date: string
  direction: 'inbound' | 'outbound'
  disposition: string
  billsec_seconds: number
  duration_seconds: number
  effective_advisor_name: string | null
  effective_advisor_slack_user_id: string | null
  agent_ext: string | null
  agent_name: string | null
  sales_score: number | null
}

export interface InsightAnalysis {
  call_id: string
  outcome: string
  outcome_confidence: number | null
  sales_score: number | null
  dimension_scores: Record<string, number> | null
  call_type?: string | null
  observations: {
    strengths?: string[]
    improvements?: string[]
    objections_raised?: string[]
    quotes_given?: string[]
    next_actions?: string[]
  }
  summary: string
  analysed_at: string
}

export interface InsightTranscript {
  call_id: string
  full_text: string
}

export interface InsightDataset {
  calls: InsightCall[]
  analyses: InsightAnalysis[]
  transcripts: InsightTranscript[]
}

// ── Aggregate output shapes ────────────────────────────────────────────────

export interface WordCount { term: string; count: number }
export interface KeywordCount { label: string; count: number; callCount: number }

export interface SentimentBuckets { positive: number; neutral: number; negative: number }
export interface SentimentAdvisor { advisor: string; avgScore: number; analysed: number; buckets: SentimentBuckets }
export interface SentimentTrendPoint { date: string; avgScore: number; count: number }

export interface CoachingAdvisor {
  advisor: string
  analysed: number
  avgSalesScore: number | null
  dimensionAvgs: Record<string, number>
  weakestDimension: string | null
  topImprovements: WordCount[]   // recurring improvement notes (by normalised text)
  improvementsRaw: string[]      // full list (fed to Claude for clustering)
}

export interface ConversionAdvisor {
  advisor: string
  qualified: number     // analysed calls that engaged (not wrong_number / no transcript)
  quotes: number
  bookings: number
  conversionRate: number    // bookings / qualified (0-100)
}
export interface NonConverter {
  callId: string
  advisor: string
  callDate: string
  externalLabel: string
  outcome: string
  salesScore: number | null
}

export interface CallsInsights {
  meta: {
    totalCalls: number
    answered: number
    transcribed: number
    analysed: number
    truncated: boolean
    startDate: string | null
    endDate: string | null
  }
  words: { top: WordCount[]; keywords: KeywordCount[] }
  objections: { top: WordCount[]; raw: string[] }
  sentiment: {
    overall: SentimentBuckets
    avgScore: number | null
    byAdvisor: SentimentAdvisor[]
    trend: SentimentTrendPoint[]
  }
  coaching: CoachingAdvisor[]
  conversion: {
    funnel: { answeredInbound: number; engaged: number; quoted: number; booked: number }
    outcomeCounts: WordCount[]
    byAdvisor: ConversionAdvisor[]
    missedOpportunities: NonConverter[]
  }
}

// ── Advisor labelling ───────────────────────────────────────────────────────

export function advisorLabel(c: { effective_advisor_name: string | null; agent_name: string | null; agent_ext: string | null }): string {
  return c.effective_advisor_name || c.agent_name || (c.agent_ext ? `Ext ${c.agent_ext}` : 'Unassigned')
}

// ── Word frequency ──────────────────────────────────────────────────────────

const STOPWORDS = new Set(`a an and are as at be been being but by can could did do does doing done for from
had has have having he her hers him his how i if in into is it its just me my no nor not of off on once only
or other our out over own she should so some such than that the their them then there these they this those to
too up us very was we were what when where which while who whom why will with would you your yours yeah yep ok
okay um uh hmm like get got going gonna know think want need say said see look right thing things really
actually basically literally well also one two three back come came take put give went lot bit sort kind
mean talking call calling phone here today day time good great cheers thanks thank please sorry hello hi`
  .split(/\s+/).filter(Boolean))

// Domain keyword groups for the diesel-performance / workshop business. Each
// group counts total mentions and how many distinct calls mentioned it.
const KEYWORD_GROUPS: { label: string; patterns: string[] }[] = [
  { label: 'Price / cost', patterns: ['price', 'prices', 'pricing', 'cost', 'costs', 'expensive', 'cheap', 'cheaper', 'how much', 'afford'] },
  { label: 'Quote', patterns: ['quote', 'quoted', 'quotes', 'estimate', 'estimated'] },
  { label: 'Warranty', patterns: ['warranty', 'warranties', 'guarantee', 'guaranteed'] },
  { label: 'DPF', patterns: ['dpf', 'diesel particulate', 'particulate filter'] },
  { label: 'EGR', patterns: ['egr'] },
  { label: 'Emissions / compliance', patterns: ['emission', 'emissions', 'compliance', 'defect notice', 'defected', 'roadworthy'] },
  { label: 'AdBlue / DEF', patterns: ['adblue', 'ad blue', ' def '] },
  { label: 'Turbo', patterns: ['turbo', 'turbos', 'turbocharger'] },
  { label: 'Tune / remap', patterns: ['tune', 'tunes', 'tuning', 'remap', 'remapping', 'dyno', 'ecu'] },
  { label: 'Injectors', patterns: ['injector', 'injectors'] },
  { label: 'Clutch', patterns: ['clutch'] },
  { label: 'Exhaust', patterns: ['exhaust', 'manifold'] },
  { label: 'Booking / service', patterns: ['book', 'booking', 'booked', 'appointment', 'service', 'servicing'] },
  { label: 'Wait / lead time', patterns: ['how long', 'wait', 'waiting', 'lead time', 'turnaround', 'when can'] },
]

function buildKeywordRegex(pattern: string): RegExp {
  // For single alphabetic tokens use word boundaries; for phrases match loosely.
  const escaped = pattern.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (/^\w+$/.test(pattern.trim())) return new RegExp(`\\b${escaped}\\b`, 'gi')
  return new RegExp(escaped.replace(/\s+/g, '\\s+'), 'gi')
}

const KEYWORD_REGEXES = KEYWORD_GROUPS.map(g => ({ label: g.label, regexes: g.patterns.map(buildKeywordRegex) }))

export function computeWords(transcripts: InsightTranscript[], topN = 40): { top: WordCount[]; keywords: KeywordCount[] } {
  const freq = new Map<string, number>()
  const kw = KEYWORD_REGEXES.map(g => ({ label: g.label, count: 0, callCount: 0 }))

  for (const t of transcripts) {
    const text = (t.full_text || '').slice(0, 40_000)
    if (!text) continue
    // Generic word frequency
    const tokens = text.toLowerCase().match(/[a-z]{3,}/g) || []
    for (const tok of tokens) {
      if (STOPWORDS.has(tok)) continue
      freq.set(tok, (freq.get(tok) || 0) + 1)
    }
    // Domain keyword counts (+ per-call hit flag)
    KEYWORD_REGEXES.forEach((g, i) => {
      let hits = 0
      for (const re of g.regexes) { const m = text.match(re); if (m) hits += m.length }
      if (hits > 0) { kw[i].count += hits; kw[i].callCount += 1 }
    })
  }

  const top = Array.from(freq.entries())
    .map(([term, count]) => ({ term, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, topN)

  const keywords = kw.filter(k => k.count > 0).sort((a, b) => b.count - a.count)
  return { top, keywords }
}

// ── Objections ──────────────────────────────────────────────────────────────

function normalisePhrase(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.,;:!?]+$/, '')
}

export function computeObjections(analyses: InsightAnalysis[]): { top: WordCount[]; raw: string[] } {
  const raw: string[] = []
  const freq = new Map<string, { display: string; count: number }>()
  for (const a of analyses) {
    for (const o of a.observations?.objections_raised || []) {
      if (!o || !o.trim()) continue
      raw.push(o.trim())
      const key = normalisePhrase(o)
      const cur = freq.get(key)
      if (cur) cur.count++
      else freq.set(key, { display: o.trim(), count: 1 })
    }
  }
  const top = Array.from(freq.values())
    .map(v => ({ term: v.display, count: v.count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 25)
  return { top, raw }
}

// ── Sentiment (derived, no Claude) ──────────────────────────────────────────
// A pragmatic proxy from data we already store: agent rapport sets the base,
// the call outcome nudges it, and each unresolved objection pulls it down.
// Clearly an approximation — the Claude pass refines the narrative.

export function deriveSentiment(a: InsightAnalysis): number {
  const rapport = typeof a.dimension_scores?.rapport === 'number' ? a.dimension_scores.rapport : 5
  let score = rapport * 10                        // 0-100 base
  const outcome = a.outcome
  if (outcome === 'sale') score += 20
  else if (outcome === 'callback_scheduled') score += 10
  else if (outcome === 'quote_given') score += 3
  else if (outcome === 'no_outcome') score -= 12
  else if (outcome === 'wrong_number') score -= 5
  const objections = a.observations?.objections_raised?.length || 0
  score -= Math.min(15, objections * 4)
  return Math.max(0, Math.min(100, Math.round(score)))
}

function bucketOf(score: number): keyof SentimentBuckets {
  if (score >= 65) return 'positive'
  if (score >= 40) return 'neutral'
  return 'negative'
}

export function computeSentiment(calls: InsightCall[], analyses: InsightAnalysis[]) {
  const callById = new Map(calls.map(c => [c.id, c]))
  const overall: SentimentBuckets = { positive: 0, neutral: 0, negative: 0 }
  const byAdvisorMap = new Map<string, { sum: number; n: number; buckets: SentimentBuckets }>()
  const byDay = new Map<string, { sum: number; n: number }>()
  let sum = 0, n = 0

  for (const a of analyses) {
    const c = callById.get(a.call_id)
    if (!c) continue
    const score = deriveSentiment(a)
    const b = bucketOf(score)
    overall[b]++
    sum += score; n++

    const adv = advisorLabel(c)
    const am = byAdvisorMap.get(adv) || { sum: 0, n: 0, buckets: { positive: 0, neutral: 0, negative: 0 } }
    am.sum += score; am.n++; am.buckets[b]++
    byAdvisorMap.set(adv, am)

    const day = c.call_date.slice(0, 10)
    const dm = byDay.get(day) || { sum: 0, n: 0 }
    dm.sum += score; dm.n++
    byDay.set(day, dm)
  }

  const byAdvisor: SentimentAdvisor[] = Array.from(byAdvisorMap.entries())
    .map(([advisor, v]) => ({ advisor, avgScore: Math.round(v.sum / v.n), analysed: v.n, buckets: v.buckets }))
    .sort((a, b) => b.analysed - a.analysed)

  const trend: SentimentTrendPoint[] = Array.from(byDay.entries())
    .map(([date, v]) => ({ date, avgScore: Math.round(v.sum / v.n), count: v.n }))
    .sort((a, b) => a.date.localeCompare(b.date))

  return { overall, avgScore: n ? Math.round(sum / n) : null, byAdvisor, trend }
}

// ── Coaching ────────────────────────────────────────────────────────────────
// Dimension keys vary by call type since the v4 rubric — accumulate whatever
// keys each analysis carries; a dimension only averages the calls it applied to.

export function computeCoaching(calls: InsightCall[], analyses: InsightAnalysis[]): CoachingAdvisor[] {
  const callById = new Map(calls.map(c => [c.id, c]))
  const map = new Map<string, {
    n: number; salesSum: number; salesN: number
    dim: Record<string, { sum: number; n: number }>
    improvements: string[]
    impFreq: Map<string, { display: string; count: number }>
  }>()

  for (const a of analyses) {
    const c = callById.get(a.call_id)
    if (!c) continue
    const adv = advisorLabel(c)
    let m = map.get(adv)
    if (!m) {
      m = { n: 0, salesSum: 0, salesN: 0, dim: {}, improvements: [], impFreq: new Map() }
      map.set(adv, m)
    }
    m.n++
    if (typeof a.sales_score === 'number') { m.salesSum += a.sales_score; m.salesN++ }
    for (const [d, v] of Object.entries(a.dimension_scores || {})) {
      if (typeof v !== 'number') continue
      if (!m.dim[d]) m.dim[d] = { sum: 0, n: 0 }
      m.dim[d].sum += v; m.dim[d].n++
    }
    for (const imp of a.observations?.improvements || []) {
      if (!imp || !imp.trim()) continue
      m.improvements.push(imp.trim())
      const key = normalisePhrase(imp)
      const cur = m.impFreq.get(key)
      if (cur) cur.count++
      else m.impFreq.set(key, { display: imp.trim(), count: 1 })
    }
  }

  return Array.from(map.entries()).map(([advisor, m]) => {
    const dimensionAvgs: Record<string, number> = {}
    let weakest: string | null = null, weakestVal = Infinity
    for (const [d, agg] of Object.entries(m.dim)) {
      if (agg.n > 0) {
        const avg = agg.sum / agg.n
        dimensionAvgs[d] = Math.round(avg * 10) / 10
        if (avg < weakestVal) { weakestVal = avg; weakest = d }
      }
    }
    const topImprovements = Array.from(m.impFreq.values())
      .map(v => ({ term: v.display, count: v.count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8)
    return {
      advisor,
      analysed: m.n,
      avgSalesScore: m.salesN ? Math.round(m.salesSum / m.salesN) : null,
      dimensionAvgs,
      weakestDimension: weakest,
      topImprovements,
      improvementsRaw: m.improvements,
    }
  }).sort((a, b) => b.analysed - a.analysed)
}

// ── Conversion funnel ───────────────────────────────────────────────────────

const BOOKED_OUTCOMES = new Set(['sale', 'callback_scheduled'])

export function computeConversion(calls: InsightCall[], analyses: InsightAnalysis[]) {
  const analysisByCall = new Map(analyses.map(a => [a.call_id, a]))
  const outcomeFreq = new Map<string, number>()
  const advMap = new Map<string, { qualified: number; quotes: number; bookings: number }>()
  const missed: NonConverter[] = []

  let answeredInbound = 0, engaged = 0, quoted = 0, booked = 0

  for (const c of calls) {
    const answered = c.disposition === 'ANSWERED'
    if (c.direction === 'inbound' && answered) answeredInbound++
    const a = analysisByCall.get(c.id)
    if (!a) continue
    if (a.outcome === 'wrong_number') continue

    engaged++
    outcomeFreq.set(a.outcome, (outcomeFreq.get(a.outcome) || 0) + 1)
    const adv = advisorLabel(c)
    const am = advMap.get(adv) || { qualified: 0, quotes: 0, bookings: 0 }
    am.qualified++

    const isQuote = a.outcome === 'quote_given' || (a.observations?.quotes_given?.length || 0) > 0
    const isBooked = BOOKED_OUTCOMES.has(a.outcome)
    if (isQuote) { quoted++; am.quotes++ }
    if (isBooked) { booked++; am.bookings++ }
    advMap.set(adv, am)

    // Missed opportunity: engaged + showed buying signal (quote or decent score)
    // but did not book.
    if (!isBooked && (isQuote || (a.sales_score ?? 0) >= 50)) {
      missed.push({
        callId: c.id,
        advisor: adv,
        callDate: c.call_date,
        externalLabel: c.agent_name ? '' : '',  // filled by API (it has external_number); keep minimal here
        outcome: a.outcome,
        salesScore: a.sales_score ?? null,
      })
    }
  }

  const byAdvisor: ConversionAdvisor[] = Array.from(advMap.entries())
    .map(([advisor, v]) => ({
      advisor, qualified: v.qualified, quotes: v.quotes, bookings: v.bookings,
      conversionRate: v.qualified ? Math.round((v.bookings / v.qualified) * 100) : 0,
    }))
    .sort((a, b) => b.qualified - a.qualified)

  const outcomeCounts = Array.from(outcomeFreq.entries())
    .map(([term, count]) => ({ term, count }))
    .sort((a, b) => b.count - a.count)

  missed.sort((a, b) => (b.salesScore ?? 0) - (a.salesScore ?? 0))

  return {
    funnel: { answeredInbound, engaged, quoted, booked },
    outcomeCounts,
    byAdvisor,
    missedOpportunities: missed.slice(0, 30),
  }
}

// ── Data fetch (Supabase) ───────────────────────────────────────────────────

export interface InsightQuery {
  startDate: string | null
  endDate: string | null
  agent: string | null   // advisor key: "slack:<id>" | "ext:<n>" | null
  limit?: number
}

const BRISBANE_OFFSET_MS = 10 * 3600 * 1000

function rangeToIso(startDate: string | null, endDate: string | null): { fromIso: string | null; toIso: string | null } {
  let fromIso: string | null = null, toIso: string | null = null
  if (startDate) fromIso = new Date(new Date(startDate + 'T00:00:00Z').getTime() - BRISBANE_OFFSET_MS).toISOString()
  if (endDate) toIso = new Date(new Date(endDate + 'T23:59:59.999Z').getTime() - BRISBANE_OFFSET_MS).toISOString()
  return { fromIso, toIso }
}

async function fetchInChunks<T>(ids: string[], fn: (chunk: string[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = []
  for (let i = 0; i < ids.length; i += 200) {
    out.push(...await fn(ids.slice(i, i + 200)))
  }
  return out
}

export function makeServiceClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase not configured')
  return createClient(url, key, { auth: { persistSession: false } })
}

// Fetches calls + their transcripts + analyses for the range/advisor. Returns
// the dataset plus the raw `external_number`/`caller_name` map so the API can
// label missed-opportunity calls.
export async function fetchInsightDataset(
  sb: SupabaseClient,
  q: InsightQuery,
): Promise<{ dataset: InsightDataset; externalById: Map<string, string>; truncated: boolean }> {
  const limit = Math.min(q.limit || 800, 1500)
  const { fromIso, toIso } = rangeToIso(q.startDate, q.endDate)
  const agentKey = parseAgentKey(q.agent)

  let query = sb.from('calls')
    .select('id, linkedid, call_date, direction, external_number, caller_name, agent_ext, agent_name, effective_advisor_name, effective_advisor_slack_user_id, duration_seconds, billsec_seconds, disposition, sales_score')
    .order('call_date', { ascending: false })
    .limit(limit)
  if (fromIso) query = query.gte('call_date', fromIso)
  if (toIso) query = query.lte('call_date', toIso)
  if (agentKey?.kind === 'slack') query = query.eq('effective_advisor_slack_user_id', agentKey.id)
  else if (agentKey?.kind === 'ext') query = query.eq('agent_ext', agentKey.ext).is('effective_advisor_slack_user_id', null)

  const { data: callRows, error } = await query
  if (error) throw error
  const calls = (callRows || []) as (InsightCall & { external_number: string | null; caller_name: string | null })[]
  const ids = calls.map(c => c.id)

  const externalById = new Map<string, string>()
  for (const c of calls) externalById.set(c.id, c.caller_name || c.external_number || 'Unknown')

  let analyses: InsightAnalysis[] = []
  let transcripts: InsightTranscript[] = []
  if (ids.length > 0) {
    analyses = await fetchInChunks(ids, async chunk => {
      const { data, error } = await sb.from('call_analysis')
        .select('call_id, outcome, outcome_confidence, sales_score, dimension_scores, observations, summary, analysed_at, call_type')
        .in('call_id', chunk)
      if (error) throw error
      return (data || []) as InsightAnalysis[]
    })
    transcripts = await fetchInChunks(ids, async chunk => {
      const { data, error } = await sb.from('call_transcripts')
        .select('call_id, full_text')
        .in('call_id', chunk)
      if (error) throw error
      return (data || []) as InsightTranscript[]
    })
  }

  return {
    dataset: { calls: calls as InsightCall[], analyses, transcripts },
    externalById,
    truncated: calls.length === limit,
  }
}

// ── Top-level assembler ─────────────────────────────────────────────────────

export function buildInsights(
  dataset: InsightDataset,
  externalById: Map<string, string>,
  opts: { truncated: boolean; startDate: string | null; endDate: string | null },
): CallsInsights {
  const { calls, analyses, transcripts } = dataset
  const conversion = computeConversion(calls, analyses)
  // Fill missed-opportunity external labels from the API-provided map.
  for (const m of conversion.missedOpportunities) m.externalLabel = externalById.get(m.callId) || 'Unknown'

  return {
    meta: {
      totalCalls: calls.length,
      answered: calls.filter(c => c.disposition === 'ANSWERED').length,
      transcribed: transcripts.length,
      analysed: analyses.length,
      truncated: opts.truncated,
      startDate: opts.startDate,
      endDate: opts.endDate,
    },
    words: computeWords(transcripts),
    objections: computeObjections(analyses),
    sentiment: computeSentiment(calls, analyses),
    coaching: computeCoaching(calls, analyses),
    conversion,
  }
}
