// pages/api/auth/logout.ts
// Compat shim — forwards to the new session DELETE endpoint. PortalSidebar
// already calls /api/auth/session directly, so this only matters for any
// stale bookmarks or external code.

import type { NextApiRequest, NextApiResponse } from 'next'
import { serialize } from 'cookie'

export default async function handler(_req: NextApiRequest, res: NextApiResponse) {
  const clear = {
    httpOnly: true,
    path: '/',
    maxAge: 0,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
  }
  res.setHeader('Set-Cookie', [
    serialize('ja-portal-access-token', '', clear),
    serialize('ja-portal-refresh-token', '', clear),
    serialize('ja_portal_auth', '', clear),  // also clear legacy cookie
  ])
  res.status(200).json({ ok: true })
}
