// pages/api/oauth/register.ts  (served at /register)
// OAuth 2.0 Dynamic Client Registration (RFC 7591). claude.ai web self-registers
// here; Claude Desktop uses the pre-seeded client instead.

import type { NextApiRequest, NextApiResponse } from 'next'
import { randomBytes } from 'node:crypto'
import { osb, sha256hex, cors } from '../../../lib/mcp/oauth'

export const config = { maxDuration: 10 }

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (cors(res, req)) return
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'invalid_request' }) }

  const body: any = req.body || {}
  const redirectUris: string[] = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((x: any) => typeof x === 'string') : []
  if (!redirectUris.length) return res.status(400).json({ error: 'invalid_redirect_uri', error_description: 'redirect_uris required' })

  const authMethod = String(body.token_endpoint_auth_method || 'client_secret_post')
  const clientId = 'jac_' + randomBytes(12).toString('hex')
  let clientSecret: string | null = null
  let secretHash: string | null = null
  if (authMethod !== 'none') { clientSecret = randomBytes(24).toString('hex'); secretHash = sha256hex(clientSecret) }

  const { error } = await osb().from('oauth_clients').insert({
    client_id: clientId, client_secret_hash: secretHash,
    name: String(body.client_name || 'Dynamic client').slice(0, 120), redirect_uris: redirectUris,
  })
  if (error) return res.status(500).json({ error: 'server_error', error_description: error.message })

  const resp: any = {
    client_id: clientId, redirect_uris: redirectUris,
    token_endpoint_auth_method: authMethod, grant_types: ['authorization_code'], response_types: ['code'],
  }
  if (clientSecret) resp.client_secret = clientSecret
  return res.status(201).json(resp)
}
