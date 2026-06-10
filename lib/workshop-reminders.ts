// lib/workshop-reminders.ts
// Workshop SMS reminders queue. queueBookingReminder() schedules a text ahead
// of a booking; processDueReminders() is drained by the cron and sends via
// ClickSend. AUTO sends are gated by workshop_settings.sms_enabled (manual
// "text customer" sends go straight through the /api/workshop/sms route).

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { sendSms } from './clicksend'
import { vehicleLabel, ymdBrisbane, addDaysYmd } from './workshop'

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

interface SmsSettings { sms_enabled: boolean; sms_from: string | null; booking_reminder_lead_hours: number; service_reminder_lead_days: number }
async function smsSettings(): Promise<SmsSettings> {
  const { data } = await sb().from('workshop_settings').select('sms_enabled, sms_from, booking_reminder_lead_hours, service_reminder_lead_days').eq('id', 'singleton').maybeSingle()
  return {
    sms_enabled: data?.sms_enabled ?? false,
    sms_from: data?.sms_from ?? null,
    booking_reminder_lead_hours: data?.booking_reminder_lead_hours ?? 24,
    service_reminder_lead_days: data?.service_reminder_lead_days ?? 14,
  }
}

function bneDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-AU', { timeZone: 'Australia/Brisbane', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true })
}

// Schedule a booking reminder (best-effort; never throws into the caller).
export async function queueBookingReminder(bookingId: string): Promise<void> {
  try {
    const db = sb()
    const { data: b } = await db.from('workshop_bookings')
      .select('id, starts_at, customer_id, vehicle_id, customer:workshop_customers(name, first_name, mobile, phone), vehicle:workshop_vehicles(rego, make, model, year)')
      .eq('id', bookingId).maybeSingle()
    if (!b) return
    const cust: any = Array.isArray(b.customer) ? b.customer[0] : b.customer
    const veh: any = Array.isArray(b.vehicle) ? b.vehicle[0] : b.vehicle
    const number = cust?.mobile || cust?.phone
    if (!number) return

    const cfg = await smsSettings()
    const sendAt = new Date(new Date(b.starts_at).getTime() - cfg.booking_reminder_lead_hours * 3600 * 1000)
    if (sendAt.getTime() <= Date.now()) return // booking too soon for a lead reminder

    // Dedupe: one pending booking reminder per booking.
    const { data: existing } = await db.from('workshop_reminders').select('id').eq('booking_id', bookingId).eq('type', 'booking').eq('status', 'pending').maybeSingle()
    if (existing) return

    const name = cust?.first_name || (cust?.name ? String(cust.name).split(' ')[0] : '') || 'there'
    const veh1 = veh ? vehicleLabel(veh) : 'your vehicle'
    const body = `Hi ${name}, a reminder your ${veh1} is booked in at Just Autos on ${bneDateTime(b.starts_at)}. Please call us if you need to reschedule.`

    await db.from('workshop_reminders').insert({
      type: 'booking', customer_id: b.customer_id || null, vehicle_id: b.vehicle_id || null, booking_id: bookingId,
      to_number: number, body, send_at: sendAt.toISOString(), status: 'pending',
    })
  } catch { /* best-effort */ }
}

function bneDate(ymd: string): string {
  return new Date(`${ymd}T00:00:00+10:00`).toLocaleDateString('en-AU', { timeZone: 'Australia/Brisbane', day: 'numeric', month: 'short', year: 'numeric' })
}

// Queue service-due / rego-due SMS for vehicles whose due date is inside the
// lead window. Dedupe = the *_reminder_sent_for marker column: queue only when
// it differs from the current due date, then stamp it — so editing a due date
// re-arms the reminder and repeat cron runs are no-ops. sms_enabled gates the
// actual send (in processDueReminders), not the queueing.
export interface ServiceDueRunResult { service_queued: number; rego_queued: number }

export async function queueServiceDueReminders(limit = 100): Promise<ServiceDueRunResult> {
  const db = sb()
  const cfg = await smsSettings()
  const cutoff = addDaysYmd(ymdBrisbane(new Date()), cfg.service_reminder_lead_days)

  const KINDS = [
    { col: 'next_service_due_date', marker: 'service_reminder_sent_for', type: 'service_due', what: 'is due for a service' },
    { col: 'rego_due_date',         marker: 'rego_reminder_sent_for',    type: 'rego_due',    what: 'is due for registration renewal' },
  ] as const
  const counts: Record<string, number> = { service_due: 0, rego_due: 0 }

  for (const k of KINDS) {
    const { data: vehicles } = await db.from('workshop_vehicles')
      .select(`id, customer_id, rego, make, model, year, ${k.col}, ${k.marker}, customer:workshop_customers(name, first_name, mobile, phone)`)
      .not(k.col, 'is', null)
      .lte(k.col, cutoff)
      .limit(limit)
    for (const v of (vehicles as any[]) || []) {
      const due = v[k.col]
      if (!due || v[k.marker] === due) continue // already queued for this date
      const cust = Array.isArray(v.customer) ? v.customer[0] : v.customer
      const number = cust?.mobile || cust?.phone
      if (!number) continue
      const name = cust?.first_name || (cust?.name ? String(cust.name).split(' ')[0] : '') || 'there'
      const kmNote = k.type === 'service_due' && v.next_service_due_km ? ` (or by ${Number(v.next_service_due_km).toLocaleString()} km)` : ''
      const body = `Hi ${name}, your ${vehicleLabel(v)} ${k.what} on ${bneDate(due)}${kmNote}. Call Just Autos to book it in.`
      const { error } = await db.from('workshop_reminders').insert({
        type: k.type, customer_id: v.customer_id || null, vehicle_id: v.id, booking_id: null,
        to_number: number, body, send_at: new Date().toISOString(), status: 'pending',
      })
      if (!error) {
        await db.from('workshop_vehicles').update({ [k.marker]: due }).eq('id', v.id)
        counts[k.type]++
      }
    }
  }
  return { service_queued: counts.service_due, rego_queued: counts.rego_due }
}

// Cancel pending due-reminders for a vehicle (called when a due date is cleared).
export async function cancelVehicleDueReminders(vehicleId: string, type: 'service_due' | 'rego_due'): Promise<void> {
  try {
    await sb().from('workshop_reminders').update({ status: 'cancelled' })
      .eq('vehicle_id', vehicleId).eq('type', type).eq('status', 'pending')
  } catch { /* best-effort */ }
}

export interface ReminderRunResult { processed: number; sent: number; failed: number; skipped: string | null }

export async function processDueReminders(limit = 50): Promise<ReminderRunResult> {
  const db = sb()
  const cfg = await smsSettings()
  if (!cfg.sms_enabled) return { processed: 0, sent: 0, failed: 0, skipped: 'sms_disabled' }

  const { data: due } = await db.from('workshop_reminders')
    .select('id, to_number, body, customer_id')
    .eq('status', 'pending')
    .lte('send_at', new Date().toISOString())
    .order('send_at', { ascending: true })
    .limit(limit)

  let sent = 0, failed = 0
  for (const r of due || []) {
    let number = (r as any).to_number
    if (!number && (r as any).customer_id) {
      const { data: c } = await db.from('workshop_customers').select('mobile, phone').eq('id', (r as any).customer_id).maybeSingle()
      number = (c as any)?.mobile || (c as any)?.phone || null
    }
    const result = await sendSms(number, (r as any).body, cfg.sms_from)
    await db.from('workshop_reminders').update({
      status: result.ok ? 'sent' : 'failed',
      clicksend_message_id: result.messageId || null,
      error: result.ok ? null : (result.error || 'send_failed'),
      sent_at: new Date().toISOString(),
    }).eq('id', (r as any).id)
    if (result.ok) sent++; else failed++
  }
  return { processed: (due || []).length, sent, failed, skipped: null }
}
