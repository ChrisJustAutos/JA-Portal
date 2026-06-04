// pages/api/crm/segments/preview.ts
// POST { definition, audience_all } — returns the mailable audience count + a
// small sample, so the composer can show "will send to N contacts" live.

import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../lib/authServer'
import { buildAudience } from '../../../../lib/crm-campaigns'

export const config = { maxDuration: 15 }

function sb() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase not configured')
  return createClient(url, key, { auth: { persistSession: false } })
}

export default withAuth('view:crm', async (req, res) => {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }) }
  let body: any = {}
  try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
  catch { return res.status(400).json({ error: 'Bad JSON body' }) }
  const audience = await buildAudience(sb(), body.definition || {}, !!body.audience_all)
  return res.status(200).json({ count: audience.length, sample: audience.slice(0, 8).map(c => ({ name: c.name, email: c.email })) })
})
