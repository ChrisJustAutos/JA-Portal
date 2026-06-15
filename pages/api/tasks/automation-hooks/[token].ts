// pages/api/tasks/automation-hooks/[token].ts
// PUBLIC inbound webhook for task automations with a 'webhook' trigger.
// POST { task_id, ...anything } with header  X-Hook-Secret: <secret>.
// The token routes to one automation; the body is stored as the enrolment
// context (available to downstream "Send webhook" actions). 32KB body cap.
import crypto from 'crypto'
import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { enrolWebhook } from '../../../../lib/task-automations'

export const config = { maxDuration: 10, api: { bodyParser: { sizeLimit: '32kb' } } }

function sb() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a), bb = Buffer.from(b)
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb)
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }) }
  const token = String(req.query.token || '')
  if (!token) return res.status(400).json({ error: 'missing token' })
  const db = sb()
  const { data: auto } = await db.from('task_automations')
    .select('id, name, graph, graph_version, enabled, webhook_secret, deleted_at')
    .eq('webhook_token', token).maybeSingle()
  if (!auto || auto.deleted_at || !auto.enabled) return res.status(404).json({ error: 'unknown or disabled hook' })

  const provided = String(req.headers['x-hook-secret'] || '')
  if (!auto.webhook_secret || !safeEqual(provided, auto.webhook_secret)) return res.status(401).json({ error: 'bad secret' })

  let body: any = {}
  try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) } catch { body = {} }
  const taskId = body.task_id ? String(body.task_id) : null
  if (!taskId) return res.status(400).json({ error: 'task_id required' })
  // Confirm the task exists before enrolling.
  const { data: t } = await db.from('tasks').select('id').eq('id', taskId).is('deleted_at', null).maybeSingle()
  if (!t) return res.status(404).json({ error: 'task not found' })

  const n = await enrolWebhook(db, auto, taskId, body)
  return res.status(202).json({ ok: true, enrolled: n })
}
