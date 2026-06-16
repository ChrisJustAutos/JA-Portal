// lib/mcp/oauth.ts
// Shared helpers for the MCP OAuth 2.1 server (authorize / token / discovery).

import type { NextApiResponse } from 'next'
import { createHash, randomBytes } from 'node:crypto'
import { createClient, SupabaseClient } from '@supabase/supabase-js'

export const ISSUER = 'https://justautos.app'
export const RESOURCE = 'https://justautos.app/api/mcp'
export const CODE_TTL_MS = 5 * 60 * 1000

let _sb: SupabaseClient | null = null
export function osb(): SupabaseClient {
  if (_sb) return _sb
  _sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  return _sb
}

export const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex')
export const b64urlSha256 = (s: string) => createHash('sha256').update(s).digest('base64url')
export const randomCode = () => randomBytes(32).toString('hex')

// Permissive CORS for the discovery/token endpoints (claude.ai web fetches some
// of these from a browser context). Returns true if it handled an OPTIONS preflight.
export function cors(res: NextApiResponse, req?: { method?: string }): boolean {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, mcp-protocol-version')
  res.setHeader('Access-Control-Max-Age', '86400')
  if (req?.method === 'OPTIONS') { res.status(204).end(); return true }
  return false
}

export interface OauthClient { client_id: string; client_secret_hash: string | null; name: string | null; redirect_uris: string[] }

export async function getClient(clientId: string): Promise<OauthClient | null> {
  if (!clientId) return null
  const { data } = await osb().from('oauth_clients').select('client_id, client_secret_hash, name, redirect_uris').eq('client_id', clientId).maybeSingle()
  return (data as OauthClient) || null
}

// A redirect_uri is allowed if it's registered for the client, or it's an https
// Claude/Anthropic callback (covers Desktop/web variants without re-registration).
export function redirectAllowed(client: OauthClient, uri: string): boolean {
  if (!uri) return false
  if ((client.redirect_uris || []).includes(uri)) return true
  try {
    const u = new URL(uri)
    if (u.protocol !== 'https:') return false
    const h = u.hostname
    return h === 'claude.ai' || h === 'claude.com' || h.endsWith('.claude.ai') || h.endsWith('.claude.com') || h.endsWith('.anthropic.com')
  } catch { return false }
}
