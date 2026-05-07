// pages/api/b2b/team/users/[id].ts
//
//   PATCH  /api/b2b/team/users/{id}  — update full_name, role, is_active. Owner only.
//   DELETE /api/b2b/team/users/{id}  — remove the user (and their auth.users row). Owner only.
//
// Safety rails enforced server-side:
//   - You can't change your own role (an owner who self-demotes locks themselves out).
//   - You can't deactivate or remove yourself via this endpoint.
//   - You can't demote / deactivate / remove the last active owner on the distributor.
//
// The target user's distributor is verified to match the caller's distributor —
// owners cannot manage users in another distributor.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withB2BAuth, B2BUser } from '../../../../../lib/b2bAuthServer'

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

export default withB2BAuth(async (req: NextApiRequest, res: NextApiResponse, user: B2BUser) => {
  const id = String(req.query.id || '').trim()
  if (!id) return res.status(400).json({ error: 'Missing user id' })

  if (user.role !== 'owner') {
    return res.status(403).json({ error: 'Only owners can manage users.' })
  }

  // Load the target row first so we can range-check distributor + apply
  // last-owner / self-edit guards before mutating.
  const c = sb()
  const { data: target, error: targetErr } = await c
    .from('b2b_distributor_users')
    .select('id, auth_user_id, email, role, is_active, distributor_id')
    .eq('id', id)
    .maybeSingle()
  if (targetErr) return res.status(500).json({ error: targetErr.message })
  if (!target || target.distributor_id !== user.distributor.id) {
    return res.status(404).json({ error: 'User not found on your distributor.' })
  }

  if (req.method === 'PATCH')  return handlePatch(c, user, target, req, res)
  if (req.method === 'DELETE') return handleDelete(c, user, target, res)
  res.setHeader('Allow', 'PATCH, DELETE')
  return res.status(405).json({ error: 'PATCH or DELETE only' })
})

async function activeOwnerCount(c: SupabaseClient, distributorId: string): Promise<number> {
  const { count } = await c
    .from('b2b_distributor_users')
    .select('id', { count: 'exact', head: true })
    .eq('distributor_id', distributorId)
    .eq('role', 'owner')
    .eq('is_active', true)
  return count || 0
}

async function handlePatch(
  c: SupabaseClient,
  caller: B2BUser,
  target: { id: string; role: string; is_active: boolean; distributor_id: string },
  req: NextApiRequest,
  res: NextApiResponse,
) {
  const body = (req.body && typeof req.body === 'object') ? req.body : {}
  const update: Record<string, any> = {}
  for (const k of EDITABLE) {
    if (Object.prototype.hasOwnProperty.call(body, k)) update[k] = body[k]
  }
  if (Object.keys(update).length === 0) {
    return res.status(400).json({ error: 'No editable fields supplied' })
  }
  if ('role' in update && !(VALID_ROLES as readonly string[]).includes(update.role)) {
    return res.status(400).json({ error: `role must be one of ${VALID_ROLES.join(', ')}` })
  }
  if ('is_active' in update && typeof update.is_active !== 'boolean') {
    return res.status(400).json({ error: 'is_active must be boolean' })
  }
  if ('full_name' in update && update.full_name != null) {
    update.full_name = String(update.full_name).trim() || null
  }

  // Self-edit guards
  const isSelf = target.id === caller.id
  if (isSelf && 'role' in update && update.role !== target.role) {
    return res.status(400).json({ error: "You can't change your own role. Ask another owner." })
  }
  if (isSelf && 'is_active' in update && update.is_active === false) {
    return res.status(400).json({ error: "You can't deactivate yourself." })
  }

  // Last-owner guard: if this change would remove the last active owner, block.
  const removesOwner =
    (target.role === 'owner' && target.is_active && (
      ('role' in update && update.role !== 'owner') ||
      ('is_active' in update && update.is_active === false)
    ))
  if (removesOwner) {
    const owners = await activeOwnerCount(c, target.distributor_id)
    if (owners <= 1) {
      return res.status(400).json({ error: 'Your distributor must have at least one active owner.' })
    }
  }

  const { data, error } = await c
    .from('b2b_distributor_users')
    .update(update)
    .eq('id', target.id)
    .eq('distributor_id', target.distributor_id)
    .select()
    .single()
  if (error) return res.status(500).json({ error: error.message })
  if (!data)  return res.status(404).json({ error: 'User not found' })
  return res.status(200).json({ user: data })
}

async function handleDelete(
  c: SupabaseClient,
  caller: B2BUser,
  target: { id: string; auth_user_id: string | null; email: string; role: string; is_active: boolean; distributor_id: string },
  res: NextApiResponse,
) {
  if (target.id === caller.id) {
    return res.status(400).json({ error: "You can't remove yourself. Ask another owner." })
  }
  if (target.role === 'owner' && target.is_active) {
    const owners = await activeOwnerCount(c, target.distributor_id)
    if (owners <= 1) {
      return res.status(400).json({ error: 'Your distributor must have at least one active owner.' })
    }
  }

  const { error: delErr } = await c
    .from('b2b_distributor_users')
    .delete()
    .eq('id', target.id)
  if (delErr) return res.status(500).json({ error: delErr.message })

  if (target.auth_user_id) {
    try { await c.auth.admin.deleteUser(target.auth_user_id) } catch { /* swallow */ }
  }
  return res.status(200).json({ ok: true, removed_email: target.email })
}
