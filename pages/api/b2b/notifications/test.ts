// pages/api/b2b/notifications/test.ts
// POST — send the current distributor user a test push, so they can confirm
// their device is registered without waiting for a real order event.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { withB2BAuth } from '../../../../lib/b2bAuthServer'
import { sendPushToB2BUsers } from '../../../../lib/push'

export const config = { maxDuration: 10 }

export default withB2BAuth(async (req: NextApiRequest, res: NextApiResponse, user) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
  const title = 'Test notification 🎉'
  const body = 'Notifications are working — you’ll get order & shipping updates here.'
  // Persist a bell row + push, so the test exercises both.
  try {
    const c = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
    await c.from('b2b_notifications').insert({ b2b_user_id: user.id, title, body, href: '/b2b/orders' })
  } catch { /* non-fatal */ }
  await sendPushToB2BUsers([user.id], { title, body, href: '/b2b/orders', tag: 'b2b-test' })
  return res.status(200).json({ ok: true })
})
