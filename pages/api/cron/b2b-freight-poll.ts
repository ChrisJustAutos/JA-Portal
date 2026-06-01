// pages/api/cron/b2b-freight-poll.ts
//
// Polls MachShip for status + ETA updates on in-flight B2B orders.
// Runs every 30 min (see vercel.json). Picks orders that:
//   - have machship_consignment_id set (i.e. booked via the live path)
//   - are NOT in a terminal state (delivered/cancelled/refunded)
//   - haven't been polled in the last 25 minutes (small jitter window so
//     overlapping invocations don't both refresh the same row)
//
// Each order is refreshed via the shared refreshOrderFreight() helper
// so the cron path stays in lockstep with the admin "Refresh from
// MachShip" button.
//
// Auth: Bearer CRON_SECRET, with the vercel-cron user-agent fallback —
// same pattern as the other crons.
//
// Manual invocation:
//   curl -H "Authorization: Bearer $CRON_SECRET" https://<host>/api/cron/b2b-freight-poll
//   curl -H "Authorization: Bearer $CRON_SECRET" https://<host>/api/cron/b2b-freight-poll?limit=5

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { refreshOrderFreight } from '../../../lib/b2b-machship-refresh'
import { bookFreightForOrder } from '../../../lib/b2b-freight-book'

const POLL_INTERVAL_MIN = 25  // skip rows polled within the last N min
const DEFAULT_BATCH     = 25

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const cronSecret = process.env.CRON_SECRET
  const authHeader = req.headers.authorization || ''
  const userAgent = String(req.headers['user-agent'] || '').toLowerCase()
  const authorized = cronSecret
    ? authHeader === `Bearer ${cronSecret}`
    : userAgent.includes('vercel-cron')
  if (!authorized) return res.status(401).json({ error: 'Unauthorised' })

  const limit = Math.max(1, Math.min(parseInt(String(req.query.limit || ''), 10) || DEFAULT_BATCH, 200))
  const c = sb()

  // ── "Book later" sweep: book any order whose scheduled time has passed and
  // that hasn't been booked yet. Clears the schedule regardless of outcome so a
  // persistent failure doesn't retry forever (the order stays visible in admin).
  let scheduledBooked = 0, scheduledFailed = 0
  const nowIso = new Date().toISOString()
  const { data: dueRows } = await c
    .from('b2b_orders')
    .select('id')
    .not('freight_book_scheduled_at', 'is', null)
    .lte('freight_book_scheduled_at', nowIso)
    .is('machship_consignment_id', null)
    .not('machship_carrier_id', 'is', null)
    .limit(50)
  for (const row of (dueRows || []) as any[]) {
    try {
      const r = await bookFreightForOrder(row.id, { actorId: null })
      if (r.ok || r.alreadyBooked) scheduledBooked++
      else { scheduledFailed++; try { await c.from('b2b_order_events').insert({ order_id: row.id, event_type: 'freight_scheduled_book_failed', actor_type: 'system', actor_id: null, notes: (r.error || '').slice(0, 500) }) } catch {} }
    } catch (e: any) { scheduledFailed++; console.error(`scheduled book failed for ${row.id}:`, e?.message || e) }
    await c.from('b2b_orders').update({ freight_book_scheduled_at: null }).eq('id', row.id)
  }

  const sinceIso = new Date(Date.now() - POLL_INTERVAL_MIN * 60_000).toISOString()
  const { data: orders, error } = await c
    .from('b2b_orders')
    .select('id, last_freight_poll_at')
    .not('machship_consignment_id', 'is', null)
    .not('status', 'in', '(delivered,cancelled,refunded)')
    .or(`last_freight_poll_at.is.null,last_freight_poll_at.lt.${sinceIso}`)
    .order('last_freight_poll_at', { ascending: true, nullsFirst: true })
    .limit(limit)

  if (error) return res.status(500).json({ ok: false, error: error.message })

  const ids = (orders || []).map((o: any) => o.id as string)
  if (ids.length === 0) {
    return res.status(200).json({ ok: true, scanned: 0, refreshed: 0, errors: 0, scheduled_booked: scheduledBooked, scheduled_failed: scheduledFailed })
  }

  let refreshed = 0
  let errors = 0
  const errorList: Array<{ id: string; error: string }> = []
  for (const id of ids) {
    const result = await refreshOrderFreight(c, id)
    if (result.ok) refreshed++
    else {
      errors++
      errorList.push({ id, error: result.error || 'unknown' })
    }
  }

  return res.status(200).json({
    ok: true,
    scanned:   ids.length,
    refreshed,
    errors,
    error_list: errorList,
    scheduled_booked: scheduledBooked,
    scheduled_failed: scheduledFailed,
  })
}
