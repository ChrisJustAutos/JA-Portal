// pages/api/mcp/tokens.ts
// Manage the current user's MCP connector tokens (any authenticated staff).
//   GET    — list my active tokens (prefix only; never the full token)
//   POST   { label? } — mint a new token; returns the full token ONCE
//   DELETE ?id=       — revoke one of my tokens

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { getSessionUser } from '../../../lib/auth'
import { generateToken, hashToken } from '../../../lib/mcp/auth'

export const config = { maxDuration: 10 }

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  _sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  return _sb
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const user = await getSessionUser(req)
  if (!user) return res.status(401).json({ error: 'Unauthorised' })
  const db = sb()

  if (req.method === 'GET') {
    const { data, error } = await db.from('mcp_tokens')
      .select('id, label, token_prefix, created_at, last_used_at')
      .eq('user_id', user.id).is('revoked_at', null).order('created_at', { ascending: false })
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ tokens: data || [] })
  }

  if (req.method === 'POST') {
    let body: any = {}
    try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) } catch { return res.status(400).json({ error: 'Bad JSON' }) }
    const label = body.label ? String(body.label).slice(0, 80) : null
    const token = generateToken()
    const { data, error } = await db.from('mcp_tokens')
      .insert({ user_id: user.id, label, token_prefix: token.slice(0, 12), token_hash: hashToken(token) })
      .select('id').single()
    if (error) return res.status(500).json({ error: error.message })
    // The full token is returned exactly once — we only store its hash.
    return res.status(201).json({ ok: true, id: data.id, token })
  }

  if (req.method === 'DELETE') {
    const id = String(req.query.id || '').trim()
    if (!id) return res.status(400).json({ error: 'id required' })
    const { error } = await db.from('mcp_tokens').update({ revoked_at: new Date().toISOString() }).eq('id', id).eq('user_id', user.id)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  res.setHeader('Allow', 'GET, POST, DELETE')
  return res.status(405).json({ error: 'GET, POST or DELETE only' })
}
