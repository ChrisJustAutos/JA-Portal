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
      // Conversations I'm a member of (+ my mute state), and public channels
      // (joinable) + customer inbox (if permitted) — independent, in parallel.
      const orParts = ['and(type.eq.channel,is_private.eq.false)']
      if (INBOX_ROLES.includes(me.role)) orParts.push('type.eq.customer')
      const [{ data: myParts }, { data: visibleExtra }] = await Promise.all([
        sb.from('conversation_participants').select('conversation_id, muted, last_read_at').eq('user_id', me.id),
        sb.from('conversations').select('id').or(orParts.join(',')).is('archived_at', null),
      ])
      const myConvIds = new Set((myParts || []).map(p => p.conversation_id))
      const mutedByConv: Record<string, boolean> = {}
      const myReadByConv: Record<string, string | null> = {}
      for (const p of myParts || []) { mutedByConv[p.conversation_id] = p.muted; myReadByConv[p.conversation_id] = p.last_read_at }
      const allIds = Array.from(new Set(Array.from(myConvIds).concat((visibleExtra || []).map(c => c.id))))
      if (allIds.length === 0) return res.status(200).json({ conversations: [] })

      // Conversations + participants + unread counts in parallel (unread = one
      // GROUP BY RPC, migration 064 — not a count query per conversation).
      const [{ data: convs }, { data: parts }, { data: unreadRows }] = await Promise.all([
        sb.from('conversations')
          .select('id, type, name, topic, is_private, source, customer_id, assigned_user_id, status, last_message_at, created_by')
          .in('id', allIds).is('archived_at', null).order('last_message_at', { ascending: false, nullsFirst: false }),
        sb.from('conversation_participants')
          .select('conversation_id, user_id, last_read_at').in('conversation_id', allIds),
        sb.rpc('messaging_unread_counts', { p_user_id: me.id }),
      ])
      const partsByConv: Record<string, string[]> = {}
      // readState: per conversation, each OTHER participant's last_read_at — used
      // to render 'Seen' / read receipts on the client (my own messages).
      const readByConv: Record<string, Record<string, string | null>> = {}
      for (const p of parts || []) {
        (partsByConv[p.conversation_id] ||= []).push(p.user_id)
        if (p.user_id !== me.id) (readByConv[p.conversation_id] ||= {})[p.user_id] = p.last_read_at
      }
      const dir = await userDirectory((parts || []).map(p => p.user_id))

      const unreadByConv: Record<string, number> = {}
      for (const r of unreadRows || []) unreadByConv[r.conversation_id] = Number(r.unread || 0)

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
          myLastReadAt: myReadByConv[c.id] || null,
          readState: readByConv[c.id] || {},
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
