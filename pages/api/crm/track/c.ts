// pages/api/crm/track/c.ts — click tracking. ?t=<token>&u=<base64 url>.
// Records the click then 302-redirects to the original URL.
import { createClient } from '@supabase/supabase-js'
import type { NextApiRequest, NextApiResponse } from 'next'
import { appBaseUrl } from '../../../../lib/crm-campaigns'
import { enrolFromEvent } from '../../../../lib/crm-automation-triggers'
import { logActivity } from '../../../../lib/crm'

function sb() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  return createClient(url!, key!, { auth: { persistSession: false } })
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const t = String(req.query.t || '')
  let target = appBaseUrl()
  try {
    const decoded = Buffer.from(decodeURIComponent(String(req.query.u || '')), 'base64').toString('utf8')
    if (/^https?:\/\//i.test(decoded)) target = decoded   // only redirect to http(s) — no open-redirect to other schemes
  } catch { /* fall back to base */ }

  if (t) {
    try {
      const db = sb()
      const { data: r } = await db.from('crm_campaign_recipients').select('id, campaign_id, contact_id, first_clicked_at, click_count').eq('token', t).single()
      if (r) {
        await db.from('crm_campaign_recipients').update({ first_clicked_at: r.first_clicked_at || new Date().toISOString(), click_count: (r.click_count || 0) + 1 }).eq('id', r.id)
        await db.from('crm_email_events').insert({ recipient_id: r.id, campaign_id: r.campaign_id, type: 'click', url: target.slice(0, 500) })
        // First click: timeline entry + the campaign_email_clicked flow trigger.
        if (!r.first_clicked_at && r.contact_id) {
          await logActivity(db, { contact_id: r.contact_id, type: 'campaign_click', body: `Clicked a campaign link: ${target.slice(0, 120)}`, meta: { campaign_id: r.campaign_id, url: target.slice(0, 300) } })
          await enrolFromEvent(db, 'campaign_email_clicked', { contact_id: r.contact_id, campaign_id: r.campaign_id, dedupe_key: `click:${r.id}` })
        }
      }
    } catch { /* still redirect */ }
  }
  res.setHeader('Cache-Control', 'no-store')
  res.redirect(302, target)
}
