// lib/workshop-activity.ts
// SERVER-ONLY. Best-effort writer for the workshop activity log
// (workshop_activity). Never throws into its caller — the audit entry must not
// break the mutation that produced it.

import type { SupabaseClient } from '@supabase/supabase-js'

export interface WorkshopActivityInput {
  action: string                 // created | updated | deleted | split | converted | payment | status
  entity: string                 // booking | quote | customer | vehicle | inventory | invoice | payment
  entity_id?: string | null
  entity_label?: string | null
  detail?: string | null
  actor_id?: string | null
  actor_name?: string | null
}

export async function logWorkshopActivity(db: SupabaseClient, a: WorkshopActivityInput): Promise<void> {
  try {
    await db.from('workshop_activity').insert({
      action: a.action,
      entity: a.entity,
      entity_id: a.entity_id || null,
      entity_label: a.entity_label ? String(a.entity_label).slice(0, 200) : null,
      detail: a.detail ? String(a.detail).slice(0, 500) : null,
      actor_id: a.actor_id || null,
      actor_name: a.actor_name ? String(a.actor_name).slice(0, 120) : null,
    })
  } catch (e: any) {
    console.error('logWorkshopActivity failed (non-fatal):', e?.message || e)
  }
}
