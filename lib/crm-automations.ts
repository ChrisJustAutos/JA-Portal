// lib/crm-automations.ts
// SERVER-ONLY. The CRM automation engine, graph edition (migration 099).
//
// Automations are graphs (lib/crm-automation-graph.ts): trigger → action /
// condition (yes|no) / wait nodes. The 5-min cron sweep claims due enrolments
// atomically and WALKS the graph until it hits a wait, a retry backoff, or
// the end — so several consecutive actions fire in one tick, and waits are
// relative to when they're reached (not cumulative from enrolment).
//
// Legacy linear automations (graph IS NULL) are migrated lazily: first touch
// converts steps → graph via linearStepsToGraph and maps any in-flight
// enrolment's next_step_order onto the 'step-N' node id, keeping next_run_at
// untouched so live sequences continue exactly on schedule.
//
// All functions are best-effort and never throw into their callers.

import crypto from 'crypto'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { sendMail } from './email'
import { sendSms } from './clicksend'
import { notify } from './notifications'
import { logActivity, contactDisplayName, applyLeadStage } from './crm'
import { enrolFromEvent } from './crm-automation-triggers'
import {
  FlowGraph, FlowNode, ConditionRule,
  linearStepsToGraph, entryNodeId, nextNodeId,
} from './crm-automation-graph'

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

export function buildVars(lead: any, contact: any): Record<string, string> {
  const name = contact ? contactDisplayName(contact) : ''
  const first = (contact?.first_name || name.split(' ')[0] || 'there').trim()
  const value = lead?.value != null ? '$' + Number(lead.value).toLocaleString('en-AU', { maximumFractionDigits: 0 }) : ''
  return {
    contact_name: name,
    first_name: first,
    last_name: contact?.last_name || '',
    vehicle: lead?.vehicle || 'your vehicle',
    lead_title: lead?.title || '',
    value,
    owner_name: lead?.owner?.display_name || '',
    company: contact?.company_name || '',
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
export function textToHtml(text: string): string {
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;line-height:1.5">${escapeHtml(text).replace(/\n/g, '<br>')}</div>`
}

// ── Graph access (with lazy legacy migration) ─────────────────────────
async function ensureGraph(c: SupabaseClient, automation: { id: string; trigger_event: string; trigger_stage: string | null; graph: any }): Promise<FlowGraph | null> {
  if (automation.graph && Array.isArray(automation.graph.nodes)) return automation.graph as FlowGraph
  const { data: steps } = await c.from('crm_automation_steps')
    .select('step_order, delay_hours, action, subject, body, task_priority')
    .eq('automation_id', automation.id).order('step_order', { ascending: true })
  if (!steps || steps.length === 0) return null
  const graph = linearStepsToGraph(automation, steps as any[])
  await c.from('crm_automations').update({ graph, trigger_config: { stage: automation.trigger_stage || null } }).eq('id', automation.id)
  return graph
}

// ── Enrolment ─────────────────────────────────────────────────────────
// Called when a lead is created or changes stage (and from the manual-enrol
// API). Enrols into every enabled automation whose trigger matches, starting
// the cursor at the trigger's first downstream node, due immediately — the
// sweep walks waits itself.
export async function enrolLead(
  lead: { id: string; stage: string; contact_id: string | null },
  event: 'lead_created' | 'stage_changed' | 'manual',
  db?: SupabaseClient,
  onlyAutomationId?: string,
  excludeAutomationId?: string,
): Promise<void> {
  try {
    const c = db || svc()
    let q = c.from('crm_automations')
      .select('id, trigger_event, trigger_stage, trigger_config, graph, graph_version')
      .eq('enabled', true).is('deleted_at', null)
    if (event !== 'manual') q = q.eq('trigger_event', event)
    if (onlyAutomationId) q = q.eq('id', onlyAutomationId)
    const { data: autos } = await q
    if (!autos || !autos.length) return
    for (const a of autos as any[]) {
      if (excludeAutomationId && a.id === excludeAutomationId) continue
      const stageFilter = (a.trigger_config?.stage ?? a.trigger_stage) || null
      if (event !== 'manual' && stageFilter && stageFilter !== lead.stage) continue
      const graph = await ensureGraph(c, a)
      if (!graph) continue
      const entry = entryNodeId(graph)
      if (!entry) continue
      const { error } = await c.from('crm_automation_enrolments').insert({
        automation_id: a.id,
        lead_id: lead.id,
        contact_id: lead.contact_id,
        status: 'active',
        next_step_order: 1,           // legacy column, unused by the graph engine
        next_run_at: new Date().toISOString(),
        current_node_id: entry,
        graph_version: a.graph_version || 1,
      })
      // 23505 = already actively enrolled (partial unique) — that's the guard working.
      if (error && error.code !== '23505') console.error('enrol insert failed:', error.message)
    }
  } catch (e: any) {
    console.error('enrolLead failed (non-fatal):', e?.message || e)
  }
}

// ── Condition evaluation ──────────────────────────────────────────────
function resolveField(field: string, lead: any, contact: any): any {
  switch (field) {
    case 'lead.stage': return lead?.stage ?? null
    case 'lead.value': return lead?.value != null ? Number(lead.value) : null
    case 'lead.source': return lead?.source ?? null
    case 'lead.owner_id': return lead?.owner_id ?? null
    case 'contact.tags': return Array.isArray(contact?.tags) ? contact.tags : []
    case 'contact.source': return contact?.source ?? null
    case 'contact.has_email': return !!contact?.email
    case 'contact.has_mobile': return !!(contact?.mobile || contact?.phone)
    default: return null
  }
}

// Async fields (engagement / time) resolved before the sync compare.
async function resolveAsyncField(c: SupabaseClient, field: string, contact: any): Promise<any> {
  if (field === 'engagement.opened' || field === 'engagement.clicked') {
    if (!contact?.id) return false
    const col = field === 'engagement.opened' ? 'opened_at' : 'first_clicked_at'
    const { data } = await c.from('crm_campaign_recipients')
      .select('id').eq('contact_id', contact.id).not(col, 'is', null).limit(1)
    return !!(data && data.length)
  }
  if (field === 'time.is_business_hours') {
    const bne = new Date(Date.now() + 10 * 3600_000)   // Australia/Brisbane, no DST
    const dow = bne.getUTCDay(), hr = bne.getUTCHours()
    return dow >= 1 && dow <= 5 && hr >= 8 && hr < 17
  }
  if (field === 'time.day_of_week') {
    return ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][new Date(Date.now() + 10 * 3600_000).getUTCDay()]
  }
  return undefined
}

function evalRule(rule: ConditionRule, lead: any, contact: any): boolean {
  const v = resolveField(rule.field, lead, contact)
  const want = rule.value
  switch (rule.op) {
    case 'eq': return String(v ?? '') === String(want ?? '') || v === want
    case 'neq': return !(String(v ?? '') === String(want ?? '') || v === want)
    case 'gt': return Number(v) > Number(want)
    case 'gte': return Number(v) >= Number(want)
    case 'lt': return Number(v) < Number(want)
    case 'lte': return Number(v) <= Number(want)
    case 'contains': return Array.isArray(v) ? v.includes(String(want)) : String(v ?? '').toLowerCase().includes(String(want ?? '').toLowerCase())
    case 'not_contains': return !(Array.isArray(v) ? v.includes(String(want)) : String(v ?? '').toLowerCase().includes(String(want ?? '').toLowerCase()))
    case 'is_set': return v !== null && v !== '' && v !== false && !(Array.isArray(v) && v.length === 0)
    case 'not_set': return v === null || v === '' || v === false || (Array.isArray(v) && v.length === 0)
    default: return false
  }
}

export async function evalCondition(c: SupabaseClient, node: FlowNode, lead: any, contact: any): Promise<boolean> {
  const rules = node.data.rules || []
  if (!rules.length) return false
  const results: boolean[] = []
  for (const r of rules) {
    if (r.field.startsWith('engagement.') || r.field.startsWith('time.')) {
      const v = await resolveAsyncField(c, r.field, contact)
      if (typeof v === 'boolean') {
        // boolean async fields honour is_set/not_set/eq semantics
        results.push(r.op === 'not_set' || r.op === 'neq' ? !v : v)
      } else {
        results.push(evalRuleValue(v, r))
      }
    } else {
      results.push(evalRule(r, lead, contact))
    }
  }
  return node.data.match === 'any' ? results.some(Boolean) : results.every(Boolean)
}

function evalRuleValue(v: any, rule: ConditionRule): boolean {
  switch (rule.op) {
    case 'eq': return String(v ?? '') === String(rule.value ?? '')
    case 'neq': return String(v ?? '') !== String(rule.value ?? '')
    default: return false
  }
}

// ── Action execution (ported from the linear engine) ─────────────────
async function executeAction(
  c: SupabaseClient,
  node: FlowNode,
  ctx: { enrolmentId: string; automationId: string; autoName: string; lead: any; contact: any; context?: any },
): Promise<{ status: 'sent' | 'skipped' | 'failed'; detail: string }> {
  const { lead, contact, autoName } = ctx
  const d = node.data
  const vars = buildVars(lead, contact)

  if (d.action === 'email') {
    const to = contact?.email
    if (!to) return { status: 'skipped', detail: 'no email on contact' }
    const subject = renderTemplate(d.subject, vars) || 'A quick follow-up'
    try {
      await sendMail(process.env.RESEND_FROM || 'noreply@mail.justautos.app', { to: [to], subject, html: textToHtml(renderTemplate(d.body, vars)) })
      await logActivity(c, { lead_id: lead?.id, contact_id: contact?.id, type: 'email', body: `Automation "${autoName}": ${subject}` })
      return { status: 'sent', detail: `email → ${to}` }
    } catch (err: any) { return { status: 'failed', detail: String(err?.message || err).slice(0, 300) } }
  }

  if (d.action === 'sms') {
    const to = contact?.mobile || contact?.phone
    if (!to) return { status: 'skipped', detail: 'no phone on contact' }
    const text = renderTemplate(d.body, vars)
    const r = await sendSms(to, text)
    if (!r.ok) return { status: 'failed', detail: r.error || 'sms failed' }
    await logActivity(c, { lead_id: lead?.id, contact_id: contact?.id, type: 'sms', body: `Automation "${autoName}": ${text.slice(0, 160)}` })
    return { status: 'sent', detail: `sms → ${to}` }
  }

  if (d.action === 'task') {
    const title = renderTemplate(d.subject, vars) || 'Follow-up'
    const { data: t } = await c.from('crm_tasks').insert({
      title: title.slice(0, 200),
      description: renderTemplate(d.body, vars) || null,
      status: 'open',
      priority: d.task_priority || 'normal',
      assignee_id: lead?.owner_id || null,
      lead_id: lead?.id || null,
      contact_id: contact?.id || null,
    }).select('id').single()
    if (lead?.owner_id) await notify({ module: 'crm', title: 'Automated follow-up task', body: title, href: '/crm/tasks', userIds: [lead.owner_id], dedupeKey: `crm-auto-task:${t?.id}` })
    await logActivity(c, { lead_id: lead?.id, contact_id: contact?.id, type: 'task', body: `Automation "${autoName}": ${title}` })
    return { status: 'sent', detail: `task created${t ? ` ${t.id}` : ''}` }
  }

  if (d.action === 'notify_owner') {
    const title = renderTemplate(d.subject, vars) || `Follow up on ${lead?.title || 'a lead'}`
    if (!lead?.owner_id) return { status: 'skipped', detail: 'no owner' }
    await notify({ module: 'crm', title, body: renderTemplate(d.body, vars), href: '/crm', userIds: [lead.owner_id], dedupeKey: `crm-auto-notify:${ctx.enrolmentId}:${node.id}` })
    return { status: 'sent', detail: 'owner notified' }
  }

  if (d.action === 'add_tag' || d.action === 'remove_tag') {
    if (!contact?.id) return { status: 'skipped', detail: 'no contact' }
    const tag = String(d.tag || '').trim()
    if (!tag) return { status: 'skipped', detail: 'no tag configured' }
    const tags: string[] = Array.isArray(contact.tags) ? contact.tags : []
    const has = tags.some(t => t.toLowerCase() === tag.toLowerCase())
    if (d.action === 'add_tag' && !has) {
      await c.from('crm_contacts').update({ tags: [...tags, tag] }).eq('id', contact.id)
      contact.tags = [...tags, tag]
      // Tag-added trigger fires for OTHER automations (never this one).
      await enrolFromEvent(c, 'tag_added', { contact_id: contact.id, tag, dedupe_key: `tag:${contact.id}:${tag.toLowerCase()}`, excludeAutomationId: ctx.automationId })
      return { status: 'sent', detail: `tag "${tag}" added` }
    }
    if (d.action === 'remove_tag' && has) {
      const next = tags.filter(t => t.toLowerCase() !== tag.toLowerCase())
      await c.from('crm_contacts').update({ tags: next }).eq('id', contact.id)
      contact.tags = next
      return { status: 'sent', detail: `tag "${tag}" removed` }
    }
    return { status: 'skipped', detail: d.action === 'add_tag' ? 'tag already present' : 'tag not present' }
  }

  if (d.action === 'move_stage') {
    if (!lead?.id) return { status: 'skipped', detail: 'no lead (contact-only enrolment)' }
    const stage = String(d.stage || '').trim()
    if (!stage) return { status: 'skipped', detail: 'no stage configured' }
    const r = await applyLeadStage(c, lead.id, stage, null)
    if (!r.ok) return { status: 'failed', detail: r.error || 'stage move failed' }
    if (r.changed) {
      lead.stage = stage
      // Other automations may trigger on this move — never this one.
      await enrolLead({ id: lead.id, stage, contact_id: r.contactId || null }, 'stage_changed', c, undefined, ctx.automationId)
    }
    return { status: 'sent', detail: `stage → ${stage}` }
  }

  if (d.action === 'update_field') {
    if (!lead?.id) return { status: 'skipped', detail: 'no lead (contact-only enrolment)' }
    const field = d.field
    const raw = renderTemplate(d.field_value, vars)
    const patch: any = {}
    if (field === 'value') patch.value = raw === '' ? null : Number(raw) || 0
    else if (field === 'owner_id') patch.owner_id = raw || null
    else if (field === 'next_follow_up_in_days') patch.next_follow_up_at = new Date(Date.now() + (Number(raw) || 0) * 86400_000).toISOString()
    else return { status: 'skipped', detail: 'no field configured' }
    const { error } = await c.from('crm_leads').update(patch).eq('id', lead.id)
    if (error) return { status: 'failed', detail: error.message }
    return { status: 'sent', detail: `${field} updated` }
  }

  if (d.action === 'webhook_out') {
    const url = String(d.url || '').trim()
    if (!/^https?:\/\//i.test(url)) return { status: 'skipped', detail: 'no/invalid URL configured' }
    const payload = JSON.stringify({
      automation: ctx.autoName,
      lead: lead ? { id: lead.id, title: lead.title, stage: lead.stage, value: lead.value, vehicle: lead.vehicle } : null,
      contact: contact ? { id: contact.id, name: contact.name, email: contact.email, mobile: contact.mobile, phone: contact.phone, tags: contact.tags } : null,
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

  if (d.action === 'create_quote_draft') {
    if (!contact?.id) return { status: 'skipped', detail: 'no contact' }
    if (lead?.workshop_quote_id) return { status: 'skipped', detail: 'lead already has a quote' }
    // Resolve / create the workshop customer (mirrors contacts/[id]/to-workshop).
    let customerId: string | null = contact.workshop_customer_id || null
    if (!customerId && contact.email) {
      const { data: m } = await c.from('workshop_customers').select('id').ilike('email', String(contact.email).trim()).limit(1)
      customerId = m?.[0]?.id || null
    }
    if (!customerId) {
      const { data: created, error } = await c.from('workshop_customers').insert({
        name: contact.name, email: contact.email || null, phone: contact.phone || null, mobile: contact.mobile || null,
      }).select('id').single()
      if (error) return { status: 'failed', detail: error.message }
      customerId = created.id
    }
    await c.from('crm_contacts').update({ workshop_customer_id: customerId }).eq('id', contact.id)
    const { data: quote, error: qErr } = await c.from('workshop_quotes').insert({
      customer_id: customerId, notes: lead ? (lead.details || lead.title || null) : null,
    }).select('id').single()
    if (qErr) return { status: 'failed', detail: qErr.message }
    if (lead?.id) await c.from('crm_leads').update({ workshop_quote_id: quote.id }).eq('id', lead.id)
    await logActivity(c, { lead_id: lead?.id || null, contact_id: contact.id, type: 'workshop_handoff', body: `Automation "${ctx.autoName}" created a draft workshop quote`, meta: { workshop_quote_id: quote.id } })
    return { status: 'sent', detail: `quote draft ${quote.id}` }
  }

  return { status: 'skipped', detail: `unknown action ${d.action}` }
}

// ── The sweep ─────────────────────────────────────────────────────────
export interface SweepResult { due: number; sent: number; skipped: number; failed: number; stopped: number; completed: number }

// Hourly (checkpoint-gated) scan for 'no_activity' triggers: leads whose
// last_activity_at went stale past each automation's configured threshold.
// The dedupe key includes the stale timestamp, so a lead re-fires only after
// fresh activity goes stale again.
async function scanNoActivityTriggers(c: SupabaseClient): Promise<void> {
  try {
    const { data: cp } = await c.from('crm_automation_checkpoints').select('value, updated_at').eq('key', 'no_activity_scan').maybeSingle()
    if (cp && Date.now() - new Date(cp.updated_at).getTime() < 55 * 60000) return
    await c.from('crm_automation_checkpoints').upsert({ key: 'no_activity_scan', value: { ran_at: new Date().toISOString() }, updated_at: new Date().toISOString() })

    const { data: autos } = await c.from('crm_automations')
      .select('id, trigger_config, graph, graph_version')
      .eq('enabled', true).eq('trigger_event', 'no_activity').is('deleted_at', null)
    for (const a of (autos || []) as any[]) {
      const days = Math.max(1, Number(a.trigger_config?.days) || 7)
      const stage = a.trigger_config?.stage || null
      const cutoff = new Date(Date.now() - days * 86400_000).toISOString()
      let q = c.from('crm_leads')
        .select('id, stage, contact_id, last_activity_at')
        .is('deleted_at', null).is('won_at', null).is('lost_at', null)
        .lt('last_activity_at', cutoff).limit(100)
      if (stage) q = q.eq('stage', stage)
      const { data: leads } = await q
      const graph = (a.graph && Array.isArray(a.graph.nodes)) ? a.graph : null
      const entry = graph ? entryNodeId(graph) : null
      if (!entry) continue
      for (const l of (leads || []) as any[]) {
        const { error } = await c.from('crm_automation_enrolments').insert({
          automation_id: a.id, lead_id: l.id, contact_id: l.contact_id,
          status: 'active', next_step_order: 1, next_run_at: new Date().toISOString(),
          current_node_id: entry, graph_version: a.graph_version || 1,
          dedupe_key: `noact:${l.id}:${l.last_activity_at || 'never'}`,
        })
        if (error && error.code !== '23505') console.error('no_activity enrol failed:', error.message)
      }
    }
  } catch (e: any) {
    console.error('scanNoActivityTriggers failed (non-fatal):', e?.message || e)
  }
}

export async function processDueAutomations(limit = 150): Promise<SweepResult> {
  const c = svc()
  const res: SweepResult = { due: 0, sent: 0, skipped: 0, failed: 0, stopped: 0, completed: 0 }
  const nowIso = new Date().toISOString()

  await scanNoActivityTriggers(c)

  const { data: enrolments, error } = await c.from('crm_automation_enrolments')
    .select(`id, automation_id, lead_id, contact_id, next_step_order, current_node_id, node_entered_at, graph_version, attempt_count, context, started_at, next_run_at,
             automation:crm_automations(id, name, enabled, deleted_at, cancel_on_stages, trigger_event, trigger_stage, graph, graph_version),
             lead:crm_leads(id, title, stage, value, source, vehicle, details, owner_id, workshop_quote_id, deleted_at, owner:user_profiles!crm_leads_owner_id_fkey(display_name)),
             contact:crm_contacts(id, name, first_name, last_name, email, phone, mobile, company_name, tags, source, workshop_customer_id, do_not_contact, deleted_at)`)
    .eq('status', 'active').lte('next_run_at', nowIso)
    .order('next_run_at', { ascending: true }).limit(limit)
  if (error) { console.error('automations sweep query failed:', error.message); return res }
  res.due = enrolments?.length || 0

  for (const e of (enrolments || []) as any[]) {
    try {
      // Atomic claim: bump next_run_at so an overlapping cron invocation
      // skips this row. If no row comes back, someone else claimed it.
      const { data: claimed } = await c.from('crm_automation_enrolments')
        .update({ next_run_at: new Date(Date.now() + 10 * 60000).toISOString() })
        .eq('id', e.id).eq('status', 'active').lte('next_run_at', nowIso)
        .select('id')
      if (!claimed || claimed.length === 0) continue

      const auto = e.automation
      const lead = e.lead
      const contact = e.contact

      const stop = async (reason: string, status: 'cancelled' | 'done' = 'cancelled') => {
        await c.from('crm_automation_enrolments').update({ status, cancel_reason: status === 'cancelled' ? reason : null, last_run_at: nowIso }).eq('id', e.id)
        if (status === 'cancelled') res.stopped++; else res.completed++
      }

      // Guards (ported; lead guards skipped for contact-only enrolments).
      if (!auto || auto.deleted_at || !auto.enabled) { await stop('automation_disabled'); continue }
      if (e.lead_id && (!lead || lead.deleted_at)) { await stop('lead_gone'); continue }
      if (lead) {
        const cancelStages: string[] = auto.cancel_on_stages || []
        if (cancelStages.includes(lead.stage)) { await stop(`lead_${lead.stage}`); continue }
      }
      if (contact?.do_not_contact) { await stop('do_not_contact'); continue }

      const graph = await ensureGraph(c, auto)
      if (!graph) { await stop('no_graph'); continue }

      // Cursor: legacy enrolments map next_step_order → 'step-N'.
      let cursor: string | null = e.current_node_id
      if (!cursor) {
        const legacy = `step-${e.next_step_order}`
        cursor = graph.nodes.some(n => n.id === legacy) ? legacy : entryNodeId(graph)
      }

      let context: any = e.context || {}
      let attempts: number = Number(e.attempt_count) || 0
      let walked = 0
      let parked = false   // stopped at a wait / retry backoff

      const persist = async (patch: any) => {
        await c.from('crm_automation_enrolments').update({ ...patch, last_run_at: new Date().toISOString() }).eq('id', e.id)
      }

      while (cursor && walked < MAX_NODES_PER_TICK) {
        walked++
        const node = graph.nodes.find(n => n.id === cursor)
        if (!node) { await stop('node_removed'); parked = true; break }

        if (node.data.kind === 'trigger') {
          cursor = nextNodeId(graph, node.id)
          continue
        }

        if (node.data.kind === 'wait') {
          const hours = Math.max(0, Number(node.data.hours) || 0)
          if (context.waiting_node === node.id) {
            // Wait elapsed (we were parked here and next_run_at came due).
            context = { ...context, waiting_node: null }
            cursor = nextNodeId(graph, node.id)
            if (!cursor) break
            continue
          }
          // Arrived at the wait — park.
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
          const yes = await evalCondition(c, node, lead, contact)
          await c.from('crm_automation_runs').insert({ enrolment_id: e.id, node_id: node.id, action: 'condition', status: 'skipped', detail: yes ? 'yes' : 'no', attempt: 1 })
          cursor = nextNodeId(graph, node.id, yes ? 'yes' : 'no')
          if (!cursor) break
          continue
        }

        // Action node. Crash-replay backstop: if this (node, attempt) already
        // ran with status sent, don't re-execute — just advance.
        const attempt = attempts + 1
        const { data: priorRuns } = await c.from('crm_automation_runs')
          .select('id').eq('enrolment_id', e.id).eq('node_id', node.id).eq('attempt', attempt).eq('status', 'sent').limit(1)
        let outcome: { status: 'sent' | 'skipped' | 'failed'; detail: string }
        if (priorRuns && priorRuns.length) {
          outcome = { status: 'sent', detail: 'already ran (crash replay guard)' }
        } else {
          outcome = await executeAction(c, node, { enrolmentId: e.id, automationId: auto.id, autoName: auto.name, lead, contact, context })
          await c.from('crm_automation_runs').insert({ enrolment_id: e.id, node_id: node.id, action: node.data.action, status: outcome.status, detail: outcome.detail, attempt })
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
          // fall through and advance past the failed node
        } else if (outcome.status === 'sent') res.sent++
        else res.skipped++

        attempts = 0
        cursor = nextNodeId(graph, node.id)
        if (!cursor) break
      }

      if (!parked) {
        if (cursor && walked >= MAX_NODES_PER_TICK) {
          // Runaway protection: pick up where we left off next tick.
          await persist({ current_node_id: cursor, attempt_count: 0, next_run_at: new Date().toISOString(), context })
        } else {
          await stop('', 'done')
        }
      }
    } catch (err: any) {
      console.error('automation enrolment run failed:', err?.message || err)
      res.failed++
    }
  }
  return res
}
