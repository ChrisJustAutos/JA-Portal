// pages/api/users/index.ts
// GET  — list all users (admin only)
// POST — invite a new user (admin only). Creates an auth.users row with a
//        temporary password, sets their profile role, and sends a password
//        reset email so they can set their own password.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { withAuth, audit } from '../../../lib/authServer'
import { PORTAL_TABS } from '../../../lib/permissions'

function getAdmin() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

async function list(req: NextApiRequest, res: NextApiResponse) {
  const sb = getAdmin()
  const { data, error } = await sb
    .from('user_profiles')
    .select('id, email, display_name, role, is_active, created_at, last_sign_in_at, visible_tabs')
    .order('created_at', { ascending: false })
  if (error) return res.status(500).json({ error: error.message })
  return res.status(200).json({ users: data || [] })
}

async function invite(req: NextApiRequest, res: NextApiResponse, actor: any) {
  const { email, displayName, role, visible_tabs } = req.body || {}
  if (!email || !role) return res.status(400).json({ error: 'email and role required' })
  const validRoles = ['admin','manager','sales','accountant','viewer']
  if (!validRoles.includes(role)) return res.status(400).json({ error: 'Invalid role' })

  // Validate visible_tabs: must be an array of strings from PORTAL_TABS ids,
  // or null/undefined to use role defaults.
  let tabsToStore: string[] | null = null
  if (visible_tabs !== undefined && visible_tabs !== null) {
    if (!Array.isArray(visible_tabs)) return res.status(400).json({ error: 'visible_tabs must be an array' })
    const validIds = new Set(PORTAL_TABS.map(t => t.id))
    const cleaned = visible_tabs.filter((x: any) => typeof x === 'string' && validIds.has(x))
    tabsToStore = cleaned
  }

  const sb = getAdmin()

  // Check if email already exists (in profiles or auth.users)
  const { data: existing } = await sb.from('user_profiles').select('id').eq('email', email).maybeSingle()
  if (existing) return res.status(409).json({ error: 'Email already registered' })

  // Generate a random initial password the user will never know — they'll set
  // their own via the password reset email we send them.
  const tempPassword = crypto.randomUUID() + 'Aa1!'
  const { data: created, error: createErr } = await sb.auth.admin.createUser({
    email,
    password: tempPassword,
    email_confirm: true,
  })
  if (createErr) return res.status(500).json({ error: 'Auth create failed: ' + createErr.message })
  if (!created?.user) return res.status(500).json({ error: 'No user returned' })

  const { error: profileErr } = await sb.from('user_profiles').insert({
    id: created.user.id,
    email: created.user.email,
    display_name: displayName || null,
    role,
    is_active: true,
    created_by: actor.id,
    visible_tabs: tabsToStore,
  })
  if (profileErr) {
    await sb.auth.admin.deleteUser(created.user.id).catch(()=>{})
    return res.status(500).json({ error: 'Profile creation failed: ' + profileErr.message })
  }

  // Send password reset so user can set their own password
  // This sends an email with a reset link.
  const redirectTo = `${req.headers.origin || 'https://ja-portal.vercel.app'}/reset-password`
  const { error: resetErr } = await sb.auth.resetPasswordForEmail(email, { redirectTo })
  if (resetErr) console.error('Reset email failed:', resetErr)

  audit(actor, 'user_invited', { target_user_id: created.user.id, target_email: email, role, displayName })

  return res.status(200).json({
    success: true,
    user: { id: created.user.id, email, displayName, role, is_active: true },
    resetEmailSent: !resetErr,
  })
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET')  return withAuth('admin:users', list)(req, res)
  if (req.method === 'POST') return withAuth('admin:users', invite)(req, res)
  return res.status(405).json({ error: 'Method not allowed' })
}
