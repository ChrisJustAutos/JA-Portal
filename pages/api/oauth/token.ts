// pages/api/oauth/token.ts  (served at /token)
// OAuth 2.1 token endpoint — exchanges an authorization code (+ PKCE verifier,
// + client secret) for an access token. Tokens are stored in mcp_tokens so the
// MCP server (/api/mcp) resolves them like any personal token.

import type { NextApiRequest, NextApiResponse } from 'next'
import { osb, sha256hex, b64urlSha256, getClient, cors } from '../../../lib/mcp/oauth'
import { generateToken, hashToken } from '../../../lib/mcp/auth'

export const config = { maxDuration: 10 }

function err(res: NextApiResponse, status: number, error: string, desc?: string) {
  res.status(status).setHeader('Cache-Control', 'no-store')
  return res.json({ error, ...(desc ? { error_description: desc } : {}) })
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (cors(res, req)) return
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'invalid_request' }) }

  const body: any = req.body || {}
  // Client auth: client_secret_post (body) or client_secret_basic (header).
  let clientId = String(body.client_id || '')
  let clientSecret = String(body.client_secret || '')
  const basic = String(req.headers.authorization || '')
  if (basic.startsWith('Basic ')) {
    try { const [cid, csec] = Buffer.from(basic.slice(6), 'base64').toString('utf8').split(':'); if (cid) clientId = decodeURIComponent(cid); if (csec != null) clientSecret = decodeURIComponent(csec) } catch { /* ignore */ }
  }

  if (String(body.grant_type || '') !== 'authorization_code') return err(res, 400, 'unsupported_grant_type')
  const code = String(body.code || '')
  const redirectUri = String(body.redirect_uri || '')
  const codeVerifier = String(body.code_verifier || '')
  if (!code) return err(res, 400, 'invalid_request', 'code required')

  const client = await getClient(clientId)
  if (!client) return err(res, 401, 'invalid_client')
  // Confidential client → verify secret. (Public clients rely on PKCE only.)
  if (client.client_secret_hash) {
    if (!clientSecret || sha256hex(clientSecret) !== client.client_secret_hash) return err(res, 401, 'invalid_client', 'bad client secret')
  }

  const db = osb()
  const { data: row } = await db.from('oauth_codes').select('*').eq('code', code).maybeSingle()
  if (!row) return err(res, 400, 'invalid_grant', 'unknown code')
  if (row.used) return err(res, 400, 'invalid_grant', 'code already used')
  if (new Date(row.expires_at).getTime() < Date.now()) return err(res, 400, 'invalid_grant', 'code expired')
  if (row.client_id !== clientId) return err(res, 400, 'invalid_grant', 'client mismatch')
  if (row.redirect_uri !== redirectUri) return err(res, 400, 'invalid_grant', 'redirect_uri mismatch')
  // PKCE
  if (row.code_challenge) {
    if (!codeVerifier) return err(res, 400, 'invalid_grant', 'code_verifier required')
    if (b64urlSha256(codeVerifier) !== row.code_challenge) return err(res, 400, 'invalid_grant', 'PKCE verification failed')
  }

  // Single-use: burn the code.
  await db.from('oauth_codes').update({ used: true }).eq('code', code)

  // Issue an access token (stored in mcp_tokens; resolved by /api/mcp).
  const token = generateToken()
  const { error: insErr } = await db.from('mcp_tokens').insert({
    user_id: row.user_id, label: `Claude (OAuth · ${client.name || clientId})`,
    token_prefix: token.slice(0, 12), token_hash: hashToken(token),
  })
  if (insErr) return err(res, 500, 'server_error', 'could not issue token')

  res.status(200).setHeader('Cache-Control', 'no-store')
  return res.json({ access_token: token, token_type: 'Bearer', expires_in: 31536000, scope: row.scope || 'mcp' })
}
