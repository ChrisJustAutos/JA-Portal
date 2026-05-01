// pages/api/myob/test/datascopes.ts
// Diagnostic: call MYOB's /accountright/DataScopes endpoint using the
// existing connection's bearer token. DataScopes returns the list of
// SME_SCOPES the registered app is allowed to request, plus the API
// endpoints each scope unlocks. This is how we discover the correct
// MYOB_SCOPE value for an app — there's no public list of scope names,
// MYOB grants them per-app at registration time.
//
// Usage:
//   GET /api/myob/test/datascopes              → uses 'JAWS' connection
//   GET /api/myob/test/datascopes?label=VPS    → uses 'VPS' connection
//
// The connection only needs a valid OAuth token (any scope, even just
// `openid offline_access`). It does NOT need a company file selected —
// DataScopes is at the API root, not inside a company file.

import type { NextApiRequest, NextApiResponse } from 'next'
import { requireAdmin, getSessionUser } from '../../../../lib/auth'
import { getConnection, myobFetch } from '../../../../lib/myob'

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  return requireAdmin(req, res, async () => {
    const user = await getSessionUser(req)
    const label = String(req.query.label || 'JAWS')
    const conn = await getConnection(label)
    if (!conn) {
      res.status(404).json({ error: `No active MYOB connection '${label}'` })
      return
    }

    try {
      // requiresCfAuth: false — DataScopes is outside any company file, no
      // x-myobapi-cftoken needed.
      const { status, data, raw } = await myobFetch(conn.id, '/accountright/DataScopes', {
        requiresCfAuth: false,
        performedBy: user?.id || null,
      })

      if (status !== 200) {
        res.status(status).json({
          error: 'DataScopes returned non-200',
          status,
          data,
          rawSnippet: raw?.substring(0, 500),
        })
        return
      }

      res.status(200).json({
        ok: true,
        connection: { label: conn.label, id: conn.id },
        message: 'These are the scopes your app is allowed to request. Set MYOB_SCOPE to one or more (space-separated), then disconnect and reconnect.',
        dataScopes: data,
      })
    } catch (e: any) {
      res.status(500).json({ error: e?.message || 'Unknown error' })
    }
  })
}
