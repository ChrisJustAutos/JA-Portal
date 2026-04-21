// pages/api/users/[id].ts
// PATCH  — update role, display_name, is_active (admin only)
// DELETE — remove user entirely (admin only; prevents self-delete)

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { withAuth, audit } from '../../../lib/authServer'
import { PORTAL_TABS } from '../../../lib/permissions'

function getAdmin() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

async function patch(req: NextApiRequest, res: NextApiResponse, actor: any) {
  const id = req.query.id as string
  if (!id) return res.status(400).json({ error: 'id required' })
  const { role, display_name, is_active, visible_tabs } = req.body || {}
  const validRoles = ['admin','manager','sales','accountant','viewer']
  if (role !== undefined && !validRoles.includes(role)) return res.status(400).json({ error: 'Invalid role' })

  // Prevent self-demoting (admin can't remove their own admin role — safety against locking yourself out)
  if (id === actor.id && role !== undefined && role !== 'admin') {
    return res.status(400).json({ error: 'Cannot change your own admin role' })
  }
  // Prevent self-deactivating
  if (id === actor.id && is_active === false) {
    return res.status(400).json({ error: 'Cannot deactivate your own account' })
  }

  const sb = getAdmin()
  const patch: any = {}
  if (role !== undefined) patch.role = role
  if (display_name !== undefined) patch.display_name = display_name
  if (is_active !== undefined) patch.is_active = is_active

  // visible_tabs: null = reset to role defaults; array = explicit allowlist
  if (visible_tabs !== undefined) {
    if (visible_tabs === null) {
      patch.visible_tabs = null
    } else if (Array.isArray(visible_tabs)) {
      const validIds = new Set(PORTAL_TABS.map(t => t.id))
      patch.visible_tabs = visible_tabs.filter((x: any) => typeof x === 'string' && validIds.has(x))
    } else {
      return res.status(400).json({ error: 'visible_tabs must be an array or null' })
    }
  }

  const { data, error } = await sb.from('user_profiles').update(patch).eq('id', id).select().single()
  if (error) return res.status(500).json({ error: error.message })

  audit(actor, 'user_updated', { target_user_id: id, target_email: data?.email, patch })
  return res.status(200).json({ user: data })
}

async function remove(req: NextApiRequest, res: NextApiResponse, actor: any) {
  const id = req.query.id as string
  if (!id) return res.status(400).json({ error: 'id required' })
  if (id === actor.id) return res.status(400).json({ error: 'Cannot delete your own account' })

  const sb = getAdmin()

  // Fetch target info for audit before delete
  const { data: target } = await sb.from('user_profiles').select('email, role').eq('id', id).maybeSingle()

  // Delete auth user (cascades to user_profiles via FK)
  const { error: delErr } = await sb.auth.admin.deleteUser(id)
  if (delErr) return res.status(500).json({ error: 'Delete failed: ' + delErr.message })

  audit(actor, 'user_deleted', { target_user_id: id, target_email: target?.email, role: target?.role })
  return res.status(200).json({ success: true })
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'PATCH')  return withAuth('admin:users', patch)(req, res)
  if (req.method === 'DELETE') return withAuth('admin:users', remove)(req, res)
  return res.status(405).json({ error: 'Method not allowed' })
}
