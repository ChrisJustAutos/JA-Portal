// pages/api/users/audit.ts
// GET — recent audit log events (admin only)

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../lib/authServer'

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' })

  const limit = Math.min(parseInt((req.query.limit as string) || '100'), 500)
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

  const { data, error } = await sb
    .from('auth_audit_log')
    .select('id, actor_id, actor_email, action, target_user_id, target_email, details, created_at')
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) return res.status(500).json({ error: error.message })
  return res.status(200).json({ rows: data || [] })
}

export default withAuth('admin:audit_log', handler)
