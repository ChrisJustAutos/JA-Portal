// lib/ap-auto-entry.ts
//
// Automated invoice entry (VPS only, background). Reads supplier invoices from
// the VPS accounts inbox AND the office scanner's scan-to-email mailbox
// (scans@ — paper invoices), FACT-CHECKS each one, and either:
//   • posts it straight to MYOB (tax-inclusive, no portal ap_invoices row) and
//     drops a success card in Slack, OR
//   • flags it in Slack with the reason and LEAVES the email for manual entry.
// Not-an-invoice attachments are skipped silently. Statement-named documents
// are skipped too (the statement watcher owns those) — EXCEPT consolidated-
// invoice suppliers (lib/ap-consolidated-suppliers, e.g. Time Express), whose
// "statement" is a single tax invoice and is entered here like any other.
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
  findFolderByDisplayNameLoose,
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
import { pdfPageCount, splitPdfRange, segmentInvoicePdf, extractPageRanges, type PageRange } from './ap-batch-split'
import { sendMail } from './email'
import { tryAutoMatchSupplier } from './ap-myob-automatch'
import { getSupplierByUid, type CompanyFileLabel } from './ap-myob-lookup'
import { resolveLineAccount } from './ap-line-resolver'
import { triageInvoice } from './ap-supabase'
import { consolidatedInvoiceSupplier } from './ap-consolidated-suppliers'
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
// Mailboxes swept by auto-entry. The office scanner SENDS FROM scans@ INTO
// the accounts inbox (it isn't a mailbox to read), so the default is just
// accounts@ — add more via AP_AUTO_ENTRY_MAILBOXES (comma-separated);
// legacy AP_AUTO_ENTRY_MAILBOX still honoured.
function vpsMailboxes(): string[] {
  const multi = (process.env.AP_AUTO_ENTRY_MAILBOXES || '').trim()
  if (multi) return multi.split(/[,;]+/).map(s => s.trim()).filter(Boolean)
  const legacy = (process.env.AP_AUTO_ENTRY_MAILBOX || '').trim()
  return [legacy || 'accounts@justautosmechanical.com.au']
}
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
  pages?: PageRange           // batch segments only — original page range in the scanned PDF
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
  mailboxes: { mailbox: string; scanned: number; folderResolved: boolean; error?: string }[]
  scannedMessages: number
  skippedDuplicates: number
  filedFolderName: string           // folder posted emails get moved to (per mailbox)
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
  const companyFile: CompanyFileLabel = 'VPS'
  const sinceDays = Math.max(1, Math.min(Number(opts.sinceDays) || 7, 60))
  const maxMessages = Math.max(1, Math.min(Number(opts.maxMessages) || 40, 100))
  const sinceIso = new Date(Date.now() - sinceDays * 86400_000).toISOString()
  const c = sb()
  const folderName = processedFolder()

  const out: AutoEntryOutcome = { enabled, dryRun, mailboxes: [], scannedMessages: 0, skippedDuplicates: 0, filedFolderName: folderName, processed: [] }

  // Master switch: do nothing (not even scan) unless enabled OR this is a dry-run preview.
  if (!enabled && !dryRun) return out

  for (const mailbox of vpsMailboxes()) {
    const boxOut = { mailbox, scanned: 0, folderResolved: false, error: undefined as string | undefined }
    out.mailboxes.push(boxOut)
    try {
      await runMailbox(c, { mailbox, companyFile, sinceIso, maxMessages, dryRun, folderName }, out, boxOut)
    } catch (e: any) {
      // One unreadable mailbox (e.g. scans@ not yet licensed for the Graph app)
      // must not sink the other.
      boxOut.error = (e?.message || String(e)).slice(0, 300)
      console.error(`[ap-auto-entry] mailbox ${mailbox} failed:`, boxOut.error)
    }
  }

  if (!dryRun) { try { await cleanupStaged(c) } catch { /* best effort */ } }
  return out
}

async function runMailbox(
  c: SupabaseClient,
  ctx: { mailbox: string; companyFile: CompanyFileLabel; sinceIso: string; maxMessages: number; dryRun: boolean; folderName: string },
  out: AutoEntryOutcome,
  boxOut: { mailbox: string; scanned: number; folderResolved: boolean },
): Promise<void> {
  const { mailbox, companyFile, sinceIso, maxMessages, dryRun, folderName } = ctx

  let messages: GraphMessageSummary[] = []
  try {
    messages = await listMessagesWithAttachments(mailbox, { sinceIsoDate: sinceIso, top: maxMessages })
  } catch (e: any) {
    throw new Error(`Could not read ${mailbox}: ${e?.message || e}`)
  }
  boxOut.scanned = messages.length
  out.scannedMessages += messages.length

  // Resolve the "filed" folder once per mailbox — read-only, so we do it on
  // dry runs too (lets a preview report whether the move target exists).
  let processedFolderId: string | null = null
  if (folderName) {
    try { processedFolderId = await findFolderByDisplayNameLoose(mailbox, folderName) } catch { /* leave null */ }
    boxOut.folderResolved = !!processedFolderId
    if (!processedFolderId) console.warn(`[ap-auto-entry] folder "${folderName}" not found in ${mailbox} — posted emails will be marked read but not moved`)
  }

  for (const msg of messages) {
    // Leftovers emails hold the invoices the scanner already couldn't handle —
    // they exist FOR the human and are never re-processed.
    if ((msg.subject || '').includes(LEFTOVER_PREFIX)) continue
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
        const items = await processAttachment(c, { mailbox, companyFile, msg, att, kind, dryRun })
        out.processed.push(...items)
        if (items.some(i => i.outcome === 'posted')) anyPosted = true
      } catch (e: any) {
        const error = (e?.message || String(e)).slice(0, 300)
        out.processed.push({ messageId: msg.id, attachmentId: att.id, attachmentName: att.name || '', supplierName: null, invoiceNumber: null, amount: null, outcome: 'error', bankCheck: 'skipped', failReasons: [], error })
        if (!dryRun) await logRow(c, { mailbox, companyFile, msg, attId: att.id, attName: att.name || '' }, { outcome: 'error', error })
      }
    }

    // Invoice entered → file the email away (read + move out of Inbox). Only on
    // a real posting; flagged / left emails stay put for manual handling. Move
    // LAST (it invalidates the message id) and best-effort (needs Mail.ReadWrite).
    // Record the outcome on the posted log row(s) so move failures are visible.
    if (anyPosted && !dryRun) {
      let moved = false
      const notes: string[] = []
      try { await markMessageAsRead(mailbox, msg.id) } catch (e: any) { notes.push(`mark-read failed: ${e?.message || e}`) }
      if (!processedFolderId) {
        notes.push(`folder "${folderName}" not found in mailbox`)
      } else {
        try { await moveMessageToFolder(mailbox, msg.id, processedFolderId); moved = true; notes.push(`moved to "${folderName}"`) }
        catch (e: any) { notes.push(`move failed: ${e?.message || e}`) }
      }
      const moveNote = notes.join('; ').slice(0, 300)
      if (notes.length) console.warn(`[ap-auto-entry] ${msg.id}: ${moveNote}`)
      try {
        await c.from('ap_auto_entry_log')
          .update({ moved, move_note: moveNote })
          .eq('graph_message_id', msg.id).eq('outcome', 'posted')
      } catch { /* best effort */ }
    }
  }
}

// Subject marker for the residual "still needs a human" email of a partially
// entered batch. The scanner must NEVER process these (they're by definition
// the invoices it already couldn't handle) — matched in the message loop.
const LEFTOVER_PREFIX = '[AP leftovers]'

// A partially-entered batch: some pages posted to MYOB, some didn't. Email a
// PDF of ONLY the un-entered pages back to the same inbox so the inbox ends up
// holding exactly what still needs manual entry — the original full batch gets
// filed away by the posted-message move. Fully-posted batches need no
// leftovers; fully-failed batches keep their original in place (no move).
async function sendBatchLeftovers(
  ctx: { mailbox: string; dryRun: boolean },
  attName: string,
  bytes: Buffer,
  items: AutoEntryItem[],
): Promise<void> {
  const posted = items.filter(i => i.outcome === 'posted')
  const leftovers = items.filter(i => i.outcome !== 'posted' && i.pages)
  if (!posted.length || !leftovers.length) return
  const esc = (s: any) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  try {
    const residual = await extractPageRanges(bytes, leftovers.map(i => i.pages!))
    const list = leftovers.map(i => {
      const pg = i.pages!.from === i.pages!.to ? `p${i.pages!.from}` : `p${i.pages!.from}-${i.pages!.to}`
      const why = i.outcome === 'skipped_not_invoice' ? 'not recognised as an invoice'
        : i.error ? esc(i.error)
        : esc(i.failReasons.map(r => r.replace(/^(RED|YELLOW):/, '')).join(', ') || i.outcome)
      return `<li><strong>${pg}</strong>: ${esc(i.supplierName || 'Unrecognised supplier')}${i.invoiceNumber ? ` — ${esc(i.invoiceNumber)}` : ''}${i.amount != null ? ` — ${money(i.amount)}` : ''} <span style="color:#888">(${why})</span></li>`
    }).join('')
    await sendMail(ctx.mailbox, {
      to: [ctx.mailbox],
      subject: `${LEFTOVER_PREFIX} ${attName} — ${leftovers.length} of ${items.length} invoices need manual entry`,
      html: `<p>${posted.length} of ${items.length} invoices in this scanned batch were entered into MYOB automatically. The attached PDF contains ONLY the ${leftovers.length} still needing manual entry:</p><ul>${list}</ul><p>The original full batch was marked processed and filed out of the inbox.</p>`,
      attachments: [{ name: `LEFTOVERS ${attName}`, contentType: 'application/pdf', content: residual }],
    })
  } catch (e: any) {
    console.error('[ap-auto-entry] leftovers email failed:', e?.message || e)
  }
}

// BATCHED-scan sources (several paper invoices per PDF). The Epson scanner
// SENDS FROM scans@ into the accounts inbox, so this matches the SENDER as
// well as the receiving mailbox. Their multi-page PDFs are segmented into
// individual documents first.
function isBatchSource(mailbox: string, fromAddress: string | null | undefined): boolean {
  const raw = (process.env.AP_BATCH_SPLIT_MAILBOXES ?? 'scans@justautosmechanical.com.au').trim()
  const list = raw.split(/[,;]+/).map(s => s.trim().toLowerCase()).filter(Boolean)
  return list.includes(mailbox.toLowerCase()) || (!!fromAddress && list.includes(String(fromAddress).toLowerCase()))
}

const MAX_BATCH_SEGMENTS = 15

async function processAttachment(
  c: SupabaseClient,
  ctx: { mailbox: string; companyFile: CompanyFileLabel; msg: GraphMessageSummary; att: GraphAttachmentMeta; kind: 'pdf' | SupportedImageMediaType; dryRun: boolean },
): Promise<AutoEntryItem[]> {
  const { mailbox, msg, att, kind } = ctx

  const b64 = await getAttachmentBase64(mailbox, msg.id, att.id)
  const bytes = Buffer.from(b64, 'base64')

  // Batched scan? Segment the PDF into individual documents and process each
  // one as its own invoice (own fact-check, MYOB bill, Slack card, log row).
  if (kind === 'pdf' && isBatchSource(mailbox, msg.from)) {
    let pages = 0
    try { pages = await pdfPageCount(bytes) } catch { /* unreadable pdf — let the single path report it */ }
    if (pages > 1) {
      let ranges: PageRange[] | null = null
      try { ranges = (await segmentInvoicePdf(b64, pages)).ranges } catch (e: any) {
        console.warn(`[ap-auto-entry] batch segmentation failed (${e?.message || e}) — falling back to one invoice per page`)
      }
      if (!ranges?.length) ranges = Array.from({ length: pages }, (_, i) => ({ from: i + 1, to: i + 1 }))
      if (ranges.length > MAX_BATCH_SEGMENTS) console.warn(`[ap-auto-entry] batch has ${ranges.length} documents — processing first ${MAX_BATCH_SEGMENTS}`)

      const items: AutoEntryItem[] = []
      const segments = ranges.slice(0, MAX_BATCH_SEGMENTS)
      for (let idx = 0; idx < segments.length; idx++) {
        const r = segments[idx]
        // The FIRST segment logs under the raw attachment id so the seen-check
        // dedups the whole attachment; later segments get a #p suffix (unique).
        const attId = idx === 0 ? att.id : `${att.id}#p${r.from}-${r.to}`
        const attName = `${att.name || 'scan.pdf'} (p${r.from}${r.to > r.from ? `-${r.to}` : ''} of ${pages})`
        try {
          const segBytes = await splitPdfRange(bytes, r.from, r.to)
          items.push({ ...(await processInvoice(c, ctx, { bytes: segBytes, b64: segBytes.toString('base64'), kind: 'pdf', attId, attName, isScan: true })), pages: r })
        } catch (e: any) {
          const error = (e?.message || String(e)).slice(0, 300)
          items.push({ messageId: msg.id, attachmentId: attId, attachmentName: attName, pages: r, supplierName: null, invoiceNumber: null, amount: null, outcome: 'error', bankCheck: 'skipped', failReasons: [], error })
          if (!ctx.dryRun) await logRow(c, { mailbox, companyFile: ctx.companyFile, msg, attId, attName }, { outcome: 'error', error })
        }
      }

      // Partially-entered batch → replace the inbox copy with a LEFTOVERS email
      // containing only the un-entered pages, so what remains in the inbox is
      // exactly what still needs a human (the original moves to the processed
      // folder because at least one invoice posted).
      if (!ctx.dryRun) await sendBatchLeftovers(ctx, att.name || 'scan.pdf', bytes, items)

      return items
    }
  }

  return [await processInvoice(c, ctx, { bytes, b64, kind, attId: att.id, attName: att.name || '', isScan: isBatchSource(mailbox, msg.from) })]
}

// Scanned batch segments are photographed paper, not digital PDFs — weaker
// models misread names off them (MPI → "IMP", Engine → "Bearing") and fall
// for product-brand logos (a JAS Oceania invoice read as "Federal Batteries").
// Scans get the strongest model; digital email PDFs stay on the default.
const scanExtractionModel = () => (process.env.AP_SCAN_EXTRACTION_MODEL || 'claude-opus-4-8').trim()

async function processInvoice(
  c: SupabaseClient,
  ctx: { mailbox: string; companyFile: CompanyFileLabel; msg: GraphMessageSummary; dryRun: boolean },
  inv: { bytes: Buffer; b64: string; kind: 'pdf' | SupportedImageMediaType; attId: string; attName: string; isScan?: boolean },
): Promise<AutoEntryItem> {
  const { mailbox, companyFile, msg, dryRun } = ctx
  const { bytes, b64, kind, attId, attName } = inv
  const base = { messageId: msg.id, attachmentId: attId, attachmentName: attName }

  // Extract. A parse failure or a non-invoice (no number AND no total) is not
  // flagged — just logged as skipped so we don't spam Slack with random PDFs.
  let extracted: ExtractedAPInvoice
  try {
    if (kind === 'pdf') {
      if (bytes.length < 100 || !bytes.subarray(0, 5).toString('ascii').startsWith('%PDF-')) throw new Error('not a PDF')
      extracted = (await extractInvoiceFromPdf(b64, inv.isScan ? { model: scanExtractionModel() } : {})).invoice
    } else {
      extracted = (await extractInvoiceFromImage(b64, kind)).invoice
    }
  } catch {
    if (!dryRun) await logRow(c, { mailbox, companyFile, msg, attId, attName }, { outcome: 'skipped_not_invoice' })
    return { ...base, supplierName: null, invoiceNumber: null, amount: null, outcome: 'skipped_not_invoice', bankCheck: 'skipped', failReasons: [] }
  }

  // Statement guard. Statement-named documents belong to the statement watcher
  // (reconcile against MYOB), NOT here — parsing a statement as an "invoice"
  // risks double-posting bills that are already entered. The exception is a
  // consolidated-invoice supplier (e.g. Time Express), whose "statement" IS a
  // single tax invoice for the period and is exactly what we should enter.
  const looksLikeStatement = /statement/i.test(msg.subject || '') || /statement/i.test(attName)
  const consolidated = consolidatedInvoiceSupplier(extracted.vendor?.name, msg.from)
  if (looksLikeStatement && !consolidated) {
    if (!dryRun) await logRow(c, { mailbox, companyFile, msg, attId, attName }, { outcome: 'skipped_not_invoice' })
    return { ...base, supplierName: extracted.vendor?.name || null, invoiceNumber: extracted.invoiceNumber, amount: extracted.totals.totalIncGst, outcome: 'skipped_not_invoice', bankCheck: 'skipped', failReasons: [] }
  }

  const total = extracted.totals.totalIncGst
  if (!extracted.invoiceNumber || total == null) {
    if (!dryRun) await logRow(c, { mailbox, companyFile, msg, attId, attName }, { outcome: 'skipped_not_invoice' })
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

  // Consolidated invoices are posted at the STATED TOTAL (Chris 2026-07-06:
  // "post with total amount on statement, disregard credits"), so the
  // statement-style layout quirks — medium parse confidence, consignment rows
  // that don't sum to the total because of credits/running balances — don't
  // block posting. Supplier match, coding and bank checks still apply.
  //
  // For everything else, medium parse confidence is the extractor's subjective
  // hedge about an unfamiliar layout. When the objective evidence corroborates
  // the read — supplier + coding resolved, totals/line-sums raise nothing —
  // the hedge alone doesn't block posting (Chris 2026-07-06, Utemart N26747:
  // every check passed yet it flagged on confidence alone). Bank evidence:
  // a MATCH is the strongest corroboration; NO printed bank details is
  // neutral, not suspicious — parts counter dockets (Ken Mills) carry none
  // and could otherwise never pass. A mismatch or unverified card still
  // blocks the override, and low confidence is always a hard stop.
  const ignorable: string[] = []
  if (consolidated) ignorable.push('YELLOW:medium-parse-confidence', 'YELLOW:line-sum-mismatch', 'YELLOW:totals-mismatch')
  else if (bank === 'match' || bank === 'no-invoice-bank') ignorable.push('YELLOW:medium-parse-confidence')
  const failReasons: string[] = triage.triageReasons.filter(r => !ignorable.includes(r))
  if (bank === 'mismatch') failReasons.push('RED:bank-mismatch')

  // Cross-source duplicate guard. The same invoice can arrive twice — the
  // supplier's email into accounts@ AND a paper copy scanned to scans@. An
  // IDENTICAL invoice number is safe end-to-end (MYOB smart-adopt links the
  // existing bill instead of re-posting), but a scan whose number OCR'd
  // differently would slip past that — so a recent posted bill for the SAME
  // supplier and SAME amount under a DIFFERENT number flags for a human.
  if (supplierUid && failReasons.length === 0) {
    const norm = (s: string | null | undefined) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
    const { data: prior } = await c.from('ap_auto_entry_log')
      .select('invoice_number, amount, created_at, mailbox')
      .eq('outcome', 'posted').eq('supplier_uid', supplierUid)
      .gte('created_at', new Date(Date.now() - 14 * 86400_000).toISOString())
    const dup = (prior || []).find(p =>
      p.amount != null && Math.abs(Number(p.amount) - total) < 0.005 &&
      norm(p.invoice_number) !== norm(extracted.invoiceNumber),
    )
    if (dup) failReasons.push(`YELLOW:possible-duplicate-of:${dup.invoice_number || 'unknown'}`)
  }

  const pass = failReasons.length === 0

  // Common Slack fields.
  const slackCommon = {
    supplierName, companyFile, invoiceNumber: extracted.invoiceNumber, invoiceDate: extracted.invoiceDate,
    totalIncGst: total, gstAmount: extracted.totals.gstAmount, codingSummary, bankCheck: bank,
    invoiceBank: extracted.bankDetails, cardBank, sourceMailbox: mailbox,
  }

  if (!pass) {
    const built = buildAutoEntryBlocks({ ...slackCommon, outcome: 'flagged', failReasons })
    if (!dryRun) {
      const staged = await stageAndSign(c, msg, attId, bytes, kind).catch(() => null)
      const withUrl = staged ? buildAutoEntryBlocks({ ...slackCommon, outcome: 'flagged', failReasons, pdfUrl: staged.url }) : built
      const ts = await sendSlack(withUrl)
      await logRow(c, { mailbox, companyFile, msg, attId, attName }, { outcome: 'flagged', supplierName, supplierUid, invoiceNumber: extracted.invoiceNumber, invoiceDate: extracted.invoiceDate, amount: total, failReasons, bankCheck: bank, pdfStoragePath: staged?.path || null, slackTs: ts })
    }
    return { ...base, supplierName, invoiceNumber: extracted.invoiceNumber, amount: total, outcome: 'flagged', bankCheck: bank, failReasons, slackText: built.text }
  }

  // PASS → post to MYOB (tax-inclusive, headless), then Slack success.
  if (dryRun) {
    const built = buildAutoEntryBlocks({ ...slackCommon, outcome: 'posted' })
    return { ...base, supplierName, invoiceNumber: extracted.invoiceNumber, amount: total, outcome: 'posted', bankCheck: bank, failReasons: [], slackText: built.text }
  }

  // Consolidated invoice → bill the stated total as ONE line. The parsed
  // consignment rows aren't trustworthy (running balances, credits netted into
  // the total), so the total-due is the source of truth. Freight is GST-able,
  // so ex-GST is derived as total/1.1 — the tax-inclusive poster then rebuilds
  // a line that matches the stated total to the cent. Coding falls to a line
  // rule on the description, else the supplier card's default expense account.
  const toPost: ExtractedAPInvoice = consolidated ? {
    ...extracted,
    totals: { subtotalExGst: null, gstAmount: null, totalIncGst: total },
    lineItems: [{
      lineNo: 1, partNumber: null,
      description: `Consolidated freight invoice ${extracted.invoiceNumber} — statement total (credits disregarded)`,
      qty: 1, uom: null, unitPriceExGst: null,
      lineTotalExGst: Math.round((total / 1.1) * 100) / 100,
      gstAmount: null, taxCodeRaw: null, taxCode: 'GST',
    }],
  } : extracted

  const posted = await postFoundInvoiceToMyob({
    companyFile, supplierUid: supplierUid!, supplierName,
    extracted: toPost, statementAmount: null,
    pdfBytes: bytes, pdfFilename: attName || `${extracted.invoiceNumber}.pdf`,
    postedBy: ACTOR,
  })

  const staged = await stageAndSign(c, msg, attId, bytes, kind).catch(() => null)

  if (!posted.posted) {
    const reasons = [...failReasons, `RED:post-failed:${posted.reason || 'unknown'}`]
    const built = buildAutoEntryBlocks({ ...slackCommon, outcome: 'flagged', failReasons: reasons, pdfUrl: staged?.url })
    const ts = await sendSlack(built)
    await logRow(c, { mailbox, companyFile, msg, attId, attName }, { outcome: 'error', supplierName, supplierUid, invoiceNumber: extracted.invoiceNumber, invoiceDate: extracted.invoiceDate, amount: total, failReasons: reasons, bankCheck: bank, error: posted.reason || null, pdfStoragePath: staged?.path || null, slackTs: ts })
    return { ...base, supplierName, invoiceNumber: extracted.invoiceNumber, amount: total, outcome: 'error', bankCheck: bank, failReasons: reasons, error: posted.reason }
  }

  const built = buildAutoEntryBlocks({ ...slackCommon, codingSummary: posted.codingDetail || slackCommon.codingSummary, outcome: 'posted', adopted: posted.adopted, pdfUrl: staged?.url })
  const ts = await sendSlack(built)
  await logRow(c, { mailbox, companyFile, msg, attId, attName }, { outcome: 'posted', supplierName, supplierUid, invoiceNumber: extracted.invoiceNumber, invoiceDate: extracted.invoiceDate, amount: total, bankCheck: bank, myobBillUid: posted.billUid || null, pdfStoragePath: staged?.path || null, slackTs: ts })
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
  c: SupabaseClient, msg: GraphMessageSummary, attId: string, bytes: Buffer, kind: 'pdf' | SupportedImageMediaType,
): Promise<{ path: string; url: string } | null> {
  const ext = kind === 'pdf' ? 'pdf' : kind.split('/')[1] || 'bin'
  const path = `auto-entry/${msg.id}_${attId}.${ext}`.replace(/[^\w./-]/g, '_')
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
  // attId may carry a batch-segment suffix (`<graphAttId>#p2-3`) — the first
  // segment uses the raw id so the seen-check dedups the whole attachment.
  ctx: { mailbox: string; companyFile: CompanyFileLabel; msg: GraphMessageSummary; attId: string; attName: string },
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
      graph_message_id: ctx.msg.id, graph_attachment_id: ctx.attId,
      subject: ctx.msg.subject ?? null, from_address: ctx.msg.from ?? null, attachment_name: ctx.attName || null,
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
