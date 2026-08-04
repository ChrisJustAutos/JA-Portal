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

  // Find the matching distributor user rows (multi-site people have several).
  const { data: distUsers, error: lookupErr } = await c
    .from('b2b_distributor_users')
    .select('id, distributor_id, email, full_name, last_login_at')
    .eq('auth_user_id', authUserId)
    .order('created_at', { ascending: true })
  if (lookupErr) return res.status(500).json({ error: lookupErr.message })
  if (!distUsers || distUsers.length === 0) {
    // Auth user exists but isn't linked to a distributor — likely a staff user
    // who shouldn't have ended up here. Don't error; just return ok.
    return res.status(200).json({ ok: true, linked: false })
  }

  const firstLogins = distUsers.filter(u => !u.last_login_at)

  await c
    .from('b2b_distributor_users')
    .update({ last_login_at: new Date().toISOString() })
    .eq('auth_user_id', authUserId)

  // Bell-notify staff the first time each distributor user signs in (dedupe
  // key makes this at-most-once per membership even if check-in re-fires).
  for (const du of firstLogins) {
    try {
      const { data: dist } = await c.from('b2b_distributors')
        .select('display_name').eq('id', du.distributor_id).maybeSingle()
      const who = du.full_name ? `${du.full_name} (${du.email})` : du.email
      const { notify } = await import('../../../../lib/notifications')
      await notify({
        module: 'b2b',
        title: `First B2B sign-in — ${dist?.display_name || 'distributor'}`,
        body: `${who} signed in to the portal for the first time.`,
        href: `/admin/b2b/distributors/${du.distributor_id}`,
        dedupeKey: `b2b-first-login:${du.id}`,
        roles: ['admin', 'manager'],
      })
    } catch (e: any) { console.error('first-login notify failed:', e?.message || e) }
  }

  return res.status(200).json({ ok: true, linked: true, distributor_id: distUsers[0].distributor_id })
}
