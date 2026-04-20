// pages/api/auth/bootstrap.ts
// One-time first-admin setup. Allowed only when no admin exists.
// Creates an auth.users row via Supabase Admin API and an active admin profile.
// After the first admin is created, this endpoint rejects further calls.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { audit } from '../../../lib/authServer'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  const { email, password, displayName } = req.body || {}
  if (!email || !password) return res.status(400).json({ error: 'email and password required' })
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' })

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) return res.status(500).json({ error: 'Server misconfigured — Supabase env vars missing' })

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } })

  // Gate: refuse if any admin already exists
  const { data: anyAdmin, error: checkErr } = await admin
    .from('user_profiles')
    .select('id')
    .eq('role', 'admin')
    .eq('is_active', true)
    .limit(1)
    .maybeSingle()
  if (checkErr) return res.status(500).json({ error: 'Bootstrap check failed: ' + checkErr.message })
  if (anyAdmin) return res.status(403).json({ error: 'Bootstrap already complete — an admin exists. Use the normal login.' })

  // Create the auth user (admin API — requires service role)
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,  // skip email verification for the bootstrap admin
  })
  if (createErr) return res.status(500).json({ error: 'Could not create auth user: ' + createErr.message })
  if (!created?.user) return res.status(500).json({ error: 'Auth user creation returned no user' })

  // Create the profile
  const { error: profileErr } = await admin.from('user_profiles').insert({
    id: created.user.id,
    email: created.user.email,
    display_name: displayName || null,
    role: 'admin',
    is_active: true,
  })
  if (profileErr) {
    // Roll back the auth user if profile creation fails
    await admin.auth.admin.deleteUser(created.user.id).catch(()=>{})
    return res.status(500).json({ error: 'Profile creation failed: ' + profileErr.message })
  }

  audit(null, 'bootstrap_admin_created', { target_user_id: created.user.id, target_email: email, displayName })

  return res.status(200).json({
    success: true,
    user: {
      id: created.user.id,
      email: created.user.email,
      displayName,
      role: 'admin',
    },
  })
}
