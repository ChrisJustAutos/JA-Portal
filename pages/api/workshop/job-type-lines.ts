// pages/api/workshop/job-type-lines.ts
// Template lines for a job-type preset. POST add / PATCH ?id / DELETE ?id.
// Gated edit:bookings.

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

const LINE_FIELDS = ['line_type', 'description', 'part_number', 'qty', 'unit_price_ex_gst', 'gst_rate', 'inventory_id', 'sort_order'] as const

export default withAuth('edit:bookings', async (req, res) => {
  const db = sb()

  if (req.method === 'POST') {
    let body: any = {}
    try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
    catch { return res.status(400).json({ error: 'Bad JSON body' }) }
    const job_type_id = String(body.job_type_id || '').trim()
    if (!job_type_id) return res.status(400).json({ error: 'job_type_id required' })
    const { data, error } = await db.from('workshop_job_type_lines').insert({
      job_type_id,
      line_type: ['labour', 'part', 'sublet', 'fee'].includes(body.line_type) ? body.line_type : 'labour',
      description: body.description || null,
      part_number: body.part_number || null,
      qty: Number(body.qty) || 1,
      unit_price_ex_gst: Number(body.unit_price_ex_gst) || 0,
      gst_rate: body.gst_rate != null ? Number(body.gst_rate) : 0.10,
      inventory_id: body.inventory_id || null,
      sort_order: Number(body.sort_order) || 0,
    }).select('*').single()
    if (error) return res.status(500).json({ error: error.message })
    return res.status(201).json({ ok: true, line: data })
  }

  if (req.method === 'PATCH') {
    const id = String(req.query.id || '').trim()
    if (!id) return res.status(400).json({ error: 'id required' })
    let body: any = {}
    try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
    catch { return res.status(400).json({ error: 'Bad JSON body' }) }
    const patch: any = {}
    for (const f of LINE_FIELDS) {
      if (!(f in body)) continue
      if (f === 'qty' || f === 'unit_price_ex_gst' || f === 'gst_rate') patch[f] = Number(body[f]) || 0
      else if (f === 'sort_order') patch[f] = Number(body[f]) || 0
      else patch[f] = body[f] === '' ? null : body[f]
    }
    const { error } = await db.from('workshop_job_type_lines').update(patch).eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  if (req.method === 'DELETE') {
    const id = String(req.query.id || '').trim()
    if (!id) return res.status(400).json({ error: 'id required' })
    const { error } = await db.from('workshop_job_type_lines').delete().eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  res.setHeader('Allow', 'POST, PATCH, DELETE')
  return res.status(405).json({ error: 'POST, PATCH or DELETE only' })
})
