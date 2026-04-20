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
])

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
