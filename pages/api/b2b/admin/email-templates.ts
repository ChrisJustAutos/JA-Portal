// pages/api/b2b/admin/email-templates.ts
// Manage the editable B2B email templates.
//   GET            → all templates merged with code defaults + variable metadata
//   PUT  { key, enabled, subject, body }  → upsert an override
//   DELETE ?key=   → reset a template to its code default

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../lib/authServer'
import { listTemplatesWithOverrides, TEMPLATE_DEFS, type TemplateKey } from '../../../../lib/email-templates'

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

const VALID_KEYS = new Set(Object.keys(TEMPLATE_DEFS))

export default withAuth('edit:b2b_distributors', async (req: NextApiRequest, res: NextApiResponse, user) => {
  const c = sb()

  if (req.method === 'GET') {
    return res.status(200).json({ templates: await listTemplatesWithOverrides() })
  }

  if (req.method === 'PUT') {
    const body = (req.body && typeof req.body === 'object') ? req.body : {}
    const key = String(body.key || '')
    if (!VALID_KEYS.has(key)) return res.status(400).json({ error: 'Unknown template key' })
    const subject = String(body.subject ?? '').slice(0, 300)
    const text = String(body.body ?? '').slice(0, 20000)
    const enabled = body.enabled !== false
    const { error } = await c.from('b2b_email_templates').upsert({
      key, enabled, subject: subject || null, body: text || null,
      updated_at: new Date().toISOString(), updated_by: user.id,
    }, { onConflict: 'key' })
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  if (req.method === 'DELETE') {
    const key = String(req.query.key || '')
    if (!VALID_KEYS.has(key)) return res.status(400).json({ error: 'Unknown template key' })
    const { error } = await c.from('b2b_email_templates').delete().eq('key', key as TemplateKey)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true, reset: true })
  }

  res.setHeader('Allow', 'GET, PUT, DELETE')
  return res.status(405).json({ error: 'GET, PUT or DELETE only' })
})
