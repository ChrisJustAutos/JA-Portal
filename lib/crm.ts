// lib/crm.ts
// Shared CRM types, pipeline definition and small server helpers used across
// the /api/crm routes. Pipeline stages mirror the Monday quote board the CRM
// replaces.

import type { SupabaseClient } from '@supabase/supabase-js'

// ── Pipeline ──────────────────────────────────────────────────────────
// Stages live in crm_pipeline_stages (migration 097) and are editable in the
// CRM's stage editor. `key` is the immutable slug stored in crm_leads.stage.
// The constants below are the pre-097 fixed pipeline, kept ONLY as a fallback
// for when the stages table can't be read — use getPipelineStages().
export const LEAD_STAGES = ['new', 'contacted', 'quoted', 'follow_up', 'won', 'lost', 'on_hold'] as const
export type LeadStage = string

export interface PipelineStage {
  id: string
  key: string
  label: string
  color: string
  sort_order: number
  on_board: boolean
  is_won: boolean
  is_lost: boolean
  archived_at: string | null
}

const FALLBACK_STAGES: PipelineStage[] = [
  { id: 'new', key: 'new', label: 'New', color: '#4f8ef7', sort_order: 1, on_board: true, is_won: false, is_lost: false, archived_at: null },
  { id: 'contacted', key: 'contacted', label: 'Contacted', color: '#2dd4bf', sort_order: 2, on_board: true, is_won: false, is_lost: false, archived_at: null },
  { id: 'quoted', key: 'quoted', label: 'Quoted', color: '#a78bfa', sort_order: 3, on_board: true, is_won: false, is_lost: false, archived_at: null },
  { id: 'follow_up', key: 'follow_up', label: 'Follow-up', color: '#fbbf24', sort_order: 4, on_board: true, is_won: false, is_lost: false, archived_at: null },
  { id: 'won', key: 'won', label: 'Won', color: '#34c77b', sort_order: 5, on_board: true, is_won: true, is_lost: false, archived_at: null },
  { id: 'lost', key: 'lost', label: 'Lost', color: '#f04e4e', sort_order: 6, on_board: true, is_won: false, is_lost: true, archived_at: null },
  { id: 'on_hold', key: 'on_hold', label: 'On hold', color: '#8b90a0', sort_order: 7, on_board: false, is_won: false, is_lost: false, archived_at: null },
]

// Server-side stage list with a short module-level cache (Vercel instances are
// short-lived; worst case a 30s-stale read after an edit).
let _stagesCache: { at: number; stages: PipelineStage[] } | null = null
export async function getPipelineStages(db: SupabaseClient, opts?: { fresh?: boolean }): Promise<PipelineStage[]> {
  if (!opts?.fresh && _stagesCache && Date.now() - _stagesCache.at < 30_000) return _stagesCache.stages
  const { data, error } = await db.from('crm_pipeline_stages')
    .select('*').order('sort_order', { ascending: true })
  if (error || !data || data.length === 0) return _stagesCache?.stages || FALLBACK_STAGES
  _stagesCache = { at: Date.now(), stages: data as PipelineStage[] }
  return _stagesCache.stages
}
export function invalidateStagesCache() { _stagesCache = null }

export interface CrmSettings {
  quote_stage_map: Record<string, string>   // workshop quote status → stage key ('' = don't move)
  sync_lead_value: boolean
}
export async function getCrmSettings(db: SupabaseClient): Promise<CrmSettings> {
  const { data } = await db.from('crm_settings').select('*').eq('id', 'singleton').maybeSingle()
  return {
    quote_stage_map: (data?.quote_stage_map as Record<string, string>) ?? { sent: 'quoted', accepted: 'won', declined: 'lost', converted: 'won' },
    sync_lead_value: data?.sync_lead_value ?? true,
  }
}

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
  // Lazy import avoids a circular dependency (crm-automations imports crm.ts).
  const { enrolLead } = await import('./crm-automations')
  await enrolLead({ id: leadId, stage: stageKey, contact_id: before.contact_id }, 'stage_changed', db)
  return { ok: true }
}

export const TASK_STATUSES = ['open', 'in_progress', 'done'] as const
export type TaskStatus = typeof TASK_STATUSES[number]
export const TASK_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const
export type TaskPriority = typeof TASK_PRIORITIES[number]

export type ActivityType =
  | 'note' | 'call' | 'email' | 'sms' | 'stage_change'
  | 'lead_created' | 'contact_created' | 'task' | 'workshop_handoff' | 'website_lead'
  | 'quote_status' | 'booking_created'

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
