// pages/api/messages/search.ts
// GET ?q= — full-text-ish search across messages in conversations the user can
// see (their memberships + public channels + customer inbox if permitted).

import type { NextApiRequest, NextApiResponse } from 'next'
import { requireAuth, getSessionUser } from '../../../lib/auth'
import { svc, userDirectory, INBOX_ROLES } from '../../../lib/messaging'

export const config = { maxDuration: 15 }

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  return requireAuth(req, res, async () => {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
    const me = (await getSessionUser(req))!
    const sb = svc()
    const q = String(req.query.q || '').trim()
    if (q.length < 2) return res.status(200).json({ results: [] })

    // Conversations the user can see.
    const { data: myParts } = await sb.from('conversation_participants').select('conversation_id').eq('user_id', me.id)
    const orParts = ['and(type.eq.channel,is_private.eq.false)']
    if (INBOX_ROLES.includes(me.role)) orParts.push('type.eq.customer')
    const { data: extra } = await sb.from('conversations').select('id').or(orParts.join(',')).is('archived_at', null)
    const convIds = Array.from(new Set((myParts || []).map(p => p.conversation_id).concat((extra || []).map(c => c.id))))
    if (convIds.length === 0) return res.status(200).json({ results: [] })

    const esc = q.replace(/[%_]/g, '\\$&')
    const { data: rows } = await sb.from('conversation_messages')
      .select('id, conversation_id, sender_user_id, body, created_at')
      .in('conversation_id', convIds)
      .is('deleted_at', null)
      .ilike('body', `%${esc}%`)
      .order('created_at', { ascending: false })
      .limit(40)

    const convNames: Record<string, string> = {}
    const { data: convs } = await sb.from('conversations').select('id, type, name').in('id', Array.from(new Set((rows || []).map(r => r.conversation_id))))
    for (const c of convs || []) convNames[c.id] = c.name || (c.type === 'dm' ? 'Direct message' : c.type === 'customer' ? 'Customer' : 'Conversation')
    const dir = await userDirectory((rows || []).map(r => r.sender_user_id).filter(Boolean) as string[])

    return res.status(200).json({
      results: (rows || []).map(r => ({
        id: r.id, conversationId: r.conversation_id, conversationName: convNames[r.conversation_id] || 'Conversation',
        senderName: r.sender_user_id ? (dir[r.sender_user_id]?.name || 'Unknown') : 'System',
        body: r.body, created_at: r.created_at,
      })),
    })
  })
}
