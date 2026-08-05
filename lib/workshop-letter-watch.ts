// lib/workshop-letter-watch.ts
// SERVER-ONLY. The real trigger for the thank-you letter automation.
//
// Jobs are finalised in MechanicDesk → MD pushes the invoice to MYOB (VPS).
// This polls VPS Sale Invoices through the accounting read seam
// (lib/accounting/read-docs.ts — provider-switched MYOB/Xero, module
// 'LETTERS') and, for each NEW invoice that represents actual work, queues a
// thank-you letter + envelope.
//
// "Job invoice, not a booking deposit" rule (confirmed against live data,
// refined 2026-07-27 after a deposit invoice printed for Gary Winter):
//   • a booking DEPOSIT invoice is paid at booking and holds a POSITIVE line
//     to 1-1230 Customer Deposits; the deposit is later applied/removed on the
//     final job invoice as a NEGATIVE 1-1230 line.
//   • the "positive income (4-xxxx) line" test alone is NOT enough: a deposit
//     invoice can carry a small positive 4-xxxx line for the EFTPOS surcharge
//     FEE (Gary Winter) and wrongly pass. So a positive 1-1230 (held deposit)
//     line vetoes it — that invoice is a booking, not a completed job.
// Print iff: has a positive income (4-xxxx) line AND has no held (positive)
// Customer-Deposit line.
//
// Account codes are MYOB DisplayIDs; on Xero the seam reverse-translates the
// Xero account codes via xero_account_map, and unmapped lines come back with
// accountDisplayId null (fails the income test → skipped, never mis-printed).

import { openSaleInvoiceReader, type SaleInvoiceLineRow } from './accounting/read-docs'
import { WORKSHOP_MYOB_LABEL } from './workshop'
import { getLetterAutomation, getTemplate, enqueueLetter, recordLetterSkip, lettersSeenUids } from './workshop-letters'

const INCOME_RE = /^4-/ // MYOB income accounts
const DEPOSIT_RE = /^1-1230/ // Customer Deposits (liability)

export interface WatchResult {
  enabled: boolean
  scanned: number
  printed: number
  skipped: number
  errors: number
  details: Array<{ number: string; customer: string; total: number; action: string; reason?: string }>
}

function isJobInvoice(lines: SaleInvoiceLineRow[]): boolean {
  if (!Array.isArray(lines)) return false
  return lines.some(l => l && l.type === 'Transaction' && INCOME_RE.test(String(l.accountDisplayId || '')) && l.total > 0)
}

// A booking deposit invoice holds a POSITIVE Customer-Deposit line. Completed
// jobs either have no 1-1230 line or a NEGATIVE one (deposit being applied),
// so this vetoes only genuine deposit invoices.
function holdsDeposit(lines: SaleInvoiceLineRow[]): boolean {
  if (!Array.isArray(lines)) return false
  return lines.some(l => l && DEPOSIT_RE.test(String(l.accountDisplayId || '')) && l.total > 0)
}

export async function runLetterWatch(opts: { dryRun?: boolean; lookbackDays?: number } = {}): Promise<WatchResult> {
  const dryRun = !!opts.dryRun
  const lookbackDays = opts.lookbackDays ?? 7
  const result: WatchResult = { enabled: false, scanned: 0, printed: 0, skipped: 0, errors: 0, details: [] }

  const cfg = await getLetterAutomation()
  // Live runs require it switched on; a dry preview works anytime so you can see
  // what WOULD print before arming it.
  if (!cfg.enabled && !dryRun) return result
  if (!cfg.template_id) return result
  result.enabled = true
  const template = await getTemplate(cfg.template_id)
  if (!template) return result

  // Cutoff = later of (watch_since) and (today − lookback): watch_since prevents
  // a backfill flood the moment it's enabled; the rolling window keeps each
  // steady-state scan small.
  const rolling = new Date(Date.now() - lookbackDays * 86400_000)
  const since = cfg.watch_since ? new Date(cfg.watch_since) : rolling
  const cutoff = (since > rolling ? since : rolling).toISOString().substring(0, 10)

  const reader = await openSaleInvoiceReader(WORKSHOP_MYOB_LABEL, 'LETTERS', cutoff)
  const items = reader.invoices
  result.scanned = items.length

  const seen = await lettersSeenUids(items.map(i => i.uid).filter(Boolean))

  for (const inv of items) {
    const number = inv.number
    const custName0 = inv.customerName
    const total = inv.totalAmount
    if (seen.has(inv.uid)) continue
    if (total < Number(cfg.min_total)) {
      if (!dryRun) await recordLetterSkip(inv.uid, custName0, total, 'below_min')
      result.skipped++; result.details.push({ number, customer: custName0, total, action: 'skip', reason: 'below_min' }); continue
    }

    // Fetch lines → real job/sale, or a pure deposit?
    let lines: SaleInvoiceLineRow[] = []
    try {
      lines = await reader.fetchLines(inv)
    } catch { result.errors++; result.details.push({ number, customer: custName0, total, action: 'error', reason: 'detail_fetch' }); continue }

    if (!isJobInvoice(lines) || holdsDeposit(lines)) {
      const reason = holdsDeposit(lines) ? 'booking_deposit' : 'deposit_or_nonjob'
      if (!dryRun) await recordLetterSkip(inv.uid, custName0, total, reason)
      result.skipped++; result.details.push({ number, customer: custName0, total, action: 'skip', reason }); continue
    }

    // Customer card → name + postal address for the letter/envelope.
    let name = custName0, addrLines: string[] = []
    try {
      const card = await reader.fetchCustomerCard(inv.customerUid, custName0)
      if (card) { name = card.name || custName0; addrLines = card.addressLines }
    } catch { /* fall back to invoice name, no address */ }

    if (dryRun) { result.printed++; result.details.push({ number, customer: name, total, action: 'would_print' }); continue }

    const r = await enqueueLetter({
      trigger: 'auto', customer: { id: null, name }, template,
      recipientNameOverride: name,
      recipientAddressOverride: addrLines.join('\n') || null,
      myobInvoiceUid: inv.uid, invoiceTotal: total,
    })
    if (r.status === 'queued') { result.printed++; result.details.push({ number, customer: name, total, action: 'printed' }) }
    else if (r.status === 'skipped') { result.skipped++ }
    else { result.errors++; result.details.push({ number, customer: name, total, action: 'error', reason: r.error }) }
  }

  return result
}
