// pages/api/b2b/admin/freight-carriers/index.ts
//
// GET /api/b2b/admin/freight-carriers
//   Returns the carrier registry plus the (masked) connection state for
//   each provider. Used by the Carrier Connections card on the B2B
//   settings page.
//
// Per-provider mutations live in [provider].ts (PUT/DELETE) and
// [provider]/test.ts (POST).

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../../lib/authServer'
import {
  PROVIDERS, PROVIDER_ORDER, maskCredentials, type ProviderId,
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

export default withAuth('admin:b2b', async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'GET only' })
  }

  const c = sb()
  const { data: rows, error } = await c
    .from('b2b_freight_carrier_connections')
    .select('provider, is_active, environment, credentials, last_test_at, last_test_ok, last_test_error, updated_at')
  if (error) return res.status(500).json({ error: error.message })

  const byProvider = new Map<string, any>()
  for (const r of rows || []) byProvider.set(r.provider, r)

  const carriers = PROVIDER_ORDER.map((id: ProviderId) => {
    const def = PROVIDERS[id]
    const row = byProvider.get(id)
    return {
      provider:    id,
      label:       def.label,
      blurb:       def.blurb,
      docsUrl:     def.docsUrl,
      environments: def.environments,
      fields: def.fields.map(f => ({
        key:      f.key,
        label:    f.label,
        hint:     f.hint || null,
        type:     f.type,
        required: f.required,
      })),
      connected:    !!row,
      is_active:    row ? !!row.is_active : false,
      environment: (row?.environment as 'live' | 'sandbox') || (def.environments[0] || 'live'),
      credentials:  maskCredentials(def, row?.credentials || null),
      last_test_at:    row?.last_test_at || null,
      last_test_ok:    row?.last_test_ok ?? null,
      last_test_error: row?.last_test_error || null,
      updated_at:      row?.updated_at || null,
    }
  })

  return res.status(200).json({ carriers })
})
