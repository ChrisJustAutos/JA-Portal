// lib/backfill/matcher.ts
// Pure matching logic. Takes parsed orders, quotes, and MD jobs; returns a list of
// match rows suitable for inserting into backfill_matches.

import type { OrderRow, QuoteRow } from './monday'
import { daysBetween, extractJobNumber } from './normalise'
import type { MatchStatus } from './types'

export interface MdJobRow {
  job_number: string
  customer_email_norm: string | null
  customer_phone_norm: string | null
  created_by: string | null
  created_date: string | null  // ISO date
}

export interface MatchPlanRow {
  order_id: string
  order_name: string
  order_date: string | null
  order_status: string | null
  already_linked: boolean
  job_number: string | null
  md_email_norm: string | null
  md_rep: string | null
  match_status: MatchStatus
  matched_quote_id: string | null
  matched_quote_name: string | null
  matched_quote_board_id: string | null
  matched_quote_date: string | null
  matched_quote_status: string | null
  days_before_order: number | null
  alternatives_count: number
}

// Build quote lookup: email_norm → quotes[] (sorted by date desc, empty dates last)
function indexQuotesByEmail(quotes: QuoteRow[]): Map<string, QuoteRow[]> {
  const byEmail = new Map<string, QuoteRow[]>()
  for (const q of quotes) {
    if (!q.email) continue
    const key = q.email.trim().toLowerCase()
    if (!key) continue
    const list = byEmail.get(key)
    if (list) list.push(q)
    else byEmail.set(key, [q])
  }
  // Sort each bucket by date desc (empty last) for deterministic behaviour
  byEmail.forEach((list: QuoteRow[]) => {
    list.sort((a: QuoteRow, b: QuoteRow) => {
      if (!a.date && !b.date) return 0
      if (!a.date) return 1
      if (!b.date) return -1
      return b.date.localeCompare(a.date)
    })
  })
  return byEmail
}

// Choose the best quote from a candidate list for a given order date.
// Preference:
//   1. Closest quote dated BEFORE the order (smallest positive days_before_order)
//   2. If none before, closest quote after the order (least negative days_before)
//   3. If order has no date, the most recent quote
function pickBestQuote(candidates: QuoteRow[], orderDate: string | null): QuoteRow | null {
  if (!candidates.length) return null

  if (!orderDate) {
    // No order date — just take the most recently dated quote (candidates already sorted desc)
    return candidates[0]
  }

  let bestBefore: { quote: QuoteRow; days: number } | null = null
  let bestAfter:  { quote: QuoteRow; days: number } | null = null

  for (const q of candidates) {
    const days = daysBetween(q.date, orderDate)
    if (days === null) continue
    if (days >= 0) {
      // Quote is on-or-before order date
      if (!bestBefore || days < bestBefore.days) bestBefore = { quote: q, days }
    } else {
      // Quote is AFTER order — less preferred
      if (!bestAfter || days > bestAfter.days) bestAfter = { quote: q, days }
    }
  }
  if (bestBefore) return bestBefore.quote
  if (bestAfter) return bestAfter.quote
  // All candidates had no date
  return candidates[0]
}

// Main matcher. Produces a MatchPlanRow for each order.
export function buildMatchPlan(
  orders: OrderRow[],
  quotes: QuoteRow[],
  mdJobs: MdJobRow[],
): MatchPlanRow[] {
  // Index MD jobs by job_number (exact string match, lowercased for safety)
  const mdByJob = new Map<string, MdJobRow>()
  for (const j of mdJobs) {
    if (j.job_number) mdByJob.set(String(j.job_number).trim(), j)
  }

  const quotesByEmail = indexQuotesByEmail(quotes)

  const plan: MatchPlanRow[] = []

  for (const order of orders) {
    // If already linked, record and move on
    if (order.alreadyLinked) {
      plan.push(baseRow(order, {
        job_number: extractJobNumber(order.name).jobNumber,
        match_status: 'already_linked',
      }))
      continue
    }

    const { jobNumber, isInvoice } = extractJobNumber(order.name)

    if (isInvoice) {
      plan.push(baseRow(order, { match_status: 'skipped_invoice' }))
      continue
    }
    if (!jobNumber) {
      plan.push(baseRow(order, { match_status: 'no_job_in_name' }))
      continue
    }

    // Look up MD
    const mdJob = mdByJob.get(jobNumber)
      // Try also without the -subjob suffix
      ?? mdByJob.get(jobNumber.replace(/-\d+$/, ''))

    if (!mdJob) {
      plan.push(baseRow(order, {
        job_number: jobNumber,
        match_status: 'job_not_in_md',
      }))
      continue
    }

    if (!mdJob.customer_email_norm) {
      plan.push(baseRow(order, {
        job_number: jobNumber,
        md_rep: mdJob.created_by,
        match_status: 'no_email_in_md',
      }))
      continue
    }

    // Look up quotes by email
    const candidates = quotesByEmail.get(mdJob.customer_email_norm) ?? []
    if (candidates.length === 0) {
      plan.push(baseRow(order, {
        job_number: jobNumber,
        md_email_norm: mdJob.customer_email_norm,
        md_rep: mdJob.created_by,
        match_status: 'no_quote_for_email',
      }))
      continue
    }

    // Pick best quote
    const best = pickBestQuote(candidates, order.date)
    if (!best) {
      plan.push(baseRow(order, {
        job_number: jobNumber,
        md_email_norm: mdJob.customer_email_norm,
        md_rep: mdJob.created_by,
        match_status: 'no_quote_for_email',
      }))
      continue
    }

    const match_status: MatchStatus = candidates.length > 1 ? 'matched_ambiguous' : 'matched'
    plan.push(baseRow(order, {
      job_number: jobNumber,
      md_email_norm: mdJob.customer_email_norm,
      md_rep: mdJob.created_by,
      match_status,
      matched_quote_id: best.id,
      matched_quote_name: best.name,
      matched_quote_board_id: best.boardId,
      matched_quote_date: best.date,
      matched_quote_status: best.status,
      days_before_order: daysBetween(best.date, order.date),
      alternatives_count: candidates.length - 1,
    }))
  }

  return plan
}

function baseRow(order: OrderRow, overrides: Partial<MatchPlanRow>): MatchPlanRow {
  return {
    order_id: order.id,
    order_name: order.name,
    order_date: order.date,
    order_status: order.status,
    already_linked: order.alreadyLinked,
    job_number: null,
    md_email_norm: null,
    md_rep: null,
    match_status: 'no_job_in_name',  // overridden
    matched_quote_id: null,
    matched_quote_name: null,
    matched_quote_board_id: null,
    matched_quote_date: null,
    matched_quote_status: null,
    days_before_order: null,
    alternatives_count: 0,
    ...overrides,
  }
}
