// scripts/probe-md-diary-jobs.ts
//
// Recon v3 for the Weekly Sales Recap MD sections, using the PROVEN data
// endpoints from lib/mechanicdesk-stocktake's collectPrePickDemand (the SPA
// /mdweb route just serves HTML; the real XHR data route is /auto_workshop/diary
// + /jobs/{id}, same cookie session). Goal: find the fields for
//   • Section 4 Diary Overview — per-day notes / staff-away
//   • Section 5 Forecast — forward bookings + their $ value
// Structure only (keys + safe scalars), no names/notes text to CI logs.

import { loginToMechanicDesk, type MdClient } from '../lib/mechanicdesk-stocktake'

const WS_ID = process.env.MECHANICDESK_WORKSHOP_ID || ''
const MD_USER = process.env.MECHANICDESK_USERNAME || ''
const MD_PASS = process.env.MECHANICDESK_PASSWORD || ''
const MD_BASE = 'https://www.mechanicdesk.com.au'
if (!WS_ID || !MD_USER || !MD_PASS) throw new Error('MECHANICDESK_* env vars required')

const keysOf = (v: any): any =>
  Array.isArray(v) ? (v.length ? [`array[${v.length}]`, keysOf(v[0])] : 'array[0]')
  : (v && typeof v === 'object') ? Object.keys(v)
  : typeof v
function scalars(o: any): any {
  if (!o || typeof o !== 'object') return {}
  const out: any = {}
  for (const [k, val] of Object.entries(o)) {
    if (val === null) out[k] = null
    else if (typeof val === 'number' || typeof val === 'boolean') out[k] = val
    else if (typeof val === 'string') out[k] = /^\d{4}-\d\d-\d\d|^\d+(\.\d+)?$/.test(val) ? val : `str(${val.length})`
    else out[k] = Array.isArray(val) ? `arr[${(val as any[]).length}]` : 'obj'
  }
  return out
}
async function mdGet(client: MdClient, path: string) {
  const r = await fetch(`${MD_BASE}${path}`, {
    headers: { Cookie: client.cookieHeader, Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', Referer: `${MD_BASE}/auto_workshop/app`, 'User-Agent': 'Mozilla/5.0 (JA probe)' },
  })
  const t = await r.text(); let j: any = null; try { j = JSON.parse(t) } catch {}
  return { status: r.status, json: j, head: j ? '' : t.slice(0, 90).replace(/\s+/g, ' ') }
}
const isoAU = (d: Date, end = false) => `${d.toISOString().slice(0, 10)}T${end ? '23:59:59' : '00:00:00'}+10:00`

async function main() {
  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ headless: true })
  try {
    const { client } = await loginToMechanicDesk(browser, WS_ID, MD_USER, MD_PASS)
    console.log('MD login ok')
    const today = new Date()
    const past = new Date(today); past.setDate(past.getDate() - 3)
    const fut = new Date(today); fut.setDate(fut.getDate() + 120)

    // 1. Diary — PAST day (find notes/value fields on booking rows)
    const dP = await mdGet(client, `/auto_workshop/diary?start=${encodeURIComponent(isoAU(past))}&end=${encodeURIComponent(isoAU(past, true))}`)
    console.log(`\n=== /auto_workshop/diary (past day) → ${dP.status}`)
    if (dP.json) {
      console.log('  TOP keys:', JSON.stringify(keysOf(dP.json)).slice(0, 400))
      for (const k of ['bookings', 'jobs', 'notes', 'day_notes', 'diary_notes']) {
        const a = dP.json[k]
        if (Array.isArray(a) && a.length) { console.log(`  ${k}[0] keys:`, JSON.stringify(keysOf(a[0])).slice(0, 600)); console.log(`  ${k}[0] scalars:`, JSON.stringify(scalars(a[0])).slice(0, 600)) }
        else if (a != null) console.log(`  ${k}:`, JSON.stringify(keysOf(a)).slice(0, 200))
      }
    } else console.log('  non-json:', dP.head)

    // 2. Day-note endpoint candidates (Section 4 source)
    for (const p of [`/auto_workshop/day_note?date=${today.toISOString().slice(0,10)}`, `/auto_workshop/diary_note?date=${today.toISOString().slice(0,10)}`, `/auto_workshop/notes?date=${today.toISOString().slice(0,10)}`, `/auto_workshop/staff_leave`, `/auto_workshop/roster`]) {
      const r = await mdGet(client, p)
      console.log(`\n=== ${p} → ${r.status}`, r.json ? JSON.stringify(keysOf(r.json)).slice(0, 200) : `non-json: ${r.head}`)
    }

    // 3. Forward diary window (Section 5 forecast — forward bookings + value)
    const dF = await mdGet(client, `/auto_workshop/diary?start=${encodeURIComponent(isoAU(today))}&end=${encodeURIComponent(isoAU(fut, true))}`)
    console.log(`\n=== /auto_workshop/diary (next 120d) → ${dF.status}`)
    let sampleJid: number | null = null
    if (dF.json) {
      const jobs = [...(dF.json.bookings || []), ...(dF.json.jobs || [])]
      console.log(`  forward rows: ${jobs.length}`)
      if (jobs[0]) { console.log('  row keys:', JSON.stringify(keysOf(jobs[0])).slice(0, 600)); console.log('  row scalars:', JSON.stringify(scalars(jobs[0])).slice(0, 600)); sampleJid = Number(jobs[0].job_id ?? jobs[0].id) || null }
    }
    // 4. One job detail — find the $ value/estimate field for forecast
    if (sampleJid) {
      const j = await mdGet(client, `/jobs/${sampleJid}?id=${sampleJid}`)
      console.log(`\n=== /jobs/${sampleJid} → ${j.status}; keys:`, JSON.stringify(keysOf(j.json)).slice(0, 500))
      if (j.json) console.log('  job scalars:', JSON.stringify(scalars(j.json)).slice(0, 700))
      if (j.json?.invoice) console.log('  invoice scalars:', JSON.stringify(scalars(j.json.invoice)).slice(0, 500))
    }
  } finally { await browser.close() }
}
main().catch(e => { console.error('FATAL', e); process.exit(1) })
