// lib/auth.ts
import { NextApiRequest, NextApiResponse } from 'next'

const PORTAL_PASSWORD = process.env.PORTAL_PASSWORD || 'justautos2026'
const COOKIE_NAME = 'ja_portal_auth'
const COOKIE_MAX_AGE = 60 * 60 * 24 * 7

export function setAuthCookie(res: NextApiResponse) {
  const value = Buffer.from(PORTAL_PASSWORD).toString('base64')
  res.setHeader('Set-Cookie', [
    `${COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE}; ${process.env.NODE_ENV === 'production' ? 'Secure;' : ''}`
  ])
}

export function clearAuthCookie(res: NextApiResponse) {
  res.setHeader('Set-Cookie', [`${COOKIE_NAME}=; Path=/; HttpOnly; Max-Age=0`])
}

export function isAuthenticated(req: NextApiRequest): boolean {
  const cookie = req.cookies[COOKIE_NAME]
  if (!cookie) return false
  try {
    const decoded = Buffer.from(cookie, 'base64').toString('utf8')
    return decoded === PORTAL_PASSWORD
  } catch { return false }
}

export async function requireAuth(
  req: NextApiRequest,
  res: NextApiResponse,
  handler: () => Promise<void>
): Promise<void> {
  if (!isAuthenticated(req)) {
    res.status(401).json({ error: 'Unauthorised' })
    return
  }
  await handler()
}
