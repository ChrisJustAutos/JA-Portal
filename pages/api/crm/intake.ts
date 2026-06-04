// pages/api/crm/intake.ts
// PUBLIC endpoint — the website's quote/contact form posts leads here.
// Guarded by a shared token (env CRM_INTAKE_TOKEN) sent as the `x-crm-token`
// header or a `token` body field, plus a honeypot field for bots. CORS is
// opened to the origin(s) in CRM_INTAKE_ORIGINS (comma-separated, default '*').
//
// On success: de-dupes/creates a contact, opens a 'new' lead (source=website),
// logs the timeline entry and notifies sales/managers/admins. Always returns a
// generic ok so the form can't be used to probe which contacts exist.

import { createClient } from '@supabase/supabase-js'
import type { NextApiRequest, NextApiResponse } from 'next'
import { contactDisplayName, findContact, logActivity } from '../../../lib/crm'
import { enrolLead } from '../../../lib/crm-automations'
import { notify } from '../../../lib/notifications'

export const config = { maxDuration: 10 }

function sb() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase not configured')
  return createClient(url, key, { auth: { persistSession: false } })
}

function applyCors(req: NextApiRequest, res: NextApiResponse) {
  const allowed = (process.env.CRM_INTAKE_ORIGINS || '*').split(',').map(s => s.trim()).filter(Boolean)
  const origin = String(req.headers.origin || '')
  if (allowed.includes('*')) res.setHeader('Access-Control-Allow-Origin', '*')
  else if (origin && allowed.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-crm-token')
  res.setHeader('Vary', 'Origin')
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  applyCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST, OPTIONS'); return res.status(405).json({ error: 'POST only' }) }

  let body: any = {}
  try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
  catch { return res.status(400).json({ error: 'Bad JSON body' }) }

  // Auth: shared token. Accepted via the x-crm-token header, a `token` body
  // field, or HTTP Basic auth (username OR password = the token) — the last
  // lets WordPress/Formidable's "Basic Auth" box carry it server-side.
  const expected = process.env.CRM_INTAKE_TOKEN
  let provided = String(req.headers['x-crm-token'] || body.token || '')
  const authz = String(req.headers.authorization || '')
  if (!provided && authz.toLowerCase().startsWith('basic ')) {
    try {
      const [u, p] = Buffer.from(authz.slice(6).trim(), 'base64').toString('utf8').split(':')
      provided = (p && expected && p === expected) ? p : (u || '')
    } catch { /* ignore malformed header */ }
  }
  if (!expected || provided !== expected) return res.status(401).json({ error: 'Unauthorized' })

  // Honeypot — bots fill hidden fields; humans leave them blank.
  if (body.company_website || body._gotcha) return res.status(200).json({ ok: true })

  const name = String(body.name || body.contact_name || '').trim()
  const email = body.email ? String(body.email).trim() : null
  const phone = body.phone ? String(body.phone).trim() : null
  const mobile = body.mobile ? String(body.mobile).trim() : null
  const message = body.message ? String(body.message).trim() : (body.details ? String(body.details).trim() : null)
  if (!name && !email && !phone && !mobile) return res.status(400).json({ error: 'Provide at least a name, email or phone' })

  try {
    const db = sb()
    // De-dupe / create the contact.
    let contactId = await findContact(db, { email, phone, mobile })
    if (!contactId) {
      const { data: c, error } = await db.from('crm_contacts').insert({
        name: contactDisplayName({ name, email, phone, mobile }),
        email, phone, mobile,
        postcode: body.postcode ? String(body.postcode).trim() : null,
        company_name: body.company ? String(body.company).trim() : null,
        source: 'website',
      }).select('id, name').single()
      if (error) throw error
      contactId = c.id
      await logActivity(db, { contact_id: contactId, type: 'contact_created', body: 'Contact created from website lead' })
    }

    // Open the lead.
    const title = body.subject ? String(body.subject).slice(0, 200) : `Website enquiry${name ? ` — ${name}` : ''}`
    const { data: lead, error: lErr } = await db.from('crm_leads').insert({
      contact_id: contactId,
      title,
      stage: 'new',
      source: 'website',
      value: body.value != null && body.value !== '' ? Number(body.value) : null,
      vehicle: body.vehicle ? String(body.vehicle) : null,
      details: message,
    }).select('id, title').single()
    if (lErr) throw lErr

    await logActivity(db, { lead_id: lead.id, contact_id: contactId, type: 'website_lead', body: message || 'New website enquiry', meta: { page: body.page || null } })
    await enrolLead({ id: lead.id, stage: 'new', contact_id: contactId }, 'lead_created', db)

    await notify({
      module: 'crm',
      title: 'New website lead',
      body: `${name || email || phone || 'Someone'}${message ? ` — ${message.slice(0, 120)}` : ''}`,
      href: '/crm',
      roles: ['admin', 'manager', 'sales'],
      dedupeKey: `crm-weblead:${lead.id}`,
    })

    return res.status(201).json({ ok: true })
  } catch (e: any) {
    console.error('crm intake failed:', e?.message || e)
    return res.status(500).json({ error: 'Could not record lead' })
  }
}
