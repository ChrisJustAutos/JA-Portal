// lib/crm-automations.ts
// SERVER-ONLY. The CRM automation engine: enrol leads into matching sequences
// and run due steps (email / SMS / task / owner notification). Driven by
// /api/cron/crm-automations. All functions are best-effort and never throw into
// their callers (enrolment must not break a lead create; the sweep must not die
// on one bad enrolment).

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { sendMail } from './email'
import { sendSms } from './clicksend'
import { notify } from './notifications'
import { logActivity, contactDisplayName } from './crm'

function svc(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  return createClient(url, key, { auth: { persistSession: false } })
}

// ── Templating ────────────────────────────────────────────────────────
// Supported placeholders: {{contact_name}} {{first_name}} {{last_name}}
// {{vehicle}} {{lead_title}} {{value}} {{owner_name}} {{company}}
export function renderTemplate(tpl: string | null | undefined, vars: Record<string, string>): string {
  if (!tpl) return ''
  return String(tpl).replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k) => (vars[k] ?? ''))
}

function buildVars(lead: any, contact: any): Record<string, string> {
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
function textToHtml(text: string): string {
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;line-height:1.5">${escapeHtml(text).replace(/\n/g, '<br>')}</div>`
}

// ── Enrolment ─────────────────────────────────────────────────────────
// Called when a lead is created or changes stage. Enrols the lead into every
// enabled automation whose trigger matches (and that it isn't already in).
export async function enrolLead(
  lead: { id: string; stage: string; contact_id: string | null },
  event: 'lead_created' | 'stage_changed',
  db?: SupabaseClient,
): Promise<void> {
  try {
    const c = db || svc()
    const { data: autos } = await c.from('crm_automations')
      .select('id, trigger_stage').eq('enabled', true).eq('trigger_event', event).is('deleted_at', null)
    if (!autos || !autos.length) return
    const matches = autos.filter((a: any) => !a.trigger_stage || a.trigger_stage === lead.stage)
    for (const a of matches) {
      const { data: first } = await c.from('crm_automation_steps')
        .select('step_order, delay_hours').eq('automation_id', a.id)
        .order('step_order', { ascending: true }).limit(1)
      if (!first || !first.length) continue
      const delayMs = Math.max(0, Number(first[0].delay_hours) || 0) * 3600 * 1000
      const nextRun = new Date(Date.now() + delayMs).toISOString()
      await c.from('crm_automation_enrolments').upsert({
        automation_id: a.id,
        lead_id: lead.id,
        contact_id: lead.contact_id,
        status: 'active',
        next_step_order: first[0].step_order,
        next_run_at: nextRun,
      }, { onConflict: 'automation_id,lead_id', ignoreDuplicates: true })
    }
  } catch (e: any) {
    console.error('enrolLead failed (non-fatal):', e?.message || e)
  }
}

// ── The sweep ─────────────────────────────────────────────────────────
export interface SweepResult { due: number; sent: number; skipped: number; failed: number; stopped: number; completed: number }

export async function processDueAutomations(limit = 100): Promise<SweepResult> {
  const c = svc()
  const res: SweepResult = { due: 0, sent: 0, skipped: 0, failed: 0, stopped: 0, completed: 0 }
  const nowIso = new Date().toISOString()

  const { data: enrolments, error } = await c.from('crm_automation_enrolments')
    .select(`id, automation_id, lead_id, contact_id, next_step_order, started_at,
             automation:crm_automations(id, name, enabled, deleted_at, cancel_on_stages),
             lead:crm_leads(id, title, stage, value, vehicle, owner_id, deleted_at, owner:user_profiles!crm_leads_owner_id_fkey(display_name)),
             contact:crm_contacts(id, name, first_name, last_name, email, phone, mobile, company_name, do_not_contact, deleted_at)`)
    .eq('status', 'active').lte('next_run_at', nowIso)
    .order('next_run_at', { ascending: true }).limit(limit)
  if (error) { console.error('automations sweep query failed:', error.message); return res }
  res.due = enrolments?.length || 0

  for (const e of (enrolments || []) as any[]) {
    try {
      const auto = e.automation
      const lead = e.lead
      const contact = e.contact

      // Guards that stop the sequence.
      const stop = async (reason: string, status: 'cancelled' | 'done' = 'cancelled') => {
        await c.from('crm_automation_enrolments').update({ status, cancel_reason: reason, last_run_at: nowIso }).eq('id', e.id)
        if (status === 'cancelled') res.stopped++; else res.completed++
      }
      if (!auto || auto.deleted_at || !auto.enabled) { await stop('automation_disabled'); continue }
      if (!lead || lead.deleted_at) { await stop('lead_gone'); continue }
      const cancelStages: string[] = auto.cancel_on_stages || []
      if (cancelStages.includes(lead.stage)) { await stop(`lead_${lead.stage}`); continue }
      if (contact?.do_not_contact) { await stop('do_not_contact'); continue }

      // The step that's due.
      const { data: stepRows } = await c.from('crm_automation_steps')
        .select('*').eq('automation_id', auto.id).eq('step_order', e.next_step_order).limit(1)
      const step = stepRows && stepRows[0]
      if (!step) { await stop('no_more_steps', 'done'); continue }

      const vars = buildVars(lead, contact)
      let runStatus: 'sent' | 'skipped' | 'failed' = 'sent'
      let detail = ''

      if (step.action === 'email') {
        const to = contact?.email
        if (!to) { runStatus = 'skipped'; detail = 'no email on contact' }
        else {
          const subject = renderTemplate(step.subject, vars) || 'A quick follow-up'
          const html = textToHtml(renderTemplate(step.body, vars))
          try {
            await sendMail(process.env.RESEND_FROM || 'noreply@mail.justautos.app', { to: [to], subject, html })
            detail = `email → ${to}`
            await logActivity(c, { lead_id: lead.id, contact_id: contact?.id, type: 'email', body: `Automation "${auto.name}": ${subject}` })
          } catch (err: any) { runStatus = 'failed'; detail = String(err?.message || err).slice(0, 300) }
        }
      } else if (step.action === 'sms') {
        const to = contact?.mobile || contact?.phone
        const text = renderTemplate(step.body, vars)
        if (!to) { runStatus = 'skipped'; detail = 'no phone on contact' }
        else {
          const r = await sendSms(to, text)
          if (r.ok) { detail = `sms → ${to}`; await logActivity(c, { lead_id: lead.id, contact_id: contact?.id, type: 'sms', body: `Automation "${auto.name}": ${text.slice(0, 160)}` }) }
          else { runStatus = 'failed'; detail = r.error || 'sms failed' }
        }
      } else if (step.action === 'task') {
        const title = renderTemplate(step.subject, vars) || 'Follow-up'
        const { data: t } = await c.from('crm_tasks').insert({
          title: title.slice(0, 200),
          description: renderTemplate(step.body, vars) || null,
          status: 'open',
          priority: step.task_priority || 'normal',
          assignee_id: lead.owner_id || null,
          lead_id: lead.id,
          contact_id: contact?.id || null,
        }).select('id').single()
        detail = `task created${t ? ` ${t.id}` : ''}`
        if (lead.owner_id) await notify({ module: 'crm', title: 'Automated follow-up task', body: title, href: '/crm/tasks', userIds: [lead.owner_id], dedupeKey: `crm-auto-task:${t?.id}` })
        await logActivity(c, { lead_id: lead.id, contact_id: contact?.id, type: 'task', body: `Automation "${auto.name}": ${title}` })
      } else if (step.action === 'notify_owner') {
        const title = renderTemplate(step.subject, vars) || `Follow up on ${lead.title}`
        if (lead.owner_id) await notify({ module: 'crm', title, body: renderTemplate(step.body, vars), href: '/crm', userIds: [lead.owner_id], dedupeKey: `crm-auto-notify:${e.id}:${step.id}` })
        detail = lead.owner_id ? 'owner notified' : 'no owner'
        if (!lead.owner_id) runStatus = 'skipped'
      } else {
        runStatus = 'skipped'; detail = `unknown action ${step.action}`
      }

      // Log the run.
      await c.from('crm_automation_runs').insert({ enrolment_id: e.id, step_id: step.id, action: step.action, status: runStatus, detail })
      if (runStatus === 'sent') res.sent++; else if (runStatus === 'skipped') res.skipped++; else res.failed++

      // Advance to the next step (if any), else complete.
      const { data: nextRows } = await c.from('crm_automation_steps')
        .select('step_order, delay_hours').eq('automation_id', auto.id).gt('step_order', e.next_step_order)
        .order('step_order', { ascending: true }).limit(1)
      const next = nextRows && nextRows[0]
      if (next) {
        const nextRun = new Date(new Date(e.started_at).getTime() + Math.max(0, Number(next.delay_hours) || 0) * 3600 * 1000).toISOString()
        await c.from('crm_automation_enrolments').update({ next_step_order: next.step_order, next_run_at: nextRun, last_run_at: nowIso }).eq('id', e.id)
      } else {
        await c.from('crm_automation_enrolments').update({ status: 'done', last_run_at: nowIso }).eq('id', e.id)
        res.completed++
      }
    } catch (err: any) {
      console.error('automation enrolment run failed:', err?.message || err)
      res.failed++
    }
  }
  return res
}
