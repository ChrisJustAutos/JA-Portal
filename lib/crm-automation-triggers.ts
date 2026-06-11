// lib/crm-automation-triggers.ts
// SERVER-ONLY. enrolFromEvent — the single entry point every cross-module
// trigger fires through: tag added, quote accepted/declined, booking created,
// campaign email opened/clicked, inbound webhook. (lead_created/stage_changed
// keep going through enrolLead directly — they're lead-native.)
//
// Resolution: a lead-level event enrols its lead; a contact-level event
// enrols the contact's newest open lead, else a CONTACT-ONLY enrolment
// (lead_id NULL) — lead-dependent actions then log 'skipped'. Dedupe keys
// stop the same real-world event enrolling twice. Best-effort, never throws.

import type { SupabaseClient } from '@supabase/supabase-js'
import { entryNodeId, FlowGraph, linearStepsToGraph } from './crm-automation-graph'

export type CrmTriggerEvent =
  | 'tag_added' | 'quote_accepted' | 'quote_declined' | 'booking_created'
  | 'campaign_email_opened' | 'campaign_email_clicked' | 'webhook'

export interface TriggerPayload {
  contact_id?: string | null
  lead_id?: string | null
  tag?: string | null
  campaign_id?: string | null
  quote_id?: string | null
  booking_id?: string | null
  context?: any                    // webhook body etc. — stored on the enrolment
  dedupe_key?: string | null       // caller-supplied uniqueness for this event
  excludeAutomationId?: string | null  // no self-enrolment from automation-caused events
}

async function graphOf(c: SupabaseClient, a: any): Promise<FlowGraph | null> {
  if (a.graph && Array.isArray(a.graph.nodes)) return a.graph as FlowGraph
  const { data: steps } = await c.from('crm_automation_steps')
    .select('step_order, delay_hours, action, subject, body, task_priority')
    .eq('automation_id', a.id).order('step_order', { ascending: true })
  if (!steps || !steps.length) return null
  return linearStepsToGraph(a, steps as any[])
}

// Newest open lead for a contact (not deleted, not won/lost).
async function openLeadOf(c: SupabaseClient, contactId: string): Promise<{ id: string; stage: string } | null> {
  const { data } = await c.from('crm_leads')
    .select('id, stage').eq('contact_id', contactId).is('deleted_at', null).is('won_at', null).is('lost_at', null)
    .order('created_at', { ascending: false }).limit(1)
  return (data && data[0]) || null
}

export async function enrolFromEvent(db: SupabaseClient, event: CrmTriggerEvent, payload: TriggerPayload): Promise<number> {
  let enrolled = 0
  try {
    const { data: autos } = await db.from('crm_automations')
      .select('id, trigger_event, trigger_config, graph, graph_version')
      .eq('enabled', true).eq('trigger_event', event).is('deleted_at', null)
    if (!autos || !autos.length) return 0

    for (const a of autos as any[]) {
      if (payload.excludeAutomationId && a.id === payload.excludeAutomationId) continue
      const cfg = a.trigger_config || {}
      if (event === 'tag_added' && cfg.tag && String(cfg.tag).toLowerCase() !== String(payload.tag || '').toLowerCase()) continue
      if ((event === 'campaign_email_opened' || event === 'campaign_email_clicked') && cfg.campaign_id && cfg.campaign_id !== payload.campaign_id) continue

      const graph = await graphOf(db, a)
      if (!graph) continue
      const entry = entryNodeId(graph)
      if (!entry) continue

      // Resolve the enrolment target.
      let leadId = payload.lead_id || null
      let contactId = payload.contact_id || null
      if (!leadId && contactId) {
        const lead = await openLeadOf(db, contactId)
        if (lead) leadId = lead.id
      }
      if (!leadId && !contactId) continue
      if (leadId && !contactId) {
        const { data: l } = await db.from('crm_leads').select('contact_id').eq('id', leadId).maybeSingle()
        contactId = l?.contact_id || null
      }

      // Don't enrol do-not-contact contacts at all.
      if (contactId) {
        const { data: ct } = await db.from('crm_contacts').select('do_not_contact').eq('id', contactId).maybeSingle()
        if (ct?.do_not_contact) continue
      }

      const dedupe = payload.dedupe_key ? `${event}:${payload.dedupe_key}` : null
      const { error } = await db.from('crm_automation_enrolments').insert({
        automation_id: a.id,
        lead_id: leadId,
        contact_id: contactId,
        status: 'active',
        next_step_order: 1,
        next_run_at: new Date().toISOString(),
        current_node_id: entry,
        graph_version: a.graph_version || 1,
        context: payload.context ?? null,
        dedupe_key: dedupe,
      })
      if (!error) enrolled++
      else if (error.code !== '23505') console.error('enrolFromEvent insert failed:', error.message)
    }
  } catch (e: any) {
    console.error('enrolFromEvent failed (non-fatal):', e?.message || e)
  }
  return enrolled
}
