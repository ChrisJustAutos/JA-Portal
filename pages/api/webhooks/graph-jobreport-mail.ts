// pages/api/webhooks/graph-jobreport-mail.ts
// Pipeline C — Microsoft Graph webhook for the nightly Mechanics Desk
// Job WIP report email.
//
// Flow:
//   1. Subscription created on chris@... mailbox watching Inbox/created
//   2. Each evening ~6:10 PM AEST (08:10 UTC), Mechanics Desk sends an email
//      with subject "ATTN: Just Autos, Your daily Job Wip Report" containing
//      a CSV/XLSX attachment with all current jobs.
//   3. Graph POSTs notification → this endpoint → we fetch attachment →
//      ingest via lib/job-report-upload as report_type='wip_snapshot' (its
//      own lane — does NOT pollute the forecast lane that drives the
//      Forecasting page).
//
// Filtering (defensive — we have a dedicated subscription, but Chris's
// Inbox gets plenty of unrelated mail):
//   - Sender must be noreply@mg.mechanicdesk.com.au
//   - Subject must match /Job Wip Report/i
//   - At least one attachment must be CSV/XLSX
//
// Idempotency: dedupe on (subscription_id, graph_message_id) via quote_events.
// If we've already logged this graphMessageId for pipeline=C_jobreport_ingestion,
// skip — Graph delivers duplicates surprisingly often.
//
// Microsoft contract:
//   - Validation handshake: respond ?validationToken=... within 10s
//   - Notifications: respond 202 within 30s

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import {
  findSubscriptionByGraphId,
  getMessageMeta,
  listAttachmentMeta,
  getAttachmentBase64,
} from '../../../lib/microsoft-graph'
import { ingestJobReport } from '../../../lib/job-report-upload'

export const config = {
  api: {
    bodyParser: { sizeLimit: '1mb' },
  },
  // The actual heavy work is fetching the XLSX (~100kb-2mb) + parsing
  // ~1000 jobs + DB inserts. Comfortably under 30s in practice but we
  // give ourselves headroom because Graph times out at 30s anyway.
  maxDuration: 60,
}

// Sender + subject filter — both tightly scoped because Mechanics Desk
// sends OTHER emails to chris@... (quotes, system notices, etc.) and we
// only want the WIP report.
const EXPECTED_SENDER = 'noreply@mg.mechanicdesk.com.au'
const SUBJECT_PATTERN = /Job\s*Wip\s*Report/i
const ATTACHMENT_PATTERN = /\.(csv|xlsx?)$/i

interface GraphNotification {
  subscriptionId: string
  subscriptionExpirationDateTime: string
  changeType: string
  resource: string
  resourceData: { '@odata.type': string; '@odata.id': string; id: string }
  clientState: string
  tenantId: string
}

interface GraphNotificationBatch { value: GraphNotification[] }

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // ── 1. Validation handshake ────────────────────────────────────────
  const validationToken = req.query.validationToken
  if (typeof validationToken === 'string' && validationToken.length > 0) {
    res.setHeader('Content-Type', 'text/plain')
    return res.status(200).send(validationToken)
  }

  // ── 2. Method check ────────────────────────────────────────────────
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  // ── 3. Parse the notification batch ────────────────────────────────
  let batch: GraphNotificationBatch
  try {
    batch = (typeof req.body === 'string' ? JSON.parse(req.body) : req.body) as GraphNotificationBatch
  } catch (e: any) {
    console.error('[graph-jobreport] could not parse body:', e?.message)
    return res.status(202).json({ accepted: 0, error: 'unparseable body' })
  }

  if (!batch || !Array.isArray(batch.value) || batch.value.length === 0) {
    return res.status(202).json({ accepted: 0 })
  }

  // ── 4. Process each notification ───────────────────────────────────
  const results: Array<{ messageId: string; status: string; reason?: string }> = []

  for (const notification of batch.value) {
    try {
      const result = await processNotification(notification)
      results.push(result)
    } catch (e: any) {
      console.error('[graph-jobreport] processNotification failed:', e?.message, e?.stack)
      results.push({
        messageId: notification.resourceData?.id || 'unknown',
        status: 'error',
        reason: e?.message || String(e),
      })
    }
  }

  return res.status(202).json({
    accepted: results.length,
    results,
  })
}

async function processNotification(notification: GraphNotification): Promise<{
  messageId: string
  status: string
  reason?: string
}> {
  const tStart = Date.now()
  const messageId = notification.resourceData?.id

  if (!messageId) {
    return { messageId: 'unknown', status: 'skipped', reason: 'no resourceData.id' }
  }

  // 4a. Verify subscription
  const stored = await findSubscriptionByGraphId(notification.subscriptionId)
  if (!stored) {
    await logGraphEvent({
      subscriptionId: notification.subscriptionId, messageId, mailbox: null,
      status: 'failed', reason: 'subscription not found in graph_subscriptions',
      durationMs: Date.now() - tStart,
    })
    return { messageId, status: 'rejected', reason: 'unknown subscription' }
  }

  if (stored.client_state !== notification.clientState) {
    await logGraphEvent({
      subscriptionId: notification.subscriptionId, messageId, mailbox: stored.mailbox,
      status: 'failed', reason: 'clientState mismatch — possible spoofing',
      durationMs: Date.now() - tStart,
    })
    return { messageId, status: 'rejected', reason: 'invalid clientState' }
  }

  // 4b. Idempotency
  const alreadyProcessed = await checkAlreadyProcessed(notification.subscriptionId, messageId)
  if (alreadyProcessed) {
    return { messageId, status: 'skipped', reason: 'already processed' }
  }

  // 4c. Fetch message metadata
  const mailbox = stored.mailbox
  let messageMeta
  try {
    messageMeta = await getMessageMeta(mailbox, messageId)
  } catch (e: any) {
    await logGraphEvent({
      subscriptionId: notification.subscriptionId, messageId, mailbox,
      status: 'failed', reason: `getMessageMeta failed: ${e?.message || String(e)}`,
      durationMs: Date.now() - tStart,
    })
    return { messageId, status: 'error', reason: 'message fetch failed' }
  }

  // 4d. Sender filter — defence in depth (subscription is on Inbox so we get
  // all mail). We don't run Pipeline C unless the sender matches Mechanics Desk.
  const fromLower = (messageMeta.from || '').toLowerCase()
  if (fromLower !== EXPECTED_SENDER) {
    await logGraphEvent({
      subscriptionId: notification.subscriptionId, messageId, mailbox,
      messageSubject: messageMeta.subject, messageFrom: messageMeta.from,
      status: 'skipped', reason: `sender mismatch (expected ${EXPECTED_SENDER}, got ${messageMeta.from})`,
      durationMs: Date.now() - tStart,
    })
    return { messageId, status: 'skipped', reason: 'sender mismatch' }
  }

  // 4e. Subject filter
  if (!SUBJECT_PATTERN.test(messageMeta.subject || '')) {
    await logGraphEvent({
      subscriptionId: notification.subscriptionId, messageId, mailbox,
      messageSubject: messageMeta.subject, messageFrom: messageMeta.from,
      status: 'skipped', reason: 'subject does not match Job Wip Report',
      durationMs: Date.now() - tStart,
    })
    return { messageId, status: 'skipped', reason: 'subject mismatch' }
  }

  if (!messageMeta.hasAttachments) {
    await logGraphEvent({
      subscriptionId: notification.subscriptionId, messageId, mailbox,
      messageSubject: messageMeta.subject, messageFrom: messageMeta.from,
      status: 'failed', reason: 'WIP report email has no attachments — Mechanics Desk export may have failed',
      durationMs: Date.now() - tStart,
    })
    return { messageId, status: 'error', reason: 'no attachments' }
  }

  // 4f. Find the CSV/XLSX attachment
  let attachments
  try {
    attachments = await listAttachmentMeta(mailbox, messageId)
  } catch (e: any) {
    await logGraphEvent({
      subscriptionId: notification.subscriptionId, messageId, mailbox,
      messageSubject: messageMeta.subject, messageFrom: messageMeta.from,
      status: 'failed', reason: `listAttachmentMeta failed: ${e?.message || String(e)}`,
      durationMs: Date.now() - tStart,
    })
    return { messageId, status: 'error', reason: 'attachment list failed' }
  }

  // Pick the first matching attachment. Mechanics Desk sends one CSV/XLSX
  // per email; if there are multiple we take the first and log the rest.
  const wipAttachment = attachments.find(a => ATTACHMENT_PATTERN.test(a.name))
  if (!wipAttachment) {
    await logGraphEvent({
      subscriptionId: notification.subscriptionId, messageId, mailbox,
      messageSubject: messageMeta.subject, messageFrom: messageMeta.from,
      status: 'failed', reason: `no CSV/XLSX attachment found`,
      detailsExtra: { attachmentNames: attachments.map(a => a.name) },
      durationMs: Date.now() - tStart,
    })
    return { messageId, status: 'error', reason: 'no matching attachment' }
  }

  // 4g. Run the ingestion
  await runPipelineC({
    mailbox,
    messageId,
    messageSubject: messageMeta.subject,
    messageFrom: messageMeta.from,
    attachmentId: wipAttachment.id,
    attachmentName: wipAttachment.name,
    attachmentSize: wipAttachment.size,
    subscriptionId: notification.subscriptionId,
  })

  return { messageId, status: 'processed' }
}

async function runPipelineC(input: {
  mailbox: string
  messageId: string
  messageSubject: string | null
  messageFrom: string | null
  attachmentId: string
  attachmentName: string
  attachmentSize: number
  subscriptionId: string
}): Promise<void> {
  const tStart = Date.now()

  // 1. Download attachment
  let fileBase64: string
  try {
    fileBase64 = await getAttachmentBase64(input.mailbox, input.messageId, input.attachmentId)
  } catch (e: any) {
    await logIngestEvent({
      ...input,
      status: 'failed',
      detailsExtra: {
        where: 'getAttachmentBase64',
        error: e?.message || String(e),
      },
      durationMs: Date.now() - tStart,
    })
    return
  }

  const buffer = Buffer.from(fileBase64, 'base64')

  // 2. Ingest as wip_snapshot — its own lane, doesn't touch the forecast lane.
  // The auto-WIP export from Mechanics Desk is a stripped-down version of the
  // manual export (missing Job Date, real Job Types, Total/Quoted Total) so it
  // is NOT used for forecasting. Reserved for a future "Today's Workshop"
  // widget on Overview.
  try {
    const result = await ingestJobReport({
      buffer,
      filename: input.attachmentName,
      source: 'graph_mail',
      reportType: 'wip_snapshot',
      uploadedBy: null,
      notes: `Auto-ingested as WIP snapshot from email "${input.messageSubject}" (${new Date().toISOString()})`,
    })

    await logIngestEvent({
      ...input,
      status: 'success',
      detailsExtra: {
        runId: result.runId,
        reportType: result.reportType,
        jobCount: result.jobCount,
        rematchedInvoices: result.rematchedInvoices,
        warnings: result.warnings,
        headerMap: result.headerMap,
        ingestDurationMs: result.durationMs,
      },
      durationMs: Date.now() - tStart,
    })
  } catch (e: any) {
    await logIngestEvent({
      ...input,
      status: 'failed',
      detailsExtra: {
        where: 'ingestJobReport',
        error: e?.message || String(e),
      },
      durationMs: Date.now() - tStart,
    })
  }
}

// ── Idempotency ────────────────────────────────────────────────────────

async function checkAlreadyProcessed(subscriptionId: string, messageId: string): Promise<boolean> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return false
  const sb = createClient(url, key, { auth: { persistSession: false } })

  const { data, error } = await sb
    .from('quote_events')
    .select('id')
    .eq('pipeline', 'C_jobreport_ingestion')
    .filter('details->>graphMessageId', 'eq', messageId)
    .filter('details->>subscriptionId', 'eq', subscriptionId)
    .limit(1)

  if (error) {
    console.warn('[graph-jobreport] idempotency check failed:', error.message)
    return false
  }
  return (data?.length || 0) > 0
}

// ── Logging ────────────────────────────────────────────────────────────

interface LogIngestEventInput {
  mailbox: string
  messageId: string
  messageSubject: string | null
  messageFrom: string | null
  attachmentName: string
  attachmentSize: number
  subscriptionId: string
  status: 'success' | 'partial' | 'failed'
  detailsExtra: Record<string, any>
  durationMs: number
}

async function logIngestEvent(input: LogIngestEventInput): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.warn('[graph-jobreport] cannot log event — Supabase env not configured')
    return
  }
  const sb = createClient(url, key, { auth: { persistSession: false } })

  const { error } = await sb.from('quote_events').insert({
    pipeline: 'C_jobreport_ingestion',
    agent_email: input.mailbox,
    details: {
      ...input.detailsExtra,
      attachmentName: input.attachmentName,
      attachmentSize: input.attachmentSize,
      graphMessageId: input.messageId,
      messageSubject: input.messageSubject,
      messageFrom: input.messageFrom,
      subscriptionId: input.subscriptionId,
    },
    completed_at: new Date().toISOString(),
    duration_ms: input.durationMs,
    status: input.status,
  })
  if (error) {
    console.warn('[graph-jobreport] quote_events insert failed:', error.message)
  }
}

interface LogGraphEventInput {
  subscriptionId: string
  messageId: string
  mailbox: string | null
  messageSubject?: string | null
  messageFrom?: string | null
  status: 'success' | 'partial' | 'failed' | 'skipped'
  reason: string
  detailsExtra?: Record<string, any>
  durationMs: number
}

async function logGraphEvent(input: LogGraphEventInput): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return
  const sb = createClient(url, key, { auth: { persistSession: false } })

  const dbStatus = input.status === 'skipped' ? 'partial' : input.status

  await sb.from('quote_events').insert({
    pipeline: 'C_graph_notification',
    agent_email: input.mailbox,
    details: {
      subscriptionId: input.subscriptionId,
      graphMessageId: input.messageId,
      messageSubject: input.messageSubject || null,
      messageFrom: input.messageFrom || null,
      reason: input.reason,
      ...input.detailsExtra,
    },
    duration_ms: input.durationMs,
    status: dbStatus,
    completed_at: new Date().toISOString(),
  })
}
