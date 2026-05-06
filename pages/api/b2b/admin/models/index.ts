// pages/api/b2b/admin/models/index.ts
//
// GET  → list all models (active + inactive), with usage counts
// POST → create a new model { name, sort_order? }
//
// Permission: edit:b2b_distributors (mirrors the other B2B admin endpoints).

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../../lib/authServer'

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

export default withAuth('edit:b2b_distributors', async (req: NextApiRequest, res: NextApiResponse) => {
  const c = sb()

  if (req.method === 'GET') {
    const { data: models, error } = await c
      .from('b2b_models')
      .select('id, name, sort_order, is_active, created_at, updated_at')
      .order('sort_order', { ascending: true })
      .order('name',       { ascending: true })
    if (error) return res.status(500).json({ error: error.message })

    // Usage count: how many catalogue items reference each model
    const { data: counts } = await c
      .from('b2b_catalogue')
      .select('model_id')
      .not('model_id', 'is', null)
    const usage: Record<string, number> = {}
    for (const r of counts || []) {
      const id = (r as any).model_id
      if (id) usage[id] = (usage[id] || 0) + 1
    }

    return res.status(200).json({
      models: (models || []).map(m => ({ ...m, usage_count: usage[m.id] || 0 })),
    })
  }

  if (req.method === 'POST') {
    const body = (req.body && typeof req.body === 'object') ? req.body : {}
    const name = String(body.name || '').trim()
    if (!name) return res.status(400).json({ error: 'name is required' })
    if (name.length > 80) return res.status(400).json({ error: 'name max 80 characters' })

    const sort_order = Number.isFinite(Number(body.sort_order)) ? Number(body.sort_order) : 0

    const { data, error } = await c
      .from('b2b_models')
      .insert({ name, sort_order })
      .select()
      .single()
    if (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'A model with that name already exists' })
      return res.status(500).json({ error: error.message })
    }
    return res.status(201).json({ model: data })
  }

  res.setHeader('Allow', 'GET, POST')
  return res.status(405).json({ error: 'GET or POST only' })
})
