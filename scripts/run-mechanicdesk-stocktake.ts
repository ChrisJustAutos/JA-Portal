// scripts/run-mechanicdesk-stocktake.ts
//
// GitHub Actions worker for stocktake operations. Triggered via
// repository_dispatch with client_payload:
//   { upload_id: "<uuid>", mode: "match" | "push" }
//
// Match mode:
//   1. Login to MD
//   2. For each parsed_rows entry, search MD via resource_search
//      — runs a parallel pool (default 5 workers, configurable via
//      STOCKTAKE_MATCH_CONCURRENCY env var). Auto-throttles on 429/5xx.
//   3. Record match status (matched / not_found / ambiguous / error)
//   4. PATCH the upload with match_results (preserving sheet_name)
//
// Push mode:
//   1. Login to MD
//   2. Find an open in-progress stocktake (or create a new one) — and
//      ALWAYS re-fetch by ID before reading stocktake_sheets, because
//      the GET /stocktakes listing endpoint returns stocktakes without
//      sheets populated.
//   3. For each matched row, POST /stocktake_sheets/{id}/new_item
//      with both the counted quantity AND the system on-hand snapshot
//      (md_current_qty) so MD's QTY column shows the right baseline.
//      — runs a parallel pool (default 3 workers, configurable via
//      STOCKTAKE_PUSH_CONCURRENCY env var). Each row gets ONE retry on
//      transient failure (429/5xx/network) before being marked as error.
//   4. Update upload with pushed_count / status='completed'
//   5. NEVER finishes/submits the stocktake — that's manual

import {
  loginToMechanicDesk,
  findStockBySku,
  findOpenStocktake,
  createStocktake,
  getStocktake,
  addItemToSheet,
  type MdClient,
  type MdStocktake,
} from '../lib/mechanicdesk-stocktake'

interface ParsedRow {
  row_number: number
  sku: string
  qty: number
  raw_name?: string
  sheet_name?: string  // for multi-tab workbooks
}

interface MatchResultEntry {
  row_number: number
  sku: string
  qty: number
  sheet_name?: string  // carried through from parsed_rows for traceability
  status: 'matched' | 'not_found' | 'ambiguous' | 'error'
  md_stock_id?: number
  md_stock_name?: string
  md_stock_number?: string
  md_current_qty?: number
  candidates?: Array<{ id: number; stock_number: string; name: string }>
  error?: string
}

function log(...args: any[]) {
  console.log(`[${new Date().toISOString()}]`, ...args)
}

const PORTAL_BASE = process.env.JA_PORTAL_BASE_URL || ''
const PORTAL_TOKEN = process.env.JA_PORTAL_API_KEY || ''
const UPLOAD_ID = process.env.UPLOAD_ID || ''
const MODE = process.env.MODE || ''

if (!PORTAL_BASE) throw new Error('JA_PORTAL_BASE_URL required')
if (!PORTAL_TOKEN) throw new Error('JA_PORTAL_API_KEY required')
if (!UPLOAD_ID) throw new Error('UPLOAD_ID required')
if (!['match', 'push'].includes(MODE)) throw new Error(`Invalid MODE: ${MODE}`)

async function readUpload(): Promise<any> {
  const r = await fetch(`${PORTAL_BASE}/api/stocktake/${UPLOAD_ID}`, {
    headers: { 'X-Service-Token': PORTAL_TOKEN },
  })
  if (!r.ok) throw new Error(`Failed to read upload ${UPLOAD_ID}: ${r.status} ${await r.text().catch(() => '')}`)
  return r.json()
}

async function patchUpload(update: Record<string, any>): Promise<void> {
  const r = await fetch(`${PORTAL_BASE}/api/stocktake/${UPLOAD_ID}`, {
    method: 'PATCH',
    headers: {
      'X-Service-Token': PORTAL_TOKEN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(update),
  })
  if (!r.ok) {
    const text = await r.text().catch(() => '')
    throw new Error(`Failed to patch upload: ${r.status} ${text.slice(0, 300)}`)
  }
}

async function notifySlack(message: string, isError = false): Promise<void> {
  const webhook = process.env.SLACK_WEBHOOK_URL
  if (!webhook) return
  const runUrl = process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : null
  const prefix = isError ? ':rotating_light: *Stocktake worker FAILED*' : ':white_check_mark: Stocktake worker'
  const body = `${prefix}\nUpload ${UPLOAD_ID} (${MODE})\n${message}${runUrl ? `\n<${runUrl}|View run logs>` : ''}`
  try {
    await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: body }),
    })
  } catch (e: any) {
    log(`Slack notify failed: ${e?.message}`)
  }
}

/**
 * Detect throttle/transient error signals from mdFetch errors.
 * mdFetch's error format is: "MD <METHOD> <path> → <status>: <body>"
 * Returns true for 429 and 5xx. Used by both match and push to halve
 * concurrency adaptively.
 */
function isThrottleError(msg: string): boolean {
  return /→\s*(429|5\d\d)\b/.test(msg)
}

/**
 * Detect any transient failure that's worth retrying once.
 * Includes throttle signals plus connection-reset / abort / timeout style
 * errors that fetch can throw without an HTTP status.
 */
function isTransientError(msg: string): boolean {
  if (isThrottleError(msg)) return true
  return /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up|network/i.test(msg)
}

// ── Match mode ────────────────────────────────────────────────────────

/**
 * Match a single SKU against MD. Returns the result entry to push into
 * the results array (in the original row's slot). Also returns whether
 * the call hit a "throttle signal" (429 or 5xx) so the pool can react.
 */
async function matchSingleRow(
  client: MdClient,
  row: ParsedRow,
): Promise<{ entry: MatchResultEntry; throttled: boolean }> {
  const baseEntry: Pick<MatchResultEntry, 'row_number' | 'sku' | 'qty' | 'sheet_name'> = {
    row_number: row.row_number,
    sku: row.sku,
    qty: row.qty,
    sheet_name: row.sheet_name,
  }

  try {
    const r = await findStockBySku(client, row.sku)
    if (r.kind === 'matched' && r.stock) {
      return {
        entry: {
          ...baseEntry,
          status: 'matched',
          md_stock_id: r.stock.id,
          md_stock_name: r.stock.name || '',
          md_stock_number: r.stock.stock_number || '',
          md_current_qty: typeof r.stock.available === 'number' ? r.stock.available : undefined,
        },
        throttled: false,
      }
    }
    if (r.kind === 'ambiguous' && r.candidates) {
      return {
        entry: {
          ...baseEntry,
          status: 'ambiguous',
          candidates: r.candidates.map(c => ({
            id: c.id,
            stock_number: c.stock_number || '',
            name: c.name || '',
          })),
        },
        throttled: false,
      }
    }
    return { entry: { ...baseEntry, status: 'not_found' }, throttled: false }
  } catch (e: any) {
    const msg: string = e?.message || String(e)
    return {
      entry: { ...baseEntry, status: 'error', error: msg },
      throttled: isThrottleError(msg),
    }
  }
}

/**
 * Run the match pass with a parallel worker pool.
 *
 * Design:
 *   - Worker pool of `concurrency` async loops, each pulling the next
 *     row index from a shared counter
 *   - Results land in `results[i]` so output order matches input order
 *   - On 429/5xx, halve concurrency (down to min 1) by setting a
 *     "throttle floor" — extra workers see it and exit
 *   - 100ms gap between starts within a single worker (so 5 workers
 *     ≈ 50 rows/sec ceiling, vs 10 rows/sec serial)
 */
async function runMatch(client: MdClient, parsedRows: ParsedRow[]): Promise<void> {
  const total = parsedRows.length

  const concurrencyEnv = parseInt(process.env.STOCKTAKE_MATCH_CONCURRENCY || '', 10)
  const initialConcurrency = Number.isFinite(concurrencyEnv) && concurrencyEnv >= 1
    ? Math.min(concurrencyEnv, 16)
    : 5
  const perWorkerGapMs = 100

  log(`Running match for ${total} rows · concurrency=${initialConcurrency}`)

  const results: MatchResultEntry[] = new Array(total)
  let nextIndex = 0
  let completed = 0
  let matched = 0
  let unmatched = 0
  let throttleEvents = 0
  let activeConcurrency = initialConcurrency
  let lastLoggedTenth = 0

  async function worker(workerNum: number): Promise<void> {
    while (true) {
      if (workerNum >= activeConcurrency) return

      const i = nextIndex++
      if (i >= total) return

      const row = parsedRows[i]
      const { entry, throttled } = await matchSingleRow(client, row)
      results[i] = entry
      completed++
      if (entry.status === 'matched') matched++
      else unmatched++

      if (throttled) {
        throttleEvents++
        const before = activeConcurrency
        activeConcurrency = Math.max(1, Math.floor(activeConcurrency / 2))
        if (activeConcurrency < before) {
          log(`  ⚠ Throttle signal on row ${row.row_number} (SKU "${row.sku}") — concurrency ${before} → ${activeConcurrency}`)
        }
      }

      const tenth = Math.floor((completed / total) * 10)
      if (tenth > lastLoggedTenth || (completed % 50 === 0 && completed > 0)) {
        lastLoggedTenth = tenth
        log(`  ${completed}/${total} processed (matched=${matched}, unmatched=${unmatched}, conc=${activeConcurrency})`)
      }

      await new Promise(r => setTimeout(r, perWorkerGapMs))
    }
  }

  const startedAt = Date.now()
  const workerPromises: Promise<void>[] = []
  for (let w = 0; w < initialConcurrency; w++) {
    workerPromises.push(worker(w))
  }
  await Promise.all(workerPromises)
  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1)

  log(`Match complete in ${elapsedSec}s: ${matched} matched, ${unmatched} unmatched (throttle events: ${throttleEvents})`)

  // Sanity check: every slot should be filled
  const missing: number[] = []
  for (let i = 0; i < total; i++) {
    if (!results[i]) missing.push(i)
  }
  if (missing.length > 0) {
    log(`  ⚠ ${missing.length} result slots missing — filling with error entries`)
    for (const i of missing) {
      const row = parsedRows[i]
      results[i] = {
        row_number: row.row_number,
        sku: row.sku,
        qty: row.qty,
        sheet_name: row.sheet_name,
        status: 'error',
        error: 'Result slot was never populated (worker pool bug)',
      }
      unmatched++
    }
  }

  await patchUpload({
    status: 'matched',
    matched_at: new Date().toISOString(),
    matched_count: matched,
    unmatched_count: unmatched,
    match_results: results,
    github_run_id: process.env.GITHUB_RUN_ID || null,
  })

  await notifySlack(
    `Match complete in ${elapsedSec}s: ${matched} matched, ${unmatched} unmatched (out of ${total} rows)` +
    (throttleEvents > 0 ? ` · ${throttleEvents} throttle events, final concurrency ${activeConcurrency}` : ''),
    false,
  )
}

// ── Push mode ─────────────────────────────────────────────────────────

function pickUsableSheet(stocktake: MdStocktake): { id: number; status: string; finished: boolean } | null {
  const sheets = stocktake.stocktake_sheets
  if (!Array.isArray(sheets) || sheets.length === 0) return null

  const inProgress = sheets.find(s => s && !s.deleted && s.status === 'in progress')
  if (inProgress) return inProgress

  const notFinished = sheets.find(s => s && !s.deleted && !s.finished)
  if (notFinished) return notFinished

  const anyNotDeleted = sheets.find(s => s && !s.deleted)
  return anyNotDeleted || null
}

async function fetchStocktakeWithSheet(
  client: MdClient,
  stocktakeId: number,
  attempts = 5,
): Promise<MdStocktake> {
  let last: MdStocktake | null = null
  for (let i = 1; i <= attempts; i++) {
    last = await getStocktake(client, stocktakeId)
    const sheetCount = Array.isArray(last.stocktake_sheets) ? last.stocktake_sheets.length : 'undefined'
    log(`  Attempt ${i}: stocktake ${stocktakeId} returned ${sheetCount} sheet(s)`)
    if (Array.isArray(last.stocktake_sheets) && last.stocktake_sheets.some(s => s && !s.deleted)) {
      return last
    }
    if (i < attempts) {
      log(`  No usable sheet yet — waiting 1s before retry`)
      await new Promise(r => setTimeout(r, 1000))
    }
  }
  if (last) return last
  throw new Error(`Failed to fetch stocktake ${stocktakeId} after ${attempts} attempts`)
}

async function resolveTargetSheet(client: MdClient): Promise<{
  stocktakeId: number
  sheetId: number
  wasCreated: boolean
}> {
  log('Looking for an open in-progress stocktake…')
  const openSummary = await findOpenStocktake(client)

  if (openSummary) {
    log(`Found existing stocktake ${openSummary.id} ("${openSummary.name}") in listing — re-fetching for sheets`)
    let fresh: MdStocktake
    try {
      fresh = await fetchStocktakeWithSheet(client, openSummary.id)
    } catch (e: any) {
      throw new Error(`Could not load sheets for stocktake ${openSummary.id}: ${e?.message || e}`)
    }
    const sheet = pickUsableSheet(fresh)
    if (!sheet) {
      const sheetDebug = Array.isArray(fresh.stocktake_sheets)
        ? JSON.stringify(fresh.stocktake_sheets.map(s => ({ id: s?.id, status: s?.status, deleted: s?.deleted, finished: s?.finished })))
        : 'undefined'
      throw new Error(`Stocktake ${openSummary.id} has no usable sheet (sheets: ${sheetDebug})`)
    }
    log(`  Using sheet ${sheet.id} (status="${sheet.status}", finished=${sheet.finished})`)
    return { stocktakeId: openSummary.id, sheetId: sheet.id, wasCreated: false }
  }

  const name = `JA Portal Upload ${new Date().toISOString().slice(0, 10)}`
  log(`No open stocktake — creating new "${name}"`)
  const created = await createStocktake(client, name)
  const initialSheetCount = Array.isArray(created.stocktake_sheets) ? created.stocktake_sheets.length : 'undefined'
  log(`  Created stocktake ${created.id} (sheets in POST response: ${initialSheetCount})`)

  await patchUpload({
    mechanicdesk_stocktake_id: String(created.id),
    mechanicdesk_stocktake_was_created: true,
  }).catch(e => log(`  Warn: could not persist stocktake_id early: ${e?.message}`))

  log(`  Re-fetching stocktake ${created.id} to read its sheet…`)
  const fresh = await fetchStocktakeWithSheet(client, created.id)
  const sheet = pickUsableSheet(fresh)
  if (!sheet) {
    const sheetDebug = Array.isArray(fresh.stocktake_sheets)
      ? JSON.stringify(fresh.stocktake_sheets.map(s => ({ id: s?.id, status: s?.status, deleted: s?.deleted })))
      : 'undefined'
    throw new Error(`Stocktake ${created.id} was created but no usable sheet appeared (sheets: ${sheetDebug}). Check MD UI directly — the stocktake may need manual intervention.`)
  }
  log(`  Resolved sheet ${sheet.id}`)
  return { stocktakeId: created.id, sheetId: sheet.id, wasCreated: true }
}

interface PushAttemptResult {
  ok: boolean
  throttled: boolean
  error?: string
}

/**
 * Push a single matched row to MD. On a transient failure (429/5xx/network),
 * waits 1s and retries ONCE. Returns success/failure plus whether a throttle
 * signal was seen (so the pool can halve concurrency).
 */
async function pushSingleRow(
  client: MdClient,
  sheetId: number,
  row: MatchResultEntry,
): Promise<PushAttemptResult> {
  let throttled = false

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await addItemToSheet(client, sheetId, {
        stockId: row.md_stock_id!,
        stockNumber: row.md_stock_number || row.sku,
        stockName: row.md_stock_name || '',
        count: row.qty,
        currentQty: row.md_current_qty,
      })
      return { ok: true, throttled }
    } catch (e: any) {
      const msg: string = e?.message || String(e)
      if (isThrottleError(msg)) throttled = true

      if (attempt === 1 && isTransientError(msg)) {
        log(`  Retry SKU "${row.sku}" after transient error: ${msg.slice(0, 120)}`)
        await new Promise(r => setTimeout(r, 1000))
        continue
      }

      return { ok: false, throttled, error: msg }
    }
  }

  return { ok: false, throttled, error: 'Exhausted retry attempts' }
}

async function runPush(client: MdClient, matchResults: MatchResultEntry[]): Promise<void> {
  const matched = matchResults.filter(r => r.status === 'matched' && r.md_stock_id != null)
  if (matched.length === 0) throw new Error('No matched items to push')

  const concurrencyEnv = parseInt(process.env.STOCKTAKE_PUSH_CONCURRENCY || '', 10)
  const initialConcurrency = Number.isFinite(concurrencyEnv) && concurrencyEnv >= 1
    ? Math.min(concurrencyEnv, 8)
    : 3

  log(`Push starting: ${matched.length} items to add · concurrency=${initialConcurrency}`)

  // Diagnostic: how many rows have a known system QTY snapshot?
  const withQty = matched.filter(r => typeof r.md_current_qty === 'number').length
  if (withQty < matched.length) {
    log(`  Note: ${matched.length - withQty}/${matched.length} matched rows have no md_current_qty — those will go in with QTY=0 (variance will appear large in MD)`)
  }

  const { stocktakeId, sheetId, wasCreated } = await resolveTargetSheet(client)
  log(`Target: stocktake_id=${stocktakeId}, sheet_id=${sheetId}, created_new=${wasCreated}`)

  await patchUpload({
    mechanicdesk_stocktake_id: String(stocktakeId),
    mechanicdesk_sheet_id: String(sheetId),
    mechanicdesk_stocktake_was_created: wasCreated,
  })

  const total = matched.length
  let nextIndex = 0
  let completed = 0
  let pushed = 0
  let throttleEvents = 0
  let activeConcurrency = initialConcurrency
  let lastLoggedTenth = 0
  const errors: any[] = []

  async function worker(workerNum: number): Promise<void> {
    while (true) {
      if (workerNum >= activeConcurrency) return

      const i = nextIndex++
      if (i >= total) return

      const row = matched[i]
      const { ok, throttled, error } = await pushSingleRow(client, sheetId, row)
      completed++

      if (ok) {
        pushed++
      } else {
        log(`  ERROR adding SKU "${row.sku}" (stock_id=${row.md_stock_id}): ${error}`)
        errors.push({
          row_number: row.row_number,
          sku: row.sku,
          sheet_name: row.sheet_name,
          md_stock_id: row.md_stock_id,
          error: error || 'unknown',
        })
      }

      if (throttled) {
        throttleEvents++
        const before = activeConcurrency
        activeConcurrency = Math.max(1, Math.floor(activeConcurrency / 2))
        if (activeConcurrency < before) {
          log(`  ⚠ Throttle signal on row ${row.row_number} (SKU "${row.sku}") — concurrency ${before} → ${activeConcurrency}`)
        }
      }

      // Periodic progress log + DB checkpoint of pushed_count
      const tenth = Math.floor((completed / total) * 10)
      if (tenth > lastLoggedTenth || (completed % 25 === 0 && completed > 0)) {
        lastLoggedTenth = tenth
        log(`  ${completed}/${total} done (pushed=${pushed}, errors=${errors.length}, conc=${activeConcurrency})`)
        await patchUpload({ pushed_count: pushed }).catch(() => undefined)
      }
    }
  }

  const startedAt = Date.now()
  const workerPromises: Promise<void>[] = []
  for (let w = 0; w < initialConcurrency; w++) {
    workerPromises.push(worker(w))
  }
  await Promise.all(workerPromises)
  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1)

  log(`Push complete in ${elapsedSec}s: ${pushed} added, ${errors.length} errors (throttle events: ${throttleEvents})`)

  await patchUpload({
    status: errors.length === matched.length ? 'failed' : 'completed',
    pushed_count: pushed,
    push_completed_at: new Date().toISOString(),
    push_errors: errors.length > 0 ? errors : null,
    github_run_id: process.env.GITHUB_RUN_ID || null,
  })

  await notifySlack(
    `Push complete in ${elapsedSec}s: ${pushed}/${matched.length} items added` +
    (errors.length > 0 ? ` · ${errors.length} errors` : '') +
    (wasCreated ? ` · created new stocktake ${stocktakeId}` : ` · used existing stocktake ${stocktakeId}`) +
    (throttleEvents > 0 ? ` · ${throttleEvents} throttle events, final concurrency ${activeConcurrency}` : ''),
    errors.length > 0,
  )
}

// ── Main ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  log(`Stocktake worker starting · upload=${UPLOAD_ID} · mode=${MODE}`)

  const upload = await readUpload()
  log(`Loaded upload "${upload.filename}" (status=${upload.status}, total_rows=${upload.total_rows})`)

  const wsId = process.env.MECHANICDESK_WORKSHOP_ID
  const username = process.env.MECHANICDESK_USERNAME
  const password = process.env.MECHANICDESK_PASSWORD
  if (!wsId || !username || !password) {
    throw new Error('MECHANICDESK_WORKSHOP_ID/USERNAME/PASSWORD env vars required')
  }

  log('Loading Playwright (dynamic import)…')
  const playwright = await import('playwright')
  const { chromium } = playwright

  log('Launching headless Chromium for login')
  const browser = await chromium.launch({ headless: true })
  try {
    const { client } = await loginToMechanicDesk(browser, wsId, username, password)
    log(`Login OK · ${client.cookieHeader.split(';').length} cookies, csrf=${client.csrfToken ? 'yes' : 'no'}`)

    if (MODE === 'match') {
      const rows = (upload.parsed_rows || []) as ParsedRow[]
      if (rows.length === 0) throw new Error('No parsed_rows in upload')
      await runMatch(client, rows)
    } else if (MODE === 'push') {
      const results = (upload.match_results || []) as MatchResultEntry[]
      if (results.length === 0) throw new Error('No match_results in upload')
      await runPush(client, results)
    }

    log('Worker done')
    process.exit(0)
  } catch (e: any) {
    log(`FATAL: ${e?.message || e}`)
    if (e?.stack) log(e.stack)

    try {
      await patchUpload({
        status: 'failed',
        notes: `Worker error in ${MODE} mode: ${e?.message || e}`,
      })
    } catch (patchErr: any) {
      log(`Could not mark upload as failed: ${patchErr?.message}`)
    }

    await notifySlack(`Error in ${MODE}: ${e?.message || e}`, true)
    process.exit(1)
  } finally {
    await browser.close().catch(() => undefined)
  }
}

main()
