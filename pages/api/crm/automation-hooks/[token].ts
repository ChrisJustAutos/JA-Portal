// pages/api/crm/automation-hooks/[token].ts
// PUBLIC inbound webhook trigger for one automation (the Zapier/Make
// replacement entry point). POST JSON here to enrol a contact into the flow:
//
//   POST /api/crm/automation-hooks/<webhook_token>
//   X-Hook-Secret: <webhook_secret>            (required if one is set)
//   { "email": "...", "mobile": "...", "name": "...", ...anything }
//
// The contact is matched by email/phone (created if missing); the full body
// is stored as the enrolment's context (usable later by webhook_out actions).
// Security: unguessable 32-byte token in the path + constant-time secret
// compare + 64KB body cap. Never echoes PII back.

import crypto from 'crypto'
import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { findContact, contactDisplayName, logActivity } from '../../../../lib/crm'
import { enrolFromEvent } from '../../../../lib/crm-automation-triggers'

export const config = { maxDuration: 10, api: { bodyParser: { sizeLimit: '64kb' } } }

function timingSafeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a), bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return crypto.timingSafeEqual(ab, bb)
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }) }
  const token = String(req.query.token || '')
  if (!/^[A-Za-z0-9_-]{20,80}$/.test(token)) return res.status(404).json({ error: 'not_found' })

  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  const { data: auto } = await db.from('crm_automations')
    .select('id, enabled, deleted_at, webhook_secret, trigger_event')
    .eq('webhook_token', token).maybeSingle()
  if (!auto || auto.deleted_at || auto.trigger_event !== 'webhook') return res.status(404).json({ error: 'not_found' })
  if (!auto.enabled) return res.status(409).json({ error: 'automation_disabled' })
  if (auto.webhook_secret) {
    const given = String(req.headers['x-hook-secret'] || '')
    if (!given || !timingSafeEq(given, auto.webhook_secret)) return res.status(401).json({ error: 'bad_secret' })
  }

  let body: any = {}
  try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
  catch { return res.status(400).json({ error: 'Bad JSON body' }) }

  // Match or create the contact from whatever identity fields came in.
  const email = body.email ? String(body.email).trim() : null
  const mobile = body.mobile ? String(body.mobile).trim() : (body.phone ? String(body.phone).trim() : null)
  let contactId = await findContact(db, { email, phone: body.phone, mobile })
  if (!contactId && (email || mobile || body.name)) {
    const { data: created } = await db.from('crm_contacts').insert({
      name: contactDisplayName({ name: body.name, email, mobile }),
      email, mobile, phone: body.phone ? String(body.phone).trim() : null,
      source: 'webhook',
    }).select('id').single()
    contactId = created?.id || null
    if (contactId) await logActivity(db, { contact_id: contactId, type: 'contact_created', body: 'Contact created by an automation webhook' })
  }
  if (!contactId) return res.status(400).json({ error: 'No contact identity — include email, mobile or name' })

  const enrolled = await enrolFromEvent(db, 'webhook', {
    contact_id: contactId,
    context: body,
    dedupe_key: body.dedupe_key ? String(body.dedupe_key).slice(0, 120) : `wh:${contactId}:${Date.now()}`,
  })
  return res.status(200).json({ ok: true, enrolled })
}
