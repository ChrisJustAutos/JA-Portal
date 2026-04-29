// lib/quote-call-context.ts
// Combined call-history lookup. Used by:
//   - Pipeline B (Monday "Fetch Call Notes" button): post a combined narrative
//     covering the customer's recent call history as a Monday update.
//
// LOGIC:
//   1. Normalise input phone (multiple variants — see buildPhoneVariants).
//   2. Find ALL calls within the last 30 days that:
//        - match a phone variant
//        - have a transcript with substantive content (>= 50 chars)
//      ordered by call_date DESC, capped at MAX_CALLS.
//   3. If zero qualifying calls → return null.
//   4. Otherwise → call generateCombinedFollowUp() to produce one cohesive
//      narrative covering all the calls, plus a footer listing them.
//
// PERSISTENCE: this function does NOT persist anything. The combined view
// doesn't fit neatly into call_analysis.follow_up_summary (which is per-call).
// We re-generate every button-press; ~$0.005-0.02 per click and a few seconds.
// If usage volumes ever justify caching, we'd add a customer_call_summaries
// table keyed by (phone, call_id_set_hash). Not warranted yet.
//
// PIPELINE A: a separate single-call function (kept for future use) lives
// adjacent — currently this file exposes only the combined flow because
// Pipeline A isn't built yet. When Pipeline A is built, it will use the
// existing single-call generateFollowUpSummary directly rather than this
// helper.

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { normalisePhone } from './monday-followup'
import {
  generateCombinedFollowUp,
  renderCombinedNote,
  CombinedFollowUp,
  CombinedCallInput,
} from './anthropic-followup'

const LOOKBACK_DAYS = 30
const MAX_CALLS = 10                  // cap per design discussion
const MIN_TRANSCRIPT_CHARS = 50       // skip calls with effectively no transcript

export interface QuoteCallContext {
  // The most recent call (used for header / matched_call_id logging)
  latestCallId: string
  latestCallDate: string

  // All call IDs included in the analysis (chronological-asc)
  callIds: string[]

  // The combined narrative
  summary: CombinedFollowUp

  // Pre-rendered text for the Monday Update body
  formatted: string

  // Telemetry
  callCount: number                   // how many calls fed into the summary
  generatedOnDemand: true             // always true — this flow always generates
}

function getServiceClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw new Error('Supabase env vars not configured (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)')
  }
  return createClient(url, key, { auth: { persistSession: false } })
}

// Variants to bridge SQL-column normalisation vs TS normalisePhone.
function buildPhoneVariants(rawPhone: string): string[] {
  const stripped = rawPhone.replace(/\s+/g, '').trim()
  const tsNorm = normalisePhone(stripped)
  if (!tsNorm) return []

  const variants = new Set<string>()
  variants.add(`0${tsNorm}`)
  variants.add(tsNorm)
  variants.add(stripped)
  if (stripped.startsWith('+')) variants.add(stripped.substring(1))

  return Array.from(variants).filter(Boolean)
}

/**
 * Look up and combine recent calls for a phone into a single narrative.
 *
 * @param rawPhone Phone number in any common format.
 * @returns        The combined summary + rendered Monday-update text,
 *                 or null if no qualifying calls exist.
 */
export async function getQuoteCallContext(
  rawPhone: string | null | undefined,
): Promise<QuoteCallContext | null> {
  if (!rawPhone || !rawPhone.trim()) return null

  const variants = buildPhoneVariants(rawPhone)
  if (variants.length === 0) return null

  const sb = getServiceClient()
  const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString()

  // Pull recent calls + their transcripts. We want as many as possible up to
  // MAX_CALLS but Supabase's PostgREST returns the joined table as nested
  // arrays so we filter/cap in code rather than via SQL window functions.
  const { data, error } = await sb
    .from('calls')
    .select(`
      id,
      call_date,
      duration_seconds,
      direction,
      caller_name,
      external_number,
      external_number_normalised,
      effective_advisor_name,
      agent_name,
      call_transcripts(full_text)
    `)
    .in('external_number_normalised', variants)
    .gte('call_date', since)
    .order('call_date', { ascending: false })
    .limit(MAX_CALLS * 2)              // pull a margin in case some lack transcripts

  if (error) {
    console.warn('[quote-call-context] Supabase query failed:', error.message)
    return null
  }
  if (!data || data.length === 0) return null

  // Filter to calls with substantive transcripts.
  type Row = (typeof data)[number]
  const eligible: Array<{ row: Row; transcript: string }> = []
  for (const row of data) {
    const transcriptObj = pickFirst((row as any).call_transcripts)
    const transcript = transcriptObj?.full_text || ''
    if (transcript.trim().length >= MIN_TRANSCRIPT_CHARS) {
      eligible.push({ row, transcript })
    }
    if (eligible.length >= MAX_CALLS) break
  }

  if (eligible.length === 0) return null

  // Build the input shape generateCombinedFollowUp expects.
  const callsForClaude: CombinedCallInput[] = eligible.map(({ row, transcript }) => ({
    callId: (row as any).id,
    callDate: (row as any).call_date,
    direction: ((row as any).direction || 'inbound') as 'inbound' | 'outbound',
    agentName: (row as any).effective_advisor_name || (row as any).agent_name || null,
    durationSeconds: (row as any).duration_seconds || 0,
    transcript,
  }))

  let combined: CombinedFollowUp
  try {
    const result = await generateCombinedFollowUp(callsForClaude)
    combined = result.summary
  } catch (e: any) {
    console.warn('[quote-call-context] combined generation failed:', e?.message || e)
    return null
  }

  // Render the Monday Update body.
  const formatted = renderCombinedNote(combined, {
    calls: callsForClaude.map(c => ({
      callDate: c.callDate,
      agentName: c.agentName,
      direction: c.direction,
      durationSeconds: c.durationSeconds,
    })),
  })

  // Sort ASC for callIds (chronological) so logging is predictable;
  // latest is last.
  const callsAsc = [...callsForClaude].sort(
    (a, b) => new Date(a.callDate).getTime() - new Date(b.callDate).getTime(),
  )
  const latest = callsAsc[callsAsc.length - 1]

  return {
    latestCallId: latest.callId,
    latestCallDate: latest.callDate,
    callIds: callsAsc.map(c => c.callId),
    summary: combined,
    formatted,
    callCount: callsAsc.length,
    generatedOnDemand: true,
  }
}

function pickFirst<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null
  return Array.isArray(value) ? (value[0] || null) : value
}
