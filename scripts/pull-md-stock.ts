// scripts/pull-md-stock.ts
//
// GitHub Actions worker for the parts-bot stock cache. Logs into MechanicDesk,
// pages the FULL catalogue (/stocks.json), and POSTs the snapshot to the portal
// (/api/parts-bot/md-stock-ingest), which replaces md_stock_cache. The Slack
// bot's search_md_stock tool then answers front-counter parts queries from that
// cache — instantly and without touching MD at query time.
//
// Runs on a ~30-min schedule (see .github/workflows/md-stock-sync.yml). MD has
// no API, so this scheduled scrape is the only fast, collision-free source.
//
// Env: MECHANICDESK_WORKSHOP_ID / _USERNAME / _PASSWORD, JA_PORTAL_BASE_URL,
//      JA_PORTAL_API_KEY (service token w/ stocktake:write), REQUESTED_BY (opt).

import { loginToMechanicDesk, fetchAllStock } from '../lib/mechanicdesk-stocktake'

function log(...args: any[]) { console.log(`[${new Date().toISOString()}]`, ...args) }

const PORTAL_BASE = process.env.JA_PORTAL_BASE_URL || ''
const PORTAL_TOKEN = process.env.JA_PORTAL_API_KEY || ''
const REQUESTED_BY = (process.env.REQUESTED_BY || 'scheduled').trim()
if (!PORTAL_BASE) throw new Error('JA_PORTAL_BASE_URL required')
if (!PORTAL_TOKEN) throw new Error('JA_PORTAL_API_KEY required')

async function ingest(body: Record<string, any>): Promise<any> {
  const r = await fetch(`${PORTAL_BASE}/api/parts-bot/md-stock-ingest`, {
    method: 'POST',
    headers: { 'X-Service-Token': PORTAL_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(`ingest ${body.action} → ${r.status}: ${(await r.text().catch(() => '')).slice(0, 300)}`)
  return r.json()
}

async function main() {
  log('MD stock-cache pull starting')
  const started = await ingest({ action: 'start', requested_by: REQUESTED_BY })
  const runId = started.run_id as string
  log(`run ${runId} started`)

  try {
    const wsId = process.env.MECHANICDESK_WORKSHOP_ID
    const username = process.env.MECHANICDESK_USERNAME
    const password = process.env.MECHANICDESK_PASSWORD
    if (!wsId || !username || !password) throw new Error('MECHANICDESK_WORKSHOP_ID/USERNAME/PASSWORD required')

    log('Launching headless Chromium for MD login')
    const { chromium } = await import('playwright')
    const browser = await chromium.launch({ headless: true })
    try {
      const { client } = await loginToMechanicDesk(browser, wsId, username, password)
      log('Logged in — paging /stocks.json')
      const items = await fetchAllStock(client, { log })
      log(`Fetched ${items.length} catalogue item(s) — posting to portal`)
      const done = await ingest({ action: 'finish', run_id: runId, items })
      log(`Done — cached ${done.items} item(s)`)
    } finally {
      await browser.close().catch(() => undefined)
    }
  } catch (e: any) {
    const msg = e?.message || String(e)
    log('FAILED:', msg)
    try { await ingest({ action: 'error', run_id: runId, error: msg.slice(0, 1000) }) } catch { /* */ }
    process.exit(1)
  }
}

main().catch(e => { log('FATAL:', e?.message || e); process.exit(1) })
