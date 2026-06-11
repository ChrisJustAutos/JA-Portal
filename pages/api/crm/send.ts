// pages/api/crm/send.ts
// POST { contact_id, lead_id?, channel: 'sms'|'email', subject?, body }
// Quick one-off compose from the CRM (contact/lead drawers). Respects
// do_not_contact, supports {{placeholders}}, logs the crm_activities
// timeline entry. Deliberately NOT the workshop SMS route — different
// permission gate and different timeline. Gated edit:crm.

import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../lib/authServer'
import { roleHasPermission } from '../../../lib/permissions'
import { logActivity } from '../../../lib/crm'
import { renderTemplate, buildVars, textToHtml } from '../../../lib/crm-automations'
import { sendMail } from '../../../lib/email'
import { sendSms } from '../../../lib/clicksend'

export const config = { maxDuration: 15 }

export default withAuth('view:crm', async (req, res, user) => {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }) }
  if (!roleHasPermission(user.role, 'edit:crm')) return res.status(403).json({ error: 'Forbidden' })
  let body: any = {}
  try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
  catch { return res.status(400).json({ error: 'Bad JSON body' }) }

  const contactId = String(body.contact_id || '').trim()
  const leadId = body.lead_id ? String(body.lead_id) : null
  const channel = body.channel === 'sms' ? 'sms' : 'email'
  const text = String(body.body || '').trim()
  if (!contactId) return res.status(400).json({ error: 'contact_id required' })
  if (!text) return res.status(400).json({ error: 'Message body required' })

  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  const { data: contact } = await db.from('crm_contacts').select('*').eq('id', contactId).is('deleted_at', null).maybeSingle()
  if (!contact) return res.status(404).json({ error: 'Contact not found' })
  if (contact.do_not_contact) return res.status(409).json({ error: 'Contact is marked do-not-contact' })

  let lead: any = null
  if (leadId) {
    const { data } = await db.from('crm_leads').select('*, owner:user_profiles!crm_leads_owner_id_fkey(display_name)').eq('id', leadId).maybeSingle()
    lead = data
  }
  const vars = buildVars(lead, contact)

  if (channel === 'sms') {
    const to = contact.mobile || contact.phone
    if (!to) return res.status(400).json({ error: 'No mobile/phone on the contact' })
    const rendered = renderTemplate(text, vars)
    const r = await sendSms(to, rendered)
    if (!r.ok) return res.status(502).json({ error: r.error || 'SMS failed' })
    await logActivity(db, { contact_id: contactId, lead_id: leadId, type: 'sms', body: `SMS: ${rendered.slice(0, 200)}`, actor_id: user.id })
    return res.status(200).json({ ok: true, to })
  }

  const to = contact.email
  if (!to) return res.status(400).json({ error: 'No email on the contact' })
  const subject = renderTemplate(String(body.subject || ''), vars) || 'A message from Just Autos'
  try {
    await sendMail(process.env.RESEND_FROM || 'noreply@mail.justautos.app', { to: [to], subject, html: textToHtml(renderTemplate(text, vars)) })
  } catch (e: any) { return res.status(502).json({ error: e?.message || 'Email failed' }) }
  await logActivity(db, { contact_id: contactId, lead_id: leadId, type: 'email', body: `Email: ${subject}`, actor_id: user.id })
  return res.status(200).json({ ok: true, to })
})
