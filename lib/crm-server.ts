// lib/crm-server.ts
// SERVER-ONLY CRM mutations that client pages must never bundle (the
// automation engine drags in web-push / node built-ins). lib/crm.ts stays
// client-safe; API routes import from here.

import type { SupabaseClient } from '@supabase/supabase-js'
import { applyLeadStage } from './crm'
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
  const r = await applyLeadStage(db, leadId, stageKey, actorId)
  if (!r.ok) return { ok: false, error: r.error }
  if (r.changed) {
    await enrolLead({ id: leadId, stage: stageKey, contact_id: r.contactId || null }, 'stage_changed', db)
  }
  return { ok: true }
}
