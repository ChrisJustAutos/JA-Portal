// lib/crm-campaigns.ts
// SERVER-ONLY. CRM campaign engine: resolve an audience from a segment, render
// + personalise each email with open/click tracking and an unsubscribe footer,
// and send in batches via Resend. Driven by /api/cron/crm-campaigns (promotes
// scheduled campaigns + drains the send queue) and by the "send now" API route.

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { contactDisplayName } from './crm'

export function campaignSvc(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  return createClient(url, key, { auth: { persistSession: false } })
}

export function appBaseUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL || process.env.APP_BASE_URL || 'https://justautos.app').replace(/\/+$/, '')
}
function campaignFromAddress(): string {
  return (process.env.RESEND_CAMPAIGN_FROM || process.env.RESEND_FROM || 'Just Autos <noreply@mail.justautos.app>').trim()
}

export interface SegmentDef {
  tags_any?: string[]; sources?: string[]; owner_ids?: string[]
  created_after?: string; created_before?: string; search?: string
}
export interface AudienceContact { id: string; name: string; first_name: string | null; last_name: string | null; email: string | null; company_name: string | null }

// Mailable contacts matching a segment (or all). Always excludes do_not_contact,
// marketing_opt_out and missing emails, and de-dupes by email.
export async function buildAudience(db: SupabaseClient, def: SegmentDef | null, audienceAll: boolean): Promise<AudienceContact[]> {
  let q = db.from('crm_contacts')
    .select('id, name, first_name, last_name, email, company_name, tags, source, owner_id, created_at')
    .is('deleted_at', null).eq('do_not_contact', false).eq('marketing_opt_out', false)
    .not('email', 'is', null)
  if (!audienceAll && def) {
    if (def.tags_any?.length) q = q.overlaps('tags', def.tags_any)
    if (def.sources?.length) q = q.in('source', def.sources)
    if (def.owner_ids?.length) q = q.in('owner_id', def.owner_ids)
    if (def.created_after) q = q.gte('created_at', def.created_after)
    if (def.created_before) q = q.lte('created_at', def.created_before)
    if (def.search) {
      const s = String(def.search).replace(/[%,()*]/g, ' ').trim()
      if (s) q = q.or(`name.ilike.%${s}%,email.ilike.%${s}%,company_name.ilike.%${s}%`)
    }
  }
  const { data } = await q.limit(10000)
  const seen = new Set<string>(); const out: AudienceContact[] = []
  for (const c of (data || []) as any[]) {
    const e = String(c.email || '').trim().toLowerCase()
    if (!e || seen.has(e)) continue
    seen.add(e)
    out.push({ id: c.id, name: c.name, first_name: c.first_name, last_name: c.last_name, email: c.email, company_name: c.company_name })
  }
  return out
}

// ── Rendering ─────────────────────────────────────────────────────────
function escapeHtml(s: string): string { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') }

function contactVars(c: AudienceContact): Record<string, string> {
  const name = contactDisplayName(c)
  return { first_name: (c.first_name || name.split(' ')[0] || 'there').trim(), contact_name: name, company: c.company_name || '' }
}
function fill(tpl: string, vars: Record<string, string>): string {
  return String(tpl || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k) => vars[k] ?? '')
}

// Personalise a single template string (e.g. a subject line) for a contact.
export function personalize(tpl: string, c: AudienceContact): string { return fill(tpl, contactVars(c)) }

// Build the final HTML for one recipient: personalise, wrap text as HTML if it
// isn't already, rewrite links for click tracking, add the open pixel + footer.
export function renderCampaignHtml(campaign: any, c: AudienceContact, token: string): string {
  const base = appBaseUrl()
  const vars = contactVars(c)
  let body = fill(campaign.body || '', vars)
  const looksHtml = /<\w+[\s>]/.test(body)
  if (!looksHtml) {
    body = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#222;line-height:1.55">${escapeHtml(body).replace(/\n/g, '<br>')}</div>`
  }
  // Click tracking: wrap absolute http(s) links (skip our own tracking/unsub).
  body = body.replace(/href="(https?:\/\/[^"]+)"/gi, (m, url) => {
    if (url.includes('/api/crm/track/') || url.includes('/api/crm/unsubscribe')) return m
    return `href="${base}/api/crm/track/c?t=${token}&u=${encodeURIComponent(Buffer.from(url).toString('base64'))}"`
  })
  const pixel = `<img src="${base}/api/crm/track/o?t=${token}" width="1" height="1" alt="" style="display:none">`
  const unsub = `${base}/api/crm/unsubscribe?t=${token}`
  const footer = `<div style="margin-top:28px;padding-top:14px;border-top:1px solid #e3e3e3;font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#999;line-height:1.5">`
    + `Just Autos · You're receiving this because you're a Just Autos contact.<br>`
    + `<a href="${unsub}" style="color:#999">Unsubscribe from marketing emails</a></div>`
  return `<div>${body}${footer}${pixel}</div>`
}

// ── Materialise recipients ────────────────────────────────────────────
// Resolve the audience and create one pending recipient row per contact.
// Idempotent: skips if recipients already exist for the campaign.
export async function materializeRecipients(db: SupabaseClient, campaign: any): Promise<number> {
  const { count } = await db.from('crm_campaign_recipients').select('id', { count: 'exact', head: true }).eq('campaign_id', campaign.id)
  if ((count || 0) > 0) return count || 0
  let def: SegmentDef | null = null
  if (campaign.segment_id) {
    const { data: seg } = await db.from('crm_segments').select('definition').eq('id', campaign.segment_id).single()
    def = (seg?.definition as SegmentDef) || {}
  }
  const audience = await buildAudience(db, def, !!campaign.audience_all)
  if (audience.length) {
    const rows = audience.map(c => ({ campaign_id: campaign.id, contact_id: c.id, email: c.email }))
    // Chunk inserts to keep payloads sane.
    for (let i = 0; i < rows.length; i += 500) {
      await db.from('crm_campaign_recipients').upsert(rows.slice(i, i + 500), { onConflict: 'campaign_id,contact_id', ignoreDuplicates: true })
    }
  }
  await db.from('crm_campaigns').update({ total_recipients: audience.length }).eq('id', campaign.id)
  return audience.length
}

// ── Sending ───────────────────────────────────────────────────────────
async function resendBatch(items: any[]): Promise<{ ids: (string | null)[]; error?: string }> {
  const key = (process.env.RESEND_API_KEY || '').trim()
  if (!key) return { ids: items.map(() => null), error: 'resend_not_configured' }
  try {
    const r = await fetch('https://api.resend.com/emails/batch', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(items),
    })
    const data: any = await r.json().catch(() => ({}))
    if (!r.ok) return { ids: items.map(() => null), error: `resend ${r.status}: ${JSON.stringify(data).slice(0, 200)}` }
    const arr = Array.isArray(data?.data) ? data.data : []
    return { ids: items.map((_, i) => arr[i]?.id || null) }
  } catch (e: any) { return { ids: items.map(() => null), error: e?.message || 'send_error' } }
}

// Send up to `limit` pending recipients for one campaign. Marks the campaign
// 'sent' when its queue is empty. Returns how many were sent/failed.
export async function sendCampaignBatch(db: SupabaseClient, campaign: any, limit = 100): Promise<{ sent: number; failed: number; done: boolean }> {
  const { data: pending } = await db.from('crm_campaign_recipients')
    .select('id, contact_id, email, token').eq('campaign_id', campaign.id).eq('status', 'pending')
    .order('created_at', { ascending: true }).limit(limit)
  if (!pending || pending.length === 0) {
    await db.from('crm_campaigns').update({ status: 'sent', sent_at: new Date().toISOString() }).eq('id', campaign.id).eq('status', 'sending')
    return { sent: 0, failed: 0, done: true }
  }

  const from = campaign.from_name ? `${campaign.from_name} <${campaignFromAddress().replace(/^.*<|>.*$/g, '')}>` : campaignFromAddress()
  const replyTo = campaign.reply_to || (process.env.RESEND_REPLY_TO || '').trim() || undefined
  const base = appBaseUrl()

  // Build a contact lookup for personalisation.
  const ids = pending.map((p: any) => p.contact_id).filter(Boolean)
  const { data: contacts } = ids.length
    ? await db.from('crm_contacts').select('id, name, first_name, last_name, email, company_name').in('id', ids)
    : { data: [] as any[] }
  const cById = new Map<string, any>((contacts || []).map((c: any) => [c.id, c]))

  const items = pending.map((p: any) => {
    const c = cById.get(p.contact_id) || { id: p.contact_id, name: p.email, first_name: null, last_name: null, email: p.email, company_name: null }
    const vars = contactVars(c)
    return {
      from,
      to: [p.email],
      subject: fill(campaign.subject || '(no subject)', vars),
      html: renderCampaignHtml(campaign, c, p.token),
      ...(replyTo ? { reply_to: replyTo } : {}),
      headers: { 'List-Unsubscribe': `<${base}/api/crm/unsubscribe?t=${p.token}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
    }
  })

  const { ids: providerIds, error } = await resendBatch(items)
  let sent = 0, failed = 0
  const nowIso = new Date().toISOString()
  for (let i = 0; i < pending.length; i++) {
    const pid = providerIds[i]
    if (pid) {
      await db.from('crm_campaign_recipients').update({ status: 'sent', provider_id: pid, sent_at: nowIso }).eq('id', pending[i].id)
      sent++
    } else {
      await db.from('crm_campaign_recipients').update({ status: 'failed', error: (error || 'send failed').slice(0, 300) }).eq('id', pending[i].id)
      failed++
    }
  }
  // Bump cached counters.
  const { data: cur } = await db.from('crm_campaigns').select('sent_count, fail_count').eq('id', campaign.id).single()
  await db.from('crm_campaigns').update({ sent_count: (cur?.sent_count || 0) + sent, fail_count: (cur?.fail_count || 0) + failed }).eq('id', campaign.id)

  // Anything left?
  const { count: remaining } = await db.from('crm_campaign_recipients').select('id', { count: 'exact', head: true }).eq('campaign_id', campaign.id).eq('status', 'pending')
  const done = (remaining || 0) === 0
  if (done) await db.from('crm_campaigns').update({ status: 'sent', sent_at: nowIso }).eq('id', campaign.id).eq('status', 'sending')
  return { sent, failed, done }
}

// ── Cron worker ───────────────────────────────────────────────────────
export interface CampaignSweep { promoted: number; sent: number; failed: number }
export async function processCampaigns(perCampaign = 100): Promise<CampaignSweep> {
  const db = campaignSvc()
  const res: CampaignSweep = { promoted: 0, sent: 0, failed: 0 }
  const nowIso = new Date().toISOString()

  // 1. Promote scheduled campaigns whose time has come.
  const { data: due } = await db.from('crm_campaigns')
    .select('*').eq('status', 'scheduled').is('deleted_at', null).lte('scheduled_at', nowIso).limit(10)
  for (const camp of due || []) {
    await materializeRecipients(db, camp)
    await db.from('crm_campaigns').update({ status: 'sending' }).eq('id', camp.id).eq('status', 'scheduled')
    res.promoted++
  }

  // 2. Drain sending campaigns (one batch each per tick).
  const { data: sending } = await db.from('crm_campaigns')
    .select('*').eq('status', 'sending').is('deleted_at', null).limit(5)
  for (const camp of sending || []) {
    const r = await sendCampaignBatch(db, camp, perCampaign)
    res.sent += r.sent; res.failed += r.failed
  }
  return res
}
