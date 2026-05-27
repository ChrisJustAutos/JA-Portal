// lib/workshop.ts
//
// Shared types + status model for the portal-native workshop system
// (Phase 1: diary). MYOB is the financial/customer/stock master; the portal
// owns bookings, vehicles + service history, jobs. Tables created in
// migration 031 (workshop_*). All access is server-side via service-role API
// routes gated on view:diary / edit:bookings.

// The MYOB company file the workshop integrates with. The workshop/mechanical
// business is "Vehicle Performance Solutions" (VPS) — NOT the wholesale file
// (JAWS). Customer/inventory sync + job invoices all use this connection label.
export const WORKSHOP_MYOB_LABEL = 'VPS'

// Job status flow — reconciled with the autodesk_pro prototype
// (booking → in_progress → invoiced → paid), plus diary-side states.
export type BookingStatus =
  | 'prebooked'
  | 'booking'
  | 'confirmed'
  | 'in_progress'
  | 'awaiting_parts'
  | 'ready'
  | 'done'
  | 'invoiced'
  | 'paid'
  | 'cancelled'
  | 'no_show'

export const BOOKING_STATUSES: BookingStatus[] = [
  'prebooked', 'booking', 'confirmed', 'in_progress', 'awaiting_parts', 'ready', 'done', 'invoiced', 'paid', 'cancelled', 'no_show',
]

// Label + colour for diary chips. Colours mirror the portal's T theme palette.
export const BOOKING_STATUS_META: Record<BookingStatus, { label: string; color: string }> = {
  prebooked:      { label: 'Pre-booked',     color: '#8b90a0' },
  booking:        { label: 'Booked',         color: '#8b90a0' },
  confirmed:      { label: 'Confirmed',      color: '#4f8ef7' },
  in_progress:    { label: 'In progress',    color: '#f5a623' },
  awaiting_parts: { label: 'Awaiting parts', color: '#a78bfa' },
  ready:          { label: 'Ready',          color: '#2dd4bf' },
  done:           { label: 'Done',           color: '#34c77b' },
  invoiced:       { label: 'Invoiced',       color: '#2dd4bf' },
  paid:           { label: 'Paid',           color: '#34c77b' },
  cancelled:      { label: 'Cancelled',      color: '#545968' },
  no_show:        { label: 'No show',        color: '#f04e4e' },
}

// Job types — curated common set. The prototype shipped a large job-type
// catalogue (assets/job_type_data) importable as seed data later; job_type is
// a free-text column so this list just drives the picker default.
export type JobTypeOption = { value: string; label: string }
export const JOB_TYPES: JobTypeOption[] = [
  { value: 'general_service',     label: 'General Service' },
  { value: 'logbook_service',     label: 'Logbook Service' },
  { value: 'brakes',              label: 'Brakes' },
  { value: 'tyres',               label: 'Tyres / Wheels' },
  { value: 'suspension',          label: 'Suspension / Steering' },
  { value: 'diagnostic',          label: 'Diagnostic' },
  { value: 'electrical',          label: 'Electrical' },
  { value: 'air_conditioning',    label: 'Air Conditioning' },
  { value: 'clutch_transmission', label: 'Clutch / Transmission' },
  { value: 'engine',              label: 'Engine' },
  { value: 'roadworthy',          label: 'Roadworthy / Inspection' },
  { value: 'repair',              label: 'General Repair' },
  { value: 'warranty',            label: 'Warranty' },
  { value: 'other',               label: 'Other' },
]
export function jobTypeLabel(v: string | null | undefined): string {
  if (!v) return ''
  return JOB_TYPES.find(j => j.value === v)?.label || v
}

// ── Quotes ──────────────────────────────────────────────────────────────
export type QuoteStatus = 'pending' | 'sent' | 'accepted' | 'declined' | 'expired' | 'converted'
export const QUOTE_STATUSES: QuoteStatus[] = ['pending', 'sent', 'accepted', 'declined', 'expired', 'converted']
export const QUOTE_STATUS_META: Record<QuoteStatus, { label: string; color: string }> = {
  pending:   { label: 'Pending',   color: '#8b90a0' },
  sent:      { label: 'Sent',      color: '#4f8ef7' },
  accepted:  { label: 'Accepted',  color: '#34c77b' },
  declined:  { label: 'Declined',  color: '#f04e4e' },
  expired:   { label: 'Expired',   color: '#545968' },
  converted: { label: 'Converted', color: '#2dd4bf' },
}

export interface WorkshopCustomer {
  id: string
  myob_uid: string | null
  name: string
  first_name: string | null
  last_name: string | null
  phone: string | null
  mobile: string | null
  email: string | null
  address: string | null
  notes: string | null
}

export interface WorkshopVehicle {
  id: string
  customer_id: string | null
  rego: string | null
  make: string | null
  model: string | null
  year: number | null
  vin: string | null
  colour: string | null
  engine: string | null
  transmission: string | null
  odometer: number | null
  notes: string | null
}

export interface WorkshopBooking {
  id: string
  customer_id: string | null
  vehicle_id: string | null
  starts_at: string
  ends_at: string
  technician_ext: string | null
  bay: string | null
  service_type: string | null
  status: BookingStatus
  notes: string | null
  created_by: string | null
  // Unified job fields (autodesk_pro Jobs model):
  job_type?: string | null
  description?: string | null
  internal_notes?: string | null
  estimated_value?: number | null
  span_techs?: string | null            // comma-separated extra technician exts
  is_overdue?: boolean
  odometer?: number | null
  summary?: string | null
  myob_invoice_uid?: string | null
  total_ex_gst?: number | null
  total_inc_gst?: number | null
  completed_at?: string | null
  // Joined for display (filled by the bookings API):
  customer?: Pick<WorkshopCustomer, 'id' | 'name' | 'phone' | 'mobile'> | null
  vehicle?: Pick<WorkshopVehicle, 'id' | 'rego' | 'make' | 'model' | 'year'> | null
}

// ── Display helpers ─────────────────────────────────────────────────────
export function vehicleLabel(v?: Partial<WorkshopVehicle> | null): string {
  if (!v) return ''
  const desc = [v.year, v.make, v.model].filter(Boolean).join(' ')
  const rego = v.rego ? v.rego.toUpperCase() : ''
  if (desc && rego) return `${rego} — ${desc}`
  return rego || desc || 'Vehicle'
}

export function customerLabel(c?: Partial<WorkshopCustomer> | null): string {
  if (!c) return ''
  return c.name || [c.first_name, c.last_name].filter(Boolean).join(' ') || 'Customer'
}

export function bookingDurationMin(b: Pick<WorkshopBooking, 'starts_at' | 'ends_at'>): number {
  const s = new Date(b.starts_at).getTime()
  const e = new Date(b.ends_at).getTime()
  return Math.max(0, Math.round((e - s) / 60000))
}

// ── Diary date helpers (Brisbane, UTC+10, no DST) — mirrors pages/calls.tsx ──
const BNE_OFFSET_MS = 10 * 3600 * 1000

export function ymdBrisbane(d: Date): string {
  return new Date(d.getTime() + BNE_OFFSET_MS).toISOString().slice(0, 10)
}

// Start/end of a Brisbane calendar day, returned as UTC ISO bounds for querying.
export function brisbaneDayBounds(ymd: string): { fromIso: string; toIso: string } {
  // ymd is a Brisbane date; its 00:00 Brisbane = (ymd)T00:00+10:00.
  const from = new Date(`${ymd}T00:00:00+10:00`)
  const to = new Date(from.getTime() + 24 * 3600 * 1000)
  return { fromIso: from.toISOString(), toIso: to.toISOString() }
}

export function addDaysYmd(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00+10:00`)
  d.setUTCDate(d.getUTCDate() + days)
  return ymdBrisbane(d)
}

// Monday-start week containing the given Brisbane ymd.
export function weekStartYmd(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00+10:00`)
  const dow = (d.getUTCDay() + 6) % 7 // 0 = Monday
  return addDaysYmd(ymd, -dow)
}
