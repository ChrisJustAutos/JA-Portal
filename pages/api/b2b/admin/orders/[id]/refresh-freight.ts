// pages/api/b2b/admin/orders/[id]/refresh-freight.ts
//
// Admin endpoint that re-polls MachShip for the current state of a
// booked consignment and updates the order accordingly.
//
//   POST /api/b2b/admin/orders/{id}/refresh-freight  (no body)
//     → { ok, order: { status, freight_status, freight_eta_at,
//                      last_freight_poll_at, tracking_number } }
//
// Used by:
//   - The "Refresh from MachShip" button on the admin order page.
//   - The 30-minute cron poller, which loops in-flight orders and
//     calls refreshOrderFreight() directly (so it doesn't need to
//     re-hit this HTTP endpoint for each one).

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../../../lib/authServer'
import { refreshOrderFreight } from '../../../../../../lib/b2b-machship-refresh'

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

export default withAuth('admin:b2b', async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'POST only' })
  }
  const id = String(req.query.id || '').trim()
  if (!id) return res.status(400).json({ error: 'id required' })

  const result = await refreshOrderFreight(sb(), id)
  if (!result.ok) {
    return res.status(result.status || 500).json({ error: result.error })
  }
  return res.status(200).json({ ok: true, order: result.order })
})
