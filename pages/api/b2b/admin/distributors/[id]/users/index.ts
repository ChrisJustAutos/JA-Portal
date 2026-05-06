// pages/api/b2b/admin/distributors/[id]/users/index.ts
//
// POST  /api/b2b/admin/distributors/{id}/users
//   body: { email, full_name?, role? }
//   1. Calls supabase.auth.admin.inviteUserByEmail(email, { redirectTo: /b2b/auth/callback })
//   2. Inserts row in b2b_distributor_users linked to that auth user
//
// Notes:
//   - email is stored lowercased; the unique index on lower(email) prevents
//     adding the same email twice across distributors
//   - if Supabase Auth says "user already registered", we return a friendly
//     error rather than auto-merging (V1 simplicity — admin can resolve manually)
//   - free Supabase tier is rate-limited to 4 invite emails per hour;
//     custom SMTP lifts this in production

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth, PortalUser } from '../../../../../../../lib/authServer'

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

const VALID_ROLES = ['admin', 'buyer', 'viewer'] as const

export default withAuth('edit:b2b_distributors', async (req: NextApiRequest, res: NextApiResponse, user: PortalUser) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'POST only' })
  }

  const distributorId = String(req.query.id || '').trim()
  if (!distributorId) return res.status(400).json({ error: 'Missing distributor id' })

  const body = (req.body && typeof req.body === 'object') ? req.body : {}
  const email     = String(body.email || '').trim().toLowerCase()
  const full_name = body.full_name ? String(body.full_name).trim() : null
  const role      = body.role && VALID_ROLES.includes(body.role) ? body.role : 'buyer'

  if (!email) return res.status(400).json({ error: 'email required' })
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'invalid email format' })

  const c = sb()

  // 1. Verify distributor exists
  const { data: dist, error: distErr } = await c
    .from('b2b_distributors')
    .select('id, display_name, is_active')
    .eq('id', distributorId)
    .maybeSingle()
  if (distErr) return res.status(500).json({ error: distErr.message })
  if (!dist) return res.status(404).json({ error: 'Distributor not found' })

  // 2. Check email isn't already in b2b_distributor_users (anywhere)
  const { data: existing } = await c
    .from('b2b_distributor_users')
    .select('id, distributor_id, is_active')
    .eq('email', email)  // already lowercase
    .maybeSingle()
  if (existing) {
    return res.status(409).json({
      error: existing.distributor_id === distributorId
        ? 'This email is already a user on this distributor.'
        : 'This email is already linked to a different distributor.',
    })
  }

  // 3. Send the Supabase invite email
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://ja-portal.vercel.app'
  const redirectTo = `${baseUrl}/b2b/auth/callback`

  let authUserId: string
  try {
    const { data: authData, error: inviteErr } = await c.auth.admin.inviteUserByEmail(email, {
      redirectTo,
      data: {
        b2b_distributor_id: distributorId,
        b2b_distributor_name: dist.display_name,
      },
    })
    if (inviteErr) {
      const msg = String(inviteErr.message || '').toLowerCase()
      if (msg.includes('already') || msg.includes('registered') || (inviteErr as any).status === 422) {
        return res.status(409).json({
          error: 'This email already has a Supabase account. Contact support to link them manually.',
          detail: inviteErr.message,
        })
      }
      return res.status(502).json({
        error: 'Supabase invite failed',
        detail: inviteErr.message,
      })
    }
    if (!authData?.user?.id) {
      return res.status(502).json({ error: 'Supabase invite returned no user id' })
    }
    authUserId = authData.user.id
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || String(e) })
  }

  // 4. Insert b2b_distributor_users row linked to the new auth user
  const { data: distUser, error: insertErr } = await c
    .from('b2b_distributor_users')
    .insert({
      distributor_id: distributorId,
      auth_user_id: authUserId,
      email,
      full_name,
      role,
      invited_at: new Date().toISOString(),
      invited_by: user.id,
      is_active: true,
    })
    .select()
    .single()

  if (insertErr) {
    // Insert failed but the auth.users row was created — orphan situation.
    // Best-effort: delete the auth user so admin can retry cleanly.
    try { await c.auth.admin.deleteUser(authUserId) } catch { /* swallow */ }
    return res.status(500).json({ error: 'Failed to link user to distributor', detail: insertErr.message })
  }

  return res.status(201).json({
    user: distUser,
    invite_sent_to: email,
    redirect_to: redirectTo,
  })
})
