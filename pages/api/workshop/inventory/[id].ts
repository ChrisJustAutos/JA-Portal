// pages/api/workshop/inventory/[id].ts
//   GET   — full inventory item (view:diary).
//   PATCH — edit item fields (admin:settings). MYOB-backed fields (sku, name,
//           description, cost, sell price, sale account) flag the row dirty so
//           the next sync won't clobber the edit before it's pushed.
//   POST  — { action: 'push' } push the item back to MYOB; { action:
//           'generate_barcode' } assign a unique internal Code-128 barcode.

import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../lib/authServer'
import { roleHasPermission } from '../../../../lib/permissions'
import { pushInventoryItemToMyob } from '../../../../lib/workshop-myob-items'

export const config = { maxDuration: 30 }

function sb() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase not configured')
  return createClient(url, key, { auth: { persistSession: false } })
}

// Editable text + numeric fields. MYOB_BACKED ones also flag the row dirty.
const TEXT_FIELDS = ['sku', 'part_name', 'sale_description', 'barcode', 'supplier', 'location', 'bin', 'brand', 'category', 'sale_account_uid', 'sale_account_name'] as const
const NUM_FIELDS = ['buy_price', 'sell_price', 'price_level_2', 'price_level_3', 'price_level_4', 'markup_pct', 'alert_qty', 'reorder_qty', 'max_qty'] as const
const MYOB_BACKED = new Set(['sku', 'part_name', 'sale_description', 'buy_price', 'sell_price', 'sale_account_uid', 'sale_account_name'])

export default withAuth('view:diary', async (req, res, user) => {
  const id = String(req.query.id || '').trim()
  if (!id) return res.status(400).json({ error: 'id required' })
  const db = sb()

  if (req.method === 'GET') {
    const { data, error } = await db.from('workshop_inventory').select('*').eq('id', id).maybeSingle()
    if (error) return res.status(500).json({ error: error.message })
    if (!data) return res.status(404).json({ error: 'not_found' })
    return res.status(200).json({ item: data })
  }

  if (req.method === 'PATCH') {
    if (!roleHasPermission(user.role, 'admin:settings')) return res.status(403).json({ error: 'Admin only' })
    let body: any = {}
    try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
    catch { return res.status(400).json({ error: 'Bad JSON body' }) }

    const patch: any = { updated_at: new Date().toISOString() }
    let touchedMyob = false
    for (const f of TEXT_FIELDS) if (f in body) { patch[f] = body[f] === '' || body[f] == null ? null : String(body[f]); if (MYOB_BACKED.has(f)) touchedMyob = true }
    for (const f of NUM_FIELDS) if (f in body) { patch[f] = body[f] === '' || body[f] == null ? null : Number(body[f]) || 0; if (MYOB_BACKED.has(f)) touchedMyob = true }
    if (Object.keys(patch).length === 1) return res.status(400).json({ error: 'No editable fields in body' })
    if (touchedMyob) patch.myob_dirty = true

    const { error } = await db.from('workshop_inventory').update(patch).eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    const { data } = await db.from('workshop_inventory').select('*').eq('id', id).maybeSingle()
    return res.status(200).json({ ok: true, item: data })
  }

  if (req.method === 'POST') {
    if (!roleHasPermission(user.role, 'admin:settings')) return res.status(403).json({ error: 'Admin only' })
    let body: any = {}
    try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
    catch { return res.status(400).json({ error: 'Bad JSON body' }) }
    const action = String(body.action || '')

    if (action === 'generate_barcode') {
      const { data: seq, error: seqErr } = await db.rpc('next_internal_barcode')
      if (seqErr) return res.status(500).json({ error: seqErr.message })
      const barcode = String(seq)
      const { error } = await db.from('workshop_inventory').update({ barcode, updated_at: new Date().toISOString() }).eq('id', id)
      if (error) return res.status(500).json({ error: error.message })
      return res.status(200).json({ ok: true, barcode })
    }

    if (action === 'push') {
      const result = await pushInventoryItemToMyob(id, user.id)
      if (!result.ok) return res.status(502).json({ error: result.error || 'Push failed' })
      const { data } = await db.from('workshop_inventory').select('*').eq('id', id).maybeSingle()
      return res.status(200).json({ ok: true, item: data })
    }

    return res.status(400).json({ error: 'Unknown action' })
  }

  res.setHeader('Allow', 'GET, PATCH, POST')
  return res.status(405).json({ error: 'GET, PATCH or POST only' })
})
