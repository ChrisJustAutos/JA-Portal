// pages/api/crm/import-contacts.ts
// POST { rows: [{ name?, first_name?, last_name?, email?, phone?, mobile?,
//                 company_name?, tags?: string[] | "a, b" }] }
// Bulk contact import (the ActiveCampaign cutover tool — the contacts page
// parses the AC CSV export client-side and posts rows here). Dedupe via the
// same email/phone matching the rest of the CRM uses: existing contacts get
// new tags merged + blank fields filled, new ones are created with
// source='import'. Gated edit:crm. Max 5000 rows per call.

import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../lib/authServer'
import { roleHasPermission } from '../../../lib/permissions'
import { findContact, contactDisplayName, logActivity } from '../../../lib/crm'

export const config = { maxDuration: 300, api: { bodyParser: { sizeLimit: '4mb' } } }

function asTags(v: any): string[] {
  if (Array.isArray(v)) return v.map(t => String(t).trim()).filter(Boolean)
  if (typeof v === 'string') return v.split(/[,;|]/).map(t => t.trim()).filter(Boolean)
  return []
}

export default withAuth('view:crm', async (req, res, user) => {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }) }
  if (!roleHasPermission(user.role, 'edit:crm')) return res.status(403).json({ error: 'Forbidden' })
  let body: any = {}
  try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
  catch { return res.status(400).json({ error: 'Bad JSON body' }) }
  const rows: any[] = Array.isArray(body.rows) ? body.rows.slice(0, 5000) : []
  if (!rows.length) return res.status(400).json({ error: 'rows required' })

  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  let created = 0, merged = 0, skipped = 0

  for (const r of rows) {
    const email = r.email ? String(r.email).trim() : null
    const phone = r.phone ? String(r.phone).trim() : null
    const mobile = r.mobile ? String(r.mobile).trim() : null
    const first = r.first_name ? String(r.first_name).trim() : null
    const last = r.last_name ? String(r.last_name).trim() : null
    const name = (r.name && String(r.name).trim()) || [first, last].filter(Boolean).join(' ').trim() || null
    const tags = asTags(r.tags)
    if (!email && !phone && !mobile && !name) { skipped++; continue }

    const existingId = await findContact(db, { email, phone, mobile })
    if (existingId) {
      // Merge: add new tags, fill blanks only — never overwrite real data.
      const { data: cur } = await db.from('crm_contacts').select('tags, email, phone, mobile, first_name, last_name, company_name').eq('id', existingId).maybeSingle()
      if (cur) {
        const have = new Set(((cur.tags as string[]) || []).map(t => t.toLowerCase()))
        const newTags = tags.filter(t => !have.has(t.toLowerCase()))
        const patch: any = {}
        if (newTags.length) patch.tags = [...((cur.tags as string[]) || []), ...newTags]
        if (!cur.email && email) patch.email = email
        if (!cur.phone && phone) patch.phone = phone
        if (!cur.mobile && mobile) patch.mobile = mobile
        if (!cur.first_name && first) patch.first_name = first
        if (!cur.last_name && last) patch.last_name = last
        if (!cur.company_name && r.company_name) patch.company_name = String(r.company_name).trim()
        if (Object.keys(patch).length) { await db.from('crm_contacts').update(patch).eq('id', existingId); merged++ }
        else skipped++
      } else skipped++
      continue
    }

    const { error } = await db.from('crm_contacts').insert({
      name: name || contactDisplayName({ email, phone, mobile }),
      first_name: first, last_name: last,
      email, phone, mobile,
      company_name: r.company_name ? String(r.company_name).trim() : null,
      tags, source: 'import',
    })
    if (!error) created++
    else skipped++
  }

  await logActivity(db, { type: 'note', body: `Contact import by ${user.displayName || user.email}: ${created} created, ${merged} merged, ${skipped} skipped` } as any)
  return res.status(200).json({ ok: true, created, merged, skipped })
})
