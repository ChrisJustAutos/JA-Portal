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

const VALID_ROLES = ['owner', 'member'] as const

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
  const role      = body.role && VALID_ROLES.includes(body.role) ? body.role : 'member'

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

  // 2. Same-distributor duplicate → reject. An existing account on ANOTHER
  //    distributor gets LINKED as an extra membership (multi-site owners,
  //    e.g. Hunter Mechanical) — no invite email needed.
  const { data: existingRows } = await c
    .from('b2b_distributor_users')
    .select('id, distributor_id, auth_user_id, full_name, is_active')
    .eq('email', email)  // already lowercase
  if ((existingRows || []).some(r => r.distributor_id === distributorId)) {
    return res.status(409).json({ error: 'This email is already a user on this distributor.' })
  }
  const linkable = (existingRows || []).find(r => r.auth_user_id)
  if (linkable) {
    const { data: distUser, error: linkErr } = await c
      .from('b2b_distributor_users')
      .insert({
        distributor_id: distributorId,
        auth_user_id: linkable.auth_user_id,
        email,
        full_name: full_name || linkable.full_name,
        role,
        invited_at: new Date().toISOString(),
        invited_by: user.id,
        is_active: true,
      })
      .select()
      .single()
    if (linkErr) return res.status(500).json({ error: 'Failed to link user', detail: linkErr.message })
    return res.status(201).json({
      user: distUser,
      linked_existing: true,
      invite_sent_to: null,
      message: 'Existing portal login linked to this distributor — no invite email sent; they pick the account from the portal header switcher.',
    })
  }

  // 3. Create the auth account WITHOUT Supabase's invite email — its
  //    one-click links get burned by corporate mail scanners (Harrop
  //    2026-08-06). Our own mailer sends a scanner-proof /b2b/welcome link
  //    after the row insert below.
  let authUserId: string
  try {
    const { data: authData, error: createErr } = await c.auth.admin.createUser({
      email,
      email_confirm: false,
      user_metadata: {
        b2b_distributor_id: distributorId,
        b2b_distributor_name: dist.display_name,
      },
    })
    if (createErr) {
      const msg = String(createErr.message || '').toLowerCase()
      if (msg.includes('already') || msg.includes('registered') || (createErr as any).status === 422) {
        return res.status(409).json({
          error: 'This email already has a Supabase account. Contact support to link them manually.',
          detail: createErr.message,
        })
      }
      return res.status(502).json({
        error: 'Account creation failed',
        detail: createErr.message,
      })
    }
    if (!authData?.user?.id) {
      return res.status(502).json({ error: 'Account creation returned no user id' })
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

  // Scanner-proof welcome email (same as the Resend-invite button).
  const { resendInviteEmail } = await import('../../../../../../../lib/b2b-invites')
  const sent = await resendInviteEmail(c, distUser.id)

  return res.status(201).json({
    user: distUser,
    invite_sent_to: sent.ok ? email : null,
    ...(sent.ok ? {} : { warning: `User created but the invite email failed (${sent.error}) — use Resend invite.` }),
  })
})
