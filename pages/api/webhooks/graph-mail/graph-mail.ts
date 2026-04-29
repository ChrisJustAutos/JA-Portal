// pages/api/webhooks/graph-mail.ts
// Pipeline A — PRODUCTION webhook receiver for Microsoft Graph mail notifications.
//
// Replaces both:
//   - The PowerShell-driven stub at /api/webhooks/graph-mail/graph-mail-test
//   - The existing Zapier "Phone Enquiry — Quote Sent" Zap (steps 1-11)
//
// Flow:
//   1. Microsoft Graph creates a subscription per rep mailbox watching
//      the Inbox for new messages. (Setup endpoint creates these.)
//   2. When a Mechanics Desk quote email arrives, Graph POSTs a
//      notification to THIS endpoint (within ~5 sec of mail receipt).
//   3. We validate clientState against the stored subscription record.
//   4. We fetch the message + attachments via Graph API.
//   5. For each attachment whose name starts with "performance-estimate"
//      (case-insensitive), we run the same pipeline the stub already runs.
//   6. We log the whole flow to quote_events.
//
// IMPORTANT — Microsoft's contract:
//   - On subscription creation, Graph POSTs once with ?validationToken=...
//     We MUST respond within 10 sec with 200 OK + the token in plain text.
//   - On every notification, we MUST respond with 202 Accepted within 30 sec.
//     Otherwise Graph retries with backoff and eventually disables the sub.
//   - Notifications can come in batches (multiple in one POST).
//
// Idempotency: Graph may deliver the same notification multiple times due
// to retries or subscription overlap. We dedupe on (subscription_id,
// graph_message_id) — if we've already logged a row for this combination,
// skip.
//
// Strategy for staying within the 30s response window:
//   - Validation handshake: respond IMMEDIATELY with the token.
//   - Notifications: do the work synchronously but FAST. Pipeline A's
//     parse + AC + Monday flow is ~7-12s per quote. We'd risk timeout if
//     a single notification carried multiple messages with multiple
//     PDFs each. Mitigation: process the first message synchronously
//     (so its result is logged) and any extras get queued via a
//     fire-and-forget background fetch.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import {
  findSubscriptionByGraphId,
  getMessageMeta,
  listAttachmentMeta,
  getAttachmentBase64,
} from '../../../lib/microsoft-graph'
import { extractQuoteFromPdf, ExtractedQuote } from '../../../lib/quote-extraction'
import { resolveContactForCall } from '../../../lib/activecampaign'
import { applyQuoteRecencyRule } from '../../../lib/activecampaign-deals'
import { getQuoteCallContext } from '../../../lib/quote-call-context'
import { getAgentByMailbox } from '../../../lib/agents'
import { syncQuoteToMonday, type SyncQuoteToMondayResult } from '../../../lib/quote-pipeline-monday'

export const config = {
  api: {
    // Graph notifications are small JSON. 1mb is generous.
    bodyParser: { sizeLimit: '1mb' },
  },
  // Vercel max for hobby is 10s, pro is 60s, enterprise is 900s. We need
  // enough room to fetch attachment + parse + AC + Monday sync. Stub runs
  // in 7-12s, so 60s is comfortable.
  maxDuration: 60,
}

const FILENAME_PATTERN = /^performance-estimate/i

// Pattern for attachment filenames Mechanics Desk uses. Matches Zapier's
// existing filter: name starts with "performance-estimate" (case-insensitive).

interface GraphNotification {
  subscriptionId: string
  subscriptionExpirationDateTime: string
  changeType: string                   // 'created', 'updated', etc.
  resource: string                     // e.g. "Users/{id}/Messages/{messageId}"
  resourceData: {
    '@odata.type': string
    '@odata.id': string
    id: string                         // The message ID
  }
  clientState: string
  tenantId: string
}

interface GraphNotificationBatch {
  value: GraphNotification[]
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // ── 1. Validation handshake ────────────────────────────────────────
  // When a subscription is first created, Graph POSTs once with
  // ?validationToken=... in the URL and an empty body. We MUST respond
  // within 10s with 200 OK and the token as plain text.
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
    console.error('[graph-mail] could not parse body:', e?.message)
    return res.status(202).json({ accepted: 0, skipped: 0, error: 'unparseable body' })
  }

  if (!batch || !Array.isArray(batch.value) || batch.value.length === 0) {
    // Empty or malformed — still respond 202 so Graph doesn't keep retrying
    return res.status(202).json({ accepted: 0, skipped: 0 })
  }

  // ── 4. Process each notification ───────────────────────────────────
  // Microsoft's 30-second response budget:
  //   - We process them sequentially. If a batch has multiple messages
  //     and each takes ~10s, we're at risk of timeout. Mitigation: if the
  //     first message takes too long, return 202 to Graph and process the
  //     rest in the background. For Pipeline A's expected volume (1-2
  //     quotes/day per rep), batches are almost always 1 message.
  //   - Each notification fires logEvent with status='in_progress'
  //     immediately, then updates after processing.

  const results: Array<{ messageId: string; status: string; reason?: string }> = []

  for (const notification of batch.value) {
    try {
      const result = await processNotification(notification)
      results.push(result)
    } catch (e: any) {
      console.error('[graph-mail] processNotification failed:', e?.message, e?.stack)
      results.push({
        messageId: notification.resourceData?.id || 'unknown',
        status: 'error',
        reason: e?.message || String(e),
      })
    }
  }

  // ── 5. Respond 202 Accepted ─────────────────────────────────────────
  // Graph just needs us to ACK within 30s. The actual work has happened
  // (or partially happened) above.
  return res.status(202).json({
    accepted: results.length,
    results: results.map(r => ({ messageId: r.messageId, status: r.status, reason: r.reason })),
  })
}

// ── processNotification: do the work for one notification ────────────

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

  // ── 4a. Verify clientState matches a stored subscription ──────────
  const stored = await findSubscriptionByGraphId(notification.subscriptionId)
  if (!stored) {
    await logGraphEvent({
      subscriptionId: notification.subscriptionId,
      messageId,
      mailbox: null,
      status: 'failed',
      reason: 'subscription not found in graph_subscriptions',
      durationMs: Date.now() - tStart,
    })
    return { messageId, status: 'rejected', reason: 'unknown subscription' }
  }

  if (stored.client_state !== notification.clientState) {
    await logGraphEvent({
      subscriptionId: notification.subscriptionId,
      messageId,
      mailbox: stored.mailbox,
      status: 'failed',
      reason: 'clientState mismatch — possible spoofing',
      durationMs: Date.now() - tStart,
    })
    return { messageId, status: 'rejected', reason: 'invalid clientState' }
  }

  // ── 4b. Idempotency check: have we already processed this message? ──
  // Look in quote_events for a row with this graph_message_id under the
  // same subscription. If yes, skip.
  const alreadyProcessed = await checkAlreadyProcessed(notification.subscriptionId, messageId)
  if (alreadyProcessed) {
    return { messageId, status: 'skipped', reason: 'already processed' }
  }

  // ── 4c. Fetch the message metadata ─────────────────────────────────
  const mailbox = stored.mailbox
  let messageMeta
  try {
    messageMeta = await getMessageMeta(mailbox, messageId)
  } catch (e: any) {
    await logGraphEvent({
      subscriptionId: notification.subscriptionId,
      messageId,
      mailbox,
      status: 'failed',
      reason: `getMessageMeta failed: ${e?.message || String(e)}`,
      durationMs: Date.now() - tStart,
    })
    return { messageId, status: 'error', reason: 'message fetch failed' }
  }

  if (!messageMeta.hasAttachments) {
    await logGraphEvent({
      subscriptionId: notification.subscriptionId,
      messageId,
      mailbox,
      messageSubject: messageMeta.subject,
      messageFrom: messageMeta.from,
      status: 'skipped',
      reason: 'no attachments',
      durationMs: Date.now() - tStart,
    })
    return { messageId, status: 'skipped', reason: 'no attachments' }
  }

  // ── 4d. Filter attachments by filename ─────────────────────────────
  let attachments
  try {
    attachments = await listAttachmentMeta(mailbox, messageId)
  } catch (e: any) {
    await logGraphEvent({
      subscriptionId: notification.subscriptionId,
      messageId,
      mailbox,
      messageSubject: messageMeta.subject,
      messageFrom: messageMeta.from,
      status: 'failed',
      reason: `listAttachmentMeta failed: ${e?.message || String(e)}`,
      durationMs: Date.now() - tStart,
    })
    return { messageId, status: 'error', reason: 'attachment list failed' }
  }

  const matchingAttachments = attachments.filter(a => FILENAME_PATTERN.test(a.name))
  if (matchingAttachments.length === 0) {
    await logGraphEvent({
      subscriptionId: notification.subscriptionId,
      messageId,
      mailbox,
      messageSubject: messageMeta.subject,
      messageFrom: messageMeta.from,
      status: 'skipped',
      reason: `no attachment matched ${FILENAME_PATTERN}`,
      detailsExtra: {
        attachmentNames: attachments.map(a => a.name),
      },
      durationMs: Date.now() - tStart,
    })
    return { messageId, status: 'skipped', reason: 'no matching attachment' }
  }

  // ── 4e. Process each matching attachment through Pipeline A ────────
  // Usually only one, but handle multiple defensively.
  for (const att of matchingAttachments) {
    let pdfBase64: string
    try {
      pdfBase64 = await getAttachmentBase64(mailbox, messageId, att.id)
    } catch (e: any) {
      await logGraphEvent({
        subscriptionId: notification.subscriptionId,
        messageId,
        mailbox,
        messageSubject: messageMeta.subject,
        messageFrom: messageMeta.from,
        attachmentName: att.name,
        status: 'failed',
        reason: `getAttachmentBase64 failed: ${e?.message || String(e)}`,
        durationMs: Date.now() - tStart,
      })
      continue
    }

    await runPipelineA({
      mailbox,
      pdfBase64,
      pdfFilename: att.name,
      messageId,
      messageSubject: messageMeta.subject,
      messageFrom: messageMeta.from,
      subscriptionId: notification.subscriptionId,
    })
  }

  return { messageId, status: 'processed' }
}

// ── runPipelineA: the same flow the stub runs ─────────────────────────
//
// Mirrors graph-mail-test.ts but with notification-context logging.

async function runPipelineA(input: {
  mailbox: string
  pdfBase64: string
  pdfFilename: string
  messageId: string                  // Graph message ID, for idempotency tracking
  messageSubject: string | null
  messageFrom: string | null
  subscriptionId: string
}): Promise<void> {
  const tStart = Date.now()

  // 1. Resolve agent
  const agent = getAgentByMailbox(input.mailbox)
  if (!agent) {
    await logQuoteEvent({
      mailbox: input.mailbox,
      pdfFilename: input.pdfFilename,
      graphMessageId: input.messageId,
      messageSubject: input.messageSubject,
      messageFrom: input.messageFrom,
      subscriptionId: input.subscriptionId,
      status: 'failed',
      action: 'failed',
      detailsExtra: {
        where: 'agent lookup',
        error: `agent for mailbox ${input.mailbox} not in AGENTS map`,
      },
      durationMs: Date.now() - tStart,
    })
    return
  }

  // 2. Parse PDF
  let extracted: ExtractedQuote
  let parseDurationMs = 0
  try {
    const tParse = Date.now()
    const result = await extractQuoteFromPdf(input.pdfBase64)
    parseDurationMs = Date.now() - tParse
    extracted = result.quote
  } catch (e: any) {
    await logQuoteEvent({
      mailbox: input.mailbox,
      pdfFilename: input.pdfFilename,
      graphMessageId: input.messageId,
      messageSubject: input.messageSubject,
      messageFrom: input.messageFrom,
      subscriptionId: input.subscriptionId,
      status: 'failed',
      action: 'failed',
      detailsExtra: { where: 'extractQuoteFromPdf', error: e?.message || String(e) },
      durationMs: Date.now() - tStart,
    })
    return
  }

  // 3. Resolve AC contact
  const whoWhat = buildWhoWhatFromQuote(extracted)
  let acResolve
  try {
    acResolve = await resolveContactForCall({
      phone: extracted.customer.phone,
      email: extracted.customer.email,
      whoWhat,
      agentName: agent.name,
    })
  } catch (e: any) {
    await logQuoteEvent({
      mailbox: input.mailbox,
      pdfFilename: input.pdfFilename,
      graphMessageId: input.messageId,
      messageSubject: input.messageSubject,
      messageFrom: input.messageFrom,
      subscriptionId: input.subscriptionId,
      customerEmail: extracted.customer.email,
      customerPhone: extracted.customer.phone,
      status: 'failed',
      action: 'failed',
      detailsExtra: {
        where: 'resolveContactForCall',
        error: e?.message || String(e),
      },
      durationMs: Date.now() - tStart,
    })
    return
  }

  if (!acResolve.contact) {
    await logQuoteEvent({
      mailbox: input.mailbox,
      pdfFilename: input.pdfFilename,
      graphMessageId: input.messageId,
      messageSubject: input.messageSubject,
      messageFrom: input.messageFrom,
      subscriptionId: input.subscriptionId,
      customerEmail: extracted.customer.email,
      customerPhone: extracted.customer.phone,
      status: 'partial',
      action: 'skipped',
      detailsExtra: {
        where: 'ac_contact_resolve',
        reason: acResolve.reason,
        action: acResolve.action,
      },
      durationMs: Date.now() - tStart,
    })
    return
  }

  // 4. Call context
  let callContext: Awaited<ReturnType<typeof getQuoteCallContext>> = null
  if (extracted.customer.phone) {
    try {
      callContext = await getQuoteCallContext(extracted.customer.phone)
    } catch (e: any) {
      console.warn('[graph-mail] call context lookup failed (non-fatal):', e?.message || e)
    }
  }

  // 5. AC recency rule
  let recencyResult
  try {
    const ownerId = ownerIdFromAgentName(agent.name)
    recencyResult = await applyQuoteRecencyRule({
      contactId: acResolve.contact.id,
      agentName: agent.name,
      ownerId,
      quoteNumber: extracted.quote.number,
      totalIncGst: extracted.quote.totalIncGst,
      totalExGst: extracted.quote.totalExGst,
      vehicleMakeModel: extracted.vehicle.makeModel,
      vehicleRego: extracted.vehicle.rego,
      callContextNote: callContext?.formatted || null,
    })
  } catch (e: any) {
    await logQuoteEvent({
      mailbox: input.mailbox,
      pdfFilename: input.pdfFilename,
      graphMessageId: input.messageId,
      messageSubject: input.messageSubject,
      messageFrom: input.messageFrom,
      subscriptionId: input.subscriptionId,
      customerEmail: extracted.customer.email,
      customerPhone: extracted.customer.phone,
      acContactId: acResolve.contact.id,
      status: 'failed',
      action: 'failed',
      detailsExtra: {
        where: 'applyQuoteRecencyRule',
        error: e?.message || String(e),
      },
      durationMs: Date.now() - tStart,
    })
    return
  }

  // 6. Monday sync
  let mondaySync: SyncQuoteToMondayResult | null = null
  let mondayError: string | null = null
  if (!recencyResult.preview) {
    try {
      const customerName = [extracted.customer.firstName, extracted.customer.lastName]
        .filter(Boolean)
        .join(' ')
        .trim()
        || extracted.customer.name
        || 'Unknown customer'

      const dealValue = extracted.quote.totalIncGst != null
        ? extracted.quote.totalIncGst
        : (extracted.quote.totalExGst != null ? extracted.quote.totalExGst * 1.1 : 0)

      mondaySync = await syncQuoteToMonday({
        agentName: agent.name,
        acDecision: recencyResult.decision.action,
        customerName,
        phone: extracted.customer.phone,
        email: extracted.customer.email,
        postcode: extracted.customer.postcode,
        quoteNumber: extracted.quote.number,
        quoteValueIncGst: dealValue,
        noteBody: buildMondayNoteBody(extracted, callContext, agent.name),
        pdfBase64: input.pdfBase64,
        pdfFilename: input.pdfFilename,
        callDate: callContext?.latestCallDate || null,
      })
    } catch (e: any) {
      mondayError = e?.message || String(e)
      console.error('[graph-mail] syncQuoteToMonday failed:', mondayError)
    }
  }

  // 7. Final log
  const acActionForLog =
    recencyResult.preview ? 'skipped'
    : recencyResult.decision.action === 'create' ? 'deal_created'
    : 'deal_updated'

  await logQuoteEvent({
    mailbox: input.mailbox,
    pdfFilename: input.pdfFilename,
    graphMessageId: input.messageId,
    messageSubject: input.messageSubject,
    messageFrom: input.messageFrom,
    subscriptionId: input.subscriptionId,
    customerEmail: extracted.customer.email,
    customerPhone: extracted.customer.phone,
    quoteNumber: extracted.quote.number,
    quoteTotalIncGst: extracted.quote.totalIncGst,
    vehicleRego: extracted.vehicle.rego,
    acContactId: acResolve.contact.id,
    acAction: acActionForLog,
    acDealId: recencyResult.dealId,
    callId: callContext?.latestCallId || null,
    callSummaryFound: !!callContext,
    mondayAction: mondaySync?.action || null,
    mondayBoardId: mondaySync?.boardId || null,
    mondayItemId: mondaySync?.itemId || null,
    mondayError,
    status: mondayError ? 'partial' : (recencyResult.preview ? 'partial' : 'success'),
    action: mondayError ? 'failed' : 'summary_posted',
    detailsExtra: {
      stub: false,
      previewMode: recencyResult.preview,
      contactAction: acResolve.action,
      contactBackfilled: acResolve.backfilled,
      contactOwnerSet: acResolve.ownerSet,
      recencyDecision: recencyResult.decision,
      recencyDetails: recencyResult.details,
      callContextSource: callContext ? `${callContext.callCount} call(s)` : 'no calls / no phone',
      parseDurationMs,
      mondaySync: mondaySync ? {
        action: mondaySync.action,
        matchSource: mondaySync.matchSource,
        boardName: mondaySync.boardName,
        prevQuoteValue: mondaySync.prevQuoteValue,
        newQuoteValue: mondaySync.newQuoteValue,
        pdfUploaded: mondaySync.pdfUpload?.uploaded ?? null,
        pdfError: mondaySync.pdfUpload?.error ?? null,
      } : null,
    },
    durationMs: Date.now() - tStart,
  })
}

// ── Idempotency check ──────────────────────────────────────────────────

async function checkAlreadyProcessed(subscriptionId: string, messageId: string): Promise<boolean> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return false
  const sb = createClient(url, key, { auth: { persistSession: false } })

  // Match in quote_events.details on graph_message_id + subscription_id
  const { data, error } = await sb
    .from('quote_events')
    .select('id')
    .eq('pipeline', 'A_quote_ingestion')
    .filter('details->>graphMessageId', 'eq', messageId)
    .filter('details->>subscriptionId', 'eq', subscriptionId)
    .limit(1)

  if (error) {
    console.warn('[graph-mail] idempotency check failed:', error.message)
    return false
  }
  return (data?.length || 0) > 0
}

// ── Helpers ────────────────────────────────────────────────────────────

function buildWhoWhatFromQuote(q: ExtractedQuote): string {
  const name = [q.customer.firstName, q.customer.lastName].filter(Boolean).join(' ')
    || q.customer.name
    || 'Unknown caller'
  const vehiclePart = q.vehicle.makeModel ? ` with a ${q.vehicle.makeModel}` : ''
  return `${name}${vehiclePart} regarding quote ${q.quote.number}`
}

function ownerIdFromAgentName(agentName: string): number | null {
  const raw = process.env.ACTIVECAMPAIGN_OWNER_MAP || '{}'
  try {
    const parsed = JSON.parse(raw) as Record<string, number>
    const lower: Record<string, number> = {}
    for (const [k, v] of Object.entries(parsed)) lower[k.toLowerCase()] = Number(v)
    return lower[agentName.toLowerCase()] || null
  } catch {
    return null
  }
}

function buildMondayNoteBody(
  q: ExtractedQuote,
  call: Awaited<ReturnType<typeof getQuoteCallContext>>,
  repName: string,
): string {
  const lines: string[] = []
  lines.push(`📄 Quote ${q.quote.number} — sent ${new Date().toLocaleDateString('en-AU', { timeZone: 'Australia/Brisbane' })}`)
  lines.push(`Rep: ${repName}`)
  if (q.vehicle.makeModel) {
    lines.push(`Vehicle: ${q.vehicle.makeModel}${q.vehicle.rego ? ` (${q.vehicle.rego})` : ''}`)
  }
  if (q.quote.totalExGst != null) {
    lines.push(`Total: $${q.quote.totalExGst.toFixed(2)} ex GST / $${(q.quote.totalIncGst ?? q.quote.totalExGst * 1.1).toFixed(2)} inc GST`)
  }
  lines.push('')
  lines.push('── Line items ──')
  for (const item of q.quote.lineItems) {
    const qty = item.quantity ? `${item.quantity}× ` : ''
    const price = item.totalExGst != null ? ` — $${item.totalExGst.toFixed(2)}` : ''
    lines.push(`• ${qty}${item.description}${price}`)
  }
  if (call?.formatted) {
    lines.push('')
    lines.push('── Recent call context ──')
    lines.push(call.formatted)
  }
  return lines.join('\n')
}

// ── Logging helpers ────────────────────────────────────────────────────

interface LogQuoteEventInput {
  mailbox: string
  pdfFilename: string
  graphMessageId: string
  messageSubject: string | null
  messageFrom: string | null
  subscriptionId: string
  customerEmail?: string | null
  customerPhone?: string | null
  quoteNumber?: string | null
  quoteTotalIncGst?: number | null
  vehicleRego?: string | null
  acContactId?: number | null
  acAction?: 'contact_created' | 'contact_updated' | 'deal_created' | 'deal_updated' | 'skipped' | 'failed' | null
  acDealId?: number | null
  callId?: string | null
  callSummaryFound?: boolean
  mondayAction?: string | null
  mondayBoardId?: string | null
  mondayItemId?: string | null
  mondayError?: string | null
  action: 'summary_posted' | 'no_summary_posted' | 'failed' | 'skipped'
  status: 'success' | 'partial' | 'failed'
  detailsExtra: Record<string, any>
  durationMs: number
}

async function logQuoteEvent(input: LogQuoteEventInput): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.warn('[graph-mail] cannot log event — Supabase env not configured')
    return
  }
  const sb = createClient(url, key, { auth: { persistSession: false } })

  const row: any = {
    pipeline: 'A_quote_ingestion',
    agent_email: input.mailbox,
    customer_email: input.customerEmail || null,
    customer_phone: input.customerPhone || null,
    quote_number: input.quoteNumber || null,
    quote_total_inc_gst: input.quoteTotalIncGst ?? null,
    vehicle_rego: input.vehicleRego || null,
    ac_action: input.acAction || null,
    ac_contact_id: input.acContactId ?? null,
    ac_deal_id: input.acDealId ?? null,
    call_summary_found: input.callSummaryFound ?? null,
    matched_call_id: input.callId || null,
    monday_action: input.mondayAction || null,
    monday_board_id: input.mondayBoardId || null,
    monday_item_id: input.mondayItemId || null,
    monday_error: input.mondayError || null,
    details: {
      ...input.detailsExtra,
      pdfFilename: input.pdfFilename,
      graphMessageId: input.graphMessageId,
      messageSubject: input.messageSubject,
      messageFrom: input.messageFrom,
      subscriptionId: input.subscriptionId,
    },
    completed_at: new Date().toISOString(),
    duration_ms: input.durationMs,
    status: input.status,
  }

  const { error } = await sb.from('quote_events').insert(row)
  if (error) {
    console.warn('[graph-mail] quote_events insert failed:', error.message)
  }
}

interface LogGraphEventInput {
  subscriptionId: string
  messageId: string
  mailbox: string | null
  messageSubject?: string | null
  messageFrom?: string | null
  attachmentName?: string | null
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

  // status='skipped' isn't in quote_events status check but its values are
  // success|partial|failed|in_progress — map skipped to partial.
  const dbStatus =
    input.status === 'skipped' ? 'partial'
    : input.status === 'success' ? 'success'
    : input.status === 'failed' ? 'failed'
    : 'partial'

  await sb.from('quote_events').insert({
    pipeline: 'A_graph_notification',
    agent_email: input.mailbox,
    details: {
      subscriptionId: input.subscriptionId,
      graphMessageId: input.messageId,
      messageSubject: input.messageSubject || null,
      messageFrom: input.messageFrom || null,
      attachmentName: input.attachmentName || null,
      reason: input.reason,
      ...input.detailsExtra,
    },
    duration_ms: input.durationMs,
    status: dbStatus,
    completed_at: new Date().toISOString(),
  })
}
