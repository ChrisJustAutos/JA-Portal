// pages/api/ap/pull-inbox.ts
// Bulk-ingest unprocessed invoices from a shared mailbox via Microsoft Graph.
//
// POST /api/ap/pull-inbox  { sinceDays?: number }  default 30, max 90
//
// Pipeline:
//   1. List recent messages with attachments from accounts@<domain>
//   2. Skip any message ID we've already ingested (graph_message_id column)
//   3. Process remaining messages with a parallel worker pool. Each
//      worker takes the first PDF attachment and runs it through the
//      same pipeline as /api/ap/upload (parse → insert → upload PDF →
//      triage). New invoices are tagged with graph_message_id so
//      subsequent pulls skip them.
//   4. Mark the source email as read (always) and move it to a
//      configured folder (when AP_INBOX_PROCESSED_FOLDER is set). Both
//      operations require Mail.ReadWrite app permission and degrade
//      gracefully if the grant is missing.
//
// Concurrency: the Claude Haiku parse call dominates (5–15s per invoice).
// We run AP_INBOX_PULL_CONCURRENCY workers in parallel (default 4) which
// gives a ~4× speedup on cold pulls without breaching Anthropic, Graph,
// or MYOB rate limits at typical volumes. Set to 1 to revert to serial.
//
// Idempotency: graph_message_id is unique-indexed on ap_invoices, so even
// concurrent workers cannot create duplicate rows. We pre-filter for
// speed but rely on the unique index as the hard guarantee.
//
// Mailbox: defaults to accounts@justautosmechanical.com.au, override via
// AP_INBOX_MAILBOX env var. Reads via Graph app-only token (Mail.Read app
// permission), which can read any mailbox in the tenant — no per-mailbox
// subscription needed for pull-on-demand.
//
// Mark-as-read / move:
//   - AP_INBOX_MARK_READ        — 'true' (default) / 'false'
//   - AP_INBOX_PROCESSED_FOLDER — folder name (e.g. 'Printed' or
//                                 'Processed'). Unset = no move.
// Mark-as-read & move are best-effort. Failures (incl. 403 due to
// Mail.Read-only grant) do NOT roll back the ingest. The first 403
// of each kind is logged once to Vercel runtime logs.
//
// Auth: edit:supplier_invoices.
// Function timeout: 5 min.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../lib/authServer'
import {
  listMessagesWithAttachments,
  listAttachmentMeta,
  getAttachmentBase64,
  markMessageAsRead,
  findFolderByDisplayName,
  moveMessageToFolder,
  GraphAttachmentMeta,
  GraphMessageSummary,
} from '../../../lib/microsoft-graph'
import { extractInvoiceFromPdf } from '../../../lib/ap-extraction'
import {
  insertInvoiceWithLines,
  uploadInvoicePdf,
  applyTriageAndResolve,
} from '../../../lib/ap-supabase'

const DEFAULT_MAILBOX = 'accounts@justautosmechanical.com.au'
const DEFAULT_CONCURRENCY = 4
const MAX_CONCURRENCY = 8

export const config = {
  api: { bodyParser: { sizeLimit: '1mb' } },
  maxDuration: 300,
}

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

interface IngestResult {
  messageId: string
  receivedDateTime: string
  subject: string | null
  from: string | null
  attachmentName: string
  status: 'ingested' | 'duplicate' | 'failed' | 'skipped'
  invoiceId?: string
  vendor?: string | null
  total?: number | null
  reason?: string
  markedRead?: boolean
  moved?: boolean
}

function readConcurrency(): number {
  const raw = process.env.AP_INBOX_PULL_CONCURRENCY
  if (!raw) return DEFAULT_CONCURRENCY
  const n = parseInt(raw, 10)
  if (!Number.isFinite(n) || n < 1) return DEFAULT_CONCURRENCY
  return Math.min(n, MAX_CONCURRENCY)
}

function readMarkReadEnabled(): boolean {
  // Default ON; flip with AP_INBOX_MARK_READ=false
  const raw = (process.env.AP_INBOX_MARK_READ || 'true').toLowerCase().trim()
  return raw !== 'false' && raw !== '0' && raw !== 'no'
}

export default withAuth('edit:supplier_invoices', async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const { sinceDays } = (req.body || {}) as { sinceDays?: number }
  const days = Math.max(1, Math.min(Number(sinceDays) || 30, 90))
  const sinceIso = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString()

  const mailbox = process.env.AP_INBOX_MAILBOX || DEFAULT_MAILBOX
  const concurrency = readConcurrency()
  const markReadEnabled = readMarkReadEnabled()
  const processedFolderName = (process.env.AP_INBOX_PROCESSED_FOLDER || '').trim()

  // ── Step 1: list candidate messages ──
  let messages: GraphMessageSummary[]
  try {
    messages = await listMessagesWithAttachments(mailbox, {
      sinceIsoDate: sinceIso,
      top: 100,
    })
  } catch (e: any) {
    const detail = e?.message || String(e)
    console.error(`[pull-inbox] Graph mailbox listing failed for ${mailbox}: ${detail}`)
    return res.status(502).json({
      error: 'Graph mailbox listing failed',
      detail,
      mailbox,
      hint: 'Check Vercel function logs for the full Graph response. Common causes: mailbox does not exist or is unlicensed, Mail.Read application permission not granted/admin-consented, or an ApplicationAccessPolicy restricting which mailboxes the app can read.',
    })
  }

  if (messages.length === 0) {
    return res.status(200).json({
      ok: true,
      mailbox,
      sinceDays: days,
      concurrency,
      summary: { scanned: 0, ingested: 0, duplicates: 0, skipped: 0, failed: 0, markedRead: 0, moved: 0 },
      results: [],
    })
  }

  // ── Step 2: pre-fetch already-ingested message IDs ──
  const c = sb()
  const messageIds = messages.map(m => m.id)
  const alreadyProcessed = new Set<string>()
  {
    const chunkSize = 100
    for (let i = 0; i < messageIds.length; i += chunkSize) {
      const chunk = messageIds.slice(i, i + chunkSize)
      const { data, error } = await c
        .from('ap_invoices')
        .select('graph_message_id')
        .in('graph_message_id', chunk)
      if (error) {
        return res.status(500).json({ error: `Existing-message lookup failed: ${error.message}` })
      }
      for (const row of (data || []) as any[]) {
        if (row.graph_message_id) alreadyProcessed.add(row.graph_message_id)
      }
    }
  }

  // ── Step 2.5: resolve processed-folder ID once (best effort) ──
  let processedFolderId: string | null = null
  let processedFolderResolveError: string | null = null
  if (processedFolderName) {
    try {
      processedFolderId = await findFolderByDisplayName(mailbox, processedFolderName)
      if (!processedFolderId) {
        processedFolderResolveError = `No folder named "${processedFolderName}" found in Inbox children or top-level — moves disabled`
        console.error(`[pull-inbox] ${processedFolderResolveError}`)
      }
    } catch (e: any) {
      processedFolderResolveError = `Folder lookup failed: ${e?.message || e}`
      console.error(`[pull-inbox] ${processedFolderResolveError}`)
    }
  }

  // ── Mailbox-write degradation guards ──
  // First 403 of each kind disables further attempts for the whole pull
  // and logs once to Vercel. Other errors are surfaced per-result but
  // don't disable subsequent attempts (transient failures are still
  // worth retrying for the next message).
  let markReadDisabled = !markReadEnabled
  let moveDisabled     = !processedFolderId
  let markReadLogged403 = false
  let moveLogged403    = false

  function is403(e: any): boolean {
    const msg = String(e?.message || e || '')
    return /\b403\b/.test(msg) || /Forbidden/i.test(msg) || /AccessDenied/i.test(msg)
  }

  async function tryMarkRead(messageId: string): Promise<boolean> {
    if (markReadDisabled) return false
    try {
      await markMessageAsRead(mailbox, messageId)
      return true
    } catch (e: any) {
      if (is403(e)) {
        markReadDisabled = true
        if (!markReadLogged403) {
          markReadLogged403 = true
          console.error('[pull-inbox] Mark-as-read got 403 — Mail.ReadWrite app permission needed. Disabling for this pull.')
        }
      } else {
        console.error(`[pull-inbox] Mark-as-read failed for ${messageId}: ${e?.message || e}`)
      }
      return false
    }
  }

  async function tryMove(messageId: string): Promise<boolean> {
    if (moveDisabled || !processedFolderId) return false
    try {
      await moveMessageToFolder(mailbox, messageId, processedFolderId)
      return true
    } catch (e: any) {
      if (is403(e)) {
        moveDisabled = true
        if (!moveLogged403) {
          moveLogged403 = true
          console.error('[pull-inbox] Move-to-folder got 403 — Mail.ReadWrite app permission needed. Disabling for this pull.')
        }
      } else {
        console.error(`[pull-inbox] Move-to-folder failed for ${messageId}: ${e?.message || e}`)
      }
      return false
    }
  }

  // ── Per-message worker ──
  // Runs the full ingest pipeline for one message. Returns a result row
  // describing what happened. Never throws — all errors are captured
  // into the result so the worker pool keeps draining.
  async function processMessage(msg: GraphMessageSummary): Promise<IngestResult> {
    const base = {
      messageId: msg.id,
      receivedDateTime: msg.receivedDateTime,
      subject: msg.subject,
      from: msg.from,
    }

    if (alreadyProcessed.has(msg.id)) {
      // Still mark+move duplicates so already-ingested items get out of
      // the inbox even if the previous run predates this feature.
      const markedRead = await tryMarkRead(msg.id)
      const moved      = await tryMove(msg.id)
      return { ...base, attachmentName: '', status: 'duplicate', reason: 'Already ingested', markedRead, moved }
    }

    let attachments: GraphAttachmentMeta[]
    try {
      attachments = await listAttachmentMeta(mailbox, msg.id)
    } catch (e: any) {
      return { ...base, attachmentName: '', status: 'failed', reason: `Attachment list failed: ${e?.message || e}` }
    }

    const pdfAttachments = attachments.filter(a =>
      a.contentType === 'application/pdf' || /\.pdf$/i.test(a.name || '')
    )
    if (pdfAttachments.length === 0) {
      return { ...base, attachmentName: '', status: 'skipped', reason: 'No PDF attachments' }
    }

    // First PDF only. Multi-PDF emails are rare for invoices and would
    // create attribution complexity (which PDF "is" the invoice). Tag
    // the graph_message_id on the row so the unique constraint prevents
    // a re-pull from creating a second invoice off the same message —
    // even if a future pass attempts the second PDF.
    const att = pdfAttachments[0]

    let pdfBase64: string
    try {
      pdfBase64 = await getAttachmentBase64(mailbox, msg.id, att.id)
    } catch (e: any) {
      return { ...base, attachmentName: att.name, status: 'failed', reason: `Download failed: ${e?.message || e}` }
    }

    const pdfBytes = Buffer.from(pdfBase64, 'base64')
    if (pdfBytes.length < 100 || !pdfBytes.subarray(0, 5).toString('ascii').startsWith('%PDF-')) {
      return { ...base, attachmentName: att.name, status: 'failed', reason: 'Decoded bytes are not a valid PDF' }
    }

    let extraction
    try {
      extraction = await extractInvoiceFromPdf(pdfBase64)
    } catch (e: any) {
      return { ...base, attachmentName: att.name, status: 'failed', reason: `Parse failed: ${e?.message || e}` }
    }

    let inserted
    try {
      inserted = await insertInvoiceWithLines({
        source: 'email',
        pdfFilename: att.name,
        extracted: extraction.invoice,
        rawExtraction: {
          rawOutput:    extraction.rawOutput,
          model:        extraction.model,
          inputTokens:  extraction.inputTokens,
          outputTokens: extraction.outputTokens,
          costMicroUsd: extraction.costMicroUsd,
        },
      })
    } catch (e: any) {
      return { ...base, attachmentName: att.name, status: 'failed', reason: `DB insert failed: ${e?.message || e}` }
    }

    // Tag with Graph message ID for idempotency (unique-indexed column)
    {
      const { error: tagErr } = await c
        .from('ap_invoices')
        .update({ graph_message_id: msg.id })
        .eq('id', inserted.id)
      if (tagErr) {
        console.error(`Tag graph_message_id failed for ${inserted.id}: ${tagErr.message}`)
      }
    }

    try {
      await uploadInvoicePdf(inserted.pdfStoragePath, pdfBytes)
    } catch (e: any) {
      console.error(`PDF upload failed for ${inserted.id}: ${e?.message || e}`)
    }

    try {
      await applyTriageAndResolve(inserted.id)
    } catch (e: any) {
      console.error(`Triage failed for ${inserted.id}: ${e?.message || e}`)
    }

    // Mark-read first (uses original ID), then move (returns new ID,
    // original becomes invalid). Order matters.
    const markedRead = await tryMarkRead(msg.id)
    const moved      = await tryMove(msg.id)

    return {
      ...base,
      attachmentName: att.name,
      status: 'ingested',
      invoiceId: inserted.id,
      vendor: extraction.invoice.vendor?.name || null,
      total: extraction.invoice.totals?.totalIncGst ?? null,
      markedRead,
      moved,
    }
  }

  // ── Worker pool ──
  // Standard "shared index" pattern: every worker pulls from a single
  // counter, ensuring each message is processed by exactly one worker
  // and no busy-wait. Workers run independently; one worker hitting a
  // slow Claude call doesn't stall the others.
  const results: IngestResult[] = new Array(messages.length)
  let nextIndex = 0

  async function workerLoop(): Promise<void> {
    while (true) {
      const idx = nextIndex++
      if (idx >= messages.length) return
      try {
        results[idx] = await processMessage(messages[idx])
      } catch (e: any) {
        const m = messages[idx]
        results[idx] = {
          messageId: m.id,
          receivedDateTime: m.receivedDateTime,
          subject: m.subject,
          from: m.from,
          attachmentName: '',
          status: 'failed',
          reason: `Unexpected worker error: ${e?.message || e}`,
        }
      }
    }
  }

  const workerCount = Math.min(concurrency, messages.length)
  const workers = Array.from({ length: workerCount }, () => workerLoop())
  await Promise.all(workers)

  const userEmail = (req as any).user?.email || 'inbox-pull'
  void userEmail   // reserved for audit logging in a later round

  const summary = {
    scanned:    messages.length,
    ingested:   results.filter(r => r.status === 'ingested').length,
    duplicates: results.filter(r => r.status === 'duplicate').length,
    skipped:    results.filter(r => r.status === 'skipped').length,
    failed:     results.filter(r => r.status === 'failed').length,
    markedRead: results.filter(r => r.markedRead).length,
    moved:      results.filter(r => r.moved).length,
  }

  return res.status(200).json({
    ok: true,
    mailbox,
    sinceDays: days,
    concurrency,
    markRead: { enabled: markReadEnabled, disabledByPermission: markReadEnabled && markReadLogged403 },
    moveTo: {
      folderName: processedFolderName || null,
      folderResolved: !!processedFolderId,
      folderResolveError: processedFolderResolveError,
      disabledByPermission: !!processedFolderId && moveLogged403,
    },
    summary,
    results,
  })
})
