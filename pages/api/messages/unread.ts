// pages/api/messages/unread.ts
// GET — total unread message count for the current user (drives the cross-page
// nav badge, polled by the top bar every 30s). Counts non-own, non-deleted
// messages after each conversation's last_read_at, skipping muted
// conversations. One RPC call (migration 064) instead of a count query per
// conversation.

import type { NextApiRequest, NextApiResponse } from 'next'
import { requireAuth, getSessionUser } from '../../../lib/auth'
import { svc } from '../../../lib/messaging'

export const config = { maxDuration: 15 }

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  return requireAuth(req, res, async () => {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
    const me = (await getSessionUser(req))!

    const { data, error } = await svc().rpc('messaging_unread_counts', { p_user_id: me.id })
    if (error) return res.status(500).json({ error: error.message })
    const total = (data || []).filter((r: any) => !r.muted).reduce((s: number, r: any) => s + Number(r.unread || 0), 0)
    return res.status(200).json({ total })
  })
}
