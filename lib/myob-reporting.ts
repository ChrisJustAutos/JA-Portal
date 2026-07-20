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
import { searchAccounts } from './ap-myob-lookup'

// VPS | JAWS — matches the connection labels in myob_connections.
type CompanyFileLabel = 'VPS' | 'JAWS'

const PAGE = 400 // AccountRight max $top

async function conn(label: CompanyFileLabel) {
  const c = await getConnection(label)
  if (!c?.company_file_id) throw new Error(`No active MYOB connection for ${label}`)
  return c
}

// GET an AccountRight entity, following NextPageLink until exhausted.
//
// IMPORTANT: do NOT page with bare $top/$skip — AccountRight gives no stable
// ordering guarantee, so rows shift between pages and records get silently
// skipped on multi-page pulls (found reconciling EOFY distributor figures,
// 2026-07-21: full-FY pulls were missing invoices). NextPageLink is the
// API's own cursor and is the documented paging mechanism.
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
      // NextPageLink carries the full query string, but its HOST varies
      // (arl*.api.myob.com regional hosts) — take only path+query and let
      // myobFetch prepend the canonical base.
      try { const u = new URL(next, 'https://api.myob.com'); path = u.pathname + u.search } catch { path = null }
    } else {
      path = null
    }
    firstQuery = null
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

// Sale-invoice types that carry Lines. CData's SaleInvoices/SaleInvoiceItems
// spanned ALL types, so we must too — querying only Sale/Invoice/Item
// undercounts (JAWS raises some sales as Service invoices). Merge them.
// TimeBilling added 2026-07-21 (EOFY reconciliation) — AccountRight's fifth
// type; a file with it disabled just 400/404s, which fetch handles.
const INVOICE_TYPES = ['Item', 'Service', 'Professional', 'Miscellaneous', 'TimeBilling']

// Sale invoices for a date range, across all invoice types, with lines
// flattened. Both shapes carry CData-compatible field names.
export async function fetchSaleInvoicesWithLines(
  label: CompanyFileLabel, opts: { start?: string; endExclusive?: string } = {},
): Promise<{ invoices: SaleInvoiceRow[]; lines: SaleLineRow[] }> {
  const filters: string[] = []
  if (opts.start) filters.push(`Date ge ${dt(opts.start)}`)
  if (opts.endExclusive) filters.push(`Date lt ${dt(opts.endExclusive)}`)
  // Explicit $orderby makes the paging order deterministic — without it,
  // skip paging (including NextPageLink, which is skip-based) can drop the
  // odd row at page boundaries when the server's implicit order shifts.
  const q: Record<string, string | number> = { '$orderby': 'Number' }
  if (filters.length) q['$filter'] = filters.join(' and ')

  const raw: any[] = []
  for (const type of INVOICE_TYPES) {
    // Typed endpoints omit the InvoiceType field — stamp the endpoint's type.
    try { raw.push(...(await fetchAll(label, `Sale/Invoice/${type}`, q)).map(x => ({ ...x, InvoiceType: x.InvoiceType ?? type }))) }
    catch (e: any) {
      // A company file may not have every invoice type enabled — a 400/404
      // (first page) shouldn't sink the whole pull. ANY other failure must
      // propagate: swallowing a mid-pagination error silently undercounts
      // the report (exactly the 2026-07-21 EOFY reconciliation bug).
      const msg = String(e?.message || e)
      if (/HTTP 40[04]\b/.test(msg)) {
        console.warn(`[myob-reporting] Sale/Invoice/${type} ${label} unavailable:`, msg.slice(0, 200))
        continue
      }
      throw e
    }
  }
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
      InvoiceType: inv.InvoiceType ?? inv.Type ?? null,
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
// A small `top` fetches a single API page (no full paging); `status` filters
// server-side (e.g. 'Open'). The bare /Sale/Invoice endpoint spans all types.
export async function fetchSaleInvoices(
  label: CompanyFileLabel, opts: { start?: string; endExclusive?: string; top?: number; status?: string } = {},
): Promise<SaleInvoiceRow[]> {
  const filters: string[] = []
  if (opts.start) filters.push(`Date ge ${dt(opts.start)}`)
  if (opts.endExclusive) filters.push(`Date lt ${dt(opts.endExclusive)}`)
  if (opts.status) filters.push(`Status eq '${opts.status}'`)
  const q: Record<string, string | number> = { '$orderby': 'Date desc' }
  if (filters.length) q['$filter'] = filters.join(' and ')

  let raw: any[]
  if (opts.top && opts.top <= PAGE) {
    // Single page — avoid paging the whole ledger for a "recent N" list.
    const c = await conn(label)
    const r = await myobFetch(c.id, `/accountright/${c.company_file_id}/Sale/Invoice`, { query: { ...q, '$top': opts.top } })
    if (r.status !== 200) throw new Error(`MYOB Sale/Invoice ${label}: HTTP ${r.status}`)
    raw = Array.isArray(r.data?.Items) ? r.data.Items : []
  } else {
    raw = await fetchAll(label, 'Sale/Invoice', q)
  }
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

// Sale orders / quotes across line-carrying types, shaped with the flat
// CData field names the report endpoints expect. Salesperson/Customer are
// nested objects in AccountRight — flattened to *Name / *DisplayID here.
function shapeOrderLike(x: any): any {
  return {
    Number: x.Number ?? null, Date: x.Date ?? null,
    CustomerName: x.Customer?.Name ?? null, CustomerDisplayID: x.Customer?.DisplayID ?? null,
    TotalAmount: Number(x.TotalAmount) || 0, TotalTax: Number(x.TotalTax) || 0,
    BalanceDueAmount: Number(x.BalanceDueAmount) || 0, Subtotal: Number(x.Subtotal) || 0,
    Freight: Number(x.Freight) || 0, IsTaxInclusive: x.IsTaxInclusive === true,
    Status: x.Status ?? null, SalespersonName: x.Salesperson?.Name ?? null,
    CustomerPurchaseOrderNumber: x.CustomerPurchaseOrderNumber ?? null,
  }
}
async function fetchSaleDocType(label: CompanyFileLabel, doc: 'Order' | 'Quote'): Promise<any[]> {
  const out: any[] = []
  for (const type of INVOICE_TYPES) {
    try { out.push(...(await fetchAll(label, `Sale/${doc}/${type}`)).map(shapeOrderLike)) }
    catch (e: any) { console.warn(`[myob-reporting] Sale/${doc}/${type} ${label}:`, e?.message) }
  }
  return out
}
// A single sale invoice by Number, with header (CData-compatible field names)
// + flattened lines. Searches each invoice type until a match is found.
export async function fetchSaleInvoiceByNumber(
  label: CompanyFileLabel, number: string,
): Promise<{ invoice: any | null; lines: SaleLineRow[] }> {
  const q = { '$filter': `Number eq '${String(number).replace(/'/g, "''")}'` }
  for (const type of INVOICE_TYPES) {
    let raw: any[] = []
    try { raw = await fetchAll(label, `Sale/Invoice/${type}`, q) }
    catch { continue }
    if (!raw.length) continue
    const inv = raw[0]
    const invoice = {
      ID: inv.UID, Number: inv.Number ?? null, Date: inv.Date ?? null,
      CustomerName: inv.Customer?.Name ?? null,
      TotalAmount: Number(inv.TotalAmount) || 0, BalanceDueAmount: Number(inv.BalanceDueAmount) || 0,
      Status: inv.Status ?? null, Subtotal: Number(inv.Subtotal) || 0, TotalTax: Number(inv.TotalTax) || 0,
      IsTaxInclusive: inv.IsTaxInclusive === true, InvoiceType: type,
      Comment: inv.Comment ?? null, ShipToAddress: inv.ShipToAddress ?? null,
      CustomerPurchaseOrderNumber: inv.CustomerPurchaseOrderNumber ?? null,
      TermsDueDate: inv.Terms?.DueDate ?? null, TermsPaymentIsDue: inv.Terms?.PaymentIsDue ?? null,
      SalespersonName: inv.Salesperson?.Name ?? null, JournalMemo: inv.JournalMemo ?? null,
      Freight: Number(inv.Freight) || 0, LastPaymentDate: inv.LastPaymentDate ?? null,
    }
    const lines: SaleLineRow[] = (Array.isArray(inv.Lines) ? inv.Lines : []).map((l: any) => ({
      SaleInvoiceId: inv.UID,
      AccountDisplayID: l.Account?.DisplayID ?? null, AccountName: l.Account?.Name ?? null,
      TaxCodeCode: l.TaxCode?.Code ?? null, Total: Number(l.Total) || 0, Description: l.Description ?? null,
      ItemNumber: l.Item?.Number ?? null, ItemName: l.Item?.Name ?? null,
      ShipQuantity: l.ShipQuantity != null ? Number(l.ShipQuantity) : null,
      UnitPrice: l.UnitPrice != null ? Number(l.UnitPrice) : null, RowID: l.RowID ?? null,
    }))
    return { invoice, lines }
  }
  return { invoice: null, lines: [] }
}

export async function fetchSaleOrders(label: CompanyFileLabel): Promise<any[]> {
  return fetchSaleDocType(label, 'Order')
}
export async function fetchSaleQuotes(label: CompanyFileLabel): Promise<any[]> {
  return fetchSaleDocType(label, 'Quote')
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

// Active inventoried items, shaped with the flat CData Items field names the
// inventory report expects. Field paths mirror lib/b2b-catalogue-sync +
// jaws-stocktake (the proven direct-OAuth Item readers). CData's CurrentValue
// isn't a native AccountRight field — computed as AverageCost × QtyOnHand.
export async function fetchInventoryItems(label: CompanyFileLabel): Promise<any[]> {
  const raw = await fetchAll(label, 'Inventory/Item', { '$filter': 'IsActive eq true and IsInventoried eq true' })
  return raw.map(it => {
    const qtyOnHand = Number(it.QuantityOnHand) || 0
    const avgCost = Number(it.AverageCost) || 0
    const restock = it.BuyingDetails?.RestockingInformation || {}
    return {
      Number: it.Number ?? null, Name: it.Name ?? null,
      QuantityOnHand: qtyOnHand, QuantityAvailable: Number(it.QuantityAvailable) || 0,
      QuantityCommitted: Number(it.QuantityCommitted) || 0, QuantityOnOrder: Number(it.QuantityOnOrder) || 0,
      AverageCost: avgCost, CurrentValue: Math.round(avgCost * qtyOnHand * 100) / 100,
      SellingBaseSellingPrice: Number(it.SellingDetails?.BaseSellingPrice) || 0,
      SellingIsTaxInclusive: it.SellingDetails?.IsTaxInclusive === true,
      SellingTaxCodeCode: it.SellingDetails?.TaxCode?.Code ?? null,
      RestockingMinimumLevelForRestockingAlert: Number(restock.MinimumLevel) || 0,
      RestockingDefaultOrderQuantity: Number(restock.DefaultReorderQuantity) || 0,
      RestockingSupplierName: restock.Supplier?.Name ?? null,
      RestockingSupplierDisplayID: restock.Supplier?.DisplayID ?? null,
      BuyingLastPurchasePrice: Number(it.BuyingDetails?.StandardCost) || 0,
    }
  }).sort((a, b) => b.CurrentValue - a.CurrentValue)
}
// Income accounts (DisplayID 4-xxxx) from the chart of accounts — replaces the
// old "distinct 4-% accounts seen on invoice lines" query. The chart is the
// source of truth for selectable income accounts.
export async function fetchIncomeAccounts(label: CompanyFileLabel): Promise<Array<{ code: string; name: string }>> {
  const accts = await searchAccounts(label as any, '', 200, ['Income', 'OtherIncome'])
  return accts
    .filter(a => (a.displayId || '').startsWith('4-'))
    .map(a => ({ code: a.displayId, name: a.name }))
    .sort((a, b) => a.code.localeCompare(b.code))
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
