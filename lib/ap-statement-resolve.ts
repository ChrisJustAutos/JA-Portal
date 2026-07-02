// lib/ap-statement-resolve.ts
//
// Phase 2 of the supplier-statement automation: turn "here's what's missing"
// into action. For each gap the matcher found on a statement, this engine:
//
//   • in-portal-pending  — the invoice is already in ap_invoices, just not
//                          posted → AUTO-POST to MYOB, but only when it's
//                          high-confidence (triage green + supplier mapped +
//                          amount matches the statement). Anything else is
//                          left in the AP review queue for a human.
//   • missing            — no trace in MYOB or the portal → first a broad
//                          ap_invoices lookup (the mailbox is drained into
//                          ap_invoices before this runs, so a just-arrived
//                          invoice is caught even if filed under a slightly
//                          different vendor name); if still nothing, EMAIL THE
//                          SUPPLIER once, asking them to resend it.
//
// State lives in ap_statement_missing_invoices (migration 144), keyed on
// (company_file, supplier_uid, invoice_number_norm). That row is what makes the
// */10 cron idempotent — never double-post, never re-spam a supplier. As a
// second backstop, createServiceBill has its own MYOB-side smart-adopt so a
// duplicate SupplierInvoiceNumber links the existing bill instead of creating one.

import type { SupabaseClient } from '@supabase/supabase-js'
import { normaliseInvoiceNumber, type StatementMatchOutcome, type MatchResult } from './ap-statement-match'
import { type CompanyFileLabel, getSupplierByUid } from './ap-myob-lookup'
import { createServiceBill, postFoundInvoiceToMyob } from './ap-myob-bill'
import { huntInvoicesInInbox, type HuntHit } from './ap-inbox-pull'
import { sendMail } from './email'
import { sendMail as graphSendMail } from './microsoft-graph'
import type { ExtractedStatement } from './ap-statement-extraction'

const AMOUNT_TOLERANCE = 0.05

// The `postedBy` uuid stamped on auto-posted bills (ap_invoices.myob_posted_by
// is a uuid). Defaults to Chris's user id; override with a dedicated system
// user via env if audit trails should read differently.
const ACTOR = (process.env.AP_AUTOMATION_ACTOR_ID || '9d09018b-f60b-429d-81e9-cf4bdc28a454').trim()

export type ResolutionOutcome =
  | 'posted'            // created (or adopted) a MYOB bill
  | 'left_for_review'   // ALREADY in the portal AP queue but not safe to auto-post
  | 'found_not_posted'  // found the invoice in the inbox but couldn't safely auto-post — enter manually
  | 'emailed_supplier'  // chased the supplier
  | 'no_supplier_email' // found nowhere and no address to chase
  | 'already_resolved'  // a prior run already handled this one
  | 'skipped'           // dry-run preview / autoresolve disabled

export interface ResolutionAction {
  reference: string | null
  amount: number | null
  date: string | null
  outcome: ResolutionOutcome
  detail: string
  billUid?: string | null
  emailedTo?: string | null
}

export interface ResolveArgs {
  companyFile: CompanyFileLabel
  supplierUid: string
  supplierName: string | null
  // The accounts@ mailbox this statement arrived in — used as sender + Reply-To
  // + CC so a supplier's reply lands back in the inbox the AP intake scans.
  inboxMailbox: string
  statement: ExtractedStatement
  matchOutcome: StatementMatchOutcome
  dryRun: boolean
}

interface ApInvoiceRow {
  id: string
  invoice_number: string | null
  total_inc_gst: number | null
  triage_status: string | null
  triage_override: string | null
  triage_reasons: string[] | null
  resolved_supplier_uid: string | null
  status: string | null
}

const AP_INVOICE_COLS =
  'id, invoice_number, total_inc_gst, triage_status, triage_override, triage_reasons, resolved_supplier_uid, status'

// Portal-review flags that DON'T affect the bill's correctness, so they must not
// block an autonomous post (the automation is separate from the AP portal/queue).
// po-no-job-match = the invoice's PO didn't tie to a workshop job — irrelevant to
// the bill, and always true for JAWS (wholesale, not job-based).
// Which MYOB company files the automation may AUTO-POST to. Chris: VPS only for
// now — JAWS gaps are reconciled + reported for manual entry, never auto-posted.
// Override with AP_AUTOPOST_COMPANY_FILES (comma list, e.g. "VPS,JAWS").
function autoPostFiles(): Set<string> {
  return new Set((process.env.AP_AUTOPOST_COMPANY_FILES || 'VPS').split(',').map(s => s.trim().toUpperCase()).filter(Boolean))
}

const SOFT_TRIAGE_REASONS = new Set(['po-no-job-match'])
function onlySoftReasons(reasons: string[] | null): boolean {
  const flags = (reasons || []).filter(r => r.startsWith('RED:') || r.startsWith('YELLOW:'))
  if (flags.length === 0) return true
  return flags.every(r => SOFT_TRIAGE_REASONS.has(r.replace(/^(RED|YELLOW):/, '').split(':')[0]))
}

const now = () => new Date().toISOString()
const money = (n: number | null | undefined) =>
  n == null || !isFinite(n) ? '—' : `$${Number(n).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const esc = (s: any) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// A found invoice is safe to post automatically when it has a resolved MYOB
// supplier, its total matches the statement line, and it's either fully green or
// only carries soft portal-review flags (e.g. po-no-job-match) that don't affect
// the bill. Real problems (unmapped supplier, uncoded account, low confidence,
// totals mismatch, duplicate, credit note) still make triage non-green with a
// non-soft reason and hold it back.
function canAutoPost(inv: ApInvoiceRow, amount: number | null): boolean {
  const triageOk =
    inv.triage_status === 'green' ||
    inv.triage_override === 'green' ||
    (inv.triage_status === 'yellow' && onlySoftReasons(inv.triage_reasons))
  const amountOk =
    amount != null && inv.total_inc_gst != null &&
    Math.abs(Number(inv.total_inc_gst) - Math.abs(amount)) <= AMOUNT_TOLERANCE
  return triageOk && !!inv.resolved_supplier_uid && amountOk && inv.status !== 'posted' && inv.status !== 'rejected'
}

interface GapWork {
  r: MatchResult
  ref: string | null
  amount: number | null
  date: string | null
  norm: string
  prior: { status: string; supplier_emailed_at: string | null } | null
}

const toIso = (s: string | null | undefined): string | null => {
  if (!s) return null
  const t = Date.parse(s)
  return isFinite(t) ? new Date(t).toISOString() : null
}
const isoDaysAgo = (d: number) => new Date(Date.now() - d * 86400_000).toISOString()

export async function resolveStatementGaps(
  c: SupabaseClient,
  args: ResolveArgs,
): Promise<ResolutionAction[]> {
  const { companyFile, supplierUid, supplierName, inboxMailbox, matchOutcome, dryRun } = args
  const actions: ResolutionAction[] = []
  const mayPost = autoPostFiles().has(companyFile)   // VPS only by default — JAWS is report-only

  // Supplier card once — the email drives BOTH the inbox-hunt sender filter and
  // the chase fallback.
  let supplierEmail: string | null = null
  try { supplierEmail = (await getSupplierByUid(companyFile, supplierUid))?.email || null } catch { /* leave null */ }

  // Persist per-invoice state (skipped on dry-run). Omit first_seen_at so the
  // insert default sticks and re-runs don't reset it.
  const persist = async (w: { norm: string; ref: string | null; amount: number | null; date: string | null }, patch: Record<string, any>) => {
    if (dryRun) return
    try {
      await c.from('ap_statement_missing_invoices').upsert({
        company_file: companyFile, supplier_uid: supplierUid, invoice_number_norm: w.norm,
        invoice_number: w.ref, invoice_date: w.date, amount: w.amount, supplier_name: supplierName,
        last_seen_at: now(), ...patch,
      }, { onConflict: 'company_file,supplier_uid,invoice_number_norm' })
    } catch (e: any) {
      console.error('[statement-resolve] persist failed:', e?.message || e)
    }
  }

  // Post an invoice we've located (already in the portal, or just ingested from
  // the inbox) — but only when it's high-confidence. Otherwise leave it in the
  // AP queue for a human.
  const postFound = async (w: GapWork, invoiceId: string, source: 'portal' | 'inbox'): Promise<ResolutionAction> => {
    const { data } = await c.from('ap_invoices').select(AP_INVOICE_COLS).eq('id', invoiceId).maybeSingle()
    const inv = (data as ApInvoiceRow | null)
    const base = { reference: w.ref, amount: w.amount, date: w.date }
    if (!inv) return { ...base, outcome: 'left_for_review', detail: 'Located an invoice but its row vanished — review manually' }
    if (!canAutoPost(inv, w.amount)) {
      await persist(w, { status: 'left_for_review', posted_invoice_id: invoiceId, last_action_at: now() })
      return { ...base, outcome: 'left_for_review', detail: `${source === 'inbox' ? 'Found in the inbox' : 'In the AP queue'} but needs a human to code/post (${companyFile})` }
    }
    if (dryRun) return { ...base, outcome: 'posted', detail: `Would auto-post to MYOB (${companyFile}, from ${source})` }
    try {
      const r = await createServiceBill(invoiceId, ACTOR)
      const resolution = r.adopted ? 'adopted' : (source === 'portal' ? 'posted_from_portal' : 'posted_from_inbox')
      await persist(w, { status: 'posted', resolution, posted_bill_uid: r.myobBillUid, posted_invoice_id: invoiceId, last_action_at: now(), error: null })
      return { ...base, outcome: 'posted', billUid: r.myobBillUid, detail: r.adopted ? `Linked existing MYOB bill #${r.adoptedBillNumber || '?'} (${companyFile})` : `Auto-posted to MYOB (${companyFile}, from ${source})` }
    } catch (e: any) {
      const msg = (e?.message || String(e)).slice(0, 300)
      await persist(w, { status: 'left_for_review', posted_invoice_id: invoiceId, last_action_at: now(), error: msg })
      return { ...base, outcome: 'left_for_review', detail: `Located the invoice but post failed: ${msg}` }
    }
  }

  // ── Classify every gap; settle in-portal-pending immediately ──
  const gaps = matchOutcome.results.filter(r => r.status === 'missing' || r.status === 'in-portal-pending')
  const missing: GapWork[] = []
  for (const r of gaps) {
    const ref = r.line.invoiceNumber || r.line.reference
    const amount = r.line.amount
    const date = r.line.date
    const norm = normaliseInvoiceNumber(ref)
    if (!norm) continue // can't dedupe an unnumbered line — leave it to the digest
    const { data: existing } = await c.from('ap_statement_missing_invoices')
      .select('status, supplier_emailed_at')
      .eq('company_file', companyFile).eq('supplier_uid', supplierUid).eq('invoice_number_norm', norm)
      .maybeSingle()
    const w: GapWork = { r, ref, amount, date, norm, prior: (existing as any) || null }

    if (w.prior && (w.prior.status === 'posted' || w.prior.status === 'resolved')) {
      await persist(w, {}) // bump last_seen_at only
      actions.push({ reference: ref, amount, date, outcome: 'already_resolved', detail: 'Already resolved on an earlier run' })
      continue
    }
    if (r.status === 'in-portal-pending' && r.portalInvoice?.id) {
      if (mayPost) {
        actions.push(await postFound(w, r.portalInvoice.id, 'portal'))
      } else {
        await persist(w, { status: 'left_for_review', posted_invoice_id: r.portalInvoice.id, last_action_at: now() })
        actions.push({ reference: ref, amount, date, outcome: 'found_not_posted', detail: `${companyFile}: auto-post is off for this company file — enter manually` })
      }
      continue
    }
    missing.push(w) // truly missing — hunt the inbox next
  }

  // ── Search the mailbox itself for the missing invoices ──
  const toChase: GapWork[] = []
  if (missing.length > 0) {
    const sinceIso = toIso(matchOutcome.windowFrom) || isoDaysAgo(60)
    let hits = new Map<string, HuntHit>()
    try {
      hits = await huntInvoicesInInbox({
        mailbox: inboxMailbox, supplierEmail, sinceIsoDate: sinceIso,
        targets: missing.map(w => ({ norm: w.norm, raw: w.ref, amount: w.amount })),
        dryRun,
      })
    } catch (e: any) {
      console.error('[statement-resolve] inbox hunt failed:', e?.message || e)
    }

    for (const w of missing) {
      const hit = hits.get(w.norm)
      if (hit?.found) {
        if (dryRun) {
          actions.push({ reference: w.ref, amount: w.amount, date: w.date, outcome: mayPost ? 'posted' : 'found_not_posted', detail: mayPost ? `Found in inbox (${hit.attachmentName || 'PDF'}) — would post to MYOB` : `Found in inbox (${hit.attachmentName || 'PDF'}) — ${companyFile} auto-post is off; would flag for manual entry` })
        } else if (!mayPost) {
          // Found, but this company file isn't allowed to auto-post → report it.
          await persist(w, { status: 'left_for_review', last_action_at: now() })
          actions.push({ reference: w.ref, amount: w.amount, date: w.date, outcome: 'found_not_posted', detail: `Found in inbox — ${companyFile} auto-post is off; enter manually in MYOB` })
        } else if (hit.extraction && hit.pdfBytes) {
          // Post straight to MYOB from the inbox PDF — no portal row.
          const r = await postFoundInvoiceToMyob({
            companyFile, supplierUid, supplierName,
            extracted: hit.extraction.invoice, statementAmount: w.amount,
            pdfBytes: hit.pdfBytes, pdfFilename: hit.attachmentName || `${w.ref || 'invoice'}.pdf`,
            postedBy: ACTOR,
          })
          if (r.posted) {
            await persist(w, { status: 'posted', resolution: r.adopted ? 'adopted' : 'posted_from_inbox', posted_bill_uid: r.billUid || null, last_action_at: now(), error: null })
            actions.push({ reference: w.ref, amount: w.amount, date: w.date, outcome: 'posted', billUid: r.billUid, detail: r.adopted ? `Found in inbox — linked existing MYOB bill #${r.adoptedBillNumber || '?'} (${companyFile})` : `Found in inbox — auto-posted to MYOB (${companyFile}, ${r.coding})` })
          } else {
            await persist(w, { status: 'left_for_review', last_action_at: now(), error: r.reason || null })
            actions.push({ reference: w.ref, amount: w.amount, date: w.date, outcome: 'found_not_posted', detail: `Found in inbox but couldn't auto-post: ${r.reason || 'needs review'} — enter manually in MYOB` })
          }
        } else {
          toChase.push(w) // found but no payload (shouldn't happen live) — fall back to chase
        }
        continue
      }
      // Not in the inbox — chase the supplier, once.
      if (w.prior && w.prior.status === 'emailed_supplier') {
        actions.push({ reference: w.ref, amount: w.amount, date: w.date, outcome: 'already_resolved', detail: `Supplier already chased${w.prior.supplier_emailed_at ? ` on ${w.prior.supplier_emailed_at.slice(0, 10)}` : ''}` })
      } else {
        toChase.push(w)
      }
    }
  }

  // ── One chase email per supplier covering all its still-missing invoices ──
  if (toChase.length > 0) {
    if (!supplierEmail) {
      for (const w of toChase) {
        await persist(w, { status: 'no_supplier_email', last_action_at: now() })
        actions.push({ reference: w.ref, amount: w.amount, date: w.date, outcome: 'no_supplier_email', detail: 'Not in the inbox and no supplier email on the MYOB card — chase manually' })
      }
    } else if (dryRun) {
      for (const w of toChase) actions.push({ reference: w.ref, amount: w.amount, date: w.date, outcome: 'emailed_supplier', emailedTo: supplierEmail, detail: `Not in inbox — would email ${supplierEmail} to request it` })
    } else {
      const { subject, html } = buildChaseEmail(supplierName, toChase.map(w => ({ reference: w.ref, amount: w.amount, date: w.date })))
      const mail = { to: [supplierEmail], cc: [inboxMailbox], replyTo: inboxMailbox, subject, html }
      // Prefer sending AS the accounts mailbox itself (Graph): the message lands
      // in that mailbox's Sent Items and inherits the tenant's established
      // domain reputation, instead of the cold Resend/SES sender
      // (mail.justautos.app) that supplier spam filters were scoring as junk
      // (SCL 5). Fall back to Resend if Graph can't send — e.g. the Mail.Send
      // app permission isn't consented yet — so a chase never silently stops.
      let sentVia: 'accounts mailbox' | 'Resend' | null = null
      let sendErr: string | null = null
      try {
        await graphSendMail(inboxMailbox, mail)
        sentVia = 'accounts mailbox'
      } catch (ge: any) {
        try {
          await sendMail(inboxMailbox, mail)
          sentVia = 'Resend'
        } catch (re: any) {
          sendErr = (re?.message || String(re)).slice(0, 300)
        }
      }
      if (sentVia) {
        for (const w of toChase) {
          await persist(w, { status: 'emailed_supplier', supplier_emailed_at: now(), supplier_email_to: supplierEmail, last_action_at: now(), error: null })
          actions.push({ reference: w.ref, amount: w.amount, date: w.date, outcome: 'emailed_supplier', emailedTo: supplierEmail, detail: `Not in inbox — emailed ${supplierEmail} to request it (via ${sentVia})` })
        }
      } else {
        for (const w of toChase) {
          await persist(w, { status: 'outstanding', last_action_at: now(), error: sendErr })
          actions.push({ reference: w.ref, amount: w.amount, date: w.date, outcome: 'no_supplier_email', detail: `Supplier email send failed: ${sendErr}` })
        }
      }
    }
  }

  return actions
}

function buildChaseEmail(
  supplierName: string | null,
  lines: { reference: string | null; amount: number | null; date: string | null }[],
): { subject: string; html: string } {
  const n = lines.length
  const subject = `Missing invoice${n === 1 ? '' : 's'} — please resend${supplierName ? ` (${supplierName})` : ''}`
  const rows = lines.map(l =>
    `<tr>` +
    `<td style="padding:4px 12px 4px 0;font-family:monospace">${esc(l.reference || '—')}</td>` +
    `<td style="padding:4px 12px 4px 0;color:#6b7280">${esc(l.date || '—')}</td>` +
    `<td style="padding:4px 0;text-align:right;font-weight:600">${money(l.amount)}</td>` +
    `</tr>`).join('')
  const html =
    `<div style="font-family:system-ui,-apple-system,sans-serif;color:#171a21;max-width:620px;font-size:14px;line-height:1.5">` +
    `<p>Hi${supplierName ? ` ${esc(supplierName)}` : ''},</p>` +
    `<p>Your recent statement lists the following invoice${n === 1 ? '' : 's'} that ${n === 1 ? "we don't" : "we don't"} appear to have received. ` +
    `Could you please resend ${n === 1 ? 'it' : 'them'} so we can process payment?</p>` +
    `<table style="border-collapse:collapse;margin:10px 0">` +
    `<tr style="font-size:12px;color:#6b7280;text-align:left"><th style="padding:0 12px 4px 0">Invoice</th><th style="padding:0 12px 4px 0">Date</th><th style="padding:0 0 4px;text-align:right">Amount</th></tr>` +
    rows +
    `</table>` +
    `<p>Please reply to this email with the invoice${n === 1 ? '' : 's'} attached (PDF is ideal). Thanks!</p>` +
    `<p style="color:#6b7280">Just Autos — Accounts</p>` +
    `</div>`
  return { subject, html }
}
