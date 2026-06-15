// pages/api/workshop/tech-availability.ts
// Per-technician per-day availability (Away / Fully booked) for the diary.
//   GET ?from=ISO&to=ISO          — rows in the Brisbane day range
//   POST  { technician_code, date(ymd), status:'away'|'full', note? }  — upsert (edit:bookings)
//   DELETE ?technician_code=&date= — clear (edit:bookings)

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../lib/authServer'
import { roleHasPermission } from '../../../lib/permissions'
import { ymdBrisbane } from '../../../lib/workshop'

export const config = { maxDuration: 10 }

function sb(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase not configured')
  return createClient(url, key, { auth: { persistSession: false } })
}

export default withAuth('view:diary', async (req, res, user) => {
  const db = sb()

  if (req.method === 'GET') {
    const from = String(req.query.from || '').trim()
    const to = String(req.query.to || '').trim()
    let qy = db.from('workshop_tech_availability').select('technician_code, date, status, note')
    if (from) qy = qy.gte('date', ymdBrisbane(new Date(from)))
    if (to) qy = qy.lt('date', ymdBrisbane(new Date(to)))
    const { data, error } = await qy
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ availability: data || [] })
  }

  if (!roleHasPermission(user.role, 'edit:bookings')) return res.status(403).json({ error: 'Forbidden' })

  if (req.method === 'POST') {
    let body: any = {}
    try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
    catch { return res.status(400).json({ error: 'Bad JSON body' }) }
    const code = String(body.technician_code || '').trim()
    const date = String(body.date || '').trim()
    const status = body.status === 'full' ? 'full' : body.status === 'away' ? 'away' : null
    if (!code || !date || !status) return res.status(400).json({ error: 'technician_code, date and status required' })
    const { error } = await db.from('workshop_tech_availability')
      .upsert({ technician_code: code, date, status, note: body.note ? String(body.note).slice(0, 200) : null, created_by: user.id }, { onConflict: 'technician_code,date' })
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  if (req.method === 'DELETE') {
    const code = String(req.query.technician_code || '').trim()
    const date = String(req.query.date || '').trim()
    if (!code || !date) return res.status(400).json({ error: 'technician_code and date required' })
    const { error } = await db.from('workshop_tech_availability').delete().eq('technician_code', code).eq('date', date)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  res.setHeader('Allow', 'GET, POST, DELETE')
  return res.status(405).json({ error: 'GET, POST or DELETE only' })
})
