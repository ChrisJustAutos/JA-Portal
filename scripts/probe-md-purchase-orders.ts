// scripts/probe-md-purchase-orders.ts
//
// Round 8 — capture the PROCESS/RECEIVE network call from the real SPA UI.
// The UI lives at /mdweb/workshops/purchases/{id} (not the API /purchases/{id}
// which returns JSON). Create/delete + XSRF auth already confirmed; this finds
// how "Process" receives a PO into stock so the worker can replay it directly.
//
// Self-cleaning: create a $1 qty-1 test PO, open its UI, log every XHR, click
// the Process/Receive button, capture the resulting request (method/url/body),
// check the stock delta, then delete and re-check stock. Marked JA-PORTAL-PROBE.

import { loginToMechanicDesk, findStockBySku, createMdPurchase, deleteMdPurchase, type MdClient } from '../lib/mechanicdesk-stocktake'

const MD_BASE = 'https://www.mechanicdesk.com.au'
const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const SUPPLIER_ID = 1091329
const TEST_SKU = 'SSMBC697-DPF'

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

  const match = await findStockBySku(client, TEST_SKU)
  if (match.kind !== 'matched') { console.log(`Test SKU not matched (${match.kind})`); return }
  const stockId = (match.stock as any).id
  const qtyBefore = await stockQty(client)

  const po = await createMdPurchase(client, {
    supplierId: SUPPLIER_ID,
    reference: 'JA-PORTAL-PROBE',
    description: 'JA Portal automation probe — will be deleted',
    lines: [{ stock_id: stockId, quantity: 1, unit_price: 1, gst_free: false, name: `${TEST_SKU} — probe` }],
  })
  console.log(`Created test PO id=${po.id} number=${po.number} status=${po.status} · stock before=${qtyBefore}\n`)

  // ── Open the SPA UI and capture network around the Process click ──────
  const ctx = await browser.newContext({ userAgent: USER_AGENT, viewport: { width: 1400, height: 1000 } })
  await ctx.addCookies((cookies as any[]).map(c => ({ ...c, domain: 'www.mechanicdesk.com.au', path: '/' })))
  const page = await ctx.newPage()

  // MD likely uses a native confirm() for "Process this PO?" — Playwright
  // auto-dismisses native dialogs unless we accept them here.
  page.on('dialog', async (d: any) => {
    console.log(`   DIALOG (${d.type()}): "${d.message()}" → accept`)
    await d.accept().catch(() => {})
  })

  const writes: string[] = []
  page.on('request', (req: any) => {
    const u: string = req.url()
    if (!u.startsWith(MD_BASE)) return
    const m = req.method()
    if (m === 'OPTIONS') return
    // Capture all writes, plus any GET that looks like a state action.
    const rel = u.replace(MD_BASE, '')
    if (m === 'GET' && !/process|receive|complete|status/i.test(rel)) return
    let body = ''
    try { body = req.postData() || '' } catch { /* ignore */ }
    writes.push(`${m} ${rel}  body=${body.slice(0, 300)}`)
  })

  const uiUrl = `${MD_BASE}/mdweb/workshops/purchases/${po.id}`
  console.log(`Navigate ${uiUrl}`)
  await page.goto(uiUrl, { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {})
  await page.waitForTimeout(6000)
  console.log(`   title="${await page.title()}"`)

  // Dump candidate buttons.
  const buttons = await page.evaluate(() => {
    const out: string[] = []
    document.querySelectorAll('button, a.btn, .btn, [role=button], md-button, [ng-click], [ng-reflect-message]').forEach((b: any) => {
      const t = (b.textContent || b.value || '').trim().replace(/\s+/g, ' ').slice(0, 40)
      const click = b.getAttribute('ng-click') || b.getAttribute('data-action') || ''
      if (t || click) out.push(`«${t}»${click ? ` ng-click=${click}` : ''}`)
    })
    return Array.from(new Set(out)).slice(0, 80)
  })
  console.log(`   buttons: ${buttons.join(' | ')}`)

  // Click the Process / Receive button.
  let clicked = ''
  for (const rx of [/^process$/i, /process/i, /receive/i, /mark.*processed/i, /complete/i]) {
    const btn = page.locator('button, a, [role=button], md-button', { hasText: rx }).first()
    if (await btn.count().catch(() => 0)) {
      try {
        await btn.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {})
        await btn.click({ timeout: 5000 })
        clicked = rx.toString()
        console.log(`   clicked button matching ${clicked}`)
        break
      } catch (e: any) { console.log(`   click ${rx} failed: ${e?.message || e}`) }
    }
  }
  if (!clicked) console.log('   no Process/Receive button found')

  // Dump whatever appeared after the Process click — modal/dialog HTML +
  // every now-visible button — so the real submit control is identified.
  await page.waitForTimeout(2500)
  const modal = await page.evaluate(() => {
    const sels = ['md-dialog', '[role=dialog]', '.modal', '.mat-dialog-container', '.ui-dialog', '.ng-modal', '.popup', '.confirm']
    const found: string[] = []
    for (const s of sels) {
      document.querySelectorAll(s).forEach((el: any) => {
        const vis = el.offsetParent !== null || (el.getBoundingClientRect().height > 0)
        if (vis) found.push(`[${s}] ${el.outerHTML.replace(/\s+/g, ' ').slice(0, 900)}`)
      })
    }
    // Also: every visible button on the page right now (post-click).
    const btns: string[] = []
    document.querySelectorAll('button, a.btn, [role=button], md-button').forEach((b: any) => {
      if (b.offsetParent === null && b.getBoundingClientRect().height === 0) return
      const t = (b.textContent || b.value || '').trim().replace(/\s+/g, ' ').slice(0, 30)
      if (t) btns.push(t)
    })
    return { found, btns: Array.from(new Set(btns)) }
  })
  console.log(`\n   MODAL elements (${modal.found.length}):`)
  for (const m of modal.found) console.log(`     ${m}`)
  console.log(`   visible buttons now: ${modal.btns.join(' | ')}`)

  // Try clicking a likely submit inside the modal.
  for (const rx of [/^(process|receive|confirm|yes|ok|save|submit)$/i]) {
    const cbtn = page.locator('md-dialog button, [role=dialog] button, .modal button, .mat-dialog-container button, button', { hasText: rx }).last()
    if (await cbtn.count().catch(() => 0)) { try { await cbtn.click({ timeout: 3000 }); console.log(`   clicked modal submit ${rx}`); break } catch {} }
  }
  await page.waitForTimeout(5000)

  console.log('\n=== WRITE REQUESTS captured ===')
  for (const w of Array.from(new Set(writes))) console.log(`  ${w}`)

  // Read back + stock delta.
  const detailR = await fetch(`${MD_BASE}/purchases/${po.id}.json`, {
    headers: { 'Cookie': client.cookieHeader, 'User-Agent': USER_AGENT, 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
  })
  const detail = await detailR.json().catch(() => ({}))
  const qtyAfter = await stockQty(client)
  console.log(`\nAfter process: status=${detail?.status} processed=${detail?.processed} · stock ${qtyBefore} → ${qtyAfter}`)

  // Cleanup.
  await deleteMdPurchase(client, po.id, 'JA Portal probe cleanup').catch(e => console.log(`delete failed: ${e?.message || e}`))
  const qtyFinal = await stockQty(client)
  console.log(`After delete: stock=${qtyFinal} (before=${qtyBefore})`)
  if (qtyFinal !== qtyBefore) console.log(`⚠ STOCK NOT RESTORED — adjust ${TEST_SKU} by ${(qtyBefore ?? 0) - (qtyFinal ?? 0)} in MD (PO ${po.number}).`)

  await browser.close().catch(() => {})
  console.log('\nProbe complete.')
}

main().catch(e => { console.error('FATAL', e); process.exit(1) })
