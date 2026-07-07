// scripts/probe-md-exports.ts
// One-shot reconnaissance for the Workshop Map worker: finds MechanicDesk's
// invoice/quote export endpoints. Logs in, scans the old app + /mdweb SPA
// HTML and JS bundles for report/export route strings, then probes a battery
// of candidate URLs (short date range so heavy reports don't 504) and logs
// status / content-type / sheet names for anything that parses as a workbook.
// Read the Action logs, then bake the winning routes into
// pull-md-workshop-map.ts (or set MD_*_REPORT_PATH repo variables).
//
// Env: MECHANICDESK_WORKSHOP_ID / _USERNAME / _PASSWORD.

import * as XLSX from 'xlsx'
import { loginToMechanicDesk, MdClient } from '../lib/mechanicdesk-stocktake'

function log(...args: any[]) { console.log(`[${new Date().toISOString()}]`, ...args) }
const MD_BASE = 'https://www.mechanicdesk.com.au'

function mdDateParam(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${days[dt.getUTCDay()]} ${months[dt.getUTCMonth()]} ${String(dt.getUTCDate()).padStart(2, '0')} ${dt.getUTCFullYear()} 00:00:00 GMT+1000 (Australian Eastern Standard Time)`
}

async function get(client: MdClient, url: string, accept = '*/*'): Promise<{ status: number; ct: string; buf: Buffer }> {
  const r = await fetch(url, {
    headers: {
      'Cookie': client.cookieHeader,
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': accept,
      'Referer': `${MD_BASE}/auto_workshop/app`,
    },
    redirect: 'follow',
  })
  return { status: r.status, ct: r.headers.get('content-type') || '', buf: Buffer.from(await r.arrayBuffer()) }
}

async function main() {
  const wsId = process.env.MECHANICDESK_WORKSHOP_ID!
  const username = process.env.MECHANICDESK_USERNAME!
  const password = process.env.MECHANICDESK_PASSWORD!
  if (!wsId || !username || !password) throw new Error('MD creds required')

  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ headless: true })
  try {
    const { client } = await loginToMechanicDesk(browser, wsId, username, password)
    log('Logged in')

    // ── 1. Token scan: route-ish strings mentioning report/export/xls ──────
    const pages = ['/reports', '/auto_workshop/app', '/mdweb', '/mdweb/', '/settings', '/exports', '/data_exports', '/export_data']
    const tokens = new Set<string>()
    const jsUrls = new Set<string>()
    for (const p of pages) {
      try {
        const { status, ct, buf } = await get(client, `${MD_BASE}${p}`, 'text/html,*/*')
        const text = buf.toString('utf8')
        log(`scan ${p} → ${status} ${ct} (${buf.length}B)`)
        if (status !== 200) continue
        for (const m of text.matchAll(/["'(]((?:\/|https?:\/\/[^"'()]*\/)?(?:api\/)?[a-z0-9_\-/]*(?:report|export|invoice|quote)[a-z0-9_\-/]*(?:\.(?:xls|xlsx|csv|json))?)["')]/gi)) {
          const t = m[1]
          if (t.length < 200) tokens.add(t)
        }
        for (const m of text.matchAll(/(?:src|href)="([^"]+\.js[^"]*)"/g)) {
          jsUrls.add(m[1].startsWith('http') ? m[1] : `${MD_BASE}${m[1].startsWith('/') ? '' : '/'}${m[1]}`)
        }
      } catch (e: any) { log(`scan ${p} failed: ${e?.message || e}`) }
    }
    log(`Found ${jsUrls.size} JS bundle(s)`)
    for (const ju of [...jsUrls].slice(0, 15)) {
      try {
        const { status, buf } = await get(client, ju)
        if (status !== 200) continue
        const js = buf.toString('utf8')
        let n = 0
        for (const m of js.matchAll(/["'`]((?:\/|api\/)[a-z0-9_\-/]*(?:report|export)[a-z0-9_\-/]*(?:\/download)?(?:\.(?:xls|xlsx|csv|json))?)["'`]/gi)) {
          const t = m[1]
          if (t.length < 200 && !tokens.has(t)) { tokens.add(t); n++ }
        }
        log(`bundle ${ju.slice(0, 100)} → +${n} token(s)`)
      } catch { /* skip */ }
    }
    log(`TOKENS (${tokens.size}):`)
    for (const t of [...tokens].sort()) log(`  ${t}`)

    // ── 2. Candidate battery (1-week range so heavy reports don't 504) ─────
    const to = new Date(); const from = new Date(to.getTime() - 7 * 86400_000)
    const ymd = (d: Date) => d.toISOString().slice(0, 10)
    const params = new URLSearchParams({ from: mdDateParam(ymd(from)), to: mdDateParam(ymd(to)) })
    const candidates = [
      `/reports/income_by_invoice/download?${params}`,
      `/reports/quote_conversion/download?${params}`,
      `/reports/income/download?${params}`,
      `/reports/payments/download?${params}`,
      `/invoices.xls?${params}`,
      `/quotes.xls?${params}`,
      `/invoices/export?${params}`,
      `/quotes/export?${params}`,
      `/invoices/download?${params}`,
      `/quotes/download?${params}`,
      `/exports/invoices?${params}`,
      `/exports/quotes?${params}`,
      `/data_exports/invoices?${params}`,
      `/data_exports/quotes?${params}`,
    ]
    for (const c of candidates) {
      try {
        const { status, ct, buf } = await get(client, `${MD_BASE}${c}`, 'application/vnd.ms-excel, */*')
        let sheets = ''
        if (status === 200 && !ct.includes('html') && buf.length > 512) {
          try { sheets = ' sheets=[' + XLSX.read(buf).SheetNames.join(' | ') + ']' } catch { sheets = ' (not a workbook)' }
        }
        log(`PROBE ${c.split('?')[0]} → ${status} ${ct} ${buf.length}B${sheets}`)
      } catch (e: any) { log(`PROBE ${c.split('?')[0]} → ERR ${e?.message || e}`) }
    }
    log('Probe complete')
  } finally {
    await browser.close().catch(() => undefined)
  }
}

main().catch(e => { log('FATAL:', e?.message || e); process.exit(1) })
