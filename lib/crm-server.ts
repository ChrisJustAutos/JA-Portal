// lib/crm-server.ts
// SERVER-ONLY CRM mutations that client pages must never bundle (the
// automation engine drags in web-push / node built-ins). lib/crm.ts stays
// client-safe; API routes import from here.

import type { SupabaseClient } from '@supabase/supabase-js'
import { getPipelineStages, logActivity } from './crm'
import { enrolLead } from './crm-automations'

/**
 * Move a lead to a stage: validates the stage, stamps won_at/lost_at from the
 * stage flags, logs the stage_change activity and enrols matching automations.
 * The single path for ALL stage moves — the leads PATCH route and the
 * workshop→CRM bridge both call this so automations fire either way.
 */
export async function setLeadStage(
  db: SupabaseClient,
  leadId: string,
  stageKey: string,
  actorId: string | null,
): Promise<{ ok: boolean; error?: string }> {
  const stages = await getPipelineStages(db)
  const stage = stages.find(s => s.key === stageKey && !s.archived_at)
  if (!stage) return { ok: false, error: `Unknown stage "${stageKey}"` }
  const { data: before } = await db.from('crm_leads').select('id, stage, contact_id').eq('id', leadId).is('deleted_at', null).maybeSingle()
  if (!before) return { ok: false, error: 'Lead not found' }
  if (before.stage === stageKey) return { ok: true }

  const patch: any = { stage: stageKey }
  if (stage.is_won) { patch.won_at = new Date().toISOString(); patch.lost_at = null }
  else if (stage.is_lost) { patch.lost_at = new Date().toISOString(); patch.won_at = null }
  else { patch.won_at = null; patch.lost_at = null }
  const { error } = await db.from('crm_leads').update(patch).eq('id', leadId)
  if (error) return { ok: false, error: error.message }

  const fromLabel = stages.find(s => s.key === before.stage)?.label || before.stage
  await logActivity(db, {
    lead_id: leadId, contact_id: before.contact_id, type: 'stage_change',
    body: `${fromLabel} → ${stage.label}`,
    meta: { from: before.stage, to: stageKey }, actor_id: actorId,
  })
  await enrolLead({ id: leadId, stage: stageKey, contact_id: before.contact_id }, 'stage_changed', db)
  return { ok: true }
}
