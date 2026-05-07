// pages/api/b2b/admin/tiers/[id].ts
//
// PATCH  /api/b2b/admin/tiers/{id}  → update name, description, display_order, is_active
// DELETE /api/b2b/admin/tiers/{id}  → permanent delete; distributor.tier_id is set NULL by FK
//
// Permission: edit:b2b_distributors

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

const EDITABLE = ['name', 'description', 'display_order', 'is_active'] as const

export default withAuth('edit:b2b_distributors', async (req: NextApiRequest, res: NextApiResponse) => {
  const id = String(req.query.id || '').trim()
  if (!id) return res.status(400).json({ error: 'Missing id' })

  const c = sb()
  if (req.method === 'PATCH') {
    const body = (req.body && typeof req.body === 'object') ? req.body : {}
    const update: Record<string, any> = {}
    for (const k of EDITABLE) {
      if (Object.prototype.hasOwnProperty.call(body, k)) update[k] = body[k]
    }
    if (Object.keys(update).length === 0) return res.status(400).json({ error: 'No editable fields supplied' })

    if ('name' in update) {
      const v = String(update.name || '').trim()
      if (!v) return res.status(400).json({ error: 'name cannot be empty' })
      if (v.length > 80) return res.status(400).json({ error: 'name max 80 characters' })
      update.name = v
    }
    if ('description' in update) {
      update.description = update.description != null && String(update.description).trim() !== ''
        ? String(update.description).trim()
        : null
    }
    if ('display_order' in update) {
      const v = Number(update.display_order)
      if (!Number.isFinite(v)) return res.status(400).json({ error: 'display_order must be a number' })
      update.display_order = Math.round(v)
    }
    if ('is_active' in update && typeof update.is_active !== 'boolean') {
      return res.status(400).json({ error: 'is_active must be boolean' })
    }
    update.updated_at = new Date().toISOString()

    const { data, error } = await c.from('b2b_tiers').update(update).eq('id', id).select().single()
    if (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'A tier with that name already exists' })
      return res.status(500).json({ error: error.message })
    }
    if (!data) return res.status(404).json({ error: 'Tier not found' })
    return res.status(200).json({ tier: data })
  }

  if (req.method === 'DELETE') {
    const { error } = await c.from('b2b_tiers').delete().eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  res.setHeader('Allow', 'PATCH, DELETE')
  return res.status(405).json({ error: 'PATCH or DELETE only' })
})
