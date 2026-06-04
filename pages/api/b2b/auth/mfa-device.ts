// pages/api/b2b/auth/mfa-device.ts
// "Trust this device for 24 hours" for the distributor portal's TOTP MFA —
// the B2B twin of /api/auth/mfa-device. Identifies the distributor from their
// access token (getCurrentB2BUserFromToken) and keys the trusted-device row by
// their auth.users id, reusing the shared mfa_trusted_devices table but a
// distinct cookie so it never crosses with a staff trust.
//
//   POST { action: 'check', access_token } → { trusted }
//   POST { action: 'trust', access_token } → { ok }  (after a successful code)

import type { NextApiRequest, NextApiResponse } from 'next'
import { serialize } from 'cookie'
import { createClient } from '@supabase/supabase-js'
import { randomBytes, createHash } from 'crypto'
import { getCurrentB2BUserFromToken } from '../../../../lib/b2bAuthServer'

const DEVICE_COOKIE = 'ja-b2b-mfa-device'
const TRUST_HOURS = 24
const MAX_AGE = 60 * 60 * TRUST_HOURS
function sb() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }) }
  const { action, access_token } = req.body || {}
  if (!access_token) return res.status(400).json({ error: 'access_token required' })

  const user = await getCurrentB2BUserFromToken(access_token)
  if (!user) return res.status(401).json({ error: 'Not an active distributor user' })
  const uid = user.authUserId
  const c = sb()

  if (action === 'check') {
    const token = req.cookies[DEVICE_COOKIE]
    if (!token) return res.status(200).json({ trusted: false })
    const { data } = await c.from('mfa_trusted_devices')
      .select('id')
      .eq('user_id', uid)
      .eq('token_hash', sha256(token))
      .gt('expires_at', new Date().toISOString())
      .maybeSingle()
    return res.status(200).json({ trusted: !!data })
  }

  if (action === 'trust') {
    const token = randomBytes(32).toString('hex')
    const expiresAt = new Date(Date.now() + MAX_AGE * 1000).toISOString()
    const { error } = await c.from('mfa_trusted_devices').insert({
      user_id: uid,
      token_hash: sha256(token),
      user_agent: String(req.headers['user-agent'] || '').slice(0, 300),
      expires_at: expiresAt,
    })
    if (error) return res.status(500).json({ error: error.message })
    c.from('mfa_trusted_devices').delete().eq('user_id', uid).lt('expires_at', new Date().toISOString()).then(() => {}, () => {})
    res.setHeader('Set-Cookie', serialize(DEVICE_COOKIE, token, {
      httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: MAX_AGE,
    }))
    return res.status(200).json({ ok: true })
  }

  return res.status(400).json({ error: 'action must be check or trust' })
}
