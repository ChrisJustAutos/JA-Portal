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
  available?: number
  buy_price?: number
  sell_price_excluded_gst?: number
  sell_price_included_gst?: number
  price?: number
  average_buy_price?: number
  location?: string | null
  bin?: string | null
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
  if (init.method && init.method !== 'GET' && client.csrfToken) {
    headers['X-CSRF-Token'] = client.csrfToken
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
