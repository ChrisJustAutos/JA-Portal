// pages/api/notifications/index.ts
// GET    — latest 50 notifications for the current user (bell dropdown).
// PATCH  — mark read: { id } for one, { all: true } for everything unread.
// DELETE — remove: { id } for one, { all: true } for everything.

import type { NextApiRequest, NextApiResponse } from 'next'
import { requireAuth, getSessionUser } from '../../../lib/auth'
import { notifSvc, mutedModulesForUser } from '../../../lib/notifications'
import { visibleNavSections } from '../../../lib/permissions'

export const config = { maxDuration: 10 }

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  return requireAuth(req, res, async () => {
    const me = (await getSessionUser(req))!
    const sb = notifSvc()

    if (req.method === 'GET') {
      // Only list notifications for modules this user can access AND hasn't muted.
      const allowed = new Set(visibleNavSections(me.role, me.visibleTabs))
      const [{ data, error }, muted] = await Promise.all([
        sb.from('notifications')
          .select('id, module, title, body, href, created_at, read_at')
          .eq('user_id', me.id)
          .order('created_at', { ascending: false })
          .limit(80),
        mutedModulesForUser(me.id),
      ])
      if (error) return res.status(500).json({ error: error.message })
      const notifications = (data || []).filter(n => allowed.has(n.module) && !muted.has(n.module)).slice(0, 50)
      return res.status(200).json({ notifications })
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

    if (req.method === 'DELETE') {
      let body: any = {}
      try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
      catch { return res.status(400).json({ error: 'Bad JSON body' }) }
      let q = sb.from('notifications').delete().eq('user_id', me.id)
      if (body.all === true) { /* everything */ }
      else if (body.id) q = q.eq('id', String(body.id))
      else return res.status(400).json({ error: 'id or all:true required' })
      const { error } = await q
      if (error) return res.status(500).json({ error: error.message })
      return res.status(200).json({ ok: true })
    }

    res.setHeader('Allow', 'GET, PATCH, DELETE')
    return res.status(405).json({ error: 'GET, PATCH or DELETE only' })
  })
}
