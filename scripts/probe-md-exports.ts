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

    // ── 3b. JSON APIs: /invoices.json + /quotes.json structure ─────────────
    // (/invoices.xls turned out to be JSON — these are the old-app Angular
    // endpoints, paginated like /stocks.json. Map the record + meta shape.)
    for (const p of [
      '/invoices.json?page=1',
      '/invoices.json?page=1&per_page=200',
      '/invoices.json?page=1&from=2026-07-01&to=2026-07-07',
      '/invoices.json?page=1&start_date=2026-07-01&end_date=2026-07-07',
      '/quotes.json?page=1',
    ]) {
      try {
        const { status, ct, buf } = await get(client, `${MD_BASE}${p}`, 'application/json')
        log(`JSON ${p} → ${status} ${ct} ${buf.length}B`)
        if (status !== 200) continue
        const j = JSON.parse(buf.toString('utf8'))
        const arrKey = Object.keys(j).find(k => Array.isArray(j[k]))
        const arr = arrKey ? j[arrKey] : []
        const metaKeys = Object.keys(j).filter(k => k !== arrKey)
        log(`  keys: [${Object.keys(j).join(', ')}] · ${arrKey}: ${arr.length} row(s) · meta: ${JSON.stringify(Object.fromEntries(metaKeys.map(k => [k, j[k]])))?.slice(0, 400)}`)
        if (arr.length) {
          const dates = arr.map((r: any) => String(r.issue_date || '').slice(0, 10)).filter(Boolean)
          log(`  issue_date span: ${dates[0]} … ${dates[dates.length - 1]}`)
          log(`  FIRST RECORD: ${JSON.stringify(arr[0]).slice(0, 4500)}`)
        }
      } catch (e: any) { log(`JSON ${p} → ERR ${e?.message || e}`) }
    }

    // ── 3. The Export Data feature (async export queue) ────────────────────
    // /data_export is the form; /export_requests/ the queue. Past manual
    // exports show up here with their type names + download URLs.
    for (const p of ['/data_export', '/data_export.json']) {
      try {
        const { status, ct, buf } = await get(client, `${MD_BASE}${p}`, 'text/html,application/json,*/*')
        const text = buf.toString('utf8')
        log(`EXPORT-PAGE ${p} → ${status} ${ct} ${buf.length}B`)
        if (status === 200) {
          for (const m of text.matchAll(/<form[^>]*action="([^"]+)"[^>]*>/gi)) log(`  form action: ${m[1]}`)
          for (const m of text.matchAll(/<select[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/select>/gi)) {
            const opts = [...m[2].matchAll(/<option[^>]*value="([^"]*)"[^>]*>([^<]*)/gi)].map(o => `${o[1]}(${o[2].trim()})`)
            log(`  select ${m[1]}: ${opts.join(', ')}`)
          }
          for (const m of text.matchAll(/<input[^>]*name="([^"]+)"[^>]*>/gi)) log(`  input: ${m[1]}`)
          if (ct.includes('json')) log(`  body: ${text.slice(0, 2500)}`)
        }
      } catch (e: any) { log(`EXPORT-PAGE ${p} → ERR ${e?.message || e}`) }
    }
    for (const p of ['/export_requests.json', '/export_requests', '/export_requests/']) {
      try {
        const { status, ct, buf } = await get(client, `${MD_BASE}${p}`, 'application/json,text/html,*/*')
        const text = buf.toString('utf8')
        log(`EXPORT-REQS ${p} → ${status} ${ct} ${buf.length}B`)
        if (status === 200) log(`  body: ${text.slice(0, 3000)}`)
      } catch (e: any) { log(`EXPORT-REQS ${p} → ERR ${e?.message || e}`) }
    }

    // ── 4. Column-level detail on the workbooks we CAN get ────────────────
    const detail = [
      `/reports/income_by_invoice/download?${params}`,
      `/invoices.xls?${params}`,
      `/quotes.xls?${params}`,
      '/invoices.xls',            // no params — does the date filter even apply?
      '/invoices.xls?page=2',     // pagination?
    ]
    for (const c of detail) {
      try {
        const { status, ct, buf } = await get(client, `${MD_BASE}${c}`, 'application/vnd.ms-excel, */*')
        if (status !== 200) { log(`DETAIL ${c.split('?')[0]}${c.includes('?') ? '?' + c.split('?')[1].slice(0, 20) : ''} → ${status}`); continue }
        try {
          const wb = XLSX.read(buf)
          log(`DETAIL ${c.split('?')[0]}${c.includes('?') ? ' (' + c.split('?')[1].slice(0, 20) + '…)' : ''} → ${buf.length}B`)
          for (const sn of wb.SheetNames) {
            const rows: any[][] = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1 }) as any[][]
            log(`  sheet "${sn}": ${rows.length} row(s); header: ${JSON.stringify((rows[0] || []).slice(0, 40))}`)
            if (rows.length > 1) log(`    first data row: ${JSON.stringify((rows[1] || []).slice(0, 20))}`)
          }
        } catch (e: any) { log(`DETAIL ${c} → parse failed: ${e?.message}; first 300 chars: ${buf.toString('utf8').slice(0, 300)}`) }
      } catch (e: any) { log(`DETAIL ${c} → ERR ${e?.message || e}`) }
    }
    log('Probe complete')
  } finally {
    await browser.close().catch(() => undefined)
  }
}

main().catch(e => { log('FATAL:', e?.message || e); process.exit(1) })
