// scripts/probe-md-purchase-orders.ts
//
// Round 4 — LIVE round-trip test. Rounds 2–3 mapped the read surface:
//   GET /purchases.json           → list (statuses seen: sent, processed)
//   GET /purchases/{id}.json      → full detail incl. purchase_items
//     [{stock_id, quantity, unit_price, included_gst, gst_free, name,
//       description, ...}], supplier_id, reference, number (MD-assigned)
//   Supplier "Just Autos Wholesale" = id 1091329 (#1653)
//   MD's API takes FLAT JSON (no Rails wrapper — see POST /stocktakes).
//
// This round discovers CREATE + PROCESS (receive) + DELETE by doing them
// for real with a $1 × qty 1 test line, then cleaning up:
//   1. snapshot stock qty for the test SKU
//   2. POST /purchases (try flat body, then variants) — log result
//   3. discover the process endpoint on the created PO
//   4. DELETE the test PO (try variants)
//   5. re-snapshot stock qty — verify the delete reversed any receipt
//
// If cleanup fails, the test PO is reference JA-PORTAL-PROBE (delete it
// manually in MD) and the log says exactly what stock moved.

import { loginToMechanicDesk, findStockBySku, type MdClient } from '../lib/mechanicdesk-stocktake'

const MD_BASE = 'https://www.mechanicdesk.com.au'
const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const SUPPLIER_ID = 1091329          // Just Autos Wholesale
const TEST_SKU = 'SSMBC697-DPF'      // known stock 28812487

async function md(client: MdClient, path: string, init: { method?: string; body?: any } = {}) {
  const headers: Record<string, string> = {
    'Cookie': client.cookieHeader,
    'User-Agent': USER_AGENT,
    'Accept': 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
  }
  if (init.body !== undefined) headers['Content-Type'] = 'application/json'
  if (init.method && init.method !== 'GET') {
    if (client.csrfToken) headers['X-CSRF-Token'] = client.csrfToken
    const xsrf = (globalThis as any).__xsrf
    if (xsrf) headers['X-XSRF-TOKEN'] = xsrf   // Angular-style — the likely unlock
  }
  const r = await fetch(MD_BASE + path, {
    method: init.method || 'GET',
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    redirect: 'manual',
  })
  const text = await r.text().catch(() => '')
  let json: any = null
  try { json = JSON.parse(text) } catch { /* not JSON */ }
  return { status: r.status, json, text }
}

function log(label: string, r: { status: number; json: any; text: string }, maxLen = 1200) {
  const body = r.json ? JSON.stringify(r.json).slice(0, maxLen) : r.text.replace(/\s+/g, ' ').slice(0, 300)
  console.log(`${label} → ${r.status} ${body}`)
}

async function stockQty(client: MdClient): Promise<number | null> {
  try {
    const m = await findStockBySku(client, TEST_SKU)
    if (m.kind === 'matched') return Number((m.stock as any).quantity ?? (m.stock as any).available ?? 0)
  } catch { /* ignore */ }
  return null
}

async function main() {
  const wsId = process.env.MECHANICDESK_WORKSHOP_ID
  const user = process.env.MECHANICDESK_USERNAME
  const pass = process.env.MECHANICDESK_PASSWORD
  if (!wsId || !user || !pass) throw new Error('MECHANICDESK_* env vars required')

  console.log('Loading Playwright...')
  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ headless: true })
  const { client, cookies } = await loginToMechanicDesk(browser, wsId, user, pass)
  console.log(`Logged in · csrf=${client.csrfToken ? 'yes' : 'no'}`)

  // Round 4: POSTs 401'd ("Please login") — Rails CSRF. The login page
  // doesn't carry the csrf meta; harvest it from the app shell, plus any
  // rotated session cookies, before attempting writes.
  if (!client.csrfToken) {
    const ctx = await browser.newContext({ userAgent: USER_AGENT, viewport: { width: 1280, height: 900 } })
    await ctx.addCookies((cookies as any[]).map(c => ({ ...c, domain: 'www.mechanicdesk.com.au', path: '/' })))
    const page = await ctx.newPage()
    for (const target of ['/', '/auto_workshop', '/stocktakes_page', '/stocks_page']) {
      try {
        await page.goto(MD_BASE + target, { waitUntil: 'domcontentloaded', timeout: 30000 })
        await page.waitForTimeout(3000)
        const meta = await page.evaluate(() => document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || null)
        console.log(`csrf hunt ${target}: title="${await page.title()}" meta=${meta ? 'FOUND' : 'none'}`)
        if (meta) { client.csrfToken = meta; break }
      } catch (e: any) {
        console.log(`csrf hunt ${target}: ${e?.message || e}`)
      }
    }
    // Refresh cookie header from the browsing context (session may rotate).
    const fresh = await ctx.cookies(MD_BASE)
    if (fresh.length) client.cookieHeader = fresh.map((c: any) => `${c.name}=${c.value}`).join('; ')
    await ctx.close()
  }
  await browser.close().catch(() => {})
  console.log(`csrf token: ${client.csrfToken ? `yes (${String(client.csrfToken).slice(0, 12)}…)` : 'STILL MISSING'}\n`)

  const stock = await findStockBySku(client, TEST_SKU)
  if (stock.kind !== 'matched') { console.log(`Test SKU ${TEST_SKU} not matched (${stock.kind}) — abort`); return }
  const stockId = (stock.stock as any).id
  const qtyBefore = await stockQty(client)
  console.log(`Test stock id=${stockId} qtyBefore=${qtyBefore}\n`)

  // Round 6: GET works but POST 401s "Please login" with the same cookies →
  // Rails/Angular CSRF. The SPA reads the XSRF-TOKEN cookie and echoes it as
  // an X-XSRF-TOKEN header on writes. Dump cookie names and extract it.
  console.log(`COOKIE NAMES: ${client.cookieHeader.split(';').map(s => s.trim().split('=')[0]).join(', ')}`)
  const xsrfPair = client.cookieHeader.split(';').map(s => s.trim()).find(s => /^XSRF-TOKEN=/i.test(s))
  const xsrfToken = xsrfPair ? decodeURIComponent(xsrfPair.split('=').slice(1).join('=')) : null
  console.log(`XSRF-TOKEN cookie: ${xsrfToken ? `FOUND (${xsrfToken.slice(0, 16)}…)` : 'none'}`)
  if (xsrfToken && !client.csrfToken) client.csrfToken = xsrfToken
  ;(globalThis as any).__xsrf = xsrfToken

  // ── 2. CREATE attempts ────────────────────────────────────────────────
  const itemFlat = {
    stock_id: stockId,
    quantity: 1,
    unit_price: 1,
    included_gst: false,
    gst_free: false,
    name: `${TEST_SKU} — probe`,
    description: 'JA Portal automation probe — will be deleted',
    note: '',
  }
  const baseBody = {
    date: new Date().toISOString(),
    supplier_id: SUPPLIER_ID,
    reference: 'JA-PORTAL-PROBE',
    description: 'JA Portal automation probe — will be deleted',
  }

  let createdId: number | null = null
  const attempts: Array<[string, any]> = [
    ['flat purchase_items', { ...baseBody, purchase_items: [itemFlat] }],
    ['purchase_items_attributes', { ...baseBody, purchase_items_attributes: [itemFlat] }],
    ['wrapped purchase', { purchase: { ...baseBody, purchase_items_attributes: [itemFlat] } }],
  ]
  for (const [label, body] of attempts) {
    const r = await md(client, '/purchases', { method: 'POST', body })
    log(`CREATE (${label})`, r, 2000)
    if (r.status >= 200 && r.status < 300 && r.json?.id) { createdId = r.json.id; break }
  }
  if (!createdId) { console.log('\nNo create variant worked — see responses above.'); return }
  console.log(`\nCreated test purchase id=${createdId}`)

  // Read back — status + items
  const detail = await md(client, `/purchases/${createdId}.json`)
  console.log(`Readback status=${detail.json?.status} number=${detail.json?.number} total=${detail.json?.total_amount} items=${(detail.json?.purchase_items || []).length}`)

  // ── 3. PROCESS (receive) endpoint discovery ───────────────────────────
  const processAttempts: Array<[string, string, any]> = [
    ['POST /process', `POST`, `/purchases/${createdId}/process`],
    ['PUT /process', `PUT`, `/purchases/${createdId}/process`],
    ['POST /receive', `POST`, `/purchases/${createdId}/receive`],
    ['PUT status=processed', `PUT`, `/purchases/${createdId}`],
  ]
  let processed = false
  for (const [label, method, path] of processAttempts) {
    const body = path.endsWith(String(createdId)) ? { status: 'processed' } : {}
    const r = await md(client, path, { method, body })
    log(`PROCESS (${label})`, r)
    if (r.status >= 200 && r.status < 300) {
      const check = await md(client, `/purchases/${createdId}.json`)
      console.log(`  → status now: ${check.json?.status} processed=${check.json?.processed}`)
      if (check.json?.processed || check.json?.status === 'processed') { processed = true; break }
    }
  }
  const qtyAfterProcess = await stockQty(client)
  console.log(`processed=${processed} qtyAfterProcess=${qtyAfterProcess} (before=${qtyBefore})\n`)

  // ── 4. DELETE / cleanup ───────────────────────────────────────────────
  const deleteAttempts: Array<[string, string, any]> = [
    ['DELETE w/ reason', 'DELETE', { deleted_reason: 'JA Portal probe cleanup' }],
    ['DELETE plain', 'DELETE', undefined],
  ]
  let deleted = false
  for (const [label, method, body] of deleteAttempts) {
    const r = await md(client, `/purchases/${createdId}`, { method, body })
    log(`DELETE (${label})`, r)
    if (r.status >= 200 && r.status < 300) { deleted = true; break }
  }
  const check = await md(client, `/purchases/${createdId}.json`)
  console.log(`After delete: status=${check.status} deleted=${check.json?.deleted}`)
  const qtyFinal = await stockQty(client)
  console.log(`\nFINAL: created=${createdId} processed=${processed} deleted=${deleted}`)
  console.log(`STOCK ${TEST_SKU}: before=${qtyBefore} afterProcess=${qtyAfterProcess} final=${qtyFinal}`)
  if (qtyFinal !== qtyBefore) {
    console.log(`⚠ STOCK NOT RESTORED — adjust ${TEST_SKU} by ${(qtyBefore ?? 0) - (qtyFinal ?? 0)} in MD or delete PO JA-PORTAL-PROBE manually.`)
  }
}

main().catch(e => {
  console.error('FATAL', e)
  process.exit(1)
})
