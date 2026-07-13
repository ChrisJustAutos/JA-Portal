// scripts/probe-md-customers.ts
//
// One-shot reconnaissance for the Monday→MD customer import (manual only).
// Discovers MechanicDesk's customer search + shape so createMdCustomer can be
// built on real field names. Prints STRUCTURE (keys, endpoint status codes),
// never customer values — CI logs are not the place for PII.
//
// Env: MECHANICDESK_WORKSHOP_ID / MECHANICDESK_USERNAME / MECHANICDESK_PASSWORD
//      PROBE_QUERY (optional customer-name search term, default "smith")

import { loginToMechanicDesk, type MdClient } from '../lib/mechanicdesk-stocktake'

const WS_ID = process.env.MECHANICDESK_WORKSHOP_ID || ''
const MD_USER = process.env.MECHANICDESK_USERNAME || ''
const MD_PASS = process.env.MECHANICDESK_PASSWORD || ''
const QUERY = process.env.PROBE_QUERY || 'smith'
const MD_BASE = 'https://www.mechanicdesk.com.au'

if (!WS_ID || !MD_USER || !MD_PASS) throw new Error('MECHANICDESK_* env vars required')

function shapeOf(v: any, depth = 0): any {
  if (v === null || v === undefined) return null
  if (Array.isArray(v)) return v.length ? [shapeOf(v[0], depth + 1), `(${v.length} items)`] : []
  if (typeof v === 'object') {
    if (depth > 3) return '{...}'
    return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, typeof val === 'object' ? shapeOf(val, depth + 1) : typeof val]))
  }
  return typeof v
}

async function mdGet(client: MdClient, path: string): Promise<{ status: number; json: any | null; textHead: string }> {
  const r = await fetch(`${MD_BASE}${path}`, {
    headers: {
      Cookie: client.cookieHeader,
      Accept: 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      'User-Agent': 'Mozilla/5.0 (JA-Portal probe)',
    },
  })
  const text = await r.text()
  let json: any = null
  try { json = JSON.parse(text) } catch { /* not json */ }
  return { status: r.status, json, textHead: json ? '' : text.slice(0, 120).replace(/\s+/g, ' ') }
}

async function main() {
  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ headless: true })
  const login = await loginToMechanicDesk(browser, WS_ID, MD_USER, MD_PASS)
  const client: MdClient = login.client
  console.log('logged in')

  const candidates = [
    `/customers.json?query=${QUERY}`,
    `/customers.json?search=${QUERY}`,
    `/customers.json?keyword=${QUERY}`,
    `/customers.json?term=${QUERY}`,
    `/customers.json?page=1&per_page=2`,
    `/customers?query=${QUERY}`,
    `/customers/autocomplete?term=${QUERY}`,
    `/customers/search?q=${QUERY}`,
  ]
  for (const p of candidates) {
    try {
      const r = await mdGet(client, p)
      const kind = r.json ? (Array.isArray(r.json) ? `array[${r.json.length}]` : typeof r.json) : `non-json: ${r.textHead}`
      console.log(`\n=== GET ${p} → ${r.status} ${kind}`)
      if (r.json) {
        const first = Array.isArray(r.json) ? r.json[0] : (r.json.customers?.[0] ?? r.json.items?.[0] ?? r.json)
        console.log('shape:', JSON.stringify(shapeOf(first), null, 1).slice(0, 1500))
      }
    } catch (e: any) {
      console.log(`=== GET ${p} → ERROR ${e?.message}`)
    }
  }

  // A single customer detail (take an id from the list probe if one worked)
  try {
    const list = await mdGet(client, `/customers.json?page=1&per_page=1`)
    const first = Array.isArray(list.json) ? list.json[0] : list.json?.customers?.[0]
    if (first?.id) {
      const detail = await mdGet(client, `/customers/${first.id}.json`)
      console.log(`\n=== GET /customers/{id}.json → ${detail.status}`)
      console.log('detail shape:', JSON.stringify(shapeOf(detail.json), null, 1).slice(0, 2500))
    }
  } catch (e: any) { console.log('detail probe error:', e?.message) }

  await browser.close()
}

main().catch(e => { console.error('FATAL', e); process.exit(1) })
