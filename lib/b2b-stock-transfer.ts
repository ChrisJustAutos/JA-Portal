// lib/b2b-stock-transfer.ts
// SERVER-ONLY. Internal stock transfers between the two MYOB entities.
//
// JAWS → VPS (forward):
//   1. JAWS Sale/Invoice/Item to the "VPS" customer card at MYOB AVERAGE
//      COST (relieves JAWS stock, no margin, hits the GL).
//   2. VPS Purchase/Bill/Service from the "JAWS" supplier card to the
//      stock-transfer account (≤2 lines: taxable + GST-free subtotals).
//
// VPS → JAWS (reverse — the mirror):
//   1. VPS Sale/Invoice/Service to the "JAWS" customer card, lines posted
//      to the same stock-transfer account (credits it back).
//   2. JAWS Purchase/Bill/Item from the "VPS" supplier card — ITEM lines,
//      so AccountRight RECEIVES the stock back into JAWS inventory.
//   VPS doesn't track these items as inventory, so there's no on-hand cap
//   on the reverse direction; cost = JAWS AverageCost, falling back to the
//   item's StandardCost when average is 0 (e.g. JAWS holds none).
//
// The REQUIRED PO reference lands on both documents of either direction
// (sale CustomerPurchaseOrderNumber + bill SupplierInvoiceNumber).
//
// Failure model (both directions): sale-side fail → 'failed' (nothing
// written). Sale landed but purchase-side failed → 'partial' —
// retryPurchaseSide() re-attempts only the bill. UID-guarded, never dupes.

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { getConnection, myobFetch } from './myob'
import { loadSettings, ensureJawsTaxCodes } from './b2b-settings'
import { ensureTaxCodes } from './ap-myob-bill'
import { refreshAllStock } from './b2b-stock'

const UUID_REGEX_G = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const PAGE_SIZE = 400

export type TransferDirection = 'JAWS_TO_VPS' | 'VPS_TO_JAWS'

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

function round2(n: number): number { return Math.round(n * 100) / 100 }

function uidFromLocation(headers: Record<string, string>, companyFileId: string | null, what: string): string {
  const location = (headers || {})['location'] || ''
  const uuids = String(location).match(UUID_REGEX_G) || []
  const uid = uuids[uuids.length - 1] || null
  if (!uid || uid === companyFileId) throw new Error(`MYOB returned success but no ${what} UID in Location: "${location}"`)
  return uid
}

// ── Transfer settings ───────────────────────────────────────────────────
export interface TransferConfig {
  customerUid: string | null      // forward: "VPS" customer card in JAWS
  customerName: string | null
  supplierUid: string | null      // forward: "JAWS" supplier card in VPS
  supplierName: string | null
  accountUid: string | null       // VPS GL account (bill lines forward, sale lines reverse)
  accountName: string | null
  customerUidVps: string | null   // reverse: "JAWS" customer card in VPS
  customerNameVps: string | null
  supplierUidJaws: string | null  // reverse: "VPS" supplier card in JAWS
  supplierNameJaws: string | null
  mdPurchaseSupplierId: number | null  // MechanicDesk supplier id the workshop PO is raised on
}

export async function loadTransferConfig(): Promise<TransferConfig> {
  const s: any = await loadSettings()
  return {
    customerUid:      s.myob_transfer_customer_uid       || null,
    customerName:     s.myob_transfer_customer_name      || null,
    supplierUid:      s.myob_transfer_supplier_uid       || null,
    supplierName:     s.myob_transfer_supplier_name      || null,
    accountUid:       s.myob_transfer_account_uid        || null,
    accountName:      s.myob_transfer_account_name       || null,
    customerUidVps:   s.myob_transfer_customer_uid_vps   || null,
    customerNameVps:  s.myob_transfer_customer_name_vps  || null,
    supplierUidJaws:  s.myob_transfer_supplier_uid_jaws  || null,
    supplierNameJaws: s.myob_transfer_supplier_name_jaws || null,
    mdPurchaseSupplierId: s.md_purchase_supplier_id ?? null,
  }
}

// ── Live JAWS costs ─────────────────────────────────────────────────────
// AverageCost is AccountRight's running average cost of on-hand stock.
// StandardCost (BuyingDetails) is the fallback for the reverse direction,
// where JAWS may hold zero (average reads 0 with nothing on hand).
export interface ItemCost { avgCost: number; standardCost: number; onHand: number; isInventoried: boolean }

export async function fetchJawsItemCosts(): Promise<Record<string, ItemCost>> {
  const conn = await getConnection('JAWS')
  if (!conn) throw new Error('JAWS MYOB connection not configured')
  const out: Record<string, ItemCost> = {}
  let skip = 0
  while (true) {
    const result = await myobFetch(conn.id, `/accountright/${conn.company_file_id}/Inventory/Item`, {
      query: { '$top': PAGE_SIZE, '$skip': skip },
    })
    if (result.status !== 200) {
      throw new Error(`MYOB inventory fetch failed (HTTP ${result.status}): ${(result.raw || '').substring(0, 200)}`)
    }
    const items: any[] = Array.isArray(result.data?.Items) ? result.data.Items : []
    for (const it of items) {
      if (!it.UID) continue
      out[it.UID] = {
        avgCost: Number(it.AverageCost ?? 0),
        standardCost: Number(it?.BuyingDetails?.StandardCost ?? 0),
        onHand: Number(it.QuantityOnHand ?? 0),
        isInventoried: it.IsInventoried !== false,
      }
    }
    if (items.length < PAGE_SIZE) break
    skip += PAGE_SIZE
  }
  return out
}

// ── Execute ─────────────────────────────────────────────────────────────
export interface TransferLineInput { catalogue_id: string; qty: number }

export interface TransferResult {
  transferId: string
  direction: TransferDirection
  status: 'complete' | 'partial'
  saleDocUid: string
  saleDocNumber: string | null
  purchaseDocUid: string | null
  error: string | null
  subtotalEx: number
  gst: number
  totalInc: number
}

interface BuiltLine {
  catalogue_id: string; myob_item_uid: string; sku: string; name: string
  qty: number; unit_cost_ex: number; total_ex: number; is_taxable: boolean
}

export async function executeStockTransfer(opts: {
  lines: TransferLineInput[]
  direction?: TransferDirection
  note?: string | null
  poReference?: string | null   // REQUIRED — lands on BOTH MYOB docs
  userId: string
}): Promise<TransferResult> {
  const c = sb()
  const direction: TransferDirection = opts.direction === 'VPS_TO_JAWS' ? 'VPS_TO_JAWS' : 'JAWS_TO_VPS'
  const forward = direction === 'JAWS_TO_VPS'
  if (!opts.lines.length) throw new Error('No lines to transfer')
  const poRef = (opts.poReference || '').trim()
  if (!poRef) throw new Error('A PO reference is required for a stock transfer')

  // 1. Config + connections
  const cfgT = await loadTransferConfig()
  if (!cfgT.accountUid) throw new Error('Transfer not configured: pick the VPS stock-transfer account first')
  if (forward) {
    if (!cfgT.customerUid) throw new Error('Transfer not configured: pick the VPS customer card (in JAWS) first')
    if (!cfgT.supplierUid) throw new Error('Transfer not configured: pick the JAWS supplier card (in VPS) first')
  } else {
    if (!cfgT.customerUidVps) throw new Error('Transfer not configured: pick the JAWS customer card (in VPS) first')
    if (!cfgT.supplierUidJaws) throw new Error('Transfer not configured: pick the VPS supplier card (in JAWS) first')
  }
  const jaws = await getConnection('JAWS')
  if (!jaws) throw new Error('JAWS MYOB connection not configured')
  const jawsTax = await ensureJawsTaxCodes()

  // 2. Catalogue rows + live costs
  const ids = opts.lines.map(l => l.catalogue_id)
  const { data: catRows, error: catErr } = await c
    .from('b2b_catalogue')
    .select('id, myob_item_uid, sku, name, is_taxable')
    .in('id', ids)
  if (catErr) throw new Error(`Catalogue load failed: ${catErr.message}`)
  const catById: Record<string, any> = {}
  for (const r of catRows || []) catById[r.id] = r

  const costs = await fetchJawsItemCosts()

  const built: BuiltLine[] = []
  const problems: string[] = []
  for (const l of opts.lines) {
    const cat = catById[l.catalogue_id]
    if (!cat) { problems.push(`Unknown catalogue item ${l.catalogue_id}`); continue }
    if (!cat.myob_item_uid) { problems.push(`${cat.sku}: no MYOB item UID`); continue }
    const qty = Number(l.qty)
    if (!isFinite(qty) || qty <= 0) { problems.push(`${cat.sku}: invalid qty`); continue }
    const cost = costs[cat.myob_item_uid]
    if (!cost) { problems.push(`${cat.sku}: not found in JAWS inventory`); continue }
    if (!cost.isInventoried) { problems.push(`${cat.sku}: not an inventoried item`); continue }
    // Forward moves physical JAWS stock — capped at on-hand. Reverse brings
    // stock back from VPS (untracked there), so no cap applies.
    if (forward && qty > cost.onHand) { problems.push(`${cat.sku}: qty ${qty} exceeds on-hand ${cost.onHand}`); continue }
    // MYOB AverageCost carries 4+ decimal places, but each line must satisfy
    // Total = qty × UnitPrice at 2dp ("LineTotalUnbalanced" otherwise) —
    // round the unit cost FIRST and derive totals from the rounded figure.
    const rawCost = forward
      ? (Number(cost.avgCost) || 0)
      : (Number(cost.avgCost) || Number(cost.standardCost) || 0)
    const unitCost = round2(rawCost)
    built.push({
      catalogue_id: cat.id,
      myob_item_uid: cat.myob_item_uid,
      sku: cat.sku,
      name: cat.name,
      qty,
      unit_cost_ex: unitCost,
      total_ex: round2(qty * unitCost),
      is_taxable: cat.is_taxable !== false,
    })
  }
  if (problems.length) throw new Error(`Cannot transfer: ${problems.join('; ')}`)
  if (!built.length) throw new Error('No valid lines to transfer')

  const taxableEx    = round2(built.filter(b => b.is_taxable).reduce((s, b) => s + b.total_ex, 0))
  const nonTaxableEx = round2(built.filter(b => !b.is_taxable).reduce((s, b) => s + b.total_ex, 0))
  const subtotalEx   = round2(taxableEx + nonTaxableEx)
  const gst          = round2(taxableEx * 0.10)
  const totalInc     = round2(subtotalEx + gst)

  // 3. Create the transfer record up-front (audit trail even if MYOB hangs)
  const { data: transfer, error: tErr } = await c
    .from('b2b_stock_transfers')
    .insert({
      status: 'pending',
      direction,
      note: opts.note || null,
      po_reference: poRef,
      line_count: built.length,
      subtotal_ex_gst: subtotalEx,
      gst,
      total_inc: totalInc,
      created_by: opts.userId,
    })
    .select('id').single()
  if (tErr) throw new Error(`Transfer record create failed: ${tErr.message}`)
  const transferId = transfer.id as string

  await c.from('b2b_stock_transfer_lines').insert(built.map((b, i) => ({
    transfer_id: transferId,
    catalogue_id: b.catalogue_id,
    myob_item_uid: b.myob_item_uid,
    sku: b.sku,
    name: b.name,
    qty: b.qty,
    unit_cost_ex: b.unit_cost_ex,
    total_ex: b.total_ex,
    is_taxable: b.is_taxable,
    sort_order: i,
  })))

  const today = new Date().toISOString().substring(0, 10)
  let saleDocUid: string
  let saleDocNumber: string | null = null

  if (forward) {
    // ── 4a. JAWS Sale/Invoice/Item at average cost ────────────────────
    const { data: rpcNumber, error: rpcErr } = await c.rpc('b2b_next_myob_invoice_number')
    if (rpcErr) {
      await c.from('b2b_stock_transfers').update({ status: 'failed', error: `Number allocation failed: ${rpcErr.message}` }).eq('id', transferId)
      throw new Error(`Failed to allocate MYOB invoice number: ${rpcErr.message}`)
    }
    saleDocNumber = String(rpcNumber || '').trim()

    const invoiceBody: Record<string, any> = {
      Customer: { UID: cfgT.customerUid },
      Date: today,
      Number: saleDocNumber,
      CustomerPurchaseOrderNumber: poRef.substring(0, 20),
      Lines: built.map(b => ({
        Type: 'Transaction',
        Description: `Stock transfer to VPS: ${b.name} — ${b.sku}`.substring(0, 255),
        Item: { UID: b.myob_item_uid },
        ShipQuantity: b.qty,
        UnitPrice: b.unit_cost_ex,
        Total: b.total_ex,
        TaxCode: { UID: b.is_taxable ? jawsTax.gstUid : jawsTax.freUid },
      })),
      IsTaxInclusive: false,
      FreightAmount: 0,
      FreightTaxCode: { UID: jawsTax.freUid },
      Subtotal: subtotalEx,
      TotalTax: gst,
      TotalAmount: totalInc,
      Comment: `Internal stock transfer JAWS → VPS (${built.length} item${built.length === 1 ? '' : 's'} at average cost)`,
      JournalMemo: `Stock transfer ${transferId.substring(0, 8)} — PO ${poRef} — JA Portal`.substring(0, 255),
    }
    const invRes = await myobFetch(jaws.id, `/accountright/${jaws.company_file_id}/Sale/Invoice/Item`, {
      method: 'POST', body: invoiceBody, performedBy: opts.userId,
    })
    if (invRes.status !== 201 && invRes.status !== 200) {
      const errMsg = `JAWS Sale.Invoice POST failed (HTTP ${invRes.status}): ${(invRes.raw || '').substring(0, 400)}`
      await c.from('b2b_stock_transfers').update({ status: 'failed', error: errMsg.substring(0, 1000) }).eq('id', transferId)
      throw new Error(errMsg)
    }
    saleDocUid = uidFromLocation(invRes.headers, jaws.company_file_id, 'invoice')
    await c.from('b2b_stock_transfers')
      .update({ jaws_invoice_uid: saleDocUid, jaws_invoice_number: saleDocNumber })
      .eq('id', transferId)
  } else {
    // ── 4b. VPS Sale/Invoice/Service to the JAWS customer card ────────
    const vps = await getConnection('VPS')
    if (!vps) {
      await c.from('b2b_stock_transfers').update({ status: 'failed', error: 'VPS MYOB connection not configured' }).eq('id', transferId)
      throw new Error('VPS MYOB connection not configured')
    }
    const vpsTax = await ensureTaxCodes('VPS')
    const saleLines: any[] = []
    if (taxableEx > 0) saleLines.push({
      Type: 'Transaction',
      Description: `Stock transfer to JAWS — PO ${poRef} (${built.length} items)`.substring(0, 255),
      Account: { UID: cfgT.accountUid },
      Total: taxableEx,
      TaxCode: { UID: vpsTax.gstUid },
    })
    if (nonTaxableEx > 0) {
      if (!vpsTax.freUid) throw new Error('VPS has no FRE tax code for GST-free transfer lines')
      saleLines.push({
        Type: 'Transaction',
        Description: `Stock transfer to JAWS — PO ${poRef} (GST-free items)`.substring(0, 255),
        Account: { UID: cfgT.accountUid },
        Total: nonTaxableEx,
        TaxCode: { UID: vpsTax.freUid },
      })
    }
    const invoiceBody: Record<string, any> = {
      Customer: { UID: cfgT.customerUidVps },
      Date: today,
      CustomerPurchaseOrderNumber: poRef.substring(0, 20),
      Lines: saleLines,
      IsTaxInclusive: false,
      Subtotal: subtotalEx,
      TotalTax: gst,
      TotalAmount: totalInc,
      Comment: `Internal stock transfer VPS → JAWS (${built.length} item${built.length === 1 ? '' : 's'} at cost)`,
      JournalMemo: `Stock transfer ${transferId.substring(0, 8)} — PO ${poRef} — JA Portal`.substring(0, 255),
    }
    const invRes = await myobFetch(vps.id, `/accountright/${vps.company_file_id}/Sale/Invoice/Service`, {
      method: 'POST', body: invoiceBody, performedBy: opts.userId,
    })
    if (invRes.status !== 201 && invRes.status !== 200) {
      const errMsg = `VPS Sale.Invoice POST failed (HTTP ${invRes.status}): ${(invRes.raw || '').substring(0, 400)}`
      await c.from('b2b_stock_transfers').update({ status: 'failed', error: errMsg.substring(0, 1000) }).eq('id', transferId)
      throw new Error(errMsg)
    }
    saleDocUid = uidFromLocation(invRes.headers, vps.company_file_id, 'invoice')
    // MYOB auto-numbers Service invoices — fetch the assigned Number (best-effort).
    try {
      const detail = await myobFetch(vps.id, `/accountright/${vps.company_file_id}/Sale/Invoice/Service/${saleDocUid}`)
      if (detail.status === 200 && detail.data?.Number) saleDocNumber = String(detail.data.Number)
    } catch { /* keep null */ }
    await c.from('b2b_stock_transfers')
      .update({ vps_invoice_uid: saleDocUid, vps_invoice_number: saleDocNumber })
      .eq('id', transferId)
  }

  // 5. Purchase side
  let purchaseDocUid: string | null = null
  let purchaseError: string | null = null
  try {
    purchaseDocUid = forward
      ? await writeVpsBill({ poReference: poRef, jawsInvoiceNumber: saleDocNumber!, taxableEx, nonTaxableEx, gst, accountUid: cfgT.accountUid!, supplierUid: cfgT.supplierUid!, lineCount: built.length, userId: opts.userId })
      : await writeJawsItemBill({ poReference: poRef, lines: built, gst, supplierUid: cfgT.supplierUidJaws!, jawsTax, userId: opts.userId })
  } catch (e: any) {
    purchaseError = e?.message || String(e)
  }

  const status = purchaseDocUid ? 'complete' : 'partial'
  await c.from('b2b_stock_transfers').update({
    status,
    ...(forward ? { vps_bill_uid: purchaseDocUid } : { jaws_bill_uid: purchaseDocUid }),
    // Forward transfers also raise + receive a purchase order in
    // MechanicDesk (workshop inventory) via the GH Actions worker.
    ...(forward ? { md_po_status: 'queued' } : {}),
    error: purchaseError ? purchaseError.substring(0, 1000) : null,
    completed_at: purchaseDocUid ? new Date().toISOString() : null,
  }).eq('id', transferId)

  // 6. JAWS stock changed in both directions — refresh the cache (best-effort)
  try { await refreshAllStock() } catch (e: any) { console.error('transfer: stock refresh failed (non-fatal):', e?.message || e) }

  return {
    transferId, direction, status,
    saleDocUid, saleDocNumber,
    purchaseDocUid,
    error: purchaseError,
    subtotalEx, gst, totalInc,
  }
}

// ── Purchase side: VPS Service bill (forward) ──────────────────────────
async function writeVpsBill(opts: {
  poReference: string
  jawsInvoiceNumber: string
  taxableEx: number
  nonTaxableEx: number
  gst: number
  accountUid: string
  supplierUid: string
  lineCount: number
  userId: string
}): Promise<string> {
  const vps = await getConnection('VPS')
  if (!vps) throw new Error('VPS MYOB connection not configured')
  const vpsTax = await ensureTaxCodes('VPS')

  const lines: any[] = []
  if (opts.taxableEx > 0) {
    lines.push({
      Type: 'Transaction',
      Description: `Stock transfer from JAWS — inv ${opts.jawsInvoiceNumber} (${opts.lineCount} items)`.substring(0, 255),
      Account: { UID: opts.accountUid },
      Total: opts.taxableEx,
      TaxCode: { UID: vpsTax.gstUid },
    })
  }
  if (opts.nonTaxableEx > 0) {
    if (!vpsTax.freUid) throw new Error('VPS has no FRE tax code for GST-free transfer lines')
    lines.push({
      Type: 'Transaction',
      Description: `Stock transfer from JAWS — inv ${opts.jawsInvoiceNumber} (GST-free items)`.substring(0, 255),
      Account: { UID: opts.accountUid },
      Total: opts.nonTaxableEx,
      TaxCode: { UID: vpsTax.freUid },
    })
  }
  if (!lines.length) throw new Error('Transfer has zero value — nothing to bill')

  const subtotal = round2(opts.taxableEx + opts.nonTaxableEx)
  const body: Record<string, any> = {
    Date: new Date().toISOString().substring(0, 10),
    // The PO reference is the bill's visible reference; the JAWS invoice
    // number always stays in the JournalMemo for matching.
    SupplierInvoiceNumber: opts.poReference.substring(0, 30),
    Supplier: { UID: opts.supplierUid },
    Lines: lines,
    IsTaxInclusive: false,
    FreightAmount: 0,
    FreightTaxCode: { UID: vpsTax.freUid || vpsTax.gstUid },
    Subtotal: subtotal,
    TotalTax: opts.gst,
    TotalAmount: round2(subtotal + opts.gst),
    JournalMemo: `Internal stock transfer from JAWS — inv ${opts.jawsInvoiceNumber} — JA Portal`.substring(0, 255),
  }

  const res = await myobFetch(vps.id, `/accountright/${vps.company_file_id}/Purchase/Bill/Service`, {
    method: 'POST', body, performedBy: opts.userId,
  })
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(`VPS Purchase.Bill POST failed (HTTP ${res.status}): ${(res.raw || '').substring(0, 400)}`)
  }
  return uidFromLocation(res.headers, vps.company_file_id, 'bill')
}

// ── Purchase side: JAWS Item bill (reverse — receives stock) ───────────
async function writeJawsItemBill(opts: {
  poReference: string
  lines: BuiltLine[]
  gst: number
  supplierUid: string
  jawsTax: { gstUid: string; freUid: string }
  userId: string
}): Promise<string> {
  const jaws = await getConnection('JAWS')
  if (!jaws) throw new Error('JAWS MYOB connection not configured')

  const subtotal = round2(opts.lines.reduce((s, b) => s + b.total_ex, 0))
  const body: Record<string, any> = {
    Date: new Date().toISOString().substring(0, 10),
    SupplierInvoiceNumber: opts.poReference.substring(0, 30),
    Supplier: { UID: opts.supplierUid },
    Lines: opts.lines.map(b => ({
      Type: 'Transaction',
      Description: `Stock transfer from VPS: ${b.name} — ${b.sku}`.substring(0, 255),
      Item: { UID: b.myob_item_uid },
      BillQuantity: b.qty,
      UnitPrice: b.unit_cost_ex,
      Total: b.total_ex,
      TaxCode: { UID: b.is_taxable ? opts.jawsTax.gstUid : opts.jawsTax.freUid },
    })),
    IsTaxInclusive: false,
    FreightAmount: 0,
    FreightTaxCode: { UID: opts.jawsTax.freUid },
    Subtotal: subtotal,
    TotalTax: opts.gst,
    TotalAmount: round2(subtotal + opts.gst),
    JournalMemo: `Internal stock transfer from VPS — PO ${opts.poReference} — JA Portal`.substring(0, 255),
  }

  const res = await myobFetch(jaws.id, `/accountright/${jaws.company_file_id}/Purchase/Bill/Item`, {
    method: 'POST', body, performedBy: opts.userId,
  })
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(`JAWS Purchase.Bill POST failed (HTTP ${res.status}): ${(res.raw || '').substring(0, 400)}`)
  }
  return uidFromLocation(res.headers, jaws.company_file_id, 'bill')
}

// ── Retry the purchase side of a partial transfer ──────────────────────
export async function retryPurchaseSide(transferId: string, userId: string): Promise<TransferResult> {
  const c = sb()
  const { data: t, error } = await c.from('b2b_stock_transfers').select('*').eq('id', transferId).maybeSingle()
  if (error) throw new Error(error.message)
  if (!t) throw new Error('Transfer not found')
  const forward = (t.direction || 'JAWS_TO_VPS') !== 'VPS_TO_JAWS'
  const existingBill = forward ? t.vps_bill_uid : t.jaws_bill_uid
  const saleUid = forward ? t.jaws_invoice_uid : t.vps_invoice_uid

  const asResult = (purchaseDocUid: string | null): TransferResult => ({
    transferId,
    direction: forward ? 'JAWS_TO_VPS' : 'VPS_TO_JAWS',
    status: 'complete',
    saleDocUid: saleUid,
    saleDocNumber: forward ? t.jaws_invoice_number : t.vps_invoice_number,
    purchaseDocUid,
    error: null,
    subtotalEx: Number(t.subtotal_ex_gst), gst: Number(t.gst), totalInc: Number(t.total_inc),
  })
  if (existingBill) return asResult(existingBill)
  if (!saleUid) throw new Error('Transfer has no sale-side document — cannot retry the bill (start a new transfer)')

  const cfgT = await loadTransferConfig()
  const { data: lineRows } = await c.from('b2b_stock_transfer_lines')
    .select('catalogue_id, myob_item_uid, sku, name, qty, unit_cost_ex, total_ex, is_taxable')
    .eq('transfer_id', transferId).order('sort_order', { ascending: true })
  const lines: BuiltLine[] = (lineRows || []).map((l: any) => ({
    catalogue_id: l.catalogue_id, myob_item_uid: l.myob_item_uid, sku: l.sku, name: l.name,
    qty: Number(l.qty), unit_cost_ex: Number(l.unit_cost_ex), total_ex: Number(l.total_ex),
    is_taxable: l.is_taxable !== false,
  }))
  const taxableEx    = round2(lines.filter(l => l.is_taxable).reduce((s, l) => s + l.total_ex, 0))
  const nonTaxableEx = round2(lines.filter(l => !l.is_taxable).reduce((s, l) => s + l.total_ex, 0))

  let purchaseDocUid: string
  if (forward) {
    if (!cfgT.supplierUid || !cfgT.accountUid) throw new Error('Transfer settings incomplete')
    purchaseDocUid = await writeVpsBill({
      poReference: t.po_reference || t.jaws_invoice_number,
      jawsInvoiceNumber: t.jaws_invoice_number,
      taxableEx, nonTaxableEx,
      gst: Number(t.gst),
      accountUid: cfgT.accountUid,
      supplierUid: cfgT.supplierUid,
      lineCount: Number(t.line_count) || lines.length,
      userId,
    })
  } else {
    if (!cfgT.supplierUidJaws) throw new Error('Transfer settings incomplete (VPS supplier card in JAWS)')
    const jawsTax = await ensureJawsTaxCodes()
    purchaseDocUid = await writeJawsItemBill({
      poReference: t.po_reference || '',
      lines,
      gst: Number(t.gst),
      supplierUid: cfgT.supplierUidJaws,
      jawsTax: { gstUid: jawsTax.gstUid, freUid: jawsTax.freUid },
      userId,
    })
  }

  await c.from('b2b_stock_transfers').update({
    status: 'complete',
    ...(forward ? { vps_bill_uid: purchaseDocUid } : { jaws_bill_uid: purchaseDocUid }),
    error: null,
    completed_at: new Date().toISOString(),
  }).eq('id', transferId)

  if (!forward) {
    // Reverse bill receives stock into JAWS — refresh the cache.
    try { await refreshAllStock() } catch { /* non-fatal */ }
  }

  return asResult(purchaseDocUid)
}
