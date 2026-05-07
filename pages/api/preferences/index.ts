// pages/api/preferences/index.ts
// GET   — return current user's preferences (creates default row on first access)
// PATCH — update one or more preferences
//
// Any authenticated user can manage their own preferences.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../lib/authServer'

function getAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  )
}

// Whitelist of keys users are allowed to update via PATCH.
// Prevents users from setting arbitrary columns (e.g. user_id, created_at).
const PATCHABLE_KEYS = new Set([
  'gst_display',
  'default_date_range',
  'auto_refresh_seconds',
  'timezone',
  'decimal_precision',
  'locale',
  'theme',
  'company_logo_url',
  'nav_groups',
])

// Coerce + validate the nav_groups payload. Rejects on shape mismatch;
// returns the cleaned array on success.
function sanitizeNavGroups(input: any): { ok: true; value: any[] } | { ok: false; error: string } {
  if (!Array.isArray(input)) return { ok: false, error: 'nav_groups must be an array' }
  if (input.length > 50) return { ok: false, error: 'too many groups (max 50)' }
  const cleaned: any[] = []
  const seenIds = new Set<string>()
  for (const g of input) {
    if (!g || typeof g !== 'object') return { ok: false, error: 'each group must be an object' }
    const id = String(g.id || '').trim()
    const name = String(g.name || '').trim()
    if (!id) return { ok: false, error: 'group id required' }
    if (id.length > 64) return { ok: false, error: 'group id too long' }
    if (seenIds.has(id)) return { ok: false, error: `duplicate group id: ${id}` }
    seenIds.add(id)
    if (!name) return { ok: false, error: 'group name required' }
    if (name.length > 80) return { ok: false, error: 'group name too long' }
    if (!Array.isArray(g.item_ids)) return { ok: false, error: `group ${id}: item_ids must be an array` }
    if (g.item_ids.length > 200) return { ok: false, error: `group ${id}: too many items` }
    const itemIds: string[] = []
    for (const it of g.item_ids) {
      if (typeof it !== 'string' || !it) continue
      itemIds.push(it.slice(0, 64))
    }
    cleaned.push({
      id: id.slice(0, 64),
      name: name.slice(0, 80),
      collapsed: !!g.collapsed,
      item_ids: itemIds,
    })
  }
  return { ok: true, value: cleaned }
}

async function handler(req: NextApiRequest, res: NextApiResponse, user: any) {
  const sb = getAdmin()

  if (req.method === 'GET') {
    // Upsert defaults if no row exists, then return the row
    const { data: existing } = await sb
      .from('user_preferences')
      .select('*')
      .eq('user_id', user.id)
      .maybeSingle()

    if (existing) {
      return res.status(200).json({ preferences: existing })
    }

    const { data: created, error: insErr } = await sb
      .from('user_preferences')
      .insert({ user_id: user.id })
      .select()
      .single()
    if (insErr) return res.status(500).json({ error: insErr.message })
    return res.status(200).json({ preferences: created })
  }

  if (req.method === 'PATCH') {
    const body = req.body || {}
    const patch: Record<string, any> = {}
    for (const key of Object.keys(body)) {
      if (PATCHABLE_KEYS.has(key)) patch[key] = body[key]
    }
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: 'No patchable fields in request body' })
    }

    if ('nav_groups' in patch) {
      const result = sanitizeNavGroups(patch.nav_groups)
      if (!result.ok) return res.status(400).json({ error: `nav_groups: ${result.error}` })
      patch.nav_groups = result.value
    }

    // Ensure row exists first (in case GET was never called)
    await sb.from('user_preferences').upsert({ user_id: user.id }, { onConflict: 'user_id' })

    const { data, error } = await sb
      .from('user_preferences')
      .update(patch)
      .eq('user_id', user.id)
      .select()
      .single()
    if (error) return res.status(500).json({ error: error.message })

    return res.status(200).json({ preferences: data })
  }

  return res.status(405).json({ error: 'Method not allowed' })
}

export default withAuth(null, handler)  // any authenticated user; no specific permission required
