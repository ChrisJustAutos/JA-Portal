// lib/b2b-stock-transfer.ts
// SERVER-ONLY. Internal stock transfer JAWS → VPS.
//
// One transfer = two MYOB documents, written in sequence:
//   1. JAWS  — Sale/Invoice/Item to the configured "VPS" customer card.
//      Item lines priced at MYOB AVERAGE COST (ex GST), so JAWS books the
//      sale at book value (no margin) and AccountRight relieves JAWS stock.
//      Posted as an Invoice (not Order) so it hits the GL immediately.
//   2. VPS   — Purchase/Bill/Service from the configured "JAWS" supplier
//      card, posted to the configured stock-transfer account. Collapsed to
//      at most two lines (taxable subtotal + GST-free subtotal) — the
//      per-item detail lives on the JAWS invoice and in the portal.
//      SupplierInvoiceNumber = the JAWS invoice number, tying them together.
//
// Failure model: if the JAWS invoice fails the transfer is 'failed' (nothing
// was written). If the JAWS invoice lands but the VPS bill fails, the
// transfer is 'partial' — retryVpsBill() re-attempts only the bill side.
// Both writes are guarded by the stored UIDs, so retries never duplicate.

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { getConnection, myobFetch } from './myob'
import { loadSettings, ensureJawsTaxCodes } from './b2b-settings'
import { ensureTaxCodes } from './ap-myob-bill'
import { refreshAllStock } from './b2b-stock'

const UUID_REGEX_G = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const PAGE_SIZE = 400

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

// ── Transfer settings ───────────────────────────────────────────────────
export interface TransferConfig {
  customerUid: string | null   // "VPS" customer card in JAWS
  customerName: string | null
  supplierUid: string | null   // "JAWS" supplier card in VPS
  supplierName: string | null
  accountUid: string | null    // VPS GL account for the bill lines
  accountName: string | null
}

export async function loadTransferConfig(): Promise<TransferConfig> {
  const s: any = await loadSettings()
  return {
    customerUid:  s.myob_transfer_customer_uid  || null,
    customerName: s.myob_transfer_customer_name || null,
    supplierUid:  s.myob_transfer_supplier_uid  || null,
    supplierName: s.myob_transfer_supplier_name || null,
    accountUid:   s.myob_transfer_account_uid   || null,
    accountName:  s.myob_transfer_account_name  || null,
  }
}

// ── Live JAWS costs ─────────────────────────────────────────────────────
// AverageCost is AccountRight's running average cost of on-hand stock —
// the book value the transfer must move at for JAWS to zero out cleanly.
export interface ItemCost { avgCost: number; onHand: number; isInventoried: boolean }

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
  status: 'complete' | 'partial'
  jawsInvoiceUid: string
  jawsInvoiceNumber: string | null
  vpsBillUid: string | null
  error: string | null
  subtotalEx: number
  gst: number
  totalInc: number
}

export async function executeStockTransfer(opts: {
  lines: TransferLineInput[]
  note?: string | null
  poReference?: string | null   // REQUIRED — lands on BOTH MYOB docs (sale CustomerPONumber + bill SupplierInvoiceNumber)
  userId: string
}): Promise<TransferResult> {
  const c = sb()
  if (!opts.lines.length) throw new Error('No lines to transfer')
  if (!(opts.poReference || '').trim()) throw new Error('A PO reference is required for a stock transfer')

  // 1. Config + connections
  const cfgT = await loadTransferConfig()
  if (!cfgT.customerUid) throw new Error('Transfer not configured: pick the VPS customer card (in JAWS) first')
  if (!cfgT.supplierUid) throw new Error('Transfer not configured: pick the JAWS supplier card (in VPS) first')
  if (!cfgT.accountUid)  throw new Error('Transfer not configured: pick the VPS stock-transfer account first')
  const jawsTax = await ensureJawsTaxCodes()
  const jaws = await getConnection('JAWS')
  if (!jaws) throw new Error('JAWS MYOB connection not configured')

  // 2. Catalogue rows + live average costs
  const ids = opts.lines.map(l => l.catalogue_id)
  const { data: catRows, error: catErr } = await c
    .from('b2b_catalogue')
    .select('id, myob_item_uid, sku, name, is_taxable')
    .in('id', ids)
  if (catErr) throw new Error(`Catalogue load failed: ${catErr.message}`)
  const catById: Record<string, any> = {}
  for (const r of catRows || []) catById[r.id] = r

  const costs = await fetchJawsItemCosts()

  interface BuiltLine {
    catalogue_id: string; myob_item_uid: string; sku: string; name: string
    qty: number; unit_cost_ex: number; total_ex: number; is_taxable: boolean
  }
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
    if (qty > cost.onHand) { problems.push(`${cat.sku}: qty ${qty} exceeds on-hand ${cost.onHand}`); continue }
    // MYOB AverageCost carries 4+ decimal places, but the invoice line must
    // satisfy Total = ShipQuantity × UnitPrice at 2dp ("LineTotalUnbalanced"
    // otherwise). Round the unit cost FIRST and derive the total from the
    // rounded figure so the pair always balances.
    const unitCost = round2(Number(cost.avgCost) || 0)
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
      note: opts.note || null,
      po_reference: (opts.poReference || '').trim() || null,
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

  // 4. JAWS Sale/Invoice/Item at average cost
  const { data: rpcNumber, error: rpcErr } = await c.rpc('b2b_next_myob_invoice_number')
  if (rpcErr) {
    await c.from('b2b_stock_transfers').update({ status: 'failed', error: `Number allocation failed: ${rpcErr.message}` }).eq('id', transferId)
    throw new Error(`Failed to allocate MYOB invoice number: ${rpcErr.message}`)
  }
  const invoiceNumber = String(rpcNumber || '').trim()

  const today = new Date().toISOString().substring(0, 10)
  const invoiceBody: Record<string, any> = {
    Customer: { UID: cfgT.customerUid },
    Date: today,
    Number: invoiceNumber,
    Lines: built.map(b => ({
      Type: 'Transaction',
      Description: `Stock transfer to VPS: ${b.name} — ${b.sku}`.substring(0, 255),
      Item: { UID: b.myob_item_uid },
      ShipQuantity: b.qty,
      UnitPrice: b.unit_cost_ex,   // already 2dp; Total derived from it
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
    JournalMemo: `Stock transfer ${transferId.substring(0, 8)} — JA Portal`.substring(0, 255),
  }
  const poRef = (opts.poReference || '').trim()
  if (poRef) invoiceBody.CustomerPurchaseOrderNumber = poRef.substring(0, 20)  // MYOB caps PO at 20 chars

  const invRes = await myobFetch(jaws.id, `/accountright/${jaws.company_file_id}/Sale/Invoice/Item`, {
    method: 'POST', body: invoiceBody, performedBy: opts.userId,
  })
  if (invRes.status !== 201 && invRes.status !== 200) {
    const errMsg = `JAWS Sale.Invoice POST failed (HTTP ${invRes.status}): ${(invRes.raw || '').substring(0, 400)}`
    await c.from('b2b_stock_transfers').update({ status: 'failed', error: errMsg.substring(0, 1000) }).eq('id', transferId)
    throw new Error(errMsg)
  }
  const invLocation = (invRes.headers || {})['location'] || ''
  const invUuids = String(invLocation).match(UUID_REGEX_G) || []
  const jawsInvoiceUid = invUuids[invUuids.length - 1] || null
  if (!jawsInvoiceUid || jawsInvoiceUid === jaws.company_file_id) {
    const errMsg = `MYOB returned 201 but no invoice UID in Location: "${invLocation}"`
    await c.from('b2b_stock_transfers').update({ status: 'failed', error: errMsg }).eq('id', transferId)
    throw new Error(errMsg)
  }

  await c.from('b2b_stock_transfers')
    .update({ jaws_invoice_uid: jawsInvoiceUid, jaws_invoice_number: invoiceNumber })
    .eq('id', transferId)

  // 5. VPS Purchase/Bill/Service
  let vpsBillUid: string | null = null
  let vpsError: string | null = null
  try {
    vpsBillUid = await writeVpsBill({
      transferId,
      jawsInvoiceNumber: invoiceNumber,
      poReference: poRef || null,
      taxableEx, nonTaxableEx, gst,
      accountUid: cfgT.accountUid!,
      supplierUid: cfgT.supplierUid!,
      lineCount: built.length,
      userId: opts.userId,
    })
  } catch (e: any) {
    vpsError = e?.message || String(e)
  }

  const status = vpsBillUid ? 'complete' : 'partial'
  await c.from('b2b_stock_transfers').update({
    status,
    vps_bill_uid: vpsBillUid,
    error: vpsError ? vpsError.substring(0, 1000) : null,
    completed_at: vpsBillUid ? new Date().toISOString() : null,
  }).eq('id', transferId)

  // 6. JAWS stock changed — refresh the catalogue cache (best-effort)
  try { await refreshAllStock() } catch (e: any) { console.error('transfer: stock refresh failed (non-fatal):', e?.message || e) }

  return {
    transferId,
    status,
    jawsInvoiceUid,
    jawsInvoiceNumber: invoiceNumber,
    vpsBillUid,
    error: vpsError,
    subtotalEx, gst, totalInc,
  }
}

// ── VPS bill (shared by execute + retry) ────────────────────────────────
async function writeVpsBill(opts: {
  transferId: string
  jawsInvoiceNumber: string
  poReference?: string | null
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
  // When a PO reference is supplied it becomes the bill's visible reference
  // (Supplier Invoice No.) so both sides carry the same number; the JAWS
  // invoice number always stays in the JournalMemo for matching.
  const supplierInvNo = ((opts.poReference || '').trim() || opts.jawsInvoiceNumber).substring(0, 30)
  const body: Record<string, any> = {
    Date: new Date().toISOString().substring(0, 10),
    SupplierInvoiceNumber: supplierInvNo,
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
  const location = (res.headers || {})['location'] || ''
  const uuids = String(location).match(UUID_REGEX_G) || []
  const billUid = uuids[uuids.length - 1] || null
  if (!billUid || billUid === vps.company_file_id) {
    throw new Error(`MYOB returned 201 but no bill UID in Location: "${location}"`)
  }
  return billUid
}

// ── Retry the VPS side of a partial transfer ───────────────────────────
export async function retryVpsBill(transferId: string, userId: string): Promise<TransferResult> {
  const c = sb()
  const { data: t, error } = await c.from('b2b_stock_transfers').select('*').eq('id', transferId).maybeSingle()
  if (error) throw new Error(error.message)
  if (!t) throw new Error('Transfer not found')
  if (t.vps_bill_uid) {
    return {
      transferId, status: 'complete',
      jawsInvoiceUid: t.jaws_invoice_uid, jawsInvoiceNumber: t.jaws_invoice_number,
      vpsBillUid: t.vps_bill_uid, error: null,
      subtotalEx: Number(t.subtotal_ex_gst), gst: Number(t.gst), totalInc: Number(t.total_inc),
    }
  }
  if (!t.jaws_invoice_uid || !t.jaws_invoice_number) {
    throw new Error('Transfer has no JAWS invoice — cannot retry the VPS bill (start a new transfer)')
  }

  const cfgT = await loadTransferConfig()
  if (!cfgT.supplierUid || !cfgT.accountUid) throw new Error('Transfer settings incomplete')

  const { data: lines } = await c.from('b2b_stock_transfer_lines')
    .select('total_ex, is_taxable').eq('transfer_id', transferId)
  const taxableEx    = round2((lines || []).filter((l: any) => l.is_taxable !== false).reduce((s: number, l: any) => s + Number(l.total_ex), 0))
  const nonTaxableEx = round2((lines || []).filter((l: any) => l.is_taxable === false).reduce((s: number, l: any) => s + Number(l.total_ex), 0))

  const vpsBillUid = await writeVpsBill({
    transferId,
    jawsInvoiceNumber: t.jaws_invoice_number,
    poReference: t.po_reference || null,
    taxableEx, nonTaxableEx,
    gst: Number(t.gst),
    accountUid: cfgT.accountUid,
    supplierUid: cfgT.supplierUid,
    lineCount: Number(t.line_count) || (lines || []).length,
    userId,
  })

  await c.from('b2b_stock_transfers').update({
    status: 'complete', vps_bill_uid: vpsBillUid, error: null, completed_at: new Date().toISOString(),
  }).eq('id', transferId)

  return {
    transferId, status: 'complete',
    jawsInvoiceUid: t.jaws_invoice_uid, jawsInvoiceNumber: t.jaws_invoice_number,
    vpsBillUid, error: null,
    subtotalEx: Number(t.subtotal_ex_gst), gst: Number(t.gst), totalInc: Number(t.total_inc),
  }
}
