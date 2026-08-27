// pages/api/b2b/admin/freight-markup-tiers.ts
// CRUD for the tiered freight markup (migration 208).
//   GET                                         → { tiers: [...] }
//   POST   { up_to_ex_gst|null, markup_percent } → create
//   PATCH  ?id=  { ...editable }                 → update
//   DELETE ?id=                                  → remove
//
// up_to_ex_gst is the INCLUSIVE upper bound of the band, on what the CARRIER
// charges us ex GST. NULL is the open-ended top band, and there can only be one
// (a partial unique index enforces it) — two would make resolution ambiguous.
//
// Mirrors freight-pallets.ts, same permission, so the Freight packaging screen
// edits both the same way. The legacy flat b2b_settings.freight_markup_percent
// stays as the fallback for an empty table — see lib/b2b-freight
// resolveMarkupPct.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../lib/authServer'

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

function cleanBody(body: any): { update: Record<string, any>; issues: string[] } {
  const update: Record<string, any> = {}
  const issues: string[] = []

  if ('up_to_ex_gst' in body) {
    const raw = body.up_to_ex_gst
    // '' / null / undefined all mean "the open-ended top band".
    if (raw === null || raw === undefined || String(raw).trim() === '') {
      update.up_to_ex_gst = null
    } else {
      const v = Number(raw)
      if (!Number.isFinite(v) || v <= 0) issues.push('Up to must be a dollar amount greater than zero, or blank for the top band')
      else update.up_to_ex_gst = Math.round(v * 100) / 100
    }
  }
  if ('markup_percent' in body) {
    const v = Number(body.markup_percent)
    if (!Number.isFinite(v) || v < 0 || v > 500) issues.push('Markup must be between 0 and 500 percent')
    else update.markup_percent = Math.round(v * 100) / 100
  }
  if ('sort_order' in body) {
    const v = parseInt(String(body.sort_order), 10)
    if (!Number.isFinite(v) || v < 0) issues.push('sort_order must be a non-negative number')
    else update.sort_order = v
  }
  if ('is_active' in body) update.is_active = !!body.is_active
  return { update, issues }
}

// The one-open-band unique index surfaces as a Postgres 23505; say what it
// actually means rather than leaking the index name.
function friendly(error: { code?: string; message: string }): string {
  if (error.code === '23505') return 'There is already an open-ended top band — edit that one, or give this band an upper limit.'
  return error.message
}

export default withAuth('edit:b2b_distributors', async (req: NextApiRequest, res: NextApiResponse) => {
  const c = sb()

  if (req.method === 'GET') {
    const { data, error } = await c.from('b2b_freight_markup_tiers')
      .select('id, up_to_ex_gst, markup_percent, sort_order, is_active')
      .order('sort_order', { ascending: true }).order('created_at', { ascending: true })
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ tiers: data || [] })
  }

  if (req.method === 'POST') {
    const { update, issues } = cleanBody(req.body || {})
    if (!('markup_percent' in update)) issues.push('markup_percent required')
    // Absent (not just blank) up_to means the caller forgot the field.
    if (!('up_to_ex_gst' in update)) issues.push('up_to_ex_gst required (blank for the open-ended top band)')
    if (issues.length) return res.status(400).json({ error: 'Validation failed', issues })
    const { data, error } = await c.from('b2b_freight_markup_tiers').insert(update).select('id').single()
    if (error) return res.status(500).json({ error: friendly(error) })
    return res.status(200).json({ ok: true, id: data.id })
  }

  if (req.method === 'PATCH') {
    const id = String(req.query.id || '').trim()
    if (!id) return res.status(400).json({ error: 'id required' })
    const { update, issues } = cleanBody(req.body || {})
    if (issues.length) return res.status(400).json({ error: 'Validation failed', issues })
    if (Object.keys(update).length === 0) return res.status(400).json({ error: 'No fields to update' })
    const { error } = await c.from('b2b_freight_markup_tiers').update(update).eq('id', id)
    if (error) return res.status(500).json({ error: friendly(error) })
    return res.status(200).json({ ok: true })
  }

  if (req.method === 'DELETE') {
    const id = String(req.query.id || '').trim()
    if (!id) return res.status(400).json({ error: 'id required' })
    const { error } = await c.from('b2b_freight_markup_tiers').delete().eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  res.setHeader('Allow', 'GET, POST, PATCH, DELETE')
  return res.status(405).json({ error: 'GET, POST, PATCH or DELETE only' })
})
