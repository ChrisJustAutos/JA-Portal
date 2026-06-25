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
//      STOCKTAKE_PUSH_CONCURRENCY env var). A row retries on transient
//      failure (429/5xx/network) AND recovers from a mid-run MD session
//      eviction (401 "Please login") by re-logging in — otherwise one
//      stray login elsewhere would 401 every remaining row.
//   4. Update upload with pushed_count / status='completed'
//   5. NEVER finishes/submits the stocktake — that's manual
//
//   ERRORS_ONLY=1 (push mode): re-push only the rows that failed last time,
//   onto the SAME stored sheet — no new stocktake, no duplicate adds. Used
//   to clean up a partial push.

import {
  loginToMechanicDesk,
  findStockBySku,
  findOpenStocktake,
  createStocktake,
  getStocktake,
  addItemToSheet,
  fetchInStockUniverse,
  type MdClient,
  type MdStocktake,
  type InStockItem,
} from '../lib/mechanicdesk-stocktake'

interface ParsedRow {
  row_number: number
  sku: string
  qty: number
  raw_name?: string
  bin?: string         // from the count sheet (MD bins are sparse)
  location?: string    // from the count sheet
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
  md_bin?: string
  md_location?: string
  sheet_bin?: string       // bin from the uploaded count sheet (preferred over md_bin)
  sheet_location?: string
  candidates?: Array<{ id: number; stock_number: string; name: string }>
  error?: string
  count_source?: 'md_stocktake'  // counted qty was pulled from the live MD stocktake entry
  added_from_md?: boolean        // row was counted directly in MD, not present in our sheet
}

function log(...args: any[]) {
  console.log(`[${new Date().toISOString()}]`, ...args)
}

// Log the MD stock object's field names once per run (to confirm qty fields).
let loggedStockKeys = false

const PORTAL_BASE = process.env.JA_PORTAL_BASE_URL || ''
const PORTAL_TOKEN = process.env.JA_PORTAL_API_KEY || ''
const UPLOAD_ID = process.env.UPLOAD_ID || ''
const MODE = process.env.MODE || ''

if (!PORTAL_BASE) throw new Error('JA_PORTAL_BASE_URL required')
if (!PORTAL_TOKEN) throw new Error('JA_PORTAL_API_KEY required')
if (!UPLOAD_ID) throw new Error('UPLOAD_ID required')
if (!['match', 'push', 'recheck', 'refresh'].includes(MODE)) throw new Error(`Invalid MODE: ${MODE}`)

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

/**
 * Detect a MechanicDesk session-eviction error: MD allows only ONE active
 * session per employee account, so if another worker (prepick/recheck) or a
 * human logs in with the same MD account mid-run, our cookies are invalidated
 * and every subsequent write 401s with "Please login" (or the explicit
 * "logged in from a different computer" on the first one). Recoverable by
 * re-logging in — see reloginShared(). mdFetch's format is "MD <m> <p> → 401: …".
 */
function isAuthError(msg: string): boolean {
  return /→\s*401\b/.test(msg) && /login|different computer/i.test(msg)
}

// ── Shared re-login (recover from mid-run session eviction) ─────────────
// All workers in a pool share ONE MdClient. When the session is evicted we
// re-login once and mutate that shared client in place, so every worker picks
// up the fresh cookies on its next call. Concurrent callers coalesce onto a
// single in-flight login (no thundering herd), and we cap total re-logins so a
// genuine credential problem or a session "war" with another process can't
// loop forever.
interface MdCreds { wsId: string; username: string; password: string }

let reloginPromise: Promise<boolean> | null = null
let reloginCount = 0
const MAX_RELOGINS = 4

async function reloginShared(browser: any, client: MdClient, creds: MdCreds): Promise<boolean> {
  if (!reloginPromise) {
    if (reloginCount >= MAX_RELOGINS) {
      log(`  Re-login cap (${MAX_RELOGINS}) reached — giving up on session recovery`)
      return false
    }
    reloginCount++
    const attempt = reloginCount
    reloginPromise = (async () => {
      // Back off (growing with each attempt) before re-logging in so we don't
      // immediately collide again with whatever just evicted us.
      await new Promise(r => setTimeout(r, 1500 * attempt))
      log(`  Session evicted — re-logging in to MD (attempt ${attempt}/${MAX_RELOGINS})…`)
      const { client: fresh } = await loginToMechanicDesk(browser, creds.wsId, creds.username, creds.password)
      client.cookieHeader = fresh.cookieHeader
      client.csrfToken = fresh.csrfToken
      log('  Re-login OK — resuming')
      return true
    })()
    // Release the slot once settled so a later genuine eviction can re-login again.
    reloginPromise.catch(() => false).finally(() => { reloginPromise = null })
  }
  try {
    return await reloginPromise
  } catch (e: any) {
    log(`  Re-login failed: ${e?.message || e}`)
    return false
  }
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
  const baseEntry: Pick<MatchResultEntry, 'row_number' | 'sku' | 'qty' | 'sheet_name' | 'sheet_bin' | 'sheet_location'> = {
    row_number: row.row_number,
    sku: row.sku,
    qty: row.qty,
    sheet_name: row.sheet_name,
    sheet_bin: row.bin,
    sheet_location: row.location,
  }

  try {
    const r = await findStockBySku(client, row.sku)
    if (r.kind === 'matched' && r.stock) {
      const st: any = r.stock
      if (!loggedStockKeys) { loggedStockKeys = true; log(`  match: MD stock fields = ${Object.keys(st).join(', ')} (quantity=${st.quantity}, available=${st.available}, allocated=${st.allocated_quantity})`) }
      // System QTY = TOTAL on hand, not "available" (= total − allocated).
      const total = typeof st.quantity === 'number' ? st.quantity
        : (typeof st.available === 'number' && typeof st.allocated_quantity === 'number') ? st.available + st.allocated_quantity
        : (typeof st.available === 'number' ? st.available : undefined)
      return {
        entry: {
          ...baseEntry,
          status: 'matched',
          md_stock_id: r.stock.id,
          md_stock_name: r.stock.name || '',
          md_stock_number: r.stock.stock_number || '',
          md_current_qty: total,
          md_bin: r.stock.bin || undefined,
          md_location: r.stock.location || undefined,
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
async function runMatch(client: MdClient, parsedRows: ParsedRow[]): Promise<MatchResultEntry[]> {
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

  // Stay in 'matching' until the post-pass sets total System Qty + coverage,
  // so the UI doesn't briefly show the search "available" value. main() flips
  // status to 'matched' after the post-pass.
  await patchUpload({
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

  return results
}

// ── Coverage mode (folded into match) ─────────────────────────────────
// Compare the counted sheet against MD's full in-stock universe (the Stock
// Value report) so nothing in the system is missed. Non-fatal: a failure here
// must never fail the match itself.

const normSku = (s: string | undefined | null) => String(s || '').trim().toUpperCase()

// Overwrite matched rows' md_current_qty with the TOTAL on-hand qty from the
// Stock Value list (MD's search endpoint only returns "available" = total −
// allocated). Returns how many rows were updated.
function applyTotalQty(results: MatchResultEntry[], universe: InStockItem[]): number {
  const qtyByNum = new Map<string, number>()
  for (const u of universe) { if (u.stock_number) qtyByNum.set(normSku(u.stock_number), u.available) }
  let n = 0
  for (const r of results) {
    if (r.status !== 'matched') continue
    const q = qtyByNum.get(normSku(r.md_stock_number || r.sku))
    if (q != null) { r.md_current_qty = q; n++ }
  }
  return n
}

// Pull MD's in-stock universe and store the items NOT in `counted`. `source`
// records what the count was compared against (uploaded sheet vs live MD
// stocktake) so the UI can show it. Pass `preUniverse` to reuse one pull.
async function storeCoverage(client: MdClient, counted: Set<string>, source: string, preUniverse?: InStockItem[], sampleStock?: any): Promise<void> {
  let universe = preUniverse
  if (!universe) { log('Coverage: pulling MD in-stock universe (Stock Value)…'); universe = await fetchInStockUniverse(client, { log }) }
  log(`Coverage: ${universe.length} in-stock items in MD; ${counted.size} counted`)
  if (universe.length === 0) {
    log('Coverage: empty universe — skipping (check /stocks.json shape in logs above)')
    return
  }
  const uncounted = universe.filter(s => !counted.has(normSku(s.stock_number)))
  uncounted.sort((a, b) => (b.value || 0) - (a.value || 0))   // biggest $ exposure first
  const uncountedValue = Math.round(uncounted.reduce((sum, s) => sum + (s.value || 0), 0) * 100) / 100
  const CAP = 5000
  const stored = uncounted.slice(0, CAP)

  await patchUpload({
    coverage_at: new Date().toISOString(),
    in_stock_total: universe.length,
    in_stock_uncounted: uncounted.length,
    coverage: {
      total: universe.length,
      counted: universe.length - uncounted.length,
      uncounted_count: uncounted.length,
      uncounted_value: uncountedValue,
      uncounted: stored,
      truncated: uncounted.length > CAP,
      source,
      // Diagnostic: one raw MD stock object so we can confirm the qty field names.
      sample_stock: sampleStock || null,
    },
  })
  log(`Coverage: ${uncounted.length}/${universe.length} in-stock items NOT counted ($${uncountedValue} at buy price)`)
  await notifySlack(`Coverage (vs ${source}): ${uncounted.length} of ${universe.length} in-stock items NOT counted ($${uncountedValue} at buy price)`, false)
}

// After a match: pull the Stock Value list once, set TOTAL system qty on the
// matched rows from it, then run coverage off the same pull.
async function runMatchPostPass(client: MdClient, results: MatchResultEntry[]): Promise<void> {
  log('Match: pulling MD Stock Value to set total system qty…')
  let sample: any = null
  const universe = await fetchInStockUniverse(client, { log, onSample: (r) => { sample = r } })
  const n = applyTotalQty(results, universe)
  if (n > 0) { await patchUpload({ match_results: results }); log(`Match: set total system qty on ${n} matched rows from Stock Value`) }
  const counted = new Set<string>()
  for (const r of results) { if (r.md_stock_number) counted.add(normSku(r.md_stock_number)); if (r.sku) counted.add(normSku(r.sku)) }
  await storeCoverage(client, counted, 'uploaded sheet', universe, sample)
}

// Re-check: read what's actually in the MD stocktake now and pull the changes
// back. Used after pushing, after editing counts in MD, or after staff count
// directly in MD. Two things happen off one read:
//   1. Counted qty (+ the system-qty snapshot) on each matched row is synced to
//      whatever the MD stocktake entry currently says, so Count/Variance match
//      MD. Items counted in MD that we don't have are appended.
//   2. Coverage is recomputed against the live Stock Value report (as before).
async function runRecheck(client: MdClient, stocktakeId: string, results: MatchResultEntry[]): Promise<void> {
  log(`Recheck: reading MD stocktake ${stocktakeId}…`)
  const st = await fetchStocktakeWithSheet(client, Number(stocktakeId))

  // What MD currently has counted, keyed by SKU. Counts are summed if a SKU
  // somehow appears on more than one sheet (it's one physical item).
  const mdBySku = new Map<string, { count: number; systemQty?: number; stockId?: number; name?: string; stockNumber: string }>()
  const counted = new Set<string>()
  let rows = 0
  for (const sheet of st.stocktake_sheets || []) {
    if (!sheet || sheet.deleted) continue
    for (const it of (sheet.stocktake_items || [])) {
      const stockNumber = String((it.stock && it.stock.stock_number) || it.stock_number || '').trim()
      if (!stockNumber) continue
      const key = normSku(stockNumber)
      counted.add(key); rows++
      const count = typeof it.count === 'number' ? it.count : 0
      const systemQty = typeof it.quantity === 'number' ? it.quantity
        : (it.stock && typeof it.stock.quantity === 'number' ? it.stock.quantity : undefined)
      const prev = mdBySku.get(key)
      if (prev) { prev.count += count }
      else mdBySku.set(key, { count, systemQty, stockId: it.stock?.id, name: it.stock?.name, stockNumber })
    }
  }
  log(`Recheck: MD stocktake has ${counted.size} distinct counted items (${rows} rows)`)

  // 1) Sync counts onto existing matched rows; append rows MD has that we don't.
  let updated = 0, changed = 0, added = 0
  const present = new Set<string>()
  for (const r of results) {
    const key = normSku(r.md_stock_number || r.sku)
    const md = mdBySku.get(key)
    if (!md) continue
    present.add(key)
    if (r.qty !== md.count) changed++
    r.qty = md.count
    if (typeof md.systemQty === 'number') r.md_current_qty = md.systemQty
    r.count_source = 'md_stocktake'
    updated++
  }
  let nextRow = results.reduce((m, r) => Math.max(m, r.row_number || 0), 0)
  for (const [key, md] of mdBySku) {
    if (present.has(key)) continue
    results.push({
      row_number: ++nextRow,
      sku: md.stockNumber,
      qty: md.count,
      sheet_name: 'MD stocktake',
      status: 'matched',
      md_stock_id: md.stockId,
      md_stock_name: md.name || '',
      md_stock_number: md.stockNumber,
      md_current_qty: md.systemQty,
      count_source: 'md_stocktake',
      added_from_md: true,
    })
    added++
  }
  const matchedCount = results.filter(r => r.status === 'matched').length
  await patchUpload({ match_results: results, matched_count: matchedCount, matched_at: new Date().toISOString() })
  log(`Recheck: counts synced — ${updated} matched rows updated (${changed} changed), ${added} added from MD`)

  // 2) Coverage off the live Stock Value report.
  await storeCoverage(client, counted, 'MD stocktake')
  await notifySlack(`Recheck: synced counts from MD stocktake — ${updated} updated (${changed} changed), ${added} new · then coverage`, false)
}

// Refresh: pulls MD Stock Value (the source of truth for "what's tracked") and
//   1. updates md_current_qty on every matched row that IS in the report, then
//   2. drops every matched row that is NOT in the report.
//
// Why drop them all? The Stock Value report is MD's "in-stock universe": it
// excludes non-stock items, deleted items, and zero-on-hand items by design.
// If a SKU isn't there any more, it's not part of the active stock the user
// is taking — keeping it just clutters the match list with stale rows from
// the original upload. (We previously kept zero-tracked items in via a
// per-item search; users found that confusing.)
//
// Safety: if Stock Value comes back implausibly small (<10% of matched rows
// would survive), we bail out without removing anything — covers the case
// where the report endpoint glitched and returned a partial list.
async function runRefresh(client: MdClient, results: MatchResultEntry[]): Promise<void> {
  log('Refresh: pulling MD Stock Value for current total system qty…')
  const universe = await fetchInStockUniverse(client, { log })
  const updated = applyTotalQty(results, universe)
  const universeBySku = new Set<string>()
  for (const u of universe) if (u.stock_number) universeBySku.add(normSku(u.stock_number))

  const matchedRows = results.filter(r => r.status === 'matched')
  const survivors = matchedRows.filter(r => universeBySku.has(normSku(r.md_stock_number || r.sku)))
  const orphans = matchedRows.length - survivors.length

  // Safety guard — refuse to drop everything if Stock Value looks broken.
  if (matchedRows.length >= 50 && survivors.length < matchedRows.length * 0.1) {
    log(`  ⚠ Refusing to drop ${orphans} rows — only ${survivors.length}/${matchedRows.length} matched rows survived (Stock Value may have glitched). Updated qty only.`)
    await patchUpload({ match_results: results, matched_at: new Date().toISOString() })
    await notifySlack(`Refresh: ${updated} updated · skipped removing ${orphans} orphans (Stock Value looked anomalous)`, false)
    return
  }

  const orphanSet = new Set<number>()
  for (const r of matchedRows) {
    if (!universeBySku.has(normSku(r.md_stock_number || r.sku))) orphanSet.add(r.row_number)
  }
  const kept = results.filter(r => !orphanSet.has(r.row_number))

  await patchUpload({ match_results: kept, matched_at: new Date().toISOString() })

  log(`Refresh: qty updated on ${updated} from Stock Value; removed ${orphans} matched rows no longer in Stock Value`)
  await notifySlack(
    `Refresh: ${updated} qty updated · removed ${orphans} rows no longer in Stock Value`,
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
 * Push a single matched row to MD. Recovers from two failure classes before
 * marking the row an error:
 *   • Session eviction (401 "Please login" / "different computer") — triggers a
 *     shared re-login, then retries with the fresh session. This is the common
 *     cause of bulk push errors: another MD login kills our session mid-run and
 *     without recovery EVERY remaining row 401s on the dead cookie.
 *   • Transient failure (429/5xx/network) — waits 1s and retries.
 * Returns success/failure plus whether a throttle signal was seen (so the pool
 * can halve concurrency).
 */
async function pushSingleRow(
  client: MdClient,
  sheetId: number,
  row: MatchResultEntry,
  relogin: () => Promise<boolean>,
): Promise<PushAttemptResult> {
  let throttled = false
  const MAX_ATTEMPTS = 4

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
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

      if (attempt < MAX_ATTEMPTS) {
        if (isAuthError(msg)) {
          // Session was evicted — re-establish it (shared across the pool) and
          // retry the same row immediately on the fresh session.
          const recovered = await relogin()
          if (recovered) continue
          return { ok: false, throttled, error: msg }
        }
        if (isTransientError(msg)) {
          log(`  Retry SKU "${row.sku}" after transient error: ${msg.slice(0, 120)}`)
          await new Promise(r => setTimeout(r, 1000))
          continue
        }
      }

      return { ok: false, throttled, error: msg }
    }
  }

  return { ok: false, throttled, error: 'Exhausted retry attempts' }
}

interface RunPushOpts {
  relogin: () => Promise<boolean>
  // Errors-only retry: push only the rows that failed last time, onto the SAME
  // MD sheet, without re-adding the rows that already landed (which would
  // duplicate them in MD).
  errorsOnly?: boolean
  errorRowNumbers?: Set<number>
  priorPushed?: number
  forcedSheet?: { stocktakeId: number; sheetId: number } | null
}

async function runPush(client: MdClient, matchResults: MatchResultEntry[], opts: RunPushOpts): Promise<void> {
  let matched = matchResults.filter(r => r.status === 'matched' && r.md_stock_id != null)
  if (opts.errorsOnly && opts.errorRowNumbers) {
    matched = matched.filter(r => opts.errorRowNumbers!.has(r.row_number))
  }
  if (matched.length === 0) throw new Error(opts.errorsOnly ? 'No failed rows to retry' : 'No matched items to push')

  const baselinePushed = opts.errorsOnly ? (opts.priorPushed || 0) : 0

  const concurrencyEnv = parseInt(process.env.STOCKTAKE_PUSH_CONCURRENCY || '', 10)
  const initialConcurrency = Number.isFinite(concurrencyEnv) && concurrencyEnv >= 1
    ? Math.min(concurrencyEnv, 8)
    : 3

  log(`Push starting: ${matched.length} items to add${opts.errorsOnly ? ' (errors-only retry)' : ''} · concurrency=${initialConcurrency}`)

  // Diagnostic: how many rows have a known system QTY snapshot?
  const withQty = matched.filter(r => typeof r.md_current_qty === 'number').length
  if (withQty < matched.length) {
    log(`  Note: ${matched.length - withQty}/${matched.length} matched rows have no md_current_qty — those will go in with QTY=0 (variance will appear large in MD)`)
  }

  let stocktakeId: number, sheetId: number, wasCreated: boolean
  if (opts.forcedSheet) {
    ({ stocktakeId, sheetId } = opts.forcedSheet)
    wasCreated = false
    log(`Errors-only retry: reusing stored sheet ${sheetId} on stocktake ${stocktakeId} (no new stocktake created)`)
  } else {
    ({ stocktakeId, sheetId, wasCreated } = await resolveTargetSheet(client))
    log(`Target: stocktake_id=${stocktakeId}, sheet_id=${sheetId}, created_new=${wasCreated}`)
  }

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
      const { ok, throttled, error } = await pushSingleRow(client, sheetId, row, opts.relogin)
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
        await patchUpload({ pushed_count: baselinePushed + pushed }).catch(() => undefined)
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

  const totalPushed = baselinePushed + pushed
  log(`Push complete in ${elapsedSec}s: ${pushed} added${opts.errorsOnly ? ` (cumulative ${totalPushed})` : ''}, ${errors.length} errors (throttle events: ${throttleEvents})`)

  await patchUpload({
    // On an errors-only retry the prior run already pushed rows, so the upload
    // is never "failed" overall — at worst some retried rows still error.
    status: (!opts.errorsOnly && errors.length === matched.length) ? 'failed' : 'completed',
    pushed_count: totalPushed,
    push_completed_at: new Date().toISOString(),
    push_errors: errors.length > 0 ? errors : null,
    github_run_id: process.env.GITHUB_RUN_ID || null,
  })

  await notifySlack(
    `Push complete in ${elapsedSec}s: ${pushed}/${matched.length} items added` +
    (opts.errorsOnly ? ` (errors-only retry · ${totalPushed} pushed in total)` : '') +
    (errors.length > 0 ? ` · ${errors.length} errors` : '') +
    (opts.forcedSheet ? ` · reused stocktake ${stocktakeId}` : wasCreated ? ` · created new stocktake ${stocktakeId}` : ` · used existing stocktake ${stocktakeId}`) +
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
    const creds: MdCreds = { wsId, username, password }
    const { client } = await loginToMechanicDesk(browser, wsId, username, password)
    log(`Login OK · ${client.cookieHeader.split(';').length} cookies, csrf=${client.csrfToken ? 'yes' : 'no'}`)

    // Bound recovery handler: re-establishes this shared client's session if MD
    // evicts it mid-run (single-session-per-employee collision).
    const relogin = () => reloginShared(browser, client, creds)

    if (MODE === 'match') {
      const rows = (upload.parsed_rows || []) as ParsedRow[]
      if (rows.length === 0) throw new Error('No parsed_rows in upload')
      const results = await runMatch(client, rows)
      // Set total system qty + coverage off one Stock Value pull. Best-effort —
      // never let it fail the match it rides on.
      try {
        await runMatchPostPass(client, results)
      } catch (e: any) {
        log(`Match post-pass (qty + coverage) failed (non-fatal): ${e?.message || e}`)
        await notifySlack(`Match qty/coverage step failed (match still OK): ${e?.message || e}`, false).catch(() => undefined)
      }
      // Finalise only now — after System Qty is set — so the UI never shows the
      // intermediate "available" value.
      await patchUpload({ status: 'matched' })
    } else if (MODE === 'push') {
      const results = (upload.match_results || []) as MatchResultEntry[]
      if (results.length === 0) throw new Error('No match_results in upload')
      const errorsOnly = ['1', 'true'].includes((process.env.ERRORS_ONLY || '').toLowerCase())
      if (errorsOnly) {
        const priorErrors = Array.isArray(upload.push_errors) ? upload.push_errors : []
        if (priorErrors.length === 0) throw new Error('Errors-only retry requested but the upload has no recorded push errors')
        const errorRowNumbers = new Set<number>(priorErrors.map((e: any) => Number(e.row_number)).filter((n: number) => isFinite(n)))
        const forcedSheet = upload.mechanicdesk_stocktake_id && upload.mechanicdesk_sheet_id
          ? { stocktakeId: Number(upload.mechanicdesk_stocktake_id), sheetId: Number(upload.mechanicdesk_sheet_id) }
          : null
        log(`Errors-only retry: ${errorRowNumbers.size} failed row(s)${forcedSheet ? `, reusing sheet ${forcedSheet.sheetId}` : ', resolving a target sheet'}`)
        await runPush(client, results, {
          relogin,
          errorsOnly: true,
          errorRowNumbers,
          priorPushed: Number(upload.pushed_count) || 0,
          forcedSheet,
        })
      } else {
        await runPush(client, results, { relogin })
      }
    } else if (MODE === 'recheck') {
      if (!upload.mechanicdesk_stocktake_id) throw new Error('No MechanicDesk stocktake id on this upload — push to MD first.')
      const results = (upload.match_results || []) as MatchResultEntry[]
      await runRecheck(client, String(upload.mechanicdesk_stocktake_id), results)
    } else if (MODE === 'refresh') {
      const results = (upload.match_results || []) as MatchResultEntry[]
      if (results.length === 0) throw new Error('No match_results to refresh')
      await runRefresh(client, results)
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
