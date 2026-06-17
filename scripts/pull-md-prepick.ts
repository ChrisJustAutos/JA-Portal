// scripts/pull-md-prepick.ts
//
// GitHub Actions worker for the workshop "Pre Pick" feature. Logs into
// MechanicDesk, lists the diary jobs for a date range, fetches each job's
// invoice line-items, sums the TRACKED parts by stock + records the live
// on-hand, and POSTs the aggregate to the portal (which stores it as a
// md_prepick_runs snapshot the Pre Pick screen reads).
//
// Triggered by repository_dispatch ('prepick-pull', client_payload {from,to,
// requested_by}) from /api/workshop/prepick/refresh, by workflow_dispatch
// (from/to inputs), or on a schedule (defaults to today → +14 days).
//
// Env: MECHANICDESK_WORKSHOP_ID / _USERNAME / _PASSWORD, JA_PORTAL_BASE_URL,
//      JA_PORTAL_API_KEY (service token w/ stocktake:write), FROM, TO,
//      REQUESTED_BY (optional).

import { loginToMechanicDesk, collectPrePickDemand } from '../lib/mechanicdesk-stocktake'

function log(...args: any[]) { console.log(`[${new Date().toISOString()}]`, ...args) }

const PORTAL_BASE = process.env.JA_PORTAL_BASE_URL || ''
const PORTAL_TOKEN = process.env.JA_PORTAL_API_KEY || ''
if (!PORTAL_BASE) throw new Error('JA_PORTAL_BASE_URL required')
if (!PORTAL_TOKEN) throw new Error('JA_PORTAL_API_KEY required')

function ymd(d: Date): string { return d.toISOString().slice(0, 10) }
function defaultRange(): { from: string; to: string } {
  const now = new Date()
  const to = new Date(now); to.setDate(to.getDate() + 14)
  return { from: ymd(now), to: ymd(to) }
}
const FROM = (process.env.FROM || '').trim() || defaultRange().from
const TO = (process.env.TO || '').trim() || defaultRange().to
const REQUESTED_BY = (process.env.REQUESTED_BY || 'scheduled').trim()

async function ingest(body: Record<string, any>): Promise<any> {
  const r = await fetch(`${PORTAL_BASE}/api/workshop/prepick/ingest`, {
    method: 'POST',
    headers: { 'X-Service-Token': PORTAL_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(`ingest ${body.action} → ${r.status}: ${(await r.text().catch(() => '')).slice(0, 300)}`)
  return r.json()
}

async function main() {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(FROM) || !/^\d{4}-\d{2}-\d{2}$/.test(TO)) {
    throw new Error(`Bad FROM/TO: ${FROM}..${TO}`)
  }
  log(`Pre Pick pull for ${FROM} … ${TO}`)

  // 1. Open a run row (status 'running') so the UI can show progress.
  const started = await ingest({ action: 'start', from: FROM, to: TO, requested_by: REQUESTED_BY })
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
      log('Logged in — collecting demand')
      const { jobsCount, items } = await collectPrePickDemand(client, FROM, TO, log)
      log(`Aggregated ${items.length} part(s) across ${jobsCount} job(s)`)
      await ingest({ action: 'finish', run_id: runId, jobs_count: jobsCount, items })
      log('Done')
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
