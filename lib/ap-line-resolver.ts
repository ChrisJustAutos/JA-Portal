// lib/ap-line-resolver.ts
// Smart per-line account resolver for AP invoices.
//
// Two layers:
//   A) Rules    — manual patterns from ap_line_account_rules
//                 Highest priority. Supplier-specific rules outrank globals
//                 at the same priority value.
//   B) History  — learned from past posted bills in ap_line_account_history
//                 Auto-applies when ONE account dominates ≥ HISTORY_STRONG_DOMINANCE
//                 of past usage AND has at least HISTORY_STRONG_MIN_BILLS supporting
//                 bills. Otherwise the top candidate is surfaced as a UI suggestion
//                 (suggested_account_*) for one-click application.
//
// Resolution order: rules first, then history. If neither produces a confident
// answer, the line is left with account_uid=NULL and falls back to the
// invoice-level resolved_account_uid at MYOB-post time.
//
// Safety: lines whose account_source = 'manual' are NEVER overwritten by the
// resolver. Once a human picks an account, that pick is sacred until the human
// explicitly clears it (which sets source back to 'unset').
//
// Hooked into applyTriageAndResolve (lib/ap-supabase.ts) so every re-triage
// pass refreshes line account suggestions, and into createServiceBill
// (lib/ap-myob-bill.ts) on success to learn from each posted bill.

import type { SupabaseClient } from '@supabase/supabase-js'

// ── Confidence thresholds ───────────────────────────────────────────────

// Auto-apply from history requires BOTH:
//   - at least HISTORY_STRONG_MIN_BILLS distinct prior bills supporting the choice
//   - at least HISTORY_STRONG_DOMINANCE share of all past (supplier, desc) bill counts
// Below either threshold, we surface the top candidate as a suggestion only.
const HISTORY_STRONG_MIN_BILLS = 5
const HISTORY_STRONG_DOMINANCE = 0.80

// Skip very-short tokens during fuzzy lookup. Tokens this long or longer
// are used as ilike anchors when no exact-normalised match exists.
const FUZZY_TOKEN_MIN_LEN = 4

// ── Types ───────────────────────────────────────────────────────────────

export type AccountSource =
  | 'unset'             // resolver hasn't picked anything yet
  | 'rule'              // auto-applied from ap_line_account_rules
  | 'history-strong'    // auto-applied from ap_line_account_history
  | 'history-weak'      // suggestion only (in suggested_*); not applied
  | 'manual'            // user explicitly picked
  | 'supplier-default'  // explicitly accepted invoice-level fallback

export interface ResolverInput {
  supplier_uid: string | null
  myob_company_file: string             // 'VPS' | 'JAWS'
  description: string
  part_number: string | null
}

export interface ResolverResult {
  source: AccountSource
  // When set, auto-apply (writes account_uid/code/name on the line)
  account_uid: string | null
  account_code: string | null
  account_name: string | null
  // When set, the UI surfaces a one-click suggestion
  suggested_account_uid: string | null
  suggested_account_code: string | null
  suggested_account_name: string | null
  // Diagnostic / for the UI badge
  rule_id?: string | null
  rule_pattern?: string | null
  history_bill_count?: number | null
  history_total_count?: number | null
}

interface Rule {
  id: string
  supplier_uid: string | null
  pattern: string
  match_type: 'contains' | 'starts_with' | 'exact' | 'regex'
  match_field: 'description' | 'part_number' | 'both'
  case_sensitive: boolean
  account_uid: string
  account_code: string
  account_name: string
  priority: number
  hits: number
}

interface HistoryRow {
  account_uid: string
  account_code: string
  account_name: string
  bill_count: number
}

// ── Public API ──────────────────────────────────────────────────────────

export function normaliseDescription(text: string | null | undefined): string {
  return (text || '').toLowerCase().replace(/\s+/g, ' ').trim()
}

/**
 * Resolve a single line. Pure read — no DB writes.
 *
 * Caller decides whether to apply the result; resolveAllLinesForInvoice
 * is the usual call site, which writes back to ap_invoice_lines and
 * bumps rule hits.
 */
export async function resolveLineAccount(
  c: SupabaseClient,
  input: ResolverInput,
): Promise<ResolverResult> {
  // ── A: rules ──
  const rule = await tryRules(c, input)
  if (rule) {
    return {
      source: 'rule',
      account_uid: rule.account_uid,
      account_code: rule.account_code,
      account_name: rule.account_name,
      suggested_account_uid: null,
      suggested_account_code: null,
      suggested_account_name: null,
      rule_id: rule.id,
      rule_pattern: rule.pattern,
    }
  }

  // ── B: history (only if we have a supplier_uid) ──
  if (input.supplier_uid) {
    const hist = await tryHistory(c, input.supplier_uid, input.description)
    if (hist) {
      const top = hist.top
      const dominance = hist.total > 0 ? top.bill_count / hist.total : 0

      if (top.bill_count >= HISTORY_STRONG_MIN_BILLS && dominance >= HISTORY_STRONG_DOMINANCE) {
        return {
          source: 'history-strong',
          account_uid: top.account_uid,
          account_code: top.account_code,
          account_name: top.account_name,
          suggested_account_uid: null,
          suggested_account_code: null,
          suggested_account_name: null,
          history_bill_count: top.bill_count,
          history_total_count: hist.total,
        }
      }
      // Below threshold but at least one prior bill — suggest, don't apply
      return {
        source: 'history-weak',
        account_uid: null,
        account_code: null,
        account_name: null,
        suggested_account_uid: top.account_uid,
        suggested_account_code: top.account_code,
        suggested_account_name: top.account_name,
        history_bill_count: top.bill_count,
        history_total_count: hist.total,
      }
    }
  }

  // ── Nothing applies ──
  return {
    source: 'unset',
    account_uid: null,
    account_code: null,
    account_name: null,
    suggested_account_uid: null,
    suggested_account_code: null,
    suggested_account_name: null,
  }
}

/**
 * Resolve every line on an invoice and persist results. Skips lines whose
 * account_source = 'manual' to preserve user picks.
 *
 * Returns counts for logging; never throws — individual line failures are
 * swallowed (logged) to avoid breaking the parse pipeline.
 */
export async function resolveAllLinesForInvoice(
  c: SupabaseClient,
  invoiceId: string,
): Promise<{ processed: number; applied: number; suggested: number; skippedManual: number }> {
  const { data: inv } = await c
    .from('ap_invoices')
    .select('resolved_supplier_uid, myob_company_file')
    .eq('id', invoiceId)
    .single()
  if (!inv) {
    return { processed: 0, applied: 0, suggested: 0, skippedManual: 0 }
  }

  const { data: lines } = await c
    .from('ap_invoice_lines')
    .select('id, line_no, description, part_number, account_source')
    .eq('invoice_id', invoiceId)
    .order('line_no', { ascending: true })

  if (!lines || lines.length === 0) {
    return { processed: 0, applied: 0, suggested: 0, skippedManual: 0 }
  }

  let applied = 0
  let suggested = 0
  let skippedManual = 0
  const ruleHits: string[] = []

  for (const line of lines as any[]) {
    if (line.account_source === 'manual') {
      skippedManual++
      continue
    }

    try {
      const r = await resolveLineAccount(c, {
        supplier_uid: inv.resolved_supplier_uid,
        myob_company_file: inv.myob_company_file || 'VPS',
        description: line.description || '',
        part_number: line.part_number,
      })

      const update: Record<string, any> = {
        account_uid:            r.account_uid,
        account_code:           r.account_code,
        account_name:           r.account_name,
        suggested_account_uid:  r.suggested_account_uid,
        suggested_account_code: r.suggested_account_code,
        suggested_account_name: r.suggested_account_name,
        account_source:         r.source,
      }
      await c.from('ap_invoice_lines').update(update).eq('id', line.id)

      if (r.source === 'rule' || r.source === 'history-strong') applied++
      else if (r.source === 'history-weak') suggested++
      if (r.rule_id) ruleHits.push(r.rule_id)
    } catch (e: any) {
      console.error(`resolveAllLinesForInvoice line=${line.id}: ${e?.message}`)
    }
  }

  if (ruleHits.length > 0) {
    void bumpRuleHits(c, ruleHits)
  }

  return { processed: lines.length, applied, suggested, skippedManual }
}

/**
 * Increment hits + last_matched_at on rules. Best-effort; failures are
 * logged but don't propagate. Aggregates counts so a multi-line invoice
 * that fires the same rule N times bumps hits by N.
 */
export async function bumpRuleHits(c: SupabaseClient, ruleIds: string[]): Promise<void> {
  const counts = new Map<string, number>()
  for (const id of ruleIds) counts.set(id, (counts.get(id) || 0) + 1)

  const now = new Date().toISOString()
  for (const [id, n] of Array.from(counts.entries())) {
    try {
      const { data } = await c.from('ap_line_account_rules')
        .select('hits').eq('id', id).maybeSingle()
      const current = (data?.hits as number | undefined) ?? 0
      await c.from('ap_line_account_rules')
        .update({ hits: current + n, last_matched_at: now })
        .eq('id', id)
    } catch (e: any) {
      console.error(`bumpRuleHits id=${id} failed: ${e?.message}`)
    }
  }
}

/**
 * Record a successful MYOB post into ap_line_account_history. Increments
 * bill_count by 1 for each (supplier, normalised desc, account_uid) tuple
 * present on the bill. Lines without a description or account are skipped.
 *
 * Called from createServiceBill on the success path. Best-effort: failures
 * are logged but never propagated, so a history hiccup doesn't fail a post.
 */
export async function recordPostedLineHistory(
  c: SupabaseClient,
  ctx: {
    supplier_uid: string
    supplier_name: string | null
    myob_company_file: string
    lines: Array<{
      description: string
      account_uid: string
      account_code: string
      account_name: string
    }>
  },
): Promise<void> {
  for (const line of ctx.lines) {
    const norm = normaliseDescription(line.description)
    if (!norm || !line.account_uid) continue

    try {
      // Read-then-write — Supabase JS client has no atomic increment.
      const { data: existing } = await c.from('ap_line_account_history')
        .select('id, bill_count')
        .eq('supplier_uid', ctx.supplier_uid)
        .eq('description_normalised', norm)
        .eq('account_uid', line.account_uid)
        .maybeSingle()

      if (existing) {
        await c.from('ap_line_account_history')
          .update({
            bill_count: ((existing.bill_count as number) || 0) + 1,
            last_seen_at: new Date().toISOString(),
            source: 'ja_post',
          })
          .eq('id', existing.id)
      } else {
        await c.from('ap_line_account_history').insert({
          supplier_uid:           ctx.supplier_uid,
          supplier_name:          ctx.supplier_name,
          myob_company_file:      ctx.myob_company_file,
          description_normalised: norm,
          account_uid:            line.account_uid,
          account_code:           line.account_code,
          account_name:           line.account_name,
          bill_count:             1,
          source:                 'ja_post',
        })
      }
    } catch (e: any) {
      console.error(`recordPostedLineHistory desc="${norm}" failed: ${e?.message}`)
    }
  }
}

// ── Internal: rules ─────────────────────────────────────────────────────

async function tryRules(c: SupabaseClient, input: ResolverInput): Promise<Rule | null> {
  // Fetch all rules for this company file. Table is small enough that
  // in-memory filtering is simpler than a complex Postgres OR query.
  const { data: rules } = await c
    .from('ap_line_account_rules')
    .select('id, supplier_uid, pattern, match_type, match_field, case_sensitive, account_uid, account_code, account_name, priority, hits')
    .eq('myob_company_file', input.myob_company_file)
    .order('priority', { ascending: false })

  if (!rules || rules.length === 0) return null

  const applicable = (rules as Rule[]).filter(r =>
    r.supplier_uid === null || r.supplier_uid === input.supplier_uid
  )

  // Sort: priority DESC, supplier-specific before global at same priority
  applicable.sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority
    if (a.supplier_uid && !b.supplier_uid) return -1
    if (!a.supplier_uid && b.supplier_uid) return 1
    return 0
  })

  for (const rule of applicable) {
    if (matchesRule(rule, input.description, input.part_number)) return rule
  }
  return null
}

function matchesRule(rule: Rule, description: string, partNumber: string | null): boolean {
  let candidate = ''
  if (rule.match_field === 'description' || rule.match_field === 'both') {
    candidate += ' ' + (description || '')
  }
  if (rule.match_field === 'part_number' || rule.match_field === 'both') {
    candidate += ' ' + (partNumber || '')
  }
  candidate = candidate.trim()
  if (!candidate) return false

  if (rule.match_type === 'regex') {
    try {
      const re = new RegExp(rule.pattern, rule.case_sensitive ? '' : 'i')
      return re.test(candidate)
    } catch { return false }
  }

  let test = candidate
  let pat = rule.pattern || ''
  if (!rule.case_sensitive) {
    test = test.toLowerCase()
    pat = pat.toLowerCase()
  }

  switch (rule.match_type) {
    case 'exact':       return test === pat
    case 'starts_with': return test.startsWith(pat)
    case 'contains':    return test.includes(pat)
    default:            return false
  }
}

// ── Internal: history ───────────────────────────────────────────────────

async function tryHistory(
  c: SupabaseClient,
  supplierUid: string,
  description: string,
): Promise<{ top: HistoryRow; total: number } | null> {
  const norm = normaliseDescription(description)
  if (!norm) return null

  // 1. Exact match on normalised description (most precise)
  const { data: exact } = await c
    .from('ap_line_account_history')
    .select('account_uid, account_code, account_name, bill_count')
    .eq('supplier_uid', supplierUid)
    .eq('description_normalised', norm)
    .order('bill_count', { ascending: false })
    .limit(20)

  let rows: HistoryRow[] = (exact as HistoryRow[]) || []

  // 2. Fall back to fuzzy: ilike on the longest non-trivial token
  if (rows.length === 0) {
    const tokens = norm.split(/\s+/).filter(t => t.length >= FUZZY_TOKEN_MIN_LEN)
    if (tokens.length === 0) return null
    const longestToken = tokens.sort((a, b) => b.length - a.length)[0]

    // Escape % and _ so user-supplied tokens don't act as wildcards
    const escapedToken = longestToken.replace(/[%_]/g, '\\$&')

    const { data: fuzzy } = await c
      .from('ap_line_account_history')
      .select('account_uid, account_code, account_name, bill_count')
      .eq('supplier_uid', supplierUid)
      .ilike('description_normalised', `%${escapedToken}%`)
      .order('bill_count', { ascending: false })
      .limit(50)

    rows = (fuzzy as HistoryRow[]) || []
  }

  if (rows.length === 0) return null

  // Aggregate across rows (fuzzy may return multiple rows per account)
  const agg = new Map<string, HistoryRow>()
  for (const r of rows) {
    const ex = agg.get(r.account_uid)
    if (ex) ex.bill_count += r.bill_count
    else agg.set(r.account_uid, { ...r })
  }

  const sorted = Array.from(agg.values()).sort((a, b) => b.bill_count - a.bill_count)
  const total = sorted.reduce((s, r) => s + r.bill_count, 0)

  return { top: sorted[0], total }
}
