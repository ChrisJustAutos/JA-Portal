// lib/workshop-job-type-apply.ts
// SERVER-ONLY. The core "apply a job type's template block to a booking or a
// quote" logic, extracted so it can be reused by:
//   - pages/api/workshop/job-types/[id]/apply.ts          (booking)
//   - pages/api/workshop/job-types/[id]/apply-to-quote.ts (quote)
//   - pages/api/workshop/job-type-packages/[id]/apply.ts  (a package = loop members)
//
// Each applied job type adds its own block: a 'description' heading line (the
// job type's work narrative, or its name) followed by its labour/parts lines —
// so a multi-job document reads [description] parts, [description] parts, …

import { SupabaseClient } from '@supabase/supabase-js'

export interface ApplyResult { ok: boolean; added: number; jobTypeLabel: string | null; error?: string }

const round2 = (n: number) => Math.round(n * 100) / 100

// Append a job type's block to a BOOKING (workshop_booking_lines, ex-GST) and
// carry its checklist onto the booking. Mirrors the original /apply endpoint.
export async function applyJobTypeToBooking(
  db: SupabaseClient, jobTypeId: string, bookingId: string, actorLabel: string,
): Promise<ApplyResult> {
  const { data: jobType } = await db.from('workshop_job_types')
    .select('id, code, name, description, checklist').eq('id', jobTypeId).maybeSingle()
  if (!jobType) return { ok: false, added: 0, jobTypeLabel: null, error: 'job type not found' }

  const { data: tmplLines } = await db.from('workshop_job_type_lines')
    .select('*').eq('job_type_id', jobTypeId).order('sort_order', { ascending: true })

  // Carry the job type's checklist onto the booking (skip duplicates by text).
  const jtChecklist: string[] = Array.isArray((jobType as any).checklist) ? (jobType as any).checklist : []
  if (jtChecklist.length) {
    const { data: bk2 } = await db.from('workshop_bookings').select('checklist').eq('id', bookingId).maybeSingle()
    const cur: any[] = Array.isArray((bk2 as any)?.checklist) ? (bk2 as any).checklist : []
    const have = new Set(cur.map((c: any) => String(c?.text || '').trim().toLowerCase()))
    const adds = jtChecklist.map(t => String(t || '').trim()).filter(t => t && !have.has(t.toLowerCase())).map(t => ({ text: t, done: false }))
    if (adds.length) await db.from('workshop_bookings').update({ checklist: [...cur, ...adds] }).eq('id', bookingId)
  }

  const headingText = String((jobType as any).description || '').trim() || String((jobType as any).name || '').trim() || null
  const tmpl = (tmplLines || []) as any[]
  let added = 0
  if (headingText || tmpl.length) {
    const { data: existing } = await db.from('workshop_booking_lines').select('sort_order').eq('booking_id', bookingId).order('sort_order', { ascending: false }).limit(1)
    let nextSort = (existing && existing[0] ? Number(existing[0].sort_order) || 0 : 0) + 1
    const rows: any[] = []
    if (headingText) rows.push({
      booking_id: bookingId, line_type: 'description', description: headingText,
      part_number: null, qty: 0, unit_price_ex_gst: 0, gst_rate: 0.10, inventory_id: null,
      total_ex_gst: 0, sort_order: nextSort++,
    })
    for (const l of tmpl) rows.push({
      booking_id: bookingId, line_type: l.line_type, description: l.description, part_number: l.part_number,
      qty: l.qty, unit_price_ex_gst: l.unit_price_ex_gst, gst_rate: l.gst_rate, inventory_id: l.inventory_id,
      total_ex_gst: round2((Number(l.qty) || 0) * (Number(l.unit_price_ex_gst) || 0)), sort_order: nextSort++,
    })
    if (rows.length) {
      const { error } = await db.from('workshop_booking_lines').insert(rows)
      if (error) return { ok: false, added: 0, jobTypeLabel: null, error: error.message }
      added = rows.length
    }
  }

  try {
    const { data: linked } = await db.from('workshop_doc_job_types').select('id').eq('booking_id', bookingId).eq('job_type_id', jobTypeId).maybeSingle()
    if (!linked) await db.from('workshop_doc_job_types').insert({ booking_id: bookingId, job_type_id: jobTypeId, applied_by: actorLabel })
  } catch { /* best-effort */ }

  return { ok: true, added, jobTypeLabel: (jobType as any).code || (jobType as any).name }
}

// Recompute a quote's stored totals from its lines (the apply path bypasses the
// quote-lines API which would normally do this).
export async function recomputeQuoteTotals(db: SupabaseClient, quoteId: string): Promise<void> {
  const { data: allLines } = await db.from('workshop_quote_lines').select('qty, unit_price, line_type').eq('quote_id', quoteId)
  let subtotal = 0
  for (const l of (allLines || []) as any[]) { if (l.line_type === 'description') continue; subtotal += Number(l.qty) * Number(l.unit_price) }
  subtotal = round2(subtotal)
  const gst = round2(subtotal * 0.10)
  await db.from('workshop_quotes').update({ subtotal, gst, total: round2(subtotal + gst), updated_at: new Date().toISOString() }).eq('id', quoteId)
}

// Append a job type's block to a QUOTE (workshop_quote_lines, inc-GST unit
// price). Mirrors the original /apply-to-quote endpoint, but returns added=0
// rather than erroring on an empty job type (so a package doesn't fail wholesale
// on one empty member). Recomputes the quote totals.
export async function applyJobTypeToQuote(
  db: SupabaseClient, jobTypeId: string, quoteId: string, actorLabel: string,
): Promise<ApplyResult> {
  const { data: jobType } = await db.from('workshop_job_types')
    .select('id, code, name, description').eq('id', jobTypeId).maybeSingle()
  if (!jobType) return { ok: false, added: 0, jobTypeLabel: null, error: 'job type not found' }

  const { data: tmplLines } = await db.from('workshop_job_type_lines')
    .select('*').eq('job_type_id', jobTypeId).order('sort_order', { ascending: true })

  const { data: existing } = await db.from('workshop_quote_lines').select('sort_order').eq('quote_id', quoteId).order('sort_order', { ascending: false }).limit(1)
  let nextSort = (existing && existing[0] ? Number(existing[0].sort_order) || 0 : 0) + 1

  const headingText = String((jobType as any).description || '').trim() || String((jobType as any).name || '').trim() || null
  const rows: any[] = []
  if (headingText) rows.push({
    quote_id: quoteId, line_type: 'description', description: headingText,
    part_number: null, qty: 0, unit_price: 0, inventory_id: null, sort_order: nextSort++,
  })
  for (const l of (tmplLines || []) as any[]) {
    const ex = Number(l.unit_price_ex_gst) || 0
    const rate = Number(l.gst_rate) || 0
    const inc = Math.round(ex * (1 + rate) * 10000) / 10000
    rows.push({
      quote_id: quoteId, line_type: l.line_type || 'item', description: l.description || l.part_number || 'Line',
      part_number: l.part_number, qty: l.qty, unit_price: inc, inventory_id: l.inventory_id, sort_order: nextSort++,
    })
  }
  if (rows.length === 0) return { ok: true, added: 0, jobTypeLabel: (jobType as any).code || (jobType as any).name }

  const { error: insErr } = await db.from('workshop_quote_lines').insert(rows)
  if (insErr) return { ok: false, added: 0, jobTypeLabel: null, error: insErr.message }

  await recomputeQuoteTotals(db, quoteId)

  try {
    const { data: linked } = await db.from('workshop_doc_job_types').select('id').eq('quote_id', quoteId).eq('job_type_id', jobTypeId).maybeSingle()
    if (!linked) await db.from('workshop_doc_job_types').insert({ quote_id: quoteId, job_type_id: jobTypeId, applied_by: actorLabel })
  } catch { /* best-effort */ }

  return { ok: true, added: rows.length, jobTypeLabel: (jobType as any).code || (jobType as any).name }
}
