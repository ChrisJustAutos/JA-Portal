// pages/api/admin/backfill-quotes.ts
// One-off admin endpoint to backfill quote ingestions that the live webhook
// missed — e.g. when an Outlook rule filed the MechanicDesk quote emails into
// a subfolder (like Kaleb's "Quotes Sent") that the Inbox-only subscription
// never saw.
//
// What it does:
//   1. Lists messages across the WHOLE mailbox (all folders) for the last
//      N days (listAllMessagesWithAttachments).
//   2. Keeps those from MechanicDesk's sender that carry a
//      `performance-estimate*` PDF.
//   3. Skips any already processed (a quote_events row with the same
//      graphMessageId — from the live webhook OR a previous backfill run).
//   4. Feeds each PDF through the SAME pipeline the webhook uses by POSTing
//      to the stub endpoint (parse → Active Campaign → Monday).
//   5. Writes an 'A_backfill' marker row per message so re-runs are idempotent.
//
// Auth: GRAPH_ADMIN_SETUP_SECRET in ?key= (same secret as the setup endpoint).
//
// Query params:
//   mailbox  — mailbox to backfill (default kaleb@justautosmechanical.com.au)
//   days     — lookback window in days (default 14)
//   limit    — max messages to actually process this run (default 20). Each
//              quote takes ~7-12s through the pipeline, so this keeps us under
//              the function time budget. Re-run to process the next batch.
//   dryRun   — '1' to list matches without processing (no AC/Monday writes)

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import {
  listAllMessagesWithAttachments,
  listAttachmentMeta,
  getAttachmentBase64,
} from '../../../lib/microsoft-graph'
import { getAgentByMailbox } from '../../../lib/agents'

export const config = {
  api: { bodyParser: { sizeLimit: '64kb' } },
  // Each quote runs the full parse + AC + Monday pipeline (~7-12s). Give the
  // batch plenty of room; `limit` keeps the total bounded.
  maxDuration: 300,
}

const FILENAME_PATTERN = /^performance-estimate/i
const DEFAULT_MAILBOX = 'kaleb@justautosmechanical.com.au'
const DEFAULT_FROM_FILTER = 'mechanicdesk'

interface ItemResult {
  messageId: string
  subject: string | null
  receivedDateTime: string
  attachment: string | null
  outcome: 'processed' | 'skipped_already_done' | 'skipped_no_match' | 'failed' | 'dry_run'
  reason?: string
  stub?: any
}

function sb() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env not configured')
  return createClient(url, key, { auth: { persistSession: false } })
}

async function alreadyProcessed(client: ReturnType<typeof sb>, messageId: string): Promise<boolean> {
  const { data, error } = await client
    .from('quote_events')
    .select('id')
    .filter('details->>graphMessageId', 'eq', messageId)
    .limit(1)
  if (error) {
    console.warn('[backfill-quotes] dedup check failed:', error.message)
    return false
  }
  return (data?.length || 0) > 0
}

async function writeMarker(
  client: ReturnType<typeof sb>,
  mailbox: string,
  messageId: string,
  outcome: string,
  extra: Record<string, any>,
): Promise<void> {
  await client.from('quote_events').insert({
    pipeline: 'A_backfill',
    agent_email: mailbox,
    status: outcome === 'processed' ? 'success' : 'partial',
    completed_at: new Date().toISOString(),
    details: { graphMessageId: messageId, backfill: true, outcome, ...extra },
  }).then(({ error }) => {
    if (error) console.warn('[backfill-quotes] marker insert failed:', error.message)
  })
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const expected = process.env.GRAPH_ADMIN_SETUP_SECRET
  if (!expected) return res.status(500).json({ ok: false, error: 'GRAPH_ADMIN_SETUP_SECRET not configured' })
  if (((req.query.key as string) || '') !== expected) return res.status(401).json({ ok: false, error: 'Unauthorized' })
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ ok: false, error: 'Method not allowed (use POST)' })
  }

  const stubSecret = process.env.QUOTE_STUB_SECRET
  if (!stubSecret) return res.status(500).json({ ok: false, error: 'QUOTE_STUB_SECRET not configured' })

  const mailbox = ((req.query.mailbox as string) || DEFAULT_MAILBOX).trim()
  const days = Math.min(Math.max(parseInt((req.query.days as string) || '14', 10) || 14, 1), 90)
  const limit = Math.min(Math.max(parseInt((req.query.limit as string) || '20', 10) || 20, 1), 50)
  const dryRun = (req.query.dryRun as string) === '1'
  const fromFilter = ((req.query.fromFilter as string) || DEFAULT_FROM_FILTER).toLowerCase()

  if (!getAgentByMailbox(mailbox)) {
    return res.status(400).json({ ok: false, error: `Mailbox ${mailbox} is not a configured rep (lib/agents.ts)` })
  }

  const baseUrl = (process.env.JA_PORTAL_BASE_URL || `https://${req.headers.host}`).replace(/\/$/, '')
  const sinceIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()

  let client: ReturnType<typeof sb>
  try { client = sb() } catch (e: any) { return res.status(500).json({ ok: false, error: e?.message || String(e) }) }

  // 1. List whole-mailbox messages with attachments since the cutoff.
  let messages
  try {
    messages = await listAllMessagesWithAttachments(mailbox, { sinceIsoDate: sinceIso, maxPages: 15 })
  } catch (e: any) {
    return res.status(502).json({ ok: false, error: `Graph list failed: ${e?.message || String(e)}` })
  }

  // 2. Keep MechanicDesk-originated messages.
  const candidates = messages.filter(m => (m.from || '').toLowerCase().includes(fromFilter))

  const results: ItemResult[] = []
  let processed = 0

  for (const m of candidates) {
    if (processed >= limit) {
      results.push({
        messageId: m.id, subject: m.subject, receivedDateTime: m.receivedDateTime,
        attachment: null, outcome: 'skipped_no_match', reason: 'batch limit reached — re-run to continue',
      })
      continue
    }

    // 2a. Already handled? (webhook or earlier backfill)
    if (await alreadyProcessed(client, m.id)) {
      results.push({ messageId: m.id, subject: m.subject, receivedDateTime: m.receivedDateTime, attachment: null, outcome: 'skipped_already_done' })
      continue
    }

    // 2b. Find a performance-estimate attachment.
    let atts
    try {
      atts = await listAttachmentMeta(mailbox, m.id)
    } catch (e: any) {
      results.push({ messageId: m.id, subject: m.subject, receivedDateTime: m.receivedDateTime, attachment: null, outcome: 'failed', reason: `attachment list: ${e?.message || String(e)}` })
      continue
    }
    const match = atts.find(a => FILENAME_PATTERN.test(a.name))
    if (!match) {
      results.push({ messageId: m.id, subject: m.subject, receivedDateTime: m.receivedDateTime, attachment: null, outcome: 'skipped_no_match', reason: 'no performance-estimate attachment' })
      continue
    }

    if (dryRun) {
      results.push({ messageId: m.id, subject: m.subject, receivedDateTime: m.receivedDateTime, attachment: match.name, outcome: 'dry_run' })
      continue
    }

    // 2c. Download + feed through the proven stub pipeline.
    try {
      const pdfBase64 = await getAttachmentBase64(mailbox, m.id, match.id)
      const r = await fetch(`${baseUrl}/api/webhooks/graph-mail/graph-mail-test?key=${encodeURIComponent(stubSecret)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentEmail: mailbox, pdfBase64, pdfFilename: match.name }),
      })
      const stubJson = await r.json().catch(() => null)
      const ok = r.ok && stubJson?.ok !== false
      await writeMarker(client, mailbox, m.id, ok ? 'processed' : 'failed', {
        attachmentName: match.name,
        receivedDateTime: m.receivedDateTime,
        stubStatus: r.status,
        stubResult: stubJson ? { quoteNumber: stubJson?.parsed?.quoteNumber, monday: stubJson?.monday, error: stubJson?.error } : null,
      })
      results.push({
        messageId: m.id, subject: m.subject, receivedDateTime: m.receivedDateTime,
        attachment: match.name, outcome: ok ? 'processed' : 'failed',
        reason: ok ? undefined : (stubJson?.error || `stub HTTP ${r.status}`),
        stub: stubJson ? { quoteNumber: stubJson?.parsed?.quoteNumber, monday: stubJson?.monday } : null,
      })
      processed++
    } catch (e: any) {
      results.push({ messageId: m.id, subject: m.subject, receivedDateTime: m.receivedDateTime, attachment: match.name, outcome: 'failed', reason: e?.message || String(e) })
    }
  }

  const summary = {
    mailbox, days, limit, dryRun,
    messagesScanned: messages.length,
    fromMechanicDesk: candidates.length,
    processed: results.filter(r => r.outcome === 'processed').length,
    alreadyDone: results.filter(r => r.outcome === 'skipped_already_done').length,
    noMatch: results.filter(r => r.outcome === 'skipped_no_match').length,
    failed: results.filter(r => r.outcome === 'failed').length,
    dryRunMatches: results.filter(r => r.outcome === 'dry_run').length,
  }

  return res.status(200).json({ ok: summary.failed === 0, summary, results })
}
