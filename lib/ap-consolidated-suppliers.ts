// lib/ap-consolidated-suppliers.ts
//
// Suppliers whose monthly "statement" is really ONE consolidated tax invoice
// (e.g. a courier's period invoice listing every consignment as a row).
// For these suppliers:
//   • the statement watcher must NOT reconcile or chase — the rows are
//     consignments on a single bill, not individual invoices that could be
//     missing from MYOB (chasing them emails the supplier about invoice
//     numbers that don't exist); and
//   • AP auto-entry SHOULD enter the document as a normal invoice, billed at
//     the STATED TOTAL as a single line ("post with total amount on statement,
//     disregard credits" — Chris 2026-07-06): the statement-style layout
//     parses at medium confidence and its rows needn't sum to the total, so
//     neither blocks posting.
//
// Comma-separated name patterns via AP_CONSOLIDATED_INVOICE_SUPPLIERS override
// the default list. Matching is case- and whitespace-insensitive and is tried
// against every candidate given (parsed supplier name, sender address …), so
// the "time express" pattern also matches accounts@timeexpresscourier.com.

// 'supagas': their monthly "INVOICE STATEMENT-…" PDF IS the EOM tax invoice
// (confirmed Chris 2026-08-05 after the 31 JUL one was skipped_not_invoice).
//
// 'boc.com': BOC bill once, at end of month, and their notification subject is
// "Your BOC/SPW Invoice or Statement is here" — the word "Statement" in that
// subject vetoed the document on 2026-08-31 (skipped_not_invoice, nothing
// entered), while July's, subject "Invoice", posted fine at $45.35. Chris
// 2026-09-01: "They only send an invoice at the end of the month, so it should
// be entered."
//
// ⚠ Matched on the SENDER DOMAIN, not the name. Matching is a plain substring,
// so a bare 'boc' would fire on any address or vendor containing those three
// letters. The trade-off: a BOC invoice FORWARDED by a staff member (sender no
// longer boc.com) whose subject still says "Statement" would be skipped again.
// Add the exact vendor-name pattern if that shows up — the extractor's name is
// what to match, and it needs to be seen before it can be trusted.
const DEFAULT_PATTERNS = ['time express', 'supagas', 'boc.com']

export function consolidatedInvoiceSupplier(...candidates: (string | null | undefined)[]): boolean {
  const raw = (process.env.AP_CONSOLIDATED_INVOICE_SUPPLIERS || '').trim()
  const patterns = (raw ? raw.split(/[,;]+/) : DEFAULT_PATTERNS)
    .map(p => p.trim().toLowerCase().replace(/\s+/g, ''))
    .filter(Boolean)
  const haystacks = candidates
    .filter(Boolean)
    .map(s => String(s).toLowerCase().replace(/\s+/g, ''))
  return haystacks.some(h => patterns.some(p => h.includes(p)))
}
