// pages/api/myob/auth/connect.ts
// Starts the MYOB OAuth flow. Generates a random CSRF state, stashes it in
// a short-lived httpOnly cookie, and redirects the admin to MYOB's authorise
// endpoint. On return, /api/myob/auth/callback completes the exchange.

import type { NextApiRequest, NextApiResponse } from 'next'
import { randomBytes } from 'crypto'
import { requireAdmin } from '../../../../lib/auth'
import { buildAuthorizeUrl } from '../../../../lib/myob'

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  return requireAdmin(req, res, async () => {
    const state = randomBytes(24).toString('hex')
    // Stash state + label in a 10-min cookie for CSRF verification on callback.
    // Label defaults to 'JAWS' — can be overridden with ?label=VPS etc.
    const label = String(req.query.label || 'JAWS').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || 'JAWS'
    const cookieValue = `${state}:${label}`
    res.setHeader('Set-Cookie',
      `myob-oauth-state=${cookieValue}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`)
    res.writeHead(302, { Location: buildAuthorizeUrl(state) })
    res.end()
  })
}
