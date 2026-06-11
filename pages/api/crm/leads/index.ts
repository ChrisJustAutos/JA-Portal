// pages/api/crm/leads/index.ts
// GET  ?owner=&stage=&q=  — list pipeline leads (with contact + owner)
// POST                    — create a lead, optionally creating/linking a contact

import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../lib/authServer'
import { roleHasPermission } from '../../../../lib/permissions'
import { getPipelineStages, findContact, contactDisplayName, logActivity } from '../../../../lib/crm'
import { enrolLead } from '../../../../lib/crm-automations'

export const config = { maxDuration: 10 }

function sb() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase not configured')
  return createClient(url, key, { auth: { persistSession: false } })
}

export default withAuth('view:crm', async (req, res, user) => {
  const db = sb()

  if (req.method === 'GET') {
    const owner = String(req.query.owner || '').trim()
    const stage = String(req.query.stage || '').trim()
    const q = String(req.query.q || '').trim().replace(/[%,()*]/g, ' ').trim()
    let query = db.from('crm_leads')
      .select('id, title, stage, value, source, vehicle, owner_id, contact_id, contact_attempts, next_follow_up_at, last_activity_at, created_at, won_at, lost_at, workshop_quote_id, contact:crm_contacts(id, name, email, phone, mobile, company_name), owner:user_profiles!crm_leads_owner_id_fkey(id, display_name)')
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(600)
    if (owner === 'me') query = query.eq('owner_id', user.id)
    else if (owner && owner !== 'all') query = query.eq('owner_id', owner)
    if (stage) query = query.eq('stage', stage)
    if (q) query = query.ilike('title', `%${q}%`)
    const { data, error } = await query
    if (error) return res.status(500).json({ error: error.message })
    // Surface the linked workshop quote (status chip + total on lead cards).
    const leads = data || []
    const quoteIds = leads.map((l: any) => l.workshop_quote_id).filter(Boolean)
    if (quoteIds.length) {
      const { data: quotes } = await db.from('workshop_quotes').select('id, status, total').in('id', quoteIds)
      const byId: Record<string, any> = {}
      for (const qt of quotes || []) byId[qt.id] = qt
      for (const l of leads as any[]) if (l.workshop_quote_id) l.quote = byId[l.workshop_quote_id] || null
    }
    return res.status(200).json({ leads })
  }

  if (req.method === 'POST') {
    if (!roleHasPermission(user.role, 'edit:crm')) return res.status(403).json({ error: 'Forbidden' })
    let body: any = {}
    try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
    catch { return res.status(400).json({ error: 'Bad JSON body' }) }

    // Resolve / create the contact.
    let contactId: string | null = body.contact_id || null
    if (!contactId && (body.contact_name || body.email || body.phone || body.mobile)) {
      contactId = await findContact(db, { email: body.email, phone: body.phone, mobile: body.mobile })
      if (!contactId) {
        const name = contactDisplayName({ name: body.contact_name, email: body.email, phone: body.phone, mobile: body.mobile })
        const { data: c, error: cErr } = await db.from('crm_contacts').insert({
          name,
          email: body.email ? String(body.email).trim() : null,
          phone: body.phone ? String(body.phone).trim() : null,
          mobile: body.mobile ? String(body.mobile).trim() : null,
          company_name: body.company_name ? String(body.company_name).trim() : null,
          source: body.source ? String(body.source) : 'manual',
          owner_id: body.owner_id || user.id,
        }).select('id').single()
        if (cErr) return res.status(500).json({ error: cErr.message })
        contactId = c.id
        await logActivity(db, { contact_id: contactId, type: 'contact_created', body: `Contact created with lead by ${user.displayName || user.email}`, actor_id: user.id })
      }
    }

    const stages = await getPipelineStages(db)
    const firstOpen = stages.find(s => !s.is_won && !s.is_lost && !s.archived_at)?.key || 'new'
    const stage: string = stages.some(s => s.key === body.stage && !s.archived_at) ? body.stage : firstOpen
    const { data, error } = await db.from('crm_leads').insert({
      contact_id: contactId,
      title: body.title ? String(body.title).slice(0, 200) : 'New lead',
      stage,
      value: body.value != null && body.value !== '' ? Number(body.value) : null,
      owner_id: body.owner_id || user.id,
      source: body.source ? String(body.source) : 'manual',
      vehicle: body.vehicle ? String(body.vehicle) : null,
      details: body.details ? String(body.details) : null,
      next_follow_up_at: body.next_follow_up_at || null,
      created_by: user.id,
    }).select('*').single()
    if (error) return res.status(500).json({ error: error.message })
    await logActivity(db, { lead_id: data.id, contact_id: contactId, type: 'lead_created', body: `Lead "${data.title}" created by ${user.displayName || user.email}`, actor_id: user.id })
    await enrolLead({ id: data.id, stage: data.stage, contact_id: data.contact_id }, 'lead_created', db)
    return res.status(201).json({ ok: true, lead: data })
  }

  res.setHeader('Allow', 'GET, POST')
  return res.status(405).json({ error: 'GET or POST only' })
})
