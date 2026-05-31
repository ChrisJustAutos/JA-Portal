// lib/messaging.ts
// SERVER-ONLY helpers for the chat platform API routes. All writes/reads in the
// API layer use the service-role client (bypasses RLS), so access control is
// enforced HERE in code — mirroring the RLS in migration 046. Client realtime
// reads are still gated by RLS.

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import type { Role } from './auth'

let _sb: SupabaseClient | null = null
export function svc(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

export const INBOX_ROLES: Role[] = ['admin', 'manager', 'sales']

export interface ConversationRow {
  id: string
  type: 'channel' | 'dm' | 'group' | 'customer'
  name: string | null
  topic: string | null
  is_private: boolean
  source: string | null
  status: string
  last_message_at: string | null
  created_by: string | null
}

export async function isMember(conversationId: string, userId: string): Promise<boolean> {
  const { data } = await svc().from('conversation_participants')
    .select('user_id').eq('conversation_id', conversationId).eq('user_id', userId).maybeSingle()
  return !!data
}

// Mirror of can_see_conversation() for the service-role API layer.
export async function canAccessConversation(conv: ConversationRow, userId: string, role: Role): Promise<boolean> {
  if (conv.type === 'channel' && !conv.is_private) return true
  if (await isMember(conv.id, userId)) return true
  if (conv.type === 'customer' && INBOX_ROLES.includes(role)) return true
  return false
}

export async function getConversation(conversationId: string): Promise<ConversationRow | null> {
  const { data } = await svc().from('conversations')
    .select('id, type, name, topic, is_private, source, status, last_message_at, created_by')
    .eq('id', conversationId).maybeSingle()
  return (data as ConversationRow) || null
}

// Map of user_id -> { name, email } for labelling participants/senders.
export async function userDirectory(ids: string[]): Promise<Record<string, { name: string; email: string }>> {
  const uniq = Array.from(new Set(ids.filter(Boolean)))
  if (uniq.length === 0) return {}
  const { data } = await svc().from('user_profiles')
    .select('id, display_name, email').in('id', uniq)
  const out: Record<string, { name: string; email: string }> = {}
  for (const u of data || []) out[u.id] = { name: u.display_name || u.email, email: u.email }
  return out
}
