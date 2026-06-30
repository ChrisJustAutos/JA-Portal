// lib/ap-statement-watch.ts
//
// Automated supplier-statement reconciliation. Scans the two "accounts"
// inboxes for statement PDFs, runs each through the EXISTING statement engine
// (extractStatementFromPdf → matchStatementAgainstMyob), and returns the
// missing invoices so the cron can email a digest.
//
// Reuses, doesn't reinvent:
//   - lib/microsoft-graph   inbox listing + attachment download (same as AP pull)
//   - lib/ap-statement-extraction   Claude PDF → ExtractedStatement
//   - lib/ap-statement-match        ExtractedStatement vs MYOB → missing list
//   - lib/ap-myob-lookup            supplier resolution per company file
//
// Statement identification: subject OR a PDF attachment filename contains
// "statement" (case-insensitive). Company file is decided by which inbox the
// mail arrived in. Supplier is auto-resolved from the statement's supplier name;
// when it can't be confidently matched, the statement is flagged "needs review"
// rather than risk a wrong reconcile.
//
// Dedupe: ap_statement_scans keyed on (graph_message_id, graph_attachment_id),
// so a daily scan never re-processes or re-emails the same statement. dryRun
// skips that write so a preview run leaves the real run free to process.

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import {
  listMessagesWithAttachments,
  listAttachmentMeta,
  getAttachmentBase64,
  GraphMessageSummary,
  GraphAttachmentMeta,
} from './microsoft-graph'
import { extractStatementFromPdf } from './ap-statement-extraction'
import { matchStatementAgainstMyob } from './ap-statement-match'
import { type CompanyFileLabel } from './ap-myob-lookup'
import { tryAutoMatchSupplier } from './ap-myob-automatch'

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

// Inbox → MYOB company file. (Confirmed addresses; override via AP_STATEMENT_INBOXES
// JSON env if they ever change.)
interface InboxConfig { mailbox: string; companyFile: CompanyFileLabel }
function inboxes(): InboxConfig[] {
  const raw = (process.env.AP_STATEMENT_INBOXES || '').trim()
  if (raw) {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed) && parsed.every(x => x.mailbox && (x.companyFile === 'JAWS' || x.companyFile === 'VPS'))) return parsed
    } catch { /* fall through to defaults */ }
  }
  return [
    // NOTE: the wholesale mailbox is .com (NOT .com.au — that domain isn't a
    // Microsoft 365 tenant, so Graph can't read it). Matches lib/b2b-settings.
    { mailbox: 'accounts@justautoswholesale.com',     companyFile: 'JAWS' },
    { mailbox: 'accounts@justautosmechanical.com.au', companyFile: 'VPS'  },
  ]
}

export interface MissingInvoice { reference: string | null; date: string | null; amount: number | null }
export interface MismatchInvoice { reference: string | null; statementAmount: number | null; myobAmount: number | null }

export type StatementScanStatus = 'reconciled' | 'has_missing' | 'needs_review' | 'failed'

export interface StatementScanResult {
  mailbox: string
  companyFile: CompanyFileLabel
  messageId: string
  attachmentId: string
  attachmentName: string
  subject: string | null
  from: string | null
  receivedAt: string
  supplierName: string | null
  supplierUid: string | null
  supplierResolution: 'matched' | 'ambiguous' | 'none'
  status: StatementScanStatus
  period: string | null
  invoiceLines: number
  missing: MissingInvoice[]
  mismatches: MismatchInvoice[]
  reviewReason?: string
  error?: string
}

export interface StatementWatchOutcome {
  scannedMessages: number
  statementsFound: number
  processed: StatementScanResult[]   // NEW statements processed this run
  skippedDuplicates: number
  perInbox: { mailbox: string; companyFile: CompanyFileLabel; scanned: number; statements: number; error?: string }[]
}

const hasStatementWord = (s: string | null | undefined) => !!s && /statement/i.test(s)

function periodLabel(s: { statementDate: string | null; periodFrom: string | null; periodTo: string | null }): string | null {
  if (s.periodFrom && s.periodTo) return `${s.periodFrom} → ${s.periodTo}`
  return s.statementDate || s.periodTo || null
}

// Resolve the statement's supplier to a single MYOB supplier card in the right
// company file. Confident match only: exactly one search hit, or an exact
// (case-insensitive) name match among several. Otherwise → needs review.
async function resolveSupplier(companyFile: CompanyFileLabel, name: string | null, abn: string | null):
  Promise<{ resolution: 'matched' | 'ambiguous' | 'none'; uid: string | null; matchedName: string | null }> {
  const q = (name || '').trim()
  if (!q) return { resolution: 'none', uid: null, matchedName: null }
  // Reuse the AP invoice auto-matcher: it searches MYOB on the first couple of
  // name tokens and matches when either name contains the other, so a
  // statement's full legal name ("CDI Motorsport Pty Ltd") still resolves to a
  // short supplier card ("Cdi motorsport"). ABN (if the statement carries one)
  // wins outright. Returns a confident single match or null (→ needs review).
  try {
    const m = await tryAutoMatchSupplier(q, abn, companyFile)
    if (m) return { resolution: 'matched', uid: m.supplier.uid, matchedName: m.supplier.name }
  } catch { /* fall through to needs-review */ }
  return { resolution: 'none', uid: null, matchedName: null }
}

export interface WatchOptions { sinceDays?: number; maxStatements?: number; dryRun?: boolean }

export async function runStatementWatch(opts: WatchOptions = {}): Promise<StatementWatchOutcome> {
  const sinceDays = Math.max(1, Math.min(Number(opts.sinceDays) || 4, 60))
  // Default cap keeps a run inside the 300s budget (each statement ≈ a Claude
  // parse + a MYOB bill pull). Statements are monthly, so daily runs see few.
  const maxStatements = Math.max(1, Math.min(Number(opts.maxStatements) || 12, 100))
  const dryRun = !!opts.dryRun
  const sinceIso = new Date(Date.now() - sinceDays * 86400_000).toISOString()
  const c = sb()

  const processed: StatementScanResult[] = []
  const perInbox: StatementWatchOutcome['perInbox'] = []
  let scannedMessages = 0
  let statementsFound = 0
  let skippedDuplicates = 0

  for (const inbox of inboxes()) {
    let messages: GraphMessageSummary[] = []
    try {
      messages = await listMessagesWithAttachments(inbox.mailbox, { sinceIsoDate: sinceIso, top: 100 })
    } catch (e: any) {
      perInbox.push({ mailbox: inbox.mailbox, companyFile: inbox.companyFile, scanned: 0, statements: 0, error: e?.message || String(e) })
      continue
    }
    scannedMessages += messages.length
    let inboxStatements = 0

    for (const msg of messages) {
      if (processed.length >= maxStatements) break
      let atts: GraphAttachmentMeta[]
      try { atts = await listAttachmentMeta(inbox.mailbox, msg.id) } catch { continue }
      const subjIsStatement = hasStatementWord(msg.subject)
      const pdfStatements = atts.filter(a => {
        const isPdf = (a.contentType || '').toLowerCase() === 'application/pdf' || /\.pdf$/i.test(a.name || '')
        return isPdf && (subjIsStatement || hasStatementWord(a.name))
      })
      if (pdfStatements.length === 0) continue

      for (const att of pdfStatements) {
        if (processed.length >= maxStatements) break
        // Dedupe.
        const { data: seen } = await c.from('ap_statement_scans')
          .select('id').eq('graph_message_id', msg.id).eq('graph_attachment_id', att.id).maybeSingle()
        if (seen) { skippedDuplicates++; continue }

        statementsFound++; inboxStatements++
        const base = {
          mailbox: inbox.mailbox, companyFile: inbox.companyFile,
          messageId: msg.id, attachmentId: att.id, attachmentName: att.name || '',
          subject: msg.subject, from: msg.from, receivedAt: msg.receivedDateTime,
        }

        const record = async (r: StatementScanResult) => {
          processed.push(r)
          if (dryRun) return
          // AWAIT the dedupe insert — Vercel can kill in-flight promises once
          // the handler responds, and a lost row would re-process/re-email.
          try {
            await c.from('ap_statement_scans').insert({
              mailbox: r.mailbox, company_file: r.companyFile,
              graph_message_id: r.messageId, graph_attachment_id: r.attachmentId,
              attachment_name: r.attachmentName, subject: r.subject, from_address: r.from,
              supplier_name: r.supplierName, supplier_uid: r.supplierUid,
              match_status: r.status, invoice_lines: r.invoiceLines, missing_count: r.missing.length,
              missing: r.missing, error: r.error || null,
            })
          } catch { /* non-fatal; worst case re-processed next run */ }
        }

        try {
          const b64 = await getAttachmentBase64(inbox.mailbox, msg.id, att.id)
          const { statement } = await extractStatementFromPdf(b64)
          const supplierName = statement.supplier?.name || null
          const period = periodLabel(statement)
          const invoiceLines = statement.lines.filter(l => l.type === 'invoice').length

          const sup = await resolveSupplier(inbox.companyFile, supplierName, (statement.supplier as any)?.abn ?? null)
          if (sup.resolution !== 'matched' || !sup.uid) {
            await record({
              ...base, supplierName, supplierUid: null, supplierResolution: sup.resolution,
              status: 'needs_review', period, invoiceLines, missing: [], mismatches: [],
              reviewReason: `Couldn't confidently match "${supplierName || '(unknown)'}" to a MYOB supplier — reconcile manually`,
            })
            continue
          }

          const outcome = await matchStatementAgainstMyob(c, inbox.companyFile, sup.uid, statement)
          const missing: MissingInvoice[] = outcome.results
            .filter(r => r.status === 'missing')
            .map(r => ({ reference: r.line.invoiceNumber || r.line.reference, date: r.line.date, amount: r.line.amount }))
          const mismatches: MismatchInvoice[] = outcome.results
            .filter(r => r.status === 'amount-mismatch')
            .map(r => ({ reference: r.line.invoiceNumber || r.line.reference, statementAmount: r.line.amount, myobAmount: r.myobBill?.totalAmount ?? null }))

          await record({
            ...base, supplierName: sup.matchedName || supplierName, supplierUid: sup.uid, supplierResolution: 'matched',
            status: missing.length > 0 ? 'has_missing' : 'reconciled',
            period, invoiceLines, missing, mismatches,
          })
        } catch (e: any) {
          await record({
            ...base, supplierName: null, supplierUid: null, supplierResolution: 'none',
            status: 'failed', period: null, invoiceLines: 0, missing: [], mismatches: [],
            error: (e?.message || String(e)).slice(0, 300),
          })
        }
      }
    }
    perInbox.push({ mailbox: inbox.mailbox, companyFile: inbox.companyFile, scanned: messages.length, statements: inboxStatements })
  }

  return { scannedMessages, statementsFound, processed, skippedDuplicates, perInbox }
}

// ── Email digest ────────────────────────────────────────────────────────
const money = (n: number | null | undefined) => (n == null || !isFinite(n) ? '—' : `$${Number(n).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)
const esc = (s: any) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function buildDigestHtml(outcome: StatementWatchOutcome, generatedAt: string): { subject: string; html: string } | null {
  const stmts = outcome.processed
  const inboxErrors = (outcome.perInbox || []).filter(p => p.error)
  if (stmts.length === 0 && inboxErrors.length === 0) return null

  const totalMissing = stmts.reduce((s, r) => s + r.missing.length, 0)
  const needsReview = stmts.filter(r => r.status === 'needs_review' || r.status === 'failed')
  const withMissing = stmts.filter(r => r.missing.length > 0)
  const clean = stmts.filter(r => r.status === 'reconciled')

  const subject = (stmts.length === 0 && inboxErrors.length > 0)
    ? `AP statement check — ⚠ ${inboxErrors.length} inbox${inboxErrors.length === 1 ? '' : 'es'} could not be read`
    : `AP statement check — ${totalMissing} missing invoice${totalMissing === 1 ? '' : 's'} across ${withMissing.length} statement${withMissing.length === 1 ? '' : 's'}${inboxErrors.length ? ` (+${inboxErrors.length} inbox error${inboxErrors.length === 1 ? '' : 's'})` : ''}`

  const card = (inner: string, accent: string) =>
    `<div style="border:1px solid #e5e7eb;border-left:3px solid ${accent};border-radius:8px;padding:12px 14px;margin:0 0 12px">${inner}</div>`

  let body = ''

  // Inbox read failures — surface loudly so a mailbox the app can't read is
  // never again mistaken for "nothing to reconcile" (this hid the wholesale
  // inbox typo for over a week).
  if (inboxErrors.length > 0) {
    body += `<h2 style="font-size:15px;color:#dc2626;margin:18px 0 8px">⚠ Inbox(es) that couldn't be read (${inboxErrors.length})</h2>`
    for (const p of inboxErrors) {
      body += card(
        `<div style="font-weight:600">${esc(p.mailbox)} <span style="color:#6b7280;font-weight:400">· ${esc(p.companyFile)}</span></div>` +
        `<div style="font-size:12px;color:#6b7280;margin-top:3px">${esc(p.error)}</div>`,
        '#dc2626',
      )
    }
  }

  // Missing — the headline.
  if (withMissing.length > 0) {
    body += `<h2 style="font-size:15px;color:#dc2626;margin:18px 0 8px">⚠ Missing from MYOB (${totalMissing})</h2>`
    for (const r of withMissing) {
      const rows = r.missing.map(m =>
        `<tr><td style="padding:3px 10px 3px 0;font-family:monospace">${esc(m.reference || '—')}</td>` +
        `<td style="padding:3px 10px 3px 0;color:#6b7280">${esc(m.date || '—')}</td>` +
        `<td style="padding:3px 0;text-align:right;font-weight:600">${money(m.amount)}</td></tr>`).join('')
      const mismatchNote = r.mismatches.length
        ? `<div style="font-size:12px;color:#d97706;margin-top:6px">Also ${r.mismatches.length} amount mismatch(es): ${r.mismatches.map(m => `${esc(m.reference)} (statement ${money(m.statementAmount)} vs MYOB ${money(m.myobAmount)})`).join('; ')}</div>`
        : ''
      body += card(
        `<div style="font-weight:600">${esc(r.supplierName || 'Unknown supplier')} <span style="color:#6b7280;font-weight:400">· ${esc(r.companyFile)}${r.period ? ` · ${esc(r.period)}` : ''}</span></div>` +
        `<table style="font-size:13px;border-collapse:collapse;margin-top:6px">${rows}</table>${mismatchNote}`,
        '#dc2626',
      )
    }
  }

  // Needs review.
  if (needsReview.length > 0) {
    body += `<h2 style="font-size:15px;color:#d97706;margin:18px 0 8px">Needs manual review (${needsReview.length})</h2>`
    for (const r of needsReview) {
      body += card(
        `<div style="font-weight:600">${esc(r.supplierName || r.attachmentName || 'Statement')} <span style="color:#6b7280;font-weight:400">· ${esc(r.companyFile)}</span></div>` +
        `<div style="font-size:12px;color:#6b7280;margin-top:3px">${esc(r.reviewReason || r.error || 'Could not reconcile automatically')} — open <a href="https://justautos.app/ap/statement">/ap/statement</a></div>`,
        '#d97706',
      )
    }
  }

  // Reconciled (brief confirmation).
  if (clean.length > 0) {
    body += `<h2 style="font-size:15px;color:#059669;margin:18px 0 8px">Fully reconciled (${clean.length})</h2><div style="font-size:13px;color:#374151">`
    body += clean.map(r => `${esc(r.supplierName)} (${esc(r.companyFile)}${r.period ? `, ${esc(r.period)}` : ''})`).join(' · ')
    body += `</div>`
  }

  const html =
    `<div style="font-family:system-ui,-apple-system,sans-serif;color:#171a21;max-width:680px">` +
    `<h1 style="font-size:18px;margin:0 0 4px">Supplier statement reconciliation</h1>` +
    `<div style="font-size:12px;color:#6b7280;margin-bottom:6px">${esc(generatedAt)} · ${stmts.length} statement(s) checked · ${outcome.scannedMessages} email(s) scanned</div>` +
    body +
    `<div style="font-size:11px;color:#9097a6;margin-top:20px;border-top:1px solid #e5e7eb;padding-top:8px">In-stock reconcile is read-only — nothing was written to MYOB. Enter the missing invoices in MYOB, or review at <a href="https://justautos.app/ap/statement">/ap/statement</a>.</div>` +
    `</div>`

  return { subject, html }
}
