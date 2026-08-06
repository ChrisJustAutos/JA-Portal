// lib/b2b-myob-po.ts
//
// Creates Item Purchase Orders in MYOB JAWS for B2B drop-ship lines.
// One PO per supplier; the ship-to address is the distributor's, so the
// supplier delivers direct to the customer.
//
//   POST /accountright/{cf_id}/Purchase/Order/Item
//   { Supplier:{UID}, ShipToAddress, IsTaxInclusive:false,
//     Lines:[{ Type:'Transaction', Item:{UID}, ShipQuantity, UnitPrice,
//              TaxCode:{UID} }], Comment, JournalMemo }
//
// MYOB returns 201 with an empty body; the new PO's UID is the LAST UUID
// in the Location header. We then GET the order back to read its Number.

import { getConnection, myobFetch } from './myob'

function round2(n: number): number { return Math.round(n * 100) / 100 }

export interface DropShipPOLine {
  itemUid: string
  description: string
  qty: number
  unitPriceExGst: number
  taxUid: string
}

export interface CreatePOInput {
  supplierUid: string
  lines: DropShipPOLine[]
  shipToAddress: string
  comment?: string
  journalMemo?: string
}

export interface CreatePOResult {
  uid: string | null
  number: string | null
}

export async function createDropShipPurchaseOrder(input: CreatePOInput): Promise<CreatePOResult> {
  const conn = await getConnection('JAWS')
  if (!conn) throw new Error('MYOB JAWS not connected')
  if (!conn.company_file_id) throw new Error('MYOB JAWS has no company file selected')

  const body = {
    Supplier: { UID: input.supplierUid },
    ShipToAddress: input.shipToAddress.slice(0, 255),
    IsTaxInclusive: false,
    Lines: input.lines.map(l => ({
      Type: 'Transaction',
      Item: { UID: l.itemUid },
      // BillQuantity is the PURCHASE-line qty field. ShipQuantity (a sales
      // concept) was silently ignored by MYOB → POs arrived with 0 quantity
      // (MPI Automotive, Chris 2026-08-06).
      BillQuantity: l.qty,
      UnitPrice: round2(l.unitPriceExGst),
      TaxCode: { UID: l.taxUid },
      Description: l.description.slice(0, 255),
    })),
    Comment: (input.comment || '').slice(0, 255),
    JournalMemo: (input.journalMemo || '').slice(0, 255),
  }

  const path = `/accountright/${conn.company_file_id}/Purchase/Order/Item`
  const result = await myobFetch(conn.id, path, { method: 'POST', body })
  if (result.status >= 400) {
    throw new Error(`MYOB rejected the purchase order (HTTP ${result.status}): ${extractErr(result)}`)
  }

  const uid = extractUid(result, conn.company_file_id)
  let number: string | null = null
  if (uid) {
    // Best-effort: read the created PO to capture its human number.
    try {
      const got = await myobFetch(conn.id, `/accountright/${conn.company_file_id}/Purchase/Order/Item/${uid}`)
      if (got.status === 200 && got.data) number = String(got.data.Number || '') || null
    } catch { /* number is nice-to-have */ }
  }
  return { uid, number }
}

// ─── Convert Purchase.Order → Purchase.Bill (supplier confirmed) ────────

export interface ConvertPoToBillInput {
  poUid: string
  supplierName?: string | null   // for the "<NAME> DS" location lookup
  journalMemo?: string
}

export interface ConvertPoToBillResult {
  uid: string | null
  number: string | null
}

/**
 * Converts a drop-ship Purchase ORDER into a BILL when the supplier confirms,
 * using MYOB's NATIVE conversion — the exact purchase-side mirror of the sale
 * side (lib/b2b-myob-invoice convertOrderToInvoiceInMyob): GET the originating
 * order, then POST the converted document carrying an `Order: { UID }` link +
 * the same lines. AccountRight consumes/closes the PO (no delete, no
 * duplicate) and RECEIVES the stock — into each line's Location, which we
 * point at the supplier's "<NAME> DS" inventory location (same matcher the
 * drop-ship SALE lines use), so the sale line has stock to draw from and the
 * Sale.Order → Invoice conversion stops failing with
 * Inventory_InsufficientStockMultipleLocation (Torrisi B2B-2026-000040).
 * Keeps the SAME Number for continuity. Throws on failure.
 */
export async function convertDropShipPoToBill(input: ConvertPoToBillInput): Promise<ConvertPoToBillResult> {
  const conn = await getConnection('JAWS')
  if (!conn) throw new Error('MYOB JAWS not connected')
  if (!conn.company_file_id) throw new Error('MYOB JAWS has no company file selected')

  // 1. GET the purchase order — the bill mirrors its lines exactly.
  const got = await myobFetch(conn.id, `/accountright/${conn.company_file_id}/Purchase/Order/Item/${input.poUid}`)
  if (got.status !== 200 || !got.data) {
    throw new Error(`MYOB purchase order fetch failed (HTTP ${got.status}): ${extractErr(got)}`)
  }
  const po = got.data

  // 2. Resolve the supplier's DS location (e.g. "MPI DS") — best-effort; a
  // miss keeps whatever location the PO line already carries.
  let dsLocUid: string | null = null
  const key = String(input.supplierName || '').trim().toUpperCase()
  if (key) {
    try {
      const r = await myobFetch(conn.id, `/accountright/${conn.company_file_id}/Inventory/Location`, { query: { '$top': 400 } })
      if (r.status === 200) {
        const locs: any[] = r.data?.Items || []
        const first = key.split(/\s+/)[0]
        const hit = locs.find(l => String(l.Name || '').toUpperCase() === `${first} DS`)
          || locs.find(l => String(l.Name || '').toUpperCase().startsWith(first) && /\bDS\b/i.test(String(l.Name || '')))
        dsLocUid = hit?.UID || null
      }
    } catch { /* best-effort */ }
  }

  const lines = (Array.isArray(po.Lines) ? po.Lines : [])
    .filter((l: any) => l?.Type === 'Transaction' && l?.Item?.UID)
    .map((l: any) => ({
      Type: 'Transaction',
      Item: { UID: l.Item.UID },
      // Same qty field the PO was created with — BillQuantity is THE
      // purchase-line quantity (ShipQuantity is silently ignored, see above).
      BillQuantity: Number(l.BillQuantity ?? 0),
      UnitPrice: round2(Number(l.UnitPrice ?? 0)),
      Total: round2(Number(l.Total ?? 0)),
      ...(l.TaxCode?.UID ? { TaxCode: { UID: l.TaxCode.UID } } : {}),
      Description: String(l.Description || '').slice(0, 255),
      // Receive the stock where the drop-ship SALE line draws it from.
      ...(dsLocUid ? { Location: { UID: dsLocUid } }
        : (l.Location?.UID ? { Location: { UID: l.Location.UID } } : {})),
    }))
  if (lines.length === 0) throw new Error('Purchase order has no item lines to bill')
  if (!po.Supplier?.UID) throw new Error('Purchase order has no supplier UID')

  const body: Record<string, any> = {
    Supplier: { UID: po.Supplier.UID },
    Date: new Date().toISOString().substring(0, 10),
    IsTaxInclusive: false,
    Lines: lines,
    // Native MYOB conversion: link the bill to the originating purchase order.
    Order: { UID: input.poUid },
    // Envelope totals carried from the order (lines are identical).
    Subtotal: po.Subtotal,
    TotalTax: po.TotalTax,
    TotalAmount: po.TotalAmount,
    JournalMemo: (input.journalMemo || po.JournalMemo || '').slice(0, 255),
  }
  if (po.Number) body.Number = String(po.Number)   // keep the PO number for continuity
  if (po.ShipToAddress) body.ShipToAddress = String(po.ShipToAddress).slice(0, 255)
  if (po.Comment) body.Comment = String(po.Comment).slice(0, 255)
  if (Number(po.Freight || 0) > 0) {
    body.Freight = round2(Number(po.Freight))
    if (po.FreightTaxCode?.UID) body.FreightTaxCode = { UID: po.FreightTaxCode.UID }
  }

  const path = `/accountright/${conn.company_file_id}/Purchase/Bill/Item`
  const result = await myobFetch(conn.id, path, { method: 'POST', body })
  if (result.status !== 201 && result.status !== 200) {
    throw new Error(`MYOB PO→Bill conversion failed (HTTP ${result.status}): ${extractErr(result)}`)
  }

  const uid = extractUid(result, conn.company_file_id)
  let number: string | null = po.Number ? String(po.Number) : null
  if (uid) {
    // Best-effort: read the created bill to confirm its human number.
    try {
      const bill = await myobFetch(conn.id, `/accountright/${conn.company_file_id}/Purchase/Bill/Item/${uid}`)
      if (bill.status === 200 && bill.data?.Number) number = String(bill.data.Number)
    } catch { /* number is nice-to-have */ }
  }
  return { uid, number }
}

// Location header carries cfId + the new PO UID; take the last UUID.
function extractUid(result: { headers?: Record<string, string> }, cfId: string): string | null {
  const loc = result.headers?.['location'] || result.headers?.['Location'] || ''
  const uuids = loc.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) || []
  const last = uuids.length > 0 ? uuids[uuids.length - 1] : null
  // Guard against accidentally grabbing the company-file id.
  return last && last !== cfId ? last : null
}

// Fetch a supplier's email + name from MYOB Contact/Supplier. The email
// isn't on the item, so we read the card when we need it (PO emailing).
export async function getSupplierContact(supplierUid: string): Promise<{ email: string | null; name: string | null }> {
  const conn = await getConnection('JAWS')
  if (!conn?.company_file_id) throw new Error('MYOB JAWS not connected')
  const r = await myobFetch(conn.id, `/accountright/${conn.company_file_id}/Contact/Supplier/${encodeURIComponent(supplierUid)}`)
  if (r.status !== 200 || !r.data) return { email: null, name: null }
  const d = r.data
  const addrs: any[] = Array.isArray(d.Addresses) ? d.Addresses : []
  const email = (addrs.find(a => a?.Email)?.Email || '').trim() || null
  return { email, name: d.CompanyName || null }
}

function extractErr(result: { status: number; data: any; raw: string }): string {
  const d = result.data
  if (d && Array.isArray(d.Errors) && d.Errors.length > 0) {
    return d.Errors.map((e: any) => e.Message || e.Name || JSON.stringify(e)).join('; ')
  }
  if (d && typeof d.Message === 'string') return d.Message
  return (result.raw || '').slice(0, 300) || `HTTP ${result.status}`
}
