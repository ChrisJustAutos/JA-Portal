// pages/api/b2b/auth/check-in.ts
//
// POST /api/b2b/auth/check-in
//   body: { access_token }
//
// Called by the magic-link callback page after a distributor signs in.
// Verifies the token, looks up the matching b2b_distributor_users row,
// and updates last_login_at. Best-effort — the callback doesn't block
// on this succeeding.
//
// Not gated by withAuth (distributors don't have user_profiles entries
// and aren't part of the staff permission system). Instead, the access
// token is verified directly against Supabase Auth.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'POST only' })
  }

  const access_token = String(req.body?.access_token || '').trim()
  if (!access_token) return res.status(400).json({ error: 'access_token required' })

  const c = sb()

  // Verify the token belongs to a real auth user
  const { data: authData, error: authErr } = await c.auth.getUser(access_token)
  if (authErr || !authData?.user?.id) {
    return res.status(401).json({ error: 'Invalid token' })
  }
  const authUserId = authData.user.id

  // Find the matching distributor user
  const { data: distUser, error: lookupErr } = await c
    .from('b2b_distributor_users')
    .select('id, distributor_id')
    .eq('auth_user_id', authUserId)
    .maybeSingle()
  if (lookupErr) return res.status(500).json({ error: lookupErr.message })
  if (!distUser) {
    // Auth user exists but isn't linked to a distributor — likely a staff user
    // who shouldn't have ended up here. Don't error; just return ok.
    return res.status(200).json({ ok: true, linked: false })
  }

  await c
    .from('b2b_distributor_users')
    .update({ last_login_at: new Date().toISOString() })
    .eq('id', distUser.id)

  return res.status(200).json({ ok: true, linked: true, distributor_id: distUser.distributor_id })
}
