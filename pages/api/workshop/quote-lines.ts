// pages/api/workshop/quote-lines.ts
// GET    ?quote_id= — lines for a quote
// POST              — add a line     (edit:bookings)
// PATCH  ?id=       — update a line  (edit:bookings)
// DELETE ?id=       — remove a line  (edit:bookings)
// Every mutation recomputes the parent quote's subtotal/gst/total.

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../lib/authServer'
import { roleHasPermission } from '../../../lib/permissions'
import { onQuoteTotalChanged } from '../../../lib/crm-bridge'

export const config = { maxDuration: 10 }

function sb(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase not configured')
  return createClient(url, key, { auth: { persistSession: false } })
}

const round2 = (n: number) => Math.round(n * 100) / 100

async function recompute(db: SupabaseClient, quoteId: string) {
  const { data: lines } = await db.from('workshop_quote_lines').select('qty, unit_price, line_type').eq('quote_id', quoteId)
  let subtotal = 0
  for (const l of lines || []) {
    if ((l as any).line_type === 'description') continue   // heading rows carry no value
    subtotal += Number((l as any).qty) * Number((l as any).unit_price)
  }
  subtotal = round2(subtotal)
  const gst = round2(subtotal * 0.10)
  const total = round2(subtotal + gst)
  await db.from('workshop_quotes').update({ subtotal, gst, total, updated_at: new Date().toISOString() }).eq('id', quoteId)
  await onQuoteTotalChanged(db, quoteId, total)   // value sync onto the linked CRM lead
}

export default withAuth('view:diary', async (req, res, user) => {
  const db = sb()

  if (req.method === 'GET') {
    const quoteId = String(req.query.quote_id || '').trim()
    if (!quoteId) return res.status(400).json({ error: 'quote_id required' })
    const { data, error } = await db.from('workshop_quote_lines').select('*').eq('quote_id', quoteId).order('sort_order', { ascending: true })
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ lines: data || [] })
  }

  if (!roleHasPermission(user.role, 'edit:bookings')) return res.status(403).json({ error: 'Forbidden' })

  let body: any = {}
  try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
  catch { return res.status(400).json({ error: 'Bad JSON body' }) }

  if (req.method === 'POST') {
    const quote_id = String(body.quote_id || '').trim()
    if (!quote_id) return res.status(400).json({ error: 'quote_id required' })
    const { data, error } = await db.from('workshop_quote_lines').insert({
      quote_id,
      line_type: body.line_type ? String(body.line_type) : 'item',
      description: body.description ? String(body.description) : null,
      part_number: body.part_number ? String(body.part_number) : null,
      qty: Number(body.qty) || (body.line_type === 'description' ? 0 : 1),
      unit_price: Number(body.unit_price) || 0,
      inventory_id: body.inventory_id || null,
      sort_order: Number(body.sort_order) || 0,
    }).select('*').single()
    if (error) return res.status(500).json({ error: error.message })
    await recompute(db, quote_id)
    return res.status(201).json({ ok: true, line: data })
  }

  if (req.method === 'PATCH') {
    const id = String(req.query.id || '').trim()
    if (!id) return res.status(400).json({ error: 'id required' })
    const patch: Record<string, any> = {}
    for (const f of ['line_type', 'description', 'part_number', 'qty', 'unit_price', 'inventory_id', 'sort_order']) {
      if (f in body) patch[f] = body[f] === '' ? null : body[f]
    }
    const { data, error } = await db.from('workshop_quote_lines').update(patch).eq('id', id).select('quote_id').single()
    if (error) return res.status(500).json({ error: error.message })
    if (data?.quote_id) await recompute(db, data.quote_id)
    return res.status(200).json({ ok: true })
  }

  if (req.method === 'DELETE') {
    const id = String(req.query.id || '').trim()
    if (!id) return res.status(400).json({ error: 'id required' })
    const { data: existing } = await db.from('workshop_quote_lines').select('quote_id').eq('id', id).maybeSingle()
    const { error } = await db.from('workshop_quote_lines').delete().eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    if (existing?.quote_id) await recompute(db, existing.quote_id)
    return res.status(200).json({ ok: true })
  }

  res.setHeader('Allow', 'GET, POST, PATCH, DELETE')
  return res.status(405).json({ error: 'GET, POST, PATCH or DELETE only' })
})
