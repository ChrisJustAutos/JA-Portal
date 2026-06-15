// pages/api/workshop/users-lite.ts
// GET — minimal active-user list (id, name, email) for workshop pickers such as
// the quote salesperson selector. Names/ids only; gated view:diary.

import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../lib/authServer'

export const config = { maxDuration: 10 }

function sb() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase not configured')
  return createClient(url, key, { auth: { persistSession: false } })
}

export default withAuth('view:diary', async (req, res) => {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'GET only' }) }
  const db = sb()
  const { data, error } = await db.from('user_profiles')
    .select('id, display_name, email').eq('is_active', true).order('display_name', { ascending: true })
  if (error) return res.status(500).json({ error: error.message })
  return res.status(200).json({ users: data || [] })
})
