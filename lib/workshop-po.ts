// lib/workshop-po.ts
// SERVER-ONLY. Workshop purchase-order helpers: totals recompute + an optional
// push to MYOB AccountRight (VPS) as a Purchase Bill (Item layout) when a PO is
// received. Posting is gated by workshop_settings.myob_posting_enabled and
// requires the supplier to be MYOB-linked and every line to resolve a MYOB item.

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { getConnection, myobFetch } from './myob'
import { getWorkshopSettings } from './workshop-myob-invoice'
import { WORKSHOP_MYOB_LABEL } from './workshop'

const UUID_REGEX_G = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const round2 = (n: number) => Math.round(n * 100) / 100

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

// Recompute and persist a PO's money totals from its lines (10% GST estimate;
// MYOB computes the authoritative tax when the bill is posted).
export async function recomputePoTotals(db: SupabaseClient, poId: string): Promise<{ subtotal: number; gst: number; total: number }> {
  const { data: lines } = await db.from('workshop_po_lines').select('qty, unit_cost_ex_gst').eq('po_id', poId)
  let subtotal = 0
  for (const l of lines || []) subtotal += round2((Number(l.qty) || 0) * (Number(l.unit_cost_ex_gst) || 0))
  subtotal = round2(subtotal)
  const gst = round2(subtotal * 0.1)
  const total = round2(subtotal + gst)
  await db.from('workshop_purchase_orders').update({ subtotal_ex_gst: subtotal, gst, total_inc: total, updated_at: new Date().toISOString() }).eq('id', poId)
  return { subtotal, gst, total }
}

async function resolveGstTaxCode(connId: string, cfId: string): Promise<string> {
  const r = await myobFetch(connId, `/accountright/${cfId}/GeneralLedger/TaxCode`, { query: { '$top': 200 } })
  if (r.status !== 200) throw new Error(`MYOB tax code fetch failed (HTTP ${r.status})`)
  const items: any[] = Array.isArray(r.data?.Items) ? r.data.Items : []
  const gst = items.find(it => String(it.Code || '').toUpperCase() === 'GST')
  if (!gst?.UID) throw new Error(`${WORKSHOP_MYOB_LABEL} MYOB has no GST tax code`)
  return gst.UID
}

export class PoMyobError extends Error {
  code: 'posting_disabled' | 'supplier_not_linked' | 'item_not_linked' | 'no_lines' | 'myob_error'
  constructor(code: PoMyobError['code'], message: string) { super(message); this.code = code }
}

// Push a received PO to MYOB as a Purchase Bill (Item layout). Idempotent on
// workshop_purchase_orders.myob_bill_uid. Throws PoMyobError on any blocker.
export async function pushPurchaseBillToMyob(poId: string, performedBy: string | null = null): Promise<{ myob_uid: string; myob_number: string | null; status: 'created' | 'already_written' }> {
  const c = sb()
  const { data: po } = await c.from('workshop_purchase_orders')
    .select('id, myob_bill_uid, notes, supplier:workshop_suppliers(myob_supplier_uid)')
    .eq('id', poId).maybeSingle()
  if (!po) throw new Error('Purchase order not found')
  if ((po as any).myob_bill_uid) return { myob_uid: (po as any).myob_bill_uid, myob_number: null, status: 'already_written' }

  const settings = await getWorkshopSettings()
  if (!settings.myob_posting_enabled) throw new PoMyobError('posting_disabled', 'MYOB posting is off. Turn it on in Workshop Settings → MYOB accounts.')

  const supplier: any = Array.isArray((po as any).supplier) ? (po as any).supplier[0] : (po as any).supplier
  if (!supplier?.myob_supplier_uid) throw new PoMyobError('supplier_not_linked', 'This PO’s supplier isn’t linked to a MYOB supplier card. Set the MYOB supplier UID on the supplier first.')

  // Resolve each line's MYOB item (from the stored uid or via the inventory row).
  const { data: lines } = await c.from('workshop_po_lines')
    .select('*, inventory:workshop_inventory(myob_uid)').eq('po_id', poId).order('sort_order', { ascending: true })
  if (!lines || lines.length === 0) throw new PoMyobError('no_lines', 'This PO has no line items.')

  const conn = await getConnection(WORKSHOP_MYOB_LABEL)
  if (!conn || !conn.company_file_id) throw new Error(`${WORKSHOP_MYOB_LABEL} MYOB connection not configured`)
  const gstUid = await resolveGstTaxCode(conn.id, conn.company_file_id)

  const myobLines: any[] = []
  let subtotal = 0, totalTax = 0
  for (const ln of lines as any[]) {
    const inv: any = Array.isArray(ln.inventory) ? ln.inventory[0] : ln.inventory
    const itemUid = ln.myob_item_uid || inv?.myob_uid
    if (!itemUid) throw new PoMyobError('item_not_linked', `Line "${ln.name}" has no MYOB item link — only inventory items synced from MYOB can be billed. Remove it or link the part.`)
    const qty = Number(ln.qty) || 1
    const lineEx = round2(qty * (Number(ln.unit_cost_ex_gst) || 0))
    myobLines.push({ Type: 'Transaction', Item: { UID: itemUid }, BillQuantity: qty, UnitPrice: round2(Number(ln.unit_cost_ex_gst) || 0), Total: lineEx, TaxCode: { UID: gstUid } })
    subtotal += lineEx
    totalTax += lineEx * 0.1
  }
  subtotal = round2(subtotal); totalTax = round2(totalTax)
  const totalAmount = round2(subtotal + totalTax)

  const path = `/accountright/${conn.company_file_id}/Purchase/Bill/Item`
  const body: Record<string, any> = {
    Supplier: { UID: supplier.myob_supplier_uid },
    Date: new Date().toISOString().substring(0, 10),
    Lines: myobLines,
    IsTaxInclusive: false,
    Subtotal: subtotal,
    TotalTax: totalTax,
    TotalAmount: totalAmount,
    JournalMemo: `Workshop PO ${poId}`.substring(0, 255),
  }
  const result = await myobFetch(conn.id, path, { method: 'POST', body, performedBy })
  if (result.status !== 201 && result.status !== 200) {
    throw new PoMyobError('myob_error', `MYOB Purchase.Bill POST failed (HTTP ${result.status}): ${(result.raw || '').substring(0, 300)}`)
  }
  const location = (result.headers || {})['location'] || (result.headers || {})['Location'] || ''
  const uuids = String(location).match(UUID_REGEX_G) || []
  const uid = uuids[uuids.length - 1] || null
  if (!uid || uid === conn.company_file_id) throw new PoMyobError('myob_error', `MYOB accepted the bill but returned no UID: "${location}"`)

  let number: string | null = null
  try {
    const detail = await myobFetch(conn.id, `${path}/${uid}`)
    if (detail.status === 200 && detail.data?.Number) number = String(detail.data.Number)
  } catch { /* not fatal */ }

  await c.from('workshop_purchase_orders').update({
    myob_bill_uid: uid, myob_bill_number: number, myob_written_at: new Date().toISOString(), myob_write_error: null, updated_at: new Date().toISOString(),
  }).eq('id', poId)

  return { myob_uid: uid, myob_number: number, status: 'created' }
}
