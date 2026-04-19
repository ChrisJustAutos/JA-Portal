// pages/api/vin-codes/mutate.ts
// POST: apply mutations to vin_model_codes.
// Body: { action, payload }
// Supported actions:
//   - upsert: { vin_prefix, model_code, friendly_name?, notes? }
//   - delete: { id } OR { vin_prefix }

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { invalidateVinCache } from '../../../lib/vinCodes'

function getSb() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars not configured')
  return createClient(url, key, { auth: { persistSession: false } })
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  const cookie = req.cookies['ja_portal_auth']
  const pw = process.env.PORTAL_PASSWORD || 'justautos2026'
  if (!cookie) return res.status(401).json({ error: 'Unauthenticated' })
  try {
    if (Buffer.from(cookie, 'base64').toString('utf8') !== pw) {
      return res.status(401).json({ error: 'Unauthenticated' })
    }
  } catch { return res.status(401).json({ error: 'Unauthenticated' }) }

  const { action, payload } = req.body || {}
  if (!action) return res.status(400).json({ error: 'action required' })

  try {
    const sb = getSb()
    let result: any = null

    switch (action) {
      case 'upsert': {
        const { vin_prefix, model_code, friendly_name, notes } = payload || {}
        if (!vin_prefix || !model_code) return res.status(400).json({ error: 'vin_prefix and model_code required' })
        // Normalise — uppercase, trim
        const prefix = String(vin_prefix).trim().toUpperCase()
        if (prefix.length < 2) return res.status(400).json({ error: 'vin_prefix must be at least 2 chars' })
        const { data, error } = await sb.from('vin_model_codes')
          .upsert({
            vin_prefix: prefix,
            model_code: String(model_code).trim(),
            friendly_name: friendly_name ? String(friendly_name).trim() : null,
            notes: notes ? String(notes).trim() : null,
            updated_at: new Date().toISOString(),
          }, { onConflict: 'vin_prefix' })
          .select().single()
        if (error) throw error
        result = data
        break
      }
      case 'delete': {
        const { id, vin_prefix } = payload || {}
        if (!id && !vin_prefix) return res.status(400).json({ error: 'id or vin_prefix required' })
        const query = sb.from('vin_model_codes').delete()
        const { error } = id ? await query.eq('id', id) : await query.eq('vin_prefix', String(vin_prefix).trim().toUpperCase())
        if (error) throw error
        result = { deleted: true }
        break
      }
      default:
        return res.status(400).json({ error: `Unknown action: ${action}` })
    }

    invalidateVinCache()
    res.status(200).json({ success: true, result })
  } catch (e: any) {
    console.error('vin-codes mutate error:', e)
    res.status(500).json({ error: e.message || 'Mutation failed' })
  }
}
