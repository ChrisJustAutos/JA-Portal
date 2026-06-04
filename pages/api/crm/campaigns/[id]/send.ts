// pages/api/crm/campaigns/[id]/send.ts
// POST { scheduled_at? } — send now (materialise recipients + status 'sending',
// the cron drains it) or schedule for later (status 'scheduled'). (edit:crm)

import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../../lib/authServer'
import { roleHasPermission } from '../../../../../lib/permissions'
import { materializeRecipients } from '../../../../../lib/crm-campaigns'

export const config = { maxDuration: 60 }

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

  const { data: campaign } = await db.from('crm_campaigns').select('*').eq('id', id).is('deleted_at', null).single()
  if (!campaign) return res.status(404).json({ error: 'Not found' })
  if (!['draft', 'scheduled'].includes(campaign.status)) return res.status(400).json({ error: `Already ${campaign.status}` })
  if (!campaign.subject?.trim() || !campaign.body?.trim()) return res.status(400).json({ error: 'Add a subject and body first' })
  if (!campaign.segment_id && !campaign.audience_all) return res.status(400).json({ error: 'Choose an audience (a segment or all contacts)' })

  // Schedule for later?
  const when = body.scheduled_at ? new Date(body.scheduled_at) : null
  if (when && when.getTime() > Date.now() + 30_000) {
    await db.from('crm_campaigns').update({ status: 'scheduled', scheduled_at: when.toISOString() }).eq('id', id)
    return res.status(200).json({ ok: true, scheduled: true, scheduled_at: when.toISOString() })
  }

  // Send now.
  const count = await materializeRecipients(db, campaign)
  if (count === 0) return res.status(400).json({ error: 'No mailable contacts match this audience' })
  await db.from('crm_campaigns').update({ status: 'sending', scheduled_at: null }).eq('id', id)
  return res.status(200).json({ ok: true, sending: true, recipients: count })
})
