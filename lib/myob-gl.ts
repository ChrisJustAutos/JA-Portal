// lib/myob-gl.ts
//
// General Ledger journal lines from MYOB AccountRight, via the existing
// per-company-file OAuth connections (lib/myob getConnection + myobFetch).
// Built for the Management Dashboard report (lib/mgmt-dashboard) — the live
// replacement for the pasted "General Ledger [Detail]" report the Excel
// workbook was built on.
//
// Endpoint: /GeneralLedger/JournalTransaction — one record per posted journal
// (Sale/Purchase/CashPayment/CashReceipt/General/Inventory), with the GL
// distribution nested in Lines[]. Each line carries Account + Amount +
// IsCredit. We flatten to one row per line with a SIGNED amount:
//
//     amount = debit − credit   (debits positive, credits negative)
//
// so revenue (a credit balance) sums as Σ(−amount) over 4-* accounts and
// COGS/expenses sum as Σ(amount) over 5-*/6-* — matching the workbook's
// (H−G)/(G−H) building blocks.
//
// Conventions copied from lib/myob-reporting (read that file before editing):
//   - NextPageLink cursor paging is MANDATORY (bare $top/$skip silently drops
//     rows on multi-page pulls — 2026-07-21 EOFY reconciliation bug).
//   - NextPageLink's HOST varies (arl*.api.myob.com) — keep only path+query.
//   - $filter dates are datetime'YYYY-MM-DDT00:00:00' literals, ranges are
//     [start, endExclusive).
//   - $top capped at 400 (AccountRight max).
//   - Explicit $orderby keeps skip-based paging deterministic.

import { getConnection, myobFetch } from './myob'

type CompanyFileLabel = 'VPS' | 'JAWS'

const PAGE = 400

const dt = (d: string) => `datetime'${d}T00:00:00'`

async function conn(label: CompanyFileLabel) {
  const c = await getConnection(label)
  if (!c?.company_file_id) throw new Error(`No active MYOB connection for ${label}`)
  return c
}

// GET an AccountRight entity, following NextPageLink until exhausted.
async function fetchAll(label: CompanyFileLabel, entity: string, query: Record<string, string | number> = {}): Promise<any[]> {
  const c = await conn(label)
  const out: any[] = []
  let path: string | null = `/accountright/${c.company_file_id}/${entity}`
  let firstQuery: Record<string, string | number> | null = { ...query, '$top': PAGE }
  for (let page = 0; page < 500 && path; page++) {
    const r = await myobFetch(c.id, path, firstQuery ? { query: firstQuery } : {})
    if (r.status !== 200) throw new Error(`MYOB ${entity} ${label}: HTTP ${r.status} ${(r.raw || '').slice(0, 160)}`)
    const items: any[] = Array.isArray(r.data?.Items) ? r.data.Items : []
    out.push(...items)
    const next: string | null = typeof r.data?.NextPageLink === 'string' && r.data.NextPageLink ? r.data.NextPageLink : null
    if (next) {
      try { const u = new URL(next, 'https://api.myob.com'); path = u.pathname + u.search } catch { path = null }
    } else {
      path = null
    }
    firstQuery = null
  }
  return out
}

// One flattened GL journal line.
export interface GlLine {
  dateIso: string                 // YYYY-MM-DD (DateOccurred)
  accountDisplayId: string        // e.g. '4-1401'
  accountName: string
  amount: number                  // SIGNED: debit − credit (credits negative)
  memo: string | null             // journal Description, e.g. 'Sale; Penrith 4x4'
  invoiceNumberish: string | null // journal DisplayID = the GL report's "ID No."
                                  // (invoice/bill/txn number, e.g. 'JAWSB2B0037')
  journalType: string | null      // Sale | Purchase | CashPayment | CashReceipt | General | Inventory
}

// GL journal lines for [start, endExclusive), flattened + signed.
//
// Gotchas learned building this:
//   - JournalTransaction has NO typed sub-endpoints — one endpoint, filter by
//     DateOccurred. DatePosted also exists; the workbook's GL report keys on
//     transaction date, so DateOccurred is the right filter.
//   - Line Amount is a positive magnitude with an IsCredit flag (not signed).
//   - The journal-level DisplayID is what the pasted GL [Detail] report shows
//     as "ID No." — it's the invoice number for SJ journals, which is what the
//     B2B-intercompany exclusion rule matches on.
//   - Lines have no per-line description; the journal Description (memo) is
//     shared by all lines of the journal.
export async function fetchGlJournalLines(
  label: CompanyFileLabel,
  opts: { start: string; endExclusive: string },
): Promise<GlLine[]> {
  const filter = `DateOccurred ge ${dt(opts.start)} and DateOccurred lt ${dt(opts.endExclusive)}`
  const raw = await fetchAll(label, 'GeneralLedger/JournalTransaction', {
    '$filter': filter,
    '$orderby': 'DateOccurred',
  })
  const out: GlLine[] = []
  for (const j of raw) {
    const dateIso = typeof j.DateOccurred === 'string' ? j.DateOccurred.slice(0, 10) : ''
    if (!dateIso) continue
    const memo: string | null = j.Description ?? null
    const invoiceNumberish: string | null = j.DisplayID ?? null
    const journalType: string | null = j.JournalType ?? null
    for (const l of Array.isArray(j.Lines) ? j.Lines : []) {
      const code = l.Account?.DisplayID
      if (!code) continue
      const mag = Number(l.Amount) || 0
      out.push({
        dateIso,
        accountDisplayId: String(code),
        accountName: l.Account?.Name ?? '',
        amount: l.IsCredit === true ? -mag : mag,
        memo,
        invoiceNumberish,
        journalType,
      })
    }
  }
  return out
}

// One chart-of-accounts row, with live balance (for the Cash-in-Bank KPI).
export interface GlAccount {
  uid: string
  code: string          // DisplayID, e.g. '1-1110'
  name: string
  type: string          // Bank | Income | CostOfSales | Expense | OtherIncome | …
  classification: string | null // Asset | Liability | Income | CostOfSales | Expense | Equity …
  isHeader: boolean
  currentBalance: number
}

// Full (postable) chart of accounts with current balances.
export async function fetchGlAccounts(label: CompanyFileLabel): Promise<GlAccount[]> {
  const raw = await fetchAll(label, 'GeneralLedger/Account', {
    '$filter': 'IsHeader eq false',
    '$orderby': 'DisplayID',
  })
  return raw.map((a): GlAccount => ({
    uid: a.UID,
    code: a.DisplayID || '',
    name: a.Name || '',
    type: a.Type || '',
    classification: a.Classification ?? null,
    isHeader: a.IsHeader === true,
    currentBalance: Number(a.CurrentBalance) || 0,
  }))
}
