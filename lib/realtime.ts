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
        // conversation_id denormalised onto reactions (migration 064) so we
        // only receive this conversation's reactions, not the whole workspace.
        { event: '*', schema: 'public', table: 'message_reactions', filter: `conversation_id=eq.${conversationId}` },
        (p) => h.onReaction?.((p.eventType === 'DELETE' ? p.old : p.new), p.eventType as any))
      .subscribe()
  })
  return () => { if (ch) sb.removeChannel(ch) }
}

// Live updates to the user's conversation list (new conversation, last_message_at
// bump, read-state). RLS only delivers conversations the user can see.
// Structured handlers so the client can patch its list incrementally instead
// of refetching on every event (last_message_at bumps on EVERY message).
export interface ConversationListHandlers {
  onConversation?: (row: any, eventType: 'INSERT' | 'UPDATE' | 'DELETE') => void
  onParticipant?: (row: any, eventType: 'INSERT' | 'UPDATE' | 'DELETE') => void
}
export function subscribeToConversationList(h: ConversationListHandlers): () => void {
  const sb = getSupabase()
  let ch: RealtimeChannel | null = null
  ensureRealtimeAuth().then(() => {
    ch = sb.channel('conv-list')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'conversations' },
        (p) => h.onConversation?.((p.eventType === 'DELETE' ? p.old : p.new), p.eventType as any))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'conversation_participants' },
        (p) => h.onParticipant?.((p.eventType === 'DELETE' ? p.old : p.new), p.eventType as any))
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

// Workspace presence — who's online right now. One shared channel; each client
// tracks itself under its user id. onChange receives the set of online user ids.
// No DB writes — presence state lives in the Realtime socket. (No "last seen"
// persistence yet; offline users simply drop out of the set.)
export interface PresenceChannel { leave: () => void }
export function joinPresence(me: { id: string; name: string }, onChange: (onlineIds: string[]) => void): PresenceChannel {
  const sb = getSupabase()
  let ch: RealtimeChannel | null = null
  ensureRealtimeAuth().then(() => {
    ch = sb.channel('presence:workspace', { config: { presence: { key: me.id } } })
    ch.on('presence', { event: 'sync' }, () => {
      try { onChange(Object.keys(ch!.presenceState())) } catch {}
    }).subscribe(async (status) => {
      if (status === 'SUBSCRIBED') { try { await ch!.track({ id: me.id, name: me.name, at: Date.now() }) } catch {} }
    })
  })
  return { leave: () => { if (ch) sb.removeChannel(ch) } }
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
