// scripts/pull-md-oncar.ts
//
// GitHub Actions worker for the Stocktake (MD) "parts on cars" checker. Logs
// into MechanicDesk, sweeps the diary backwards from today, and returns the
// tracked parts sitting on STARTED jobs — cars in the workshop whose jobs
// haven't been invoiced, so MD/MYOB still counts their parts as on-hand.
// POSTs the snapshot to /api/workshop/oncar/ingest.
//
// MD has no usable jobs-list endpoint, so the day-by-day diary sweep is the
// only enumeration available — see collectPartsOnCars for the full reasoning.
//
// Env: MECHANICDESK_WORKSHOP_ID / _USERNAME / _PASSWORD, JA_PORTAL_BASE_URL,
//      JA_PORTAL_API_KEY (service token w/ stocktake:write),
//      LOOKBACK_DAYS (opt, default 365), RUN_ID (opt, pre-created row),
//      REQUESTED_BY (opt).

import { loginToMechanicDesk, collectPartsOnCars } from '../lib/mechanicdesk-stocktake'

function log(...args: any[]) { console.log(`[${new Date().toISOString()}]`, ...args) }

const PORTAL_BASE = process.env.JA_PORTAL_BASE_URL || ''
const PORTAL_TOKEN = process.env.JA_PORTAL_API_KEY || ''
const REQUESTED_BY = (process.env.REQUESTED_BY || 'scheduled').trim()
const RUN_ID_IN = (process.env.RUN_ID || '').trim()
const LOOKBACK = Number(process.env.LOOKBACK_DAYS || 365)
if (!PORTAL_BASE) throw new Error('JA_PORTAL_BASE_URL required')
if (!PORTAL_TOKEN) throw new Error('JA_PORTAL_API_KEY required')

async function ingest(body: Record<string, any>): Promise<any> {
  const r = await fetch(`${PORTAL_BASE}/api/workshop/oncar/ingest`, {
    method: 'POST',
    headers: { 'X-Service-Token': PORTAL_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(`ingest ${body.action} → ${r.status}: ${(await r.text().catch(() => '')).slice(0, 300)}`)
  return r.json()
}

async function main() {
  log(`Parts-on-cars pull starting (lookback ${LOOKBACK}d)`)
  const started = await ingest({ action: 'start', run_id: RUN_ID_IN || undefined, requested_by: REQUESTED_BY })
  const runId = started.run_id as string
  log(`run ${runId} running`)

  try {
    const wsId = process.env.MECHANICDESK_WORKSHOP_ID
    const username = process.env.MECHANICDESK_USERNAME
    const password = process.env.MECHANICDESK_PASSWORD
    if (!wsId || !username || !password) throw new Error('MECHANICDESK_WORKSHOP_ID/USERNAME/PASSWORD required')

    const { chromium } = await import('playwright')
    const browser = await chromium.launch({ headless: true })
    try {
      const { client } = await loginToMechanicDesk(browser, wsId, username, password)
      log('Logged in — sweeping the diary')
      // One session per employee in MD: recover in place if a human logs in
      // mid-sweep, rather than silently reporting fewer cars than are really
      // in the workshop.
      const relogin = async () => {
        const { client: fresh } = await loginToMechanicDesk(browser, wsId, username, password)
        client.cookieHeader = fresh.cookieHeader
        client.csrfToken = fresh.csrfToken
      }
      const res = await collectPartsOnCars(client, { lookbackDays: LOOKBACK, log: (m) => log(m), relogin })
      log(`${res.jobs.length} job(s), ${res.items.length} SKU(s), ${res.unitsTotal} unit(s), $${res.valueTotal}`)
      const done = await ingest({ action: 'finish', run_id: runId, result: res })
      log(`Done — stored ${done.items} item(s) / ${done.jobs} job(s)`)
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
