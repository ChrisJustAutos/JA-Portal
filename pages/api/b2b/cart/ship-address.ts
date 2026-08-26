// POST /api/b2b/cart/ship-address  { address_id }
//
// Choose which of the distributor's delivery sites this cart is going to.
// Freight is priced on the destination postcode, so changing this changes the
// quote — the cart GET recomputes it on the next load.
//
// Only the caller's OWN distributor's addresses are accepted. The id comes from
// the browser, so without that check one distributor could quote (and ship) to
// another's address by posting a guessed uuid.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withB2BAuth, B2BUser } from '../../../../lib/b2bAuthServer'

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
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }) }
  const addressId = String(req.body?.address_id || '').trim()
  if (!addressId) return res.status(400).json({ error: 'address_id required' })

  const c = sb()

  // Must belong to THIS distributor and be usable.
  const { data: addr, error: aErr } = await c
    .from('b2b_distributor_addresses')
    .select('id, label, postcode')
    .eq('id', addressId)
    .eq('distributor_id', user.distributor.id)
    .eq('is_active', true)
    .maybeSingle()
  if (aErr) return res.status(500).json({ error: aErr.message })
  if (!addr) return res.status(404).json({ error: 'That delivery address is not available on your account.' })

  const { data: cart, error: cErr } = await c
    .from('b2b_carts')
    .select('id')
    .eq('distributor_user_id', user.id)
    .maybeSingle()
  if (cErr) return res.status(500).json({ error: cErr.message })
  if (!cart) return res.status(404).json({ error: 'No cart to update yet — add an item first.' })

  const { error: uErr } = await c.from('b2b_carts')
    .update({ ship_address_id: addr.id, updated_at: new Date().toISOString() })
    .eq('id', cart.id)
  if (uErr) return res.status(500).json({ error: uErr.message })

  return res.status(200).json({ ok: true, address_id: addr.id, label: addr.label, postcode: addr.postcode })
})
