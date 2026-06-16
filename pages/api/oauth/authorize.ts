// pages/api/oauth/authorize.ts  (served at /authorize)
// OAuth 2.1 authorization endpoint (authorization-code + PKCE). The staff member
// must be logged into the portal; we then auto-approve (trusted first-party
// connector) and redirect back to Claude with a short-lived code.

import type { NextApiRequest, NextApiResponse } from 'next'
import { getSessionUser } from '../../../lib/auth'
import { getClient, redirectAllowed, osb, randomCode, CODE_TTL_MS } from '../../../lib/mcp/oauth'

export const config = { maxDuration: 10 }

function errorPage(res: NextApiResponse, status: number, msg: string) {
  res.status(status).setHeader('Content-Type', 'text/html')
  res.send(`<!doctype html><meta charset=utf-8><body style="font-family:system-ui;background:#0f1115;color:#e6e6e6;padding:40px"><h2>Connection error</h2><p>${msg}</p></body>`)
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).end() }

  const q = req.query
  const responseType = String(q.response_type || '')
  const clientId = String(q.client_id || '')
  const redirectUri = String(q.redirect_uri || '')
  const state = typeof q.state === 'string' ? q.state : ''
  const codeChallenge = typeof q.code_challenge === 'string' ? q.code_challenge : ''
  const codeChallengeMethod = typeof q.code_challenge_method === 'string' ? q.code_challenge_method : ''
  const scope = typeof q.scope === 'string' ? q.scope : 'mcp'

  // Validate the client + redirect_uri BEFORE trusting redirect_uri for error redirects.
  const client = await getClient(clientId)
  if (!client) return errorPage(res, 400, 'Unknown client_id. Check the Client ID you entered in Claude.')
  if (!redirectAllowed(client, redirectUri)) return errorPage(res, 400, 'redirect_uri is not allowed for this client.')

  const back = (params: Record<string, string>) => {
    const u = new URL(redirectUri)
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v)
    if (state) u.searchParams.set('state', state)
    res.writeHead(302, { Location: u.toString() }); res.end()
  }

  if (responseType !== 'code') return back({ error: 'unsupported_response_type' })
  if (codeChallenge && codeChallengeMethod && codeChallengeMethod !== 'S256') return back({ error: 'invalid_request', error_description: 'only S256 PKCE supported' })

  // Require a portal session — otherwise bounce through login and come back here.
  const user = await getSessionUser(req)
  if (!user) {
    const qs = (req.url || '').split('?')[1] || ''
    const next = '/authorize' + (qs ? `?${qs}` : '')
    res.writeHead(302, { Location: `/login?next=${encodeURIComponent(next)}` }); res.end()
    return
  }

  // Auto-approve (trusted connector) → mint a one-time code bound to this user/client/PKCE.
  const code = randomCode()
  const { error } = await osb().from('oauth_codes').insert({
    code, client_id: clientId, user_id: user.id, redirect_uri: redirectUri,
    code_challenge: codeChallenge || null, code_challenge_method: codeChallengeMethod || null,
    scope, expires_at: new Date(Date.now() + CODE_TTL_MS).toISOString(),
  })
  if (error) return back({ error: 'server_error', error_description: 'could not issue code' })
  return back({ code })
}
