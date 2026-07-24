// scripts/probe-md-note.ts
// One-off probe: log into MechanicDesk with a real browser, open a customer
// page, click "+ Add note", save a note — and CAPTURE every mutating network
// request the UI makes (method, URL, body). Also dumps the customer's JSON
// (address keys, whether notes appear) so the worker's create payloads can use
// MD's actual field names instead of guesses.
//
// Env: MECHANICDESK_WORKSHOP_ID/USERNAME/PASSWORD, PROBE_CUSTOMER_ID
// (defaults to the Portal Test customer created 2026-07-24).

const WS_ID = process.env.MECHANICDESK_WORKSHOP_ID || ''
const MD_USER = process.env.MECHANICDESK_USERNAME || ''
const MD_PASS = process.env.MECHANICDESK_PASSWORD || ''
const CUSTOMER_ID = process.env.PROBE_CUSTOMER_ID || '16244926'
const MD_BASE = 'https://www.mechanicdesk.com.au'

async function main() {
  const { chromium } = await import('playwright')
  const browser = await chromium.launch()
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()

  // Capture every mutating request the UI fires.
  page.on('request', r => {
    const m = r.method()
    if (m === 'POST' || m === 'PUT' || m === 'PATCH' || m === 'DELETE') {
      const url = r.url()
      if (url.includes('mechanicdesk')) {
        console.log(`REQ ${m} ${url}`)
        const body = r.postData()
        if (body) console.log(`  BODY ${body.slice(0, 800)}`)
      }
    }
  })
  page.on('response', async r => {
    const req = r.request()
    const m = req.method()
    if ((m === 'POST' || m === 'PUT' || m === 'PATCH') && r.url().includes('mechanicdesk') && !r.url().includes('/login')) {
      console.log(`RESP ${r.status()} ${m} ${r.url()}`)
    }
  })

  try {
    // Login (same flow as lib/mechanicdesk-stocktake, context kept open)
    await page.goto(`${MD_BASE}/auto_workshop/login`, { waitUntil: 'domcontentloaded', timeout: 30000 })
    const wsField = await page.$('input[name*="workshop"], input[placeholder*="orkshop"]')
    if (wsField) await wsField.fill(WS_ID)
    await page.fill('input[type="text"]:not([name*="workshop"]), input[name*="user"], input[type="email"]', MD_USER).catch(async () => {
      const inputs = await page.$$('input[type="text"]')
      if (inputs[1]) await inputs[1].fill(MD_USER)
    })
    await page.fill('input[type="password"]', MD_PASS)
    await page.click('button:has-text("Login"), input[type="submit"], button[type="submit"]')
    await page.waitForSelector('input[type="password"]', { state: 'detached', timeout: 30000 })
    console.log('LOGIN OK')

    // Dump the customer JSON via the session (address keys + notes presence)
    const custJson = await page.evaluate(async (id) => {
      const r = await fetch(`/customers/${id}.json`, { headers: { Accept: 'application/json' } })
      return { status: r.status, body: (await r.text()).slice(0, 2500) }
    }, CUSTOMER_ID)
    console.log(`CUSTOMER JSON ${custJson.status}: ${custJson.body}`)

    // Open the customer page and add a note through the UI
    await page.goto(`${MD_BASE}/customers/${CUSTOMER_ID}`, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await page.waitForTimeout(2500)
    const addNote = page.locator('text=Add note').first()
    await addNote.click({ timeout: 10000 }).catch(async (e: any) => {
      console.log(`add-note click failed: ${e?.message}`)
    })
    await page.waitForTimeout(1000)
    // Whatever editor appeared: fill the first visible textarea / contenteditable
    const ta = page.locator('textarea:visible').first()
    if (await ta.count()) {
      await ta.fill('PROBE NOTE — capture endpoint (delete me)')
    } else {
      const ce = page.locator('[contenteditable="true"]').first()
      if (await ce.count()) await ce.fill('PROBE NOTE — capture endpoint (delete me)')
      else console.log('NO NOTE EDITOR FOUND — dumping nearby HTML')
    }
    await page.waitForTimeout(500)
    // Save: try the likely buttons
    for (const sel of ['button:has-text("Save")', 'button:has-text("Add")', 'button:has-text("Create")', 'input[type="submit"]']) {
      const btn = page.locator(sel).first()
      if (await btn.count() && await btn.isVisible().catch(() => false)) {
        console.log(`clicking ${sel}`)
        await btn.click().catch((e: any) => console.log(`save click failed: ${e?.message}`))
        break
      }
    }
    await page.waitForTimeout(4000)  // let the XHR fire and get captured
    console.log('PROBE DONE')
  } catch (e: any) {
    console.error('PROBE ERROR:', e?.message || e)
    console.log('URL at failure:', page.url())
  } finally {
    await browser.close()
  }
}

main().catch(e => { console.error(e); process.exit(1) })
