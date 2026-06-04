// lib/crm.ts
// Shared CRM types, pipeline definition and small server helpers used across
// the /api/crm routes. Pipeline stages mirror the Monday quote board the CRM
// replaces.

import type { SupabaseClient } from '@supabase/supabase-js'

// ── Pipeline ──────────────────────────────────────────────────────────
export const LEAD_STAGES = ['new', 'contacted', 'quoted', 'follow_up', 'won', 'lost', 'on_hold'] as const
export type LeadStage = typeof LEAD_STAGES[number]

export const LEAD_STAGE_LABELS: Record<LeadStage, string> = {
  new:       'New',
  contacted: 'Contacted',
  quoted:    'Quoted',
  follow_up: 'Follow-up',
  won:       'Won',
  lost:      'Lost',
  on_hold:   'On hold',
}

// Columns shown on the kanban, in order. (on_hold is reachable via the lead
// editor but kept off the board so it doesn't clutter the active pipeline.)
export const PIPELINE_COLUMNS: LeadStage[] = ['new', 'contacted', 'quoted', 'follow_up', 'won', 'lost']

export const TASK_STATUSES = ['open', 'in_progress', 'done'] as const
export type TaskStatus = typeof TASK_STATUSES[number]
export const TASK_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const
export type TaskPriority = typeof TASK_PRIORITIES[number]

export type ActivityType =
  | 'note' | 'call' | 'email' | 'sms' | 'stage_change'
  | 'lead_created' | 'contact_created' | 'task' | 'workshop_handoff' | 'website_lead'

// ── Helpers ───────────────────────────────────────────────────────────

// Last 9 digits — enough to match AU mobiles/landlines regardless of +61/0 prefix.
export function phoneKey(p: string | null | undefined): string | null {
  const digits = String(p || '').replace(/\D/g, '')
  if (digits.length < 6) return null
  return digits.slice(-9)
}

export function contactDisplayName(c: { name?: string | null; first_name?: string | null; last_name?: string | null; email?: string | null; phone?: string | null; mobile?: string | null }): string {
  if (c.name && c.name.trim()) return c.name.trim()
  const fl = [c.first_name, c.last_name].filter(Boolean).join(' ').trim()
  if (fl) return fl
  return c.email || c.mobile || c.phone || 'Unknown contact'
}

// Insert a timeline row and bump the parent contact/lead last_activity_at.
// Best-effort: never throws (timeline is auxiliary to the mutation that calls it).
export async function logActivity(
  db: SupabaseClient,
  a: { contact_id?: string | null; lead_id?: string | null; type: ActivityType; body?: string | null; meta?: any; actor_id?: string | null },
): Promise<void> {
  try {
    await db.from('crm_activities').insert({
      contact_id: a.contact_id || null,
      lead_id: a.lead_id || null,
      type: a.type,
      body: a.body || null,
      meta: a.meta ?? null,
      actor_id: a.actor_id || null,
    })
    const now = new Date().toISOString()
    if (a.contact_id) await db.from('crm_contacts').update({ last_activity_at: now }).eq('id', a.contact_id)
    if (a.lead_id) await db.from('crm_leads').update({ last_activity_at: now }).eq('id', a.lead_id)
  } catch (e: any) {
    console.error('crm logActivity failed (non-fatal):', e?.message || e)
  }
}

// Find an existing contact by email (case-insensitive) or phone/mobile (last-9
// match), among non-deleted rows. Returns the contact id or null.
export async function findContact(
  db: SupabaseClient,
  { email, phone, mobile }: { email?: string | null; phone?: string | null; mobile?: string | null },
): Promise<string | null> {
  const e = (email || '').trim().toLowerCase()
  if (e) {
    const { data } = await db.from('crm_contacts')
      .select('id').is('deleted_at', null).ilike('email', e).limit(1)
    if (data && data.length) return data[0].id
  }
  const keys = [phoneKey(phone), phoneKey(mobile)].filter(Boolean) as string[]
  for (const k of keys) {
    const { data } = await db.from('crm_contacts')
      .select('id, phone, mobile').is('deleted_at', null)
      .or(`phone.ilike.%${k},mobile.ilike.%${k}`).limit(1)
    if (data && data.length) return data[0].id
  }
  return null
}
