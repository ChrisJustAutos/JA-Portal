// pages/api/notifications/index.ts
// GET   — latest 50 notifications for the current user (bell dropdown).
// PATCH — mark read: { id } for one, { all: true } for everything unread.

import type { NextApiRequest, NextApiResponse } from 'next'
import { requireAuth, getSessionUser } from '../../../lib/auth'
import { notifSvc } from '../../../lib/notifications'

export const config = { maxDuration: 10 }

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  return requireAuth(req, res, async () => {
    const me = (await getSessionUser(req))!
    const sb = notifSvc()

    if (req.method === 'GET') {
      const { data, error } = await sb.from('notifications')
        .select('id, module, title, body, href, created_at, read_at')
        .eq('user_id', me.id)
        .order('created_at', { ascending: false })
        .limit(50)
      if (error) return res.status(500).json({ error: error.message })
      return res.status(200).json({ notifications: data || [] })
    }

    if (req.method === 'PATCH') {
      let body: any = {}
      try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
      catch { return res.status(400).json({ error: 'Bad JSON body' }) }
      const nowIso = new Date().toISOString()
      let q = sb.from('notifications').update({ read_at: nowIso })
        .eq('user_id', me.id).is('read_at', null)
      if (body.all === true) { /* all unread */ }
      else if (body.id) q = q.eq('id', String(body.id))
      else return res.status(400).json({ error: 'id or all:true required' })
      const { error } = await q
      if (error) return res.status(500).json({ error: error.message })
      return res.status(200).json({ ok: true })
    }

    res.setHeader('Allow', 'GET, PATCH')
    return res.status(405).json({ error: 'GET or PATCH only' })
  })
}
