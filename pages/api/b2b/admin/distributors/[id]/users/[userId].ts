// pages/api/b2b/admin/distributors/[id]/users/[userId].ts
//
// PATCH  /api/b2b/admin/distributors/{id}/users/{userId}  — update role, full_name, is_active
// DELETE /api/b2b/admin/distributors/{id}/users/{userId}  — remove user (also removes auth.users row)
//
// Permission: edit:b2b_distributors

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
const EDITABLE = ['full_name', 'role', 'is_active'] as const

export default withAuth('edit:b2b_distributors', async (req: NextApiRequest, res: NextApiResponse, _user: PortalUser) => {
  const distributorId = String(req.query.id || '').trim()
  const userId        = String(req.query.userId || '').trim()
  if (!distributorId) return res.status(400).json({ error: 'Missing distributor id' })
  if (!userId)        return res.status(400).json({ error: 'Missing user id' })

  if (req.method === 'PATCH')  return handlePatch(distributorId, userId, req, res)
  if (req.method === 'DELETE') return handleDelete(distributorId, userId, res)
  res.setHeader('Allow', 'PATCH, DELETE')
  return res.status(405).json({ error: 'PATCH or DELETE only' })
})

async function handlePatch(distId: string, userId: string, req: NextApiRequest, res: NextApiResponse) {
  const body = (req.body && typeof req.body === 'object') ? req.body : {}
  const update: Record<string, any> = {}
  for (const key of EDITABLE) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      update[key] = body[key]
    }
  }
  if (Object.keys(update).length === 0) {
    return res.status(400).json({ error: 'No editable fields supplied' })
  }
  if ('role' in update && !VALID_ROLES.includes(update.role)) {
    return res.status(400).json({ error: `role must be one of ${VALID_ROLES.join(', ')}` })
  }
  if ('is_active' in update && typeof update.is_active !== 'boolean') {
    return res.status(400).json({ error: 'is_active must be boolean' })
  }
  if ('full_name' in update && update.full_name != null) {
    update.full_name = String(update.full_name).trim() || null
  }

  const c = sb()
  const { data, error } = await c
    .from('b2b_distributor_users')
    .update(update)
    .eq('id', userId)
    .eq('distributor_id', distId)
    .select()
    .single()
  if (error) return res.status(500).json({ error: error.message })
  if (!data) return res.status(404).json({ error: 'User not found on this distributor' })
  return res.status(200).json({ user: data })
}

async function handleDelete(distId: string, userId: string, res: NextApiResponse) {
  const c = sb()
  // Look up the user first so we can also clean up the auth.users record
  const { data: existing, error: fetchErr } = await c
    .from('b2b_distributor_users')
    .select('id, auth_user_id, email')
    .eq('id', userId)
    .eq('distributor_id', distId)
    .maybeSingle()
  if (fetchErr) return res.status(500).json({ error: fetchErr.message })
  if (!existing) return res.status(404).json({ error: 'User not found on this distributor' })

  const { error: delErr } = await c
    .from('b2b_distributor_users')
    .delete()
    .eq('id', userId)
  if (delErr) return res.status(500).json({ error: delErr.message })

  // Best-effort: remove the auth.users record so the email can be re-invited later
  if (existing.auth_user_id) {
    try { await c.auth.admin.deleteUser(existing.auth_user_id) } catch { /* swallow */ }
  }

  return res.status(200).json({ ok: true, removed_email: existing.email })
}
