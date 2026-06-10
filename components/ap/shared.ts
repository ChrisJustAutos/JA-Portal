// components/ap/shared.ts
// Shared types, display helpers and style factories for the AP (supplier
// invoices) module — extracted from pages/ap/[id].tsx so the detail-page
// components under components/ap/ can import them from one place.

import { T } from '../../lib/ui/theme'

// ── Types (AP detail-page shapes) ────────────────────────────────────────

export type AccountSource =
  | 'unset' | 'rule' | 'history-strong' | 'history-weak' | 'manual' | 'supplier-default'

export interface InvoiceRow {
  id: string
  source: string
  email_from: string | null
  email_subject: string | null
  pdf_filename: string | null
  received_at: string
  vendor_name_parsed: string | null
  vendor_abn: string | null
  vendor_email: string | null
  vendor_phone: string | null
  vendor_website: string | null
  vendor_street: string | null
  vendor_city: string | null
  vendor_state: string | null
  vendor_postcode: string | null
  vendor_country: string | null
  invoice_number: string | null
  invoice_date: string | null
  due_date: string | null
  po_number: string | null
  subtotal_ex_gst: number | null
  gst_amount: number | null
  total_inc_gst: number | null
  via_capricorn: boolean
  capricorn_reference: string | null
  capricorn_member_number: string | null
  notes: string | null
  parse_confidence: 'high' | 'medium' | 'low' | null
  resolved_supplier_uid: string | null
  resolved_supplier_name: string | null
  resolved_account_uid: string | null
  resolved_account_code: string | null
  myob_company_file: 'VPS' | 'JAWS'
  triage_status: 'pending' | 'green' | 'yellow' | 'red'
  triage_reasons: string[] | null
  triage_override: 'green' | null
  triage_override_reason: string | null
  triage_override_by: string | null
  triage_override_at: string | null
  status: string
  myob_bill_uid: string | null
  myob_posted_at: string | null
  myob_post_error: string | null
  myob_post_attempts: number | null
  rejection_reason: string | null
  linked_job_number: string | null
  linked_job_match_method: 'auto-po' | 'manual' | null
  linked_job_at: string | null
  po_check_status: 'matched' | 'unmatched' | 'no-po-on-invoice' | null
  payment_account_uid: string | null
  payment_account_code: string | null
  payment_account_name: string | null
  myob_payment_uid: string | null
  myob_payment_applied_at: string | null
  myob_payment_error: string | null
  is_credit_note: boolean
  myob_txn_type: 'bill' | 'spend_money' | null
}

export interface PaymentAccount {
  id: string
  myob_company_file: 'VPS' | 'JAWS'
  label: string
  account_uid: string
  account_code: string
  account_name: string
  is_default_for_capricorn: boolean
  is_active: boolean
  sort_order: number
}

export interface LineRow {
  id: string
  invoice_id: string
  line_no: number
  part_number: string | null
  description: string
  qty: number | null
  uom: string | null
  unit_price_ex_gst: number | null
  line_total_ex_gst: number
  gst_amount: number | null
  tax_code: string
  account_uid: string | null
  account_code: string | null
  account_name: string | null
  account_source: AccountSource | null
  suggested_account_uid: string | null
  suggested_account_code: string | null
  suggested_account_name: string | null
}

export interface JobInfo {
  job_number: string
  customer_name: string | null
  vehicle: string | null
  status: string | null
  opened_date: string | null
  closed_date: string | null
  job_type: string | null
  vehicle_platform: string | null
  estimated_total: number | null
}

export interface MyobSupplier {
  uid: string
  displayId: string | null
  name: string
  abn: string | null
  isIndividual: boolean
}

export interface MyobAccount {
  uid: string
  displayId: string
  name: string
  type: string
  parentName: string | null
  isHeader: boolean
}

export interface HeaderEditable {
  vendor_name_parsed: string
  vendor_abn:         string
  invoice_number:     string
  invoice_date:       string
  po_number:          string
  due_date:           string
  subtotal_ex_gst:    string
  gst_amount:         string
  total_inc_gst:      string
  notes:              string
}

// ── Display helpers ──────────────────────────────────────────────────────

// Display helper for credit-note awareness. The DB always stores monetary
// values as positive magnitudes (subtotal/gst/total/line_total); the
// is_credit_note flag is the sign indicator. Anywhere we surface those
// values to the user we run them through this so a credit note shows
// "-$100" not "$100" — and on save we take Math.abs so the magnitude
// stays in the column. Returns the input untouched when not a credit
// note or when the value is null/non-numeric.
export function signedAmount<T>(v: T, isCreditNote: boolean | null | undefined): T {
  if (!isCreditNote) return v
  if (v == null) return v
  const n = Number(v as any)
  if (!Number.isFinite(n)) return v
  return (-n) as any
}

// Note: NOT the same as lib/ui/format's money2 — this renders null/undefined
// as an em-dash rather than "$0.00", which the AP detail page relies on.
export function fmtMoney(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—'
  return `$${Number(n).toFixed(2)}`
}

// ── Style factories (AP-local looks; not the kit qbtn/pbtn variants) ─────

export function btnPrimary(): React.CSSProperties {
  return {
    background:T.blue, color:'#fff', border:'none',
    padding:'7px 14px', borderRadius:5, fontSize:12, fontWeight:500, fontFamily:'inherit', cursor:'pointer',
  }
}
export function btnSecondary(): React.CSSProperties {
  return {
    background:'transparent', color:T.text2, border:`1px solid ${T.border2}`,
    padding:'7px 12px', borderRadius:5, fontSize:12, fontFamily:'inherit', cursor:'pointer',
  }
}

export function inputStyle(): React.CSSProperties {
  return {
    width:'100%',
    boxSizing:'border-box',
    background: T.bg3, border:`1px solid ${T.border2}`, color: T.text,
    padding:'8px 10px', borderRadius:5,
    fontSize:16, fontFamily:'inherit', outline:'none',
  }
}
