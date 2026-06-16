// pages/api/oauth/protected-resource.ts  (served at /.well-known/oauth-protected-resource)
// OAuth 2.0 Protected Resource Metadata (RFC 9728) — points Claude at our AS.

import type { NextApiRequest, NextApiResponse } from 'next'
import { ISSUER, RESOURCE, cors } from '../../../lib/mcp/oauth'

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (cors(res, req)) return
  res.status(200).json({
    resource: RESOURCE,
    authorization_servers: [ISSUER],
    scopes_supported: ['mcp'],
    bearer_methods_supported: ['header'],
  })
}
