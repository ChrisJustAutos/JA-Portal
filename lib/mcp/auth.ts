// lib/mcp/auth.ts
// Per-user token auth for the JA Portal MCP connector. A token is minted in
// Settings → Claude connector and presented as `Authorization: Bearer <token>`.
// We store only sha256(token); resolveMcpUser maps a presented token back to the
// portal user so every tool call runs with that user's role/permissions.

import type { NextApiRequest } from 'next'
import { createHash, randomBytes } from 'node:crypto'
import { createClient, SupabaseClient } from '@supabase/supabase-js'

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  _sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  return _sb
}

export const TOKEN_PREFIX = 'jap_'
export function generateToken(): string { return TOKEN_PREFIX + randomBytes(24).toString('hex') }
export function hashToken(t: string): string { return createHash('sha256').update(t).digest('hex') }

export interface McpUser {
  userId: string
  role: string
  displayName: string | null
  email: string | null
}

/** Resolve the Bearer token on the request to a portal user, or null if invalid. */
export async function resolveMcpUser(req: NextApiRequest): Promise<McpUser | null> {
  const auth = String(req.headers.authorization || req.headers.Authorization || '')
  if (!auth.startsWith('Bearer ')) return null
  const token = auth.slice(7).trim()
  if (!token.startsWith(TOKEN_PREFIX)) return null

  const db = sb()
  const { data: row } = await db.from('mcp_tokens')
    .select('id, user_id').eq('token_hash', hashToken(token)).is('revoked_at', null).maybeSingle()
  if (!row) return null

  const { data: prof } = await db.from('user_profiles')
    .select('id, role, display_name, email, is_active').eq('id', row.user_id).maybeSingle()
  if (!prof || (prof as any).is_active === false) return null

  // Stamp last-used (fire-and-forget — never block the tool call on it).
  db.from('mcp_tokens').update({ last_used_at: new Date().toISOString() }).eq('id', row.id).then(() => {}, () => {})

  return { userId: prof.id, role: String((prof as any).role), displayName: (prof as any).display_name || null, email: (prof as any).email || null }
}
