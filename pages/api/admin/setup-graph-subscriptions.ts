// pages/api/admin/setup-graph-subscriptions.ts
// One-shot admin endpoint to create all Microsoft Graph subscriptions
// the portal needs.
//
// Auth: GRAPH_ADMIN_SETUP_SECRET in the URL (?key=...).
//
// Subscriptions created:
//   • Pipeline A — every rep mailbox in lib/agents.ts → /api/webhooks/graph-mail
//                  Watches Inbox/created for Mechanics Desk quote PDFs.
//   • Pipeline C — Chris's mailbox only → /api/webhooks/graph-jobreport-mail
//                  Watches Inbox/created for the nightly Job WIP report email.
//
// Idempotency: safe to call repeatedly. Skips if a subscription already
// exists with the same (mailbox, notificationUrl) combination.
//
// Env vars required:
//   GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET — Azure App
//   GRAPH_WEBHOOK_URL                  — Pipeline A webhook URL
//   GRAPH_JOBREPORT_WEBHOOK_URL        — Pipeline C webhook URL
//   GRAPH_JOBREPORT_MAILBOX            — Mailbox to watch for WIP report (e.g. chris@justautos.com.au)

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
  pipeline: 'A' | 'C'
  mailbox: string
  status: 'created' | 'skipped' | 'failed'
  subscriptionId?: string
  expiresAt?: string
  reason?: string
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Auth
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

  const pipelineAUrl = process.env.GRAPH_WEBHOOK_URL
  const pipelineCUrl = process.env.GRAPH_JOBREPORT_WEBHOOK_URL
  const jobReportMailbox = process.env.GRAPH_JOBREPORT_MAILBOX

  if (!pipelineAUrl) {
    return res.status(500).json({ ok: false, error: 'GRAPH_WEBHOOK_URL not configured' })
  }

  // Pipeline C config is optional — if missing, skip Pipeline C setup with a warning
  // rather than failing the whole call. Pipeline A is the more critical subscription.
  const pipelineCConfigured = !!(pipelineCUrl && jobReportMailbox)

  // Find existing active subs once, index by (mailbox, notificationUrl)
  const existing = await listActiveSubscriptions()
  const existingByKey = new Map<string, typeof existing[number]>()
  for (const sub of existing) {
    const key = `${sub.mailbox.toLowerCase()}|${sub.notification_url}`
    existingByKey.set(key, sub)
  }

  const results: SetupResult[] = []

  // ── Pipeline A — rep mailboxes ──────────────────────────────────────
  const repMailboxes = Object.keys(AGENTS_BY_MAILBOX)
  for (const mailbox of repMailboxes) {
    const result = await ensureSubscription({
      mailbox,
      notificationUrl: pipelineAUrl,
      existingByKey,
      pipeline: 'A',
    })
    results.push(result)
  }

  // ── Pipeline C — Chris's mailbox for WIP report ─────────────────────
  if (pipelineCConfigured) {
    const result = await ensureSubscription({
      mailbox: jobReportMailbox!,
      notificationUrl: pipelineCUrl!,
      existingByKey,
      pipeline: 'C',
    })
    results.push(result)
  } else {
    results.push({
      pipeline: 'C',
      mailbox: jobReportMailbox || '(unset)',
      status: 'failed',
      reason: 'GRAPH_JOBREPORT_WEBHOOK_URL or GRAPH_JOBREPORT_MAILBOX not configured — skipping Pipeline C',
    })
  }

  const created = results.filter(r => r.status === 'created').length
  const skipped = results.filter(r => r.status === 'skipped').length
  const failed = results.filter(r => r.status === 'failed').length

  return res.status(200).json({
    ok: failed === 0,
    summary: { total: results.length, created, skipped, failed },
    results,
    webhookUrls: {
      pipelineA: pipelineAUrl,
      pipelineC: pipelineCUrl || null,
    },
  })
}

async function ensureSubscription(input: {
  mailbox: string
  notificationUrl: string
  existingByKey: Map<string, any>
  pipeline: 'A' | 'C'
}): Promise<SetupResult> {
  const key = `${input.mailbox.toLowerCase()}|${input.notificationUrl}`
  const existing = input.existingByKey.get(key)

  if (existing) {
    return {
      pipeline: input.pipeline,
      mailbox: input.mailbox,
      status: 'skipped',
      subscriptionId: existing.subscription_id,
      expiresAt: existing.expiration_date_time,
      reason: 'active subscription already exists',
    }
  }

  try {
    const resource = `users/${encodeURIComponent(input.mailbox)}/mailFolders('Inbox')/messages`
    const clientState = generateClientState()

    const sub = await createSubscription({
      resource,
      notificationUrl: input.notificationUrl,
      clientState,
      changeType: 'created',
      expirationMinutes: 4200,
    })

    await insertSubscriptionRow({
      mailbox: input.mailbox,
      resource,
      subscription: sub,
    })

    return {
      pipeline: input.pipeline,
      mailbox: input.mailbox,
      status: 'created',
      subscriptionId: sub.id,
      expiresAt: sub.expirationDateTime,
    }
  } catch (e: any) {
    return {
      pipeline: input.pipeline,
      mailbox: input.mailbox,
      status: 'failed',
      reason: e?.message || String(e),
    }
  }
}
