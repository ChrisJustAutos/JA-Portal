// lib/quote-call-context.ts
// Shared call-summary lookup. Used by:
//   - Pipeline A (quote ingestion): attach the most-recent call context to the
//     AC deal note when a quote PDF arrives. Read-only.
//   - Pipeline B (Monday "Fetch Call Notes" button): post the most-recent call
//     summary as a Monday update on the clicked item. Generates on-demand
//     if a transcript exists but no follow_up_summary has been produced yet
//     (the proactive sync cron has a backlog).
//
// LOGIC:
//   1. Normalise input phone (multiple variants — see buildPhoneVariants).
//   2. Find the most recent call within 30 days that matches a phone variant.
//   3. Branch on what's available:
//        a. follow_up_summary present → return it (LOOKUP HIT)
//        b. follow_up_summary missing AND transcript exists AND
//           generateOnDemand=true → call Claude, persist result, return it
//        c. neither → return null
//
// Best-effort. Pipelines A and B both proceed gracefully on null.
//
// COST NOTE: generate-on-demand fires the same Anthropic API call the
// proactive cron uses (~$0.01–0.03 per call with Haiku 4.5). Only Pipeline B
// triggers it (rep-initiated, low volume). Pipeline A passes generateOnDemand=false.

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { normalisePhone } from './monday-followup'
import {
  renderSummaryAsNote,
  generateFollowUpSummary,
  FollowUpSummary,
} from './anthropic-followup'

const LOOKBACK_DAYS = 30

export interface QuoteCallContext {
  // The matched call
  callId: string
  calledAt: string                  // ISO timestamp (UTC, as stored)
  durationSeconds: number
  outcome: string | null            // sale / quote_given / wrong_number / etc
  agentName: string | null

  // The structured follow-up summary (validated shape)
  summary: FollowUpSummary

  // Pre-rendered text — ready to post as a Monday update or AC deal note.
  formatted: string

  // True when this summary was just generated on-demand (vs. read from cache).
  // Useful for telemetry — the endpoint can log generated_on_demand=true to
  // quote_events so we can see how often the cron is missing things.
  generatedOnDemand: boolean
}

export interface GetContextOptions {
  // When true, missing follow_up_summary triggers a Claude API call to
  // generate one, which is then persisted to call_analysis. Pipeline B
  // sets this true. Pipeline A keeps it false.
  generateOnDemand?: boolean
}

// ── Server-side Supabase client ─────────────────────────────────────────
function getServiceClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw new Error('Supabase env vars not configured (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)')
  }
  return createClient(url, key, { auth: { persistSession: false } })
}

// ── Phone variant generation ────────────────────────────────────────────
// The SQL normalised column produces (e.g.):
//   "+61411222333"   → "0411222333"      (61 → 0)
//   "0411 222 333"   → "0411222333"      (whitespace stripped)
// The TS normalisePhone in monday-followup.ts strips leading 0 too:
//   "0411 222 333"   → "411222333"
// Cast a wide net to bridge the two normalisers.
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

// ── Validate summary shape (defensive) ──────────────────────────────────
function isValidSummary(raw: any): raw is FollowUpSummary {
  if (!raw || typeof raw !== 'object') return false
  const fields = ['who_what', 'discussed', 'objections', 'commitments', 'next_step', 'sentiment']
  for (const f of fields) {
    if (typeof raw[f] !== 'string' || !raw[f].trim()) return false
  }
  if (!['hot', 'warm', 'cold'].includes(raw.sentiment)) return false
  return true
}

// ── Public entry point ──────────────────────────────────────────────────

/**
 * Look up (and optionally generate) the most recent call summary for a phone.
 *
 * @param rawPhone Phone number in any common format.
 * @param options  generateOnDemand: true to fire Claude API when missing.
 * @returns        Structured + pre-formatted context, or null if no
 *                 matching call within the last 30 days, or no transcript
 *                 to generate from.
 */
export async function getQuoteCallContext(
  rawPhone: string | null | undefined,
  options: GetContextOptions = {},
): Promise<QuoteCallContext | null> {
  if (!rawPhone || !rawPhone.trim()) return null

  const variants = buildPhoneVariants(rawPhone)
  if (variants.length === 0) return null

  const sb = getServiceClient()
  const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString()

  // We want the most recent call regardless of analysis state (so that
  // generate-on-demand can fall back to a transcript). The previous version
  // used !inner+filter on follow_up_summary, which excluded calls that
  // could be summarised on demand. Now: pull the latest matching call,
  // join analysis + transcript, and branch in code.
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
      call_transcripts(full_text),
      call_analysis(
        id,
        outcome,
        follow_up_summary
      )
    `)
    .in('external_number_normalised', variants)
    .gte('call_date', since)
    .order('call_date', { ascending: false })
    .limit(1)

  if (error) {
    console.warn('[quote-call-context] Supabase query failed:', error.message)
    return null
  }
  if (!data || data.length === 0) return null

  const row: any = data[0]
  const analysis = pickFirst(row.call_analysis)
  const transcript = pickFirst(row.call_transcripts)
  const agentName = row.effective_advisor_name || row.agent_name || null

  // ── Branch A: existing valid follow_up_summary → return it ─────────
  if (analysis && isValidSummary(analysis.follow_up_summary)) {
    return buildContext(row, analysis, analysis.follow_up_summary, agentName, false)
  }

  // ── Branch B: generate on demand if allowed and possible ───────────
  if (options.generateOnDemand && analysis && transcript?.full_text) {
    try {
      const gen = await generateFollowUpSummary(transcript.full_text, {
        direction: row.direction,
        agent_name: agentName,
        caller_name: row.caller_name,
        external_number: row.external_number,
        duration_seconds: row.duration_seconds || 0,
        call_date: row.call_date,
      })

      // Persist back so future lookups hit the cache. Match the columns
      // sync-followups.ts writes for consistency.
      const { error: updErr } = await sb
        .from('call_analysis')
        .update({
          follow_up_summary: gen.summary,
          follow_up_generated_at: new Date().toISOString(),
          follow_up_model: gen.model,
        })
        .eq('id', analysis.id)

      if (updErr) {
        // Persist failed but we still have the summary in memory; surface
        // it to the rep and log the persist failure — they don't care if
        // it was saved, they just want the notes.
        console.warn('[quote-call-context] follow_up_summary persist failed (returning anyway):', updErr.message)
      }

      return buildContext(row, analysis, gen.summary, agentName, true)
    } catch (e: any) {
      // Claude API call failed — fall through to null. Caller (the endpoint)
      // will post the "no analysed call" message. Better than throwing.
      console.warn('[quote-call-context] on-demand generation failed:', e?.message || e)
      return null
    }
  }

  // ── Branch C: nothing to surface ───────────────────────────────────
  // Either no analysis row, no transcript, or generateOnDemand=false.
  return null
}

// ── Helpers ─────────────────────────────────────────────────────────────

function pickFirst<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null
  return Array.isArray(value) ? (value[0] || null) : value
}

function buildContext(
  row: any,
  analysis: any,
  summary: FollowUpSummary,
  agentName: string | null,
  generatedOnDemand: boolean,
): QuoteCallContext {
  return {
    callId: row.id,
    calledAt: row.call_date,
    durationSeconds: row.duration_seconds || 0,
    outcome: analysis?.outcome || null,
    agentName,
    summary,
    formatted: renderSummaryAsNote(summary, {
      agentName: agentName || undefined,
      callDate: row.call_date,
      durationSec: row.duration_seconds || undefined,
    }),
    generatedOnDemand,
  }
}

// ── TODO — phone normalisation cleanup (unchanged) ─────────────────────
// Extract a single normalise() into lib/phone.ts whose TS output exactly
// matches the SQL generated column. Variant-list approach is fine for now.
