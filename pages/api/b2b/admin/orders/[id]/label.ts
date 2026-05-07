// pages/api/b2b/admin/orders/[id]/label.ts
// Returns a short-lived signed URL for an order's stored shipping label.
// Used by the admin order detail page's "Print label" / "Download label"
// buttons. Bucket is private — the URL must be fresh on each request.
//
// GET /api/b2b/admin/orders/{id}/label   → { url: string, ttlSeconds: number }
//   404 if no label is attached to the order.

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

const LABELS_BUCKET = 'b2b-shipping-labels'
const URL_TTL_SECONDS = 300  // 5 min — long enough to print/save, short enough not to leak

export default withAuth('admin:b2b', async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'GET only' })
  }
  const id = String(req.query.id || '').trim()
  if (!id) return res.status(400).json({ error: 'id required' })

  const c = sb()
  const { data: order, error } = await c
    .from('b2b_orders')
    .select('label_pdf_path')
    .eq('id', id)
    .maybeSingle()
  if (error)               return res.status(500).json({ error: error.message })
  if (!order)              return res.status(404).json({ error: 'Order not found' })
  if (!order.label_pdf_path) return res.status(404).json({ error: 'No label attached to this order' })

  const { data, error: signErr } = await c.storage
    .from(LABELS_BUCKET)
    .createSignedUrl(order.label_pdf_path, URL_TTL_SECONDS)
  if (signErr || !data?.signedUrl) {
    return res.status(500).json({ error: signErr?.message || 'Could not sign label URL' })
  }

  return res.status(200).json({ url: data.signedUrl, ttlSeconds: URL_TTL_SECONDS })
})
