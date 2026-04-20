// pages/api/auth/session.ts
// Handles session lifecycle with httpOnly cookies so API routes can verify without
// exposing tokens to client JS.
//   POST   { access_token, refresh_token }  — set cookies (called after supabase.auth.signIn)
//   GET    — return current user profile
//   DELETE — clear cookies (sign out)

import type { NextApiRequest, NextApiResponse } from 'next'
import { getCurrentUser, audit } from '../../../lib/authServer'
import { serialize } from 'cookie'

const ACCESS_COOKIE = 'ja-portal-access-token'
const REFRESH_COOKIE = 'ja-portal-refresh-token'
// 30 days in seconds
const MAX_AGE = 60 * 60 * 24 * 30

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'POST') {
    const { access_token, refresh_token } = req.body || {}
    if (!access_token) return res.status(400).json({ error: 'access_token required' })

    // Verify token is valid before setting the cookie
    const fakeReq = { ...req, headers: { ...req.headers, authorization: `Bearer ${access_token}` } } as NextApiRequest
    const user = await getCurrentUser(fakeReq)
    if (!user) return res.status(401).json({ error: 'Invalid token or no active profile' })

    const cookieOpts = {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax' as const,
      path: '/',
      maxAge: MAX_AGE,
    }
    const cookies = [
      serialize(ACCESS_COOKIE, access_token, cookieOpts),
    ]
    if (refresh_token) {
      cookies.push(serialize(REFRESH_COOKIE, refresh_token, cookieOpts))
    }
    res.setHeader('Set-Cookie', cookies)

    // Update last_sign_in_at
    try {
      const { createClient } = await import('@supabase/supabase-js')
      const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
      await sb.from('user_profiles').update({ last_sign_in_at: new Date().toISOString() }).eq('id', user.id)
    } catch (e) { console.error('last_sign_in update failed:', e) }

    audit(user, 'sign_in')

    return res.status(200).json({
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        role: user.role,
      },
    })
  }

  if (req.method === 'GET') {
    const user = await getCurrentUser(req)
    if (!user) return res.status(401).json({ error: 'Unauthenticated' })
    return res.status(200).json({
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        role: user.role,
      },
    })
  }

  if (req.method === 'DELETE') {
    const user = await getCurrentUser(req)
    if (user) audit(user, 'sign_out')
    const clear = { httpOnly: true, path: '/', maxAge: 0, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' as const }
    res.setHeader('Set-Cookie', [
      serialize(ACCESS_COOKIE, '', clear),
      serialize(REFRESH_COOKIE, '', clear),
    ])
    return res.status(200).json({ success: true })
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
