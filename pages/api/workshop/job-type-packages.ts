// pages/api/workshop/job-type-packages.ts
// Job-type PACKAGES — a named, ordered bundle of existing job types.
//   GET            — all packages, each with its ordered member job types (view:diary)
//   POST           — create a package (+ optional job_type_ids) (edit:bookings)
//   PATCH ?id=     — update header and/or replace member job_type_ids (edit:bookings)
//   DELETE ?id=    — delete (cascade items) (edit:bookings)
//
// Members reference workshop_job_types by id — applying a package just runs the
// shared job-type apply per member (see /job-type-packages/[id]/apply).

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

const HEADER_FIELDS = ['name', 'description', 'active', 'sort_order'] as const

// Replace a package's member set from an ordered list of job_type_ids.
async function setItems(db: SupabaseClient, packageId: string, jobTypeIds: any): Promise<void> {
  if (!Array.isArray(jobTypeIds)) return
  const ids = jobTypeIds.map((x: any) => String(x)).filter(Boolean)
  await db.from('workshop_job_type_package_items').delete().eq('package_id', packageId)
  if (ids.length) {
    await db.from('workshop_job_type_package_items').insert(
      ids.map((jid, i) => ({ package_id: packageId, job_type_id: jid, sort_order: i })),
    )
  }
}

export default withAuth('view:diary', async (req, res, user) => {
  const db = sb()

  if (req.method === 'GET') {
    const { data: packages, error } = await db.from('workshop_job_type_packages').select('*').order('sort_order', { ascending: true }).order('name', { ascending: true })
    if (error) return res.status(500).json({ error: error.message })
    const ids = (packages || []).map((p: any) => p.id)
    let items: any[] = []
    if (ids.length) {
      const { data } = await db.from('workshop_job_type_package_items')
        .select('package_id, job_type_id, sort_order, job_type:workshop_job_types!job_type_id ( id, name, code )')
        .in('package_id', ids).order('sort_order', { ascending: true })
      items = data || []
    }
    const byPkg: Record<string, any[]> = {}
    for (const it of items) {
      const jt = Array.isArray(it.job_type) ? it.job_type[0] : it.job_type
      ;(byPkg[it.package_id] ||= []).push({ job_type_id: it.job_type_id, sort_order: it.sort_order, name: jt?.name || null, code: jt?.code || null })
    }
    return res.status(200).json({ packages: (packages || []).map((p: any) => ({ ...p, items: byPkg[p.id] || [] })) })
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
    const { data, error } = await db.from('workshop_job_type_packages').insert({
      name,
      description: body.description ? String(body.description) : null,
      sort_order: body.sort_order != null ? Number(body.sort_order) || 0 : 0,
    }).select('*').single()
    if (error) return res.status(500).json({ error: error.message })
    if (Array.isArray(body.job_type_ids)) await setItems(db, data.id, body.job_type_ids)
    return res.status(201).json({ ok: true, package: data })
  }

  if (req.method === 'PATCH') {
    const id = String(req.query.id || '').trim()
    if (!id) return res.status(400).json({ error: 'id required' })
    const patch: any = { updated_at: new Date().toISOString() }
    for (const f of HEADER_FIELDS) {
      if (!(f in body)) continue
      if (f === 'active') patch[f] = !!body[f]
      else if (f === 'sort_order') patch[f] = Number(body[f]) || 0
      else patch[f] = body[f] === '' ? null : body[f]
    }
    const { error } = await db.from('workshop_job_type_packages').update(patch).eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    if (Array.isArray(body.job_type_ids)) await setItems(db, id, body.job_type_ids)
    return res.status(200).json({ ok: true })
  }

  if (req.method === 'DELETE') {
    const id = String(req.query.id || '').trim()
    if (!id) return res.status(400).json({ error: 'id required' })
    const { error } = await db.from('workshop_job_type_packages').delete().eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true, deleted: true })
  }

  res.setHeader('Allow', 'GET, POST, PATCH, DELETE')
  return res.status(405).json({ error: 'GET, POST, PATCH or DELETE only' })
})
