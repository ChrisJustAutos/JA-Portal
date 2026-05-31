// pages/api/messages/[id].ts
// PATCH  { body }   — edit own message
// DELETE            — soft-delete own message
// POST   { emoji }  — toggle a reaction on a message (any member)

import type { NextApiRequest, NextApiResponse } from 'next'
import { requireAuth, getSessionUser } from '../../../lib/auth'
import { svc, getConversation, canAccessConversation } from '../../../lib/messaging'

export const config = { maxDuration: 15 }

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  return requireAuth(req, res, async () => {
    const me = (await getSessionUser(req))!
    const sb = svc()
    const id = String(req.query.id || '')

    const { data: msg } = await sb.from('conversation_messages')
      .select('id, conversation_id, sender_user_id, deleted_at').eq('id', id).maybeSingle()
    if (!msg) return res.status(404).json({ error: 'Not found' })
    const conv = await getConversation(msg.conversation_id)
    if (!conv || !(await canAccessConversation(conv, me.id, me.role))) return res.status(403).json({ error: 'Forbidden' })

    if (req.method === 'POST') {
      const emoji = String((req.body || {}).emoji || '').trim()
      if (!emoji) return res.status(400).json({ error: 'emoji required' })
      const { data: existing } = await sb.from('message_reactions')
        .select('message_id').eq('message_id', id).eq('user_id', me.id).eq('emoji', emoji).maybeSingle()
      if (existing) await sb.from('message_reactions').delete().eq('message_id', id).eq('user_id', me.id).eq('emoji', emoji)
      else await sb.from('message_reactions').insert({ message_id: id, user_id: me.id, emoji })
      return res.status(200).json({ ok: true, on: !existing })
    }

    // Edit / delete are author-only.
    if (msg.sender_user_id !== me.id) return res.status(403).json({ error: 'Not your message' })

    if (req.method === 'PATCH') {
      const body = String((req.body || {}).body || '').trim()
      if (!body) return res.status(400).json({ error: 'Empty' })
      await sb.from('conversation_messages').update({ body, edited_at: new Date().toISOString() }).eq('id', id)
      return res.status(200).json({ ok: true })
    }

    if (req.method === 'DELETE') {
      await sb.from('conversation_messages').update({ deleted_at: new Date().toISOString(), body: '' }).eq('id', id)
      return res.status(200).json({ ok: true })
    }

    return res.status(405).json({ error: 'Method not allowed' })
  })
}
