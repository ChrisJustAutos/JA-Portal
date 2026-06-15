// pages/api/workshop/job-types/[id]/apply-to-quote.ts
// POST { quote_id, append_notes? } — copy a job type's template lines onto a
// quote (workshop_quote_lines). Sibling of /apply (which targets bookings).
// Converts the ex-GST template price to inc-GST for the quote's single price
// field. Appends the job type's description to the quote's notes when
// append_notes is true (default).

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../../lib/authServer'

export const config = { maxDuration: 10 }

function sb(): SupabaseClient {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  )
}

export default withAuth('edit:bookings', async (req, res, user) => {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }) }
  const jobTypeId = String(req.query.id || '').trim()
  if (!jobTypeId) return res.status(400).json({ error: 'job type id required' })
  let body: any = {}
  try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
  catch { return res.status(400).json({ error: 'Bad JSON body' }) }
  const quoteId = String(body.quote_id || '').trim()
  if (!quoteId) return res.status(400).json({ error: 'quote_id required' })
  const appendNotes = body.append_notes !== false

  const db = sb()
  const { data: jobType } = await db.from('workshop_job_types').select('id, code, name, description').eq('id', jobTypeId).maybeSingle()
  if (!jobType) return res.status(404).json({ error: 'job type not found' })

  const { data: tmplLines } = await db.from('workshop_job_type_lines').select('*').eq('job_type_id', jobTypeId).order('sort_order', { ascending: true })
  if (!tmplLines || tmplLines.length === 0) return res.status(400).json({ error: 'This job type has no template lines.' })

  // Append after existing quote lines.
  const { data: existing } = await db.from('workshop_quote_lines').select('sort_order').eq('quote_id', quoteId).order('sort_order', { ascending: false }).limit(1)
  let nextSort = (existing && existing[0] ? Number(existing[0].sort_order) || 0 : 0) + 1

  // Convert ex-GST template price + gst_rate → inc-GST unit price for quote.
  const rows = tmplLines.map((l: any) => {
    const ex = Number(l.unit_price_ex_gst) || 0
    const rate = Number(l.gst_rate) || 0
    const inc = Math.round(ex * (1 + rate) * 10000) / 10000
    return {
      quote_id: quoteId,
      description: l.description || l.part_number || 'Line',
      part_number: l.part_number,
      qty: l.qty,
      unit_price: inc,
      inventory_id: l.inventory_id,
      sort_order: nextSort++,
    }
  })
  const { error: insErr } = await db.from('workshop_quote_lines').insert(rows)
  if (insErr) return res.status(500).json({ error: insErr.message })

  // Append the job type's description to the quote's notes (work narrative).
  if (appendNotes && (jobType as any).description) {
    const jtDesc = String((jobType as any).description).trim()
    const { data: q } = await db.from('workshop_quotes').select('notes').eq('id', quoteId).maybeSingle()
    const existingNotes = String((q as any)?.notes || '').trim()
    let next = existingNotes
    if (!existingNotes) next = jtDesc
    else if (!existingNotes.includes(jtDesc)) next = `${existingNotes}\n\n${jtDesc}`
    if (next !== existingNotes) await db.from('workshop_quotes').update({ notes: next }).eq('id', quoteId)
  }

  // Record that this job type was applied (drives optional email attachments).
  try {
    const { data: linked } = await db.from('workshop_doc_job_types').select('id').eq('quote_id', quoteId).eq('job_type_id', jobTypeId).maybeSingle()
    if (!linked) await db.from('workshop_doc_job_types').insert({ quote_id: quoteId, job_type_id: jobTypeId, applied_by: user.displayName || user.email || user.id })
  } catch { /* best-effort */ }

  return res.status(200).json({ ok: true, added: rows.length, job_type: (jobType as any).code || (jobType as any).name })
})
