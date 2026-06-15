// pages/api/tasks/automations/[id].ts
// GET    — one automation (graph) + enrolment counts for the canvas editor
// PATCH  — update name/enabled, replace the graph (validated, bumps version,
//          mints webhook token/secret on first webhook save) (edit:tasks)
// DELETE — soft-delete; active enrolments stop on the next sweep (edit:tasks)
import crypto from 'crypto'
import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../lib/authServer'
import { roleHasPermission } from '../../../../lib/permissions'
import { validateGraph } from '../../../../lib/task-automation-graph'

export const config = { maxDuration: 10 }

function sb() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase not configured')
  return createClient(url, key, { auth: { persistSession: false } })
}

export default withAuth('view:tasks', async (req, res, user) => {
  const db = sb()
  const id = String(req.query.id || '')
  if (!id) return res.status(400).json({ error: 'id required' })

  if (req.method === 'GET') {
    const { data: auto, error } = await db.from('task_automations').select('*').eq('id', id).is('deleted_at', null).maybeSingle()
    if (error || !auto) return res.status(404).json({ error: 'Not found' })
    const { data: enr } = await db.from('task_automation_enrolments').select('status').eq('automation_id', id)
    const counts = { active: 0, done: 0, cancelled: 0 }
    for (const e of enr || []) { if (e.status === 'active') counts.active++; else if (e.status === 'done') counts.done++; else counts.cancelled++ }
    return res.status(200).json({ automation: auto, counts })
  }

  if (req.method === 'PATCH') {
    if (!roleHasPermission(user.role, 'edit:tasks')) return res.status(403).json({ error: 'Forbidden' })
    let body: any = {}
    try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
    catch { return res.status(400).json({ error: 'Bad JSON body' }) }

    const patch: any = { updated_at: new Date().toISOString() }
    if ('name' in body) patch.name = String(body.name).trim()
    if ('description' in body) patch.description = body.description ? String(body.description) : null
    if ('enabled' in body) patch.enabled = !!body.enabled

    if ('graph' in body) {
      const v = validateGraph(body.graph)
      if (!v.ok) return res.status(400).json({ error: v.errors.join(' ') })
      const trigger = (body.graph.nodes as any[]).find(n => n.data?.kind === 'trigger')
      patch.graph = body.graph
      patch.trigger_event = trigger?.data?.event || 'task_created'
      patch.trigger_config = trigger?.data?.config || {}
      const { data: cur } = await db.from('task_automations').select('graph_version, webhook_token').eq('id', id).maybeSingle()
      patch.graph_version = (Number(cur?.graph_version) || 1) + 1
      if (patch.trigger_event === 'webhook' && !cur?.webhook_token) {
        patch.webhook_token = crypto.randomBytes(24).toString('base64url')
        patch.webhook_secret = crypto.randomBytes(24).toString('base64url')
      }
    }
    if (body.regenerate_webhook === true) {
      patch.webhook_token = crypto.randomBytes(24).toString('base64url')
      patch.webhook_secret = crypto.randomBytes(24).toString('base64url')
    }

    const { error } = await db.from('task_automations').update(patch).eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  if (req.method === 'DELETE') {
    if (!roleHasPermission(user.role, 'edit:tasks')) return res.status(403).json({ error: 'Forbidden' })
    const { error } = await db.from('task_automations').update({ deleted_at: new Date().toISOString(), enabled: false }).eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  res.setHeader('Allow', 'GET, PATCH, DELETE')
  return res.status(405).json({ error: 'GET, PATCH or DELETE only' })
})
