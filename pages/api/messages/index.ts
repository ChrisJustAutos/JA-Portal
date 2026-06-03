// pages/api/messages/index.ts
// GET  ?conversationId=&before=&limit=  — messages (oldest→newest) with sender,
//        attachments, mentions. Access-checked.
// POST  { conversationId, body, parentMessageId?, mentionIds?, attachments? }
//        — send a message into an internal conversation.

import type { NextApiRequest, NextApiResponse } from 'next'
import { requireAuth, getSessionUser } from '../../../lib/auth'
import { svc, getConversation, canAccessConversation, isMember, userDirectory } from '../../../lib/messaging'

export const config = { maxDuration: 20 }

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  return requireAuth(req, res, async () => {
    const me = (await getSessionUser(req))!
    const sb = svc()

    if (req.method === 'GET') {
      const conversationId = String(req.query.conversationId || '')
      const conv = await getConversation(conversationId)
      if (!conv) return res.status(404).json({ error: 'Not found' })
      if (!(await canAccessConversation(conv, me.id, me.role))) return res.status(403).json({ error: 'Forbidden' })

      const limit = Math.min(parseInt(String(req.query.limit || '60'), 10) || 60, 200)
      const before = req.query.before ? String(req.query.before) : null
      // parentId set → thread replies (ascending). Otherwise the main timeline
      // (top-level only; thread replies are hidden from it).
      const parentId = req.query.parentId ? String(req.query.parentId) : null
      let q = sb.from('conversation_messages')
        .select('id, conversation_id, sender_user_id, parent_message_id, body, message_type, direction, created_at, edited_at, deleted_at')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: false })
        .limit(limit)
      if (parentId) q = q.eq('parent_message_id', parentId)
      else q = q.is('parent_message_id', null)
      if (before) q = q.lt('created_at', before)
      const { data: rows, error } = await q
      if (error) return res.status(500).json({ error: error.message })
      const msgs = (rows || []).reverse()
      const ids = msgs.map(m => m.id)

      const [{ data: atts }, { data: ments }, { data: reacts }, { data: children }, dir] = await Promise.all([
        ids.length ? sb.from('message_attachments').select('id, message_id, storage_path, filename, content_type, size_bytes').in('message_id', ids) : Promise.resolve({ data: [] as any[] }),
        ids.length ? sb.from('message_mentions').select('message_id, mentioned_user_id').in('message_id', ids) : Promise.resolve({ data: [] as any[] }),
        ids.length ? sb.from('message_reactions').select('message_id, user_id, emoji').in('message_id', ids) : Promise.resolve({ data: [] as any[] }),
        (!parentId && ids.length) ? sb.from('conversation_messages').select('parent_message_id').in('parent_message_id', ids).is('deleted_at', null) : Promise.resolve({ data: [] as any[] }),
        userDirectory(msgs.map(m => m.sender_user_id).filter(Boolean) as string[]),
      ])
      const attByMsg: Record<string, any[]> = {}
      for (const a of atts || []) (attByMsg[a.message_id] ||= []).push(a)
      const mentByMsg: Record<string, string[]> = {}
      for (const m of ments || []) (mentByMsg[m.message_id] ||= []).push(m.mentioned_user_id)
      // Reactions grouped per message+emoji, with count and whether *I* reacted.
      const reactByMsg: Record<string, Record<string, { count: number; mine: boolean }>> = {}
      for (const r of reacts || []) {
        const g = (reactByMsg[r.message_id] ||= {})
        const e = (g[r.emoji] ||= { count: 0, mine: false })
        e.count++; if (r.user_id === me.id) e.mine = true
      }
      const replyCount: Record<string, number> = {}
      for (const c of children || []) replyCount[c.parent_message_id] = (replyCount[c.parent_message_id] || 0) + 1

      return res.status(200).json({
        messages: msgs.map(m => ({
          ...m,
          senderName: m.sender_user_id ? (dir[m.sender_user_id]?.name || 'Unknown') : (m.message_type === 'external' ? 'Customer' : 'System'),
          attachments: attByMsg[m.id] || [],
          mentions: mentByMsg[m.id] || [],
          reactions: Object.entries(reactByMsg[m.id] || {}).map(([emoji, v]) => ({ emoji, count: v.count, mine: v.mine })),
          replyCount: replyCount[m.id] || 0,
        })),
        hasMore: (rows || []).length === limit,
      })
    }

    if (req.method === 'POST') {
      const { conversationId, body, parentMessageId, mentionIds, attachments } = req.body || {}
      if (!conversationId) return res.status(400).json({ error: 'conversationId required' })
      const text = String(body || '').trim()
      const atts = Array.isArray(attachments) ? attachments : []
      if (!text && atts.length === 0) return res.status(400).json({ error: 'Empty message' })

      const conv = await getConversation(conversationId)
      if (!conv) return res.status(404).json({ error: 'Not found' })
      if (!(await canAccessConversation(conv, me.id, me.role))) return res.status(403).json({ error: 'Forbidden' })

      // External replies (WhatsApp/Messenger/Instagram) land in a later phase.
      if (conv.type === 'customer') {
        return res.status(400).json({ error: 'External replies are not enabled yet (coming in the WhatsApp/Messenger phase).' })
      }

      // Auto-join a public channel on first post.
      if (!(await isMember(conversationId, me.id))) {
        if (conv.type === 'channel' && !conv.is_private) {
          await sb.from('conversation_participants').insert({ conversation_id: conversationId, user_id: me.id, role: 'member' })
        } else {
          return res.status(403).json({ error: 'Not a member' })
        }
      }

      const { data: msg, error } = await sb.from('conversation_messages')
        .insert({ conversation_id: conversationId, sender_user_id: me.id, parent_message_id: parentMessageId || null, body: text, message_type: 'user' })
        .select('id, conversation_id, sender_user_id, parent_message_id, body, message_type, created_at').single()
      if (error) return res.status(500).json({ error: error.message })

      if (Array.isArray(mentionIds) && mentionIds.length) {
        await sb.from('message_mentions').insert(
          Array.from(new Set(mentionIds as string[])).map(uid => ({ message_id: msg.id, mentioned_user_id: uid }))
        ).then(() => {}, () => {})
      }
      if (atts.length) {
        await sb.from('message_attachments').insert(
          atts.map((a: any) => ({ message_id: msg.id, storage_path: a.storagePath, filename: a.filename, content_type: a.contentType, size_bytes: a.sizeBytes }))
        ).then(() => {}, () => {})
      }
      // Mark my own read pointer forward.
      await sb.from('conversation_participants').update({ last_read_at: new Date().toISOString() })
        .eq('conversation_id', conversationId).eq('user_id', me.id)

      // Background Web Push to the other (non-muted) participants — pops a
      // desktop/mobile notification even when their app is closed. Best-effort.
      try {
        const { data: parts } = await sb.from('conversation_participants')
          .select('user_id, muted').eq('conversation_id', conversationId)
        const recipients = (parts || [])
          .filter((p: any) => p.user_id && p.user_id !== me.id && !p.muted)
          .map((p: any) => p.user_id)
        if (recipients.length) {
          const senderName = me.displayName || 'New message'
          const convLabel = conv.type === 'dm' ? senderName : `${conv.name || 'Channel'} · ${senderName}`
          const { sendPushToUsers } = await import('../../../lib/push')
          await sendPushToUsers(recipients, {
            title: convLabel,
            body: text ? text.slice(0, 140) : 'Sent an attachment',
            href: `/messages?c=${conversationId}`,
            tag: `conv-${conversationId}`,   // one rolling toast per conversation
          })
        }
      } catch (e: any) { console.error('message push failed (non-fatal):', e?.message || e) }

      const dir = await userDirectory([me.id])
      return res.status(200).json({ message: { ...msg, senderName: dir[me.id]?.name || me.displayName, attachments: atts, mentions: mentionIds || [] } })
    }

    return res.status(405).json({ error: 'Method not allowed' })
  })
}
