// pages/api/crm/contacts/[id]/to-workshop.ts
// POST — hand a CRM contact off to the portal-native Workshop module: ensure a
// workshop_customers row exists (match by email/phone, else create), link it to
// the contact, and open a draft workshop quote. If lead_id is supplied the lead
// is linked to the new quote and moved to 'quoted'. (edit:crm + edit:bookings)
//
// Returns { customerId, quoteId } so the CRM can route to /workshop/quotes.

import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../../lib/authServer'
import { roleHasPermission } from '../../../../../lib/permissions'
import { logActivity, phoneKey } from '../../../../../lib/crm'

export const config = { maxDuration: 10 }

function sb() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase not configured')
  return createClient(url, key, { auth: { persistSession: false } })
}

export default withAuth('view:crm', async (req, res, user) => {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }) }
  if (!roleHasPermission(user.role, 'edit:crm') || !roleHasPermission(user.role, 'edit:bookings')) {
    return res.status(403).json({ error: 'Forbidden — needs CRM and Workshop edit access' })
  }
  const db = sb()
  const id = String(req.query.id || '')
  if (!id) return res.status(400).json({ error: 'id required' })

  let body: any = {}
  try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
  catch { return res.status(400).json({ error: 'Bad JSON body' }) }

  const { data: contact, error: cErr } = await db.from('crm_contacts')
    .select('*').eq('id', id).is('deleted_at', null).single()
  if (cErr || !contact) return res.status(404).json({ error: 'Contact not found' })

  // 1. Resolve the workshop customer.
  let workshopCustomerId: string | null = contact.workshop_customer_id || null

  if (!workshopCustomerId) {
    // Try to match an existing workshop customer by email then phone/mobile.
    const e = (contact.email || '').trim().toLowerCase()
    if (e) {
      const { data } = await db.from('workshop_customers').select('id').ilike('email', e).limit(1)
      if (data && data.length) workshopCustomerId = data[0].id
    }
    if (!workshopCustomerId) {
      for (const k of [phoneKey(contact.mobile), phoneKey(contact.phone)].filter(Boolean) as string[]) {
        const { data } = await db.from('workshop_customers').select('id').or(`phone.ilike.%${k},mobile.ilike.%${k}`).limit(1)
        if (data && data.length) { workshopCustomerId = data[0].id; break }
      }
    }
  }

  if (!workshopCustomerId) {
    // Create a fresh workshop customer from the contact.
    const { data, error } = await db.from('workshop_customers').insert({
      name: contact.name,
      first_name: contact.first_name || null,
      last_name: contact.last_name || null,
      email: contact.email || null,
      phone: contact.phone || null,
      mobile: contact.mobile || null,
      company: contact.company_name || null,
    }).select('id').single()
    if (error) return res.status(500).json({ error: `Could not create workshop customer: ${error.message}` })
    workshopCustomerId = data.id
  }

  // Link back to the contact (idempotent).
  if (contact.workshop_customer_id !== workshopCustomerId) {
    await db.from('crm_contacts').update({ workshop_customer_id: workshopCustomerId }).eq('id', id)
  }

  // 2. Create the draft workshop quote.
  const noteParts = [body.notes && String(body.notes)].filter(Boolean)
  const { data: quote, error: qErr } = await db.from('workshop_quotes').insert({
    customer_id: workshopCustomerId,
    vehicle_id: body.vehicle_id || null,
    notes: noteParts.length ? noteParts.join('\n') : null,
    created_by: user.id,
  }).select('id').single()
  if (qErr) return res.status(500).json({ error: `Could not create workshop quote: ${qErr.message}` })

  // 3. Link the lead (if any) and advance it to 'quoted'.
  const leadId = body.lead_id ? String(body.lead_id) : null
  if (leadId) {
    await db.from('crm_leads').update({ workshop_quote_id: quote.id, stage: 'quoted' }).eq('id', leadId)
  }

  await logActivity(db, {
    contact_id: id,
    lead_id: leadId,
    type: 'workshop_handoff',
    body: `Started a workshop quote for ${contact.name}`,
    meta: { workshop_customer_id: workshopCustomerId, workshop_quote_id: quote.id },
    actor_id: user.id,
  })

  return res.status(201).json({ ok: true, customerId: workshopCustomerId, quoteId: quote.id })
})
