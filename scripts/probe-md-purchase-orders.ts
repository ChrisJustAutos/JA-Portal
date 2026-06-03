// scripts/probe-md-purchase-orders.ts
//
// Round 3. Round 2 found the surface: MD calls them PURCHASES —
//   GET /purchases.json            → { purchases: [{id, number, status,
//        total_amount, stock_names, reference, ...}], meta }
//   GET /suppliers/{id}/purchase_orders.json → same shape per supplier
// Round 2's UI pass 403'd (fresh context lacked the spoofed user-agent).
//
// This round maps the CREATE + RECEIVE shape:
//   1. Full JSON of one known purchase (id 6830348 — created manually
//      today) → line item field names, status values, supplier linkage.
//   2. /purchases/new + .json (form/template shape).
//   3. UI recon WITH the spoofed UA on /purchases/new — dump forms,
//      field names, selects, and all XHRs the page fires.

import { loginToMechanicDesk, type MdClient } from '../lib/mechanicdesk-stocktake'

const MD_BASE = 'https://www.mechanicdesk.com.au'
const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const KNOWN_PURCHASE_ID = 6830348

async function dump(client: MdClient, path: string, maxLen = 4000): Promise<void> {
  try {
    const r = await fetch(MD_BASE + path, {
      headers: {
        'Cookie': client.cookieHeader,
        'Accept': 'application/json, text/html',
        'User-Agent': USER_AGENT,
        'X-Requested-With': 'XMLHttpRequest',
      },
      redirect: 'manual',
    })
    const text = r.status < 300 ? await r.text() : ''
    console.log(`\n### ${r.status} ${path} ct=${r.headers.get('content-type') || ''}`)
    if (text) {
      const trimmed = text.trim()
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try { console.log(JSON.stringify(JSON.parse(trimmed), null, 1).slice(0, maxLen)) }
        catch { console.log(trimmed.slice(0, maxLen)) }
      } else {
        console.log(`HTML len=${text.length} preview=${trimmed.replace(/\s+/g, ' ').slice(0, 600)}`)
      }
    }
  } catch (e: any) {
    console.log(`ERR ${path}: ${e?.message || e}`)
  }
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

  // ── Pass 1: purchase detail + create-template shapes ──────────────────
  await dump(client, `/purchases/${KNOWN_PURCHASE_ID}.json`, 6000)
  await dump(client, `/purchases/${KNOWN_PURCHASE_ID}`, 2500)
  await dump(client, '/purchases/new.json', 3000)
  await dump(client, '/purchases/new', 2500)
  await dump(client, '/purchases.json?page=1', 1500)

  // ── Pass 2: UI recon with the spoofed UA ──────────────────────────────
  console.log('\n=== UI recon (/purchases/new) ===')
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    viewport: { width: 1280, height: 900 },
  })
  await context.addCookies((cookies as any[]).map(c => ({ ...c, domain: 'www.mechanicdesk.com.au', path: '/' })))
  const page = await context.newPage()

  const seenXhr = new Set<string>()
  page.on('request', (req: any) => {
    const u: string = req.url()
    if (!u.startsWith(MD_BASE)) return
    if (/\.(png|jpe?g|gif|svg|css|woff2?|ico)(\?|$)/i.test(u)) return
    if (/\.js(\?|$)/i.test(u)) return
    const key = `${req.method()} ${u.replace(MD_BASE, '')}`
    if (!seenXhr.has(key)) { seenXhr.add(key); console.log(`  XHR ${key.slice(0, 160)}`) }
  })

  for (const target of ['/purchases/new', `/purchases/${KNOWN_PURCHASE_ID}`]) {
    try {
      console.log(`\n-- navigate ${target}`)
      await page.goto(MD_BASE + target, { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {})
      await page.waitForTimeout(6000)
      console.log(`   url now: ${page.url()}  title: ${await page.title()}`)
      const info = await page.evaluate(() => {
        const forms: string[] = []
        document.querySelectorAll('form').forEach(f => {
          const fields: string[] = []
          f.querySelectorAll('input,select,textarea').forEach((el: any) => {
            const nm = el.name || el.id
            if (nm) fields.push(`${el.tagName.toLowerCase()}:${nm}${el.type ? `(${el.type})` : ''}`)
          })
          forms.push(`FORM action=${f.getAttribute('action')} method=${f.getAttribute('method')} fields=[${fields.join(', ')}]`)
        })
        const named: string[] = []
        document.querySelectorAll('input[name],select[name],textarea[name]').forEach((el: any) => {
          named.push(`${el.tagName.toLowerCase()}:${el.name}${el.type ? `(${el.type})` : ''}`)
        })
        const buttons: string[] = []
        document.querySelectorAll('button, [role=button], input[type=submit], a.btn, .btn').forEach((b: any) => {
          const t = (b.textContent || b.value || '').trim().replace(/\s+/g, ' ').slice(0, 40)
          if (t) buttons.push(t)
        })
        return {
          bodyPreview: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 500),
          forms: forms.slice(0, 12),
          named: Array.from(new Set(named)).slice(0, 80),
          buttons: Array.from(new Set(buttons)).slice(0, 50),
        }
      })
      console.log(`   body: ${info.bodyPreview}`)
      for (const f of info.forms) console.log(`   ${f.slice(0, 500)}`)
      console.log(`   named fields: ${info.named.join(', ')}`)
      console.log(`   buttons: ${info.buttons.join(' | ')}`)
    } catch (e: any) {
      console.log(`   nav failed: ${e?.message || e}`)
    }
  }

  await browser.close().catch(() => {})
  console.log('\nProbe complete.')
}

main().catch(e => {
  console.error('FATAL', e)
  process.exit(1)
})
