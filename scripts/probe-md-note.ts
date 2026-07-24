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
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 1000 },
  })
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
    // Login — selectors copied VERBATIM from lib/mechanicdesk-stocktake's
    // proven loginToMechanicDesk (three-field form: workshop id, username, pw).
    await page.goto(`${MD_BASE}/auto_workshop/login`, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await page.waitForSelector('input[type="password"]', { timeout: 20000 })
    const workshopInput = await page.$('input[name*="workshop" i], input#workshop_id, input[placeholder*="Workshop" i]')
    if (workshopInput) await workshopInput.fill(WS_ID)
    else {
      const fallback = await page.$('input[type="text"]:not([disabled])')
      if (!fallback) throw new Error('Could not find workshop ID field')
      await fallback.fill(WS_ID)
    }
    const usernameInput = await page.$('input[name="username"], input#username, input[name="user[username]"]')
    if (usernameInput) await usernameInput.fill(MD_USER)
    else {
      const all = await page.$$('input[type="text"]:not([disabled])')
      if (all.length < 2) throw new Error('Could not find username field')
      await all[1].fill(MD_USER)
    }
    const passwordInput = await page.$('input[type="password"]')
    if (!passwordInput) throw new Error('Could not find password field')
    await passwordInput.fill(MD_PASS)
    const submit = await page.$('button:has-text("Login"), input[type="submit"], button[type="submit"]')
    if (!submit) throw new Error('Could not find submit button')
    await submit.click()
    await page.waitForSelector('input[type="password"]', { state: 'detached', timeout: 30000 })
    console.log('LOGIN OK')

    // Dump the customer JSON via the session (address keys + notes presence)
    const custJson = await page.evaluate(async (id) => {
      const r = await fetch(`/customers/${id}.json`, { headers: { Accept: 'application/json' } })
      return { status: r.status, body: (await r.text()).slice(0, 2500) }
    }, CUSTOMER_ID)
    console.log(`CUSTOMER JSON ${custJson.status}: ${custJson.body}`)

    // GET-probe plausible notes read endpoints (statuses tell us the resource name)
    for (const path of [`/customers/${CUSTOMER_ID}/notes.json`, `/notes.json?notable_id=${CUSTOMER_ID}&notable_type=Customer`, `/customer_notes.json?customer_id=${CUSTOMER_ID}`, `/crm_notes.json?customer_id=${CUSTOMER_ID}`, `/comments.json?customer_id=${CUSTOMER_ID}`]) {
      const r = await page.evaluate(async (p2) => {
        const rr = await fetch(p2, { headers: { Accept: 'application/json' } })
        return { p: p2, status: rr.status, body: (await rr.text()).slice(0, 200) }
      }, path)
      console.log(`GETPROBE ${r.status} ${r.p}: ${r.body}`)
    }

    // Try BOTH UIs for the Add note button: old app page, then the mdweb SPA.
    for (const url of [`${MD_BASE}/customers/${CUSTOMER_ID}`, `${MD_BASE}/mdweb#/customers/${CUSTOMER_ID}`]) {
      console.log(`PAGE ${url}`)
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
      await page.waitForTimeout(8000)  // SPA hydration
      console.log(`  landed on ${page.url()} title="${await page.title()}"`)
      const htmlHits = await page.evaluate(() => {
        const html = document.body ? document.body.innerHTML : ''
        const out: string[] = []
        const re = /add[\s_-]?note/gi
        let m
        while ((m = re.exec(html)) && out.length < 3) out.push(html.slice(Math.max(0, m.index - 120), m.index + 120).replace(/\s+/g, ' '))
        return out
      })
      console.log(`  add-note HTML hits: ${htmlHits.length}`)
      htmlHits.forEach(h => console.log(`  HIT: ${h}`))
      const addNote2 = page.locator('text=Add note').first()
      if (await addNote2.count()) {
        await addNote2.click({ timeout: 8000 }).catch((e: any) => console.log(`  click failed: ${e?.message?.slice(0, 100)}`))
        await page.waitForTimeout(1500)
        const ta2 = page.locator('textarea:visible').first()
        if (await ta2.count()) {
          await ta2.fill('PROBE NOTE — capture endpoint (delete me)')
          for (const sel of ['button:has-text("Save")', 'button:has-text("Add")', 'button:has-text("Create")', 'button:has-text("OK")']) {
            const btn = page.locator(sel).first()
            if (await btn.count() && await btn.isVisible().catch(() => false)) {
              console.log(`  clicking ${sel}`)
              await btn.click().catch((e: any) => console.log(`  save failed: ${e?.message?.slice(0, 100)}`))
              break
            }
          }
          await page.waitForTimeout(4000)
          break  // note attempted — captured requests tell the story
        } else {
          console.log('  no textarea after click')
        }
      } else {
        console.log('  no Add note element on this page')
      }
    }
    console.log('PROBE DONE')
  } catch (e: any) {
    console.error('PROBE ERROR:', e?.message || e)
    console.log('URL at failure:', page.url())
  } finally {
    await browser.close()
  }
}

main().catch(e => { console.error(e); process.exit(1) })
