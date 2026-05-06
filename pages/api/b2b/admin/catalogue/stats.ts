// pages/api/b2b/admin/catalogue/stats.ts
// GET /api/b2b/admin/catalogue/stats
// Returns: { total, visible, priced, lastSyncAt, lastSyncAdded, lastSyncUpdated, lastSyncError }

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../../lib/authServer'

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

export default withAuth('view:b2b', async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'GET only' })
  }

  const c = sb()

  const [totalRes, visibleRes, pricedRes, settingsRes] = await Promise.all([
    c.from('b2b_catalogue').select('id', { count: 'exact', head: true }),
    c.from('b2b_catalogue').select('id', { count: 'exact', head: true }).eq('b2b_visible', true),
    c.from('b2b_catalogue').select('id', { count: 'exact', head: true }).gt('trade_price_ex_gst', 0),
    c.from('b2b_settings')
      .select('last_catalogue_sync_at, last_catalogue_sync_added, last_catalogue_sync_updated, last_catalogue_sync_error')
      .eq('id', 'singleton')
      .maybeSingle(),
  ])

  if (totalRes.error)   return res.status(500).json({ error: `total: ${totalRes.error.message}` })
  if (visibleRes.error) return res.status(500).json({ error: `visible: ${visibleRes.error.message}` })
  if (pricedRes.error)  return res.status(500).json({ error: `priced: ${pricedRes.error.message}` })

  return res.status(200).json({
    total:           totalRes.count ?? 0,
    visible:         visibleRes.count ?? 0,
    priced:          pricedRes.count ?? 0,
    lastSyncAt:      settingsRes.data?.last_catalogue_sync_at ?? null,
    lastSyncAdded:   settingsRes.data?.last_catalogue_sync_added ?? null,
    lastSyncUpdated: settingsRes.data?.last_catalogue_sync_updated ?? null,
    lastSyncError:   settingsRes.data?.last_catalogue_sync_error ?? null,
  })
})
