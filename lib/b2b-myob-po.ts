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
  /** Force the PO's human-readable Number. Used to stamp our MYOB sale-invoice
   *  number on the supplier's PO so both sides quote one reference (Chris
   *  2026-08-26). Omit and MYOB assigns its own sequential number. MYOB caps
   *  this field at 13 characters and rejects a duplicate outright. */
  number?: string | null
}

export interface CreatePOResult {
  uid: string | null
  number: string | null
}

export async function createDropShipPurchaseOrder(input: CreatePOInput): Promise<CreatePOResult> {
  const conn = await getConnection('JAWS')
  if (!conn) throw new Error('MYOB JAWS not connected')
  if (!conn.company_file_id) throw new Error('MYOB JAWS has no company file selected')

  const body: Record<string, any> = {
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
  // MYOB's Number field is 13 chars and must be unique across purchases.
  const wanted = String(input.number || '').trim().slice(0, 13)
  if (wanted) body.Number = wanted

  const path = `/accountright/${conn.company_file_id}/Purchase/Order/Item`
  let result = await myobFetch(conn.id, path, { method: 'POST', body })
  // A forced Number can be refused - most likely a duplicate, since MYOB
  // enforces uniqueness across purchases. Losing the whole PO over the
  // reference we wanted printed on it would be the wrong trade: retry once
  // letting MYOB assign its own number, and say so in the log.
  if (result.status >= 400 && wanted) {
    console.warn(`[myob-po] Number "${wanted}" refused (HTTP ${result.status}: ${extractErr(result)}) - retrying with MYOB's own numbering`)
    delete body.Number
    result = await myobFetch(conn.id, path, { method: 'POST', body })
  }
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
  // For ADOPTING a manual conversion: when the PO is gone from MYOB (someone
  // converted it in the desktop app — conversion consumes the order), we look
  // the resulting bill up by these instead of creating anything.
  poNumber?: string | null
  supplierUid?: string | null
}

export interface ConvertPoToBillResult {
  uid: string | null
  number: string | null
  adopted?: boolean   // true = found an existing bill from a manual MYOB conversion; nothing was created
}

/** Is the purchase ORDER still OPEN in MYOB? false = consumed by a
 *  conversion — a 404 (API conversions delete the order) OR a 200 whose
 *  Status is no longer 'Open' (DESKTOP conversions keep the document,
 *  status 'ConvertedToBill' — Torrisi 2026-08-06); null = couldn't tell
 *  (transient error) — callers must NOT treat null as gone. */
export async function purchaseOrderExists(poUid: string): Promise<boolean | null> {
  const conn = await getConnection('JAWS')
  if (!conn?.company_file_id) return null
  try {
    const r = await myobFetch(conn.id, `/accountright/${conn.company_file_id}/Purchase/Order/Item/${poUid}`)
    if (r.status === 404) return false
    if (r.status !== 200) return null
    const status = String(r.data?.Status || '')
    return status && status !== 'Open' ? false : true
  } catch { return null }
}

/** Find the bill a manual MYOB conversion produced. Desktop conversion often
 *  keeps the PO's Number, so try that first; when the desktop renumbered the
 *  bill, fall back to supplier + exact total. Only an unambiguous
 *  (exactly-one) match is ever adopted. */
async function findConvertedBill(opts: { poNumber?: string | null; supplierUid?: string | null; totalAmount?: number | null }): Promise<ConvertPoToBillResult | null> {
  const conn = await getConnection('JAWS')
  if (!conn?.company_file_id) return null
  const search = async (filter: string): Promise<ConvertPoToBillResult | null> => {
    const r = await myobFetch(conn.id, `/accountright/${conn.company_file_id}/Purchase/Bill/Item`, {
      query: { '$filter': filter, '$top': 2 },
    })
    if (r.status !== 200) return null
    const items: any[] = r.data?.Items || []
    if (items.length !== 1) return null   // ambiguous or absent — no adopt
    return { uid: items[0].UID || null, number: String(items[0].Number || '') || null, adopted: true }
  }
  const supplierClause = opts.supplierUid ? ` and Supplier/UID eq guid'${opts.supplierUid}'` : ''
  if (opts.poNumber) {
    const byNumber = await search(`Number eq '${opts.poNumber.replace(/'/g, "''")}'${supplierClause}`)
    if (byNumber?.uid) return byNumber
  }
  const total = Number(opts.totalAmount || 0)
  if (opts.supplierUid && total > 0) {
    const byTotal = await search(`Supplier/UID eq guid'${opts.supplierUid}' and TotalAmount eq ${total.toFixed(2)}`)
    if (byTotal?.uid) return byTotal
  }
  return null
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
  const adoptExisting = async (totalAmount?: number | null): Promise<ConvertPoToBillResult> => {
    // PO consumed — someone converted it manually in the MYOB desktop app
    // (Torrisi B2B-2026-000040, Chris 2026-08-06). Adopt their bill instead
    // of erroring. Desktop conversions keep the document (Status
    // 'ConvertedToBill'); API conversions delete it (404).
    const existing = await findConvertedBill({ poNumber: input.poNumber, supplierUid: input.supplierUid, totalAmount })
    if (existing?.uid) return existing
    throw new Error(`MYOB purchase order ${input.poNumber || input.poUid} was already converted (or deleted) but the resulting bill couldn't be identified — record the bill number on the order manually.`)
  }
  if (got.status === 404) return adoptExisting()
  if (got.status !== 200 || !got.data) {
    throw new Error(`MYOB purchase order fetch failed (HTTP ${got.status}): ${extractErr(got)}`)
  }
  const po = got.data
  const poStatus = String(po.Status || '')
  if (poStatus && poStatus !== 'Open') return adoptExisting(Number(po.TotalAmount || 0))

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
  // FreightTaxCode is REQUIRED on an Item Bill even when there is no freight -
  // MYOB rejects the whole conversion with "FreightTaxCode is required"
  // otherwise. A drop-ship PO never carries freight (the supplier ships direct
  // and bills us separately), so this branch never ran and every drop-ship
  // bill failed. MPI AUTOMOTIVE PO 00001382, B2B-2026-000052, 2026-08-26.
  //
  // The sale-invoice path already learned this and falls back to FRE when
  // freight is zero (lib/b2b-myob-invoice.ts); the purchase-bill path did not.
  // Zero freight attracts no GST, so FRE is the correct code, not merely a
  // placeholder to satisfy the validator.
  const freight = round2(Number(po.Freight || 0))
  body.Freight = freight
  const { assertCheckoutConfigured } = await import('./b2b-settings')
  const cfg = await assertCheckoutConfigured()
  body.FreightTaxCode = { UID: po.FreightTaxCode?.UID || (freight > 0 ? cfg.gstTaxCodeUid : cfg.freTaxCodeUid) }

  const path = `/accountright/${conn.company_file_id}/Purchase/Bill/Item`
  const result = await myobFetch(conn.id, path, { method: 'POST', body })
  if (result.status !== 201 && result.status !== 200) {
    // Authoritative manual-conversion signal (seen live 2026-08-06): error
    // 38001 OrderConvertedToBill — the PO was billed in the desktop app.
    const errTxt = `${extractErr(result)} ${(result.raw || '')}`.slice(0, 600)
    if (result.status === 400 && /OrderConvertedToBill|38001/i.test(errTxt)) {
      return adoptExisting(Number(po.TotalAmount || 0))
    }
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
