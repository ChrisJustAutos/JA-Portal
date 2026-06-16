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
//   3. Dedupes on the QUOTE NUMBER (parsed from the subject / filename)
//      against existing quote_events rows for this rep — so the live webhook's
//      ingestions, MechanicDesk's duplicate sends, and earlier backfill runs
//      are all skipped. (Message IDs are unreliable: Graph renumbers a message
//      when an Outlook rule moves it.)
//   4. Feeds each new PDF through the SAME pipeline the webhook uses by POSTing
//      to the stub endpoint (parse → Active Campaign → Monday).
//
// Auth: GRAPH_ADMIN_SETUP_SECRET in ?key= (same secret as the setup endpoint).
//
// Query params:
//   mailbox  — mailbox to backfill (default kaleb@justautosmechanical.com.au)
//   days     — lookback window in days (default 14)
//   limit    — max NEW quotes to process this run (default 8). Each quote takes
//              ~20s through the pipeline, so this keeps us under the 300s
//              function budget. Re-run until `processed` is 0.
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
  maxDuration: 300,
}

const FILENAME_PATTERN = /^performance-estimate/i
const DEFAULT_MAILBOX = 'kaleb@justautosmechanical.com.au'
const DEFAULT_FROM_FILTER = 'mechanicdesk'

// Quote number lives in the subject ("...Performance Estimate #58127") and the
// attachment filename ("performance-estimate-58127.pdf").
function quoteNoFromSubject(subject: string | null): string | null {
  if (!subject) return null
  const m = subject.match(/performance estimate\s*#?\s*(\d{3,})/i)
  return m ? m[1] : null
}
function quoteNoFromFilename(name: string): string | null {
  const m = name.match(/(\d{3,})/)
  return m ? m[1] : null
}

interface ItemResult {
  messageId: string
  subject: string | null
  receivedDateTime: string
  quoteNo: string | null
  attachment: string | null
  outcome: 'processed' | 'skipped_already_done' | 'skipped_no_match' | 'skipped_limit' | 'failed' | 'dry_run'
  reason?: string
  monday?: any
}

function sb() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env not configured')
  return createClient(url, key, { auth: { persistSession: false } })
}

// Pull every quote number this rep already has a quote_events row for, so we
// can dedup in-memory without a DB round-trip per candidate.
async function loadProcessedQuoteNumbers(client: ReturnType<typeof sb>, mailbox: string): Promise<Set<string>> {
  const { data, error } = await client
    .from('quote_events')
    .select('quote_number')
    .eq('agent_email', mailbox)
    .eq('pipeline', 'A_quote_ingestion')
    .in('status', ['success', 'partial'])
    .not('quote_number', 'is', null)
  if (error) throw new Error(`quote_events preload failed: ${error.message}`)
  const set = new Set<string>()
  for (const r of data || []) if (r.quote_number) set.add(String(r.quote_number))
  return set
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
  const limit = Math.min(Math.max(parseInt((req.query.limit as string) || '8', 10) || 8, 1), 20)
  const dryRun = (req.query.dryRun as string) === '1'
  const fromFilter = ((req.query.fromFilter as string) || DEFAULT_FROM_FILTER).toLowerCase()

  if (!getAgentByMailbox(mailbox)) {
    return res.status(400).json({ ok: false, error: `Mailbox ${mailbox} is not a configured rep (lib/agents.ts)` })
  }

  const baseUrl = (process.env.JA_PORTAL_BASE_URL || `https://${req.headers.host}`).replace(/\/$/, '')
  const sinceIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()

  let client: ReturnType<typeof sb>
  let processedNumbers: Set<string>
  try {
    client = sb()
    processedNumbers = await loadProcessedQuoteNumbers(client, mailbox)
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) })
  }

  // 1. List whole-mailbox messages with attachments since the cutoff.
  let messages
  try {
    messages = await listAllMessagesWithAttachments(mailbox, { sinceIsoDate: sinceIso, maxPages: 15 })
  } catch (e: any) {
    return res.status(502).json({ ok: false, error: `Graph list failed: ${e?.message || String(e)}` })
  }

  // 2. Keep MechanicDesk-originated messages that look like quotes (subject).
  const candidates = messages.filter(m =>
    (m.from || '').toLowerCase().includes(fromFilter) && quoteNoFromSubject(m.subject) !== null,
  )

  const results: ItemResult[] = []
  let processed = 0

  for (const m of candidates) {
    const subjNo = quoteNoFromSubject(m.subject)

    // 2a. Dedup by quote number (covers webhook ingestions, MD duplicate sends,
    //     and previously-backfilled quotes).
    if (subjNo && processedNumbers.has(subjNo)) {
      results.push({ messageId: m.id, subject: m.subject, receivedDateTime: m.receivedDateTime, quoteNo: subjNo, attachment: null, outcome: 'skipped_already_done' })
      continue
    }

    if (processed >= limit) {
      results.push({ messageId: m.id, subject: m.subject, receivedDateTime: m.receivedDateTime, quoteNo: subjNo, attachment: null, outcome: 'skipped_limit', reason: 'batch limit reached — re-run to continue' })
      continue
    }

    // 2b. Find the performance-estimate attachment.
    let atts
    try {
      atts = await listAttachmentMeta(mailbox, m.id)
    } catch (e: any) {
      results.push({ messageId: m.id, subject: m.subject, receivedDateTime: m.receivedDateTime, quoteNo: subjNo, attachment: null, outcome: 'failed', reason: `attachment list: ${e?.message || String(e)}` })
      continue
    }
    const match = atts.find(a => FILENAME_PATTERN.test(a.name))
    if (!match) {
      results.push({ messageId: m.id, subject: m.subject, receivedDateTime: m.receivedDateTime, quoteNo: subjNo, attachment: null, outcome: 'skipped_no_match', reason: 'no performance-estimate attachment' })
      continue
    }

    const quoteNo = subjNo || quoteNoFromFilename(match.name)
    // Re-check against the filename number too (subject occasionally differs).
    if (quoteNo && quoteNo !== subjNo && processedNumbers.has(quoteNo)) {
      results.push({ messageId: m.id, subject: m.subject, receivedDateTime: m.receivedDateTime, quoteNo, attachment: match.name, outcome: 'skipped_already_done' })
      continue
    }

    if (dryRun) {
      results.push({ messageId: m.id, subject: m.subject, receivedDateTime: m.receivedDateTime, quoteNo, attachment: match.name, outcome: 'dry_run' })
      if (quoteNo) processedNumbers.add(quoteNo) // avoid double-counting MD dup sends in the preview
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
      // Mark the number done immediately so MD's duplicate send (same run) is skipped.
      if (ok && quoteNo) processedNumbers.add(quoteNo)
      results.push({
        messageId: m.id, subject: m.subject, receivedDateTime: m.receivedDateTime,
        quoteNo, attachment: match.name, outcome: ok ? 'processed' : 'failed',
        reason: ok ? undefined : (stubJson?.error || `stub HTTP ${r.status}`),
        monday: stubJson?.monday ?? null,
      })
      processed++
    } catch (e: any) {
      results.push({ messageId: m.id, subject: m.subject, receivedDateTime: m.receivedDateTime, quoteNo, attachment: match.name, outcome: 'failed', reason: e?.message || String(e) })
    }
  }

  const summary = {
    mailbox, days, limit, dryRun,
    alreadyHadNumbers: processedNumbers.size,
    messagesScanned: messages.length,
    quoteCandidates: candidates.length,
    processed: results.filter(r => r.outcome === 'processed').length,
    alreadyDone: results.filter(r => r.outcome === 'skipped_already_done').length,
    noMatch: results.filter(r => r.outcome === 'skipped_no_match').length,
    failed: results.filter(r => r.outcome === 'failed').length,
    remaining: results.filter(r => r.outcome === 'skipped_limit').length,
    dryRunMatches: results.filter(r => r.outcome === 'dry_run').length,
  }

  return res.status(200).json({ ok: summary.failed === 0, summary, results })
}
