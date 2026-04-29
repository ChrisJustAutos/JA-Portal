// pages/api/cron/renew-graph-subscriptions.ts
// Renews Microsoft Graph subscriptions before they expire.
//
// Outlook message subscriptions max out at 4230 mins (~70.5 hrs). We
// initially subscribe at 4200 mins. This cron extends the expiration on
// any subscription within 24 hours of expiring.
//
// Schedule (set in vercel.json):
//   Every 6 hours. Plenty of slack — even if 2-3 cron runs are missed
//   in a row, we'd still renew before the 70-hour cap.
//
// Auth: Vercel cron jobs hit the endpoint with a CRON_SECRET header
// (configured in vercel.json). Vercel auto-injects it; we verify against
// process.env.CRON_SECRET. Optionally also accepts ?key= param so we can
// trigger manually for testing.
//
// Behaviour:
//   - Find all status='active' subscriptions in graph_subscriptions
//   - For each, if expiration is within 24 hrs, PATCH on Graph to extend
//   - Update graph_subscriptions row with new expiration + last_renewed_at
//   - On failure, log to last_renewal_error and increment status to
//     'failed' if expired (we'll need a separate process to recreate
//     failed subs — out of scope for this cron)

import type { NextApiRequest, NextApiResponse } from 'next'
import {
  listActiveSubscriptions,
  renewSubscription,
  updateSubscriptionRowAfterRenewal,
  markSubscriptionRenewalFailure,
} from '../../../lib/microsoft-graph'
import { createClient } from '@supabase/supabase-js'

export const config = {
  api: { bodyParser: false },
  maxDuration: 60,
}

// Renewal window: extend subs that expire within this many hours
const RENEWAL_WINDOW_HOURS = 24

interface RenewalResult {
  rowId: string
  mailbox: string
  subscriptionId: string
  status: 'renewed' | 'skipped' | 'failed' | 'expired'
  oldExpiration: string
  newExpiration?: string
  reason?: string
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // ── Auth: Vercel cron header OR manual ?key= ────────────────────────
  const cronSecret = process.env.CRON_SECRET
  const authHeader = req.headers.authorization || ''
  const queryKey = (req.query.key as string) || ''

  const fromVercelCron = cronSecret && authHeader === `Bearer ${cronSecret}`
  const manualTrigger = cronSecret && queryKey === cronSecret
  if (cronSecret && !fromVercelCron && !manualTrigger) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' })
  }

  const tStart = Date.now()
  const results: RenewalResult[] = []

  try {
    const subs = await listActiveSubscriptions()

    const now = Date.now()
    const renewalThreshold = now + RENEWAL_WINDOW_HOURS * 60 * 60 * 1000

    for (const sub of subs) {
      const expiry = new Date(sub.expiration_date_time).getTime()

      if (expiry < now) {
        // Already expired — nothing to renew. Mark as expired so it doesn't
        // keep showing up. A separate re-subscribe process needs to handle this.
        await markSubscriptionRenewalFailure(
          sub.id,
          `expired before renewal: expiration ${sub.expiration_date_time}`,
          'expired',
        )
        results.push({
          rowId: sub.id,
          mailbox: sub.mailbox,
          subscriptionId: sub.subscription_id,
          status: 'expired',
          oldExpiration: sub.expiration_date_time,
          reason: 'expired before renewal',
        })
        continue
      }

      if (expiry > renewalThreshold) {
        // Not yet within renewal window. Skip.
        results.push({
          rowId: sub.id,
          mailbox: sub.mailbox,
          subscriptionId: sub.subscription_id,
          status: 'skipped',
          oldExpiration: sub.expiration_date_time,
          reason: `expires in >${RENEWAL_WINDOW_HOURS}h`,
        })
        continue
      }

      // Within window — renew via Graph
      try {
        const renewed = await renewSubscription(sub.subscription_id, 4200)
        await updateSubscriptionRowAfterRenewal(sub.id, renewed.expirationDateTime)
        results.push({
          rowId: sub.id,
          mailbox: sub.mailbox,
          subscriptionId: sub.subscription_id,
          status: 'renewed',
          oldExpiration: sub.expiration_date_time,
          newExpiration: renewed.expirationDateTime,
        })
      } catch (e: any) {
        const errMessage = e?.message || String(e)
        // If Graph says the subscription doesn't exist (404), mark as failed
        // — we'll need to recreate via the setup endpoint. For other errors,
        // leave status='active' and just log the renewal failure so we'll
        // try again next run.
        const newStatus = /404|not found/i.test(errMessage) ? 'failed' : 'active'
        await markSubscriptionRenewalFailure(sub.id, errMessage, newStatus)
        results.push({
          rowId: sub.id,
          mailbox: sub.mailbox,
          subscriptionId: sub.subscription_id,
          status: 'failed',
          oldExpiration: sub.expiration_date_time,
          reason: errMessage,
        })
      }
    }

    // Telemetry
    await logRenewalRun({
      durationMs: Date.now() - tStart,
      results,
    })

    const renewed = results.filter(r => r.status === 'renewed').length
    const skipped = results.filter(r => r.status === 'skipped').length
    const failed = results.filter(r => r.status === 'failed').length
    const expired = results.filter(r => r.status === 'expired').length

    return res.status(200).json({
      ok: failed === 0 && expired === 0,
      summary: { total: results.length, renewed, skipped, failed, expired },
      durationMs: Date.now() - tStart,
      results,
    })
  } catch (e: any) {
    await logRenewalRun({
      durationMs: Date.now() - tStart,
      results,
      topLevelError: e?.message || String(e),
    })
    return res.status(500).json({
      ok: false,
      error: e?.message || String(e),
      durationMs: Date.now() - tStart,
    })
  }
}

async function logRenewalRun(input: {
  durationMs: number
  results: RenewalResult[]
  topLevelError?: string
}): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return
  const sb = createClient(url, key, { auth: { persistSession: false } })

  const failed = input.results.filter(r => r.status === 'failed' || r.status === 'expired').length

  await sb.from('quote_events').insert({
    pipeline: 'A_subscription_renewal',
    details: {
      results: input.results,
      topLevelError: input.topLevelError || null,
    },
    duration_ms: input.durationMs,
    status: input.topLevelError ? 'failed' : (failed > 0 ? 'partial' : 'success'),
    completed_at: new Date().toISOString(),
  })
}
