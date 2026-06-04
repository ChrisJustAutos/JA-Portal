// pages/api/crm/resend-webhook.ts
// Optional Resend webhook for deliverability events (bounces/complaints/etc.),
// matched to recipients by Resend's email id. Guarded by ?key=<RESEND_WEBHOOK_SECRET>
// (set that env + add the URL with ?key= in the Resend dashboard to enable).
// A hard bounce or spam complaint auto-sets the contact's marketing_opt_out so
// we stop mailing bad/unhappy addresses.
import { createClient } from '@supabase/supabase-js'
import type { NextApiRequest, NextApiResponse } from 'next'

function sb() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  return createClient(url!, key!, { auth: { persistSession: false } })
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }) }
  const secret = process.env.RESEND_WEBHOOK_SECRET
  if (!secret) return res.status(200).json({ ok: true, skipped: 'not_configured' })
  if (String(req.query.key || '') !== secret) return res.status(401).json({ error: 'Unauthorized' })

  let body: any = {}
  try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
  catch { return res.status(400).json({ error: 'Bad JSON' }) }

  const type = String(body?.type || '')           // e.g. 'email.bounced'
  const emailId = body?.data?.email_id || body?.data?.id
  if (!emailId) return res.status(200).json({ ok: true, skipped: 'no_email_id' })

  try {
    const db = sb()
    const { data: r } = await db.from('crm_campaign_recipients').select('id, campaign_id, contact_id').eq('provider_id', emailId).single()
    if (!r) return res.status(200).json({ ok: true, skipped: 'no_recipient' })

    if (type === 'email.bounced') {
      await db.from('crm_campaign_recipients').update({ status: 'bounced' }).eq('id', r.id)
      await db.from('crm_email_events').insert({ recipient_id: r.id, campaign_id: r.campaign_id, type: 'bounce' })
      if (r.contact_id) await db.from('crm_contacts').update({ marketing_opt_out: true }).eq('id', r.contact_id)
    } else if (type === 'email.complained') {
      await db.from('crm_campaign_recipients').update({ status: 'complained' }).eq('id', r.id)
      await db.from('crm_email_events').insert({ recipient_id: r.id, campaign_id: r.campaign_id, type: 'complaint' })
      if (r.contact_id) await db.from('crm_contacts').update({ marketing_opt_out: true }).eq('id', r.contact_id)
    } else if (type === 'email.opened') {
      await db.from('crm_email_events').insert({ recipient_id: r.id, campaign_id: r.campaign_id, type: 'open' })
    } else if (type === 'email.clicked') {
      await db.from('crm_email_events').insert({ recipient_id: r.id, campaign_id: r.campaign_id, type: 'click', url: (body?.data?.click?.link || '').slice(0, 500) })
    } else if (type === 'email.delivered') {
      await db.from('crm_email_events').insert({ recipient_id: r.id, campaign_id: r.campaign_id, type: 'delivered' })
    }
  } catch (e: any) { console.error('resend-webhook failed:', e?.message || e) }
  return res.status(200).json({ ok: true })
}
