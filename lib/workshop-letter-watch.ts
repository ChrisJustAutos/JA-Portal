// lib/workshop-letter-watch.ts
// SERVER-ONLY. The real trigger for the thank-you letter automation.
//
// Jobs are finalised in MechanicDesk → MD pushes the invoice to MYOB (VPS).
// This polls VPS Sale Invoices via the portal's MYOB OAuth connection and, for
// each NEW invoice that represents actual work, queues a thank-you letter +
// envelope.
//
// "Job invoice, not a booking deposit" rule (confirmed against live data):
//   • a booking deposit posts ONLY to 1-1230 Customer Deposits
//   • a job invoice always has ≥1 line posting to an income account (4-xxxx),
//     positive amount (it may ALSO carry a negative 1-1230 "deposit applied")
// So: print iff the invoice has a positive income (4-xxxx) line.

import { getConnection, myobFetch } from './myob'
import { WORKSHOP_MYOB_LABEL } from './workshop'
import { getLetterAutomation, getTemplate, enqueueLetter, recordLetterSkip, lettersSeenUids } from './workshop-letters'

const INCOME_RE = /^4-/ // MYOB income accounts

export interface WatchResult {
  enabled: boolean
  scanned: number
  printed: number
  skipped: number
  errors: number
  details: Array<{ number: string; customer: string; total: number; action: string; reason?: string }>
}

function isJobInvoice(lines: any[]): boolean {
  if (!Array.isArray(lines)) return false
  return lines.some(l => l && l.Type === 'Transaction' && INCOME_RE.test(String(l.Account?.DisplayID || '')) && Number(l.Total) > 0)
}

function customerNameFrom(card: any, fallback: string): string {
  if (!card) return fallback
  if (card.CompanyName) return String(card.CompanyName)
  const n = [card.FirstName, card.LastName].filter(Boolean).join(' ').trim()
  return n || fallback
}

function addressLinesFrom(card: any): string[] {
  const addrs = Array.isArray(card?.Addresses) ? card.Addresses : []
  const a = addrs.find((x: any) => x?.Location === 1) || addrs[0]
  if (!a) return []
  const lines: string[] = []
  if (a.Street) String(a.Street).split(/\r?\n/).map((s: string) => s.trim()).filter(Boolean).forEach((s: string) => lines.push(s))
  const cityLine = [a.City, a.State, a.PostCode].filter(Boolean).join(' ').trim()
  if (cityLine) lines.push(cityLine)
  return lines
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

  const conn = await getConnection(WORKSHOP_MYOB_LABEL)
  if (!conn || !conn.company_file_id) throw new Error(`${WORKSHOP_MYOB_LABEL} MYOB connection not configured`)
  const base = `/accountright/${conn.company_file_id}/Sale/Invoice`

  // Cutoff = later of (watch_since) and (today − lookback): watch_since prevents
  // a backfill flood the moment it's enabled; the rolling window keeps each
  // steady-state scan small.
  const rolling = new Date(Date.now() - lookbackDays * 86400_000)
  const since = cfg.watch_since ? new Date(cfg.watch_since) : rolling
  const cutoff = (since > rolling ? since : rolling).toISOString().substring(0, 10)

  const list = await myobFetch(conn.id, base, { query: { '$filter': `Date ge datetime'${cutoff}'`, '$orderby': 'Date desc', '$top': 200 } })
  if (list.status !== 200) throw new Error(`MYOB invoice list failed (HTTP ${list.status})`)
  const items: any[] = Array.isArray(list.data?.Items) ? list.data.Items : []
  result.scanned = items.length

  const seen = await lettersSeenUids(items.map(i => i.UID).filter(Boolean))

  for (const inv of items) {
    const number = String(inv.Number ?? '')
    const custName0 = inv.Customer?.Name || ''
    const total = Number(inv.TotalAmount) || 0
    if (seen.has(inv.UID)) continue
    if (total < Number(cfg.min_total)) {
      if (!dryRun) await recordLetterSkip(inv.UID, custName0, total, 'below_min')
      result.skipped++; result.details.push({ number, customer: custName0, total, action: 'skip', reason: 'below_min' }); continue
    }

    // Fetch lines → real job/sale, or a pure deposit?
    let lines: any[] = []
    try {
      const d = await myobFetch(conn.id, `${base}/${inv.InvoiceType || 'Item'}/${inv.UID}`)
      lines = Array.isArray(d.data?.Lines) ? d.data.Lines : []
    } catch { result.errors++; result.details.push({ number, customer: custName0, total, action: 'error', reason: 'detail_fetch' }); continue }

    if (!isJobInvoice(lines)) {
      if (!dryRun) await recordLetterSkip(inv.UID, custName0, total, 'deposit_or_nonjob')
      result.skipped++; result.details.push({ number, customer: custName0, total, action: 'skip', reason: 'deposit_or_nonjob' }); continue
    }

    // Customer card → name + postal address for the letter/envelope.
    let name = custName0, addrLines: string[] = []
    try {
      if (inv.Customer?.UID) {
        const c = await myobFetch(conn.id, `/accountright/${conn.company_file_id}/Contact/Customer/${inv.Customer.UID}`)
        if (c.status === 200) { name = customerNameFrom(c.data, custName0); addrLines = addressLinesFrom(c.data) }
      }
    } catch { /* fall back to invoice name, no address */ }

    if (dryRun) { result.printed++; result.details.push({ number, customer: name, total, action: 'would_print' }); continue }

    const r = await enqueueLetter({
      trigger: 'auto', customer: { id: null, name }, template,
      recipientNameOverride: name,
      recipientAddressOverride: addrLines.join('\n') || null,
      myobInvoiceUid: inv.UID, invoiceTotal: total,
    })
    if (r.status === 'queued') { result.printed++; result.details.push({ number, customer: name, total, action: 'printed' }) }
    else if (r.status === 'skipped') { result.skipped++ }
    else { result.errors++; result.details.push({ number, customer: name, total, action: 'error', reason: r.error }) }
  }

  return result
}
