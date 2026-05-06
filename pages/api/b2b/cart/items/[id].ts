// pages/api/b2b/cart/items/[id].ts
//
// DELETE /api/b2b/cart/items/{id}  — removes a specific cart line.
//
// We verify the line belongs to the signed-in user's cart before deleting,
// so a malicious user can't delete another distributor's cart items by ID.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withB2BAuth, B2BUser } from '../../../../../lib/b2bAuthServer'

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

export default withB2BAuth(async (req: NextApiRequest, res: NextApiResponse, user: B2BUser) => {
  if (req.method !== 'DELETE') {
    res.setHeader('Allow', 'DELETE')
    return res.status(405).json({ error: 'DELETE only' })
  }

  const lineId = String(req.query.id || '').trim()
  if (!lineId) return res.status(400).json({ error: 'Missing line id' })

  const c = sb()

  // Verify ownership: line.cart_id must point at this user's cart
  const { data: line, error: lookupErr } = await c
    .from('b2b_cart_items')
    .select('id, cart_id, b2b_carts!b2b_cart_items_cart_id_fkey ( distributor_user_id )')
    .eq('id', lineId)
    .maybeSingle()
  if (lookupErr) return res.status(500).json({ error: lookupErr.message })
  if (!line) return res.status(404).json({ error: 'Line not found' })

  const cartUserId = Array.isArray((line as any).b2b_carts)
    ? (line as any).b2b_carts[0]?.distributor_user_id
    : (line as any).b2b_carts?.distributor_user_id
  if (cartUserId !== user.id) return res.status(403).json({ error: 'Forbidden' })

  const { error: delErr } = await c.from('b2b_cart_items').delete().eq('id', lineId)
  if (delErr) return res.status(500).json({ error: delErr.message })

  return res.status(200).json({ ok: true })
})
