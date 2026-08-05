// GET /api/xero/auth/start — kicks off the Xero OAuth consent (admin only).
// One consent can authorise BOTH organisations; tenants are assigned to
// entity labels (VPS/JAWS) afterwards via /api/xero/connections.

import type { NextApiRequest, NextApiResponse } from 'next'
import { randomUUID } from 'crypto'
import { withAuth } from '../../../../lib/authServer'
import { roleHasPermission } from '../../../../lib/permissions'
import { xeroAuthorizeUrl } from '../../../../lib/xero'

export default withAuth(null, async (_req: NextApiRequest, res: NextApiResponse, user: any) => {
  if (!roleHasPermission(user.role, 'admin:settings')) return res.status(403).json({ error: 'Admin only' })
  try {
    const state = randomUUID()
    res.setHeader('Set-Cookie', `ja-xero-oauth-state=${state}; Path=/; Max-Age=600; SameSite=Lax; Secure; HttpOnly`)
    const url = await xeroAuthorizeUrl(state)
    res.redirect(302, url)
  } catch (e: any) {
    res.status(500).json({ error: e?.message || String(e) })
  }
})
