// pages/api/crm/users.ts
// GET — active staff list for owner / assignee pickers (view:crm).

import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../lib/authServer'

export const config = { maxDuration: 10 }

function sb() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase not configured')
  return createClient(url, key, { auth: { persistSession: false } })
}

export default withAuth('view:crm', async (_req, res) => {
  const { data, error } = await sb().from('user_profiles')
    .select('id, display_name, email, role').eq('is_active', true).order('display_name', { ascending: true })
  if (error) return res.status(500).json({ error: error.message })
  return res.status(200).json({ users: data || [] })
})
