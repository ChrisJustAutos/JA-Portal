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
  'accent_color',
  'theme_preset',
  'company_logo_url',
  'nav_groups',
  'app_labels',
  'launcher_order',
  'order_status_groups',
])

const VALID_ORDER_STATUSES = new Set(['pending_payment','paid','picking','packed','shipped','delivered','cancelled','refunded'])

// Coerce + validate order_status_groups: [{ id, name, statuses[] }].
function sanitizeOrderStatusGroups(input: any): { ok: true; value: any[] } | { ok: false; error: string } {
  if (input == null) return { ok: true, value: [] }
  if (!Array.isArray(input)) return { ok: false, error: 'must be an array' }
  if (input.length > 20) return { ok: false, error: 'too many groups (max 20)' }
  const out: any[] = []
  const seen = new Set<string>()
  for (const g of input) {
    if (!g || typeof g !== 'object') return { ok: false, error: 'each group must be an object' }
    const id = String(g.id || '').trim().slice(0, 64)
    const name = String(g.name || '').trim().slice(0, 40)
    if (!id || seen.has(id)) continue
    seen.add(id)
    if (!name) return { ok: false, error: 'group name required' }
    if (!Array.isArray(g.statuses)) return { ok: false, error: 'statuses must be an array' }
    const statuses = Array.from(new Set(g.statuses.filter((s: any) => typeof s === 'string' && VALID_ORDER_STATUSES.has(s))))
    if (statuses.length === 0) continue
    out.push({ id, name, statuses })
  }
  return { ok: true, value: out }
}

// Coerce + validate launcher_order: a flat list of cell id strings.
function sanitizeLauncherOrder(input: any): { ok: true; value: string[] } | { ok: false; error: string } {
  if (input == null) return { ok: true, value: [] }
  if (!Array.isArray(input)) return { ok: false, error: 'launcher_order must be an array' }
  if (input.length > 200) return { ok: false, error: 'too many entries (max 200)' }
  const out: string[] = []
  const seen = new Set<string>()
  for (const it of input) {
    if (typeof it !== 'string') continue
    const id = it.trim().slice(0, 64)
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return { ok: true, value: out }
}

// Coerce + validate app_labels: a flat { appId: customLabel } map.
function sanitizeAppLabels(input: any): { ok: true; value: Record<string, string> } | { ok: false; error: string } {
  if (input == null) return { ok: true, value: {} }
  if (typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'app_labels must be an object' }
  const entries = Object.entries(input as Record<string, any>)
  if (entries.length > 100) return { ok: false, error: 'too many app_labels (max 100)' }
  const out: Record<string, string> = {}
  for (const [k, v] of entries) {
    const key = String(k || '').trim().slice(0, 64)
    if (!key) continue
    const val = String(v ?? '').trim().slice(0, 40)
    if (!val) continue   // empty value = no override; drop it
    out[key] = val
  }
  return { ok: true, value: out }
}

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

    if ('app_labels' in patch) {
      const result = sanitizeAppLabels(patch.app_labels)
      if (!result.ok) return res.status(400).json({ error: `app_labels: ${result.error}` })
      patch.app_labels = result.value
    }

    if ('launcher_order' in patch) {
      const result = sanitizeLauncherOrder(patch.launcher_order)
      if (!result.ok) return res.status(400).json({ error: `launcher_order: ${result.error}` })
      patch.launcher_order = result.value
    }

    if ('order_status_groups' in patch) {
      const result = sanitizeOrderStatusGroups(patch.order_status_groups)
      if (!result.ok) return res.status(400).json({ error: `order_status_groups: ${result.error}` })
      patch.order_status_groups = result.value
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
