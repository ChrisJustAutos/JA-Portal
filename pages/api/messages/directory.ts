// pages/api/messages/directory.ts
// Lightweight active-staff directory for the chat member/mention/DM pickers.
// Any user with chat access (view:messages) can read it — unlike /api/users
// which is admin-only.

import type { NextApiRequest, NextApiResponse } from 'next'
import { requireAuth, getSessionUser } from '../../../lib/auth'
import { roleHasPermission } from '../../../lib/permissions'
import { svc } from '../../../lib/messaging'

export const config = { maxDuration: 10 }

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  return requireAuth(req, res, async () => {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
    const me = (await getSessionUser(req))!
    if (!roleHasPermission(me.role, 'view:messages')) return res.status(403).json({ error: 'Forbidden' })

    const { data } = await svc().from('user_profiles')
      .select('id, display_name, email, role')
      .eq('is_active', true)
      .order('display_name', { ascending: true })

    const users = (data || []).map(u => ({ id: u.id, name: u.display_name || u.email, email: u.email, role: u.role }))
    return res.status(200).json({ users, meId: me.id })
  })
}
