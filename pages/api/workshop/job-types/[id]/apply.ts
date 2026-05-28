// pages/api/workshop/job-types/[id]/apply.ts
// POST { booking_id, lines_only? } — copy a job type's template lines AND its
// work-done description onto a booking. Lines are appended after any existing
// lines. The description is set if the booking has none, or appended (with a
// blank line between) if it already has one — so the same text shows on the
// invoice AND on the job-card checklist. Pass `lines_only: true` when the
// caller has already set the description (e.g. the diary booking modal).
// Gated edit:bookings.

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../../lib/authServer'

export const config = { maxDuration: 10 }

function sb(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase not configured')
  return createClient(url, key, { auth: { persistSession: false } })
}

export default withAuth('edit:bookings', async (req, res) => {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }) }
  const jobTypeId = String(req.query.id || '').trim()
  if (!jobTypeId) return res.status(400).json({ error: 'job type id required' })
  let body: any = {}
  try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
  catch { return res.status(400).json({ error: 'Bad JSON body' }) }
  const bookingId = String(body.booking_id || '').trim()
  if (!bookingId) return res.status(400).json({ error: 'booking_id required' })

  const linesOnly = !!body.lines_only

  const db = sb()
  const { data: jobType } = await db.from('workshop_job_types').select('id, code, name, description').eq('id', jobTypeId).maybeSingle()
  if (!jobType) return res.status(404).json({ error: 'job type not found' })

  const { data: tmplLines } = await db.from('workshop_job_type_lines').select('*').eq('job_type_id', jobTypeId).order('sort_order', { ascending: true })
  if (!tmplLines || tmplLines.length === 0) return res.status(400).json({ error: 'This job type has no template lines.' })

  // Carry the job type's work-done description onto the booking so it shows on
  // the job-card checklist + the invoice. Skip if the caller's already set it.
  if (!linesOnly && (jobType as any).description) {
    const jtDesc = String((jobType as any).description).trim()
    const { data: bk } = await db.from('workshop_bookings').select('description').eq('id', bookingId).maybeSingle()
    const existing = String((bk as any)?.description || '').trim()
    let next = existing
    if (!existing) next = jtDesc
    else if (!existing.includes(jtDesc)) next = `${existing}\n\n${jtDesc}`
    if (next !== existing) {
      await db.from('workshop_bookings').update({ description: next }).eq('id', bookingId)
    }
  }

  // Append after the booking's existing lines.
  const { data: existing } = await db.from('workshop_booking_lines').select('sort_order').eq('booking_id', bookingId).order('sort_order', { ascending: false }).limit(1)
  let nextSort = (existing && existing[0] ? Number(existing[0].sort_order) || 0 : 0) + 1

  const rows = tmplLines.map((l: any) => ({
    booking_id: bookingId,
    line_type: l.line_type,
    description: l.description,
    part_number: l.part_number,
    qty: l.qty,
    unit_price_ex_gst: l.unit_price_ex_gst,
    gst_rate: l.gst_rate,
    inventory_id: l.inventory_id,
    total_ex_gst: Math.round((Number(l.qty) || 0) * (Number(l.unit_price_ex_gst) || 0) * 100) / 100,
    sort_order: nextSort++,
  }))
  const { error } = await db.from('workshop_booking_lines').insert(rows)
  if (error) return res.status(500).json({ error: error.message })

  return res.status(200).json({ ok: true, added: rows.length, job_type: (jobType as any).code || (jobType as any).name })
})
