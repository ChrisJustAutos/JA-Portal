// lib/ap-consolidated-suppliers.ts
//
// Suppliers whose monthly "statement" is really ONE consolidated tax invoice
// (e.g. a courier's period invoice listing every consignment as a row).
// For these suppliers:
//   • the statement watcher must NOT reconcile or chase — the rows are
//     consignments on a single bill, not individual invoices that could be
//     missing from MYOB (chasing them emails the supplier about invoice
//     numbers that don't exist); and
//   • AP auto-entry SHOULD treat the document as a normal invoice — its
//     statement-style layout inherently parses at medium confidence, which
//     alone shouldn't block posting.
//
// Comma-separated name patterns via AP_CONSOLIDATED_INVOICE_SUPPLIERS override
// the default list. Matching is case- and whitespace-insensitive and is tried
// against every candidate given (parsed supplier name, sender address …), so
// the "time express" pattern also matches accounts@timeexpresscourier.com.

const DEFAULT_PATTERNS = ['time express']

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
