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
import { selectAllRows } from './supabase-paged'

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
    // PAGED, not `.limit(3000)`: PostgREST silently caps responses at 1000
    // rows whatever the limit says. The read has no upper bound, so a custom
    // range in Reports → Sales Report (up to ~3 months, plus the 5-day lead-in)
    // pulls everything from that date to now — already ~2.6k rows at the
    // current ~190 leads/week, and the store only grows. Ordered ascending,
    // truncation would drop the NEWEST leads, so the selected range could come
    // back empty exactly the way the quotes map report did. Paging on
    // monday_item_id (unique index srol_item_uq); assembleRecap re-sorts by
    // createdAt, so the page order doesn't matter. See lib/supabase-paged.ts.
    const rows = await selectAllRows<any>(() => sb().from('sales_recap_overnight_leads')
      .select('monday_item_id, board_id, channel, name, phone, lead_created_at')
      .gte('lead_created_at', new Date(sinceMs).toISOString()), 'monday_item_id')
    return rows.map(r => ({
      itemId: String(r.monday_item_id), boardId: r.board_id || '', channel: r.channel,
      name: r.name, phone: r.phone, createdAt: r.lead_created_at,
    }))
  } catch (e: any) {
    console.error('[overnight-leads] store read failed, using live pull:', e?.message || e)
    return live.filter(l => Date.parse(l.createdAt) >= sinceMs)
  }
}
