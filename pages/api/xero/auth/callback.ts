// GET /api/xero/auth/callback — OAuth redirect target. Exchanges the code,
// lists the authorised organisations, and stores/refreshes the tokens on
// every xero_connections row (auto-creating rows for unassigned tenants so
// the admin can map them to VPS/JAWS). NOTE: tokens are per-APP, not
// per-tenant — every label row carries the same token pair.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { exchangeAuthCode, listTenants } from '../../../../lib/xero'

function sb() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { code, state, error } = req.query as Record<string, string>
  if (error) return res.status(400).send(`Xero consent failed: ${error}`)
  if (!code) return res.status(400).send('Missing code')
  const cookieState = String(req.headers.cookie || '').match(/ja-xero-oauth-state=([^;]+)/)?.[1]
  if (!cookieState || cookieState !== state) return res.status(400).send('State mismatch — restart the connect flow')

  try {
    const tok = await exchangeAuthCode(code)
    const tenants = await listTenants(tok.access_token)
    const c = sb()
    const expires = new Date(Date.now() + (tok.expires_in || 1800) * 1000).toISOString()

    // Update tokens on ALL existing rows (shared app token), then make sure
    // every authorised tenant has a row (unassigned ones get a TENANT: label
    // placeholder the admin renames to VPS/JAWS via /api/xero/connections).
    const { data: existing } = await c.from('xero_connections').select('id, label, tenant_id')
    for (const row of existing || []) {
      await c.from('xero_connections').update({
        access_token: tok.access_token, refresh_token: tok.refresh_token,
        access_expires_at: expires, updated_at: new Date().toISOString(),
      }).eq('id', row.id)
    }
    const known = new Set((existing || []).map(r => r.tenant_id).filter(Boolean))
    for (const t of tenants) {
      if (known.has(t.tenantId)) continue
      await c.from('xero_connections').insert({
        label: `TENANT:${t.tenantName || t.tenantId}`.slice(0, 60),
        tenant_id: t.tenantId, tenant_name: t.tenantName,
        access_token: tok.access_token, refresh_token: tok.refresh_token,
        access_expires_at: expires,
      })
    }

    res.setHeader('Set-Cookie', 'ja-xero-oauth-state=; Path=/; Max-Age=0')
    return res.redirect(302, '/admin/connections?xero=connected')
  } catch (e: any) {
    return res.status(500).send(`Xero connect failed: ${e?.message || e}`)
  }
}
