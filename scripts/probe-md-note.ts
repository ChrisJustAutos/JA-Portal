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
    const url = r.url()
    if (!url.includes('mechanicdesk')) return
    const mutating = m === 'POST' || m === 'PUT' || m === 'PATCH' || m === 'DELETE'
    if (mutating || /note/i.test(url)) {
      console.log(`REQ ${m} ${url}`)
      const body = r.postData()
      if (body) console.log(`  BODY ${body.slice(0, 800)}`)
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

    // Extract note-related API paths straight from MD's frontend bundles —
    // the endpoint is a string literal in their code, no UI interaction needed.
    for (const appUrl of [`${MD_BASE}/mdweb`, `${MD_BASE}/customers/${CUSTOMER_ID}`]) {
      console.log(`PAGE ${appUrl}`)
      await page.goto(appUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e: any) => console.log(`  goto failed: ${e?.message?.slice(0, 80)}`))
      await page.waitForTimeout(6000)
      const found = await page.evaluate(async () => {
        const srcs = Array.from(document.querySelectorAll('script[src]')).map(sc => (sc as HTMLScriptElement).src)
        const hits = new Set<string>()
        for (const src of srcs.slice(0, 15)) {
          try {
            const t = await (await fetch(src)).text()
            // route-ish string literals mentioning note
            for (const m of t.matchAll(/["'`](\/?[A-Za-z0-9_\/${}:.-]*notes?[A-Za-z0-9_\/${}:.-]*)["'`]/g)) {
              const v = m[1]
              if (v.length < 80 && /note/i.test(v)) hits.add(v)
            }
          } catch { /* skip asset */ }
        }
        return { scripts: srcs.length, hits: Array.from(hits).slice(0, 80) }
      })
      console.log(`  scripts=${found.scripts} note-strings=${found.hits.length}`)
      for (const h of found.hits) console.log(`  NOTESTR ${h}`)
      if (found.hits.length) break
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
