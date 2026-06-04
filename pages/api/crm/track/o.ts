// pages/api/crm/track/o.ts — open-tracking pixel. ?t=<recipient token>.
// Returns a 1x1 transparent GIF and records the open (best-effort).
import { createClient } from '@supabase/supabase-js'
import type { NextApiRequest, NextApiResponse } from 'next'

const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64')

function sb() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  return createClient(url!, key!, { auth: { persistSession: false } })
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Content-Type', 'image/gif')
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private')
  const t = String(req.query.t || '')
  if (t) {
    try {
      const db = sb()
      const { data: r } = await db.from('crm_campaign_recipients').select('id, campaign_id, opened_at, open_count').eq('token', t).single()
      if (r) {
        await db.from('crm_campaign_recipients').update({ opened_at: r.opened_at || new Date().toISOString(), open_count: (r.open_count || 0) + 1 }).eq('id', r.id)
        await db.from('crm_email_events').insert({ recipient_id: r.id, campaign_id: r.campaign_id, type: 'open' })
      }
    } catch { /* never let tracking break image delivery */ }
  }
  return res.status(200).send(PIXEL)
}
