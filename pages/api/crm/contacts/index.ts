// pages/api/crm/contacts/index.ts
// GET  ?q=&owner=&limit=&offset=  — search/list contacts
// POST                            — create a contact (edit:crm)

import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../lib/authServer'
import { roleHasPermission } from '../../../../lib/permissions'
import { contactDisplayName, findContact, logActivity } from '../../../../lib/crm'

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
    const q = String(req.query.q || '').trim().replace(/[%,()*]/g, ' ').trim()
    const owner = String(req.query.owner || '').trim()
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50))
    const offset = Math.max(0, Number(req.query.offset) || 0)
    let query = db.from('crm_contacts')
      .select('id, name, email, phone, mobile, company_name, source, owner_id, tags, last_activity_at, created_at, owner:user_profiles!crm_contacts_owner_id_fkey(id, display_name)', { count: 'exact' })
      .is('deleted_at', null)
      .order('last_activity_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)
    if (q) query = query.or(`name.ilike.%${q}%,email.ilike.%${q}%,phone.ilike.%${q}%,mobile.ilike.%${q}%,company_name.ilike.%${q}%`)
    if (owner === 'me') query = query.eq('owner_id', user.id)
    else if (owner) query = query.eq('owner_id', owner)
    const { data, count, error } = await query
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ contacts: data || [], total: count || 0 })
  }

  if (req.method === 'POST') {
    if (!roleHasPermission(user.role, 'edit:crm')) return res.status(403).json({ error: 'Forbidden' })
    let body: any = {}
    try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
    catch { return res.status(400).json({ error: 'Bad JSON body' }) }

    const first = body.first_name ? String(body.first_name).trim() : null
    const last = body.last_name ? String(body.last_name).trim() : null
    const name = contactDisplayName({ name: body.name, first_name: first, last_name: last, email: body.email, phone: body.phone, mobile: body.mobile })
    if (name === 'Unknown contact' && !body.name) return res.status(400).json({ error: 'A name, email or phone is required' })

    // Soft de-dupe: if an existing contact matches by email/phone, return it
    // instead of creating a twin (unless caller passes force:true).
    if (!body.force) {
      const existing = await findContact(db, { email: body.email, phone: body.phone, mobile: body.mobile })
      if (existing) {
        const { data } = await db.from('crm_contacts').select('*').eq('id', existing).single()
        return res.status(200).json({ ok: true, contact: data, deduped: true })
      }
    }

    const { data, error } = await db.from('crm_contacts').insert({
      name,
      first_name: first,
      last_name: last,
      email: body.email ? String(body.email).trim() : null,
      phone: body.phone ? String(body.phone).trim() : null,
      mobile: body.mobile ? String(body.mobile).trim() : null,
      company_name: body.company_name ? String(body.company_name).trim() : null,
      postcode: body.postcode ? String(body.postcode).trim() : null,
      source: body.source ? String(body.source) : 'manual',
      owner_id: body.owner_id || user.id,
      notes: body.notes ? String(body.notes) : null,
    }).select('*').single()
    if (error) return res.status(500).json({ error: error.message })
    await logActivity(db, { contact_id: data.id, type: 'contact_created', body: `Contact created by ${user.displayName || user.email}`, actor_id: user.id })
    return res.status(201).json({ ok: true, contact: data })
  }

  res.setHeader('Allow', 'GET, POST')
  return res.status(405).json({ error: 'GET or POST only' })
})
