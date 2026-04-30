// scripts/run-mechanicdesk-stocktake.ts
//
// GitHub Actions worker for stocktake operations. Triggered via
// repository_dispatch with client_payload:
//   { upload_id: "<uuid>", mode: "match" | "push" }
//
// Match mode:
//   1. Login to MD
//   2. For each parsed_rows entry, search MD via resource_search
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

// ── Match mode ────────────────────────────────────────────────────────

async function runMatch(client: MdClient, parsedRows: ParsedRow[]): Promise<void> {
  log(`Running match for ${parsedRows.length} rows`)
  const results: MatchResultEntry[] = []
  let matched = 0
  let unmatched = 0

  for (let i = 0; i < parsedRows.length; i++) {
    const row = parsedRows[i]
    if (i > 0 && i % 10 === 0) log(`  ${i}/${parsedRows.length} processed (matched=${matched}, unmatched=${unmatched})`)

    // Common fields carried through from the parsed row, including sheet_name
    // so we can show "Sheet: Exhausts · Row 5" in the UI later
    const baseEntry: Pick<MatchResultEntry, 'row_number' | 'sku' | 'qty' | 'sheet_name'> = {
      row_number: row.row_number,
      sku: row.sku,
      qty: row.qty,
      sheet_name: row.sheet_name,
    }

    try {
      const r = await findStockBySku(client, row.sku)
      if (r.kind === 'matched' && r.stock) {
        results.push({
          ...baseEntry,
          status: 'matched',
          md_stock_id: r.stock.id,
          md_stock_name: r.stock.name || '',
          md_stock_number: r.stock.stock_number || '',
          md_current_qty: typeof r.stock.available === 'number' ? r.stock.available : undefined,
        })
        matched++
      } else if (r.kind === 'ambiguous' && r.candidates) {
        results.push({
          ...baseEntry,
          status: 'ambiguous',
          candidates: r.candidates.map(c => ({
            id: c.id,
            stock_number: c.stock_number || '',
            name: c.name || '',
          })),
        })
        unmatched++
      } else {
        results.push({ ...baseEntry, status: 'not_found' })
        unmatched++
      }
    } catch (e: any) {
      log(`  Error matching SKU "${row.sku}": ${e?.message}`)
      results.push({
        ...baseEntry,
        status: 'error',
        error: e?.message || String(e),
      })
      unmatched++
    }

    await new Promise(r => setTimeout(r, 100))
  }

  log(`Match complete: ${matched} matched, ${unmatched} unmatched`)

  await patchUpload({
    status: 'matched',
    matched_at: new Date().toISOString(),
    matched_count: matched,
    unmatched_count: unmatched,
    match_results: results,
    github_run_id: process.env.GITHUB_RUN_ID || null,
  })

  await notifySlack(
    `Match complete: ${matched} matched, ${unmatched} unmatched (out of ${parsedRows.length} rows)`,
    false,
  )
}

// ── Push mode ─────────────────────────────────────────────────────────

/**
 * Pick the best sheet from a stocktake's sheet list. Preference order:
 *   1. Sheet with status === 'in progress' AND not deleted
 *   2. Any sheet that's not finished AND not deleted
 *   3. Any sheet that's not deleted
 * Returns null if no usable sheet exists.
 *
 * Tolerant of stocktake_sheets being undefined / null (which the listing
 * endpoint sometimes returns) — in that case returns null and the caller
 * should re-fetch with retry.
 */
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

/**
 * Re-fetch a stocktake by ID with retries, looking for at least one
 * non-deleted sheet. The GET /stocktakes listing endpoint returns
 * stocktakes without their sheets populated, AND the POST /stocktakes
 * response sometimes returns the new stocktake with empty
 * stocktake_sheets even though Sheet 1 was created server-side.
 */
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
  // Return whatever we got last so the caller can produce a useful error message
  if (last) return last
  throw new Error(`Failed to fetch stocktake ${stocktakeId} after ${attempts} attempts`)
}

/**
 * Resolve the target sheet to write items to. Either uses an existing
 * in-progress stocktake or creates a new one. ALWAYS re-fetches by ID
 * before reading stocktake_sheets — the listing endpoint omits them.
 */
async function resolveTargetSheet(client: MdClient): Promise<{
  stocktakeId: number
  sheetId: number
  wasCreated: boolean
}> {
  log('Looking for an open in-progress stocktake…')
  const openSummary = await findOpenStocktake(client)

  if (openSummary) {
    log(`Found existing stocktake ${openSummary.id} ("${openSummary.name}") in listing — re-fetching for sheets`)
    // Listing endpoint returns the stocktake without stocktake_sheets populated,
    // so we must always re-fetch. Use the same retry helper as the create path.
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

  // Create a new stocktake
  const name = `JA Portal Upload ${new Date().toISOString().slice(0, 10)}`
  log(`No open stocktake — creating new "${name}"`)
  const created = await createStocktake(client, name)
  const initialSheetCount = Array.isArray(created.stocktake_sheets) ? created.stocktake_sheets.length : 'undefined'
  log(`  Created stocktake ${created.id} (sheets in POST response: ${initialSheetCount})`)

  // Persist immediately so we can recover if downstream fails
  await patchUpload({
    mechanicdesk_stocktake_id: String(created.id),
    mechanicdesk_stocktake_was_created: true,
  }).catch(e => log(`  Warn: could not persist stocktake_id early: ${e?.message}`))

  // Re-fetch with retry until the auto-created sheet appears
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

async function runPush(client: MdClient, matchResults: MatchResultEntry[]): Promise<void> {
  const matched = matchResults.filter(r => r.status === 'matched' && r.md_stock_id != null)
  if (matched.length === 0) throw new Error('No matched items to push')
  log(`Push starting: ${matched.length} items to add`)

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

  let pushed = 0
  const errors: any[] = []

  for (let i = 0; i < matched.length; i++) {
    const row = matched[i]
    if (i > 0 && i % 10 === 0) {
      log(`  ${i}/${matched.length} pushed (errors=${errors.length})`)
      await patchUpload({ pushed_count: pushed }).catch(() => undefined)
    }

    try {
      await addItemToSheet(client, sheetId, {
        stockId: row.md_stock_id!,
        stockNumber: row.md_stock_number || row.sku,
        stockName: row.md_stock_name || '',
        count: row.qty,
        currentQty: row.md_current_qty,
      })
      pushed++
    } catch (e: any) {
      log(`  ERROR adding SKU "${row.sku}" (stock_id=${row.md_stock_id}): ${e?.message}`)
      errors.push({
        row_number: row.row_number,
        sku: row.sku,
        sheet_name: row.sheet_name,
        md_stock_id: row.md_stock_id,
        error: e?.message || String(e),
      })
    }

    await new Promise(r => setTimeout(r, 150))
  }

  log(`Push complete: ${pushed} added, ${errors.length} errors`)

  await patchUpload({
    status: errors.length === matched.length ? 'failed' : 'completed',
    pushed_count: pushed,
    push_completed_at: new Date().toISOString(),
    push_errors: errors.length > 0 ? errors : null,
    github_run_id: process.env.GITHUB_RUN_ID || null,
  })

  await notifySlack(
    `Push complete: ${pushed}/${matched.length} items added` +
    (errors.length > 0 ? ` · ${errors.length} errors` : '') +
    (wasCreated ? ` · created new stocktake ${stocktakeId}` : ` · used existing stocktake ${stocktakeId}`),
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
