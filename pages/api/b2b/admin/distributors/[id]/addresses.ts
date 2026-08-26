// /api/b2b/admin/distributors/{id}/addresses
//
//   GET                                   → every address for this distributor
//   POST   { label, line1?, line2?, suburb?, state?, postcode, contact_name?,
//            contact_phone?, notes?, is_default?, sort_order? }   → add a site
//   PATCH  { address_id, ...same fields, is_active? }             → edit one
//   DELETE ?address_id=                                           → deactivate
//
// Extra delivery sites for a distributor that runs several stores under one
// entity (migration 204). Staff-managed rather than self-serve: where a
// distributor's goods may be sent is a credit and fraud decision, not a
// preference, and the distributor portal only ever SELECTS from this list.
//
// DELETE deactivates rather than removing. An address is referenced by past
// carts and orders, and `b2b_orders.shipping_address_snapshot` is the record of
// what was printed — but the link back is still worth keeping.
//
// Permission: edit:b2b_distributors, same as the rest of the distributor record.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../../../lib/authServer'

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

const FIELDS = ['label', 'line1', 'line2', 'suburb', 'state', 'postcode', 'country', 'contact_name', 'contact_phone', 'notes'] as const

function clean(body: any): Record<string, any> {
  const out: Record<string, any> = {}
  for (const f of FIELDS) {
    if (!(f in body)) continue
    const v = body[f]
    out[f] = v == null || String(v).trim() === '' ? null : String(v).trim().slice(0, 200)
  }
  if ('sort_order' in body) {
    const n = Number(body.sort_order)
    if (Number.isFinite(n)) out.sort_order = Math.max(0, Math.min(9999, Math.round(n)))
  }
  if ('is_active' in body) out.is_active = body.is_active === true
  return out
}

export default withAuth('edit:b2b_distributors', async (req: NextApiRequest, res: NextApiResponse) => {
  const distributorId = String(req.query.id || '').trim()
  if (!distributorId) return res.status(400).json({ error: 'Missing distributor id' })
  const c = sb()

  if (req.method === 'GET') {
    const { data, error } = await c.from('b2b_distributor_addresses')
      .select('*').eq('distributor_id', distributorId)
      .order('is_active', { ascending: false })
      .order('sort_order', { ascending: true })
      .order('label', { ascending: true })
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true, addresses: data || [] })
  }

  // Making one address the default must clear the others first — the DB has a
  // partial unique index on (distributor_id) where is_default, so setting a
  // second one without clearing the first is rejected outright.
  const makeDefault = async (addressId: string) => {
    await c.from('b2b_distributor_addresses')
      .update({ is_default: false, updated_at: new Date().toISOString() })
      .eq('distributor_id', distributorId).neq('id', addressId).eq('is_default', true)
    await c.from('b2b_distributor_addresses')
      .update({ is_default: true, updated_at: new Date().toISOString() })
      .eq('id', addressId).eq('distributor_id', distributorId)
  }

  if (req.method === 'POST') {
    const patch = clean(req.body || {})
    if (!patch.label) return res.status(400).json({ error: 'Give the site a label — it is what the distributor picks from at checkout.' })
    if (!patch.postcode) return res.status(400).json({ error: 'A postcode is required — freight is priced on it.' })
    const { data, error } = await c.from('b2b_distributor_addresses')
      .insert({ ...patch, distributor_id: distributorId, is_default: false })
      .select('*').single()
    if (error) return res.status(500).json({ error: error.message })
    // First address for this distributor, or explicitly asked for → default.
    const { count } = await c.from('b2b_distributor_addresses')
      .select('id', { count: 'exact', head: true })
      .eq('distributor_id', distributorId).eq('is_active', true)
    if (req.body?.is_default === true || (count || 0) <= 1) await makeDefault(data.id)
    return res.status(200).json({ ok: true, address: data })
  }

  if (req.method === 'PATCH') {
    const addressId = String(req.body?.address_id || '').trim()
    if (!addressId) return res.status(400).json({ error: 'address_id required' })
    const patch = clean(req.body || {})
    if ('postcode' in patch && !patch.postcode && patch.is_active !== false) {
      return res.status(400).json({ error: 'An active address needs a postcode — freight is priced on it.' })
    }
    if (Object.keys(patch).length > 0) {
      const { error } = await c.from('b2b_distributor_addresses')
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq('id', addressId).eq('distributor_id', distributorId)
      if (error) {
        if (/active_needs_postcode/.test(error.message || '')) {
          return res.status(400).json({ error: 'An active address needs a postcode — freight is priced on it.' })
        }
        return res.status(500).json({ error: error.message })
      }
    }
    if (req.body?.is_default === true) await makeDefault(addressId)
    const { data } = await c.from('b2b_distributor_addresses').select('*').eq('id', addressId).maybeSingle()
    return res.status(200).json({ ok: true, address: data })
  }

  if (req.method === 'DELETE') {
    const addressId = String(req.query.address_id || '').trim()
    if (!addressId) return res.status(400).json({ error: 'address_id required' })
    const { data: addr } = await c.from('b2b_distributor_addresses')
      .select('id, is_default').eq('id', addressId).eq('distributor_id', distributorId).maybeSingle()
    if (!addr) return res.status(404).json({ error: 'Address not found on this distributor' })
    // Refusing to strand them without a default: the cart and checkout both
    // fall back to it, so promote another site first.
    if (addr.is_default) {
      const { count } = await c.from('b2b_distributor_addresses')
        .select('id', { count: 'exact', head: true })
        .eq('distributor_id', distributorId).eq('is_active', true).neq('id', addressId)
      if ((count || 0) > 0) {
        return res.status(400).json({ error: 'That is the default delivery address. Make another site the default first, then remove this one.' })
      }
    }
    const { error } = await c.from('b2b_distributor_addresses')
      .update({ is_active: false, is_default: false, updated_at: new Date().toISOString() })
      .eq('id', addressId).eq('distributor_id', distributorId)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true, deactivated: addressId })
  }

  res.setHeader('Allow', 'GET, POST, PATCH, DELETE')
  return res.status(405).json({ error: 'GET, POST, PATCH or DELETE' })
})
