// lib/realtime.ts
// Client-side Supabase Realtime helpers for the chat platform. This is the
// portal's first use of client Realtime — everything else polls.
//
// RLS is the delivery boundary: the authenticated client only receives rows it
// can SELECT (see migration 046). We MUST hand the user's JWT to the Realtime
// socket (`realtime.setAuth`) or it falls back to the anon role and RLS hides
// everything. Writes still go through service-role API routes; these
// subscriptions are read-only live delivery.

import type { RealtimeChannel } from '@supabase/supabase-js'
import { getSupabase } from './supabaseClient'

// Push the current access token onto the Realtime socket so RLS sees the user.
export async function ensureRealtimeAuth(): Promise<void> {
  const sb = getSupabase()
  const { data } = await sb.auth.getSession()
  const token = data.session?.access_token
  if (token) sb.realtime.setAuth(token)
}

export interface ConversationHandlers {
  onMessageInsert?: (row: any) => void
  onMessageUpdate?: (row: any) => void
  onReaction?: (row: any, eventType: 'INSERT' | 'UPDATE' | 'DELETE') => void
}

// Live updates for a single open conversation (new/edited messages + reactions).
export function subscribeToConversation(conversationId: string, h: ConversationHandlers): () => void {
  const sb = getSupabase()
  let ch: RealtimeChannel | null = null
  ensureRealtimeAuth().then(() => {
    ch = sb.channel(`conv:${conversationId}`)
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'conversation_messages', filter: `conversation_id=eq.${conversationId}` },
        (p) => h.onMessageInsert?.(p.new))
      .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'conversation_messages', filter: `conversation_id=eq.${conversationId}` },
        (p) => h.onMessageUpdate?.(p.new))
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'message_reactions' },
        (p) => h.onReaction?.((p.new ?? p.old), p.eventType as any))
      .subscribe()
  })
  return () => { if (ch) sb.removeChannel(ch) }
}

// Live updates to the user's conversation list (new conversation, last_message_at
// bump, read-state). RLS only delivers conversations the user can see.
export function subscribeToConversationList(onChange: () => void): () => void {
  const sb = getSupabase()
  let ch: RealtimeChannel | null = null
  ensureRealtimeAuth().then(() => {
    ch = sb.channel('conv-list')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'conversations' }, () => onChange())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'conversation_participants' }, () => onChange())
      .subscribe()
  })
  return () => { if (ch) sb.removeChannel(ch) }
}

// All new messages the user can see (RLS-filtered), regardless of which
// conversation is open — used to drive desktop notifications.
export function subscribeToAllMessages(onInsert: (row: any) => void): () => void {
  const sb = getSupabase()
  let ch: RealtimeChannel | null = null
  ensureRealtimeAuth().then(() => {
    ch = sb.channel('all-messages')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'conversation_messages' }, (p) => onInsert(p.new))
      .subscribe()
  })
  return () => { if (ch) sb.removeChannel(ch) }
}

// Lightweight typing indicator over a Realtime broadcast channel (no DB writes).
export interface TypingChannel {
  setTyping: (isTyping: boolean) => void
  leave: () => void
}
export function joinTyping(conversationId: string, user: { id: string; name: string }, onTyping: (typers: { id: string; name: string }[]) => void): TypingChannel {
  const sb = getSupabase()
  const typers = new Map<string, { name: string; at: number }>()
  const emit = () => {
    const now = Date.now()
    for (const [id, v] of Array.from(typers.entries())) if (now - v.at > 5000) typers.delete(id)
    onTyping(Array.from(typers.entries()).filter(([id]) => id !== user.id).map(([id, v]) => ({ id, name: v.name })))
  }
  const ch = sb.channel(`typing:${conversationId}`, { config: { broadcast: { self: false } } })
    .on('broadcast', { event: 'typing' }, (msg) => {
      const { id, name } = (msg.payload || {}) as { id: string; name: string }
      if (id) { typers.set(id, { name, at: Date.now() }); emit() }
    })
    .subscribe()
  const interval = setInterval(emit, 2000)
  return {
    setTyping: (isTyping: boolean) => { if (isTyping) ch.send({ type: 'broadcast', event: 'typing', payload: user }) },
    leave: () => { clearInterval(interval); sb.removeChannel(ch) },
  }
}
