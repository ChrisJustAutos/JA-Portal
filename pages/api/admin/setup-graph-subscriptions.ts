// pages/api/admin/setup-graph-subscriptions.ts
// One-shot admin endpoint to create Microsoft Graph subscriptions for every
// rep mailbox in lib/agents.ts.
//
// Auth: GRAPH_ADMIN_SETUP_SECRET in the URL (?key=...).
//
// Behaviour:
//   - For each rep mailbox, check if an active subscription already exists
//     in graph_subscriptions table. Skip if yes.
//   - If no, create a fresh subscription via Graph API watching the rep's
//     Inbox for new messages.
//   - Generate a fresh clientState per subscription. Store in DB so the
//     webhook can verify notifications.
//   - Return a summary of what was created vs skipped vs failed.
//
// Idempotency: safe to call repeatedly. Won't create duplicates.
//
// To re-subscribe a mailbox (e.g. after a manual delete), first mark the
// existing graph_subscriptions row as status='deleted' and delete via Graph.

import type { NextApiRequest, NextApiResponse } from 'next'
import { AGENTS_BY_MAILBOX } from '../../../lib/agents'
import {
  createSubscription,
  generateClientState,
  insertSubscriptionRow,
  listActiveSubscriptions,
} from '../../../lib/microsoft-graph'

export const config = {
  api: { bodyParser: { sizeLimit: '64kb' } },
  maxDuration: 60,
}

interface SetupResult {
  mailbox: string
  status: 'created' | 'skipped' | 'failed'
  subscriptionId?: string
  expiresAt?: string
  reason?: string
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // ── Auth ────────────────────────────────────────────────────────────
  const expected = process.env.GRAPH_ADMIN_SETUP_SECRET
  const got = (req.query.key as string) || ''
  if (!expected) {
    return res.status(500).json({ ok: false, error: 'GRAPH_ADMIN_SETUP_SECRET not configured' })
  }
  if (got !== expected) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' })
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ ok: false, error: 'Method not allowed' })
  }

  const notificationUrl = process.env.GRAPH_WEBHOOK_URL
  if (!notificationUrl) {
    return res.status(500).json({ ok: false, error: 'GRAPH_WEBHOOK_URL not configured' })
  }

  // ── Find existing active subscriptions ──────────────────────────────
  const existing = await listActiveSubscriptions()
  const existingByMailbox = new Map<string, typeof existing[number]>()
  for (const sub of existing) {
    existingByMailbox.set(sub.mailbox.toLowerCase(), sub)
  }

  const results: SetupResult[] = []

  // ── Iterate mailboxes from lib/agents.ts ────────────────────────────
  const mailboxes = Object.keys(AGENTS_BY_MAILBOX)
  for (const mailbox of mailboxes) {
    const lowerMailbox = mailbox.toLowerCase()

    // Skip if already subscribed
    if (existingByMailbox.has(lowerMailbox)) {
      const sub = existingByMailbox.get(lowerMailbox)!
      results.push({
        mailbox,
        status: 'skipped',
        subscriptionId: sub.subscription_id,
        expiresAt: sub.expiration_date_time,
        reason: 'active subscription already exists',
      })
      continue
    }

    // Create new subscription
    try {
      const resource = `users/${encodeURIComponent(mailbox)}/mailFolders('Inbox')/messages`
      const clientState = generateClientState()

      const sub = await createSubscription({
        resource,
        notificationUrl,
        clientState,
        changeType: 'created',
        expirationMinutes: 4200,   // ~70 hrs
      })

      await insertSubscriptionRow({
        mailbox,
        resource,
        subscription: sub,
      })

      results.push({
        mailbox,
        status: 'created',
        subscriptionId: sub.id,
        expiresAt: sub.expirationDateTime,
      })
    } catch (e: any) {
      results.push({
        mailbox,
        status: 'failed',
        reason: e?.message || String(e),
      })
    }
  }

  const created = results.filter(r => r.status === 'created').length
  const skipped = results.filter(r => r.status === 'skipped').length
  const failed = results.filter(r => r.status === 'failed').length

  return res.status(200).json({
    ok: failed === 0,
    summary: { total: results.length, created, skipped, failed },
    results,
    webhookUrl: notificationUrl,
  })
}
