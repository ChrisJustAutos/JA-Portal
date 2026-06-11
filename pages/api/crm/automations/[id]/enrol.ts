// pages/api/crm/automations/[id]/enrol.ts
// POST { lead_id } — manually enrol a lead into this automation (edit:crm).
// The test harness for any flow, and the "Run automation" button on a lead.
// Ignores the trigger filter (manual is explicit) but respects the one-active-
// enrolment-per-lead guard.

import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../../lib/authServer'
import { roleHasPermission } from '../../../../../lib/permissions'
import { enrolLead } from '../../../../../lib/crm-automations'

export const config = { maxDuration: 10 }

export default withAuth('view:crm', async (req, res, user) => {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }) }
  if (!roleHasPermission(user.role, 'edit:crm')) return res.status(403).json({ error: 'Forbidden' })
  const automationId = String(req.query.id || '')
  let body: any = {}
  try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
  catch { return res.status(400).json({ error: 'Bad JSON body' }) }
  const leadId = String(body.lead_id || '').trim()
  if (!automationId || !leadId) return res.status(400).json({ error: 'automation id + lead_id required' })

  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  const { data: lead } = await db.from('crm_leads').select('id, stage, contact_id').eq('id', leadId).is('deleted_at', null).maybeSingle()
  if (!lead) return res.status(404).json({ error: 'Lead not found' })

  await enrolLead(lead as any, 'manual', db, automationId)
  const { data: enr } = await db.from('crm_automation_enrolments')
    .select('id, status, next_run_at').eq('automation_id', automationId).eq('lead_id', leadId)
    .order('created_at', { ascending: false }).limit(1)
  return res.status(200).json({ ok: true, enrolment: enr?.[0] || null })
})
