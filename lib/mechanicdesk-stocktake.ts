// lib/mechanicdesk-stocktake.ts
//
// MechanicsDesk stocktake API client. Used by the GH Actions worker
// (scripts/run-mechanicdesk-stocktake.ts) — never called from Vercel
// serverless functions.
//
// IMPORTANT: We deliberately avoid statically importing 'playwright' so
// that `next build` doesn't try to type-check or bundle it. Playwright
// is only available inside the GH Action, where it's installed at run
// time via `npm install --no-save playwright`.
//
// Endpoints discovered via reconnaissance:
//   GET    /auto_workshop/resource_search?query=X
//   GET    /stocktakes
//   GET    /stocktakes/{id}
//   POST   /stocktakes                                    (create new)
//   POST   /stocktake_sheets/{sheet_id}/new_item          (add item ⭐)

const MD_BASE = 'https://www.mechanicdesk.com.au'
const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

// ── Types ───────────────────────────────────────────────────────────────

export interface MdStock {
  id: number
  stock_number: string | null
  name: string | null
  quantity?: number            // total on-hand (the stocktake "system QTY")
  available?: number           // total − allocated/reserved
  allocated_quantity?: number
  buy_price?: number
  sell_price_excluded_gst?: number
  sell_price_included_gst?: number
  price?: number
  average_buy_price?: number
  location?: string | null
  bin?: string | null
  // Free-form passthrough so callers can sniff for fields like
  // non_stock / is_non_stock / track_inventory that aren't documented but
  // come back from MD's API. See detectNonStock() in the stocktake worker.
  [key: string]: any
}

export interface MdResourceSearchResponse {
  customers: any[]
  stocks: MdStock[]
  suppliers: any[]
  invoices: any[]
  jobs: any[]
  vehicles: any[]
  bills: any[]
  quotes: any[]
  purchases: any[]
  credit_notes: any[]
  supplier_credit_notes: any[]
}

export interface MdStocktakeSheet {
  id: number
  name: string
  finished: boolean
  deleted: boolean
  status: string
  stocktake_items: MdStocktakeItem[]
  notes: any[]
}

export interface MdStocktakeItem {
  id: number
  count: number
  quantity: number
  total_value: number
  difference_amount: number
  counted: boolean
  stock?: {
    id: number
    stock_number: string
    name: string
    quantity: number
  } | null
  stock_number?: string
}

export interface MdStocktake {
  id: number
  name: string
  time: string
  status: string
  finished: boolean
  deleted: boolean
  remaining_stocks_decision: string
  uncounted_stocks_decision: string
  stocktake_sheets: MdStocktakeSheet[]
  notes: any[]
}

export interface MdClient {
  cookieHeader: string
  csrfToken?: string
}

// ── Login (via dynamically-imported Playwright) ─────────────────────────

export interface MdLoginResult {
  client: MdClient
  cookies: { name: string; value: string }[]
}

/**
 * Log into MD using Playwright (a real browser is needed to handle the
 * login form's CSRF token + redirects). Returns a client with cookies
 * baked in for subsequent fetch() calls.
 *
 * Caller passes in an already-launched Playwright Browser instance. We
 * type it as `any` because we don't want to import playwright statically
 * (it's not in the main app's dependencies — only installed at runtime
 * inside the GH Actions worker).
 */
export async function loginToMechanicDesk(
  browser: any,
  workshopId: string,
  username: string,
  password: string,
): Promise<MdLoginResult> {
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    viewport: { width: 1280, height: 900 },
  })
  const page = await context.newPage()

  await page.goto(`${MD_BASE}/auto_workshop/login`, { waitUntil: 'domcontentloaded', timeout: 30000 })

  const workshopInput = await page.$('input[name*="workshop" i], input#workshop_id, input[placeholder*="Workshop" i]')
  if (workshopInput) {
    await workshopInput.fill(workshopId)
  } else {
    const fallback = await page.$('input[type="text"]:not([disabled])')
    if (!fallback) throw new Error('Could not find workshop ID field')
    await fallback.fill(workshopId)
  }

  const usernameInput = await page.$('input[name="username"], input#username, input[name="user[username]"]')
  if (usernameInput) {
    await usernameInput.fill(username)
  } else {
    const all = await page.$$('input[type="text"]:not([disabled])')
    if (all.length < 2) throw new Error('Could not find username field')
    await all[1].fill(username)
  }

  const passwordInput = await page.$('input[type="password"]')
  if (!passwordInput) throw new Error('Could not find password field')
  await passwordInput.fill(password)

  const submit = await page.$('button:has-text("Login"), input[type="submit"], button[type="submit"]')
  if (!submit) throw new Error('Could not find submit button')
  await submit.click()

  await page.waitForSelector('input[type="password"]', { state: 'detached', timeout: 30000 })
  await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => undefined)

  const cookies = await context.cookies(MD_BASE)
  if (cookies.length === 0) throw new Error('No cookies after login — session not established')

  const csrfToken = await page.evaluate(() => {
    const meta = document.querySelector('meta[name="csrf-token"]')
    return meta?.getAttribute('content') || null
  }).catch(() => null)

  await context.close()

  return {
    client: {
      cookieHeader: cookies.map((c: any) => `${c.name}=${c.value}`).join('; '),
      csrfToken: csrfToken || undefined,
    },
    cookies: cookies.map((c: any) => ({ name: c.name, value: c.value })),
  }
}

// ── HTTP helpers ────────────────────────────────────────────────────────

async function mdFetch<T>(
  client: MdClient,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const url = path.startsWith('http') ? path : `${MD_BASE}${path}`
  const headers: Record<string, string> = {
    'Cookie': client.cookieHeader,
    'User-Agent': USER_AGENT,
    'Accept': 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
    ...((init.headers || {}) as Record<string, string>),
  }
  if (init.method && init.method !== 'GET') {
    if (client.csrfToken) headers['X-CSRF-Token'] = client.csrfToken
    // MD's app is Angular-style: it echoes the XSRF-TOKEN cookie as an
    // X-XSRF-TOKEN header on writes. Without this, POST/PUT/DELETE 401 with
    // "Please login" even though the session cookies are valid. (Confirmed
    // via probe — this is what unlocks purchase create/delete.)
    const xsrf = client.cookieHeader.split(';').map(s => s.trim()).find(s => /^XSRF-TOKEN=/i.test(s))
    if (xsrf) headers['X-XSRF-TOKEN'] = decodeURIComponent(xsrf.split('=').slice(1).join('='))
  }
  if (init.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json'
  }

  const r = await fetch(url, { ...init, headers, redirect: 'follow' })
  if (!r.ok) {
    const text = await r.text().catch(() => '')
    throw new Error(`MD ${init.method || 'GET'} ${path} → ${r.status}: ${text.slice(0, 500)}`)
  }
  const ct = r.headers.get('content-type') || ''
  if (ct.includes('text/html')) {
    const text = await r.text()
    throw new Error(`MD ${init.method || 'GET'} ${path} → got HTML (session may have expired): ${text.slice(0, 200)}`)
  }
  return r.json() as Promise<T>
}

// ── API methods ─────────────────────────────────────────────────────────

/** Search for a product by SKU/name. Returns up to ~10 stocks. */
export async function searchProducts(client: MdClient, query: string): Promise<MdStock[]> {
  if (!query || !query.trim()) return []
  const r = await mdFetch<MdResourceSearchResponse>(
    client,
    `/auto_workshop/resource_search?query=${encodeURIComponent(query.trim())}`,
  )
  return r.stocks || []
}

/**
 * Find a stock by exact SKU match. Returns:
 *   { kind: 'matched', stock }   — exactly one match
 *   { kind: 'not_found' }         — no exact match
 *   { kind: 'ambiguous', candidates } — multiple stocks share the SKU
 */
export interface SkuMatchResult {
  kind: 'matched' | 'not_found' | 'ambiguous'
  stock?: MdStock
  candidates?: MdStock[]
}

export async function findStockBySku(client: MdClient, sku: string): Promise<SkuMatchResult> {
  const trimmed = sku.trim()
  if (!trimmed) return { kind: 'not_found' }

  const stocks = await searchProducts(client, trimmed)
  const exactMatches = stocks.filter(s =>
    (s.stock_number || '').trim().toLowerCase() === trimmed.toLowerCase()
  )

  if (exactMatches.length === 0) return { kind: 'not_found' }
  if (exactMatches.length === 1) return { kind: 'matched', stock: exactMatches[0] }
  return { kind: 'ambiguous', candidates: exactMatches }
}

/** List all stocktakes. */
export async function listStocktakes(client: MdClient): Promise<MdStocktake[]> {
  return mdFetch<MdStocktake[]>(client, '/stocktakes')
}

/** Find an open (in-progress, not deleted) stocktake. Returns null if none. */
export async function findOpenStocktake(client: MdClient): Promise<MdStocktake | null> {
  const all = await listStocktakes(client)
  const open = all.filter(s => s.status === 'in progress' && !s.deleted && !s.finished)
  open.sort((a, b) => (b.time || '').localeCompare(a.time || ''))
  return open[0] || null
}

/** Read a single stocktake by ID. */
export async function getStocktake(client: MdClient, id: number | string): Promise<MdStocktake> {
  return mdFetch<MdStocktake>(client, `/stocktakes/${id}`)
}

/** Create a new stocktake. Returns the created stocktake with Sheet 1 initialised. */
export async function createStocktake(
  client: MdClient,
  name: string,
  opts: { remaining_stocks_decision?: 'keep_system_quantity' | 'set_to_zero' } = {},
): Promise<MdStocktake> {
  const body = {
    time: new Date().toISOString(),
    name,
    remaining_stocks_decision: opts.remaining_stocks_decision || 'keep_system_quantity',
  }
  return mdFetch<MdStocktake>(client, '/stocktakes', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

/**
 * Add an item to a stocktake sheet — THE MAGIC POST.
 *
 * Discovered request shape (from recon):
 *   {
 *     "id": 50552,
 *     "item": {
 *       "stock_id": 23213830,
 *       "description": "15472-52010 - Gasket Turbo Oil",
 *       "count": 4,            // ← what was counted (TOTAL COUNT in MD UI)
 *       "counted": true,
 *       "quantity": 12,        // ← system on-hand snapshot (QTY in MD UI)
 *       "allocated_quantity": 0
 *     }
 *   }
 *
 * NOTE on quantity: MD does NOT auto-populate this from the stock record.
 * Whatever we send becomes the "system QTY" snapshot and is what MD uses
 * to compute the variance (count - quantity). We send the value from
 * `findStockBySku` (the `available` field) so variance reports correctly.
 * If we don't have it, we fall back to 0 and MD will treat the count as
 * pure addition (variance = full count).
 */
export interface AddItemInput {
  stockId: number
  stockNumber: string
  stockName: string
  count: number
  /** System on-hand qty at the time of the count, from MD's stock record.
   *  Captured during the match step via findStockBySku → stock.available. */
  currentQty?: number
  /** Allocated/reserved qty. Defaults to 0. We don't currently capture this. */
  allocatedQty?: number
}

export async function addItemToSheet(
  client: MdClient,
  sheetId: number | string,
  item: AddItemInput,
): Promise<MdStocktakeSheet> {
  const description = `${item.stockNumber} - ${item.stockName}`.trim()
  const quantity = typeof item.currentQty === 'number' && isFinite(item.currentQty) ? item.currentQty : 0
  const allocated_quantity = typeof item.allocatedQty === 'number' && isFinite(item.allocatedQty) ? item.allocatedQty : 0
  const body = {
    id: Number(sheetId),
    item: {
      stock_id: item.stockId,
      description,
      count: item.count,
      counted: true,
      quantity,
      allocated_quantity,
    },
  }
  return mdFetch<MdStocktakeSheet>(
    client,
    `/stocktake_sheets/${sheetId}/new_item`,
    { method: 'POST', body: JSON.stringify(body) },
  )
}

// ── In-stock universe (for the stocktake coverage check) ─────────────────

export interface InStockItem {
  stock_id: number
  stock_number: string
  name: string
  available: number     // on-hand qty (> 0)
  buy_price: number
  value: number         // available × buy_price
  bin: string | null
  location: string | null
}

/** Read the first present numeric field from a candidate list (defensive — MD
 *  field names for stock aren't fully documented). Accepts numeric strings. */
function pickNum(obj: any, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = obj?.[k]
    if (typeof v === 'number' && isFinite(v)) return v
    if (typeof v === 'string' && v.trim() !== '' && isFinite(Number(v))) return Number(v)
  }
  return undefined
}

/** First present non-empty string from a candidate list. */
function pickStr(obj: any, keys: string[]): string | null {
  for (const k of keys) {
    const v = obj?.[k]
    if (v != null && String(v).trim() !== '') return String(v).trim()
  }
  return null
}

/**
 * Pull the full in-stock universe from MD — the data behind the Stock Value
 * report — by paging /stocks.json. "In stock" = on-hand qty > 0. Used by the
 * stocktake coverage check to flag items in the system that weren't counted.
 *
 * On-hand qty + buy price are read from a prioritised list of candidate keys
 * (MD's stock JSON shape isn't fully documented); the first page logs the item
 * keys so the true shape is captured in the worker logs.
 */
export async function fetchInStockUniverse(
  client: MdClient,
  opts: { log?: (...a: any[]) => void; maxPages?: number; onSample?: (raw: any) => void } = {},
): Promise<InStockItem[]> {
  const log = opts.log || (() => {})
  const maxPages = opts.maxPages || 500
  const items: InStockItem[] = []

  for (let page = 1; page <= maxPages; page++) {
    let resp: { stocks?: any[]; meta?: any }
    try {
      resp = await mdFetch<{ stocks?: any[]; meta?: any }>(client, `/stocks.json?page=${page}`)
    } catch (e: any) {
      if (page === 1) throw e   // first-page failure is fatal
      log(`  coverage: /stocks.json page ${page} failed (${String(e?.message).slice(0, 120)}) — stopping at ${items.length} kept`)
      break
    }
    const stocks = Array.isArray(resp?.stocks) ? resp.stocks : []
    if (page === 1 && stocks[0]) { log(`  coverage: /stocks.json item keys = ${Object.keys(stocks[0]).join(', ')}`); opts.onSample?.(stocks[0]) }
    if (stocks.length === 0) break

    for (const s of stocks) {
      // Total on-hand qty (NOT "available" = total − allocated). Prefer the
      // total/quantity fields; fall back to available only if that's all MD gives.
      const available = pickNum(s, ['quantity', 'total_quantity', 'total_qty', 'on_hand', 'on_hand_quantity', 'quantity_on_hand', 'stock_on_hand', 'soh', 'current_quantity', 'available', 'qty']) ?? 0
      if (!(available > 0)) continue   // in-stock only
      const buy = pickNum(s, ['average_buy_price', 'buy_price', 'cost_price', 'price']) ?? 0
      items.push({
        stock_id: Number(s.id) || 0,
        stock_number: String(s.stock_number || '').trim(),
        name: String(s.name || '').trim(),
        available,
        buy_price: buy,
        value: Math.round(available * buy * 100) / 100,
        bin: pickStr(s, ['bin', 'bin_location', 'shelf']),
        location: pickStr(s, ['location', 'location_name']),
      })
    }

    const totalPages = pickNum(resp?.meta || {}, ['total_pages', 'last_page', 'pages'])
    if (totalPages && page >= totalPages) break
    log(`  coverage: page ${page} → ${stocks.length} stocks (in-stock kept so far: ${items.length})`)
  }

  return items
}

// ── Full catalogue (parts-bot cache) ───────────────────────────────────────

export interface AllStockItem {
  stock_id: number
  stock_number: string
  name: string
  on_hand: number              // total on-hand (system QTY)
  available: number            // free-to-sell = on-hand − allocated (best available)
  allocated: number            // committed to jobs
  on_order: number | null      // incoming on open POs (only if the list exposes it)
  alert_qty: number | null     // MD reorder-alert threshold (only if exposed)
  buy_price: number | null
  sell_price: number | null
  bin: string | null
  location: string | null
}

/**
 * Pull the ENTIRE MD catalogue by paging /stocks.json — every item, including
 * zero-on-hand ones (so "we have none, call the supplier" is answerable). This
 * differs from fetchInStockUniverse (in-stock-only, drops bin/allocated): the
 * parts-bot cache needs the full list plus allocated / free-to-sell / bin.
 *
 * allocated / alert_qty / on_order come back only if the LIST endpoint exposes
 * them (the per-item detail endpoint always has them, but fetching detail for
 * thousands of rows every 30 min is too heavy). Missing → null / 0.
 */
export async function fetchAllStock(
  client: MdClient,
  opts: { log?: (...a: any[]) => void; maxPages?: number; onSample?: (raw: any) => void } = {},
): Promise<AllStockItem[]> {
  const log = opts.log || (() => {})
  const maxPages = opts.maxPages || 1000
  const items: AllStockItem[] = []

  for (let page = 1; page <= maxPages; page++) {
    let resp: { stocks?: any[]; meta?: any }
    try {
      resp = await mdFetch<{ stocks?: any[]; meta?: any }>(client, `/stocks.json?page=${page}`)
    } catch (e: any) {
      if (page === 1) throw e   // first-page failure is fatal
      log(`  catalogue: /stocks.json page ${page} failed (${String(e?.message).slice(0, 120)}) — stopping at ${items.length}`)
      break
    }
    const stocks = Array.isArray(resp?.stocks) ? resp.stocks : []
    if (page === 1 && stocks[0]) { log(`  catalogue: /stocks.json item keys = ${Object.keys(stocks[0]).join(', ')}`); opts.onSample?.(stocks[0]) }
    if (stocks.length === 0) break

    for (const s of stocks) {
      const stockNumber = String(s.stock_number || '').trim()
      const name = String(s.name || '').trim()
      if (!stockNumber && !name) continue   // skip junk rows with no identity

      const onHand = pickNum(s, ['quantity', 'total_quantity', 'total_qty', 'on_hand', 'on_hand_quantity', 'quantity_on_hand', 'stock_on_hand', 'soh', 'current_quantity', 'qty']) ?? 0
      const allocated = pickNum(s, ['allocated_quantity', 'allocated', 'reserved_quantity', 'reserved']) ?? 0
      // Free-to-sell: prefer MD's own "available" if present, else on-hand − allocated.
      const availField = pickNum(s, ['available_quantity', 'available'])
      const available = availField != null ? availField : Math.max(0, onHand - allocated)

      items.push({
        stock_id: Number(s.id) || 0,
        stock_number: stockNumber,
        name,
        on_hand: onHand,
        available,
        allocated,
        on_order: pickNum(s, ['ordered_quantity', 'on_order', 'on_order_quantity', 'incoming_quantity']) ?? null,
        alert_qty: pickNum(s, ['alert_quantity', 'reorder_point', 'minimum_quantity', 'min_quantity']) ?? null,
        buy_price: pickNum(s, ['average_buy_price', 'buy_price', 'cost_price']) ?? null,
        sell_price: pickNum(s, ['sell_price_included_gst', 'sell_price_excluded_gst', 'price', 'sell_price']) ?? null,
        bin: pickStr(s, ['bin', 'bin_location', 'shelf']),
        location: pickStr(s, ['location', 'location_name']),
      })
    }

    const totalPages = pickNum(resp?.meta || {}, ['total_pages', 'last_page', 'pages'])
    if (totalPages && page >= totalPages) break
    log(`  catalogue: page ${page} → ${stocks.length} stocks (total so far: ${items.length})`)
  }

  return items
}

// ── Purchase orders ───────────────────────────────────────────────────────
// MD calls them "purchases". Create + delete confirmed via probe; the write
// auth is the XSRF-TOKEN echo handled in mdFetch. Receiving a PO into stock
// ("process") is done in MD's UI — the endpoint isn't a guessable REST route,
// so we create the PO and leave it for staff to receive (or wire the process
// call once its request is captured from the MD UI's network tab).

export interface MdPurchaseLineInput {
  stock_id: number
  quantity: number
  unit_price: number       // ex-GST
  gst_free: boolean
  name: string
  description?: string
}

export interface MdPurchaseResult {
  id: number
  number: string | null
  status: string | null
  total_amount: number | null
}

/**
 * Create a purchase order in MechanicDesk. Flat body (no Rails wrapper), the
 * shape confirmed by probe:
 *   { date, supplier_id, reference, description,
 *     purchase_items: [{ stock_id, quantity, unit_price,
 *                        included_gst:false, gst_free, name, description }] }
 * Returns the created purchase (status starts 'pending').
 */
export async function createMdPurchase(
  client: MdClient,
  input: { supplierId: number; reference?: string; description?: string; lines: MdPurchaseLineInput[] },
): Promise<MdPurchaseResult> {
  const ref = (input.reference || '').trim()
  const body: Record<string, any> = {
    date: new Date().toISOString(),
    supplier_id: input.supplierId,
    // Only set a reference when supplied — an empty/absent reference lets MD
    // assign its own sequential PO number (confirmed via probe).
    ...(ref ? { reference: ref } : {}),
    description: input.description || '',
    purchase_items: input.lines.map(l => ({
      stock_id: l.stock_id,
      quantity: l.quantity,
      unit_price: l.unit_price,
      included_gst: false,
      gst_free: l.gst_free,
      name: l.name,
      description: l.description || l.name,
      note: '',
    })),
  }
  const r = await mdFetch<any>(client, '/purchases', { method: 'POST', body: JSON.stringify(body) })
  if (!r?.id) throw new Error(`MD purchase create returned no id: ${JSON.stringify(r).slice(0, 200)}`)
  return { id: r.id, number: r.number ?? null, status: r.status ?? null, total_amount: r.total_amount ?? null }
}

/** Soft-delete a purchase (status → 'deleted'). Used to roll back a bad PO. */
export async function deleteMdPurchase(client: MdClient, purchaseId: number, reason = 'JA Portal rollback'): Promise<void> {
  await mdFetch<any>(client, `/purchases/${purchaseId}`, {
    method: 'DELETE',
    body: JSON.stringify({ deleted_reason: reason }),
  })
}

/**
 * PROCESS (receive) a purchase into MD stock — increments on-hand qty.
 * Endpoint + body shape captured from the MD UI's "Process" action:
 *   PUT /purchases/{id}/processes  { id, purchase_items: [<full items>] }
 * The items echo the purchase's own purchase_items (each carrying its line
 * `id`); MD receives the full ordered quantity. We GET the purchase first to
 * get the line ids, then PUT them back. Idempotent-ish: re-processing an
 * already-processed PO is a no-op on stock. Returns the post-process status.
 */
export async function processMdPurchase(
  client: MdClient,
  purchaseId: number,
): Promise<{ status: string | null; processed: boolean }> {
  const detail = await mdFetch<any>(client, `/purchases/${purchaseId}.json`)
  if (detail?.processed === true || detail?.status === 'processed') {
    return { status: detail.status ?? 'processed', processed: true }
  }
  const items = Array.isArray(detail?.purchase_items) ? detail.purchase_items : []
  if (items.length === 0) throw new Error(`Purchase ${purchaseId} has no items to process`)
  await mdFetch<any>(client, `/purchases/${purchaseId}/processes`, {
    method: 'PUT',
    body: JSON.stringify({ id: purchaseId, purchase_items: items }),
  })
  const after = await mdFetch<any>(client, `/purchases/${purchaseId}.json`)
  return { status: after?.status ?? null, processed: after?.processed === true }
}

// ── Pre Pick: aggregate parts demand for jobs in a date range ─────────────
// Walks the MD diary day-by-day to collect job ids, fetches each job's invoice
// line-items, and sums the TRACKED parts (real stock — labour/freight/misc are
// disable_tracking=true) by stock id, recording the live on-hand at pull time.
// Endpoints (mdweb SPA, same session):
//   GET /mdweb/workshops/diary?start=<iso>&end=<iso>  → { bookings:[{job_id}], jobs:[{job_id}] }
//   GET /mdweb/workshops/jobs/{id}?id={id}            → { invoice:{ items:[{ stock_id, quantity, stock:{…} }] } }

export interface MdPrePickItem {
  md_stock_id: number
  sku: string | null
  name: string | null
  to_pick: number
  on_hand: number
  allocated: number              // allocated_quantity = on-hand already committed/reserved to jobs
  on_order: number               // ordered_quantity = incoming on open MD purchase orders
  on_order_detail: any[] | null  // raw current_purchase_items (open PO lines) for the drill-down
  alert_qty: number | null
  reorder_point: number | null
  buy_price: number | null
  location: string | null
}

// One row per job in the range (metadata from the MD diary booking).
export interface MdPrePickJob {
  md_job_id: number
  job_number: string | null
  customer_name: string | null
  phone: string | null
  vehicle: string | null
  rego: string | null
  status: string | null
  description: string | null
  scheduled_at: string | null
  parts_count: number
  parts_qty: number
}

// One row per (job, stock) — the parts applied to a job (tracked stock only).
export interface MdPrePickJobItem {
  md_job_id: number
  md_stock_id: number
  sku: string | null
  name: string | null
  quantity: number
}

function ymdList(fromYmd: string, toYmd: string): string[] {
  const out: string[] = []
  const start = new Date(`${fromYmd}T00:00:00+10:00`)
  const end = new Date(`${toYmd}T00:00:00+10:00`)
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    out.push(d.toISOString().slice(0, 10))
    if (out.length > 120) break   // safety bound
  }
  return out
}

// Run an async fn over items with a bounded concurrency pool. MD's old-app
// endpoints handle this fine within one authenticated session, and it turns the
// dozens of sequential job fetches (the worker's main cost) into a few seconds.
async function mapPool<I, O>(items: I[], limit: number, fn: (item: I, idx: number) => Promise<O>): Promise<O[]> {
  const out: O[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const idx = next++
      out[idx] = await fn(items[idx], idx)
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, () => worker()))
  return out
}

// Pull job metadata out of an MD diary booking/job row (field names confirmed
// from a captured diary response).
function extractJobMeta(row: any): Omit<MdPrePickJob, 'md_job_id' | 'parts_count' | 'parts_qty'> {
  const vehicle = [row?.make, row?.model, row?.year].filter(Boolean).join(' ').trim() || null
  return {
    job_number: row?.job_number != null ? String(row.job_number) : null,
    customer_name: row?.name || row?.customer?.name || null,
    phone: row?.phone || row?.mobile || row?.customer?.phone || row?.customer?.mobile || null,
    vehicle: vehicle || (row?.vehicle_title ? String(row.vehicle_title).split('\n')[0] : null),
    rego: row?.registration_number || null,
    status: row?.status || null,
    description: row?.description || row?.job_types_title || null,
    scheduled_at: row?.time || row?.start || null,
  }
}

export async function collectPrePickDemand(
  client: MdClient,
  fromYmd: string,
  toYmd: string,
  log: (m: string) => void = () => {},
): Promise<{ jobsCount: number; items: MdPrePickItem[]; jobs: MdPrePickJob[]; jobItems: MdPrePickJobItem[] }> {
  // 1. Collect unique job ids + their metadata from the diary — days fetched
  // concurrently. NOTE: /mdweb/workshops/diary is the SPA client-side route
  // (serves the HTML app shell). The actual XHR data endpoint is the old-app
  // /auto_workshop/diary — same cookie session, no bearer token.
  const jobIds = new Set<number>()
  const jobMeta = new Map<number, MdPrePickJob>()
  await mapPool(ymdList(fromYmd, toYmd), 6, async (ymd) => {
    const start = `${ymd}T00:00:00+10:00`
    const end = `${ymd}T23:59:59+10:00`
    try {
      const diary = await mdFetch<any>(client, `/auto_workshop/diary?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`)
      for (const arr of [diary?.bookings, diary?.jobs]) {
        for (const row of (Array.isArray(arr) ? arr : [])) {
          const jid = Number(row?.job_id ?? row?.id)
          if (!jid || !isFinite(jid)) continue
          jobIds.add(jid)
          const meta = extractJobMeta(row)
          const existing = jobMeta.get(jid)
          if (!existing) {
            jobMeta.set(jid, { md_job_id: jid, parts_count: 0, parts_qty: 0, ...meta })
          } else {
            // Fill any blanks from a later diary row for the same job.
            for (const k of Object.keys(meta) as (keyof typeof meta)[]) {
              if ((existing as any)[k] == null && meta[k] != null) (existing as any)[k] = meta[k]
            }
          }
        }
      }
    } catch (e: any) {
      log(`  diary ${ymd} failed: ${String(e?.message).slice(0, 140)}`)
    }
  })
  log(`  ${jobIds.size} unique job(s) in ${fromYmd}…${toYmd}`)

  // 2. Fetch each job concurrently. The job-detail data endpoint is root-level
  // /jobs/{id}?id={id} (not under /auto_workshop/, not the SPA route). Returns
  // application/json with invoice.items. Confirmed from captured request.
  const ids = Array.from(jobIds)
  const details = await mapPool(ids, 8, async (jid) => {
    try {
      return await mdFetch<any>(client, `/jobs/${jid}?id=${jid}`)
    } catch (e: any) {
      log(`  job ${jid} failed: ${String(e?.message).slice(0, 140)}`)
      return null
    }
  })

  // 3. Aggregate tracked parts by stock id, and record per-job line items.
  const agg = new Map<number, MdPrePickItem>()
  const jobItems: MdPrePickJobItem[] = []
  for (let k = 0; k < ids.length; k++) {
    const jid = ids[k]
    const job = details[k]
    if (!job) continue
    const lines = Array.isArray(job?.invoice?.items) ? job.invoice.items : []
    const perJob = new Map<number, { sku: string | null; name: string | null; qty: number }>()
    for (const it of lines) {
      const st = it?.stock
      const qty = Number(it?.quantity) || 0
      // Tracked physical stock only (skip labour/freight/misc/deposit + headings).
      if (!st || st.disable_tracking === true || !it?.stock_id || qty <= 0) continue
      const id = Number(it.stock_id)
      const sku = it.stock_number || st.stock_number || null
      const name = st.name || it.description || null
      // Global aggregate.
      const cur = agg.get(id)
      if (cur) {
        cur.to_pick += qty
      } else {
        agg.set(id, {
          md_stock_id: id, sku, name, to_pick: qty,
          on_hand: Number(st.quantity) || 0,
          allocated: 0,
          on_order: 0, on_order_detail: null,
          alert_qty: st.alert_quantity != null ? Number(st.alert_quantity) : null,
          reorder_point: st.reorder_point != null ? Number(st.reorder_point) : null,
          buy_price: st.buy_price != null ? Number(st.buy_price) : null,
          location: st.location || st.bin || null,
        })
      }
      // Per-job merge (a job may list the same part on two lines).
      const pe = perJob.get(id)
      if (pe) pe.qty += qty
      else perJob.set(id, { sku, name, qty })
    }
    let jobQty = 0
    for (const [id, e] of Array.from(perJob.entries())) {
      const q = Math.round(e.qty * 100) / 100
      jobItems.push({ md_job_id: jid, md_stock_id: id, sku: e.sku, name: e.name, quantity: q })
      jobQty += q
    }
    const meta = jobMeta.get(jid)
    if (meta) { meta.parts_count = perJob.size; meta.parts_qty = Math.round(jobQty * 100) / 100 }
  }

  // 4. Per part, pull the stock-detail endpoint for "on order" (ordered_quantity)
  // and the open-PO lines behind it (current_purchase_items). Concurrent so it
  // adds little wall-clock. The job-embedded stock lacks these fields; only
  // /stocks/{id} carries ordered_quantity/allocated_quantity/available_quantity.
  const stockIds = Array.from(agg.keys())
  await mapPool(stockIds, 8, async (sid) => {
    try {
      const detail = await mdFetch<any>(client, `/stocks/${sid}`)
      const it = agg.get(sid)
      if (!it) return
      it.on_order = Number(detail?.ordered_quantity) || 0
      it.allocated = Number(detail?.allocated_quantity) || 0
      it.on_order_detail = Array.isArray(detail?.current_purchase_items) ? detail.current_purchase_items : null
    } catch (e: any) {
      log(`  stock ${sid} detail failed: ${String(e?.message).slice(0, 120)}`)
    }
  })

  const items = Array.from(agg.values()).map(i => ({ ...i, to_pick: Math.round(i.to_pick * 100) / 100 }))
  items.sort((a, b) => b.to_pick - a.to_pick)
  const jobs = Array.from(jobMeta.values()).sort((a, b) => (b.parts_count - a.parts_count) || String(a.scheduled_at || '').localeCompare(String(b.scheduled_at || '')))
  return { jobsCount: jobIds.size, items, jobs, jobItems }
}

// ── Customers (Monday → MD customer import, probe 2026-07-13) ─────────────
// MD's customer search + object shape confirmed via probe-md-customers:
// GET /customers.json?query=<term> → array of customer objects with
// id/name/phone/mobile/email/first_name/last_name/is_company/address{...}.

export interface MdCustomerLite {
  id: number
  name: string
  phone: string | null
  mobile: string | null
  email: string | null
  first_name: string | null
  last_name: string | null
  number: string | null
}

export async function searchMdCustomers(client: MdClient, query: string): Promise<MdCustomerLite[]> {
  const q = String(query || '').trim()
  if (!q) return []
  const r = await mdFetch<any>(client, `/customers.json?query=${encodeURIComponent(q)}`)
  const rows: any[] = Array.isArray(r) ? r : (Array.isArray(r?.customers) ? r.customers : [])
  return rows.filter(c => !c.deleted).map(c => ({
    id: c.id, name: c.name || '', phone: c.phone || null, mobile: c.mobile || null,
    email: c.email || null, first_name: c.first_name || null, last_name: c.last_name || null,
    number: c.number || null,
  }))
}

export interface MdCustomerCreateInput {
  firstName: string
  lastName: string
  mobile?: string | null
  email?: string | null
  postcode?: string | null
}

export async function createMdCustomer(client: MdClient, input: MdCustomerCreateInput): Promise<MdCustomerLite> {
  const body: Record<string, any> = {
    first_name: input.firstName,
    last_name: input.lastName,
    is_company: false,
    ...(input.mobile ? { mobile: input.mobile } : {}),
    ...(input.email ? { email: input.email } : {}),
    ...(input.postcode ? { address: { postcode: String(input.postcode) } } : {}),
  }
  const r = await mdFetch<any>(client, '/customers', { method: 'POST', body: JSON.stringify(body) })
  if (!r?.id) throw new Error(`MD customer create returned no id: ${JSON.stringify(r).slice(0, 200)}`)
  return {
    id: r.id, name: r.name || `${input.firstName} ${input.lastName}`, phone: r.phone || null,
    mobile: r.mobile || null, email: r.email || null, first_name: r.first_name || null,
    last_name: r.last_name || null, number: r.number || null,
  }
}

/** Soft-delete a customer (used only by the import's --test-create self-check). */
export async function deleteMdCustomer(client: MdClient, customerId: number, reason = 'JA Portal test cleanup'): Promise<void> {
  await mdFetch<any>(client, `/customers/${customerId}`, {
    method: 'DELETE',
    body: JSON.stringify({ deleted_reason: reason }),
  })
}

// Generic escape hatch for one-off scripts (customer repair etc.) — same
// cookie/CSRF handling as every other MD call in this lib.
export function mdRequest<T = any>(client: MdClient, path: string, init: RequestInit = {}): Promise<T> {
  return mdFetch<T>(client, path, init)
}
