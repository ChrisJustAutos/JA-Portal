// lib/ap-myob-lookup.ts
// MYOB supplier + chart-of-account search wrappers used by the AP supplier
// preset picker AND the auto-match flow.
//
// Built on top of lib/myob.ts:
//   - getConnection(label)  returns the active VPS/JAWS connection row
//   - myobFetch(connId, …)  authenticated fetch with token auto-refresh
//
// MYOB AccountRight uses OData v3 syntax for filtering. Notable quirks:
//   - Substring filter is `substringof('needle', haystack)` (not `contains`)
//   - **substringof is CASE-SENSITIVE** — wrap haystack with tolower() and
//     send needle in lowercase to make searches case-insensitive (this is
//     how we make "fat" find "Fatz Pty Ltd").
//   - String literals use single quotes; quotes inside strings double-up
//   - Boolean operators are `and` / `or` (lowercase)
//   - BuyingDetails is returned inline on /Contact/Supplier list calls — no
//     $expand needed. ExpenseAccount lives there as a nested ref object.

import { getConnection, myobFetch, MyobConnection } from './myob'

export type CompanyFileLabel = 'VPS' | 'JAWS'

// ── Types returned to callers ───────────────────────────────────────────

export interface MyobAccountRef {
  uid: string
  displayId: string
  name: string
}

export interface MyobSupplierLite {
  uid: string
  displayId: string | null      // typically a sequence like "*200"
  name: string                  // CompanyName or fallback
  abn: string | null
  isIndividual: boolean
  // Default purchase/expense account on the MYOB supplier card. Used by
  // the auto-match flow to pre-fill the AP invoice's resolved_account_*.
  defaultExpenseAccount: MyobAccountRef | null
}

export interface MyobAccountLite {
  uid: string
  displayId: string             // e.g. "5-1100"
  name: string                  // e.g. "Cost Of Goods - Parts"
  type: string                  // 'Expense' | 'CostOfSales' | 'OtherExpense' | …
  parentName: string | null
  isHeader: boolean
}

// ── Helpers ─────────────────────────────────────────────────────────────

async function resolveConn(label: CompanyFileLabel): Promise<MyobConnection> {
  const conn = await getConnection(label)
  if (!conn) throw new Error(`No active MYOB connection for ${label}`)
  if (!conn.company_file_id) {
    throw new Error(`MYOB connection ${label} has no company file selected`)
  }
  return conn
}

function escapeOData(s: string): string {
  return s.replace(/'/g, "''")
}

// ── Suppliers ───────────────────────────────────────────────────────────

/**
 * Search MYOB suppliers in the given company file.
 *
 * Case-insensitive multi-token search (May 2026 update):
 *   - The query is lowercased and split into whitespace-separated tokens
 *     (max 3 tokens used, extras dropped). Each token must substring-match
 *     at least one of: CompanyName, LastName, FirstName, DisplayID. All
 *     fields are wrapped in tolower() so casing in the supplier card
 *     doesn't matter.
 *   - Tokens combine with AND, fields combine with OR. So "fatz pty"
 *     finds "Fatz Pty Ltd" because both "fatz" and "pty" appear in the
 *     CompanyName, but it won't match "Fatz Industries" (no "pty").
 *   - Empty/whitespace-only query returns the first `limit` suppliers
 *     ordered by CompanyName, useful as an initial picker list.
 *
 * @param query   optional substring; case-insensitive, multi-token
 * @param limit   max rows returned (capped at 50)
 */
export async function searchSuppliers(
  label: CompanyFileLabel,
  query: string,
  limit: number = 20,
): Promise<MyobSupplierLite[]> {
  const conn = await resolveConn(label)
  const cap = Math.min(Math.max(limit, 1), 50)
  const path = `/accountright/${conn.company_file_id}/Contact/Supplier`

  const params: Record<string, string | number> = {
    '$top': cap,
    '$orderby': 'CompanyName',
  }

  // Build a case-insensitive multi-token filter. Each token must hit at
  // least one of the four searchable fields (CompanyName, LastName,
  // FirstName, DisplayID). All comparisons are lowercase. We cap at 3
  // tokens — beyond that, OData $filter strings get long and supplier
  // names rarely span more than a couple of distinctive words.
  const lowered = query.trim().toLowerCase()
  if (lowered) {
    const tokens = lowered.split(/\s+/).filter(t => t.length > 0).slice(0, 3)
    if (tokens.length > 0) {
      const tokenClauses = tokens.map(tok => {
        const safe = escapeOData(tok)
        return (
          `(substringof('${safe}',tolower(CompanyName)) or ` +
          `substringof('${safe}',tolower(LastName)) or ` +
          `substringof('${safe}',tolower(FirstName)) or ` +
          `substringof('${safe}',tolower(DisplayID)))`
        )
      })
      params['$filter'] = tokenClauses.join(' and ')
    }
  }

  const result = await myobFetch(conn.id, path, { query: params })
  if (result.status !== 200) {
    throw new Error(`MYOB supplier search failed (HTTP ${result.status}): ${(result.raw || '').substring(0, 200)}`)
  }

  const items: any[] = Array.isArray(result.data?.Items) ? result.data.Items : []
  return items.map(mapSupplier)
}

export async function getSupplierByUid(
  label: CompanyFileLabel,
  uid: string,
): Promise<MyobSupplierLite | null> {
  const conn = await resolveConn(label)
  const path = `/accountright/${conn.company_file_id}/Contact/Supplier/${uid}`
  const result = await myobFetch(conn.id, path)
  if (result.status === 404) return null
  if (result.status !== 200) {
    throw new Error(`MYOB getSupplier failed (HTTP ${result.status}): ${(result.raw || '').substring(0, 200)}`)
  }
  return mapSupplier(result.data)
}

function mapSupplier(it: any): MyobSupplierLite {
  const company = (it?.CompanyName || '').trim()
  const first = (it?.FirstName || '').trim()
  const last = (it?.LastName || '').trim()
  const name = company || [first, last].filter(Boolean).join(' ') || '(unnamed supplier)'
  const abn =
    it?.BuyingDetails?.ABN ||
    it?.SellingDetails?.ABN ||
    it?.ABN ||
    null

  const expenseAcc = it?.BuyingDetails?.ExpenseAccount
  const defaultExpenseAccount: MyobAccountRef | null = expenseAcc?.UID
    ? {
        uid: expenseAcc.UID,
        displayId: expenseAcc.DisplayID || '',
        name: expenseAcc.Name || '',
      }
    : null

  return {
    uid: it.UID,
    displayId: it.DisplayID || null,
    name,
    abn: abn ? String(abn).replace(/\s/g, '') : null,
    isIndividual: it.IsIndividual === true,
    defaultExpenseAccount,
  }
}

// ── Accounts ────────────────────────────────────────────────────────────

/**
 * Search MYOB chart of accounts. Defaults to Expense + CostOfSales, which
 * covers the typical AP postings (parts COGS, operating expenses). Pass an
 * empty types array to search everything.
 *
 * Same case-insensitive convention as searchSuppliers — query is
 * lowercased and matched against tolower(Name) and tolower(DisplayID).
 *
 * @param query   optional substring; matched against Name + DisplayID
 */
export async function searchAccounts(
  label: CompanyFileLabel,
  query: string,
  limit: number = 30,
  types: string[] = ['Expense', 'CostOfSales'],
): Promise<MyobAccountLite[]> {
  const conn = await resolveConn(label)
  const cap = Math.min(Math.max(limit, 1), 100)
  const path = `/accountright/${conn.company_file_id}/GeneralLedger/Account`

  const filterParts: string[] = []

  if (types.length > 0) {
    const typeOr = types.map(t => `Type eq '${escapeOData(t)}'`).join(' or ')
    filterParts.push(`(${typeOr})`)
  }

  // Header accounts can't have transactions posted to them — filter out.
  filterParts.push(`IsHeader eq false`)

  const lowered = query.trim().toLowerCase()
  if (lowered) {
    const safe = escapeOData(lowered)
    filterParts.push(
      `(substringof('${safe}',tolower(Name)) or substringof('${safe}',tolower(DisplayID)))`
    )
  }

  const params: Record<string, string | number> = {
    '$top': cap,
    '$orderby': 'DisplayID',
  }
  if (filterParts.length > 0) params['$filter'] = filterParts.join(' and ')

  const result = await myobFetch(conn.id, path, { query: params })
  if (result.status !== 200) {
    throw new Error(`MYOB account search failed (HTTP ${result.status}): ${(result.raw || '').substring(0, 200)}`)
  }

  const items: any[] = Array.isArray(result.data?.Items) ? result.data.Items : []
  return items.map(mapAccount)
}

export async function getAccountByUid(
  label: CompanyFileLabel,
  uid: string,
): Promise<MyobAccountLite | null> {
  const conn = await resolveConn(label)
  const path = `/accountright/${conn.company_file_id}/GeneralLedger/Account/${uid}`
  const result = await myobFetch(conn.id, path)
  if (result.status === 404) return null
  if (result.status !== 200) {
    throw new Error(`MYOB getAccount failed (HTTP ${result.status}): ${(result.raw || '').substring(0, 200)}`)
  }
  return mapAccount(result.data)
}

function mapAccount(it: any): MyobAccountLite {
  return {
    uid: it.UID,
    displayId: it.DisplayID || '',
    name: it.Name || '',
    type: it.Type || '',
    parentName: it.ParentAccount?.Name || null,
    isHeader: it.IsHeader === true,
  }
}
