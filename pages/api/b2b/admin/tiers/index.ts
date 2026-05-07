// pages/api/b2b/admin/tiers/index.ts
//
// GET  /api/b2b/admin/tiers  → list all tiers (with distributor counts)
// POST /api/b2b/admin/tiers  → create a new tier { name, description?, display_order? }
//
// Permission: edit:b2b_distributors (same gate as the rest of distributor management).

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth, PortalUser } from '../../../../../lib/authServer'

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

export default withAuth('edit:b2b_distributors', async (req: NextApiRequest, res: NextApiResponse, user: PortalUser) => {
  const c = sb()
  if (req.method === 'GET') {
    const { data: tiers, error } = await c
      .from('b2b_tiers')
      .select('id, name, description, display_order, is_active, created_at, updated_at')
      .order('display_order', { ascending: true })
      .order('name',          { ascending: true })
    if (error) return res.status(500).json({ error: error.message })

    const ids = (tiers || []).map(t => t.id)
    const usage: Record<string, number> = {}
    if (ids.length > 0) {
      const { data: dists } = await c
        .from('b2b_distributors')
        .select('tier_id, is_active')
        .in('tier_id', ids)
      for (const d of dists || []) {
        if (d.is_active && d.tier_id) usage[d.tier_id] = (usage[d.tier_id] || 0) + 1
      }
    }
    return res.status(200).json({
      tiers: (tiers || []).map(t => ({
        id: t.id,
        name: t.name,
        description: t.description,
        // Alias for the shared TaxonomyEditor, which expects sort_order + usage_count.
        sort_order: t.display_order,
        display_order: t.display_order,
        is_active: t.is_active,
        usage_count: usage[t.id] || 0,
        created_at: t.created_at,
        updated_at: t.updated_at,
      })),
    })
  }

  if (req.method === 'POST') {
    const body = (req.body && typeof req.body === 'object') ? req.body : {}
    const name        = String(body.name || '').trim()
    const description = body.description ? String(body.description).trim() || null : null
    const sort_order  = Number.isFinite(Number(body.display_order)) ? Number(body.display_order) : 0
    if (!name) return res.status(400).json({ error: 'name is required' })
    if (name.length > 80) return res.status(400).json({ error: 'name max 80 characters' })

    const { data, error } = await c
      .from('b2b_tiers')
      .insert({ name, description, display_order: sort_order, created_by: user.id })
      .select()
      .single()
    if (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'A tier with that name already exists' })
      return res.status(500).json({ error: error.message })
    }
    return res.status(201).json({ tier: data })
  }

  res.setHeader('Allow', 'GET, POST')
  return res.status(405).json({ error: 'GET or POST only' })
})
