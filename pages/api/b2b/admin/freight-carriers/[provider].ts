// pages/api/b2b/admin/freight-carriers/[provider].ts
//
// PUT    /api/b2b/admin/freight-carriers/{provider}
//   Upsert credentials + environment + active flag for a single carrier.
//   Body: { environment: 'live'|'sandbox', is_active?: boolean,
//           credentials: { /* provider-specific keys */ } }
//   Secret-field values that come back as masked placeholders ("••••xxxx")
//   are treated as "leave alone" so the admin can edit one field without
//   retyping the others.
//
// DELETE /api/b2b/admin/freight-carriers/{provider}
//   Removes the row entirely.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../../lib/authServer'
import {
  getProvider, maskCredentials, mergeCredentialUpdate, type Environment,
} from '../../../../../lib/b2b-freight-carriers'

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

export default withAuth('admin:b2b', async (req: NextApiRequest, res: NextApiResponse, user) => {
  const providerId = String(req.query.provider || '').trim()
  const def = getProvider(providerId)
  if (!def) return res.status(404).json({ error: `Unknown provider "${providerId}"` })

  const c = sb()

  if (req.method === 'PUT') {
    const body = (req.body || {}) as Record<string, any>

    const env = (body.environment === 'sandbox' ? 'sandbox' : 'live') as Environment
    if (!def.environments.includes(env)) {
      return res.status(400).json({ error: `${def.label} does not support the "${env}" environment` })
    }
    const isActive = body.is_active !== false

    // Load whatever's there now so we can carry over secret fields the
    // browser couldn't see.
    const { data: existing, error: loadErr } = await c
      .from('b2b_freight_carrier_connections')
      .select('credentials')
      .eq('provider', def.id)
      .maybeSingle()
    if (loadErr) return res.status(500).json({ error: loadErr.message })

    const merged = mergeCredentialUpdate(def, existing?.credentials || null, body.credentials || {})
    if (merged.missing.length > 0) {
      return res.status(400).json({
        error: `Missing required field${merged.missing.length === 1 ? '' : 's'}: ${merged.missing.join(', ')}`,
      })
    }

    const { data: row, error: upErr } = await c
      .from('b2b_freight_carrier_connections')
      .upsert({
        provider:        def.id,
        environment:     env,
        is_active:       isActive,
        credentials:     merged.creds,
        updated_by:      user.id,
        // A creds change invalidates the previous test result.
        last_test_at:    null,
        last_test_ok:    null,
        last_test_error: null,
        last_test_detail: null,
      }, { onConflict: 'provider' })
      .select()
      .single()
    if (upErr) return res.status(500).json({ error: upErr.message })

    return res.status(200).json({
      carrier: {
        provider:        def.id,
        connected:       true,
        is_active:       row.is_active,
        environment:     row.environment,
        credentials:     maskCredentials(def, row.credentials),
        last_test_at:    row.last_test_at,
        last_test_ok:    row.last_test_ok,
        last_test_error: row.last_test_error,
        updated_at:      row.updated_at,
      },
    })
  }

  if (req.method === 'DELETE') {
    const { error } = await c
      .from('b2b_freight_carrier_connections')
      .delete()
      .eq('provider', def.id)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  res.setHeader('Allow', 'PUT, DELETE')
  return res.status(405).json({ error: 'Method not allowed' })
})
