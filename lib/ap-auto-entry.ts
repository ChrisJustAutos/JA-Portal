// lib/ap-auto-entry.ts
//
// Automated invoice entry (VPS only, background). Reads supplier invoices from
// the VPS accounts inbox, FACT-CHECKS each one, and either:
//   • posts it straight to MYOB (tax-inclusive, no portal ap_invoices row) and
//     drops a success card in Slack, OR
//   • flags it in Slack with the reason and LEAVES the email for manual entry.
// Not-an-invoice attachments are skipped silently.
//
// Fact-check = the existing intake triage (pure triageInvoice) — supplier
// matched, all lines coded, high confidence, totals reconcile, has number +
// total + lines — PLUS a bank-details check against the MYOB supplier card.
//
// Reuses: postFoundInvoiceToMyob (the headless tax-inclusive poster built for
// the statement automation), tryAutoMatchSupplier, resolveLineAccount,
// triageInvoice, the Graph helpers, and lib/slack postWebhook. Dedup + audit in
// ap_auto_entry_log (migration 145) so a run never re-posts / re-flags an email.

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
  type ExtractedAPInvoice,
} from './ap-extraction'
import { tryAutoMatchSupplier } from './ap-myob-automatch'
import { getSupplierByUid, type CompanyFileLabel } from './ap-myob-lookup'
import { resolveLineAccount } from './ap-line-resolver'
import { triageInvoice } from './ap-supabase'
import { postFoundInvoiceToMyob } from './ap-myob-bill'
import { postWebhook } from './slack'
import { buildAutoEntryBlocks, type BankCheck } from './ap-auto-entry-slack'

const AP_BUCKET = 'ap-invoices'
const SIGNED_URL_TTL_SEC = 7 * 24 * 3600   // 7 days for the Slack "View invoice" link
const STAGE_CLEANUP_DAYS = 14

const ACTOR = (process.env.AP_AUTOMATION_ACTOR_ID || '9d09018b-f60b-429d-81e9-cf4bdc28a454').trim()

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

export const autoEntryEnabled = () => (process.env.AP_AUTO_ENTRY_ENABLED || 'false').toLowerCase().trim() === 'true'
function vpsMailbox(): string { return (process.env.AP_AUTO_ENTRY_MAILBOX || 'accounts@justautosmechanical.com.au').trim() }
function slackWebhook(): string | null { return (process.env.SLACK_WEBHOOK_AP_VPS || '').trim() || null }
// Once an invoice is entered into MYOB, its email is marked read and moved out
// of the Inbox into this folder so the inbox only shows what still needs a human.
// Flagged / not-posted emails are left in place. Set to '' to disable the move.
function processedFolder(): string { return (process.env.AP_AUTO_ENTRY_PROCESSED_FOLDER ?? 'Read /Printed').trim() }

export type AutoEntryOutcomeKind = 'posted' | 'flagged' | 'skipped_not_invoice' | 'error'

export interface AutoEntryItem {
  messageId: string
  attachmentId: string
  attachmentName: string
  supplierName: string | null
  invoiceNumber: string | null
  amount: number | null
  outcome: AutoEntryOutcomeKind
  bankCheck: BankCheck
  failReasons: string[]
  billUid?: string | null
  adopted?: boolean
  error?: string
  // dry-run preview of the Slack card
  slackText?: string
}

export interface AutoEntryOutcome {
  enabled: boolean
  dryRun: boolean
  mailbox: string
  scannedMessages: number
  skippedDuplicates: number
  processed: AutoEntryItem[]
}

const money = (n: number | null | undefined) =>
  n == null || !isFinite(n) ? '—' : `$${Number(n).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

// PDF or supported image → how to parse it. null = not an ingestible attachment.
function classify(att: GraphAttachmentMeta): 'pdf' | SupportedImageMediaType | null {
  const ct = (att.contentType || '').toLowerCase()
  const name = (att.name || '').toLowerCase()
  if (ct === 'application/pdf' || /\.pdf$/.test(name)) return 'pdf'
  const img = SUPPORTED_IMAGE_MEDIA_TYPES.find(m => m === ct)
  if (img) return img
  if (/\.(jpe?g|png|gif|webp)$/.test(name)) {
    if (/\.png$/.test(name)) return 'image/png'
    if (/\.gif$/.test(name)) return 'image/gif'
    if (/\.webp$/.test(name)) return 'image/webp'
    return 'image/jpeg'
  }
  return null
}

// Compare the invoice's printed bank details against the MYOB supplier card.
function bankCheck(
  invoiceBank: ExtractedAPInvoice['bankDetails'],
  cardBank: { bsb: string | null; accountNumber: string | null; accountName: string | null } | null,
): BankCheck {
  const iHas = !!(invoiceBank && (invoiceBank.bsb || invoiceBank.accountNumber))
  if (!iHas) return 'no-invoice-bank'
  const cHas = !!(cardBank && (cardBank.bsb || cardBank.accountNumber))
  if (!cHas) return 'unverified'
  const bsbOk = !invoiceBank!.bsb || !cardBank!.bsb || invoiceBank!.bsb === cardBank!.bsb
  const accOk = !invoiceBank!.accountNumber || !cardBank!.accountNumber || invoiceBank!.accountNumber === cardBank!.accountNumber
  return (bsbOk && accOk) ? 'match' : 'mismatch'
}

export async function runAutoEntry(opts: { dryRun?: boolean; sinceDays?: number; maxMessages?: number } = {}): Promise<AutoEntryOutcome> {
  const dryRun = !!opts.dryRun
  const enabled = autoEntryEnabled()
  const mailbox = vpsMailbox()
  const companyFile: CompanyFileLabel = 'VPS'
  const sinceDays = Math.max(1, Math.min(Number(opts.sinceDays) || 7, 60))
  const maxMessages = Math.max(1, Math.min(Number(opts.maxMessages) || 40, 100))
  const sinceIso = new Date(Date.now() - sinceDays * 86400_000).toISOString()
  const c = sb()

  const out: AutoEntryOutcome = { enabled, dryRun, mailbox, scannedMessages: 0, skippedDuplicates: 0, processed: [] }

  // Master switch: do nothing (not even scan) unless enabled OR this is a dry-run preview.
  if (!enabled && !dryRun) return out

  let messages: GraphMessageSummary[] = []
  try {
    messages = await listMessagesWithAttachments(mailbox, { sinceIsoDate: sinceIso, top: maxMessages })
  } catch (e: any) {
    throw new Error(`Could not read ${mailbox}: ${e?.message || e}`)
  }
  out.scannedMessages = messages.length

  // Resolve the "filed" folder once (best-effort; null → we just mark read).
  let processedFolderId: string | null = null
  const folderName = processedFolder()
  if (folderName && !dryRun) {
    try { processedFolderId = await findFolderByDisplayName(mailbox, folderName) } catch { /* leave null */ }
    if (!processedFolderId) console.warn(`[ap-auto-entry] folder "${folderName}" not found in ${mailbox} — posted emails will be marked read but not moved`)
  }

  for (const msg of messages) {
    let atts: GraphAttachmentMeta[]
    try { atts = await listAttachmentMeta(mailbox, msg.id) } catch { continue }
    let anyPosted = false
    for (const att of atts) {
      const kind = classify(att)
      if (!kind) continue

      // Dedup: processed this (message, attachment) already?
      const { data: seen } = await c.from('ap_auto_entry_log')
        .select('id').eq('graph_message_id', msg.id).eq('graph_attachment_id', att.id).maybeSingle()
      if (seen) { out.skippedDuplicates++; continue }

      try {
        const item = await processAttachment(c, { mailbox, companyFile, msg, att, kind, dryRun })
        if (item) {
          out.processed.push(item)
          if (item.outcome === 'posted') anyPosted = true
        }
      } catch (e: any) {
        const error = (e?.message || String(e)).slice(0, 300)
        out.processed.push({ messageId: msg.id, attachmentId: att.id, attachmentName: att.name || '', supplierName: null, invoiceNumber: null, amount: null, outcome: 'error', bankCheck: 'skipped', failReasons: [], error })
        if (!dryRun) await logRow(c, { mailbox, companyFile, msg, att }, { outcome: 'error', error })
      }
    }

    // Invoice entered → file the email away (read + move out of Inbox). Only on
    // a real posting; flagged / left emails stay put for manual handling. Move
    // LAST (it invalidates the message id) and best-effort (needs Mail.ReadWrite).
    if (anyPosted && !dryRun) {
      try { await markMessageAsRead(mailbox, msg.id) } catch (e: any) { console.warn(`[ap-auto-entry] mark-read failed for ${msg.id}: ${e?.message || e}`) }
      if (processedFolderId) {
        try { await moveMessageToFolder(mailbox, msg.id, processedFolderId) } catch (e: any) { console.warn(`[ap-auto-entry] move failed for ${msg.id}: ${e?.message || e}`) }
      }
    }
  }

  if (!dryRun) { try { await cleanupStaged(c) } catch { /* best effort */ } }
  return out
}

async function processAttachment(
  c: SupabaseClient,
  ctx: { mailbox: string; companyFile: CompanyFileLabel; msg: GraphMessageSummary; att: GraphAttachmentMeta; kind: 'pdf' | SupportedImageMediaType; dryRun: boolean },
): Promise<AutoEntryItem | null> {
  const { mailbox, companyFile, msg, att, kind, dryRun } = ctx
  const base = { messageId: msg.id, attachmentId: att.id, attachmentName: att.name || '' }

  const b64 = await getAttachmentBase64(mailbox, msg.id, att.id)
  const bytes = Buffer.from(b64, 'base64')

  // Extract. A parse failure or a non-invoice (no number AND no total) is not
  // flagged — just logged as skipped so we don't spam Slack with random PDFs.
  let extracted: ExtractedAPInvoice
  try {
    if (kind === 'pdf') {
      if (bytes.length < 100 || !bytes.subarray(0, 5).toString('ascii').startsWith('%PDF-')) throw new Error('not a PDF')
      extracted = (await extractInvoiceFromPdf(b64)).invoice
    } else {
      extracted = (await extractInvoiceFromImage(b64, kind)).invoice
    }
  } catch {
    if (!dryRun) await logRow(c, { mailbox, companyFile, msg, att }, { outcome: 'skipped_not_invoice' })
    return { ...base, supplierName: null, invoiceNumber: null, amount: null, outcome: 'skipped_not_invoice', bankCheck: 'skipped', failReasons: [] }
  }

  const total = extracted.totals.totalIncGst
  if (!extracted.invoiceNumber || total == null) {
    if (!dryRun) await logRow(c, { mailbox, companyFile, msg, att }, { outcome: 'skipped_not_invoice' })
    return { ...base, supplierName: extracted.vendor?.name || null, invoiceNumber: extracted.invoiceNumber, amount: total, outcome: 'skipped_not_invoice', bankCheck: 'skipped', failReasons: [] }
  }

  // Resolve supplier + coding for the fact-check.
  const match = await tryAutoMatchSupplier(extracted.vendor?.name || null, extracted.vendor?.abn || null, companyFile).catch(() => null)
  const supplierUid = match?.supplier.uid || null
  const supplierName = match?.supplier.name || extracted.vendor?.name || null
  const cardBank = match?.supplier.bank || null

  let hasResolvedAccount = !!match?.supplier.defaultExpenseAccount?.uid
  let codingSummary: string | null = match?.supplier.defaultExpenseAccount?.name || null
  if (!hasResolvedAccount && supplierUid && extracted.lineItems.length > 0) {
    let allCoded = true
    for (const li of extracted.lineItems) {
      const desc = [li.partNumber, li.description].filter(Boolean).join(' — ')
      const r = await resolveLineAccount(c, { supplier_uid: supplierUid, myob_company_file: companyFile, description: desc, part_number: li.partNumber })
      if (!r.account_uid) { allCoded = false; break }
    }
    hasResolvedAccount = allCoded
    if (allCoded) codingSummary = `${extracted.lineItems.length} line(s) auto-coded`
  }

  const bank = bankCheck(extracted.bankDetails, cardBank)

  // Fact-check (pure triage). Duplicates handled by MYOB smart-adopt at post time.
  const triage = triageInvoice({
    extracted,
    hasResolvedSupplier: !!supplierUid,
    hasResolvedAccount,
    exactDuplicateOf: null,
    amountDuplicates: [],
    poCheckStatus: 'no-po-on-invoice',
  })

  const failReasons: string[] = [...triage.triageReasons]
  if (bank === 'mismatch') failReasons.push('RED:bank-mismatch')

  const pass = triage.triageStatus === 'green' && bank !== 'mismatch'

  // Common Slack fields.
  const slackCommon = {
    supplierName, companyFile, invoiceNumber: extracted.invoiceNumber, invoiceDate: extracted.invoiceDate,
    totalIncGst: total, gstAmount: extracted.totals.gstAmount, codingSummary, bankCheck: bank,
    invoiceBank: extracted.bankDetails,
  }

  if (!pass) {
    const built = buildAutoEntryBlocks({ ...slackCommon, outcome: 'flagged', failReasons })
    if (!dryRun) {
      const staged = await stageAndSign(c, msg, att, bytes, kind).catch(() => null)
      const withUrl = staged ? buildAutoEntryBlocks({ ...slackCommon, outcome: 'flagged', failReasons, pdfUrl: staged.url }) : built
      const ts = await sendSlack(withUrl)
      await logRow(c, { mailbox, companyFile, msg, att }, { outcome: 'flagged', supplierName, supplierUid, invoiceNumber: extracted.invoiceNumber, invoiceDate: extracted.invoiceDate, amount: total, failReasons, bankCheck: bank, pdfStoragePath: staged?.path || null, slackTs: ts })
    }
    return { ...base, supplierName, invoiceNumber: extracted.invoiceNumber, amount: total, outcome: 'flagged', bankCheck: bank, failReasons, slackText: built.text }
  }

  // PASS → post to MYOB (tax-inclusive, headless), then Slack success.
  if (dryRun) {
    const built = buildAutoEntryBlocks({ ...slackCommon, outcome: 'posted' })
    return { ...base, supplierName, invoiceNumber: extracted.invoiceNumber, amount: total, outcome: 'posted', bankCheck: bank, failReasons: [], slackText: built.text }
  }

  const posted = await postFoundInvoiceToMyob({
    companyFile, supplierUid: supplierUid!, supplierName,
    extracted, statementAmount: null,
    pdfBytes: bytes, pdfFilename: att.name || `${extracted.invoiceNumber}.pdf`,
    postedBy: ACTOR,
  })

  const staged = await stageAndSign(c, msg, att, bytes, kind).catch(() => null)

  if (!posted.posted) {
    const reasons = [...failReasons, `RED:post-failed:${posted.reason || 'unknown'}`]
    const built = buildAutoEntryBlocks({ ...slackCommon, outcome: 'flagged', failReasons: reasons, pdfUrl: staged?.url })
    const ts = await sendSlack(built)
    await logRow(c, { mailbox, companyFile, msg, att }, { outcome: 'error', supplierName, supplierUid, invoiceNumber: extracted.invoiceNumber, invoiceDate: extracted.invoiceDate, amount: total, failReasons: reasons, bankCheck: bank, error: posted.reason || null, pdfStoragePath: staged?.path || null, slackTs: ts })
    return { ...base, supplierName, invoiceNumber: extracted.invoiceNumber, amount: total, outcome: 'error', bankCheck: bank, failReasons: reasons, error: posted.reason }
  }

  const built = buildAutoEntryBlocks({ ...slackCommon, outcome: 'posted', adopted: posted.adopted, pdfUrl: staged?.url })
  const ts = await sendSlack(built)
  await logRow(c, { mailbox, companyFile, msg, att }, { outcome: 'posted', supplierName, supplierUid, invoiceNumber: extracted.invoiceNumber, invoiceDate: extracted.invoiceDate, amount: total, bankCheck: bank, myobBillUid: posted.billUid || null, pdfStoragePath: staged?.path || null, slackTs: ts })
  return { ...base, supplierName, invoiceNumber: extracted.invoiceNumber, amount: total, outcome: 'posted', bankCheck: bank, failReasons: [], billUid: posted.billUid, adopted: posted.adopted }
}

// Post a sample card to the configured webhook — verifies the channel + format
// without scanning the inbox or touching MYOB. Used by the cron's ?test_slack=1.
export async function sendTestSlack(): Promise<{ webhookConfigured: boolean; ok: boolean; status?: number; body?: string }> {
  const hook = slackWebhook()
  if (!hook) return { webhookConfigured: false, ok: false }
  const built = buildAutoEntryBlocks({
    outcome: 'posted',
    supplierName: 'Test Supplier Pty Ltd',
    companyFile: 'VPS',
    invoiceNumber: 'INV-TEST-001',
    invoiceDate: new Date().toISOString().slice(0, 10),
    totalIncGst: 1234.56,
    gstAmount: 112.23,
    codingSummary: 'Cost Of Goods - Parts',
    bankCheck: 'match',
    adopted: false,
    pdfUrl: null,
  })
  const r = await postWebhook(hook, { text: `🧪 (test) ${built.text}`, blocks: built.blocks })
  return { webhookConfigured: true, ok: r.ok, status: r.status, body: r.body }
}

// ── Slack ────────────────────────────────────────────────────────────────
async function sendSlack(built: { text: string; blocks: any[] }): Promise<string | null> {
  const hook = slackWebhook()
  if (!hook) { console.warn('[ap-auto-entry] SLACK_WEBHOOK_AP_VPS not set — not posting'); return null }
  try {
    const r = await postWebhook(hook, { text: built.text, blocks: built.blocks })
    return r.ok ? 'sent' : null
  } catch (e: any) { console.error('[ap-auto-entry] slack post failed:', e?.message || e); return null }
}

// ── Staged PDF for the Slack link (no ap_invoices row exists) ────────────
async function stageAndSign(
  c: SupabaseClient, msg: GraphMessageSummary, att: GraphAttachmentMeta, bytes: Buffer, kind: 'pdf' | SupportedImageMediaType,
): Promise<{ path: string; url: string } | null> {
  const ext = kind === 'pdf' ? 'pdf' : kind.split('/')[1] || 'bin'
  const path = `auto-entry/${msg.id}_${att.id}.${ext}`.replace(/[^\w./-]/g, '_')
  const contentType = kind === 'pdf' ? 'application/pdf' : kind
  const up = await c.storage.from(AP_BUCKET).upload(path, bytes, { contentType, upsert: true })
  if (up.error) { console.error('[ap-auto-entry] stage upload failed:', up.error.message); return null }
  const signed = await c.storage.from(AP_BUCKET).createSignedUrl(path, SIGNED_URL_TTL_SEC)
  if (signed.error || !signed.data?.signedUrl) return null
  return { path, url: signed.data.signedUrl }
}

async function cleanupStaged(c: SupabaseClient): Promise<void> {
  const { data } = await c.storage.from(AP_BUCKET).list('auto-entry', { limit: 1000 })
  if (!data?.length) return
  const cutoff = Date.now() - STAGE_CLEANUP_DAYS * 86400_000
  const old = data
    .filter(f => f.created_at && new Date(f.created_at).getTime() < cutoff)
    .map(f => `auto-entry/${f.name}`)
  if (old.length) await c.storage.from(AP_BUCKET).remove(old)
}

// ── Audit / dedup row ────────────────────────────────────────────────────
async function logRow(
  c: SupabaseClient,
  ctx: { mailbox: string; companyFile: CompanyFileLabel; msg: GraphMessageSummary; att: GraphAttachmentMeta },
  fields: {
    outcome: AutoEntryOutcomeKind
    supplierName?: string | null; supplierUid?: string | null
    invoiceNumber?: string | null; invoiceDate?: string | null; amount?: number | null
    failReasons?: string[]; bankCheck?: BankCheck
    myobBillUid?: string | null; pdfStoragePath?: string | null; slackTs?: string | null; error?: string | null
  },
): Promise<void> {
  try {
    await c.from('ap_auto_entry_log').insert({
      mailbox: ctx.mailbox, company_file: ctx.companyFile,
      graph_message_id: ctx.msg.id, graph_attachment_id: ctx.att.id,
      supplier_name: fields.supplierName ?? null, supplier_uid: fields.supplierUid ?? null,
      invoice_number: fields.invoiceNumber ?? null, invoice_date: fields.invoiceDate ?? null, amount: fields.amount ?? null,
      outcome: fields.outcome, fail_reasons: fields.failReasons ?? null, bank_check: fields.bankCheck ?? null,
      myob_bill_uid: fields.myobBillUid ?? null, pdf_storage_path: fields.pdfStoragePath ?? null,
      slack_ts: fields.slackTs ?? null, error: fields.error ?? null,
    })
  } catch (e: any) {
    // Unique-violation = another run already logged this attachment; fine.
    if ((e as any)?.code !== '23505') console.error('[ap-auto-entry] log insert failed:', e?.message || e)
  }
}
