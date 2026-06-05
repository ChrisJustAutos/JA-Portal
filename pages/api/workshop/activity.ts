// pages/api/workshop/activity.ts
// GET ?entity=&limit= — recent workshop activity feed (view:diary).

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
  const entity = String(req.query.entity || '').trim()
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200))
  let q = sb().from('workshop_activity')
    .select('id, action, entity, entity_id, entity_label, detail, actor_name, created_at')
    .order('created_at', { ascending: false }).limit(limit)
  if (entity) q = q.eq('entity', entity)
  const { data, error } = await q
  if (error) return res.status(500).json({ error: error.message })
  return res.status(200).json({ activity: data || [] })
})
