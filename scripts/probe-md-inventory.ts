// scripts/probe-md-inventory.ts
//
// One-off diagnostic: log into MD and probe a handful of plausible
// inventory endpoints to figure out which one exposes the alert
// quantity. Once we know the shape, the real sync gets rebuilt
// against it.
//
// Targets to try (Rails-style apps usually have .json variants):
//   GET /stocks
//   GET /stocks.json?page=1
//   GET /stocks/{knownId}
//   GET /stocks/{knownId}.json
//   GET /auto_workshop/stocks
//   GET /auto_workshop/stocks.json
//   GET /inventory
//   GET /inventory.json
//   GET /reports/low_stock
//   GET /reports/low_stock.json
//
// A known stock id: 5323203 (BPR — from the previous diagnostic).

import { loginToMechanicDesk, type MdClient } from '../lib/mechanicdesk-stocktake'

const MD_BASE = 'https://www.mechanicdesk.com.au'
const KNOWN_STOCK_ID = 5323203 // BPR

const PATHS = [
  '/stocks',
  '/stocks.json',
  '/stocks.json?page=1',
  `/stocks/${KNOWN_STOCK_ID}`,
  `/stocks/${KNOWN_STOCK_ID}.json`,
  '/auto_workshop/stocks',
  '/auto_workshop/stocks.json',
  '/auto_workshop/inventory',
  '/auto_workshop/inventory.json',
  '/inventory',
  '/inventory.json',
  '/reports/low_stock',
  '/reports/low_stock.json',
  '/reports/stocks_below_alert',
  '/reports/below_alert.json',
]

async function probe(client: MdClient, path: string): Promise<void> {
  const url = MD_BASE + path
  try {
    const r = await fetch(url, {
      headers: {
        'Cookie': client.cookieHeader,
        'Accept': 'application/json, text/html',
        'User-Agent': 'Mozilla/5.0 (compatible; ja-portal probe)',
      },
      redirect: 'manual',
    })
    const ct = r.headers.get('content-type') || ''
    const loc = r.headers.get('location') || ''
    let bodyPreview = ''
    if (r.status >= 200 && r.status < 300) {
      const text = await r.text()
      bodyPreview = text.slice(0, 400).replace(/\s+/g, ' ')
      // If it looks like JSON, attempt to parse and surface keys
      const trimmed = text.trim()
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
          const j = JSON.parse(trimmed)
          if (Array.isArray(j)) bodyPreview = `JSON ARRAY len=${j.length}; keys[0]=${j[0] ? Object.keys(j[0]).join(',') : '(empty)'}`
          else bodyPreview = `JSON OBJ keys=${Object.keys(j).join(',')}`
        } catch { /* not JSON */ }
      }
    }
    console.log(`${r.status.toString().padEnd(3)} ${path.padEnd(50)} ct=${ct.padEnd(35)} loc=${loc.slice(0, 60).padEnd(60)} body=${bodyPreview}`)
  } catch (e: any) {
    console.log(`ERR ${path}: ${e?.message || e}`)
  }
}

async function probeListShape(client: MdClient): Promise<void> {
  console.log('\n=== Inspecting /stocks.json?page=1 first item ===')
  const r = await fetch(MD_BASE + '/stocks.json?page=1', {
    headers: { 'Cookie': client.cookieHeader, 'Accept': 'application/json' },
  })
  if (!r.ok) { console.log(`Failed ${r.status}`); return }
  const j: any = await r.json()
  console.log(`Total in meta: ${JSON.stringify(j.meta || {})}`)
  console.log(`stocks.length on page 1: ${(j.stocks || []).length}`)
  if (j.stocks?.[0]) {
    const first = j.stocks[0]
    console.log(`First item keys: ${Object.keys(first).join(', ')}`)
    console.log(`First item: ${JSON.stringify(first, null, 2)}`)
  }
  // Also try with below-alert filters
  for (const qs of ['?stock_alert=true', '?below_alert=true', '?alert_only=true', '?filter=below_alert']) {
    const u = MD_BASE + '/stocks.json' + qs
    const rr = await fetch(u, { headers: { 'Cookie': client.cookieHeader, 'Accept': 'application/json' } })
    if (rr.ok) {
      const jj: any = await rr.json()
      console.log(`Filter ${qs} → meta=${JSON.stringify(jj.meta || {})}, stocks=${(jj.stocks || []).length}`)
    } else {
      console.log(`Filter ${qs} → HTTP ${rr.status}`)
    }
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
  const { client } = await loginToMechanicDesk(browser, wsId, user, pass)
  await browser.close().catch(() => {})
  console.log(`Logged in · ${client.cookieHeader.split(';').length} cookies\n`)

  await probeListShape(client)
}

main().catch(e => {
  console.error('FATAL', e)
  process.exit(1)
})
