// lib/workshop-reminders.ts
// Workshop customer comms queue, driven by editable templates
// (workshop_comm_templates). Schedules booking confirmations + reminders,
// service/rego-due notices and post-job follow-ups, on SMS or email, each
// gated by job type + its own timing. processDueReminders() (cron) drains the
// queue. AUTO sends are globally gated by workshop_settings.sms_enabled;
// manual "Text customer" sends go straight through /api/workshop/sms.

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { sendSms } from './clicksend'
import { sendMail } from './email'
import { vehicleLabel, ymdBrisbane, addDaysYmd } from './workshop'
import { CommTemplate, CommTrigger, renderTemplate, offsetMs, templateMatchesJobType, enabledTemplates } from './workshop-comm-templates'

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

interface SmsSettings { sms_enabled: boolean; sms_from: string | null; booking_reminder_lead_hours: number; service_reminder_lead_days: number; business_name: string; review_url: string | null }
async function settings(): Promise<SmsSettings> {
  const { data } = await sb().from('workshop_settings').select('sms_enabled, sms_from, booking_reminder_lead_hours, service_reminder_lead_days, business_name, review_url').eq('id', 'singleton').maybeSingle()
  return {
    sms_enabled: data?.sms_enabled ?? false,
    sms_from: data?.sms_from ?? null,
    booking_reminder_lead_hours: data?.booking_reminder_lead_hours ?? 24,
    service_reminder_lead_days: data?.service_reminder_lead_days ?? 14,
    business_name: data?.business_name || 'Just Autos',
    review_url: data?.review_url || null,
  }
}

const firstName = (c: any) => c?.first_name || (c?.name ? String(c.name).split(' ')[0] : '') || 'there'
function bneDateTime(iso: string) { return new Date(iso).toLocaleString('en-AU', { timeZone: 'Australia/Brisbane', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true }) }
function bneDateOnly(iso: string) { return new Date(iso).toLocaleDateString('en-AU', { timeZone: 'Australia/Brisbane', weekday: 'short', day: 'numeric', month: 'short' }) }
function bneTimeOnly(iso: string) { return new Date(iso).toLocaleTimeString('en-AU', { timeZone: 'Australia/Brisbane', hour: 'numeric', minute: '2-digit', hour12: true }) }
function bneYmd(ymd: string) { return new Date(`${ymd}T00:00:00+10:00`).toLocaleDateString('en-AU', { timeZone: 'Australia/Brisbane', day: 'numeric', month: 'short', year: 'numeric' }) }
const money = (n: number | null | undefined) => n != null ? `$${Number(n).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : ''

// Already queued (pending or sent) for this booking + template? (idempotency)
async function alreadyQueued(db: SupabaseClient, bookingId: string, templateId: string): Promise<boolean> {
  const { data } = await db.from('workshop_reminders').select('id').eq('booking_id', bookingId).eq('template_id', templateId).in('status', ['pending', 'sent']).limit(1)
  return !!(data && data.length)
}

// Insert a queued comm for the resolved channel; skips silently when the
// customer has no contact point for that channel.
async function queueOne(db: SupabaseClient, t: CommTemplate, ctx: {
  type: string; vars: Record<string, string>; number: string | null; email: string | null
  customerId: string | null; vehicleId: string | null; bookingId: string | null; sendAt: Date
}) {
  const to = t.channel === 'email' ? ctx.email : ctx.number
  if (!to) return false
  const { error } = await db.from('workshop_reminders').insert({
    type: ctx.type, channel: t.channel, template_id: t.id,
    customer_id: ctx.customerId, vehicle_id: ctx.vehicleId, booking_id: ctx.bookingId,
    to_number: t.channel === 'sms' ? to : null,
    to_email: t.channel === 'email' ? to : null,
    subject: t.channel === 'email' ? (renderTemplate(t.subject || '', ctx.vars) || `Just Autos — ${t.name}`) : null,
    body: renderTemplate(t.body, ctx.vars),
    send_at: ctx.sendAt.toISOString(), status: 'pending',
  })
  return !error
}

// Build the template variables + contact channels for a booking.
async function bookingContext(db: SupabaseClient, bookingId: string, biz: string, reviewUrl?: string | null) {
  const { data: b } = await db.from('workshop_bookings')
    .select('id, starts_at, completed_at, job_type, total_inc_gst, customer_id, vehicle_id, customer:workshop_customers(name, first_name, email, mobile, phone), vehicle:workshop_vehicles(rego, make, model, year)')
    .eq('id', bookingId).maybeSingle()
  if (!b) return null
  const cust: any = Array.isArray(b.customer) ? b.customer[0] : b.customer
  const veh: any = Array.isArray(b.vehicle) ? b.vehicle[0] : b.vehicle
  const { data: pays } = await db.from('workshop_payments').select('amount').eq('booking_id', bookingId).is('deleted_at', null)
  const paid = (pays || []).reduce((s: number, p: any) => s + (Number(p.amount) || 0), 0)
  const total = Number(b.total_inc_gst) || 0
  const vars: Record<string, string> = {
    first_name: firstName(cust),
    customer_name: cust?.name || '',
    vehicle: veh ? vehicleLabel(veh) : 'your vehicle',
    rego: veh?.rego || '',
    date: bneDateOnly(b.starts_at),
    time: bneTimeOnly(b.starts_at),
    due_date: '',
    business_name: biz,
    total: total ? money(total) : '',
    balance: total ? money(Math.max(0, total - paid)) : '',
    amount: '',
    review_link: reviewUrl || '',
  }
  return {
    booking: b, vars,
    number: cust?.mobile || cust?.phone || null,
    email: cust?.email || null,
    customerId: b.customer_id || null, vehicleId: b.vehicle_id || null,
  }
}

// ── Booking confirmation (immediate) + reminder (before) ─────────────────
// Kept named queueBookingReminder for existing callers (bookings POST/convert).
export async function queueBookingReminder(bookingId: string): Promise<void> {
  try {
    const db = sb()
    const cfg = await settings()
    const ctx = await bookingContext(db, bookingId, cfg.business_name, cfg.review_url)
    if (!ctx) return
    const jobType = (ctx.booking as any).job_type as string | null
    const startMs = new Date((ctx.booking as any).starts_at).getTime()

    for (const trigger of ['booking_confirmation', 'booking_reminder'] as CommTrigger[]) {
      const tmpls = await enabledTemplates(db, trigger)
      for (const t of tmpls) {
        if (!templateMatchesJobType(t, jobType)) continue
        if (await alreadyQueued(db, bookingId, t.id)) continue
        const sendAt = trigger === 'booking_reminder' ? new Date(startMs + offsetMs(t)) : new Date()
        if (trigger === 'booking_reminder' && sendAt.getTime() <= Date.now()) continue  // booking too soon
        await queueOne(db, t, { type: trigger === 'booking_confirmation' ? 'booking_confirmation' : 'booking', vars: ctx.vars, number: ctx.number, email: ctx.email, customerId: ctx.customerId, vehicleId: ctx.vehicleId, bookingId, sendAt })
      }
    }
  } catch { /* best-effort */ }
}

// ── Post-job follow-ups + review requests (after completion, job-type gated) ──
export async function queueFollowUps(bookingId: string): Promise<void> {
  try {
    const db = sb()
    const cfg = await settings()
    const ctx = await bookingContext(db, bookingId, cfg.business_name, cfg.review_url)
    if (!ctx) return
    const jobType = (ctx.booking as any).job_type as string | null
    const anchor = new Date((ctx.booking as any).completed_at || Date.now()).getTime()
    for (const trigger of ['follow_up', 'review_request'] as CommTrigger[]) {
      const tmpls = await enabledTemplates(db, trigger)
      for (const t of tmpls) {
        if (!templateMatchesJobType(t, jobType)) continue
        if (await alreadyQueued(db, bookingId, t.id)) continue
        await queueOne(db, t, { type: trigger, vars: ctx.vars, number: ctx.number, email: ctx.email, customerId: ctx.customerId, vehicleId: ctx.vehicleId, bookingId, sendAt: new Date(anchor + offsetMs(t)) })
      }
    }
  } catch { /* best-effort */ }
}

// ── Payment receipt (immediate, when a payment is recorded) ──────────────
export async function queuePaymentReceipt(bookingId: string, amount: number): Promise<void> {
  try {
    const db = sb()
    const cfg = await settings()
    const ctx = await bookingContext(db, bookingId, cfg.business_name, cfg.review_url)
    if (!ctx) return
    const jobType = (ctx.booking as any).job_type as string | null
    const vars = { ...ctx.vars, amount: amount ? money(amount) : '' }
    const tmpls = await enabledTemplates(db, 'payment_receipt')
    for (const t of tmpls) {
      if (!templateMatchesJobType(t, jobType)) continue
      // One receipt per payment: dedupe on (booking, template) won't allow
      // repeats, so include the amount+time in a synthetic guard via send.
      await queueOne(db, t, { type: 'payment_receipt', vars, number: ctx.number, email: ctx.email, customerId: ctx.customerId, vehicleId: ctx.vehicleId, bookingId, sendAt: new Date() })
    }
  } catch { /* best-effort */ }
}

// ── Quote follow-up (chase unaccepted quotes) ───────────────────────────
async function quoteContext(db: SupabaseClient, quoteId: string, biz: string) {
  const { data: q } = await db.from('workshop_quotes')
    .select('id, status, total, customer_id, vehicle_id, customer:workshop_customers(name, first_name, email, mobile, phone), vehicle:workshop_vehicles(rego, make, model, year)')
    .eq('id', quoteId).maybeSingle()
  if (!q) return null
  const cust: any = Array.isArray(q.customer) ? q.customer[0] : q.customer
  const veh: any = Array.isArray(q.vehicle) ? q.vehicle[0] : q.vehicle
  const vars: Record<string, string> = {
    first_name: firstName(cust), customer_name: cust?.name || '',
    vehicle: veh ? vehicleLabel(veh) : 'your vehicle', rego: veh?.rego || '',
    date: '', time: '', due_date: '', business_name: biz,
    total: Number(q.total) ? money(Number(q.total)) : '', balance: '', amount: '', review_link: '',
  }
  return { quote: q, vars, number: cust?.mobile || cust?.phone || null, email: cust?.email || null, customerId: q.customer_id || null, vehicleId: q.vehicle_id || null }
}

export async function queueQuoteFollowUp(quoteId: string): Promise<void> {
  try {
    const db = sb()
    const cfg = await settings()
    const ctx = await quoteContext(db, quoteId, cfg.business_name)
    if (!ctx) return
    const tmpls = await enabledTemplates(db, 'quote_follow_up')
    for (const t of tmpls) {
      const { data: ex } = await db.from('workshop_reminders').select('id').eq('quote_id', quoteId).eq('template_id', t.id).in('status', ['pending', 'sent']).limit(1)
      if (ex && ex.length) continue
      const to = t.channel === 'email' ? ctx.email : ctx.number
      if (!to) continue
      await db.from('workshop_reminders').insert({
        type: 'quote_follow_up', channel: t.channel, template_id: t.id,
        customer_id: ctx.customerId, vehicle_id: ctx.vehicleId, booking_id: null, quote_id: quoteId,
        to_number: t.channel === 'sms' ? to : null, to_email: t.channel === 'email' ? to : null,
        subject: t.channel === 'email' ? (renderTemplate(t.subject || '', ctx.vars) || `Just Autos — ${t.name}`) : null,
        body: renderTemplate(t.body, ctx.vars), send_at: new Date(Date.now() + offsetMs(t)).toISOString(), status: 'pending',
      })
    }
  } catch { /* best-effort */ }
}

// ── Service-due / rego-due ───────────────────────────────────────────────
export interface ServiceDueRunResult { service_queued: number; rego_queued: number }

export async function queueServiceDueReminders(limit = 100): Promise<ServiceDueRunResult> {
  const db = sb()
  const cfg = await settings()
  const cutoff = addDaysYmd(ymdBrisbane(new Date()), cfg.service_reminder_lead_days)
  const KINDS = [
    { col: 'next_service_due_date', marker: 'service_reminder_sent_for', trigger: 'service_due' as CommTrigger, type: 'service_due' },
    { col: 'rego_due_date',         marker: 'rego_reminder_sent_for',    trigger: 'rego_due' as CommTrigger,    type: 'rego_due' },
  ]
  const counts: Record<string, number> = { service_due: 0, rego_due: 0 }

  for (const k of KINDS) {
    const tmpls = await enabledTemplates(db, k.trigger)
    if (!tmpls.length) continue
    const { data: vehicles } = await db.from('workshop_vehicles')
      .select(`id, customer_id, rego, make, model, year, next_service_due_km, ${k.col}, ${k.marker}, customer:workshop_customers(name, first_name, email, mobile, phone)`)
      .not(k.col, 'is', null).lte(k.col, cutoff).limit(limit)
    for (const v of (vehicles as any[]) || []) {
      const due = v[k.col]
      if (!due || v[k.marker] === due) continue
      const cust = Array.isArray(v.customer) ? v.customer[0] : v.customer
      const number = cust?.mobile || cust?.phone || null
      const email = cust?.email || null
      const kmNote = k.trigger === 'service_due' && v.next_service_due_km ? ` (or by ${Number(v.next_service_due_km).toLocaleString()} km)` : ''
      const vars: Record<string, string> = {
        first_name: firstName(cust), customer_name: cust?.name || '',
        vehicle: vehicleLabel(v), rego: v.rego || '',
        due_date: `${bneYmd(due)}${kmNote}`, business_name: cfg.business_name,
        date: '', time: '', total: '', balance: '',
      }
      let queued = false
      for (const t of tmpls) {
        const to = t.channel === 'email' ? email : number
        if (!to) continue
        const { error } = await db.from('workshop_reminders').insert({
          type: k.type, channel: t.channel, template_id: t.id,
          customer_id: v.customer_id || null, vehicle_id: v.id, booking_id: null,
          to_number: t.channel === 'sms' ? to : null, to_email: t.channel === 'email' ? to : null,
          subject: t.channel === 'email' ? (renderTemplate(t.subject || '', vars) || `Just Autos — ${t.name}`) : null,
          body: renderTemplate(t.body, vars), send_at: new Date().toISOString(), status: 'pending',
        })
        if (!error) queued = true
      }
      if (queued) { await db.from('workshop_vehicles').update({ [k.marker]: due }).eq('id', v.id); counts[k.type]++ }
    }
  }
  return { service_queued: counts.service_due, rego_queued: counts.rego_due }
}

export async function cancelVehicleDueReminders(vehicleId: string, type: 'service_due' | 'rego_due'): Promise<void> {
  try {
    await sb().from('workshop_reminders').update({ status: 'cancelled' })
      .eq('vehicle_id', vehicleId).eq('type', type).eq('status', 'pending')
  } catch { /* best-effort */ }
}

// ── Drain the queue (cron) — SMS via ClickSend, email via Resend ─────────
function textToHtml(text: string): string {
  const esc = String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;line-height:1.6">${esc.replace(/\n/g, '<br>')}</div>`
}

// Minimal .ics for a booking confirmation email so it drops into the
// customer's calendar. ESLint-safe basic VEVENT.
function bookingIcs(start: string, end: string | null, summary: string): string {
  const fmt = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  const s = new Date(start)
  const e = end ? new Date(end) : new Date(s.getTime() + 3600_000)
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Just Autos//Workshop//EN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT', `UID:${fmt(s)}-${Math.abs(start.length)}@justautos.app`, `DTSTAMP:${fmt(new Date())}`,
    `DTSTART:${fmt(s)}`, `DTEND:${fmt(e)}`, `SUMMARY:${summary}`, 'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n')
}

export interface ReminderRunResult { processed: number; sent: number; failed: number; skipped: string | null }

export async function processDueReminders(limit = 50, opts?: { bookingId?: string }): Promise<ReminderRunResult> {
  const db = sb()
  const cfg = await settings()
  if (!cfg.sms_enabled) return { processed: 0, sent: 0, failed: 0, skipped: 'comms_disabled' }

  let q = db.from('workshop_reminders')
    .select('id, type, channel, to_number, to_email, subject, body, customer_id, booking_id, quote_id')
    .eq('status', 'pending').lte('send_at', new Date().toISOString())
    .order('send_at', { ascending: true }).limit(limit)
  if (opts?.bookingId) q = q.eq('booking_id', opts.bookingId)   // instant flush for one booking
  const { data: due } = await q

  let sent = 0, failed = 0
  for (const r of (due as any[]) || []) {
    // Quote follow-ups only chase quotes still awaiting a decision; once the
    // quote is accepted/declined/converted, cancel the pending chase.
    if (r.type === 'quote_follow_up' && r.quote_id) {
      const { data: q } = await db.from('workshop_quotes').select('status').eq('id', r.quote_id).maybeSingle()
      if (!q || q.status !== 'sent') {
        await db.from('workshop_reminders').update({ status: 'cancelled' }).eq('id', r.id)
        continue
      }
    }
    // Booking-bound reminders must still have a live job. If it was deleted, the
    // FK set booking_id to NULL (or the row is gone) — cancel instead of sending
    // (this also cleans up any reminders orphaned by past deletions). Vehicle-
    // bound types (service_due/rego_due) are intentionally excluded — they fire
    // off the vehicle's due dates, not a live booking.
    if (['booking', 'booking_confirmation', 'ready', 'follow_up', 'review_request', 'payment_receipt'].includes(r.type)) {
      let bookingOk = false
      if (r.booking_id) {
        const { data: bk } = await db.from('workshop_bookings').select('id').eq('id', r.booking_id).maybeSingle()
        bookingOk = !!bk
      }
      if (!bookingOk) {
        await db.from('workshop_reminders').update({ status: 'cancelled', error: 'booking deleted' }).eq('id', r.id)
        continue
      }
    }
    let ok = false, errMsg: string | null = null, msgId: string | null = null
    try {
      if (r.channel === 'email') {
        const to = r.to_email
        if (!to) { errMsg = 'no_email' }
        else {
          // Attach a calendar invite to booking-confirmation emails.
          let attachments: { name: string; contentType: string; content: Buffer }[] | undefined
          if (r.type === 'booking_confirmation' && r.booking_id) {
            const { data: bk } = await db.from('workshop_bookings').select('starts_at, ends_at').eq('id', r.booking_id).maybeSingle()
            if (bk?.starts_at) attachments = [{ name: 'booking.ics', contentType: 'text/calendar', content: Buffer.from(bookingIcs(bk.starts_at, bk.ends_at, cfg.business_name + ' booking')) }]
          }
          await sendMail('noreply@mail.justautos.app', { to: [to], subject: r.subject || 'A message from Just Autos', html: textToHtml(r.body), attachments })
          ok = true
        }
      } else {
        let number = r.to_number
        if (!number && r.customer_id) {
          const { data: c } = await db.from('workshop_customers').select('mobile, phone').eq('id', r.customer_id).maybeSingle()
          number = (c as any)?.mobile || (c as any)?.phone || null
        }
        const result = await sendSms(number, r.body, cfg.sms_from)
        ok = result.ok; errMsg = result.ok ? null : (result.error || 'send_failed'); msgId = result.messageId || null
      }
    } catch (e: any) { errMsg = e?.message || 'send_error' }
    await db.from('workshop_reminders').update({
      status: ok ? 'sent' : 'failed', clicksend_message_id: msgId, error: errMsg, sent_at: new Date().toISOString(),
    }).eq('id', r.id)
    if (ok) sent++; else failed++
  }
  return { processed: (due || []).length, sent, failed, skipped: null }
}
