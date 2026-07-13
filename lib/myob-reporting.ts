// lib/myob-reporting.ts
//
// Direct-OAuth replacement for the CData reporting queries (CData decommissioned
// 2026-07-14). Reads the AccountRight REST API via the existing per-company-file
// OAuth connections (lib/myob getConnection + myobFetch) and returns plain row
// objects with the SAME field names the old CData/PowerBI queries produced, so
// the report endpoints change as little as possible.
//
// Key structural difference from CData: AccountRight nests invoice LINES inside
// each invoice (Sale/Invoice/Item → Items[].Lines[]), rather than exposing a
// separate flat SaleInvoiceItems table. fetchSaleInvoicesWithLines() returns
// both the header rows and a flattened line list from a single pass.
//
// P&L reports are intentionally NOT reimplemented — AccountRight has no P&L
// endpoint and the portal P&L panels were retired in this migration.

import { getConnection, myobFetch } from './myob'

// VPS | JAWS — matches the connection labels in myob_connections.
type CompanyFileLabel = 'VPS' | 'JAWS'

const PAGE = 400 // AccountRight max $top

async function conn(label: CompanyFileLabel) {
  const c = await getConnection(label)
  if (!c?.company_file_id) throw new Error(`No active MYOB connection for ${label}`)
  return c
}

// GET an AccountRight entity, following NextPageLink until exhausted.
async function fetchAll(label: CompanyFileLabel, entity: string, query: Record<string, string | number> = {}): Promise<any[]> {
  const c = await conn(label)
  const base = `/accountright/${c.company_file_id}/${entity}`
  const out: any[] = []
  let skip = 0
  // Use $top/$skip paging; AccountRight also returns NextPageLink but $skip is
  // simpler and deterministic for our filtered pulls.
  for (let page = 0; page < 200; page++) {
    const r = await myobFetch(c.id, base, { query: { ...query, '$top': PAGE, '$skip': skip } })
    if (r.status !== 200) throw new Error(`MYOB ${entity} ${label}: HTTP ${r.status} ${(r.raw || '').slice(0, 160)}`)
    const items: any[] = Array.isArray(r.data?.Items) ? r.data.Items : []
    out.push(...items)
    if (items.length < PAGE) break
    skip += PAGE
  }
  return out
}

// MYOB $filter wants dates as datetime literals; ranges are [start, endExclusive).
const dt = (d: string) => `datetime'${d}T00:00:00'`

export interface SaleInvoiceRow {
  ID: string; Number: string | null; Date: string | null; CustomerName: string | null
  CustomerPurchaseOrderNumber: string | null; IsTaxInclusive: boolean
  TotalAmount: number; TotalTax: number; BalanceDueAmount: number; Status: string | null; InvoiceType: string | null
}
export interface SaleLineRow {
  SaleInvoiceId: string; AccountDisplayID: string | null; AccountName: string | null
  TaxCodeCode: string | null; Total: number; Description: string | null
  ItemNumber: string | null; ItemName: string | null; ShipQuantity: number | null; UnitPrice: number | null; RowID: string | null
}

// Sale invoices (Item type — carries Lines) for a date range, with lines
// flattened. Both shapes carry CData-compatible field names.
export async function fetchSaleInvoicesWithLines(
  label: CompanyFileLabel, opts: { start?: string; endExclusive?: string } = {},
): Promise<{ invoices: SaleInvoiceRow[]; lines: SaleLineRow[] }> {
  const filters: string[] = []
  if (opts.start) filters.push(`Date ge ${dt(opts.start)}`)
  if (opts.endExclusive) filters.push(`Date lt ${dt(opts.endExclusive)}`)
  const q: Record<string, string | number> = {}
  if (filters.length) q['$filter'] = filters.join(' and ')

  const raw = await fetchAll(label, 'Sale/Invoice/Item', q)
  const invoices: SaleInvoiceRow[] = []
  const lines: SaleLineRow[] = []
  for (const inv of raw) {
    invoices.push({
      ID: inv.UID, Number: inv.Number ?? null, Date: inv.Date ?? null,
      CustomerName: inv.Customer?.Name ?? null,
      CustomerPurchaseOrderNumber: inv.CustomerPurchaseOrderNumber ?? null,
      IsTaxInclusive: inv.IsTaxInclusive === true,
      TotalAmount: Number(inv.TotalAmount) || 0, TotalTax: Number(inv.TotalTax) || 0,
      BalanceDueAmount: Number(inv.BalanceDueAmount) || 0, Status: inv.Status ?? null,
      InvoiceType: inv.InvoiceType ?? 'Item',
    })
    for (const l of Array.isArray(inv.Lines) ? inv.Lines : []) {
      lines.push({
        SaleInvoiceId: inv.UID,
        AccountDisplayID: l.Account?.DisplayID ?? null, AccountName: l.Account?.Name ?? null,
        TaxCodeCode: l.TaxCode?.Code ?? null, Total: Number(l.Total) || 0, Description: l.Description ?? null,
        ItemNumber: l.Item?.Number ?? null, ItemName: l.Item?.Name ?? null,
        ShipQuantity: l.ShipQuantity != null ? Number(l.ShipQuantity) : null,
        UnitPrice: l.UnitPrice != null ? Number(l.UnitPrice) : null, RowID: l.RowID ?? null,
      })
    }
  }
  return { invoices, lines }
}

// Header-only sale invoices (no lines) — cheaper for dashboard summaries.
export async function fetchSaleInvoices(
  label: CompanyFileLabel, opts: { start?: string; endExclusive?: string; top?: number } = {},
): Promise<SaleInvoiceRow[]> {
  const filters: string[] = []
  if (opts.start) filters.push(`Date ge ${dt(opts.start)}`)
  if (opts.endExclusive) filters.push(`Date lt ${dt(opts.endExclusive)}`)
  const q: Record<string, string | number> = { '$orderby': 'Date desc' }
  if (filters.length) q['$filter'] = filters.join(' and ')
  const raw = await fetchAll(label, 'Sale/Invoice', q)
  const rows = raw.map((inv): SaleInvoiceRow => ({
    ID: inv.UID, Number: inv.Number ?? null, Date: inv.Date ?? null,
    CustomerName: inv.Customer?.Name ?? null,
    CustomerPurchaseOrderNumber: inv.CustomerPurchaseOrderNumber ?? null,
    IsTaxInclusive: inv.IsTaxInclusive === true,
    TotalAmount: Number(inv.TotalAmount) || 0, TotalTax: Number(inv.TotalTax) || 0,
    BalanceDueAmount: Number(inv.BalanceDueAmount) || 0, Status: inv.Status ?? null,
    InvoiceType: inv.InvoiceType ?? 'Item',
  }))
  return opts.top ? rows.slice(0, opts.top) : rows
}

export async function fetchSaleOrders(label: CompanyFileLabel): Promise<any[]> {
  return fetchAll(label, 'Sale/Order')
}
export async function fetchSaleQuotes(label: CompanyFileLabel): Promise<any[]> {
  return fetchAll(label, 'Sale/Quote')
}
export async function fetchPurchaseBills(label: CompanyFileLabel, opts: { openOnly?: boolean; top?: number } = {}): Promise<any[]> {
  const q: Record<string, string | number> = { '$orderby': 'Date desc' }
  if (opts.openOnly) q['$filter'] = `Status eq 'Open'`
  const raw = await fetchAll(label, 'Purchase/Bill', q)
  const rows = raw.map(b => ({
    Number: b.Number ?? null, Date: b.Date ?? null, SupplierName: b.Supplier?.Name ?? null,
    TotalAmount: Number(b.TotalAmount) || 0, TotalTax: Number(b.TotalTax) || 0,
    IsTaxInclusive: b.IsTaxInclusive === true, BalanceDueAmount: Number(b.BalanceDueAmount) || 0, Status: b.Status ?? null,
  }))
  return opts.top ? rows.slice(0, opts.top) : rows
}
export async function fetchItems(label: CompanyFileLabel): Promise<any[]> {
  return fetchAll(label, 'Inventory/Item')
}
// Distinct customer names seen on sale invoices (replaces the old DISTINCT
// CustomerName query). Reads the customer card list — the source of truth.
export async function fetchCustomerNames(label: CompanyFileLabel): Promise<string[]> {
  const raw = await fetchAll(label, 'Contact/Customer', { '$orderby': 'CompanyName' })
  const names = new Set<string>()
  for (const c of raw) {
    const n = (c.CompanyName || `${c.FirstName || ''} ${c.LastName || ''}`.trim() || '').trim()
    if (n) names.add(n)
  }
  return Array.from(names).sort((a, b) => a.localeCompare(b))
}
