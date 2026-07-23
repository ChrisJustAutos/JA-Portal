// pages/api/b2b/auth/session.ts
//
// Mirrors pages/api/auth/session.ts but for distributor sessions.
//   POST   { access_token, refresh_token }  — verify + set httpOnly cookies
//   DELETE — clear cookies (sign out)
//
// Called from /b2b/auth/callback after the Supabase JS SDK establishes a
// session in localStorage. We need a server-readable cookie so getServerSideProps
// can verify the user.

import type { NextApiRequest, NextApiResponse } from 'next'
import { serialize } from 'cookie'
import { getCurrentB2BUserFromToken, b2bMfaSatisfied, B2B_ACCESS_COOKIE, B2B_REFRESH_COOKIE } from '../../../../lib/b2bAuthServer'
import { getCurrentSupplierUserFromToken } from '../../../../lib/b2bSupplierAuth'
import { createClient } from '@supabase/supabase-js'

const MAX_AGE = 60 * 60 * 24 * 30  // 30 days

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'POST') {
    const { access_token, refresh_token } = req.body || {}
    if (!access_token) return res.status(400).json({ error: 'access_token required' })

    // The same auth user is EITHER a distributor user or a supplier user.
    const user = await getCurrentB2BUserFromToken(access_token)
    const supplier = user ? null : await getCurrentSupplierUserFromToken(access_token)
    if (!user && !supplier) return res.status(401).json({ error: 'This account isn’t set up for the B2B portal.' })

    // Server-side 2FA: an account with a verified authenticator only gets a
    // session cookie from an AAL2 token or a trusted device — the login page's
    // client-side code gate is advisory, this is the enforcement.
    if (user && !(await b2bMfaSatisfied(req as any, access_token, user.authUserId))) {
      return res.status(401).json({ error: 'Two-factor code required for this account.', mfa_required: true })
    }

    const cookieOpts = {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax' as const,
      path: '/',
      maxAge: MAX_AGE,
    }
    const cookies = [serialize(B2B_ACCESS_COOKIE, access_token, cookieOpts)]
    if (refresh_token) {
      cookies.push(serialize(B2B_REFRESH_COOKIE, refresh_token, cookieOpts))
    }
    res.setHeader('Set-Cookie', cookies)

    // Best-effort: bump last_login_at on the right table.
    try {
      const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
      if (user) await sb.from('b2b_distributor_users').update({ last_login_at: new Date().toISOString() }).eq('id', user.id)
      else if (supplier) await sb.from('b2b_supplier_users').update({ last_login_at: new Date().toISOString() }).eq('id', supplier.id)
    } catch (e) {
      console.error('last_login_at update failed:', e)
    }

    if (supplier) {
      return res.status(200).json({
        kind: 'supplier',
        user: { id: supplier.id, email: supplier.email, fullName: supplier.fullName, supplier: { id: supplier.supplier.id, name: supplier.supplier.name } },
      })
    }
    return res.status(200).json({
      kind: 'distributor',
      user: {
        id: user!.id,
        email: user!.email,
        fullName: user!.fullName,
        role: user!.role,
        distributor: { id: user!.distributor.id, displayName: user!.distributor.displayName },
      },
    })
  }

  if (req.method === 'DELETE') {
    const expired = {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax' as const,
      path: '/',
      maxAge: 0,
    }
    res.setHeader('Set-Cookie', [
      serialize(B2B_ACCESS_COOKIE, '', expired),
      serialize(B2B_REFRESH_COOKIE, '', expired),
    ])
    return res.status(200).json({ ok: true })
  }

  res.setHeader('Allow', 'POST, DELETE')
  return res.status(405).json({ error: 'POST or DELETE only' })
}
