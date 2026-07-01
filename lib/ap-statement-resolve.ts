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
import { normaliseInvoiceNumber, type StatementMatchOutcome } from './ap-statement-match'
import { type CompanyFileLabel, getSupplierByUid } from './ap-myob-lookup'
import { createServiceBill } from './ap-myob-bill'
import { sendMail } from './email'
import type { ExtractedStatement } from './ap-statement-extraction'

const AMOUNT_TOLERANCE = 0.05

// The `postedBy` uuid stamped on auto-posted bills (ap_invoices.myob_posted_by
// is a uuid). Defaults to Chris's user id; override with a dedicated system
// user via env if audit trails should read differently.
const ACTOR = (process.env.AP_AUTOMATION_ACTOR_ID || '9d09018b-f60b-429d-81e9-cf4bdc28a454').trim()

export type ResolutionOutcome =
  | 'posted'            // created (or adopted) a MYOB bill
  | 'left_for_review'   // found in the portal but not safe to auto-post
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
  resolved_supplier_uid: string | null
  status: string | null
}

const AP_INVOICE_COLS =
  'id, invoice_number, total_inc_gst, triage_status, triage_override, resolved_supplier_uid, status'

const now = () => new Date().toISOString()
const money = (n: number | null | undefined) =>
  n == null || !isFinite(n) ? '—' : `$${Number(n).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const esc = (s: any) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// A found invoice is safe to post automatically only when it's high-confidence:
// triage green (or explicitly overridden green) + a resolved MYOB supplier +
// its total matching the statement line within the same tolerance the matcher
// uses. Everything else falls through to a human.
function canAutoPost(inv: ApInvoiceRow, amount: number | null): boolean {
  const green = (inv.triage_status === 'green' || inv.triage_override === 'green') && !!inv.resolved_supplier_uid
  const amountOk =
    amount != null && inv.total_inc_gst != null &&
    Math.abs(Number(inv.total_inc_gst) - Math.abs(amount)) <= AMOUNT_TOLERANCE
  return green && amountOk && inv.status !== 'posted' && inv.status !== 'rejected'
}

export async function resolveStatementGaps(
  c: SupabaseClient,
  args: ResolveArgs,
): Promise<ResolutionAction[]> {
  const { companyFile, supplierUid, supplierName, inboxMailbox, matchOutcome, dryRun } = args
  const actions: ResolutionAction[] = []
  const toChase: { reference: string | null; amount: number | null; date: string | null; norm: string }[] = []

  // Persist the per-invoice state (skipped on dry-run). Omit first_seen_at so
  // the insert default sticks and re-runs don't reset it.
  const persist = async (norm: string, ref: string | null, amount: number | null, date: string | null, patch: Record<string, any>) => {
    if (dryRun) return
    try {
      await c.from('ap_statement_missing_invoices').upsert({
        company_file: companyFile,
        supplier_uid: supplierUid,
        invoice_number_norm: norm,
        invoice_number: ref,
        invoice_date: date,
        amount,
        supplier_name: supplierName,
        last_seen_at: now(),
        ...patch,
      }, { onConflict: 'company_file,supplier_uid,invoice_number_norm' })
    } catch (e: any) {
      console.error('[statement-resolve] persist failed:', e?.message || e)
    }
  }

  const post = async (
    norm: string, ref: string | null, amount: number | null, date: string | null,
    invoiceId: string, source: 'portal' | 'inbox',
  ): Promise<ResolutionAction> => {
    if (dryRun) {
      return { reference: ref, amount, date, outcome: 'posted', detail: `Would auto-post to MYOB (${companyFile}, from ${source})` }
    }
    try {
      const r = await createServiceBill(invoiceId, ACTOR)
      const resolution = r.adopted ? 'adopted' : (source === 'portal' ? 'posted_from_portal' : 'posted_from_inbox')
      await persist(norm, ref, amount, date, {
        status: 'posted', resolution, posted_bill_uid: r.myobBillUid, posted_invoice_id: invoiceId,
        last_action_at: now(), error: null,
      })
      return {
        reference: ref, amount, date, outcome: 'posted', billUid: r.myobBillUid,
        detail: r.adopted ? `Linked existing MYOB bill #${r.adoptedBillNumber || '?'} (${companyFile})` : `Auto-posted to MYOB (${companyFile})`,
      }
    } catch (e: any) {
      const msg = (e?.message || String(e)).slice(0, 300)
      await persist(norm, ref, amount, date, { status: 'left_for_review', posted_invoice_id: invoiceId, last_action_at: now(), error: msg })
      return { reference: ref, amount, date, outcome: 'left_for_review', detail: `Found in AP queue but post failed: ${msg}` }
    }
  }

  for (const r of matchOutcome.results) {
    if (r.status !== 'missing' && r.status !== 'in-portal-pending') continue
    const ref = r.line.invoiceNumber || r.line.reference
    const amount = r.line.amount
    const date = r.line.date
    const norm = normaliseInvoiceNumber(ref)
    if (!norm) continue // can't dedupe an unnumbered line — leave it to the digest

    // Prior state — a settled row means nothing to do.
    const { data: existing } = await c.from('ap_statement_missing_invoices')
      .select('status, resolution, supplier_emailed_at')
      .eq('company_file', companyFile).eq('supplier_uid', supplierUid).eq('invoice_number_norm', norm)
      .maybeSingle()
    const prior = (existing as any) || null
    if (prior && (prior.status === 'posted' || prior.status === 'resolved')) {
      await persist(norm, ref, amount, date, {}) // bump last_seen_at only
      actions.push({ reference: ref, amount, date, outcome: 'already_resolved', detail: 'Already resolved on an earlier run' })
      continue
    }

    // Is there an invoice we can post? Either the matcher already tied it to the
    // portal (in-portal-pending), or a broad lookup finds one the matcher's
    // supplier/window scope missed.
    let candidate: ApInvoiceRow | null = null
    if (r.status === 'in-portal-pending' && r.portalInvoice?.id) {
      const { data } = await c.from('ap_invoices').select(AP_INVOICE_COLS).eq('id', r.portalInvoice.id).maybeSingle()
      candidate = (data as any) || null
    } else if (r.status === 'missing' && amount != null) {
      candidate = await broadFindInvoice(c, companyFile, norm, amount)
    }

    if (candidate) {
      const source: 'portal' | 'inbox' = r.status === 'in-portal-pending' ? 'portal' : 'inbox'
      if (canAutoPost(candidate, amount)) {
        actions.push(await post(norm, ref, amount, date, candidate.id, source))
      } else {
        await persist(norm, ref, amount, date, { status: 'left_for_review', posted_invoice_id: candidate.id, last_action_at: now() })
        actions.push({ reference: ref, amount, date, outcome: 'left_for_review', detail: `In the AP queue but needs a human to code/post (${companyFile})` })
      }
      continue
    }

    // Nothing anywhere. Chase the supplier — but only once.
    if (prior && prior.status === 'emailed_supplier') {
      actions.push({ reference: ref, amount, date, outcome: 'already_resolved', detail: `Supplier already chased${prior.supplier_emailed_at ? ` on ${prior.supplier_emailed_at.slice(0, 10)}` : ''}` })
      continue
    }
    toChase.push({ reference: ref, amount, date, norm })
  }

  // One chase email per supplier covering all their outstanding invoices.
  if (toChase.length > 0) {
    let email: string | null = null
    try { email = (await getSupplierByUid(companyFile, supplierUid))?.email || null } catch { /* leave null */ }

    if (!email) {
      for (const g of toChase) {
        await persist(g.norm, g.reference, g.amount, g.date, { status: 'no_supplier_email', last_action_at: now() })
        actions.push({ reference: g.reference, amount: g.amount, date: g.date, outcome: 'no_supplier_email', detail: 'No supplier email on the MYOB card — chase manually' })
      }
    } else if (dryRun) {
      for (const g of toChase) actions.push({ reference: g.reference, amount: g.amount, date: g.date, outcome: 'emailed_supplier', emailedTo: email, detail: `Would email ${email} to request this invoice` })
    } else {
      const { subject, html } = buildChaseEmail(supplierName, toChase)
      try {
        await sendMail(inboxMailbox, { to: [email], cc: [inboxMailbox], replyTo: inboxMailbox, subject, html })
        for (const g of toChase) {
          await persist(g.norm, g.reference, g.amount, g.date, { status: 'emailed_supplier', supplier_emailed_at: now(), supplier_email_to: email, last_action_at: now(), error: null })
          actions.push({ reference: g.reference, amount: g.amount, date: g.date, outcome: 'emailed_supplier', emailedTo: email, detail: `Emailed ${email} to request this invoice` })
        }
      } catch (e: any) {
        const msg = (e?.message || String(e)).slice(0, 300)
        for (const g of toChase) {
          await persist(g.norm, g.reference, g.amount, g.date, { status: 'outstanding', last_action_at: now(), error: msg })
          actions.push({ reference: g.reference, amount: g.amount, date: g.date, outcome: 'no_supplier_email', detail: `Supplier email send failed: ${msg}` })
        }
      }
    }
  }

  return actions
}

// Broad hunt for an invoice already ingested into ap_invoices that the matcher's
// supplier+window scope missed. Filter on company file + amount (± tolerance) in
// SQL to keep the set tiny, then match the normalised invoice number in JS
// (Postgres can't cheaply reproduce normaliseInvoiceNumber). Never returns a
// posted/rejected row.
async function broadFindInvoice(
  c: SupabaseClient, companyFile: CompanyFileLabel, norm: string, amount: number,
): Promise<ApInvoiceRow | null> {
  const abs = Math.abs(amount)
  const { data } = await c.from('ap_invoices')
    .select(AP_INVOICE_COLS)
    .eq('myob_company_file', companyFile)
    .not('status', 'in', '("posted","rejected")')
    .gte('total_inc_gst', abs - AMOUNT_TOLERANCE)
    .lte('total_inc_gst', abs + AMOUNT_TOLERANCE)
    .limit(50)
  const rows = (data || []) as ApInvoiceRow[]
  return rows.find(row => normaliseInvoiceNumber(row.invoice_number) === norm) || null
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
