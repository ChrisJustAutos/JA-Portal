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
      ShipQuantity: l.qty,
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

// Location header carries cfId + the new PO UID; take the last UUID.
function extractUid(result: { headers?: Record<string, string> }, cfId: string): string | null {
  const loc = result.headers?.['location'] || result.headers?.['Location'] || ''
  const uuids = loc.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) || []
  const last = uuids.length > 0 ? uuids[uuids.length - 1] : null
  // Guard against accidentally grabbing the company-file id.
  return last && last !== cfId ? last : null
}

function extractErr(result: { status: number; data: any; raw: string }): string {
  const d = result.data
  if (d && Array.isArray(d.Errors) && d.Errors.length > 0) {
    return d.Errors.map((e: any) => e.Message || e.Name || JSON.stringify(e)).join('; ')
  }
  if (d && typeof d.Message === 'string') return d.Message
  return (result.raw || '').slice(0, 300) || `HTTP ${result.status}`
}
