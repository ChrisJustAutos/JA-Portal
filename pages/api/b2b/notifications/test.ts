// pages/api/b2b/notifications/test.ts
// POST — send the current distributor user a test push, so they can confirm
// their device is registered without waiting for a real order event.

import type { NextApiRequest, NextApiResponse } from 'next'
import { withB2BAuth } from '../../../../lib/b2bAuthServer'
import { sendPushToB2BUsers } from '../../../../lib/push'

export const config = { maxDuration: 10 }

export default withB2BAuth(async (req: NextApiRequest, res: NextApiResponse, user) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
  await sendPushToB2BUsers([user.id], {
    title: 'Test notification 🎉',
    body: 'Notifications are working — you’ll get order & shipping updates here.',
    href: '/b2b/orders',
    tag: 'b2b-test',
  })
  return res.status(200).json({ ok: true })
})
