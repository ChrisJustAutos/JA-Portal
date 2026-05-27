// lib/workshop.ts
//
// Shared types + status model for the portal-native workshop system
// (Phase 1: diary). MYOB is the financial/customer/stock master; the portal
// owns bookings, vehicles + service history, jobs. Tables created in
// migration 031 (workshop_*). All access is server-side via service-role API
// routes gated on view:diary / edit:bookings.

export type BookingStatus =
  | 'prebooked'
  | 'confirmed'
  | 'in_progress'
  | 'awaiting_parts'
  | 'done'
  | 'invoiced'
  | 'cancelled'
  | 'no_show'

export const BOOKING_STATUSES: BookingStatus[] = [
  'prebooked', 'confirmed', 'in_progress', 'awaiting_parts', 'done', 'invoiced', 'cancelled', 'no_show',
]

// Label + colour for diary chips. Colours mirror the portal's T theme palette.
export const BOOKING_STATUS_META: Record<BookingStatus, { label: string; color: string }> = {
  prebooked:      { label: 'Pre-booked',     color: '#8b90a0' }, // text2 / grey
  confirmed:      { label: 'Confirmed',      color: '#4f8ef7' }, // blue
  in_progress:    { label: 'In progress',    color: '#f5a623' }, // amber
  awaiting_parts: { label: 'Awaiting parts', color: '#a78bfa' }, // purple
  done:           { label: 'Done',           color: '#34c77b' }, // green
  invoiced:       { label: 'Invoiced',       color: '#2dd4bf' }, // teal
  cancelled:      { label: 'Cancelled',      color: '#545968' }, // text3
  no_show:        { label: 'No show',        color: '#f04e4e' }, // red
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
