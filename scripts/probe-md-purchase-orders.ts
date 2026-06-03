// scripts/probe-md-purchase-orders.ts
//
// One-off diagnostic: log into MD and map the PURCHASE ORDER surface so we
// can automate "create PO + receive stock" for JAWS → VPS internal
// transfers. Three passes:
//   1. Endpoint guesses — Rails-style .json variants for purchase orders /
//      suppliers.
//   2. UI recon — load the app shell + likely PO pages in Playwright, dump
//      every nav link whose href/text mentions order/purchase/supplier/
//      stock, and log every XHR the pages fire.
//   3. Form recon — if a "new purchase order" page exists, dump its <form>
//      action/method and every input/select name so we know the POST shape.

import { loginToMechanicDesk, type MdClient } from '../lib/mechanicdesk-stocktake'

const MD_BASE = 'https://www.mechanicdesk.com.au'

const GUESS_PATHS = [
  '/purchase_orders',
  '/purchase_orders.json',
  '/purchase_orders.json?page=1',
  '/purchase_orders/new',
  '/auto_workshop/purchase_orders',
  '/auto_workshop/purchase_orders.json',
  '/stock_orders',
  '/stock_orders.json',
  '/supplier_orders',
  '/supplier_orders.json',
  '/orders.json',
  '/suppliers',
  '/suppliers.json',
  '/auto_workshop/suppliers.json',
  '/vendors.json',
  '/stock_receipts.json',
  '/goods_received.json',
]

async function probe(client: MdClient, path: string): Promise<void> {
  const url = MD_BASE + path
  try {
    const r = await fetch(url, {
      headers: {
        'Cookie': client.cookieHeader,
        'Accept': 'application/json, text/html',
        'User-Agent': 'Mozilla/5.0 (compatible; ja-portal probe)',
        'X-Requested-With': 'XMLHttpRequest',
      },
      redirect: 'manual',
    })
    const ct = r.headers.get('content-type') || ''
    const loc = r.headers.get('location') || ''
    let bodyPreview = ''
    if (r.status >= 200 && r.status < 300) {
      const text = await r.text()
      const trimmed = text.trim()
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
          const j = JSON.parse(trimmed)
          if (Array.isArray(j)) bodyPreview = `JSON ARRAY len=${j.length}; keys[0]=${j[0] ? Object.keys(j[0]).join(',') : '(empty)'}`
          else bodyPreview = `JSON OBJ keys=${Object.keys(j).join(',')}; sample=${JSON.stringify(j).slice(0, 300)}`
        } catch { bodyPreview = trimmed.slice(0, 200).replace(/\s+/g, ' ') }
      } else {
        bodyPreview = `HTML len=${text.length}; title=${(text.match(/<title>([^<]*)<\/title>/i) || [])[1] || ''}`
      }
    }
    console.log(`${r.status.toString().padEnd(3)} ${path.padEnd(42)} ct=${ct.slice(0, 30).padEnd(31)} loc=${loc.slice(0, 50).padEnd(50)} ${bodyPreview}`)
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

  console.log(`Logged in · ${client.cookieHeader.split(';').length} cookies · csrf=${client.csrfToken ? 'yes' : 'no'}\n`)

  console.log('=== Pass 1: endpoint guesses ===')
  for (const p of GUESS_PATHS) await probe(client, p)

  // ── Pass 2: UI recon with XHR logging ────────────────────────────────
  // Login closed its own context; open a fresh one seeded with the cookies.
  console.log('\n=== Pass 2: UI recon ===')
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  await context.addCookies((cookies as any[]).map(c => ({ ...c, domain: 'www.mechanicdesk.com.au', path: '/' })))
  const page = await context.newPage()

  const seenXhr = new Set<string>()
  page.on('request', (req: any) => {
    const u: string = req.url()
    if (!u.startsWith(MD_BASE)) return
    if (/\.(png|jpe?g|gif|svg|css|woff2?|js|ico)(\?|$)/i.test(u)) return
    const key = `${req.method()} ${u.replace(MD_BASE, '')}`
    if (!seenXhr.has(key)) { seenXhr.add(key); console.log(`  XHR ${key.slice(0, 160)}`) }
  })

  for (const target of ['/', '/purchase_orders', '/purchase_orders/new', '/stock_orders']) {
    try {
      console.log(`\n-- navigate ${target}`)
      await page.goto(MD_BASE + target, { waitUntil: 'domcontentloaded', timeout: 30000 })
      await page.waitForTimeout(4000)  // let SPA panels fire their XHRs
      console.log(`   url now: ${page.url()}`)
      // Dump links mentioning order/purchase/supplier/stock
      const links = await page.evaluate(() => {
        const out: string[] = []
        document.querySelectorAll('a[href]').forEach(a => {
          const href = a.getAttribute('href') || ''
          const text = (a.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 50)
          if (/order|purchase|supplier|stock|receiv/i.test(href + ' ' + text)) out.push(`${href}  «${text}»`)
        })
        return Array.from(new Set(out)).slice(0, 60)
      })
      for (const l of links) console.log(`   link ${l}`)

      // Dump forms + their fields
      const forms = await page.evaluate(() => {
        const out: string[] = []
        document.querySelectorAll('form').forEach(f => {
          const fields: string[] = []
          f.querySelectorAll('input,select,textarea').forEach((el: any) => {
            if (el.name) fields.push(`${el.tagName.toLowerCase()}:${el.name}${el.type ? `(${el.type})` : ''}`)
          })
          out.push(`FORM action=${f.getAttribute('action')} method=${f.getAttribute('method')} fields=[${fields.join(', ')}]`)
        })
        return out.slice(0, 20)
      })
      for (const f of forms) console.log(`   ${f.slice(0, 400)}`)
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
