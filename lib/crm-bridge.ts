// lib/crm-bridge.ts
// SERVER-ONLY. Workshop → CRM bridge: when a workshop quote changes status,
// converts to a booking, or its total moves, reflect it on the linked CRM
// lead/contact — timeline activity, configurable stage move (crm_settings.
// quote_stage_map) and value sync. Best-effort: never throws into the
// workshop mutation that calls it. One-directional by design (the CRM never
// writes quote-side from here), so no sync loop is possible.

import type { SupabaseClient } from '@supabase/supabase-js'
import { logActivity, getCrmSettings } from './crm'
import { setLeadStage } from './crm-server'

const money = (n: number | null | undefined) =>
  n != null ? `$${Number(n).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : null

// Lead linked to the quote (crm_leads.workshop_quote_id), else the newest
// open-ish lead of the contact mapped via workshop_customer_id; the contact
// alone if no lead. Everything optional — CRM linkage may simply not exist.
async function findCrmTarget(db: SupabaseClient, quote: { id: string; customer_id: string | null }): Promise<{ leadId: string | null; contactId: string | null }> {
  const { data: lead } = await db.from('crm_leads')
    .select('id, contact_id').eq('workshop_quote_id', quote.id).is('deleted_at', null).maybeSingle()
  if (lead) return { leadId: lead.id, contactId: lead.contact_id }
  if (!quote.customer_id) return { leadId: null, contactId: null }
  const { data: contact } = await db.from('crm_contacts')
    .select('id').eq('workshop_customer_id', quote.customer_id).is('deleted_at', null).maybeSingle()
  if (!contact) return { leadId: null, contactId: null }
  const { data: openLead } = await db.from('crm_leads')
    .select('id').eq('contact_id', contact.id).is('deleted_at', null).is('won_at', null).is('lost_at', null)
    .order('created_at', { ascending: false }).limit(1).maybeSingle()
  return { leadId: openLead?.id || null, contactId: contact.id }
}

export async function onQuoteStatusChanged(
  db: SupabaseClient,
  quote: { id: string; customer_id: string | null; total?: number | null },
  from: string | null,
  to: string,
  actorId: string | null,
): Promise<void> {
  try {
    const { leadId, contactId } = await findCrmTarget(db, quote)
    if (!leadId && !contactId) return
    await logActivity(db, {
      lead_id: leadId, contact_id: contactId, type: 'quote_status',
      body: `Quote ${from || '?'} → ${to}${quote.total ? ` (${money(quote.total)})` : ''}`,
      meta: { quote_id: quote.id, from, to, total: quote.total ?? null }, actor_id: actorId,
    })
    if (leadId) {
      const settings = await getCrmSettings(db)
      const targetStage = settings.quote_stage_map[to]
      if (targetStage) await setLeadStage(db, leadId, targetStage, actorId)
    }
  } catch (e: any) {
    console.error('crm-bridge onQuoteStatusChanged failed (non-fatal):', e?.message || e)
  }
}

export async function onQuoteConverted(
  db: SupabaseClient,
  quote: { id: string; customer_id: string | null; total?: number | null },
  bookingId: string,
  startsAt: string,
  actorId: string | null,
): Promise<void> {
  try {
    const { leadId, contactId } = await findCrmTarget(db, quote)
    if (!leadId && !contactId) return
    await logActivity(db, {
      lead_id: leadId, contact_id: contactId, type: 'booking_created',
      body: `Booked into the workshop — ${new Date(startsAt).toLocaleString('en-AU', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Australia/Brisbane' })}`,
      meta: { quote_id: quote.id, booking_id: bookingId, starts_at: startsAt }, actor_id: actorId,
    })
    if (leadId) {
      const settings = await getCrmSettings(db)
      const targetStage = settings.quote_stage_map['converted']
      if (targetStage) await setLeadStage(db, leadId, targetStage, actorId)
    }
  } catch (e: any) {
    console.error('crm-bridge onQuoteConverted failed (non-fatal):', e?.message || e)
  }
}

// Keep the lead's value tracking the quote total (crm_settings.sync_lead_value).
export async function onQuoteTotalChanged(db: SupabaseClient, quoteId: string, total: number): Promise<void> {
  try {
    const settings = await getCrmSettings(db)
    if (!settings.sync_lead_value) return
    await db.from('crm_leads').update({ value: total }).eq('workshop_quote_id', quoteId).is('deleted_at', null)
  } catch (e: any) {
    console.error('crm-bridge onQuoteTotalChanged failed (non-fatal):', e?.message || e)
  }
}
