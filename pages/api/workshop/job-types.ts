// pages/api/workshop/job-types.ts
// Job-type presets (named jobs with template labour + part lines).
//   GET            — all job types, each with its template lines (view:diary)
//   POST           — create a job type (edit:bookings)
//   PATCH ?id=     — update header (edit:bookings)
//   DELETE ?id=    — delete (cascade lines) (edit:bookings)

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

const HEADER_FIELDS = ['name', 'code', 'description', 'default_duration_min', 'active', 'sort_order'] as const

export default withAuth('view:diary', async (req, res, user) => {
  const db = sb()

  if (req.method === 'GET') {
    const { data: types, error } = await db.from('workshop_job_types').select('*').order('name', { ascending: true })
    if (error) return res.status(500).json({ error: error.message })
    const ids = (types || []).map((t: any) => t.id)
    let lines: any[] = []
    let typeModels: any[] = []
    if (ids.length) {
      const [{ data: ld }, { data: tm }] = await Promise.all([
        db.from('workshop_job_type_lines').select('*').in('job_type_id', ids).order('sort_order', { ascending: true }),
        db.from('workshop_job_type_models').select('job_type_id, model_id').in('job_type_id', ids),
      ])
      lines = ld || []; typeModels = tm || []
    }
    const byType: Record<string, any[]> = {}
    for (const l of lines) (byType[l.job_type_id] ||= []).push(l)
    const modelsByType: Record<string, string[]> = {}
    for (const m of typeModels) (modelsByType[m.job_type_id] ||= []).push(m.model_id)
    return res.status(200).json({ jobTypes: (types || []).map((t: any) => ({ ...t, lines: byType[t.id] || [], model_ids: modelsByType[t.id] || [] })) })
  }

  if (!roleHasPermission(user.role, 'edit:bookings')) return res.status(403).json({ error: 'Forbidden' })
  let body: any = {}
  if (req.method === 'POST' || req.method === 'PATCH') {
    try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
    catch { return res.status(400).json({ error: 'Bad JSON body' }) }
  }

  if (req.method === 'POST') {
    const name = String(body.name || '').trim()
    if (!name) return res.status(400).json({ error: 'name required' })
    const { data, error } = await db.from('workshop_job_types').insert({
      name, code: body.code || null, description: body.description || null,
      default_duration_min: body.default_duration_min != null ? (Number(body.default_duration_min) || null) : null,
      sort_order: Number(body.sort_order) || 0,
      checklist: Array.isArray(body.checklist) ? body.checklist : [],
    }).select('*').single()
    if (error) return res.status(error.code === '23505' ? 409 : 500).json({ error: error.code === '23505' ? 'Code already in use.' : error.message })
    if (Array.isArray(body.model_ids) && body.model_ids.length) {
      await db.from('workshop_job_type_models').insert(body.model_ids.map((m: string) => ({ job_type_id: data.id, model_id: m })))
    }
    return res.status(201).json({ ok: true, jobType: { ...data, lines: [], model_ids: body.model_ids || [] } })
  }

  if (req.method === 'PATCH') {
    const id = String(req.query.id || '').trim()
    if (!id) return res.status(400).json({ error: 'id required' })
    const patch: any = { updated_at: new Date().toISOString() }
    for (const f of HEADER_FIELDS) {
      if (!(f in body)) continue
      if (f === 'active') patch[f] = !!body[f]
      else if (f === 'default_duration_min' || f === 'sort_order') patch[f] = body[f] == null || body[f] === '' ? null : (Number(body[f]) || 0)
      else patch[f] = body[f] === '' ? null : body[f]
    }
    if ('checklist' in body) patch.checklist = Array.isArray(body.checklist) ? body.checklist : []
    const { error } = await db.from('workshop_job_types').update(patch).eq('id', id)
    if (error) return res.status(error.code === '23505' ? 409 : 500).json({ error: error.code === '23505' ? 'Code already in use.' : error.message })
    if (Array.isArray(body.model_ids)) {
      await db.from('workshop_job_type_models').delete().eq('job_type_id', id)
      if (body.model_ids.length) await db.from('workshop_job_type_models').insert(body.model_ids.map((m: string) => ({ job_type_id: id, model_id: m })))
    }
    return res.status(200).json({ ok: true })
  }

  if (req.method === 'DELETE') {
    const id = String(req.query.id || '').trim()
    if (!id) return res.status(400).json({ error: 'id required' })
    const { error } = await db.from('workshop_job_types').delete().eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  res.setHeader('Allow', 'GET, POST, PATCH, DELETE')
  return res.status(405).json({ error: 'GET, POST, PATCH or DELETE only' })
})
