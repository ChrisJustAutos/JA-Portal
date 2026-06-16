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
  deleteSubscription,
  markSubscriptionDeleted,
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
  // Watches the WHOLE mailbox (all folders), not just the Inbox, so quote
  // emails an Outlook rule files into a subfolder (e.g. "Quotes Sent") still
  // trigger a notification. The performance-estimate filename filter in the
  // webhook gates what actually gets processed.
  const repMailboxes = Object.keys(AGENTS_BY_MAILBOX)
  for (const mailbox of repMailboxes) {
    const result = await ensureSubscription({
      mailbox,
      notificationUrl: pipelineAUrl,
      resource: wholeMailboxResource(mailbox),
      existingByKey,
      pipeline: 'A',
    })
    results.push(result)
  }

  // ── Pipeline C — Chris's mailbox for WIP report ─────────────────────
  // The nightly WIP report lands in the Inbox, so Inbox-only is fine here.
  if (pipelineCConfigured) {
    const result = await ensureSubscription({
      mailbox: jobReportMailbox!,
      notificationUrl: pipelineCUrl!,
      resource: inboxResource(jobReportMailbox!),
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

function wholeMailboxResource(mailbox: string): string {
  return `users/${encodeURIComponent(mailbox)}/messages`
}
function inboxResource(mailbox: string): string {
  return `users/${encodeURIComponent(mailbox)}/mailFolders('Inbox')/messages`
}

async function ensureSubscription(input: {
  mailbox: string
  notificationUrl: string
  resource: string
  existingByKey: Map<string, any>
  pipeline: 'A' | 'C'
}): Promise<SetupResult> {
  const key = `${input.mailbox.toLowerCase()}|${input.notificationUrl}`
  const existing = input.existingByKey.get(key)

  if (existing) {
    // Already pointed at the desired resource — nothing to do.
    if (existing.resource === input.resource) {
      return {
        pipeline: input.pipeline,
        mailbox: input.mailbox,
        status: 'skipped',
        subscriptionId: existing.subscription_id,
        expiresAt: existing.expiration_date_time,
        reason: 'active subscription already exists',
      }
    }
    // Resource changed (e.g. Inbox-only → whole mailbox): tear down the old
    // subscription on Graph + mark it deleted, then fall through to recreate.
    try {
      await deleteSubscription(existing.subscription_id)
      await markSubscriptionDeleted(existing.id)
    } catch (e: any) {
      return {
        pipeline: input.pipeline,
        mailbox: input.mailbox,
        status: 'failed',
        reason: `failed to delete stale subscription (${existing.resource}): ${e?.message || String(e)}`,
      }
    }
  }

  try {
    const resource = input.resource
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
