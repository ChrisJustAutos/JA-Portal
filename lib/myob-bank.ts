// lib/myob-bank.ts
// MYOB AccountRight bank-transaction fetcher used by the daily Slack
// payments digest (cron /api/cron/bank-payments-slack).
//
// Pulls Spend Money + Receive Money rows from a company file filtered by
// LastModified — that catches transactions newly entered OR re-allocated
// from the bank feed within the window, which is closer to "what changed
// overnight" than filtering by Date (Date can be back-dated).
//
// MYOB AccountRight uses OData v3:
//   ?$filter=LastModified ge datetime'2026-05-10T20:00:00'
//   string literal in single quotes, no Z, no offset
//
// Endpoints (paginated via NextPageLink in JSON body):
//   /accountright/{cfId}/Banking/SpendMoneyTxn
//   /accountright/{cfId}/Banking/ReceiveMoneyTxn

import { getConnection, myobFetch } from './myob'

export type CompanyFileLabel = 'VPS' | 'JAWS'

export interface BankTxn {
  uid: string
  kind: 'spend' | 'receive'
  date: string                // ISO yyyy-mm-dd
  lastModified: string        // ISO
  number: string | null       // cheque/txn number
  amount: number              // always positive (kind tells direction)
  payeeOrPayer: string | null
  memo: string | null
  bankAccountName: string | null
  bankAccountDisplayId: string | null
}

interface MyobPage<T> {
  Items: T[]
  NextPageLink: string | null
  Count?: number
}

function toAmount(v: any): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v || 0))
  return isFinite(n) ? n : 0
}

function pickContactName(row: any): string | null {
  // Spend Money: Payee object OR Card.Name fallback
  // Receive Money: Payer object OR Card.Name fallback
  const direct = row?.Payee || row?.Payer
  if (typeof direct === 'string' && direct.trim()) return direct.trim()
  const cardName = row?.Card?.Name
  if (typeof cardName === 'string' && cardName.trim()) return cardName.trim()
  return null
}

function pickAccount(row: any): { name: string | null; displayId: string | null } {
  // The "Account" field on Spend/Receive Money is the bank account itself.
  const acct = row?.Account
  if (acct && typeof acct === 'object') {
    return {
      name: typeof acct.Name === 'string' ? acct.Name : null,
      displayId: typeof acct.DisplayID === 'string' ? acct.DisplayID : null,
    }
  }
  return { name: null, displayId: null }
}

function normaliseSpend(row: any): BankTxn {
  const acct = pickAccount(row)
  return {
    uid: String(row.UID),
    kind: 'spend',
    date: String(row.Date || '').slice(0, 10),
    lastModified: String(row.LastModified || row.Date || ''),
    number: row.Number ? String(row.Number) : null,
    amount: toAmount(row.AmountPaid),
    payeeOrPayer: pickContactName(row),
    memo: typeof row.Memo === 'string' ? row.Memo.trim() || null : null,
    bankAccountName: acct.name,
    bankAccountDisplayId: acct.displayId,
  }
}

function normaliseReceive(row: any): BankTxn {
  const acct = pickAccount(row)
  return {
    uid: String(row.UID),
    kind: 'receive',
    date: String(row.Date || '').slice(0, 10),
    lastModified: String(row.LastModified || row.Date || ''),
    number: row.Number ? String(row.Number) : null,
    amount: toAmount(row.AmountReceived),
    payeeOrPayer: pickContactName(row),
    memo: typeof row.Memo === 'string' ? row.Memo.trim() || null : null,
    bankAccountName: acct.name,
    bankAccountDisplayId: acct.displayId,
  }
}

// MYOB OData expects `datetime'YYYY-MM-DDTHH:MM:SS'` with no Z / offset.
// We pass a UTC instant but format it as a naked datetime literal — MYOB
// interprets it in the company file's local time which for VPS/JAWS is
// Australia/Sydney. For our purposes "since Sydney time X" is computed
// upstream, so we format that as the literal.
function formatODataDateTime(d: Date): string {
  // Render as Sydney-local wall clock so the filter matches MYOB's TZ.
  const fmt = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Australia/Sydney',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  })
  // sv-SE gives "YYYY-MM-DD HH:mm:ss" — swap the space for a T.
  return fmt.format(d).replace(' ', 'T')
}

async function fetchPaged<T>(
  connId: string,
  path: string,
  filterIso: string,
  normalise: (row: any) => T,
  maxPages = 10,
): Promise<T[]> {
  const out: T[] = []
  let url: string | null = path
  let query: Record<string, string | number> | undefined = {
    '$filter': `LastModified ge datetime'${filterIso}'`,
    '$top': 400,
  }

  for (let i = 0; i < maxPages && url; i++) {
    const { status, data } = await myobFetch(connId, url, { query })
    if (status !== 200) {
      throw new Error(`MYOB ${path} returned HTTP ${status}`)
    }
    const page = data as MyobPage<any>
    const items = Array.isArray(page?.Items) ? page.Items : []
    for (const row of items) out.push(normalise(row))

    const next = page?.NextPageLink
    if (next && typeof next === 'string') {
      // NextPageLink is an absolute URL — myobFetch only takes paths.
      try {
        const u = new URL(next)
        url = u.pathname + u.search
        query = undefined  // query already baked into the next link
      } catch {
        url = null
      }
    } else {
      url = null
    }
  }
  return out
}

export interface CompanyTxnsResult {
  label: CompanyFileLabel
  connected: boolean
  error?: string
  txns: BankTxn[]
}

export async function fetchBankTxnsSince(
  label: CompanyFileLabel,
  since: Date,
): Promise<CompanyTxnsResult> {
  const conn = await getConnection(label)
  if (!conn) {
    return { label, connected: false, txns: [], error: 'Not connected' }
  }
  if (!conn.company_file_id) {
    return { label, connected: false, txns: [], error: 'No company file selected' }
  }

  const filterIso = formatODataDateTime(since)
  const cfId = conn.company_file_id

  try {
    const [spend, receive] = await Promise.all([
      fetchPaged(conn.id, `/accountright/${cfId}/Banking/SpendMoneyTxn`, filterIso, normaliseSpend),
      fetchPaged(conn.id, `/accountright/${cfId}/Banking/ReceiveMoneyTxn`, filterIso, normaliseReceive),
    ])
    const txns = [...spend, ...receive].sort((a, b) => {
      // Newest first
      if (a.date !== b.date) return a.date < b.date ? 1 : -1
      return a.lastModified < b.lastModified ? 1 : -1
    })
    return { label, connected: true, txns }
  } catch (e: any) {
    return { label, connected: true, txns: [], error: (e?.message || String(e)).slice(0, 300) }
  }
}
