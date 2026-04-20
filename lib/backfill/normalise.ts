// lib/backfill/normalise.ts
// Small pure functions for normalising emails, phones, and extracting job numbers.

// Normalise email: lowercase, trim, strip trailing dots/whitespace.
// Returns null for empty / invalid.
export function normaliseEmail(raw: string | null | undefined): string | null {
  if (!raw) return null
  const s = String(raw).trim().toLowerCase()
  if (!s || s === 'nan' || s === 'null' || s === 'undefined') return null
  // Basic sanity — must contain @ and a dot
  if (!s.includes('@') || !s.includes('.')) return null
  return s
}

// Normalise AU phone: digits only, strip +61 country code down to a leading 0.
// "0409 626 504" → "0409626504", "+61409626504" → "0409626504"
export function normalisePhone(raw: string | null | undefined): string | null {
  if (!raw) return null
  let s = String(raw).replace(/\D+/g, '')
  if (!s) return null
  if (s.startsWith('61') && s.length >= 10) s = '0' + s.slice(2)
  if (s.length < 8) return null
  return s
}

// Extract the job number from a Monday order name.
// "#20060 Multimapping..." → "20060"
// "#18808-1 Sub-job..."    → "18808-1"  (keeps the sub-job suffix)
// "Invoice 29431 - ..."    → null (Invoice prefix is a special case)
// "19846 3.5" DPF..."      → "19846"   (missing # is still accepted)
export function extractJobNumber(orderName: string): { jobNumber: string | null; isInvoice: boolean } {
  if (!orderName) return { jobNumber: null, isInvoice: false }
  const trimmed = orderName.trim()
  // Invoice / support / merch items — don't match to quotes
  if (/^invoice\s+\d+/i.test(trimmed)) return { jobNumber: null, isInvoice: true }
  if (/^performance\s+estimate\s+#?\d+/i.test(trimmed)) return { jobNumber: null, isInvoice: true }

  // Match # + digits, optionally followed by "-digit" for sub-jobs
  const withHash = trimmed.match(/^#\s*(\d{3,6}(?:-\d+)?)/)
  if (withHash) return { jobNumber: withHash[1], isInvoice: false }

  // Missing # — if name starts with 5 digits followed by space, accept it
  const noHash = trimmed.match(/^(\d{5}(?:-\d+)?)\s/)
  if (noHash) return { jobNumber: noHash[1], isInvoice: false }

  return { jobNumber: null, isInvoice: false }
}

// Compute days between two ISO dates (quote vs order). Positive = quote before order.
// Returns null if either date is missing/invalid.
export function daysBetween(quoteDate: string | null, orderDate: string | null): number | null {
  if (!quoteDate || !orderDate) return null
  const q = new Date(quoteDate).getTime()
  const o = new Date(orderDate).getTime()
  if (isNaN(q) || isNaN(o)) return null
  return Math.round((o - q) / (1000 * 60 * 60 * 24))
}
