// scripts/run-md-purchase-order.ts
//
// GH Actions worker — raises the MechanicDesk purchase order that matches a
// JAWS → VPS internal stock transfer. Triggered by repository_dispatch
// (event_type: 'md-purchase-order', client_payload: { transfer_id }) from
// /api/b2b/admin/stock-transfer when a forward transfer completes.
//
// Flow:
//   1. Read transfer + lines + MD supplier id from the portal (service token).
//   2. Log into MD (Playwright), map each line SKU → MD stock_id via search.
//   3. Create the purchase (status 'pending' in MD) at the transfer's costs.
//   4. Report back: md_po_status 'created' (+ md_po_ref = MD PO number) or
//      'failed' (+ error). Unmatched SKUs are reported, not fatal, unless
//      NONE match.
//
//   5. PROCESS the PO (PUT /purchases/{id}/processes) — receives the stock
//      into MD inventory, so the workshop's on-hand goes up. md_po_status
//      'done' when received, 'created' if the PO entered but processing
//      failed (staff can receive it in the MD UI).

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

async function main() {
  const { transfer, lines, md_supplier_id } = await readTransfer()
  console.log(`Transfer ${TRANSFER_ID} · direction=${transfer?.direction} · ${lines?.length || 0} lines`)

  if (transfer?.direction !== 'JAWS_TO_VPS') {
    console.log('Not a JAWS→VPS transfer — no MD PO needed. Done.')
    return
  }
  if (!md_supplier_id) {
    await report({ md_po_status: 'failed', md_po_error: 'MechanicDesk supplier not configured (Settings → set the MD supplier id)' })
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
  try {
    ;({ client } = await loginToMechanicDesk(browser, WS_ID, MD_USER, MD_PASS))
  } finally {
    await browser.close().catch(() => {})
  }

  // Map each SKU → MD stock id.
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

  const reference = String(transfer.po_reference || `TRANSFER-${String(TRANSFER_ID).slice(0, 8)}`).slice(0, 50)
  console.log(`Creating MD purchase: ${poLines.length} lines, supplier ${md_supplier_id}, ref ${reference}${misses.length ? ` (${misses.length} unmatched: ${misses.join('; ')})` : ''}`)

  const po = await createMdPurchase(client, {
    supplierId: Number(md_supplier_id),
    reference,
    description: `Internal stock transfer JAWS → VPS${misses.length ? ` (NOTE: unmatched SKUs not on PO: ${misses.join('; ')})` : ''}`.slice(0, 255),
    lines: poLines,
  })
  console.log(`MD purchase created: id=${po.id} number=${po.number} status=${po.status} total=${po.total_amount}`)

  // Receive it into stock (process). Best-effort: if it fails, the PO is still
  // entered and staff can receive it in the MD UI.
  let received = false
  let processError: string | null = null
  try {
    const r = await processMdPurchase(client, po.id)
    received = r.processed
    console.log(`MD purchase processed: status=${r.status} processed=${r.processed}`)
    if (!received) processError = `Process returned status=${r.status} (not received) — receive manually in MD`
  } catch (e: any) {
    processError = `Entered OK but processing failed: ${e?.message || e}`
    console.error(processError)
  }

  const unmatchedNote = misses.length ? ` Unmatched SKUs (add manually): ${misses.join('; ')}` : ''
  await report({
    md_po_status: received ? 'done' : 'created',
    md_po_ref: po.number || String(po.id),
    md_po_error: [processError, unmatchedNote].filter(Boolean).join('.').trim() || null,
  })
  console.log(received
    ? 'Reported back. PO entered AND received into MechanicDesk stock.'
    : 'Reported back. PO entered (receive it in the MD UI to add the stock).')
}

main().catch(async e => {
  console.error('FATAL', e)
  try { await report({ md_po_status: 'failed', md_po_error: String(e?.message || e).slice(0, 1000) }) } catch {}
  process.exit(1)
})
