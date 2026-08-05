// /api/xero/connections — admin management of Xero organisation ↔ entity mapping.
//   GET             → list connections (token values never returned)
//   PATCH {id,label} → assign an organisation to an entity label ('VPS'|'JAWS')
//   POST {action:'ping', label} → live API check for a label (Organisation read)

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../lib/authServer'
import { roleHasPermission } from '../../../lib/permissions'
import { xeroFetch, XeroLabel } from '../../../lib/xero'

function sb() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

export default withAuth(null, async (req: NextApiRequest, res: NextApiResponse, user: any) => {
  if (!roleHasPermission(user.role, 'admin:settings')) return res.status(403).json({ error: 'Admin only' })
  const c = sb()

  if (req.method === 'GET') {
    const { data } = await c.from('xero_connections')
      .select('id, label, tenant_id, tenant_name, access_expires_at, is_active, created_at, updated_at')
      .order('label')
    return res.status(200).json({ connections: data || [] })
  }

  if (req.method === 'PATCH') {
    const { id, label } = (req.body || {}) as { id?: string; label?: string }
    if (!id || !label) return res.status(400).json({ error: 'id and label required' })
    if (!['VPS', 'JAWS'].includes(label)) return res.status(400).json({ error: 'label must be VPS or JAWS' })
    // Free the label if it's currently on another row (placeholder swap).
    const { data: holder } = await c.from('xero_connections').select('id, tenant_name').eq('label', label).maybeSingle()
    if (holder && holder.id !== id) {
      await c.from('xero_connections').update({ label: `TENANT:${holder.tenant_name || holder.id}`.slice(0, 60) }).eq('id', holder.id)
    }
    const { data, error } = await c.from('xero_connections').update({ label, updated_at: new Date().toISOString() }).eq('id', id).select().single()
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ connection: { ...data, access_token: undefined, refresh_token: undefined } })
  }

  if (req.method === 'POST' && (req.body || {}).action === 'ping') {
    const label = String((req.body || {}).label || '') as XeroLabel
    if (!['VPS', 'JAWS'].includes(label)) return res.status(400).json({ error: 'label must be VPS or JAWS' })
    try {
      const org = await xeroFetch<any>(label, '/Organisation')
      const o = org?.Organisations?.[0]
      return res.status(200).json({ ok: true, organisation: o?.Name, shortCode: o?.ShortCode, countryCode: o?.CountryCode })
    } catch (e: any) {
      return res.status(502).json({ ok: false, error: e?.message || String(e) })
    }
  }

  res.setHeader('Allow', 'GET, PATCH, POST')
  return res.status(405).json({ error: 'GET, PATCH or POST only' })
})
