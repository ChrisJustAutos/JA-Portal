// pages/api/messages/unread.ts
// GET — total unread message count for the current user (drives the cross-page
// nav badge). Counts non-own, non-deleted messages after each conversation's
// last_read_at, skipping muted conversations.

import type { NextApiRequest, NextApiResponse } from 'next'
import { requireAuth, getSessionUser } from '../../../lib/auth'
import { svc } from '../../../lib/messaging'

export const config = { maxDuration: 15 }

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  return requireAuth(req, res, async () => {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
    const me = (await getSessionUser(req))!
    const sb = svc()

    const { data: parts } = await sb.from('conversation_participants')
      .select('conversation_id, last_read_at, muted').eq('user_id', me.id)
    const active = (parts || []).filter(p => !p.muted)
    if (active.length === 0) return res.status(200).json({ total: 0 })

    const counts = await Promise.all(active.map(async p => {
      let qq = sb.from('conversation_messages').select('id', { count: 'exact', head: true })
        .eq('conversation_id', p.conversation_id).neq('sender_user_id', me.id).is('deleted_at', null)
      if (p.last_read_at) qq = qq.gt('created_at', p.last_read_at)
      const { count } = await qq
      return count || 0
    }))
    return res.status(200).json({ total: counts.reduce((a, b) => a + b, 0) })
  })
}
