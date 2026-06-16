// pages/api/oauth/metadata.ts  (served at /.well-known/oauth-authorization-server)
// OAuth 2.0 Authorization Server Metadata (RFC 8414) for the MCP connector.

import type { NextApiRequest, NextApiResponse } from 'next'
import { ISSUER, cors } from '../../../lib/mcp/oauth'

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (cors(res, req)) return
  res.status(200).json({
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/authorize`,
    token_endpoint: `${ISSUER}/token`,
    registration_endpoint: `${ISSUER}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic', 'none'],
    scopes_supported: ['mcp'],
  })
}
