// pages/api/conversations/[id].ts
// GET   — conversation detail + participants (access-checked)
// PATCH — { action:'read' } mark read · { action:'join' } join public channel
//         · { name, topic } rename · { addMembers:[ids] } · { assignedUserId } (inbox)

import type { NextApiRequest, NextApiResponse } from 'next'
import { requireAuth, getSessionUser } from '../../../lib/auth'
import { svc, getConversation, canAccessConversation, isMember, userDirectory } from '../../../lib/messaging'

export const config = { maxDuration: 20 }

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  return requireAuth(req, res, async () => {
    const me = (await getSessionUser(req))!
    const sb = svc()
    const id = String(req.query.id || '')
    const conv = await getConversation(id)
    if (!conv) return res.status(404).json({ error: 'Not found' })
    if (!(await canAccessConversation(conv, me.id, me.role))) return res.status(403).json({ error: 'Forbidden' })

    if (req.method === 'GET') {
      const { data: parts } = await sb.from('conversation_participants')
        .select('user_id, role, last_read_at, muted').eq('conversation_id', id)
      const dir = await userDirectory((parts || []).map(p => p.user_id))
      return res.status(200).json({
        conversation: conv,
        participants: (parts || []).map(p => ({ ...p, name: dir[p.user_id]?.name || p.user_id, email: dir[p.user_id]?.email })),
        isMember: (parts || []).some(p => p.user_id === me.id),
      })
    }

    if (req.method === 'PATCH') {
      const body = req.body || {}

      if (body.action === 'read') {
        await sb.from('conversation_participants')
          .update({ last_read_at: new Date().toISOString() })
          .eq('conversation_id', id).eq('user_id', me.id)
        // Clear this conversation's message notifications from the bell.
        await sb.from('notifications')
          .update({ read_at: new Date().toISOString() })
          .eq('user_id', me.id).eq('module', 'messages').eq('href', `/messages?c=${id}`).is('read_at', null)
          .then(() => {}, () => {})
        return res.status(200).json({ ok: true })
      }

      if (body.action === 'join') {
        if (conv.type !== 'channel' || conv.is_private) return res.status(400).json({ error: 'Not joinable' })
        if (!(await isMember(id, me.id))) {
          await sb.from('conversation_participants').insert({ conversation_id: id, user_id: me.id, role: 'member' })
        }
        return res.status(200).json({ ok: true })
      }

      // Mutations below require membership.
      if (!(await isMember(id, me.id))) return res.status(403).json({ error: 'Not a member' })

      if (Array.isArray(body.addMembers) && body.addMembers.length) {
        const rows = (body.addMembers as string[]).map(uid => ({ conversation_id: id, user_id: uid, role: 'member' as const }))
        await sb.from('conversation_participants').upsert(rows, { onConflict: 'conversation_id,user_id', ignoreDuplicates: true })
      }
      const patch: Record<string, any> = {}
      if (typeof body.name === 'string') patch.name = body.name.trim() || null
      if (typeof body.topic === 'string') patch.topic = body.topic.trim() || null
      if (typeof body.assignedUserId !== 'undefined' && conv.type === 'customer') patch.assigned_user_id = body.assignedUserId
      if (typeof body.status === 'string' && conv.type === 'customer') patch.status = body.status
      if (Object.keys(patch).length) await sb.from('conversations').update(patch).eq('id', id)

      return res.status(200).json({ ok: true })
    }

    return res.status(405).json({ error: 'Method not allowed' })
  })
}
