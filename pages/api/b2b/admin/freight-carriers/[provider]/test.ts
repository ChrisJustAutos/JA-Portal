// pages/api/b2b/admin/freight-carriers/[provider]/test.ts
//
// POST /api/b2b/admin/freight-carriers/{provider}/test
//   Runs the provider's testConnection() probe against the stored
//   credentials, persists the result on the row (last_test_*) and
//   returns it. The "Test connection" button in the settings UI calls
//   this; it's separated from the upsert so admins can re-test later
//   without changing creds.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../../../lib/authServer'
import { getProvider, type Environment } from '../../../../../../lib/b2b-freight-carriers'

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
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'POST only' })
  }

  const providerId = String(req.query.provider || '').trim()
  const def = getProvider(providerId)
  if (!def) return res.status(404).json({ error: `Unknown provider "${providerId}"` })

  const c = sb()
  const { data: row, error: loadErr } = await c
    .from('b2b_freight_carrier_connections')
    .select('credentials, environment')
    .eq('provider', def.id)
    .maybeSingle()
  if (loadErr) return res.status(500).json({ error: loadErr.message })
  if (!row) return res.status(400).json({ error: 'No credentials saved yet — connect the carrier first.' })

  const env = (row.environment === 'sandbox' ? 'sandbox' : 'live') as Environment

  let result
  try {
    result = await def.testConnection(row.credentials || {}, env)
  } catch (e: any) {
    result = { ok: false, message: `Probe threw: ${e?.message || String(e)}` }
  }

  const stamp = new Date().toISOString()
  await c
    .from('b2b_freight_carrier_connections')
    .update({
      last_test_at:     stamp,
      last_test_ok:     result.ok,
      last_test_error:  result.ok ? null : result.message,
      last_test_detail: result.detail ?? null,
    })
    .eq('provider', def.id)

  return res.status(200).json({
    ok:      result.ok,
    message: result.message,
    tested_at: stamp,
  })
})
