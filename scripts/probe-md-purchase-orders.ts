// scripts/probe-md-purchase-orders.ts
//
// Round 11 — confirm MD purchase-order NUMBERING for the MD-first design:
//   • Does MD auto-assign its sequential number at CREATE, or only on process?
//   • Does supplying `reference` override the number?
// Safe: creates PENDING POs only (no processing → no stock change) and deletes
// them. Two creates: one with NO reference, one WITH a reference.

import { loginToMechanicDesk, findStockBySku, createMdPurchase, deleteMdPurchase, type MdClient } from '../lib/mechanicdesk-stocktake'

const MD_BASE = 'https://www.mechanicdesk.com.au'
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const SUPPLIER_ID = 1091329
const TEST_SKU = 'SSMBC697-DPF'

async function getNumber(client: MdClient, id: number): Promise<{ number: string | null; status: string | null }> {
  const r = await fetch(`${MD_BASE}/purchases/${id}.json`, {
    headers: { 'Cookie': client.cookieHeader, 'User-Agent': USER_AGENT, 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
  })
  const j = await r.json().catch(() => ({}))
  return { number: j?.number ?? null, status: j?.status ?? null }
}

async function main() {
  const wsId = process.env.MECHANICDESK_WORKSHOP_ID
  const user = process.env.MECHANICDESK_USERNAME
  const pass = process.env.MECHANICDESK_PASSWORD
  if (!wsId || !user || !pass) throw new Error('MECHANICDESK_* env vars required')

  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ headless: true })
  const { client } = await loginToMechanicDesk(browser, wsId, user, pass)
  await browser.close().catch(() => {})

  const m = await findStockBySku(client, TEST_SKU)
  if (m.kind !== 'matched') { console.log(`SKU not matched (${m.kind})`); return }
  const stockId = (m.stock as any).id
  const line = (name: string) => [{ stock_id: stockId, quantity: 1, unit_price: 1, gst_free: false, name }]

  // A) No reference — see MD's natural numbering at create.
  const a = await createMdPurchase(client, { supplierId: SUPPLIER_ID, description: 'probe A (no ref)', lines: line('probe A') } as any)
  const aRead = await getNumber(client, a.id)
  console.log(`A) no reference  → create.number=${JSON.stringify(a.number)} status=${a.status} | readback.number=${JSON.stringify(aRead.number)} status=${aRead.status}`)

  // B) With reference — does it override the number?
  const b = await createMdPurchase(client, { supplierId: SUPPLIER_ID, reference: 'JA-REF-TEST', description: 'probe B (ref)', lines: line('probe B') })
  const bRead = await getNumber(client, b.id)
  console.log(`B) reference=JA-REF-TEST → create.number=${JSON.stringify(b.number)} status=${b.status} | readback.number=${JSON.stringify(bRead.number)} status=${bRead.status}`)

  // Cleanup (both pending → delete is clean, no stock impact).
  await deleteMdPurchase(client, a.id).catch(e => console.log(`delete A failed: ${e?.message || e}`))
  await deleteMdPurchase(client, b.id).catch(e => console.log(`delete B failed: ${e?.message || e}`))
  console.log('Cleaned up. Done.')
}

main().catch(e => { console.error('FATAL', e); process.exit(1) })
