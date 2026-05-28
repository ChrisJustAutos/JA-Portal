// pages/api/workshop/quotes/[id].ts
// GET    — quote (+ customer + vehicle) + its lines.       (view:diary)
// PATCH  — status / notes / customer / vehicle.            (edit:bookings)
// DELETE — remove the quote (lines cascade).               (edit:bookings)

import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../lib/authServer'
import { roleHasPermission } from '../../../../lib/permissions'
import { QUOTE_STATUSES } from '../../../../lib/workshop'

export const config = { maxDuration: 10 }

function sb() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase not configured')
  return createClient(url, key, { auth: { persistSession: false } })
}

const EDITABLE = ['notes', 'customer_id', 'vehicle_id'] as const

export default withAuth('view:diary', async (req, res, user) => {
  const id = String(req.query.id || '').trim()
  if (!id) return res.status(400).json({ error: 'id required' })
  const db = sb()

  if (req.method === 'GET') {
    const { data: quote, error } = await db.from('workshop_quotes')
      .select(`*, customer:workshop_customers(*), vehicle:workshop_vehicles(*)`)
      .eq('id', id).maybeSingle()
    if (error) return res.status(500).json({ error: error.message })
    if (!quote) return res.status(404).json({ error: 'not_found' })
    const { data: lines } = await db.from('workshop_quote_lines')
      .select('*').eq('quote_id', id).order('sort_order', { ascending: true })
    return res.status(200).json({ quote, lines: lines || [] })
  }

  if (req.method === 'PATCH') {
    if (!roleHasPermission(user.role, 'edit:bookings')) return res.status(403).json({ error: 'Forbidden' })
    let body: any = {}
    try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
    catch { return res.status(400).json({ error: 'Bad JSON body' }) }
    const patch: Record<string, any> = { updated_at: new Date().toISOString() }
    for (const f of EDITABLE) if (f in body) patch[f] = body[f] === '' ? null : body[f]
    if ('status' in body) {
      if (!QUOTE_STATUSES.includes(body.status)) return res.status(400).json({ error: 'invalid status' })
      patch.status = body.status
    }
    const { error } = await db.from('workshop_quotes').update(patch).eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  if (req.method === 'DELETE') {
    if (!roleHasPermission(user.role, 'edit:bookings')) return res.status(403).json({ error: 'Forbidden' })
    // Soft delete — moves to trash. Pass ?hard=1 to wipe (admin only).
    const hard = String(req.query.hard || '') === '1'
    if (hard) {
      if (!roleHasPermission(user.role, 'admin:settings')) return res.status(403).json({ error: 'Admin only for hard delete' })
      const { error } = await db.from('workshop_quotes').delete().eq('id', id)
      if (error) return res.status(500).json({ error: error.message })
      return res.status(200).json({ ok: true, hard: true })
    }
    const { error } = await db.from('workshop_quotes').update({ deleted_at: new Date().toISOString() }).eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  res.setHeader('Allow', 'GET, PATCH, DELETE')
  return res.status(405).json({ error: 'GET, PATCH or DELETE only' })
})
