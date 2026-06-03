// scripts/run-md-purchase-order.ts
//
// GH Actions worker — MD-FIRST purchase order for a JAWS → VPS stock transfer.
// Triggered by repository_dispatch ('md-purchase-order', { transfer_id }) from
// /api/b2b/admin/stock-transfer when a forward transfer is staged.
//
// MD owns the PO number (its 74xx sequence), so the order is:
//   1. Read transfer + lines + MD supplier id from the portal (service token).
//   2. Log into MD, map each line SKU → MD stock id.
//   3. Create the PO with NO reference → MD assigns its sequential number.
//      (Idempotent: if the transfer already has md_po_id, reuse that PO.)
//   4. Report md_po_ref (= MD number) + md_po_id back.
//   5. finalize-myob: portal writes the JAWS sale + VPS bill using the MD
//      number as the PO reference.
//   6. Process the MD PO → receives the stock into the workshop's MD inventory.
//   7. Report final md_po_status: 'done' (received) or 'created' (entered).

import {
  loginToMechanicDesk, findStockBySku, createMdPurchase, processMdPurchase,
  type MdClient, type MdPurchaseLineInput,
} from '../lib/mechanicdesk-stocktake'

const PORTAL_BASE = process.env.JA_PORTAL_BASE_URL || ''
const PORTAL_TOKEN = process.env.JA_PORTAL_API_KEY || ''
const TRANSFER_ID = process.env.TRANSFER_ID || ''
const WS_ID = process.env.MECHANICDESK_WORKSHOP_ID || ''
const MD_USER = process.env.MECHANICDESK_USERNAME || ''
const MD_PASS = process.env.MECHANICDESK_PASSWORD || ''

if (!PORTAL_BASE) throw new Error('JA_PORTAL_BASE_URL required')
if (!PORTAL_TOKEN) throw new Error('JA_PORTAL_API_KEY required')
if (!TRANSFER_ID) throw new Error('TRANSFER_ID required')
if (!WS_ID || !MD_USER || !MD_PASS) throw new Error('MECHANICDESK_* env vars required')

const API = `${PORTAL_BASE}/api/b2b/admin/stock-transfer/${TRANSFER_ID}`

async function readTransfer(): Promise<any> {
  const r = await fetch(API, { headers: { 'X-Service-Token': PORTAL_TOKEN } })
  if (!r.ok) throw new Error(`Read transfer failed: ${r.status} ${await r.text().catch(() => '')}`)
  return r.json()
}
async function report(update: Record<string, any>): Promise<void> {
  const r = await fetch(API, {
    method: 'PATCH',
    headers: { 'X-Service-Token': PORTAL_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(update),
  })
  if (!r.ok) console.error(`Report-back failed: ${r.status} ${await r.text().catch(() => '')}`)
}
async function finalizeMyob(poNumber: string): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(API, {
    method: 'POST',
    headers: { 'X-Service-Token': PORTAL_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'finalize-myob', po_reference: poNumber }),
  })
  const j = await r.json().catch(() => null)
  if (!r.ok) return { ok: false, error: j?.error || `HTTP ${r.status}` }
  return { ok: true }
}

async function main() {
  const { transfer, lines, md_supplier_id } = await readTransfer()
  console.log(`Transfer ${TRANSFER_ID} · direction=${transfer?.direction} · ${lines?.length || 0} lines · existing md_po_id=${transfer?.md_po_id || 'none'}`)

  if (transfer?.direction !== 'JAWS_TO_VPS') { console.log('Not a JAWS→VPS transfer — no MD PO. Done.'); return }
  if (!md_supplier_id) {
    await report({ md_po_status: 'failed', md_po_error: 'MechanicDesk supplier not configured (Settings → MD supplier id)' })
    throw new Error('md_purchase_supplier_id not configured')
  }
  if (!Array.isArray(lines) || lines.length === 0) {
    await report({ md_po_status: 'failed', md_po_error: 'Transfer has no lines' })
    throw new Error('No lines')
  }

  console.log('Logging into MechanicDesk…')
  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ headless: true })
  let client: MdClient
  try { ({ client } = await loginToMechanicDesk(browser, WS_ID, MD_USER, MD_PASS)) }
  finally { await browser.close().catch(() => {}) }

  // ── Create the PO (or reuse an existing one for idempotent retries) ───
  let poId: number
  let poNumber: string
  if (transfer.md_po_id) {
    poId = Number(transfer.md_po_id)
    poNumber = String(transfer.md_po_ref || poId)
    console.log(`Reusing existing MD PO id=${poId} number=${poNumber}`)
  } else {
    const poLines: MdPurchaseLineInput[] = []
    const misses: string[] = []
    for (const ln of lines) {
      const sku = String(ln.sku || '').trim()
      const match = await findStockBySku(client, sku)
      if (match.kind !== 'matched') { misses.push(`${sku} (${match.kind})`); continue }
      poLines.push({
        stock_id: (match.stock as any).id,
        quantity: Number(ln.qty),
        unit_price: Number(ln.unit_cost_ex),
        gst_free: ln.is_taxable === false,
        name: `${sku} — ${ln.name}`.slice(0, 200),
        description: String(ln.name || sku).slice(0, 200),
      })
    }
    if (poLines.length === 0) {
      await report({ md_po_status: 'failed', md_po_error: `No SKUs matched in MD: ${misses.join('; ')}`.slice(0, 1000) })
      throw new Error('No SKUs matched')
    }
    // NO reference — MD assigns its own sequential PO number at create.
    const po = await createMdPurchase(client, {
      supplierId: Number(md_supplier_id),
      reference: '',
      description: `Internal stock transfer JAWS → VPS${misses.length ? ` (unmatched: ${misses.join('; ')})` : ''}`.slice(0, 255),
      lines: poLines,
    })
    poId = po.id
    poNumber = String(po.number || po.id)
    console.log(`MD PO created: id=${poId} number=${poNumber}${misses.length ? ` (unmatched: ${misses.join('; ')})` : ''}`)
    await report({ md_po_status: 'created', md_po_ref: poNumber, md_po_id: poId, md_po_error: misses.length ? `Unmatched SKUs (add manually): ${misses.join('; ')}` : null })
  }

  // ── Finalise the MYOB side using the MD PO number as the reference ────
  console.log(`Finalising MYOB with PO reference ${poNumber}…`)
  const fin = await finalizeMyob(poNumber)
  if (!fin.ok) {
    await report({ md_po_status: 'created', md_po_error: `MD PO ${poNumber} entered, but MYOB finalise failed: ${fin.error}` })
    throw new Error(`finalize-myob failed: ${fin.error}`)
  }
  console.log('MYOB sale + bill posted.')

  // ── Process the MD PO → receive the stock into MD inventory ───────────
  let received = false
  let processError: string | null = null
  try {
    const r = await processMdPurchase(client, poId)
    received = r.processed
    if (!received) processError = `Process returned status=${r.status} — receive manually in MD`
  } catch (e: any) {
    processError = `MYOB posted + PO entered, but MD receive failed: ${e?.message || e}`
  }

  await report({ md_po_status: received ? 'done' : 'created', md_po_ref: poNumber, md_po_id: poId, md_po_error: processError })
  console.log(received ? `Done — PO ${poNumber} entered, MYOB posted, stock received into MD.` : `PO ${poNumber} entered + MYOB posted; receive in MD UI.`)
}

main().catch(async e => {
  console.error('FATAL', e)
  try { await report({ md_po_status: 'failed', md_po_error: String(e?.message || e).slice(0, 1000) }) } catch {}
  process.exit(1)
})
