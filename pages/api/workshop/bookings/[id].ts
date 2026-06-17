// pages/api/workshop/bookings/[id].ts
// GET   — the full job card: the booking (all fields) + customer + vehicle +
//         its line items + the vehicle's prior service history. Gated view:diary.
// PATCH — update a booking (move time, reassign tech/bay, change status, edit
//         details). Gated edit:bookings.

import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../lib/authServer'
import { roleHasPermission } from '../../../../lib/permissions'
import { BOOKING_STATUSES } from '../../../../lib/workshop'

export const config = { maxDuration: 10 }

function sb() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase not configured')
  return createClient(url, key, { auth: { persistSession: false } })
}

const EDITABLE = [
  'starts_at', 'ends_at', 'technician_ext', 'span_techs', 'bay', 'service_type', 'notes', 'customer_id', 'vehicle_id',
  'job_type', 'description', 'internal_notes', 'estimated_value', 'odometer', 'summary', 'is_overdue', 'pickup_at', 'checklist',
  // MechanicDesk-parity job detail fields (migration 121)
  'third_party_customer_id', 'job_types', 'assessed_by', 'estimated_hours', 'estimated_by', 'order_number', 'driver_name', 'driver_phone', 'tags',
] as const

export default withAuth('view:diary', async (req, res, user) => {
  const id = String(req.query.id || '').trim()
  if (!id) return res.status(400).json({ error: 'id required' })
  const db = sb()

  if (req.method === 'GET') {
    const { data: booking, error } = await db
      .from('workshop_bookings')
      .select(`*, customer:workshop_customers(*), vehicle:workshop_vehicles(*)`)
      .eq('id', id)
      .maybeSingle()
    if (error) return res.status(500).json({ error: error.message })
    if (!booking) return res.status(404).json({ error: 'not_found' })

    // Resolve staff names (assessed by / estimated by) + 3rd-party payer for display.
    const staffIds = [ (booking as any).assessed_by, (booking as any).estimated_by ].filter(Boolean)
    if (staffIds.length) {
      const { data: profs } = await db.from('user_profiles').select('id, display_name, email').in('id', staffIds)
      const nameById: Record<string, string> = {}
      for (const p of profs || []) nameById[p.id] = p.display_name || p.email
      ;(booking as any).assessed_by_name = (booking as any).assessed_by ? (nameById[(booking as any).assessed_by] || null) : null
      ;(booking as any).estimated_by_name = (booking as any).estimated_by ? (nameById[(booking as any).estimated_by] || null) : null
    }
    if ((booking as any).third_party_customer_id) {
      const { data: tp } = await db.from('workshop_customers').select('id, name').eq('id', (booking as any).third_party_customer_id).maybeSingle()
      ;(booking as any).third_party_customer = tp || null
    }

    const { data: lines } = await db
      .from('workshop_booking_lines')
      .select('*')
      .eq('booking_id', id)
      .order('sort_order', { ascending: true })

    let history: any[] = []
    if ((booking as any).vehicle_id) {
      const { data: h } = await db
        .from('workshop_bookings')
        .select('id, starts_at, completed_at, status, job_type, description, summary, odometer, total_inc_gst')
        .eq('vehicle_id', (booking as any).vehicle_id)
        .neq('id', id)
        .in('status', ['done', 'invoiced', 'paid'])
        .order('starts_at', { ascending: false })
        .limit(50)
      history = h || []
    }
    return res.status(200).json({ booking, lines: lines || [], history })
  }

  // ── Delete a job (hard delete; lines/payments/time/stock cascade) ──
  if (req.method === 'DELETE') {
    if (!roleHasPermission(user.role, 'edit:bookings')) return res.status(403).json({ error: 'Forbidden — cannot delete jobs' })
    const { data: bk } = await db.from('workshop_bookings').select('id, myob_invoice_uid').eq('id', id).maybeSingle()
    if (!bk) return res.status(404).json({ error: 'not_found' })
    if ((bk as any).myob_invoice_uid) return res.status(409).json({ error: 'This job is finalised to MYOB — un-finalise it first, then delete.', code: 'finalised' })
    const { data: posted } = await db.from('workshop_payments').select('id').eq('booking_id', id).eq('posted_to_myob', true).limit(1)
    if (posted && posted.length) return res.status(409).json({ error: 'This job has a payment posted to MYOB — delete that payment in MYOB first.', code: 'posted_payment' })
    await db.from('workshop_invoices').delete().eq('booking_id', id)   // FK is SET NULL, so remove explicitly
    // Cancel any queued comms (confirmation/reminder/ready/follow-up) for this
    // job — the reminders FK is SET NULL, so a hard delete would otherwise leave
    // them 'pending' and they'd still fire (booking reminder after delete).
    await db.from('workshop_reminders').update({ status: 'cancelled', error: 'booking deleted' }).eq('booking_id', id).eq('status', 'pending')
    const { error: delErr } = await db.from('workshop_bookings').delete().eq('id', id)
    if (delErr) return res.status(500).json({ error: delErr.message })
    try { const { logWorkshopActivity } = await import('../../../../lib/workshop-activity'); await logWorkshopActivity(db, { action: 'deleted', entity: 'booking', entity_id: id, detail: 'Job deleted', actor_id: user.id, actor_name: user.displayName || user.email }) } catch { /* non-fatal */ }
    return res.status(200).json({ ok: true })
  }

  if (req.method !== 'PATCH') {
    res.setHeader('Allow', 'GET, PATCH, DELETE')
    return res.status(405).json({ error: 'GET, PATCH or DELETE only' })
  }
  if (!roleHasPermission(user.role, 'edit:bookings')) return res.status(403).json({ error: 'Forbidden — cannot edit bookings' })

  let body: any = {}
  try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
  catch { return res.status(400).json({ error: 'Bad JSON body' }) }

  const patch: Record<string, any> = { updated_at: new Date().toISOString() }
  for (const f of EDITABLE) {
    if (f in body) patch[f] = body[f] === '' ? null : body[f]
  }
  // Capture the prior status so we can fire follow-ups on the transition into
  // a completed state (rather than every save while already completed).
  let prevStatus: string | null = null
  if ('status' in body) {
    if (!BOOKING_STATUSES.includes(body.status)) return res.status(400).json({ error: 'invalid status' })
    patch.status = body.status
    const { data: prev } = await db.from('workshop_bookings').select('status, completed_at').eq('id', id).maybeSingle()
    prevStatus = prev?.status || null
    // Stamp completed_at the first time it's marked done (drives follow-up timing).
    if (body.status === 'done' && !(prev as any)?.completed_at) patch.completed_at = new Date().toISOString()
  }

  const { error } = await db.from('workshop_bookings').update(patch).eq('id', id)
  if (error) return res.status(500).json({ error: error.message })

  // Job just completed → schedule post-job follow-up comms (best-effort).
  const COMPLETE = ['done', 'invoiced', 'paid']
  if (patch.status && patch.status !== prevStatus && COMPLETE.includes(patch.status) && !COMPLETE.includes(prevStatus || '')) {
    try { const { queueFollowUps } = await import('../../../../lib/workshop-reminders'); await queueFollowUps(id) } catch { /* non-fatal */ }
  }
  return res.status(200).json({ ok: true })
})
