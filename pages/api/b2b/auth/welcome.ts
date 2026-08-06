// POST /api/b2b/auth/welcome  { token, password }
//
// Scanner-proof invite completion (Harrop 2026-08-06: their mail security
// pre-clicks links, burning Supabase's single-use invite URLs before the
// human sees them). The emailed link is a PORTAL page carrying a signed
// b2b_welcome token; opening it does nothing destructive — the account is
// only touched when the human SUBMITS the set-password form here.
//
// Guards: token signed + 7-day expiry (scope b2b_welcome, payload = the
// b2b_distributor_users row id); rejected once the user has signed in
// (use "Forgot password" after that); password min 8 chars.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { verifyOrderAction } from '../../../../lib/order-action-token'

function sb() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'POST only' })
  }
  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {})
  const token = String(body.token || '').trim()
  const password = String(body.password || '')
  if (!token) return res.status(400).json({ error: 'token required' })
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' })

  const v = verifyOrderAction(token, 'b2b_welcome')
  if (!v) return res.status(401).json({ error: 'This link has expired or is invalid — ask Just Autos to resend your invite.' })

  const c = sb()
  const { data: u } = await c.from('b2b_distributor_users')
    .select('id, auth_user_id, email, is_active, last_login_at')
    .eq('id', v.orderId).maybeSingle()
  if (!u || !u.is_active) return res.status(404).json({ error: 'This invite is no longer valid — ask Just Autos to resend it.' })
  if (u.last_login_at) {
    return res.status(409).json({ error: 'This account is already set up — sign in normally, or use "Forgot password" on the login page.' })
  }
  if (!u.auth_user_id) return res.status(409).json({ error: 'This invite needs re-issuing — ask Just Autos to resend it.' })

  const { error: updErr } = await c.auth.admin.updateUserById(u.auth_user_id, {
    password,
    email_confirm: true,
  })
  if (updErr) return res.status(502).json({ error: `Could not set the password: ${updErr.message}` })

  return res.status(200).json({ ok: true, email: u.email })
}
