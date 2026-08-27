// lib/ap-amount-due-suppliers.ts
//
// Suppliers whose invoice TOTAL is not the amount you actually pay.
//
// Chris, 2026-08-28: "needs to make sure it add in total due for red energy
// its total minus solar credit". A Red Energy electricity bill states the
// period's charges as the total, then applies a solar feed-in credit below it;
// the payable figure is the one after the credit. Posting the stated total
// books a bill for more than is owed, and the payment never reconciles.
//
// This is a CLASS, not one supplier — every energy retailer with a feed-in
// tariff has the same shape, as does anything applying an account credit — so
// it is a pattern list like ap-proforma-suppliers / ap-consolidated-suppliers,
// overridable via AP_AMOUNT_DUE_SUPPLIERS without a deploy.
//
// ⚠ We do NOT do the arithmetic. Subtracting the credit ourselves double-counts
// the moment the extractor nets it off itself, and we cannot know which it did.
// The printed "amount due" on the document is the ground truth, so we read that
// and use it verbatim.

const DEFAULT_PATTERNS = ['red energy', 'redenergy']

/** Is this a supplier whose stated total may not be the payable amount? */
export function amountDueSupplier(...candidates: (string | null | undefined)[]): boolean {
  const raw = (process.env.AP_AMOUNT_DUE_SUPPLIERS || '').trim()
  const patterns = (raw ? raw.split(/[,;]+/) : DEFAULT_PATTERNS)
    .map(p => p.trim().toLowerCase().replace(/\s+/g, ''))
    .filter(Boolean)
  if (patterns.length === 0) return false
  const haystacks = candidates
    .filter(Boolean)
    .map(s => String(s).toLowerCase().replace(/\s+/g, ''))
  return haystacks.some(h => patterns.some(p => h.includes(p)))
}

// ⚠ The sign is the whole point here. A credit balance prints as "-$70.00",
// "$-70.00" or "($70.00)" depending on the retailer, and reading it as +70
// books a bill for money that is owed TO US. Work the sign out from the whole
// token BEFORE stripping: Number() will not see a leading minus once the $
// sits between the minus and the digits.
function money(raw: string): number | null {
  const t = String(raw).trim()
  const firstDigit = t.search(/\d/)
  const prefix = firstDigit < 0 ? t : t.slice(0, firstDigit)
  const negative = prefix.includes('-') || prefix.includes('(')
  const n = Number(t.replace(/[$,()\s-]/g, ''))
  if (!isFinite(n)) return null
  return negative ? -n : n
}

export interface AmountDueRead {
  /** The printed payable figure. */
  amountDue: number
  /** The label it was found under, for the audit note. */
  label: string
  /** A solar/feed-in credit seen on the document, if any — explanation only. */
  creditSeen: number | null
}

// An amount, allowing every sign style seen on utility bills.
const AMT = String.raw`(\(?\s*-?\s*\$?\s*-?[\d,]+\.\d{2}\s*\)?)`

// ⚠ The separator is `:?` and NOT `[:\-]?`. A `-` in that class swallows the
// minus of a negative amount, which turned a $70 CREDIT balance into a $70
// bill in testing — the exact class of error this module exists to prevent.
// Ordered: the most specific wording wins.
const DUE_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: 'total amount due',     re: new RegExp(String.raw`total\s+amount\s+due\s*:?\s*` + AMT, 'i') },
  { label: 'total amount payable', re: new RegExp(String.raw`total\s+amount\s+payable\s*:?\s*` + AMT, 'i') },
  { label: 'amount payable',       re: new RegExp(String.raw`amount\s+payable\s*:?\s*` + AMT, 'i') },
  { label: 'total due',            re: new RegExp(String.raw`total\s+due\s*:?\s*` + AMT, 'i') },
  { label: 'amount due',           re: new RegExp(String.raw`amount\s+due\s*:?\s*` + AMT, 'i') },
  { label: 'new balance',          re: new RegExp(String.raw`new\s+balance\s*:?\s*` + AMT, 'i') },
]

const CREDIT_RE = new RegExp(String.raw`(?:solar|feed[\s-]?in)[^\n]{0,60}?` + AMT, 'i')

/**
 * Read the printed payable amount out of a PDF's text layer.
 * Returns null when the document has no text layer (a scan) or says no such
 * thing — the caller then leaves the extracted total alone.
 */
export function readAmountDue(rawText: string | null | undefined): AmountDueRead | null {
  if (!rawText) return null
  for (const { label, re } of DUE_PATTERNS) {
    const m = re.exec(rawText)
    if (!m) continue
    const amountDue = money(m[1])
    // Zero or negative "due" is a credit balance or a nothing-owing notice, not
    // a bill to post at that figure — leave those to the normal path so a human
    // decides. Posting a credit balance as a payable is the worst outcome here.
    if (amountDue == null || amountDue <= 0) continue
    const cm = CREDIT_RE.exec(rawText)
    const credit = cm ? money(cm[1]) : null
    return { amountDue, label, creditSeen: credit == null ? null : Math.abs(credit) }
  }
  return null
}
