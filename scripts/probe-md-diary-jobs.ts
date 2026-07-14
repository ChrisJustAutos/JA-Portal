// scripts/probe-md-diary-jobs.ts
//
// Recon for the Weekly Sales Recap's MechanicDesk sections (manual only):
//   • Section 4 Diary Overview — day notes / staff-away in the diary view
//   • Section 5 Forecast — forward-dated jobs + values ("Job Report")
//
// Prints STRUCTURE (endpoint status, top-level keys, sample object key lists,
// and a few obviously-non-PII scalar samples like dates/totals). Avoids dumping
// names/notes text bodies to CI logs — we only need field shapes to build the
// scraper. Env: MECHANICDESK_WORKSHOP_ID/USERNAME/PASSWORD.

import { loginToMechanicDesk, type MdClient } from '../lib/mechanicdesk-stocktake'

const WS_ID = process.env.MECHANICDESK_WORKSHOP_ID || ''
const MD_USER = process.env.MECHANICDESK_USERNAME || ''
const MD_PASS = process.env.MECHANICDESK_PASSWORD || ''
const MD_BASE = 'https://www.mechanicdesk.com.au'
if (!WS_ID || !MD_USER || !MD_PASS) throw new Error('MECHANICDESK_* env vars required')

function keysOf(v: any): any {
  if (Array.isArray(v)) return v.length ? [`array[${v.length}] of`, keysOf(v[0])] : 'array[0]'
  if (v && typeof v === 'object') return Object.keys(v)
  return typeof v
}
// Safe scalar preview — dates/numbers/booleans only; strings shown as length.
function scalars(o: any): any {
  if (!o || typeof o !== 'object') return {}
  const out: any = {}
  for (const [k, val] of Object.entries(o)) {
    if (val === null) out[k] = null
    else if (typeof val === 'number' || typeof val === 'boolean') out[k] = val
    else if (typeof val === 'string') out[k] = /^\d{4}-\d\d-\d\d/.test(val) ? val : `str(${val.length})`
    else out[k] = Array.isArray(val) ? `array[${(val as any[]).length}]` : 'obj'
  }
  return out
}

async function mdGet(client: MdClient, path: string) {
  const r = await fetch(`${MD_BASE}${path}`, {
    headers: { Cookie: client.cookieHeader, Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', Referer: `${MD_BASE}/auto_workshop/app`, 'User-Agent': 'Mozilla/5.0 (JA probe)' },
  })
  const text = await r.text()
  let json: any = null
  try { json = JSON.parse(text) } catch { /* */ }
  return { status: r.status, json, head: json ? '' : text.slice(0, 100).replace(/\s+/g, ' ') }
}

function iso(d: Date) { return d.toISOString().slice(0, 10) }

async function main() {
  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ headless: true })
  try {
    const { client } = await loginToMechanicDesk(browser, WS_ID, MD_USER, MD_PASS)
    console.log('MD login ok')

    const today = new Date()
    const past = new Date(today); past.setDate(past.getDate() - 7)
    const future = new Date(today); future.setDate(future.getDate() + 90)

    const paths = [
      `/mdweb/workshops/diary?start=${iso(past)}&end=${iso(today)}`,   // known endpoint, past week
      `/mdweb/workshops/diary?start=${iso(today)}&end=${iso(future)}`, // FORECAST window
      `/mdweb/workshops/diary_notes?start=${iso(past)}&end=${iso(today)}`,
      `/mdweb/workshops/day_notes?start=${iso(past)}&end=${iso(today)}`,
      `/reports/jobs.json`,
      `/mdweb/reports/jobs?start=${iso(today)}&end=${iso(future)}`,
      `/jobs.json?scheduled_start=${iso(today)}&scheduled_end=${iso(future)}`,
    ]
    for (const p of paths) {
      try {
        const r = await mdGet(client, p)
        console.log(`\n=== GET ${p} → ${r.status}`)
        if (!r.json) { console.log('  non-json:', r.head); continue }
        console.log('  top keys:', JSON.stringify(keysOf(r.json)).slice(0, 400))
        // dive into common containers
        for (const key of ['bookings', 'jobs', 'notes', 'day_notes', 'diary', 'data', 'results']) {
          const arr = r.json[key]
          if (Array.isArray(arr) && arr.length) {
            console.log(`  ${key}[0] keys:`, JSON.stringify(keysOf(arr[0])).slice(0, 500))
            console.log(`  ${key}[0] scalars:`, JSON.stringify(scalars(arr[0])).slice(0, 500))
          }
        }
      } catch (e: any) { console.log(`=== GET ${p} → ERROR ${String(e?.message).slice(0, 120)}`) }
    }

    // If diary jobs carry an id, fetch ONE job to see value/scheduled fields.
    try {
      const d = await mdGet(client, `/mdweb/workshops/diary?start=${iso(today)}&end=${iso(future)}`)
      const firstJob = d.json?.jobs?.[0] || d.json?.bookings?.[0]
      const jid = firstJob?.job_id || firstJob?.id
      if (jid) {
        const j = await mdGet(client, `/mdweb/workshops/jobs/${jid}?id=${jid}`)
        console.log(`\n=== job detail ${jid} → ${j.status}; top keys:`, JSON.stringify(keysOf(j.json)).slice(0, 500))
        if (j.json) console.log('  job scalars:', JSON.stringify(scalars(j.json)).slice(0, 600))
        if (j.json?.invoice) console.log('  invoice scalars:', JSON.stringify(scalars(j.json.invoice)).slice(0, 400))
      }
    } catch (e: any) { console.log('job detail probe error:', e?.message) }
  } finally {
    await browser.close()
  }
}
main().catch(e => { console.error('FATAL', e); process.exit(1) })
