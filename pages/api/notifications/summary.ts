// pages/api/notifications/summary.ts
// GET — one poll for everything the chrome needs: unread notification count
// per module (red badges on app tiles / sidebar rows + bell total) AND the
// messaging unread total (the Messages tile/Apps-button badge). Replaces the
// separate /api/messages/unread poll in PortalTopBar so each page makes a
// single 30s request.

import type { NextApiRequest, NextApiResponse } from 'next'
import { requireAuth, getSessionUser } from '../../../lib/auth'
import { notifSvc } from '../../../lib/notifications'
import { visibleNavSections } from '../../../lib/permissions'

export const config = { maxDuration: 10 }

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  return requireAuth(req, res, async () => {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
    const me = (await getSessionUser(req))!
    const sb = notifSvc()
    // Only surface notifications for modules this user can actually see
    // (respects role + per-user tab overrides). Notification `module` values
    // match DEFAULT_NAV ids.
    const allowed = new Set(visibleNavSections(me.role, me.visibleTabs))

    const [{ data: notifRows, error: nErr }, { data: msgRows }] = await Promise.all([
      sb.from('notifications').select('module').eq('user_id', me.id).is('read_at', null).limit(2000),
      sb.rpc('messaging_unread_counts', { p_user_id: me.id }),
    ])
    if (nErr) return res.status(500).json({ error: nErr.message })

    const byModule: Record<string, number> = {}
    let total = 0
    for (const r of notifRows || []) {
      if (!allowed.has(r.module)) continue
      byModule[r.module] = (byModule[r.module] || 0) + 1
      total++
    }
    const messages = allowed.has('messages')
      ? (msgRows || []).filter((r: any) => !r.muted).reduce((s: number, r: any) => s + Number(r.unread || 0), 0)
      : 0

    return res.status(200).json({ total, byModule, messages })
  })
}
