// scripts/run-mechanicdesk-stocktake.ts
//
// GitHub Actions worker for stocktake operations. Triggered via
// repository_dispatch with client_payload:
//   {
//     upload_id: "<uuid>",
//     mode: "match" | "push"
//   }
//
// Match mode:
//   1. Login to MD
//   2. Read parsed_rows from the upload
//   3. For each row, call /auto_workshop/resource_search
//   4. Find exact SKU match → record match_results entry
//   5. PATCH the upload with match_results, matched_count, unmatched_count
//   6. Set status='matched' or 'failed'
//
// Push mode:
//   1. Login to MD
//   2. Find an open in-progress stocktake (or create a new one)
//   3. For each matched row in match_results, POST /stocktake_sheets/{id}/new_item
//   4. Update upload with pushed_count, push_completed_at, status='completed'
//   5. NEVER finishes/submits the stocktake — that's manual

import { chromium } from 'playwright'
import {
  loginToMechanicDesk,
  findStockBySku,
  findOpenStocktake,
  createStocktake,
  addItemToSheet,
  type MdClient,
} from '../lib/mechanicdesk-stocktake'

interface ParsedRow {
  row_number: number
  sku: string
  qty: number
  raw_name?: string
}

interface MatchResultEntry {
  row_number: number
  sku: string
  qty: number
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

  // Process sequentially with small delay — MD's API is unauthenticated-rate-
  // limited and we don't want to hammer it
  for (let i = 0; i < parsedRows.length; i++) {
    const row = parsedRows[i]
    if (i > 0 && i % 10 === 0) log(`  ${i}/${parsedRows.length} processed (matched=${matched}, unmatched=${unmatched})`)

    try {
      const r = await findStockBySku(client, row.sku)
      if (r.kind === 'matched' && r.stock) {
        results.push({
          row_number: row.row_number,
          sku: row.sku,
          qty: row.qty,
          status: 'matched',
          md_stock_id: r.stock.id,
          md_stock_name: r.stock.name || '',
          md_stock_number: r.stock.stock_number || '',
          md_current_qty: typeof r.stock.available === 'number' ? r.stock.available : undefined,
        })
        matched++
      } else if (r.kind === 'ambiguous' && r.candidates) {
        results.push({
          row_number: row.row_number,
          sku: row.sku,
          qty: row.qty,
          status: 'ambiguous',
          candidates: r.candidates.map(c => ({
            id: c.id,
            stock_number: c.stock_number || '',
            name: c.name || '',
          })),
        })
        unmatched++
      } else {
        results.push({
          row_number: row.row_number,
          sku: row.sku,
          qty: row.qty,
          status: 'not_found',
        })
        unmatched++
      }
    } catch (e: any) {
      log(`  Error matching SKU "${row.sku}": ${e?.message}`)
      results.push({
        row_number: row.row_number,
        sku: row.sku,
        qty: row.qty,
        status: 'error',
        error: e?.message || String(e),
      })
      unmatched++
    }

    // Tiny delay between requests
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
}

// ── Push mode ─────────────────────────────────────────────────────────

async function runPush(client: MdClient, matchResults: MatchResultEntry[]): Promise<void> {
  const matched = matchResults.filter(r => r.status === 'matched' && r.md_stock_id != null)
  if (matched.length === 0) throw new Error('No matched items to push')
  log(`Push starting: ${matched.length} items to add`)

  // Step 1: find or create the target stocktake
  let stocktakeId: number
  let sheetId: number
  let wasCreated = false

  log('Looking for an open in-progress stocktake…')
  const openST = await findOpenStocktake(client)
  if (openST) {
    log(`Using existing stocktake ${openST.id} ("${openST.name}")`)
    stocktakeId = openST.id
    const sheet = openST.stocktake_sheets.find(s => s.status === 'in progress' && !s.deleted)
    if (!sheet) throw new Error(`Stocktake ${stocktakeId} has no in-progress sheet`)
    sheetId = sheet.id
  } else {
    const name = `JA Portal Upload ${new Date().toISOString().slice(0, 10)}`
    log(`No open stocktake — creating new "${name}"`)
    const created = await createStocktake(client, name)
    stocktakeId = created.id
    const sheet = created.stocktake_sheets[0]
    if (!sheet) throw new Error('Newly-created stocktake has no sheet')
    sheetId = sheet.id
    wasCreated = true
  }
  log(`Target: stocktake_id=${stocktakeId}, sheet_id=${sheetId}, created_new=${wasCreated}`)

  await patchUpload({
    mechanicdesk_stocktake_id: String(stocktakeId),
    mechanicdesk_sheet_id: String(sheetId),
    mechanicdesk_stocktake_was_created: wasCreated,
  })

  // Step 2: add each item
  let pushed = 0
  const errors: any[] = []

  for (let i = 0; i < matched.length; i++) {
    const row = matched[i]
    if (i > 0 && i % 10 === 0) {
      log(`  ${i}/${matched.length} pushed (errors=${errors.length})`)
      // Periodically update the count so the user sees live progress
      await patchUpload({ pushed_count: pushed }).catch(() => undefined)
    }

    try {
      await addItemToSheet(client, sheetId, {
        stockId: row.md_stock_id!,
        stockNumber: row.md_stock_number || row.sku,
        stockName: row.md_stock_name || '',
        count: row.qty,
      })
      pushed++
    } catch (e: any) {
      log(`  ERROR adding SKU "${row.sku}" (stock_id=${row.md_stock_id}): ${e?.message}`)
      errors.push({
        row_number: row.row_number,
        sku: row.sku,
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
    `${MODE === 'match' ? 'Match' : 'Push'} complete: ${pushed}/${matched.length} items added` +
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

    // Mark as failed so the UI doesn't poll forever
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
