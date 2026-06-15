// lib/task-automations.ts
// SERVER-ONLY. The Tasks automation engine (graph edition, migration 116).
//
// Automations are graphs (lib/task-automation-graph.ts): trigger → action /
// condition (yes|no) / wait nodes. The 5-min cron sweep claims due enrolments
// atomically and WALKS the graph until it hits a wait, a retry backoff, or the
// end — so several consecutive actions fire in one tick, and waits are relative
// to when they're reached.
//
// task_created / status_changed / assignee_changed enrol inline from the task
// API; due_soon / overdue are found by an hourly checkpoint scan; webhook via
// the tokened hook endpoint.
//
// All functions are best-effort and never throw into their callers.

import crypto from 'crypto'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { notify } from './notifications'
import {
  FlowGraph, FlowNode, ConditionRule, TriggerEvent,
  entryNodeId, nextNodeId, STATUSES, PRIORITIES,
} from './task-automation-graph'

function svc(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  return createClient(url, key, { auth: { persistSession: false } })
}

const MAX_NODES_PER_TICK = 25
const MAX_ATTEMPTS = 3
const BACKOFF_MINUTES = [5, 30, 120]

// ── Templating ────────────────────────────────────────────────────────
export function renderTemplate(tpl: string | null | undefined, vars: Record<string, string>): string {
  if (!tpl) return ''
  return String(tpl).replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k) => (vars[k] ?? ''))
}
function buildVars(task: any): Record<string, string> {
  return {
    task_title: task?.title || '',
    status: String(task?.status || '').replace(/_/g, ' '),
    priority: task?.priority || '',
    assignee_name: task?.assignee?.display_name || '',
    group_name: task?.group?.name || '',
    due_date: task?.due_at ? new Date(task.due_at).toLocaleDateString('en-AU', { day: '2-digit', month: 'short' }) : '',
  }
}

// ── Enrolment (inline triggers) ───────────────────────────────────────
export async function enrolTask(
  task: { id: string; status: string; priority: string; group_id: string | null; assignee_id: string | null },
  event: Exclude<TriggerEvent, 'due_soon' | 'overdue' | 'webhook'>,
  db?: SupabaseClient,
  onlyAutomationId?: string,
  excludeAutomationId?: string,
): Promise<void> {
  try {
    const c = db || svc()
    let q = c.from('task_automations')
      .select('id, trigger_event, trigger_config, graph, graph_version')
      .eq('enabled', true).is('deleted_at', null)
    if (event !== 'manual') q = q.eq('trigger_event', event)
    if (onlyAutomationId) q = q.eq('id', onlyAutomationId)
    const { data: autos } = await q
    if (!autos || !autos.length) return
    for (const a of autos as any[]) {
      if (excludeAutomationId && a.id === excludeAutomationId) continue
      const cfg = a.trigger_config || {}
      if (event === 'status_changed' && cfg.status && cfg.status !== task.status) continue
      if (event === 'task_created') {
        if (cfg.group_id && cfg.group_id !== task.group_id) continue
        if (cfg.priority && cfg.priority !== task.priority) continue
      }
      const graph = (a.graph && Array.isArray(a.graph.nodes)) ? a.graph as FlowGraph : null
      if (!graph) continue
      const entry = entryNodeId(graph)
      if (!entry) continue
      const { error } = await c.from('task_automation_enrolments').insert({
        automation_id: a.id, task_id: task.id, status: 'active',
        next_run_at: new Date().toISOString(),
        current_node_id: entry, graph_version: a.graph_version || 1,
      })
      if (error && error.code !== '23505') console.error('enrolTask insert failed:', error.message)
    }
  } catch (e: any) {
    console.error('enrolTask failed (non-fatal):', e?.message || e)
  }
}

// Webhook trigger — enrol all webhook automations matching the token's
// automation, with the posted body as context. Returns count enrolled.
export async function enrolWebhook(c: SupabaseClient, automation: any, taskId: string | null, context: any): Promise<number> {
  const graph = (automation.graph && Array.isArray(automation.graph.nodes)) ? automation.graph as FlowGraph : null
  if (!graph) return 0
  const entry = entryNodeId(graph)
  if (!entry || !taskId) return 0
  const { error } = await c.from('task_automation_enrolments').insert({
    automation_id: automation.id, task_id: taskId, status: 'active',
    next_run_at: new Date().toISOString(), current_node_id: entry,
    graph_version: automation.graph_version || 1, context: context ?? null,
  })
  return error ? 0 : 1
}

// ── Condition evaluation ──────────────────────────────────────────────
function isOverdue(task: any): boolean {
  return !!task?.due_at && task?.status !== 'done' && new Date(task.due_at).getTime() < Date.now()
}
function resolveField(field: string, task: any): any {
  switch (field) {
    case 'task.status': return task?.status ?? null
    case 'task.priority': return task?.priority ?? null
    case 'task.assignee_id': return task?.assignee_id ?? null
    case 'task.group_id': return task?.group_id ?? null
    case 'task.is_overdue': return isOverdue(task)
    case 'task.has_due': return !!task?.due_at
    case 'task.has_assignee': return !!task?.assignee_id
    default: return null
  }
}
function evalRule(rule: ConditionRule, task: any): boolean {
  const v = resolveField(rule.field, task)
  switch (rule.op) {
    case 'eq': return String(v ?? '') === String(rule.value ?? '')
    case 'neq': return String(v ?? '') !== String(rule.value ?? '')
    case 'is_set': return v !== null && v !== '' && v !== false
    case 'not_set': return v === null || v === '' || v === false
    case 'is_true': return v === true
    case 'is_false': return v === false
    default: return false
  }
}
function evalCondition(node: FlowNode, task: any): boolean {
  const rules = node.data.rules || []
  if (!rules.length) return false
  const results = rules.map(r => evalRule(r, task))
  return node.data.match === 'any' ? results.some(Boolean) : results.every(Boolean)
}

// ── Action execution ──────────────────────────────────────────────────
async function executeAction(
  c: SupabaseClient,
  node: FlowNode,
  ctx: { enrolmentId: string; automationId: string; autoName: string; task: any; context?: any },
): Promise<{ status: 'sent' | 'skipped' | 'failed'; detail: string }> {
  const { task, autoName } = ctx
  const d = node.data
  const vars = buildVars(task)

  if (d.action === 'set_status') {
    const status = String(d.status || '').trim()
    if (!STATUSES.includes(status as any)) return { status: 'skipped', detail: 'no/invalid status' }
    if (task.status === status) return { status: 'skipped', detail: 'already in status' }
    const patch: any = { status, completed_at: status === 'done' ? new Date().toISOString() : null, updated_at: new Date().toISOString() }
    const { error } = await c.from('tasks').update(patch).eq('id', task.id)
    if (error) return { status: 'failed', detail: error.message }
    task.status = status
    // Other automations may trigger on this status change — never this one.
    await enrolTask({ ...task }, 'status_changed', c, undefined, ctx.automationId)
    return { status: 'sent', detail: `status → ${status}` }
  }

  if (d.action === 'set_priority') {
    const priority = String(d.priority || '').trim()
    if (!PRIORITIES.includes(priority as any)) return { status: 'skipped', detail: 'no/invalid priority' }
    const { error } = await c.from('tasks').update({ priority, updated_at: new Date().toISOString() }).eq('id', task.id)
    if (error) return { status: 'failed', detail: error.message }
    task.priority = priority
    return { status: 'sent', detail: `priority → ${priority}` }
  }

  if (d.action === 'assign') {
    let assignee: string | null
    if (d.assignee_id === 'creator') assignee = task.created_by || null
    else assignee = d.assignee_id ? String(d.assignee_id) : null
    const { error } = await c.from('tasks').update({ assignee_id: assignee, updated_at: new Date().toISOString() }).eq('id', task.id)
    if (error) return { status: 'failed', detail: error.message }
    task.assignee_id = assignee
    if (assignee) await enrolTask({ ...task }, 'assignee_changed', c, undefined, ctx.automationId)
    return { status: 'sent', detail: assignee ? `assigned ${assignee}` : 'unassigned' }
  }

  if (d.action === 'move_group') {
    const group = d.group_id ? String(d.group_id) : null
    const { error } = await c.from('tasks').update({ group_id: group, updated_at: new Date().toISOString() }).eq('id', task.id)
    if (error) return { status: 'failed', detail: error.message }
    task.group_id = group
    return { status: 'sent', detail: group ? `group → ${group}` : 'group cleared' }
  }

  if (d.action === 'notify') {
    const target = d.notify_target === 'creator' ? task.created_by : task.assignee_id
    if (!target) return { status: 'skipped', detail: `no ${d.notify_target || 'assignee'}` }
    const title = renderTemplate(d.title, vars) || `Task: ${task.title}`
    await notify({ module: 'tasks', title, body: renderTemplate(d.body, vars), href: '/tasks', userIds: [target], dedupeKey: `task-auto:${ctx.enrolmentId}:${node.id}` })
    return { status: 'sent', detail: 'notified' }
  }

  if (d.action === 'create_task') {
    // Created tasks deliberately do NOT fire task_created automations — avoids
    // automation loops. Use explicit flows for follow-on work.
    const title = renderTemplate(d.title, vars) || 'Follow-up task'
    let assignee: string | null = null
    if (d.assignee_id === 'creator') assignee = task.created_by || null
    else if (d.assignee_id) assignee = String(d.assignee_id)
    const { error } = await c.from('tasks').insert({
      title: title.slice(0, 300),
      description: renderTemplate(d.body, vars) || null,
      status: STATUSES.includes((d.status || '') as any) ? d.status : 'todo',
      priority: PRIORITIES.includes((d.priority || '') as any) ? d.priority : 'normal',
      assignee_id: assignee,
      group_id: d.group_id ? String(d.group_id) : (task.group_id || null),
      created_by: task.created_by || null,
    })
    if (error) return { status: 'failed', detail: error.message }
    return { status: 'sent', detail: 'task created' }
  }

  if (d.action === 'webhook_out') {
    const url = String(d.url || '').trim()
    if (!/^https?:\/\//i.test(url)) return { status: 'skipped', detail: 'no/invalid URL configured' }
    const payload = JSON.stringify({
      automation: autoName,
      task: { id: task.id, title: task.title, status: task.status, priority: task.priority, assignee_id: task.assignee_id, group_id: task.group_id, due_at: task.due_at },
      context: ctx.context ?? null,
      sent_at: new Date().toISOString(),
    })
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (d.secret) headers['X-Hook-Signature'] = crypto.createHmac('sha256', String(d.secret)).update(payload).digest('hex')
    try {
      const controller = new AbortController()
      const t = setTimeout(() => controller.abort(), 10_000)
      const r = await fetch(url, { method: 'POST', headers, body: payload, signal: controller.signal })
      clearTimeout(t)
      if (!r.ok) return { status: 'failed', detail: `webhook HTTP ${r.status}` }
      return { status: 'sent', detail: `webhook → ${url.slice(0, 80)}` }
    } catch (err: any) { return { status: 'failed', detail: `webhook: ${String(err?.message || err).slice(0, 200)}` } }
  }

  return { status: 'skipped', detail: `unknown action ${d.action}` }
}

// ── Cron-detected triggers: due_soon + overdue ────────────────────────
async function scanDueTriggers(c: SupabaseClient): Promise<void> {
  try {
    const { data: cp } = await c.from('task_automation_checkpoints').select('updated_at').eq('key', 'due_scan').maybeSingle()
    if (cp && Date.now() - new Date(cp.updated_at).getTime() < 55 * 60000) return
    await c.from('task_automation_checkpoints').upsert({ key: 'due_scan', value: { ran_at: new Date().toISOString() }, updated_at: new Date().toISOString() })

    const { data: autos } = await c.from('task_automations')
      .select('id, trigger_event, trigger_config, graph, graph_version')
      .eq('enabled', true).in('trigger_event', ['due_soon', 'overdue']).is('deleted_at', null)
    const nowIso = new Date().toISOString()
    for (const a of (autos || []) as any[]) {
      const graph = (a.graph && Array.isArray(a.graph.nodes)) ? a.graph : null
      const entry = graph ? entryNodeId(graph) : null
      if (!entry) continue
      let q = c.from('tasks').select('id, due_at, group_id, status').is('deleted_at', null).neq('status', 'done').not('due_at', 'is', null).limit(200)
      if (a.trigger_event === 'overdue') q = q.lt('due_at', nowIso)
      else {
        const days = Math.max(1, Number(a.trigger_config?.days) || 3)
        q = q.gte('due_at', nowIso).lte('due_at', new Date(Date.now() + days * 86400_000).toISOString())
      }
      if (a.trigger_config?.group_id) q = q.eq('group_id', a.trigger_config.group_id)
      const { data: tasks } = await q
      for (const t of (tasks || []) as any[]) {
        const { error } = await c.from('task_automation_enrolments').insert({
          automation_id: a.id, task_id: t.id, status: 'active',
          next_run_at: nowIso, current_node_id: entry, graph_version: a.graph_version || 1,
          dedupe_key: `${a.trigger_event}:${t.id}:${t.due_at}`,
        })
        if (error && error.code !== '23505') console.error('due-scan enrol failed:', error.message)
      }
    }
  } catch (e: any) {
    console.error('scanDueTriggers failed (non-fatal):', e?.message || e)
  }
}

// ── The sweep ─────────────────────────────────────────────────────────
export interface SweepResult { due: number; sent: number; skipped: number; failed: number; stopped: number; completed: number }

export async function processDueTaskAutomations(limit = 150): Promise<SweepResult> {
  const c = svc()
  const res: SweepResult = { due: 0, sent: 0, skipped: 0, failed: 0, stopped: 0, completed: 0 }
  const nowIso = new Date().toISOString()

  await scanDueTriggers(c)

  const { data: enrolments, error } = await c.from('task_automation_enrolments')
    .select(`id, automation_id, task_id, current_node_id, node_entered_at, graph_version, attempt_count, context, next_run_at,
             automation:task_automations(id, name, enabled, deleted_at, graph),
             task:tasks(id, title, status, priority, assignee_id, group_id, due_at, created_by, deleted_at,
                        assignee:user_profiles!assignee_id(id, display_name), group:task_groups!group_id(id, name))`)
    .eq('status', 'active').lte('next_run_at', nowIso)
    .order('next_run_at', { ascending: true }).limit(limit)
  if (error) { console.error('task automations sweep query failed:', error.message); return res }
  res.due = enrolments?.length || 0

  for (const e of (enrolments || []) as any[]) {
    try {
      const { data: claimed } = await c.from('task_automation_enrolments')
        .update({ next_run_at: new Date(Date.now() + 10 * 60000).toISOString() })
        .eq('id', e.id).eq('status', 'active').lte('next_run_at', nowIso)
        .select('id')
      if (!claimed || claimed.length === 0) continue

      const auto = e.automation
      const task = e.task

      const stop = async (reason: string, status: 'cancelled' | 'done' = 'cancelled') => {
        await c.from('task_automation_enrolments').update({ status, cancel_reason: status === 'cancelled' ? reason : null, last_run_at: nowIso }).eq('id', e.id)
        if (status === 'cancelled') res.stopped++; else res.completed++
      }

      if (!auto || auto.deleted_at || !auto.enabled) { await stop('automation_disabled'); continue }
      if (!task || task.deleted_at) { await stop('task_gone'); continue }

      const graph: FlowGraph | null = (auto.graph && Array.isArray(auto.graph.nodes)) ? auto.graph : null
      if (!graph) { await stop('no_graph'); continue }

      let cursor: string | null = e.current_node_id || entryNodeId(graph)
      let context: any = e.context || {}
      let attempts: number = Number(e.attempt_count) || 0
      let walked = 0
      let parked = false

      const persist = async (patch: any) => {
        await c.from('task_automation_enrolments').update({ ...patch, last_run_at: new Date().toISOString() }).eq('id', e.id)
      }

      while (cursor && walked < MAX_NODES_PER_TICK) {
        walked++
        const node = graph.nodes.find(n => n.id === cursor)
        if (!node) { await stop('node_removed'); parked = true; break }

        if (node.data.kind === 'trigger') { cursor = nextNodeId(graph, node.id); continue }

        if (node.data.kind === 'wait') {
          const hours = Math.max(0, Number(node.data.hours) || 0)
          if (context.waiting_node === node.id) {
            context = { ...context, waiting_node: null }
            cursor = nextNodeId(graph, node.id)
            if (!cursor) break
            continue
          }
          context = { ...context, waiting_node: node.id }
          await persist({
            current_node_id: node.id, node_entered_at: new Date().toISOString(),
            next_run_at: new Date(Date.now() + hours * 3600_000).toISOString(),
            attempt_count: 0, context,
          })
          parked = true
          break
        }

        if (node.data.kind === 'condition') {
          const yes = evalCondition(node, task)
          await c.from('task_automation_runs').insert({ enrolment_id: e.id, node_id: node.id, action: 'condition', status: 'skipped', detail: yes ? 'yes' : 'no', attempt: 1 })
          cursor = nextNodeId(graph, node.id, yes ? 'yes' : 'no')
          if (!cursor) break
          continue
        }

        // Action node. Crash-replay guard.
        const attempt = attempts + 1
        const { data: priorRuns } = await c.from('task_automation_runs')
          .select('id').eq('enrolment_id', e.id).eq('node_id', node.id).eq('attempt', attempt).eq('status', 'sent').limit(1)
        let outcome: { status: 'sent' | 'skipped' | 'failed'; detail: string }
        if (priorRuns && priorRuns.length) {
          outcome = { status: 'sent', detail: 'already ran (crash replay guard)' }
        } else {
          outcome = await executeAction(c, node, { enrolmentId: e.id, automationId: auto.id, autoName: auto.name, task, context })
          await c.from('task_automation_runs').insert({ enrolment_id: e.id, node_id: node.id, action: node.data.action, status: outcome.status, detail: outcome.detail, attempt })
        }

        if (outcome.status === 'failed') {
          res.failed++
          if (attempt < MAX_ATTEMPTS) {
            const backoffMin = BACKOFF_MINUTES[Math.min(attempt - 1, BACKOFF_MINUTES.length - 1)]
            await persist({ current_node_id: node.id, attempt_count: attempt, next_run_at: new Date(Date.now() + backoffMin * 60000).toISOString(), context })
            parked = true
            break
          }
          if ((node.data.on_failure || 'continue') === 'stop') { await stop('node_failed'); parked = true; break }
        } else if (outcome.status === 'sent') res.sent++
        else res.skipped++

        attempts = 0
        cursor = nextNodeId(graph, node.id)
        if (!cursor) break
      }

      if (!parked) {
        if (cursor && walked >= MAX_NODES_PER_TICK) {
          await persist({ current_node_id: cursor, attempt_count: 0, next_run_at: new Date().toISOString(), context })
        } else {
          await stop('', 'done')
        }
      }
    } catch (err: any) {
      console.error('task automation enrolment run failed:', err?.message || err)
      res.failed++
    }
  }
  return res
}
