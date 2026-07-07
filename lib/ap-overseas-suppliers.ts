// lib/ap-overseas-suppliers.ts
//
// Regular OVERSEAS suppliers (e.g. Partsouq — Chris 2026-07-08). Their
// invoices carry no Australian GST and use foreign layouts, so the standard
// fact-check flags them every time (subtotal + GST ≠ total). For these
// suppliers, AP auto-entry:
//   • posts GST-FREE (FRE tax code) at the STATED TOTAL as a single line —
//     foreign line-item layouts aren't worth reconciling; and
//   • ONLY auto-posts when the invoice currency is AUD — a USD/AED invoice
//     entered at face value would book the wrong amount, so those flag with
//     a clear foreign-currency reason instead.
//
// Comma-separated name patterns via AP_OVERSEAS_SUPPLIERS override the
// default list. Matching is case- and whitespace-insensitive and is tried
// against every candidate given (parsed supplier name, sender address …).

const DEFAULT_PATTERNS = ['partsouq']

export function overseasSupplier(...candidates: (string | null | undefined)[]): boolean {
  const raw = (process.env.AP_OVERSEAS_SUPPLIERS || '').trim()
  const patterns = (raw ? raw.split(/[,;]+/) : DEFAULT_PATTERNS)
    .map(p => p.trim().toLowerCase().replace(/\s+/g, ''))
    .filter(Boolean)
  const haystacks = candidates
    .filter(Boolean)
    .map(s => String(s).toLowerCase().replace(/\s+/g, ''))
  return haystacks.some(h => patterns.some(p => h.includes(p)))
}
