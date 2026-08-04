// pages/api/b2b/team/users.ts
//
// Distributor self-service user management.
//
//   GET  /api/b2b/team/users       — list users on the signed-in distributor.
//                                    Any role can view.
//   POST /api/b2b/team/users       — invite a new user. Owner only.
//
// All operations are scoped to the signed-in B2B user's own distributor —
// the distributor id is taken from the session, never the request body, so
// owners cannot reach across distributors.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withB2BAuth, B2BUser } from '../../../../lib/b2bAuthServer'

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

export default withB2BAuth(async (req: NextApiRequest, res: NextApiResponse, user: B2BUser) => {
  if (req.method === 'GET')  return handleList(user, res)
  if (req.method === 'POST') return handleInvite(user, req, res)
  res.setHeader('Allow', 'GET, POST')
  return res.status(405).json({ error: 'GET or POST only' })
})

async function handleList(user: B2BUser, res: NextApiResponse) {
  const c = sb()
  const { data, error } = await c
    .from('b2b_distributor_users')
    .select('id, auth_user_id, email, full_name, role, last_login_at, invited_at, is_active, created_at')
    .eq('distributor_id', user.distributor.id)
    .not('email', 'like', 'preview+%@justautos.app')  // hide the demo/preview user
    .order('created_at', { ascending: true })
  if (error) return res.status(500).json({ error: error.message })
  return res.status(200).json({ users: data || [] })
}

async function handleInvite(user: B2BUser, req: NextApiRequest, res: NextApiResponse) {
  if (user.role !== 'owner') {
    return res.status(403).json({ error: 'Only owners can invite users.' })
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : {}
  const email     = String(body.email || '').trim().toLowerCase()
  const full_name = body.full_name ? String(body.full_name).trim() : null
  const role      = body.role && (VALID_ROLES as readonly string[]).includes(body.role) ? body.role : 'member'

  if (!email) return res.status(400).json({ error: 'email required' })
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'invalid email format' })

  const c = sb()

  // One person can belong to several distributor accounts. Same-account
  // duplicates are rejected; an existing account elsewhere gets LINKED as a
  // new membership (no invite email — they sign in with their existing
  // password and switch accounts in the portal header).
  const { data: existingRows } = await c
    .from('b2b_distributor_users')
    .select('id, distributor_id, auth_user_id, full_name, is_active')
    .eq('email', email)
  const rowsHere = (existingRows || []).filter(r => r.distributor_id === user.distributor.id)
  if (rowsHere.length > 0) {
    return res.status(409).json({ error: 'This email is already a user on your distributor.' })
  }
  const linkable = (existingRows || []).find(r => r.auth_user_id)
  if (linkable) {
    const { data: distUser, error: linkErr } = await c
      .from('b2b_distributor_users')
      .insert({
        distributor_id: user.distributor.id,
        auth_user_id: linkable.auth_user_id,
        email,
        full_name: full_name || linkable.full_name,
        role,
        invited_at: new Date().toISOString(),
        invited_by: user.authUserId,
        is_active: true,
      })
      .select()
      .single()
    if (linkErr) return res.status(500).json({ error: 'Failed to add user', detail: linkErr.message })
    return res.status(201).json({
      user: distUser,
      linked_existing: true,
      invite_sent_to: null,
      message: 'They already had a portal login, so no invite email was sent — they sign in as usual and pick this account from the switcher in the header.',
    })
  }

  // Invited distributor users set a password on arrival (welcome flow), which
  // signs them in and lands them on /b2b.
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://justautos.app'
  const redirectTo = `${baseUrl}/reset-password?welcome=1&next=${encodeURIComponent('/b2b')}`

  let authUserId: string
  try {
    const { data: authData, error: inviteErr } = await c.auth.admin.inviteUserByEmail(email, {
      redirectTo,
      data: {
        b2b_distributor_id: user.distributor.id,
        b2b_distributor_name: user.distributor.displayName,
      },
    })
    if (inviteErr) {
      const msg = String(inviteErr.message || '').toLowerCase()
      if (msg.includes('already') || msg.includes('registered') || (inviteErr as any).status === 422) {
        return res.status(409).json({
          error: 'This email already has a Supabase account. Contact your account manager to link it.',
          detail: inviteErr.message,
        })
      }
      return res.status(502).json({ error: 'Invite failed', detail: inviteErr.message })
    }
    if (!authData?.user?.id) return res.status(502).json({ error: 'Invite returned no user id' })
    authUserId = authData.user.id
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || String(e) })
  }

  const { data: distUser, error: insertErr } = await c
    .from('b2b_distributor_users')
    .insert({
      distributor_id: user.distributor.id,
      auth_user_id: authUserId,
      email,
      full_name,
      role,
      invited_at: new Date().toISOString(),
      // invited_by FKs auth.users — user.id is the b2b_distributor_users ROW
      // id, which violated the FK and failed EVERY owner self-service invite
      // ("Failed to add user", Penrith 2026-07-28).
      invited_by: user.authUserId,
      is_active: true,
    })
    .select()
    .single()
  if (insertErr) {
    try { await c.auth.admin.deleteUser(authUserId) } catch { /* swallow */ }
    return res.status(500).json({ error: 'Failed to add user', detail: insertErr.message })
  }

  return res.status(201).json({
    user: distUser,
    invite_sent_to: email,
  })
}
