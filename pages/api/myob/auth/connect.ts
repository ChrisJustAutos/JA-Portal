// pages/api/myob/auth/connect.ts
// Starts the MYOB OAuth flow. Generates a random CSRF state and stashes it —
// along with the admin user's ID — in a short-lived signed cookie. The admin
// check happens HERE, before we leave for MYOB. The callback trusts the
// cookie's packed user ID instead of re-verifying the Supabase session (which
// can be flaky across the MYOB cross-site redirect).

import type { NextApiRequest, NextApiResponse } from 'next'
import { randomBytes, createHmac } from 'crypto'
import { requireAdmin, getSessionUser } from '../../../../lib/auth'
import { buildAuthorizeUrl } from '../../../../lib/myob'

// Sign cookie payload with a secret so callback can trust its contents.
// SUPABASE_SERVICE_ROLE_KEY is already an env-secret we can reuse here —
// any long-lived server-only secret works.
function signPayload(payload: string): string {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY || 'fallback-dev-secret'
  const sig = createHmac('sha256', secret).update(payload).digest('hex').slice(0, 16)
  return `${payload}.${sig}`
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  return requireAdmin(req, res, async () => {
    const user = await getSessionUser(req)
    if (!user) { res.status(401).json({ error: 'No session user' }); return }

    const state = randomBytes(24).toString('hex')
    const label = String(req.query.label || 'JAWS').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || 'JAWS'

    // Cookie payload: state:label:userId — signed so callback can trust it
    // without re-hitting Supabase auth.
    const payload = `${state}:${label}:${user.id}`
    const signed = signPayload(payload)
    res.setHeader('Set-Cookie',
      `myob-oauth-state=${signed}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`)
    res.writeHead(302, { Location: buildAuthorizeUrl(state) })
    res.end()
  })
}
