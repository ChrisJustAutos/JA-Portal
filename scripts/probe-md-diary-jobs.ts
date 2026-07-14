// scripts/probe-md-diary-jobs.ts
//
// Recon v2 for the Weekly Sales Recap MD sections. The diary/report data now
// comes through the /mdweb SPA (raw endpoint guesses return HTML/404), so we
// instrument the browser NETWORK and drive the UI: log in, open the Diary and
// Reports→Job Report screens, and capture every XHR/fetch the SPA fires
// (URL, status, JSON top-level keys + safe scalar sample). That reveals the
// real endpoints + params to build the scrapers against. Structure only — no
// names/notes text dumped. Env: MECHANICDESK_WORKSHOP_ID/USERNAME/PASSWORD.

import { loginToMechanicDesk } from '../lib/mechanicdesk-stocktake'

const WS_ID = process.env.MECHANICDESK_WORKSHOP_ID || ''
const MD_USER = process.env.MECHANICDESK_USERNAME || ''
const MD_PASS = process.env.MECHANICDESK_PASSWORD || ''
const MD_BASE = 'https://www.mechanicdesk.com.au'
if (!WS_ID || !MD_USER || !MD_PASS) throw new Error('MECHANICDESK_* env vars required')

function keysOf(v: any): any {
  if (Array.isArray(v)) return v.length ? [`array[${v.length}]`, keysOf(v[0])] : 'array[0]'
  if (v && typeof v === 'object') return Object.keys(v).slice(0, 40)
  return typeof v
}
function scalars(o: any): any {
  if (!o || typeof o !== 'object') return {}
  const out: any = {}
  for (const [k, val] of Object.entries(o)) {
    if (val === null) out[k] = null
    else if (typeof val === 'number' || typeof val === 'boolean') out[k] = val
    else if (typeof val === 'string') out[k] = /^\d{4}-\d\d-\d\d/.test(val) ? val : `str(${val.length})`
    else out[k] = Array.isArray(val) ? `arr[${(val as any[]).length}]` : 'obj'
  }
  return out
}

async function main() {
  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ headless: true })
  const seen = new Set<string>()
  try {
    // Log in via the shared helper to reuse its CSRF/redirect handling, then
    // reuse the SAME browser's context by opening a fresh page on it.
    const { client } = await loginToMechanicDesk(browser, WS_ID, MD_USER, MD_PASS)
    console.log('MD login ok')
    const ctx = browser.contexts()[0] || await browser.newContext()
    const page = await ctx.newPage()

    // Capture every JSON-ish API response the SPA fires.
    page.on('response', async (resp) => {
      const url = resp.url()
      if (!/mechanicdesk\.com\.au/.test(url)) return
      if (!/\.json|\/api\/|report|diary|job|booking|note/i.test(url)) return
      const ct = resp.headers()['content-type'] || ''
      if (!ct.includes('json')) return
      const key = resp.request().method() + ' ' + url.split('?')[0]
      if (seen.has(key)) return
      seen.add(key)
      let body: any = null
      try { body = await resp.json() } catch { return }
      const path = url.replace(MD_BASE, '')
      console.log(`\nXHR ${resp.status()} ${resp.request().method()} ${path.slice(0, 160)}`)
      console.log('  top:', JSON.stringify(keysOf(body)).slice(0, 300))
      for (const k of ['bookings', 'jobs', 'notes', 'data', 'results', 'rows', 'items']) {
        if (Array.isArray(body?.[k]) && body[k].length) {
          console.log(`  ${k}[0] keys:`, JSON.stringify(keysOf(body[k][0])).slice(0, 400))
          console.log(`  ${k}[0] scalars:`, JSON.stringify(scalars(body[k][0])).slice(0, 400))
        }
      }
    })

    const visit = async (label: string, url: string, waitMs = 6000) => {
      console.log(`\n########## ${label}: ${url}`)
      try { await page.goto(url, { waitUntil: 'networkidle', timeout: 40000 }) }
      catch (e: any) { console.log('  nav warn:', String(e?.message).slice(0, 80)) }
      await page.waitForTimeout(waitMs)
    }

    // 1. Main app (captures dashboard + nav bootstrap calls)
    await visit('APP', `${MD_BASE}/auto_workshop/app`)
    // 2. Diary — try common SPA hash routes
    await visit('DIARY', `${MD_BASE}/auto_workshop/app#/diary`)
    // 3. Reports landing, then Job Report — hash routes are guesses; the
    //    network capture works regardless of which one actually resolves.
    await visit('REPORTS', `${MD_BASE}/auto_workshop/app#/reports`)
    await visit('REPORTS2', `${MD_BASE}/auto_workshop/app#/reports/jobs`)

    // 4. Best-effort: click any visible "Reports" then "Job" menu items.
    try {
      const rep = page.getByText(/^Reports$/i).first()
      if (await rep.count()) { await rep.click({ timeout: 5000 }); await page.waitForTimeout(3000) }
      const job = page.getByText(/Job Report|Jobs Report|^Jobs$/i).first()
      if (await job.count()) { await job.click({ timeout: 5000 }); await page.waitForTimeout(5000) }
    } catch (e: any) { console.log('  menu-click warn:', String(e?.message).slice(0, 80)) }

    console.log(`\nDISTINCT JSON ENDPOINTS SEEN: ${seen.size}`)
    for (const k of seen) console.log('  •', k.replace(MD_BASE, ''))
  } finally {
    await browser.close()
  }
}
main().catch(e => { console.error('FATAL', e); process.exit(1) })
