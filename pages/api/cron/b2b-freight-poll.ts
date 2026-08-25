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

const POLL_INTERVAL_MIN = 25  // skip rows polled within the last N min
const DEFAULT_BATCH     = 25

// Orders parked as consignment_missing used to be excluded forever, because
// nothing could ever un-stick them. refreshOrderFreight can now re-resolve a
// consignment by its carrier tracking number when it was deleted and
// re-created in MachShip, so they get a second chance — but slowly, so a
// genuinely dead consignment isn't re-asked every 30 minutes for months.
const RETRY_MISSING_HOURS = 6
const RETRY_MISSING_BATCH = 5

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

  const sinceIso = new Date(Date.now() - POLL_INTERVAL_MIN * 60_000).toISOString()
  const { data: orders, error } = await c
    .from('b2b_orders')
    .select('id, last_freight_poll_at')
    .not('machship_consignment_id', 'is', null)
    .not('status', 'in', '(delivered,cancelled,refunded)')
    // consignment_missing = the consignment 404s in MachShip (deleted /
    // re-created upstream) — no status will ever come back, stop asking.
    .or('freight_status.is.null,freight_status.neq.consignment_missing')
    .or(`last_freight_poll_at.is.null,last_freight_poll_at.lt.${sinceIso}`)
    .order('last_freight_poll_at', { ascending: true, nullsFirst: true })
    .limit(limit)

  if (error) return res.status(500).json({ ok: false, error: error.message })

  // Second, slower pass: parked consignments, in case the shipment is alive in
  // MachShip under a new id. Kept to its own small batch so a backlog of dead
  // ones can never crowd out the live orders above.
  const retryIso = new Date(Date.now() - RETRY_MISSING_HOURS * 3_600_000).toISOString()
  const { data: parked } = await c
    .from('b2b_orders')
    .select('id')
    .not('machship_consignment_id', 'is', null)
    .not('status', 'in', '(delivered,cancelled,refunded)')
    .eq('freight_status', 'consignment_missing')
    .or(`last_freight_poll_at.is.null,last_freight_poll_at.lt.${retryIso}`)
    .order('last_freight_poll_at', { ascending: true, nullsFirst: true })
    .limit(RETRY_MISSING_BATCH)

  const ids = Array.from(new Set([
    ...(orders || []).map((o: any) => o.id as string),
    ...(parked || []).map((o: any) => o.id as string),
  ]))
  if (ids.length === 0) {
    return res.status(200).json({ ok: true, scanned: 0, refreshed: 0, errors: 0 })
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
  })
}
