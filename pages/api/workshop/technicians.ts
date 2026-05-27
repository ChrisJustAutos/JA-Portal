// pages/api/workshop/technicians.ts
// Workshop technicians / staff that drive the diary lanes (workshop_technicians).
//   GET                — list all (view:diary). ?diary=1 → only active + shown.
//   POST               — add a technician (admin:settings).
//   PATCH ?id=         — update one (admin:settings).
//   DELETE ?id=        — remove; hard-delete if unused on bookings, else
//                        deactivate + hide (admin:settings).

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../lib/authServer'
import { roleHasPermission } from '../../../lib/permissions'

export const config = { maxDuration: 10 }

function sb(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase not configured')
  return createClient(url, key, { auth: { persistSession: false } })
}

const EDITABLE = ['name', 'code', 'role', 'color', 'phone_ext', 'daily_hours', 'show_in_diary', 'active', 'sort_order'] as const

function slugCode(name: string): string {
  const base = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 16) || 'tech'
  return `${base}-${Math.random().toString(36).slice(2, 6)}`
}

export default withAuth('view:diary', async (req, res, user) => {
  const db = sb()

  if (req.method === 'GET') {
    let q = db.from('workshop_technicians').select('*')
    if (String(req.query.diary || '') === '1') q = q.eq('active', true).eq('show_in_diary', true)
    const { data, error } = await q.order('sort_order', { ascending: true }).order('name', { ascending: true })
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ technicians: data || [] })
  }

  // Writes are admin-only.
  if (!roleHasPermission(user.role, 'admin:settings')) return res.status(403).json({ error: 'Admin only' })

  let body: any = {}
  if (req.method === 'POST' || req.method === 'PATCH') {
    try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
    catch { return res.status(400).json({ error: 'Bad JSON body' }) }
  }

  if (req.method === 'POST') {
    const name = String(body.name || '').trim()
    if (!name) return res.status(400).json({ error: 'name required' })
    const code = String(body.code || '').trim() || slugCode(name)
    const row: any = {
      name, code,
      role: body.role ? String(body.role) : null,
      color: body.color ? String(body.color) : null,
      phone_ext: body.phone_ext ? String(body.phone_ext) : null,
      daily_hours: body.daily_hours != null ? Math.max(0, Number(body.daily_hours) || 0) : 8,
      show_in_diary: body.show_in_diary != null ? !!body.show_in_diary : true,
      active: body.active != null ? !!body.active : true,
      sort_order: body.sort_order != null ? (Number(body.sort_order) || 0) : 0,
    }
    const { data, error } = await db.from('workshop_technicians').insert(row).select('*').single()
    if (error) return res.status(error.code === '23505' ? 409 : 500).json({ error: error.code === '23505' ? 'That code is already in use.' : error.message })
    return res.status(201).json({ ok: true, technician: data })
  }

  if (req.method === 'PATCH') {
    const id = String(req.query.id || '').trim()
    if (!id) return res.status(400).json({ error: 'id required' })
    const patch: any = { updated_at: new Date().toISOString() }
    for (const f of EDITABLE) {
      if (!(f in body)) continue
      if (f === 'daily_hours') patch[f] = Math.max(0, Number(body[f]) || 0)
      else if (f === 'sort_order') patch[f] = Number(body[f]) || 0
      else if (f === 'show_in_diary' || f === 'active') patch[f] = !!body[f]
      else patch[f] = body[f] === '' ? null : body[f]
    }
    const { error } = await db.from('workshop_technicians').update(patch).eq('id', id)
    if (error) return res.status(error.code === '23505' ? 409 : 500).json({ error: error.code === '23505' ? 'That code is already in use.' : error.message })
    return res.status(200).json({ ok: true })
  }

  if (req.method === 'DELETE') {
    const id = String(req.query.id || '').trim()
    if (!id) return res.status(400).json({ error: 'id required' })
    const { data: tech } = await db.from('workshop_technicians').select('code').eq('id', id).maybeSingle()
    if (!tech) return res.status(404).json({ error: 'not_found' })
    // Only hard-delete when no bookings reference this lane; otherwise retire it
    // (keep the row so historical bookings still resolve the technician name).
    const { count } = await db.from('workshop_bookings').select('id', { count: 'exact', head: true }).eq('technician_ext', (tech as any).code)
    if ((count || 0) > 0) {
      await db.from('workshop_technicians').update({ active: false, show_in_diary: false, updated_at: new Date().toISOString() }).eq('id', id)
      return res.status(200).json({ ok: true, retired: true, bookings: count })
    }
    const { error } = await db.from('workshop_technicians').delete().eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true, deleted: true })
  }

  res.setHeader('Allow', 'GET, POST, PATCH, DELETE')
  return res.status(405).json({ error: 'GET, POST, PATCH or DELETE only' })
})
