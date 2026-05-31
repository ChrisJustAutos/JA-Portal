// pages/api/conversations/index.ts
// GET  — list the current user's conversations (channels they're in + public
//        channels + DMs/groups + customer inbox if permitted) with unread counts.
// POST — create a conversation: { type, name?, topic?, isPrivate?, memberIds?, dmUserId? }

import type { NextApiRequest, NextApiResponse } from 'next'
import { requireAuth } from '../../../lib/auth'
import { getSessionUser } from '../../../lib/auth'
import { svc, userDirectory, INBOX_ROLES } from '../../../lib/messaging'

export const config = { maxDuration: 20 }

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  return requireAuth(req, res, async () => {
    const me = (await getSessionUser(req))!
    const sb = svc()

    if (req.method === 'GET') {
      // Conversations I'm a member of (+ my last_read_at).
      const { data: myParts } = await sb.from('conversation_participants')
        .select('conversation_id, last_read_at, muted').eq('user_id', me.id)
      const myConvIds = new Set((myParts || []).map(p => p.conversation_id))
      const lastReadByConv: Record<string, string | null> = {}
      const mutedByConv: Record<string, boolean> = {}
      for (const p of myParts || []) { lastReadByConv[p.conversation_id] = p.last_read_at; mutedByConv[p.conversation_id] = p.muted }

      // Public channels (joinable) + customer inbox (if permitted).
      const orParts = ['and(type.eq.channel,is_private.eq.false)']
      if (INBOX_ROLES.includes(me.role)) orParts.push('type.eq.customer')
      const { data: visibleExtra } = await sb.from('conversations')
        .select('id').or(orParts.join(',')).is('archived_at', null)
      const allIds = Array.from(new Set(Array.from(myConvIds).concat((visibleExtra || []).map(c => c.id))))
      if (allIds.length === 0) return res.status(200).json({ conversations: [] })

      const { data: convs } = await sb.from('conversations')
        .select('id, type, name, topic, is_private, source, customer_id, assigned_user_id, status, last_message_at, created_by')
        .in('id', allIds).is('archived_at', null).order('last_message_at', { ascending: false, nullsFirst: false })

      // Participants for naming (DMs/groups) + unread counts.
      const { data: parts } = await sb.from('conversation_participants')
        .select('conversation_id, user_id').in('conversation_id', allIds)
      const partsByConv: Record<string, string[]> = {}
      for (const p of parts || []) (partsByConv[p.conversation_id] ||= []).push(p.user_id)
      const dir = await userDirectory((parts || []).map(p => p.user_id))

      // Unread = my messages-since-last-read per conversation I'm a member of.
      const unreadByConv: Record<string, number> = {}
      await Promise.all((convs || []).filter(c => myConvIds.has(c.id)).map(async c => {
        const since = lastReadByConv[c.id]
        let q = sb.from('conversation_messages').select('id', { count: 'exact', head: true })
          .eq('conversation_id', c.id).neq('sender_user_id', me.id).is('deleted_at', null)
        if (since) q = q.gt('created_at', since)
        const { count } = await q
        unreadByConv[c.id] = count || 0
      }))

      const conversations = (convs || []).map(c => {
        const members = (partsByConv[c.id] || [])
        // DM display name = the other participant.
        let displayName = c.name
        if (c.type === 'dm') {
          const other = members.find(uid => uid !== me.id) || members[0]
          displayName = other ? dir[other]?.name || 'Direct message' : 'Direct message'
        }
        return {
          ...c,
          displayName,
          isMember: myConvIds.has(c.id),
          muted: !!mutedByConv[c.id],
          unread: unreadByConv[c.id] || 0,
          memberIds: members,
          memberNames: members.map(uid => dir[uid]?.name).filter(Boolean),
        }
      })
      return res.status(200).json({ conversations })
    }

    if (req.method === 'POST') {
      const { type, name, topic, isPrivate, memberIds, dmUserId } = req.body || {}
      if (!['channel', 'dm', 'group'].includes(type)) return res.status(400).json({ error: 'Invalid type' })

      if (type === 'dm') {
        if (!dmUserId || dmUserId === me.id) return res.status(400).json({ error: 'dmUserId required' })
        // Find an existing 1:1 dm between the two users.
        const { data: mine } = await sb.from('conversation_participants').select('conversation_id').eq('user_id', me.id)
        const myIds = (mine || []).map(r => r.conversation_id)
        if (myIds.length) {
          const { data: shared } = await sb.from('conversation_participants')
            .select('conversation_id').eq('user_id', dmUserId).in('conversation_id', myIds)
          for (const s of shared || []) {
            const { data: c } = await sb.from('conversations').select('id, type').eq('id', s.conversation_id).maybeSingle()
            if (c?.type === 'dm') return res.status(200).json({ conversationId: c.id, existing: true })
          }
        }
        const { data: conv, error } = await sb.from('conversations')
          .insert({ type: 'dm', created_by: me.id }).select('id').single()
        if (error) return res.status(500).json({ error: error.message })
        await sb.from('conversation_participants').insert([
          { conversation_id: conv.id, user_id: me.id, role: 'member' },
          { conversation_id: conv.id, user_id: dmUserId, role: 'member' },
        ])
        return res.status(200).json({ conversationId: conv.id })
      }

      // channel | group
      if (type === 'channel' && !name?.trim()) return res.status(400).json({ error: 'Channel name required' })
      const { data: conv, error } = await sb.from('conversations')
        .insert({ type, name: name?.trim() || null, topic: topic?.trim() || null, is_private: type === 'group' ? true : !!isPrivate, created_by: me.id })
        .select('id').single()
      if (error) return res.status(500).json({ error: error.message })
      const members = Array.from(new Set([me.id, ...((memberIds || []) as string[])]))
      await sb.from('conversation_participants').insert(
        members.map(uid => ({ conversation_id: conv.id, user_id: uid, role: uid === me.id ? 'admin' : 'member' }))
      )
      return res.status(200).json({ conversationId: conv.id })
    }

    return res.status(405).json({ error: 'Method not allowed' })
  })
}
