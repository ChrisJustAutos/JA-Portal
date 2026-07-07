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
import { extractStatementFromPdf, type ExtractedStatement } from './ap-statement-extraction'
import { matchStatementAgainstMyob } from './ap-statement-match'
import { type CompanyFileLabel } from './ap-myob-lookup'
import { tryAutoMatchSupplier } from './ap-myob-automatch'
import { resolveStatementGaps, type ResolutionAction } from './ap-statement-resolve'
import { consolidatedInvoiceSupplier } from './ap-consolidated-suppliers'

// Phase 2 master switch. When on (default), the watcher doesn't just report
// gaps — for each missing invoice it SEARCHES THE MAILBOX for the actual
// invoice email (auto-posting high-confidence finds to MYOB), and emails the
// supplier to chase true no-shows (see lib/ap-statement-resolve). Set to
// 'false' to fall back to Phase-1 report-only behaviour.
const autoResolveEnabled = () => (process.env.AP_STATEMENT_AUTORESOLVE || 'true').toLowerCase().trim() !== 'false'

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

export type StatementScanStatus = 'reconciled' | 'has_missing' | 'needs_review' | 'failed' | 'no_attachment'

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
  resolution?: ResolutionAction[]   // Phase 2 actions taken for this statement's gaps
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

// Reconcile a Capricorn consolidated statement PER INDIVIDUAL SUPPLIER. Groups
// the invoice lines by their issuing supplier (line.supplierName), resolves each
// to a MYOB card, and runs the normal match + resolve (inbox hunt / VPS-only
// post / chase) for each group — i.e. the single-supplier flow, once per supplier
// on the statement. Lines whose supplier can't be resolved are reported for
// manual handling. Returns the aggregated fields for the statement's scan record.
async function reconcileCapricorn(
  c: SupabaseClient,
  companyFile: CompanyFileLabel,
  inboxMailbox: string,
  statement: ExtractedStatement,
  autoResolve: boolean,
  dryRun: boolean,
): Promise<Pick<StatementScanResult, 'supplierName' | 'supplierUid' | 'supplierResolution' | 'status' | 'missing' | 'mismatches' | 'resolution' | 'reviewReason'>> {
  const invoiceLines = statement.lines.filter(l => l.type === 'invoice')
  const groups = new Map<string, typeof invoiceLines>()
  for (const l of invoiceLines) {
    const key = (l.supplierName || '').trim() || '(unnamed)'
    const arr = groups.get(key) || []
    arr.push(l); groups.set(key, arr)
  }

  const missing: MissingInvoice[] = []
  const mismatches: MismatchInvoice[] = []
  const actions: ResolutionAction[] = []
  const unresolved: string[] = []
  let anyResolved = false

  for (const [name, lines] of Array.from(groups.entries())) {
    const sup = name === '(unnamed)' ? null : await resolveSupplier(companyFile, name, null)
    if (!sup || sup.resolution !== 'matched' || !sup.uid) {
      unresolved.push(name)
      for (const l of lines) missing.push({ reference: l.invoiceNumber || l.reference, date: l.date, amount: l.amount })
      continue
    }
    anyResolved = true
    const subStatement: ExtractedStatement = { ...statement, lines }
    try {
      const outcome = await matchStatementAgainstMyob(c, companyFile, sup.uid, subStatement)
      for (const r of outcome.results) {
        if (r.status === 'missing') missing.push({ reference: r.line.invoiceNumber || r.line.reference, date: r.line.date, amount: r.line.amount })
        else if (r.status === 'amount-mismatch') mismatches.push({ reference: r.line.invoiceNumber || r.line.reference, statementAmount: r.line.amount, myobAmount: r.myobBill?.totalAmount ?? null })
      }
      if (autoResolve) {
        const acts = await resolveStatementGaps(c, {
          companyFile, supplierUid: sup.uid, supplierName: sup.matchedName || name,
          inboxMailbox, statement: subStatement, matchOutcome: outcome, dryRun,
        })
        actions.push(...acts)
      }
    } catch (e: any) {
      console.error(`[ap-statement-watch] capricorn group "${name}" failed:`, e?.message || e)
      unresolved.push(`${name} (error)`)
    }
  }

  const status: StatementScanStatus =
    unresolved.length > 0 ? 'needs_review' : missing.length > 0 ? 'has_missing' : 'reconciled'
  const reviewReason = unresolved.length
    ? `Capricorn statement — ${unresolved.length} supplier(s) couldn't be matched to MYOB (${unresolved.slice(0, 6).join(', ')}${unresolved.length > 6 ? '…' : ''}); enter/reconcile those manually.`
    : undefined

  return {
    supplierName: `Capricorn — ${groups.size} supplier${groups.size === 1 ? '' : 's'}`,
    supplierUid: null,
    supplierResolution: anyResolved ? 'matched' : 'none',
    status,
    missing,
    mismatches,
    resolution: actions.length ? actions : undefined,
    reviewReason,
  }
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

  const autoResolve = autoResolveEnabled()

  for (const inbox of inboxes()) {
    let messages: GraphMessageSummary[] = []
    try {
      // alsoSubjects: statement emails with inline-only PDFs (or a download
      // link and no attachment) report hasAttachments=false and were invisible
      // — GE Group's "monthly statement" sat unseen for a day (2026-07-08).
      messages = await listMessagesWithAttachments(inbox.mailbox, { sinceIsoDate: sinceIso, top: 100, alsoSubjects: /statement/i })
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
      if (pdfStatements.length === 0) {
        // A statement-subject email with NO readable PDF (link-only, or an
        // unsupported format like xlsx) — surface it in the digest instead of
        // silently ignoring it, so "the statement just sat there" can't recur.
        if (subjIsStatement && processed.length < maxStatements) {
          const { data: seen } = await c.from('ap_statement_scans')
            .select('id').eq('graph_message_id', msg.id).eq('graph_attachment_id', 'none').maybeSingle()
          if (seen) { skippedDuplicates++; continue }
          statementsFound++; inboxStatements++
          const kinds = atts.map(a => a.name || a.contentType || 'unnamed').join(', ')
          const record = {
            mailbox: inbox.mailbox, companyFile: inbox.companyFile,
            messageId: msg.id, attachmentId: 'none', attachmentName: '',
            subject: msg.subject, from: msg.from, receivedAt: msg.receivedDateTime,
            supplierName: null, supplierUid: null, supplierResolution: 'none' as const,
            status: 'no_attachment' as StatementScanStatus, period: null, invoiceLines: 0,
            missing: [], mismatches: [],
            reviewReason: `Statement email from ${msg.from || 'unknown sender'} has no readable PDF attachment` +
              (atts.length ? ` (attachments: ${kinds.slice(0, 150)})` : ' (likely a download link in the body)') +
              ' — open the email and handle manually.',
          }
          processed.push(record)
          if (!dryRun) {
            try {
              await c.from('ap_statement_scans').insert({
                mailbox: record.mailbox, company_file: record.companyFile,
                graph_message_id: record.messageId, graph_attachment_id: 'none',
                attachment_name: '', subject: record.subject, from_address: record.from,
                supplier_name: null, supplier_uid: null,
                match_status: 'no_attachment', invoice_lines: 0, missing_count: 0,
                missing: [], error: null,
              })
            } catch { /* non-fatal; worst case re-reported next run */ }
          }
        }
        continue
      }

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

          // Consolidated-invoice supplier (e.g. Time Express): the "statement" IS a
          // single tax invoice for the period's consignments. Its rows aren't
          // individual invoices that could be missing from MYOB — reconciling here
          // reports every row missing and chases the supplier for invoice numbers
          // that don't exist. AP auto-entry enters the document itself; just record
          // the scan (dedupe) and move on.
          if (consolidatedInvoiceSupplier(supplierName, msg.from)) {
            await record({
              ...base, supplierName, supplierUid: null, supplierResolution: 'none',
              status: 'reconciled', period, invoiceLines, missing: [], mismatches: [],
              reviewReason: 'Consolidated-invoice supplier — this "statement" is a single invoice; AP auto-entry handles it. Not reconciled or chased.',
            })
            continue
          }

          // Capricorn consolidated statement: you PAY Capricorn, but the lines are
          // individual suppliers' invoices (Repco, BNT, …) billed through it. Reconcile
          // it PER INDIVIDUAL SUPPLIER — group the lines by their issuing supplier and
          // run the normal reconcile/hunt/(VPS-only)post for each group.
          if (supplierName && /capricorn/i.test(supplierName)) {
            const cap = await reconcileCapricorn(c, inbox.companyFile, inbox.mailbox, statement, autoResolve, dryRun)
            await record({ ...base, ...cap, period, invoiceLines })
            continue
          }

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

          // Phase 2: act on the gaps (auto-post high-confidence finds, chase the
          // supplier for true no-shows). Non-fatal — a resolver error must not
          // sink the scan/dedupe record.
          let resolution: ResolutionAction[] | undefined
          if (autoResolve) {
            try {
              resolution = await resolveStatementGaps(c, {
                companyFile: inbox.companyFile, supplierUid: sup.uid, supplierName: sup.matchedName || supplierName,
                inboxMailbox: inbox.mailbox, statement, matchOutcome: outcome, dryRun,
              })
            } catch (e: any) {
              console.error('[ap-statement-watch] resolve failed:', e?.message || e)
            }
          }

          await record({
            ...base, supplierName: sup.matchedName || supplierName, supplierUid: sup.uid, supplierResolution: 'matched',
            status: missing.length > 0 ? 'has_missing' : 'reconciled',
            period, invoiceLines, missing, mismatches, resolution,
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
  const needsReview = stmts.filter(r => r.status === 'needs_review' || r.status === 'failed' || r.status === 'no_attachment')
  const withMissing = stmts.filter(r => r.missing.length > 0)
  const clean = stmts.filter(r => r.status === 'reconciled')

  // Phase 2 actions, flattened across statements (carry the supplier + file for display).
  const acts = stmts.flatMap(r => (r.resolution || []).map(a => ({ ...a, supplier: r.supplierName, companyFile: r.companyFile })))
  const posted = acts.filter(a => a.outcome === 'posted')
  const emailed = acts.filter(a => a.outcome === 'emailed_supplier')
  const forReview = acts.filter(a => a.outcome === 'left_for_review')
  const foundNotPosted = acts.filter(a => a.outcome === 'found_not_posted')
  const noEmail = acts.filter(a => a.outcome === 'no_supplier_email')

  const actionBits = [
    posted.length ? `${posted.length} auto-posted` : '',
    emailed.length ? `${emailed.length} supplier-chased` : '',
  ].filter(Boolean).join(', ')
  const subject = (stmts.length === 0 && inboxErrors.length > 0)
    ? `AP statement check — ⚠ ${inboxErrors.length} inbox${inboxErrors.length === 1 ? '' : 'es'} could not be read`
    : `AP statement check — ${totalMissing} missing invoice${totalMissing === 1 ? '' : 's'} across ${withMissing.length} statement${withMissing.length === 1 ? '' : 's'}${actionBits ? ` · ${actionBits}` : ''}${inboxErrors.length ? ` (+${inboxErrors.length} inbox error${inboxErrors.length === 1 ? '' : 's'})` : ''}`

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

  // Actions taken this run (Phase 2). Shown above the raw reconciliation so the
  // reader sees what was already handled before the "still missing" list.
  const actLine = (a: (typeof acts)[number], right: string) =>
    `<div style="font-size:13px;padding:2px 0">${esc(a.supplier || 'Unknown')} <span style="color:#6b7280">· ${esc(a.companyFile)}</span> — <span style="font-family:monospace">${esc(a.reference || '—')}</span> ${right}</div>`
  if (posted.length > 0) {
    body += `<h2 style="font-size:15px;color:#059669;margin:18px 0 8px">✅ Auto-posted to MYOB (${posted.length})</h2>`
    body += posted.map(a => actLine(a, `<span style="font-weight:600">${money(a.amount)}</span>`)).join('')
  }
  if (emailed.length > 0) {
    body += `<h2 style="font-size:15px;color:#2563eb;margin:18px 0 8px">📧 Chased supplier (${emailed.length})</h2>`
    body += emailed.map(a => actLine(a, `${money(a.amount)} <span style="color:#6b7280">→ ${esc(a.emailedTo || '')}</span>`)).join('')
  }
  if (forReview.length > 0) {
    body += `<h2 style="font-size:15px;color:#d97706;margin:18px 0 8px">🟡 In the AP queue — left for review (${forReview.length})</h2>`
    body += forReview.map(a => actLine(a, `${money(a.amount)} <span style="color:#6b7280">· needs coding/posting</span>`)).join('')
    body += `<div style="font-size:12px;color:#6b7280;margin-top:4px">Open <a href="https://justautos.app/ap">/ap</a> to code and post.</div>`
  }
  if (foundNotPosted.length > 0) {
    body += `<h2 style="font-size:15px;color:#d97706;margin:18px 0 8px">📄 Found in inbox — couldn't auto-post (${foundNotPosted.length})</h2>`
    body += foundNotPosted.map(a => actLine(a, `${money(a.amount)} <span style="color:#6b7280">· ${esc((a.detail || '').replace(/^Found in inbox but couldn't auto-post: /, ''))}</span>`)).join('')
    body += `<div style="font-size:12px;color:#6b7280;margin-top:4px">Nothing was written to the portal — enter these directly in MYOB.</div>`
  }
  if (noEmail.length > 0) {
    body += `<h2 style="font-size:15px;color:#dc2626;margin:18px 0 8px">⚠ Couldn't chase — no supplier email (${noEmail.length})</h2>`
    body += noEmail.map(a => actLine(a, `${money(a.amount)} <span style="color:#6b7280">· add an email to the MYOB card or chase manually</span>`)).join('')
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
        `<div style="font-weight:600">${esc(r.supplierName || r.subject || r.attachmentName || 'Statement')} <span style="color:#6b7280;font-weight:400">· ${esc(r.companyFile)}</span></div>` +
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
    `<div style="font-size:11px;color:#9097a6;margin-top:20px;border-top:1px solid #e5e7eb;padding-top:8px">High-confidence finds are auto-posted to MYOB and suppliers are auto-chased for true no-shows; anything left in "still missing" or "for review" needs a human. Review at <a href="https://justautos.app/ap/statement">/ap/statement</a>.</div>` +
    `</div>`

  return { subject, html }
}
