// lib/ap-myob-lookup.ts
// MYOB supplier + chart-of-account search wrappers used by the AP supplier
// preset picker.
//
// Built on top of lib/myob.ts:
//   - getConnection(label)  returns the active VPS/JAWS connection row
//   - myobFetch(connId, …)  authenticated fetch with token auto-refresh
//
// MYOB AccountRight uses OData v3 syntax for filtering. Notable quirks:
//   - Substring filter is `substringof('needle', haystack)` (not `contains`)
//   - String literals use single quotes; quotes inside strings double-up
//   - Boolean operators are `and` / `or` (lowercase)

import { getConnection, myobFetch, MyobConnection } from './myob'

export type CompanyFileLabel = 'VPS' | 'JAWS'

// ── Types returned to callers ───────────────────────────────────────────

export interface MyobSupplierLite {
  uid: string
  displayId: string | null      // typically a sequence like "*200"
  name: string                  // CompanyName or fallback
  abn: string | null
  isIndividual: boolean
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
 * @param query   optional substring; matched against CompanyName, FirstName,
 *                LastName (covers both companies and sole traders)
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

  const trimmed = query.trim()
  if (trimmed) {
    const safe = escapeOData(trimmed)
    params['$filter'] =
      `substringof('${safe}',CompanyName) or ` +
      `substringof('${safe}',LastName) or ` +
      `substringof('${safe}',FirstName)`
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
  return {
    uid: it.UID,
    displayId: it.DisplayID || null,
    name,
    abn: abn ? String(abn).replace(/\s/g, '') : null,
    isIndividual: it.IsIndividual === true,
  }
}

// ── Accounts ────────────────────────────────────────────────────────────

/**
 * Search MYOB chart of accounts. Defaults to Expense + CostOfSales, which
 * covers the typical AP postings (parts COGS, operating expenses). Pass an
 * empty types array to search everything.
 *
 * @param query   optional substring; matched against Name, DisplayID,
 *                Description
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

  const trimmed = query.trim()
  if (trimmed) {
    const safe = escapeOData(trimmed)
    filterParts.push(
      `(substringof('${safe}',Name) or substringof('${safe}',DisplayID))`
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
