// pages/api/b2b/admin/reorder/index.ts
// Stock reorder/prediction sheet.
//   GET   — { settings, items }
//   PATCH — update settings { from_date, to_date, growth_pct, forecast_months }
//   POST  — add an item { sku, name? }  (or { items: [{sku,name}] })
// Permission: edit:b2b_catalogue.

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../../lib/authServer'

export const config = { maxDuration: 15 }

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  _sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  return _sb
}

export default withAuth('edit:b2b_catalogue', async (req, res, user) => {
  const db = sb()

  if (req.method === 'GET') {
    // Add-item picker: search the catalogue for SKUs/names to add.
    const search = String(req.query.search || '').replace(/[%,()*]/g, ' ').trim()
    if (search) {
      const { data, error } = await db.from('b2b_catalogue')
        .select('sku, name').or(`sku.ilike.%${search}%,name.ilike.%${search}%`).order('sku', { ascending: true }).limit(25)
      if (error) return res.status(500).json({ error: error.message })
      return res.status(200).json({ matches: data || [] })
    }
    const [{ data: settings }, { data: items }] = await Promise.all([
      db.from('b2b_reorder_settings').select('*').eq('id', 'singleton').maybeSingle(),
      db.from('b2b_reorder_items').select('*').order('sort_order', { ascending: true }).order('sku', { ascending: true }),
    ])
    return res.status(200).json({ settings: settings || { id: 'singleton', growth_pct: 0.2, forecast_months: 3 }, items: items || [] })
  }

  let body: any = {}
  try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
  catch { return res.status(400).json({ error: 'Bad JSON body' }) }

  if (req.method === 'PATCH') {
    const patch: any = { updated_at: new Date().toISOString() }
    if ('from_date' in body) patch.from_date = body.from_date || null
    if ('to_date' in body) patch.to_date = body.to_date || null
    if ('growth_pct' in body) patch.growth_pct = Math.max(0, Number(body.growth_pct) || 0)
    if ('forecast_months' in body) patch.forecast_months = Math.max(1, Math.round(Number(body.forecast_months) || 1))
    const { error } = await db.from('b2b_reorder_settings').update(patch).eq('id', 'singleton')
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  if (req.method === 'POST') {
    const incoming: Array<{ sku: string; name?: string | null }> = Array.isArray(body.items)
      ? body.items : (body.sku ? [{ sku: body.sku, name: body.name }] : [])
    const rows = incoming
      .map(i => ({ sku: String(i.sku || '').trim(), name: i.name ? String(i.name) : null }))
      .filter(i => i.sku)
    if (!rows.length) return res.status(400).json({ error: 'sku required' })
    // Skip ones already on the sheet.
    const { data: existing } = await db.from('b2b_reorder_items').select('sku').in('sku', rows.map(r => r.sku))
    const have = new Set((existing || []).map((r: any) => r.sku))
    const toAdd = rows.filter(r => !have.has(r.sku)).map((r, i) => ({ ...r, created_by: user.id, sort_order: 1000 + i }))
    if (toAdd.length) {
      const { error } = await db.from('b2b_reorder_items').insert(toAdd)
      if (error) return res.status(500).json({ error: error.message })
    }
    return res.status(201).json({ ok: true, added: toAdd.length, skipped: rows.length - toAdd.length })
  }

  res.setHeader('Allow', 'GET, PATCH, POST')
  return res.status(405).json({ error: 'GET, PATCH or POST only' })
})
