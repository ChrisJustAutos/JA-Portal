// pages/api/notifications/push-subscribe.ts
// Store / remove this browser's Web Push subscription for the current user.
//   POST   { endpoint, keys:{ p256dh, auth } }  — upsert (called after the
//          browser grants permission and pushManager.subscribe succeeds)
//   DELETE { endpoint }                          — remove (on unsubscribe)

import type { NextApiRequest, NextApiResponse } from 'next'
import { requireAuth, getSessionUser } from '../../../lib/auth'
import { notifSvc } from '../../../lib/notifications'

export const config = { maxDuration: 10 }

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  return requireAuth(req, res, async () => {
    const me = (await getSessionUser(req))!
    const sb = notifSvc()
    let body: any = {}
    try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
    catch { return res.status(400).json({ error: 'Bad JSON body' }) }

    if (req.method === 'POST') {
      const endpoint = String(body.endpoint || '')
      const p256dh = String(body?.keys?.p256dh || '')
      const auth = String(body?.keys?.auth || '')
      if (!endpoint || !p256dh || !auth) return res.status(400).json({ error: 'endpoint + keys required' })
      const { error } = await sb.from('push_subscriptions').upsert({
        user_id: me.id,
        endpoint,
        p256dh,
        auth,
        user_agent: String(req.headers['user-agent'] || '').slice(0, 300),
        last_used_at: new Date().toISOString(),
      }, { onConflict: 'endpoint' })
      if (error) return res.status(500).json({ error: error.message })
      return res.status(200).json({ ok: true })
    }

    if (req.method === 'DELETE') {
      const endpoint = String(body.endpoint || '')
      if (!endpoint) return res.status(400).json({ error: 'endpoint required' })
      await sb.from('push_subscriptions').delete().eq('endpoint', endpoint)
      return res.status(200).json({ ok: true })
    }

    res.setHeader('Allow', 'POST, DELETE')
    return res.status(405).json({ error: 'POST or DELETE only' })
  })
}
