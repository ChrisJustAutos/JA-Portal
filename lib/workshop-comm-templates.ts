// lib/workshop-comm-templates.ts
// Editable customer communication templates (workshop_comm_templates). Shared
// renderer + helpers used by the reminder queue (lib/workshop-reminders.ts),
// the job-card "Text customer" prefill, and the settings manager.

import type { SupabaseClient } from '@supabase/supabase-js'

export type CommTrigger = 'booking_confirmation' | 'booking_reminder' | 'ready' | 'follow_up' | 'review_request' | 'payment_receipt' | 'quote_follow_up' | 'service_due' | 'rego_due'

export interface CommTemplate {
  id: string
  trigger: CommTrigger
  name: string
  channel: 'sms' | 'email'
  subject: string | null
  body: string
  enabled: boolean
  offset_value: number
  offset_unit: 'hours' | 'days'
  offset_dir: 'before' | 'after'
  job_types: string[]
  sort_order: number
}

export const COMM_TRIGGERS: { value: CommTrigger; label: string; anchor: string; dirFixed?: 'before' | 'after' }[] = [
  { value: 'booking_confirmation', label: 'Booking confirmation', anchor: 'when the booking is created', dirFixed: 'after' },
  { value: 'booking_reminder',     label: 'Booking reminder',     anchor: 'the booking start time' },
  { value: 'ready',                label: 'Ready for collection', anchor: 'sent manually from the job card', dirFixed: 'after' },
  { value: 'follow_up',            label: 'Service follow-up',    anchor: 'job completion', dirFixed: 'after' },
  { value: 'review_request',       label: 'Review request',       anchor: 'job completion', dirFixed: 'after' },
  { value: 'payment_receipt',      label: 'Payment receipt',      anchor: 'when a payment is taken', dirFixed: 'after' },
  { value: 'quote_follow_up',      label: 'Quote follow-up',      anchor: 'when a quote is sent', dirFixed: 'after' },
  { value: 'service_due',          label: 'Service due',          anchor: 'when due (within the lead window)', dirFixed: 'after' },
  { value: 'rego_due',             label: 'Registration due',     anchor: 'when due (within the lead window)', dirFixed: 'after' },
]

// {{var}} substitution; unknown vars become ''. Shared client + server.
export function renderTemplate(tpl: string | null | undefined, vars: Record<string, string>): string {
  return String(tpl || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k) => (vars[k] ?? ''))
}

// Available placeholders, surfaced in the editor.
export const COMM_VARS = ['first_name', 'customer_name', 'vehicle', 'rego', 'date', 'time', 'due_date', 'business_name', 'total', 'balance', 'amount', 'review_link']

// Signed milliseconds offset (negative = before the anchor).
export function offsetMs(t: Pick<CommTemplate, 'offset_value' | 'offset_unit' | 'offset_dir'>): number {
  const unit = t.offset_unit === 'hours' ? 3600_000 : 86400_000
  const mag = Math.max(0, Number(t.offset_value) || 0) * unit
  return t.offset_dir === 'before' ? -mag : mag
}

export function templateMatchesJobType(t: CommTemplate, jobType: string | null | undefined): boolean {
  if (!t.job_types || t.job_types.length === 0) return true   // empty = all
  return !!jobType && t.job_types.includes(jobType)
}

// Enabled templates for a trigger (server-side).
export async function enabledTemplates(db: SupabaseClient, trigger: CommTrigger): Promise<CommTemplate[]> {
  const { data } = await db.from('workshop_comm_templates')
    .select('*').eq('trigger', trigger).eq('enabled', true).order('sort_order', { ascending: true })
  return (data || []) as CommTemplate[]
}

// First enabled template for a trigger + channel (used by the manual prefill).
export async function firstTemplate(db: SupabaseClient, trigger: CommTrigger, channel: 'sms' | 'email' = 'sms'): Promise<CommTemplate | null> {
  const { data } = await db.from('workshop_comm_templates')
    .select('*').eq('trigger', trigger).eq('channel', channel).order('sort_order', { ascending: true }).limit(1)
  return (data && data[0]) as CommTemplate || null
}
