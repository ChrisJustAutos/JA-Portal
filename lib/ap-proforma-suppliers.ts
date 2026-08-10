// lib/ap-proforma-suppliers.ts
//
// Suppliers whose "proforma invoice" / order-confirmation document IS the
// payable bill: they're pay-before-dispatch, no separate tax invoice arrives
// before payment, so the proforma is what accounts pays from and it belongs
// in MYOB. For these suppliers AP auto-entry's quote/estimate guard is
// bypassed (the guard exists because posting a genuine QUOTE books a payable
// for goods never supplied — SCAR 2026-07-28; a pay-on-proforma order
// confirmation is not that).
//
// First member: HD Automotive — their "Details for order #NNNNNN" emails
// carry proforma-invoice-NNNNNN.pdf for CONFIRMED orders; two of them
// ($3,551.90 + $1,617.62) were skipped as quotes on 2026-08-10 (Chris:
// "clearly invoices that should have gone into MYOB").
//
// Comma-separated name patterns via AP_PROFORMA_SUPPLIERS override the
// default list. Matching mirrors ap-consolidated-suppliers: case- and
// whitespace-insensitive, tried against every candidate (parsed supplier
// name, attachment name, sender address …).

const DEFAULT_PATTERNS = ['hd automotive', 'hdautomotive']

export function proformaOkSupplier(...candidates: (string | null | undefined)[]): boolean {
  const raw = (process.env.AP_PROFORMA_SUPPLIERS || '').trim()
  const patterns = (raw ? raw.split(/[,;]+/) : DEFAULT_PATTERNS)
    .map(p => p.trim().toLowerCase().replace(/\s+/g, ''))
    .filter(Boolean)
  const haystacks = candidates
    .filter(Boolean)
    .map(s => String(s).toLowerCase().replace(/\s+/g, ''))
  return haystacks.some(h => patterns.some(p => h.includes(p)))
}
