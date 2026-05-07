// lib/ap-inbox-pull.ts
//
// Shared inbox-pull pipeline used by both the portal-session endpoint
// (/api/ap/pull-inbox) and the bearer-auth automation endpoint
// (/api/ap/admin/automation, action=pull_inbox).
//
// Lifted out of the route handler so route handlers can stay thin and
// auth-specific. The pipeline itself is identical regardless of caller.

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import {
  listMessagesWithAttachments,
  listAttachmentMeta,
  getAttachmentBase64,
  markMessageAsRead,
  findFolderByDisplayName,
  moveMessageToFolder,
  GraphAttachmentMeta,
  GraphMessageSummary,
} from './microsoft-graph'
import { extractInvoiceFromPdf } from './ap-extraction'
import {
  insertInvoiceWithLines,
  uploadInvoicePdf,
  applyTriageAndResolve,
} from './ap-supabase'

const DEFAULT_MAILBOX = 'accounts@justautosmechanical.com.au'
const DEFAULT_CONCURRENCY = 4
const MAX_CONCURRENCY = 8

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

export interface IngestResult {
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

export interface PullInboxOptions {
  sinceDays?: number
}

export interface PullInboxOk {
  ok: true
  mailbox: string
  sinceDays: number
  concurrency: number
  markRead: { enabled: boolean; disabledByPermission: boolean }
  moveTo: {
    folderName: string | null
    folderResolved: boolean
    folderResolveError: string | null
    disabledByPermission: boolean
  }
  summary: {
    scanned: number
    ingested: number
    duplicates: number
    skipped: number
    failed: number
    markedRead: number
    moved: number
  }
  results: IngestResult[]
}

export interface PullInboxError {
  ok: false
  status: number   // suggested HTTP status: 500 internal, 502 upstream
  error: string
  detail?: string
  mailbox?: string
  hint?: string
}

export type PullInboxResponse = PullInboxOk | PullInboxError

function readConcurrency(): number {
  const raw = process.env.AP_INBOX_PULL_CONCURRENCY
  if (!raw) return DEFAULT_CONCURRENCY
  const n = parseInt(raw, 10)
  if (!Number.isFinite(n) || n < 1) return DEFAULT_CONCURRENCY
  return Math.min(n, MAX_CONCURRENCY)
}

function readMarkReadEnabled(): boolean {
  const raw = (process.env.AP_INBOX_MARK_READ || 'true').toLowerCase().trim()
  return raw !== 'false' && raw !== '0' && raw !== 'no'
}

export async function runInboxPull(opts: PullInboxOptions = {}): Promise<PullInboxResponse> {
  const days = Math.max(1, Math.min(Number(opts.sinceDays) || 30, 90))
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
    return {
      ok: false,
      status: 502,
      error: 'Graph mailbox listing failed',
      detail,
      mailbox,
      hint: 'Check Vercel function logs for the full Graph response. Common causes: mailbox does not exist or is unlicensed, Mail.Read application permission not granted/admin-consented, or an ApplicationAccessPolicy restricting which mailboxes the app can read.',
    }
  }

  if (messages.length === 0) {
    return {
      ok: true,
      mailbox,
      sinceDays: days,
      concurrency,
      markRead: { enabled: markReadEnabled, disabledByPermission: false },
      moveTo: {
        folderName: processedFolderName || null,
        folderResolved: false,
        folderResolveError: null,
        disabledByPermission: false,
      },
      summary: { scanned: 0, ingested: 0, duplicates: 0, skipped: 0, failed: 0, markedRead: 0, moved: 0 },
      results: [],
    }
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
        return {
          ok: false,
          status: 500,
          error: `Existing-message lookup failed: ${error.message}`,
          mailbox,
        }
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

  async function processMessage(msg: GraphMessageSummary): Promise<IngestResult> {
    const base = {
      messageId: msg.id,
      receivedDateTime: msg.receivedDateTime,
      subject: msg.subject,
      from: msg.from,
    }

    if (alreadyProcessed.has(msg.id)) {
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

  const summary = {
    scanned:    messages.length,
    ingested:   results.filter(r => r.status === 'ingested').length,
    duplicates: results.filter(r => r.status === 'duplicate').length,
    skipped:    results.filter(r => r.status === 'skipped').length,
    failed:     results.filter(r => r.status === 'failed').length,
    markedRead: results.filter(r => r.markedRead).length,
    moved:      results.filter(r => r.moved).length,
  }

  return {
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
  }
}
