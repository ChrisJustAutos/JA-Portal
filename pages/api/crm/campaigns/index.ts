// pages/api/crm/campaigns/index.ts
// GET  — list campaigns with open/click tallies
// POST — create a draft campaign (edit:crm)

import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../lib/authServer'
import { roleHasPermission } from '../../../../lib/permissions'

export const config = { maxDuration: 15 }

function sb() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase not configured')
  return createClient(url, key, { auth: { persistSession: false } })
}

export default withAuth('view:crm', async (req, res, user) => {
  const db = sb()

  if (req.method === 'GET') {
    const { data: camps, error } = await db.from('crm_campaigns')
      .select('id, name, subject, status, segment_id, audience_all, scheduled_at, total_recipients, sent_count, fail_count, sent_at, created_at, segment:crm_segments(id, name)')
      .is('deleted_at', null).order('created_at', { ascending: false }).limit(100)
    if (error) return res.status(500).json({ error: error.message })

    // Tally opens/clicks from recipients in one pass.
    const ids = (camps || []).map(c => c.id)
    const opens: Record<string, { opened: number; clicked: number }> = {}
    if (ids.length) {
      const { data: rs } = await db.from('crm_campaign_recipients')
        .select('campaign_id, opened_at, first_clicked_at').in('campaign_id', ids).limit(50000)
      for (const r of rs || []) {
        const o = (opens[r.campaign_id] ||= { opened: 0, clicked: 0 })
        if (r.opened_at) o.opened++
        if (r.first_clicked_at) o.clicked++
      }
    }
    const out = (camps || []).map(c => ({ ...c, opened: opens[c.id]?.opened || 0, clicked: opens[c.id]?.clicked || 0 }))
    return res.status(200).json({ campaigns: out })
  }

  if (req.method === 'POST') {
    if (!roleHasPermission(user.role, 'edit:crm')) return res.status(403).json({ error: 'Forbidden' })
    let body: any = {}
    try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
    catch { return res.status(400).json({ error: 'Bad JSON body' }) }
    const name = String(body.name || '').trim()
    if (!name) return res.status(400).json({ error: 'name required' })
    const { data, error } = await db.from('crm_campaigns').insert({
      name,
      subject: body.subject ? String(body.subject) : '',
      preheader: body.preheader ? String(body.preheader) : null,
      body: body.body ? String(body.body) : '',
      from_name: body.from_name ? String(body.from_name) : null,
      reply_to: body.reply_to ? String(body.reply_to) : null,
      segment_id: body.segment_id || null,
      audience_all: !!body.audience_all,
      created_by: user.id,
    }).select('id').single()
    if (error) return res.status(500).json({ error: error.message })
    return res.status(201).json({ ok: true, id: data.id })
  }

  res.setHeader('Allow', 'GET, POST')
  return res.status(405).json({ error: 'GET or POST only' })
})
