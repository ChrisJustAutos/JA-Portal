// pages/api/crm/campaigns/[id]/test.ts
// POST { email } — send a one-off test of the campaign to an address, rendered
// with sample personalisation. (edit:crm)

import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../../lib/authServer'
import { roleHasPermission } from '../../../../../lib/permissions'
import { renderCampaignHtml, personalize } from '../../../../../lib/crm-campaigns'
import { sendMail } from '../../../../../lib/email'

export const config = { maxDuration: 30 }

function sb() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase not configured')
  return createClient(url, key, { auth: { persistSession: false } })
}

export default withAuth('view:crm', async (req, res, user) => {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }) }
  if (!roleHasPermission(user.role, 'edit:crm')) return res.status(403).json({ error: 'Forbidden' })
  const db = sb()
  const id = String(req.query.id || '')
  let body: any = {}
  try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
  catch { return res.status(400).json({ error: 'Bad JSON body' }) }
  const email = String(body.email || user.email || '').trim()
  if (!email) return res.status(400).json({ error: 'email required' })

  const { data: campaign } = await db.from('crm_campaigns').select('*').eq('id', id).is('deleted_at', null).single()
  if (!campaign) return res.status(404).json({ error: 'Not found' })

  const sample = { id: 'test', name: user.displayName || 'Sample Customer', first_name: (user.displayName || 'there').split(' ')[0], last_name: null, email, company_name: 'Sample Co' }
  const from = campaign.from_name ? `${campaign.from_name} <${(process.env.RESEND_CAMPAIGN_FROM || process.env.RESEND_FROM || 'noreply@mail.justautos.app').replace(/^.*<|>.*$/g, '')}>` : (process.env.RESEND_CAMPAIGN_FROM || process.env.RESEND_FROM || 'noreply@mail.justautos.app')
  try {
    await sendMail(from, {
      to: [email],
      subject: `[TEST] ${personalize(campaign.subject || '(no subject)', sample as any)}`,
      html: renderCampaignHtml(campaign, sample as any, 'test'),
      replyTo: campaign.reply_to || undefined,
    })
    return res.status(200).json({ ok: true })
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || 'send failed' })
  }
})
