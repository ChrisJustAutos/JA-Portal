// pages/api/crm/automations/[id].ts
// GET    — one automation (graph + legacy steps) for the canvas editor
// PATCH  — update fields, replace the graph (validated, bumps graph_version)
//          and/or replace the legacy step list (edit:crm)
// DELETE — soft-delete the automation (edit:crm). Active enrolments stop on
//          their next sweep (the engine cancels when the automation is gone).

import crypto from 'crypto'
import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../lib/authServer'
import { roleHasPermission } from '../../../../lib/permissions'
import { validateGraph, linearStepsToGraph } from '../../../../lib/crm-automation-graph'

export const config = { maxDuration: 10 }

function sb() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase not configured')
  return createClient(url, key, { auth: { persistSession: false } })
}

const ACTIONS = ['email', 'sms', 'task', 'notify_owner']
function stepRows(automationId: string, steps: any[]): any[] {
  return (Array.isArray(steps) ? steps : []).map((s, i) => ({
    automation_id: automationId,
    step_order: i + 1,
    delay_hours: Math.max(0, Math.round(Number(s.delay_hours) || 0)),
    action: ACTIONS.includes(s.action) ? s.action : 'email',
    subject: s.subject ? String(s.subject) : null,
    body: s.body ? String(s.body) : null,
    task_priority: s.task_priority || 'normal',
  }))
}

export default withAuth('view:crm', async (req, res, user) => {
  const db = sb()
  const id = String(req.query.id || '')
  if (!id) return res.status(400).json({ error: 'id required' })

  if (req.method === 'GET') {
    const { data: auto, error } = await db.from('crm_automations')
      .select('*, steps:crm_automation_steps(*)').eq('id', id).is('deleted_at', null).maybeSingle()
    if (error || !auto) return res.status(404).json({ error: 'Not found' })
    const steps = ((auto as any).steps || []).sort((x: any, y: any) => x.step_order - y.step_order)
    // Legacy automations render via the converter until first save.
    const graph = (auto as any).graph && Array.isArray((auto as any).graph.nodes)
      ? (auto as any).graph
      : (steps.length ? linearStepsToGraph(auto as any, steps) : null)
    const { data: enr } = await db.from('crm_automation_enrolments').select('status').eq('automation_id', id)
    const counts = { active: 0, done: 0, cancelled: 0 }
    for (const e of enr || []) {
      if (e.status === 'active') counts.active++; else if (e.status === 'done') counts.done++; else counts.cancelled++
    }
    return res.status(200).json({ automation: { ...auto, steps, graph }, counts })
  }

  if (req.method === 'PATCH') {
    if (!roleHasPermission(user.role, 'edit:crm')) return res.status(403).json({ error: 'Forbidden' })
    let body: any = {}
    try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
    catch { return res.status(400).json({ error: 'Bad JSON body' }) }

    const patch: any = {}
    if ('name' in body) patch.name = String(body.name).trim()
    if ('description' in body) patch.description = body.description ? String(body.description) : null
    if ('trigger_event' in body) patch.trigger_event = body.trigger_event === 'stage_changed' ? 'stage_changed' : 'lead_created'
    if ('trigger_stage' in body) patch.trigger_stage = body.trigger_stage || null
    if ('enabled' in body) patch.enabled = !!body.enabled
    if ('cancel_on_stages' in body && Array.isArray(body.cancel_on_stages)) patch.cancel_on_stages = body.cancel_on_stages

    // Graph replace (the canvas editor). Server-side validation is
    // authoritative; saving bumps graph_version and syncs the legacy
    // trigger columns from the trigger node so list summaries stay right.
    if ('graph' in body) {
      const v = validateGraph(body.graph)
      if (!v.ok) return res.status(400).json({ error: v.errors.join(' ') })
      const trigger = (body.graph.nodes as any[]).find(n => n.data?.kind === 'trigger')
      patch.graph = body.graph
      patch.trigger_event = trigger?.data?.event || 'lead_created'
      patch.trigger_stage = trigger?.data?.config?.stage || null
      patch.trigger_config = trigger?.data?.config || {}
      const { data: cur } = await db.from('crm_automations').select('graph_version, webhook_token, webhook_secret').eq('id', id).maybeSingle()
      patch.graph_version = (Number(cur?.graph_version) || 1) + 1
      // Webhook trigger gets its token + secret minted on first save.
      if (patch.trigger_event === 'webhook' && !cur?.webhook_token) {
        patch.webhook_token = crypto.randomBytes(24).toString('base64url')
        patch.webhook_secret = crypto.randomBytes(24).toString('base64url')
      }
    }
    if (body.regenerate_webhook === true) {
      patch.webhook_token = crypto.randomBytes(24).toString('base64url')
      patch.webhook_secret = crypto.randomBytes(24).toString('base64url')
    }

    if (Object.keys(patch).length) {
      const { error } = await db.from('crm_automations').update(patch).eq('id', id)
      if (error) return res.status(500).json({ error: error.message })
    }
    // Full replace of steps when provided.
    if ('steps' in body) {
      await db.from('crm_automation_steps').delete().eq('automation_id', id)
      const rows = stepRows(id, body.steps)
      if (rows.length) {
        const { error: sErr } = await db.from('crm_automation_steps').insert(rows)
        if (sErr) return res.status(500).json({ error: sErr.message })
      }
    }
    return res.status(200).json({ ok: true })
  }

  if (req.method === 'DELETE') {
    if (!roleHasPermission(user.role, 'edit:crm')) return res.status(403).json({ error: 'Forbidden' })
    const { error } = await db.from('crm_automations').update({ deleted_at: new Date().toISOString(), enabled: false }).eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  res.setHeader('Allow', 'GET, PATCH, DELETE')
  return res.status(405).json({ error: 'GET, PATCH or DELETE only' })
})
