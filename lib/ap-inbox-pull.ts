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
import {
  extractInvoiceFromPdf,
  extractInvoiceFromImage,
  SUPPORTED_IMAGE_MEDIA_TYPES,
  type SupportedImageMediaType,
} from './ap-extraction'
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

  // ── Step 2: pre-fetch already-ingested (message, attachment) pairs ──
  //
  // Two sets cover the two eras of rows in the table:
  //   - legacyMessages: emails ingested before migration 021 — those rows
  //     have graph_message_id but graph_attachment_id IS NULL because the
  //     old code only ever processed attachment[0]. We treat the whole
  //     message as "already done" so we don't double-create the row.
  //   - processedAttachments: post-021 rows, dedupe key is the pair.
  const c = sb()
  const messageIds = messages.map(m => m.id)
  const legacyMessages = new Set<string>()
  const processedAttachments = new Set<string>()
  {
    const chunkSize = 100
    for (let i = 0; i < messageIds.length; i += chunkSize) {
      const chunk = messageIds.slice(i, i + chunkSize)
      const { data, error } = await c
        .from('ap_invoices')
        .select('graph_message_id, graph_attachment_id')
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
        const mid = row.graph_message_id
        const aid = row.graph_attachment_id
        if (!mid) continue
        if (aid) processedAttachments.add(`${mid}|${aid}`)
        else     legacyMessages.add(mid)
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

  // Classify a Graph attachment as PDF, supported image, HEIC (skip with
  // reason), or "other" (silently ignored — signature logos, .eml, .xml).
  type Classification =
    | { kind: 'pdf' }
    | { kind: 'image'; mediaType: SupportedImageMediaType }
    | { kind: 'heic' }
    | { kind: 'other' }

  function classifyAttachment(a: GraphAttachmentMeta): Classification {
    const name = (a.name || '').toLowerCase()
    const ct = (a.contentType || '').toLowerCase()
    if (ct === 'application/pdf' || /\.pdf$/i.test(name)) return { kind: 'pdf' }
    if (ct === 'image/heic' || ct === 'image/heif' || /\.(heic|heif)$/i.test(name)) return { kind: 'heic' }
    const supported = SUPPORTED_IMAGE_MEDIA_TYPES.find(t => t === ct)
                   ?? imageMediaTypeFromName(name)
    if (supported) return { kind: 'image', mediaType: supported }
    return { kind: 'other' }
  }

  function imageMediaTypeFromName(lowerName: string): SupportedImageMediaType | null {
    if (/\.(jpe?g)$/i.test(lowerName)) return 'image/jpeg'
    if (/\.png$/i.test(lowerName))     return 'image/png'
    if (/\.gif$/i.test(lowerName))     return 'image/gif'
    if (/\.webp$/i.test(lowerName))    return 'image/webp'
    return null
  }

  function extensionForMediaType(m: SupportedImageMediaType): string {
    switch (m) {
      case 'image/jpeg': return 'jpg'
      case 'image/png':  return 'png'
      case 'image/gif':  return 'gif'
      case 'image/webp': return 'webp'
    }
  }

  async function processMessage(msg: GraphMessageSummary): Promise<IngestResult[]> {
    const base = {
      messageId: msg.id,
      receivedDateTime: msg.receivedDateTime,
      subject: msg.subject,
      from: msg.from,
    }

    // Legacy single-attachment row exists for this email — treat the whole
    // message as already-processed to avoid re-ingesting attachment[0].
    if (legacyMessages.has(msg.id)) {
      const markedRead = await tryMarkRead(msg.id)
      const moved      = await tryMove(msg.id)
      return [{ ...base, attachmentName: '', status: 'duplicate', reason: 'Already ingested', markedRead, moved }]
    }

    let attachments: GraphAttachmentMeta[]
    try {
      attachments = await listAttachmentMeta(mailbox, msg.id)
    } catch (e: any) {
      return [{ ...base, attachmentName: '', status: 'failed', reason: `Attachment list failed: ${e?.message || e}` }]
    }

    // Build the list of attachments we'll actually try to ingest, plus a
    // separate bucket of "show this to staff so they know we saw it" skips.
    type IngestableClassification =
      | { kind: 'pdf' }
      | { kind: 'image'; mediaType: SupportedImageMediaType }
    type Candidate = { att: GraphAttachmentMeta; classification: IngestableClassification }
    const candidates: Candidate[] = []
    const skipped:   IngestResult[] = []
    for (const a of attachments) {
      const classification = classifyAttachment(a)
      if (classification.kind === 'pdf' || classification.kind === 'image') {
        candidates.push({ att: a, classification })
      } else if (classification.kind === 'heic') {
        skipped.push({
          ...base,
          attachmentName: a.name,
          status: 'skipped',
          reason: 'HEIC/HEIF not supported — convert to JPG/PNG and resend',
        })
      }
      // 'other' is intentionally invisible (signature logos, .eml, etc.).
    }

    if (candidates.length === 0) {
      return skipped.length > 0
        ? skipped
        : [{ ...base, attachmentName: '', status: 'skipped', reason: 'No PDF or image attachments' }]
    }

    const results: IngestResult[] = [...skipped]
    let ingestedAny = false

    for (const { att, classification } of candidates) {
      const dedupeKey = `${msg.id}|${att.id}`
      if (processedAttachments.has(dedupeKey)) {
        results.push({ ...base, attachmentName: att.name, status: 'duplicate', reason: 'Already ingested' })
        continue
      }

      let fileBase64: string
      try {
        fileBase64 = await getAttachmentBase64(mailbox, msg.id, att.id)
      } catch (e: any) {
        results.push({ ...base, attachmentName: att.name, status: 'failed', reason: `Download failed: ${e?.message || e}` })
        continue
      }

      const fileBytes = Buffer.from(fileBase64, 'base64')

      let extraction
      let fileExtension: string
      let storageContentType: string
      try {
        if (classification.kind === 'pdf') {
          if (fileBytes.length < 100 || !fileBytes.subarray(0, 5).toString('ascii').startsWith('%PDF-')) {
            results.push({ ...base, attachmentName: att.name, status: 'failed', reason: 'Decoded bytes are not a valid PDF' })
            continue
          }
          extraction = await extractInvoiceFromPdf(fileBase64)
          fileExtension = 'pdf'
          storageContentType = 'application/pdf'
        } else {
          extraction = await extractInvoiceFromImage(fileBase64, classification.mediaType)
          fileExtension = extensionForMediaType(classification.mediaType)
          storageContentType = classification.mediaType
        }
      } catch (e: any) {
        results.push({ ...base, attachmentName: att.name, status: 'failed', reason: `Parse failed: ${e?.message || e}` })
        continue
      }

      let inserted
      try {
        inserted = await insertInvoiceWithLines({
          source: 'email',
          pdfFilename: att.name,
          fileExtension,
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
        results.push({ ...base, attachmentName: att.name, status: 'failed', reason: `DB insert failed: ${e?.message || e}` })
        continue
      }

      {
        const { error: tagErr } = await c
          .from('ap_invoices')
          .update({ graph_message_id: msg.id, graph_attachment_id: att.id })
          .eq('id', inserted.id)
        if (tagErr) {
          console.error(`Tag graph ids failed for ${inserted.id}: ${tagErr.message}`)
        }
      }

      try {
        await uploadInvoicePdf(inserted.pdfStoragePath, fileBytes, storageContentType)
      } catch (e: any) {
        console.error(`File upload failed for ${inserted.id}: ${e?.message || e}`)
      }

      try {
        await applyTriageAndResolve(inserted.id)
      } catch (e: any) {
        console.error(`Triage failed for ${inserted.id}: ${e?.message || e}`)
      }

      processedAttachments.add(dedupeKey)
      ingestedAny = true

      results.push({
        ...base,
        attachmentName: att.name,
        status: 'ingested',
        invoiceId: inserted.id,
        vendor: extraction.invoice.vendor?.name || null,
        total: extraction.invoice.totals?.totalIncGst ?? null,
      })
    }

    // Mark-read + move once per message. Apply if anything was ingested
    // or all candidates turned out to be duplicates (i.e. this email is
    // fully accounted for). If anything failed transiently, leave the
    // email in inbox so staff can see and we'll retry next pull.
    const candidateResults = results.slice(skipped.length)
    const allDuplicate = candidateResults.length > 0 && candidateResults.every(r => r.status === 'duplicate')
    const anyFailed    = candidateResults.some(r => r.status === 'failed')
    const shouldClose  = ingestedAny || (allDuplicate && !anyFailed)
    if (shouldClose && results.length > 0) {
      const markedRead = await tryMarkRead(msg.id)
      const moved      = await tryMove(msg.id)
      // Stamp once per message (on the last result) so the summary
      // counters don't double-count mark/move across attachments.
      const last = results[results.length - 1]
      results[results.length - 1] = { ...last, markedRead, moved }
    }

    return results
  }

  const resultGroups: IngestResult[][] = new Array(messages.length)
  let nextIndex = 0

  async function workerLoop(): Promise<void> {
    while (true) {
      const idx = nextIndex++
      if (idx >= messages.length) return
      try {
        resultGroups[idx] = await processMessage(messages[idx])
      } catch (e: any) {
        const m = messages[idx]
        resultGroups[idx] = [{
          messageId: m.id,
          receivedDateTime: m.receivedDateTime,
          subject: m.subject,
          from: m.from,
          attachmentName: '',
          status: 'failed',
          reason: `Unexpected worker error: ${e?.message || e}`,
        }]
      }
    }
  }

  const workerCount = Math.min(concurrency, messages.length)
  const workers = Array.from({ length: workerCount }, () => workerLoop())
  await Promise.all(workers)

  const results: IngestResult[] = resultGroups.flat()

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
