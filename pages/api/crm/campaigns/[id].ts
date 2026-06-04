// pages/api/crm/campaigns/[id].ts
// GET    — campaign + computed stats (sent/opened/clicked/unsub/bounced)
// PATCH  — edit a draft/scheduled campaign (edit:crm)
// DELETE — soft-delete (edit:crm)

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

const PATCHABLE = ['name', 'subject', 'preheader', 'body', 'from_name', 'reply_to', 'segment_id', 'audience_all']

async function countWhere(db: any, campaignId: string, col: string) {
  const { count } = await db.from('crm_campaign_recipients').select('id', { count: 'exact', head: true }).eq('campaign_id', campaignId).not(col, 'is', null)
  return count || 0
}

export default withAuth('view:crm', async (req, res, user) => {
  const db = sb()
  const id = String(req.query.id || '')
  if (!id) return res.status(400).json({ error: 'id required' })

  if (req.method === 'GET') {
    const { data: campaign, error } = await db.from('crm_campaigns').select('*, segment:crm_segments(id, name)').eq('id', id).is('deleted_at', null).single()
    if (error || !campaign) return res.status(404).json({ error: 'Not found' })
    const [opened, clicked, unsub, { count: total }, { count: bounced }] = await Promise.all([
      countWhere(db, id, 'opened_at'),
      countWhere(db, id, 'first_clicked_at'),
      countWhere(db, id, 'unsubscribed_at'),
      db.from('crm_campaign_recipients').select('id', { count: 'exact', head: true }).eq('campaign_id', id),
      db.from('crm_campaign_recipients').select('id', { count: 'exact', head: true }).eq('campaign_id', id).in('status', ['bounced', 'complained']),
    ])
    return res.status(200).json({ campaign, stats: { total: total || 0, opened, clicked, unsub, bounced: bounced || 0 } })
  }

  if (req.method === 'PATCH') {
    if (!roleHasPermission(user.role, 'edit:crm')) return res.status(403).json({ error: 'Forbidden' })
    let body: any = {}
    try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
    catch { return res.status(400).json({ error: 'Bad JSON body' }) }
    const { data: cur } = await db.from('crm_campaigns').select('status').eq('id', id).single()
    if (!cur) return res.status(404).json({ error: 'Not found' })
    if (!['draft', 'scheduled'].includes(cur.status)) return res.status(400).json({ error: `Cannot edit a campaign that is ${cur.status}` })
    const patch: any = {}
    for (const k of PATCHABLE) if (k in body) patch[k] = k === 'audience_all' ? !!body[k] : (body[k] === '' ? null : body[k])
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'No fields' })
    const { error } = await db.from('crm_campaigns').update(patch).eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  if (req.method === 'DELETE') {
    if (!roleHasPermission(user.role, 'edit:crm')) return res.status(403).json({ error: 'Forbidden' })
    const { error } = await db.from('crm_campaigns').update({ deleted_at: new Date().toISOString() }).eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  res.setHeader('Allow', 'GET, PATCH, DELETE')
  return res.status(405).json({ error: 'GET, PATCH or DELETE only' })
})
