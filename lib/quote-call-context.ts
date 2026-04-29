// lib/quote-call-context.ts
// Shared call-summary lookup. Used by:
//   - Pipeline A (quote ingestion): attach the most-recent call context to the
//     AC deal note when a quote PDF arrives.
//   - Pipeline B (Monday "Fetch Call Notes" button): post the most-recent call
//     summary as a Monday update on the clicked item.
//
// Logic:
//   1. Normalise input phone (multiple variants — the SQL column normalises
//      differently to lib/monday-followup.ts, so we cast a wide net).
//   2. Find the most recent call_analysis row within 30 days where the
//      generated calls.external_number_normalised matches any variant.
//   3. Return structured fields + a pre-rendered text block ready to drop
//      into a Monday update or AC deal note.
//
// Best-effort. Returns null if no analysed call exists within 30 days, the
// phone fails to normalise, or follow_up_summary is null on the matched row.
// Pipelines A and B both proceed without context in the null case.

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { normalisePhone } from './monday-followup'
import { renderSummaryAsNote, FollowUpSummary } from './anthropic-followup'

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
  // Same format as the existing follow-up-sync pipeline uses, so reps see
  // a consistent layout regardless of where the note appears.
  formatted: string
}

// ── Server-side Supabase client ─────────────────────────────────────────
// Inline construction matches the pattern in pages/api/cron/sync-followups.ts.
// We don't share a singleton because Next.js serverless functions are cold-
// boot fresh and a module-level client can outlive its env (e.g. on key
// rotation). Build per-call; trivially cheap.
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
//   "411222333"      → "411222333"       (no leading 0; left as-is by SQL)
//   "+1 646 912 8383"→ "16469128383"     (US number; + stripped, no AU rule)
//
// The TS normalisePhone in monday-followup.ts produces:
//   "+61411222333"   → "411222333"       (strips +61 AND leading 0)
//   "0411 222 333"   → "411222333"
//
// Because reps and PDFs use both formats interchangeably, query against any
// variant the column might hold.
function buildPhoneVariants(rawPhone: string): string[] {
  const stripped = rawPhone.replace(/\s+/g, '').trim()
  const tsNorm = normalisePhone(stripped)            // "411222333"
  if (!tsNorm) return []

  const variants = new Set<string>()
  variants.add(`0${tsNorm}`)        // "0411222333" — SQL output for +61... and 0... inputs
  variants.add(tsNorm)              // "411222333"  — SQL output if input had no leading 0/+61
  variants.add(stripped)            // raw stripped — covers anything we didn't anticipate

  // Strip leading + from raw if present (covers non-AU numbers like +1...
  // where SQL column ends up as e.g. "16469128383")
  if (stripped.startsWith('+')) {
    variants.add(stripped.substring(1))
  }

  return Array.from(variants).filter(Boolean)
}

// ── Validate summary shape (defensive) ──────────────────────────────────
// We're trusting jsonb data written by another pipeline. If the shape ever
// drifts, fail silently rather than poison Pipeline A or B with a crash.
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
 * Look up the most recent analysed call summary for a phone number.
 *
 * @param rawPhone Phone number in any common format. Quote PDFs typically
 *                 have it as "0412 345 678" or "+61 412 345 678"; Monday
 *                 buttons pass whatever's in the phone column.
 * @returns        Structured + pre-formatted context, or null if no
 *                 matching analysed call within the last 30 days.
 */
export async function getQuoteCallContext(rawPhone: string | null | undefined): Promise<QuoteCallContext | null> {
  if (!rawPhone || !rawPhone.trim()) return null

  const variants = buildPhoneVariants(rawPhone)
  if (variants.length === 0) return null

  const sb = getServiceClient()
  const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString()

  // Most recent call within window matching any phone variant, with a
  // non-null follow_up_summary. We explicitly do NOT fall back to the
  // coaching `summary` field per design decision 2026-04-29 — coaching
  // notes must never leak into customer-facing surfaces.
  const { data, error } = await sb
    .from('calls')
    .select(`
      id,
      call_date,
      duration_seconds,
      external_number_normalised,
      effective_advisor_name,
      agent_name,
      call_analysis!inner(
        id,
        outcome,
        follow_up_summary
      )
    `)
    .in('external_number_normalised', variants)
    .gte('call_date', since)
    .not('call_analysis.follow_up_summary', 'is', null)
    .order('call_date', { ascending: false })
    .limit(1)

  if (error) {
    // Don't crash the calling pipeline; log and return null. Both pipelines
    // are designed to proceed without call context.
    console.warn('[quote-call-context] Supabase query failed:', error.message)
    return null
  }

  if (!data || data.length === 0) return null
  const row: any = data[0]

  // call_analysis comes back as an array because of the !inner join.
  const analysis = Array.isArray(row.call_analysis) ? row.call_analysis[0] : row.call_analysis
  if (!analysis) return null

  const rawSummary = analysis.follow_up_summary
  if (!isValidSummary(rawSummary)) {
    console.warn('[quote-call-context] follow_up_summary failed shape validation for call_id=', row.id)
    return null
  }

  const agentName = row.effective_advisor_name || row.agent_name || null

  const formatted = renderSummaryAsNote(rawSummary, {
    agentName: agentName || undefined,
    callDate: row.call_date,
    durationSec: row.duration_seconds || undefined,
  })

  return {
    callId: row.id,
    calledAt: row.call_date,
    durationSeconds: row.duration_seconds || 0,
    outcome: analysis.outcome || null,
    agentName,
    summary: rawSummary,
    formatted,
  }
}

// ── TODO — phone normalisation cleanup ──────────────────────────────────
// Currently the TS normaliser (monday-followup.ts) and the SQL generated
// column (calls.external_number_normalised) emit different shapes for the
// same input. We work around it with buildPhoneVariants above.
//
// Better: extract a single normalise() into lib/phone.ts whose TS output
// EXACTLY matches a SQL function that the generated column calls. Then
// queries become a single equality test, not an IN over variants.
//
// Not blocking: the variant approach hits the index just as fast (Postgres
// uses bitmap or for IN with <10 values), so this is purely a code-clarity
// concern. Punt to a follow-up PR after Pipelines A and B are live.
