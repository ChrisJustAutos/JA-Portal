// lib/sales-recap-leads-store.ts
//
// Durable store behind the Sales Report's Overnight Leads panel
// (sales_recap_overnight_leads, migration 164). The live Monday pull counts
// only items CURRENTLY in the "Quote - Lead" group — staff move leads to
// Pending/Follow Up as they quote them, so re-pulling a past date range
// shrinks over time. Every snapshot upserts what's visible right now
// (first-seen wins); the report reads the stored rows, so historical ranges
// keep the counts as they were the night the leads arrived.
//
// Snapshots run half-hourly (pages/api/cron/overnight-leads-snapshot) and on
// every report render. History accumulates from ship date (2026-07-16)
// forward — ranges before that only have whatever is still in Quote - Lead.

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { fetchQuoteLeads, type QuoteLeadRow } from './sales-recap-monday'

// Live-pull lookback per snapshot: long enough that a lead can't slip
// between snapshots (leads sit in Quote - Lead at least overnight; a whole
// weekend is < 3 days).
const SNAPSHOT_LOOKBACK_MS = 3 * 86400_000

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  _sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  return _sb
}

// Upsert the leads currently visible in "Quote - Lead" (last 3 days).
// Returns the live rows so callers can fall back to them if the DB read
// fails. ignoreDuplicates keeps the FIRST-seen record — later renames or
// group moves never rewrite arrival facts.
export async function snapshotQuoteLeads(token: string): Promise<{ live: QuoteLeadRow[]; seen: number }> {
  const live = await fetchQuoteLeads(token, Date.now() - SNAPSHOT_LOOKBACK_MS)
  if (live.length) {
    const payload = live.map(l => ({
      monday_item_id: l.itemId, board_id: l.boardId, channel: l.channel,
      name: l.name, phone: l.phone, lead_created_at: l.createdAt,
    }))
    const { error } = await sb().from('sales_recap_overnight_leads')
      .upsert(payload, { onConflict: 'monday_item_id', ignoreDuplicates: true })
    if (error) throw new Error(`overnight-leads upsert: ${error.message}`)
  }
  return { live, seen: live.length }
}

// The report's lead source: snapshot first (so the current morning is fresh),
// then read everything stored since `sinceMs`. Falls back to the live rows
// when the store is unreachable — the panel then behaves like the pre-store
// live pull rather than disappearing.
export async function captureAndLoadQuoteLeads(token: string, sinceMs: number): Promise<QuoteLeadRow[]> {
  let live: QuoteLeadRow[] = []
  try {
    live = (await snapshotQuoteLeads(token)).live
  } catch (e: any) {
    console.error('[overnight-leads] snapshot failed:', e?.message || e)
  }
  try {
    const { data, error } = await sb().from('sales_recap_overnight_leads')
      .select('monday_item_id, board_id, channel, name, phone, lead_created_at')
      .gte('lead_created_at', new Date(sinceMs).toISOString())
      .order('lead_created_at', { ascending: true })
      .limit(3000)
    if (error) throw new Error(error.message)
    return (data || []).map(r => ({
      itemId: String(r.monday_item_id), boardId: r.board_id || '', channel: r.channel,
      name: r.name, phone: r.phone, createdAt: r.lead_created_at,
    }))
  } catch (e: any) {
    console.error('[overnight-leads] store read failed, using live pull:', e?.message || e)
    return live.filter(l => Date.parse(l.createdAt) >= sinceMs)
  }
}
