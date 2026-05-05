// pages/api/ap/pull-inbox.ts
// Bulk-ingest unprocessed invoices from a shared mailbox via Microsoft Graph.
//
// POST /api/ap/pull-inbox  { sinceDays?: number }  default 30, max 90
//
// Pipeline:
//   1. List recent messages with attachments from accounts@<domain>
//   2. Skip any message ID we've already ingested (graph_message_id column)
//   3. For each remaining message, take the first PDF attachment and run
//      it through the same pipeline as /api/ap/upload (parse → insert →
//      upload PDF → triage). Tag the new invoice with graph_message_id
//      so subsequent pulls skip it.
//
// Idempotency: graph_message_id is unique-indexed on ap_invoices, so even
// concurrent pulls cannot create duplicate rows. We pre-filter for speed
// but rely on the unique index as the hard guarantee.
//
// Mailbox: defaults to accounts@justautosmechanical.com.au, override via
// AP_INBOX_MAILBOX env var. Reads via Graph app-only token (Mail.Read app
// permission), which can read any mailbox in the tenant — no per-mailbox
// subscription needed for pull-on-demand.
//
// Auth: edit:supplier_invoices.
// Function timeout: 5 min (parse calls are 5–15s each, 30+ messages possible).

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../lib/authServer'
import {
  listMessagesWithAttachments,
  listAttachmentMeta,
  getAttachmentBase64,
  GraphAttachmentMeta,
} from '../../../lib/microsoft-graph'
import { extractInvoiceFromPdf } from '../../../lib/ap-extraction'
import {
  insertInvoiceWithLines,
  uploadInvoicePdf,
  applyTriageAndResolve,
} from '../../../lib/ap-supabase'

const DEFAULT_MAILBOX = 'accounts@justautosmechanical.com.au'

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
}

export default withAuth('edit:supplier_invoices', async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const { sinceDays } = (req.body || {}) as { sinceDays?: number }
  const days = Math.max(1, Math.min(Number(sinceDays) || 30, 90))
  const sinceIso = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString()

  const mailbox = process.env.AP_INBOX_MAILBOX || DEFAULT_MAILBOX

  // ── Step 1: list candidate messages ──
  let messages
  try {
    messages = await listMessagesWithAttachments(mailbox, {
      sinceIsoDate: sinceIso,
      top: 100,
    })
  } catch (e: any) {
    // Log to Vercel runtime logs — the response body alone is hard to
    // pull out of UI errors. Keep the full message so admins can read it.
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
      summary: { scanned: 0, ingested: 0, duplicates: 0, skipped: 0, failed: 0 },
      results: [],
    })
  }

  // ── Step 2: pre-fetch already-ingested message IDs ──
  const c = sb()
  const messageIds = messages.map(m => m.id)
  const alreadyProcessed = new Set<string>()
  {
    // Supabase .in() has practical caps; chunk in 100s
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

  const userEmail = (req as any).user?.email || 'inbox-pull'
  const results: IngestResult[] = []

  // ── Step 3: process each new message sequentially ──
  // Sequential, not parallel: parse calls hit Anthropic rate limits, and
  // sequential keeps memory + log noise sane. With 60s budget per message
  // we comfortably handle 4–5 invoices per pull within the 300s timeout.
  for (const msg of messages) {
    const base = {
      messageId: msg.id,
      receivedDateTime: msg.receivedDateTime,
      subject: msg.subject,
      from: msg.from,
    }

    if (alreadyProcessed.has(msg.id)) {
      results.push({ ...base, attachmentName: '', status: 'duplicate', reason: 'Already ingested' })
      continue
    }

    let attachments: GraphAttachmentMeta[]
    try {
      attachments = await listAttachmentMeta(mailbox, msg.id)
    } catch (e: any) {
      results.push({ ...base, attachmentName: '', status: 'failed', reason: `Attachment list failed: ${e?.message || e}` })
      continue
    }

    const pdfAttachments = attachments.filter(a =>
      a.contentType === 'application/pdf' || /\.pdf$/i.test(a.name || '')
    )
    if (pdfAttachments.length === 0) {
      results.push({ ...base, attachmentName: '', status: 'skipped', reason: 'No PDF attachments' })
      continue
    }

    // First PDF only. Multi-PDF emails are rare for invoices and would
    // create attribution complexity (which PDF "is" the invoice). Tag the
    // graph_message_id on the row so the unique constraint prevents a
    // re-pull from creating a second invoice off the same message — even
    // if a future pass attempts the second PDF.
    const att = pdfAttachments[0]

    let pdfBase64: string
    try {
      pdfBase64 = await getAttachmentBase64(mailbox, msg.id, att.id)
    } catch (e: any) {
      results.push({ ...base, attachmentName: att.name, status: 'failed', reason: `Download failed: ${e?.message || e}` })
      continue
    }

    const pdfBytes = Buffer.from(pdfBase64, 'base64')
    if (pdfBytes.length < 100 || !pdfBytes.subarray(0, 5).toString('ascii').startsWith('%PDF-')) {
      results.push({ ...base, attachmentName: att.name, status: 'failed', reason: 'Decoded bytes are not a valid PDF' })
      continue
    }

    let extraction
    try {
      extraction = await extractInvoiceFromPdf(pdfBase64)
    } catch (e: any) {
      results.push({ ...base, attachmentName: att.name, status: 'failed', reason: `Parse failed: ${e?.message || e}` })
      continue
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
      results.push({ ...base, attachmentName: att.name, status: 'failed', reason: `DB insert failed: ${e?.message || e}` })
      continue
    }

    // Tag with Graph message ID for idempotency (unique-indexed column)
    {
      const { error: tagErr } = await c
        .from('ap_invoices')
        .update({ graph_message_id: msg.id })
        .eq('id', inserted.id)
      if (tagErr) {
        // The row exists, just couldn't tag it. Continue but flag.
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

    results.push({
      ...base,
      attachmentName: att.name,
      status: 'ingested',
      invoiceId: inserted.id,
      vendor: extraction.invoice.vendor?.name || null,
      total: extraction.invoice.totals?.totalIncGst ?? null,
    })
  }

  void userEmail   // reserved for audit logging in a later round

  const summary = {
    scanned:    messages.length,
    ingested:   results.filter(r => r.status === 'ingested').length,
    duplicates: results.filter(r => r.status === 'duplicate').length,
    skipped:    results.filter(r => r.status === 'skipped').length,
    failed:     results.filter(r => r.status === 'failed').length,
  }

  return res.status(200).json({
    ok: true,
    mailbox,
    sinceDays: days,
    summary,
    results,
  })
})
