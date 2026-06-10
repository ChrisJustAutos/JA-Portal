// pages/api/workshop/time-entries.ts
// Tech clock-on / clock-off per job.
//   GET    ?booking_id=                 — entries + total minutes + open clocks
//   POST   {booking_id, technician_code}                 — clock ON (409 if already on)
//   POST   {booking_id, technician_code, action:'stop'}  — clock OFF (job-card friendly)
//   PATCH  {id, action:'stop'} | {id, minutes}           — stop by id / manual fix
//   DELETE ?id=                                          — remove a mistaken entry
// Clock-on also nudges the booking to in_progress if it's still sitting at a
// pre-work status.

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../lib/authServer'
import { roleHasPermission } from '../../../lib/permissions'
import { logWorkshopActivity } from '../../../lib/workshop-activity'

export const config = { maxDuration: 10 }

function sb(): SupabaseClient {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  )
}

const minutesBetween = (a: string, b: Date) => Math.max(1, Math.round((b.getTime() - new Date(a).getTime()) / 60000))

async function stopEntry(db: SupabaseClient, entry: any, user: any) {
  const now = new Date()
  const minutes = minutesBetween(entry.started_at, now)
  const { error } = await db.from('workshop_time_entries')
    .update({ ended_at: now.toISOString(), minutes }).eq('id', entry.id)
  if (error) throw new Error(error.message)
  await logWorkshopActivity(db, {
    action: 'clock_off', entity: 'booking', entity_id: entry.booking_id,
    detail: `${entry.technician_code} clocked off (${minutes} min)`,
    actor_id: user.id, actor_name: user.displayName || user.email,
  })
  return minutes
}

export default withAuth('view:diary', async (req, res, user) => {
  const db = sb()

  if (req.method === 'GET') {
    const bookingId = String(req.query.booking_id || '').trim()
    if (!bookingId) return res.status(400).json({ error: 'booking_id required' })
    const { data, error } = await db.from('workshop_time_entries')
      .select('id, technician_code, started_at, ended_at, minutes, created_by')
      .eq('booking_id', bookingId).order('started_at', { ascending: true })
    if (error) return res.status(500).json({ error: error.message })
    const entries = data || []
    const now = Date.now()
    const total = entries.reduce((s: number, e: any) => s + (e.ended_at ? (Number(e.minutes) || 0) : Math.round((now - new Date(e.started_at).getTime()) / 60000)), 0)
    return res.status(200).json({
      entries,
      total_minutes: total,
      open: entries.filter((e: any) => !e.ended_at).map((e: any) => ({ id: e.id, technician_code: e.technician_code, started_at: e.started_at })),
    })
  }

  if (!roleHasPermission(user.role, 'edit:bookings')) return res.status(403).json({ error: 'Forbidden' })
  let body: any = {}
  try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
  catch { return res.status(400).json({ error: 'Bad JSON body' }) }

  if (req.method === 'POST') {
    const bookingId = String(body.booking_id || '').trim()
    const tech = String(body.technician_code || '').trim()
    if (!bookingId || !tech) return res.status(400).json({ error: 'booking_id and technician_code required' })

    if (body.action === 'stop') {
      const { data: open } = await db.from('workshop_time_entries')
        .select('id, booking_id, technician_code, started_at')
        .eq('booking_id', bookingId).eq('technician_code', tech).is('ended_at', null).maybeSingle()
      if (!open) return res.status(404).json({ error: 'No running clock for this tech on this job' })
      const minutes = await stopEntry(db, open, user)
      return res.status(200).json({ ok: true, minutes })
    }

    const { data: entry, error } = await db.from('workshop_time_entries')
      .insert({ booking_id: bookingId, technician_code: tech, created_by: user.id })
      .select('id, technician_code, started_at').single()
    if (error) {
      if (String(error.code) === '23505') return res.status(409).json({ error: `${tech} is already clocked on to this job` })
      return res.status(500).json({ error: error.message })
    }
    // Nudge the job into in_progress when work actually starts.
    await db.from('workshop_bookings').update({ status: 'in_progress' })
      .eq('id', bookingId).in('status', ['prebooked', 'booking', 'confirmed'])
    await logWorkshopActivity(db, {
      action: 'clock_on', entity: 'booking', entity_id: bookingId,
      detail: `${tech} clocked on`, actor_id: user.id, actor_name: user.displayName || user.email,
    })
    return res.status(201).json({ ok: true, entry })
  }

  if (req.method === 'PATCH') {
    const id = String(req.query.id || body.id || '').trim()
    if (!id) return res.status(400).json({ error: 'id required' })
    const { data: entry } = await db.from('workshop_time_entries')
      .select('id, booking_id, technician_code, started_at, ended_at').eq('id', id).maybeSingle()
    if (!entry) return res.status(404).json({ error: 'Entry not found' })

    if (body.action === 'stop') {
      if (entry.ended_at) return res.status(400).json({ error: 'Already stopped' })
      const minutes = await stopEntry(db, entry, user)
      return res.status(200).json({ ok: true, minutes })
    }
    if ('minutes' in body) {
      const m = Math.max(0, Math.round(Number(body.minutes) || 0))
      const { error } = await db.from('workshop_time_entries')
        .update({ minutes: m, ended_at: entry.ended_at || new Date().toISOString() }).eq('id', id)
      if (error) return res.status(500).json({ error: error.message })
      return res.status(200).json({ ok: true })
    }
    return res.status(400).json({ error: 'Nothing to update' })
  }

  if (req.method === 'DELETE') {
    const id = String(req.query.id || '').trim()
    if (!id) return res.status(400).json({ error: 'id required' })
    const { error } = await db.from('workshop_time_entries').delete().eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  res.setHeader('Allow', 'GET, POST, PATCH, DELETE')
  return res.status(405).json({ error: 'GET, POST, PATCH or DELETE only' })
})
