// pages/api/auth/mfa-device.ts
// "Trust this device for 24 hours" for staff TOTP MFA.
//
//   POST { action: 'check',  access_token } → { trusted: boolean }
//     Called at login (after password, before the TOTP prompt). Returns true
//     if this browser holds a live trusted-device cookie for THIS user, so the
//     authenticator step can be skipped for 24h.
//   POST { action: 'trust',  access_token } → { ok: true }
//     Called after a successful TOTP verify (when the user opted to trust the
//     device). Mints a random token, stores its SHA-256 hash with a 24h expiry,
//     and sets it as an httpOnly cookie.
//
// The cookie is bound to the user via the DB row, so a trust cookie minted for
// one account never lets a different account skip MFA.

import type { NextApiRequest, NextApiResponse } from 'next'
import { getCurrentUser } from '../../../lib/authServer'
import { serialize } from 'cookie'
import { createClient } from '@supabase/supabase-js'
import { randomBytes, createHash } from 'crypto'

const DEVICE_COOKIE = 'ja-portal-mfa-device'
const TRUST_HOURS = 24
const MAX_AGE = 60 * 60 * TRUST_HOURS  // seconds

function sb() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'POST only' })
  }
  const { action, access_token } = req.body || {}
  if (!access_token) return res.status(400).json({ error: 'access_token required' })

  // Identify the user from the (AAL1) access token, same pattern as session.ts.
  const fakeReq = { ...req, headers: { ...req.headers, authorization: `Bearer ${access_token}` } } as NextApiRequest
  const user = await getCurrentUser(fakeReq)
  if (!user) return res.status(401).json({ error: 'Invalid token or no active profile' })

  const c = sb()

  if (action === 'check') {
    const token = req.cookies[DEVICE_COOKIE]
    if (!token) return res.status(200).json({ trusted: false })
    const { data } = await c.from('mfa_trusted_devices')
      .select('id, expires_at')
      .eq('user_id', user.id)
      .eq('token_hash', sha256(token))
      .gt('expires_at', new Date().toISOString())
      .maybeSingle()
    return res.status(200).json({ trusted: !!data })
  }

  if (action === 'trust') {
    const token = randomBytes(32).toString('hex')
    const expiresAt = new Date(Date.now() + MAX_AGE * 1000).toISOString()
    const { error } = await c.from('mfa_trusted_devices').insert({
      user_id: user.id,
      token_hash: sha256(token),
      user_agent: String(req.headers['user-agent'] || '').slice(0, 300),
      expires_at: expiresAt,
    })
    if (error) return res.status(500).json({ error: error.message })
    // Best-effort cleanup of this user's expired rows.
    c.from('mfa_trusted_devices').delete().eq('user_id', user.id).lt('expires_at', new Date().toISOString()).then(() => {}, () => {})
    res.setHeader('Set-Cookie', serialize(DEVICE_COOKIE, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: MAX_AGE,
    }))
    return res.status(200).json({ ok: true })
  }

  return res.status(400).json({ error: 'action must be check or trust' })
}
