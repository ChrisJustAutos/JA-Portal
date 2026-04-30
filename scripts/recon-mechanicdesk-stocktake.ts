// scripts/recon-mechanicdesk-stocktake.ts
// Reconnaissance script v3 — captures the POST that adds an item to a
// stocktake sheet by actually performing the add-item flow against the
// existing RECON_DELETE_ME stocktake (id 47270 from the previous run).
//
// Steps:
//   1. Log in
//   2. Navigate to the existing RECON stocktake at /stocktakes/{id}
//      (configurable via RECON_STOCKTAKE_ID env var, defaults to 47270)
//   3. Find the SKU search input (ng-model="item.description")
//   4. Type a short query like "OIL" — wait for autocomplete
//   5. Pick the first dropdown result via keyboard (ArrowDown + Enter)
//   6. Set the count input (ng-model="new_stocktake_item.count") to 0
//   7. Click Save → capture the POST that fires
//   8. Done. NEVER click Finish, Delete, or anything else destructive.
//
// The added item will have count=0 — no real impact on inventory if
// the stocktake were ever finished. You can delete the whole recon
// stocktake from MD afterwards.

import { chromium, Browser, BrowserContext, Page, Request, Response } from 'playwright'
import { writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'

const MD_BASE = 'https://www.mechanicdesk.com.au'
const LOGIN_URL = `${MD_BASE}/auto_workshop/login`
const RECON_STOCKTAKE_ID = process.env.RECON_STOCKTAKE_ID || '47270'
const STOCKTAKE_URL = `${MD_BASE}/auto_workshop/app#/stocktakes/${RECON_STOCKTAKE_ID}`

const ARTIFACT_DIR = process.env.GITHUB_WORKSPACE
  ? join(process.env.GITHUB_WORKSPACE, 'artifacts')
  : './artifacts'

if (!existsSync(ARTIFACT_DIR)) mkdirSync(ARTIFACT_DIR, { recursive: true })

function log(...args: any[]) {
  console.log(`[${new Date().toISOString()}]`, ...args)
}

interface CapturedRequest {
  ts: string
  method: string
  url: string
  resourceType: string
  requestHeaders?: Record<string, string>
  postData?: string | null
  status?: number
  statusText?: string
  responseHeaders?: Record<string, string>
  responseBody?: string
  responseError?: string
  durationMs?: number
  phase?: string
}

const captured: CapturedRequest[] = []
const requestStartTimes = new Map<Request, number>()
let currentPhase = 'init'

async function setupNetworkCapture(context: BrowserContext): Promise<void> {
  context.on('request', (request) => {
    requestStartTimes.set(request, Date.now())
  })

  context.on('response', async (response) => {
    const request = response.request()
    const startMs = requestStartTimes.get(request)
    requestStartTimes.delete(request)

    const url = request.url()
    if (/\.(png|jpg|jpeg|gif|svg|webp|ico|css|woff2?|ttf|otf|eot|map)(\?|$)/i.test(url)) return
    if (/google-analytics|googletagmanager|hotjar|fullstory|sentry|stripe/.test(url)) return

    const resourceType = request.resourceType()
    if (resourceType === 'image' || resourceType === 'font' || resourceType === 'stylesheet') return

    const entry: CapturedRequest = {
      ts: new Date().toISOString(),
      method: request.method(),
      url,
      resourceType,
      requestHeaders: request.headers(),
      postData: request.postData(),
      status: response.status(),
      statusText: response.statusText(),
      responseHeaders: response.headers(),
      durationMs: startMs ? Date.now() - startMs : undefined,
      phase: currentPhase,
    }

    const ct = (response.headers()['content-type'] || '').toLowerCase()
    if (
      ct.includes('json') ||
      (ct.includes('javascript') && url.includes('/auto_workshop/')) ||
      (ct.includes('text/html') && url.includes('/auto_workshop/'))
    ) {
      try {
        const body = await response.text()
        entry.responseBody = body.length > 200_000 ? body.slice(0, 200_000) + '\n... [TRUNCATED]' : body
      } catch (e: any) {
        entry.responseError = e?.message || String(e)
      }
    }

    captured.push(entry)
  })
}

async function snapshotPage(page: Page, label: string): Promise<void> {
  log(`Snapshotting "${label}"`)
  try {
    await page.screenshot({ path: join(ARTIFACT_DIR, `${label}.png`), fullPage: true })
    const html = await page.content()
    writeFileSync(join(ARTIFACT_DIR, `${label}.html`), html)
    writeFileSync(join(ARTIFACT_DIR, `${label}.url.txt`), page.url())
  } catch (e: any) {
    log(`Snapshot ${label} failed: ${e?.message || e}`)
  }
}

async function login(page: Page, workshopId: string, username: string, password: string): Promise<void> {
  log(`Navigating to login: ${LOGIN_URL}`)
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 })

  const workshopInput = await page.$('input[name*="workshop" i], input#workshop_id, input[placeholder*="Workshop" i]')
  if (!workshopInput) {
    const firstText = await page.$('input[type="text"]:not([disabled])')
    if (!firstText) throw new Error('Could not find workshop ID field')
    await firstText.fill(workshopId)
  } else {
    await workshopInput.fill(workshopId)
  }

  const usernameInput = await page.$('input[name="username"], input#username, input[name="user[username]"]')
  if (!usernameInput) {
    const allText = await page.$$('input[type="text"]:not([disabled])')
    if (allText.length < 2) throw new Error('Could not find username field')
    await allText[1].fill(username)
  } else {
    await usernameInput.fill(username)
  }

  const passwordInput = await page.$('input[type="password"]')
  if (!passwordInput) throw new Error('Could not find password field')
  await passwordInput.fill(password)

  const submit = await page.$('button:has-text("Login"), input[type="submit"], button[type="submit"]')
  if (!submit) throw new Error('Could not find submit button')
  await submit.click()

  log('Waiting for password field to disappear (login success signal)…')
  try {
    await page.waitForSelector('input[type="password"]', { state: 'detached', timeout: 30000 })
  } catch (e: any) {
    await snapshotPage(page, '01-login-failed')
    throw new Error(`Login failed: ${e?.message}`)
  }
  await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => undefined)
  log(`Login OK — landed on ${page.url()}`)
}

async function captureAddItemFlow(page: Page): Promise<void> {
  // ── Phase 1: Open the existing recon stocktake ──────────────────────
  currentPhase = 'open-stocktake'
  log(`PHASE: open-stocktake — navigating to ${STOCKTAKE_URL}`)
  await page.goto(STOCKTAKE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForTimeout(4000)
  await snapshotPage(page, '01-stocktake-open')
  log(`  Landed on: ${page.url()}`)

  // ── Phase 2: Type into the SKU search ───────────────────────────────
  currentPhase = 'type-search'
  log(`PHASE: type-search — finding ng-model="item.description" input`)

  const searchInput = await page.$('input[ng-model="item.description"]')
  if (!searchInput) {
    log('  ERROR: Could not find the item.description search input!')
    await snapshotPage(page, '02-search-not-found')
    throw new Error('SKU search input not found on stocktake page')
  }

  const searchQuery = 'OIL'
  log(`  Typing "${searchQuery}" character-by-character to trigger autocomplete`)
  await searchInput.click()
  await page.waitForTimeout(300)
  for (const ch of searchQuery) {
    await page.keyboard.type(ch, { delay: 200 })
  }
  // Wait for autocomplete network call to complete and dropdown to render
  await page.waitForTimeout(2500)
  await snapshotPage(page, '02-after-typing-search')

  // ── Phase 3: Pick the first autocomplete result ────────────────────
  currentPhase = 'pick-result'
  log(`PHASE: pick-result — pressing ArrowDown + Enter to select first result`)
  await page.keyboard.press('ArrowDown')
  await page.waitForTimeout(300)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(2000)
  await snapshotPage(page, '03-after-picking-result')

  // ── Phase 4: Set count to 0 ─────────────────────────────────────────
  currentPhase = 'set-count'
  log(`PHASE: set-count — setting new_stocktake_item.count = 0`)
  const countInput = await page.$('input[ng-model="new_stocktake_item.count"]')
  if (!countInput) {
    log('  WARN: Could not find count input — will try to capture click anyway')
  } else {
    // Triple-click to select existing value, then type 0
    await countInput.click({ clickCount: 3 })
    await page.waitForTimeout(200)
    await page.keyboard.type('0', { delay: 100 })
    await page.waitForTimeout(500)
    // Tab out so AngularJS picks up the change
    await page.keyboard.press('Tab')
    await page.waitForTimeout(500)
  }
  await snapshotPage(page, '04-after-setting-count')

  // ── Phase 5: Click Save → THIS is the magic POST ────────────────────
  currentPhase = 'click-save'
  log(`PHASE: click-save — clicking save_new_stocktake_item button`)
  const saveBtn = await page.$('button[ng-click="save_new_stocktake_item()"]')
  if (!saveBtn) {
    log('  WARN: Could not find the Save button via ng-click selector')
    // Fallback: find any visible Save button on the page
    const fallback = await page.$('button.btn-success:has-text("Save"):visible, button:has-text("Save"):visible')
    if (fallback) {
      log('  Using fallback Save button')
      await fallback.click()
    } else {
      throw new Error('Could not find Save button')
    }
  } else {
    await saveBtn.click()
  }

  // Give it plenty of time for the POST + any follow-up GETs to complete
  log('  Waiting 5s for POST + any follow-up requests…')
  await page.waitForTimeout(5000)
  await snapshotPage(page, '05-after-save')
  log(`  Final URL: ${page.url()}`)

  // ── Phase 6: Final settle ───────────────────────────────────────────
  currentPhase = 'final-settle'
  await page.waitForTimeout(2000)
  await snapshotPage(page, '06-final-state')
  log('Add-item flow complete')
}

async function main(): Promise<void> {
  const workshopId = process.env.MECHANICDESK_WORKSHOP_ID
  const username = process.env.MECHANICDESK_USERNAME
  const password = process.env.MECHANICDESK_PASSWORD
  if (!workshopId || !username || !password) {
    throw new Error('MECHANICDESK_WORKSHOP_ID, MECHANICDESK_USERNAME and MECHANICDESK_PASSWORD env vars required')
  }

  log(`Recon target stocktake: ${RECON_STOCKTAKE_ID}`)

  let browser: Browser | null = null
  try {
    log('Launching headless Chromium')
    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      acceptDownloads: false,
      viewport: { width: 1400, height: 1000 },
    })

    const consoleMessages: Array<{ ts: string; phase: string; type: string; text: string }> = []
    context.on('weberror', (err) => {
      consoleMessages.push({ ts: new Date().toISOString(), phase: currentPhase, type: 'pageerror', text: err.error().message })
    })

    await setupNetworkCapture(context)

    const page = await context.newPage()
    page.on('console', (msg) => {
      consoleMessages.push({ ts: new Date().toISOString(), phase: currentPhase, type: msg.type(), text: msg.text().slice(0, 500) })
    })

    currentPhase = 'login'
    await login(page, workshopId, username, password)
    await captureAddItemFlow(page)

    log(`Captured ${captured.length} network requests`)
    writeFileSync(join(ARTIFACT_DIR, 'network.json'), JSON.stringify(captured, null, 2))

    // Compact summary — easier to scan
    const summary = captured
      .filter(c =>
        (c.url.includes('/auto_workshop/') || c.url.includes('/api/') ||
         c.url.includes('/stocktakes') || c.url.includes('/stocktake_'))
        && !c.url.includes('/assets/')
      )
      .map(c => ({
        phase: c.phase,
        method: c.method,
        status: c.status,
        url: c.url.replace(MD_BASE, ''),
        ms: c.durationMs,
        ct: c.responseHeaders?.['content-type']?.split(';')[0],
        body_size: c.responseBody?.length,
        post_size: c.postData?.length,
      }))
    writeFileSync(join(ARTIFACT_DIR, 'network-summary.json'), JSON.stringify(summary, null, 2))
    log(`Wrote ${summary.length} app/api requests to network-summary.json`)

    // Per-phase breakdown
    const phases: Record<string, any[]> = {}
    summary.forEach(s => {
      const phase = s.phase || 'unknown'
      if (!phases[phase]) phases[phase] = []
      phases[phase].push(`${s.method} ${s.status} ${s.url}${s.post_size ? ` (POST body ${s.post_size}b)` : ''}`)
    })
    writeFileSync(join(ARTIFACT_DIR, 'network-by-phase.json'), JSON.stringify(phases, null, 2))

    writeFileSync(join(ARTIFACT_DIR, 'console.json'), JSON.stringify(consoleMessages, null, 2))

    const cookies = await context.cookies(MD_BASE)
    writeFileSync(join(ARTIFACT_DIR, 'cookies.json'), JSON.stringify(cookies.map(c => ({
      name: c.name, domain: c.domain, path: c.path,
      httpOnly: c.httpOnly, secure: c.secure, sameSite: c.sameSite,
      valueLength: c.value?.length || 0,
    })), null, 2))

    log('Done — all artifacts written to ' + ARTIFACT_DIR)
    process.exit(0)
  } catch (e: any) {
    log(`FATAL: ${e?.message || String(e)}`)
    if (e?.stack) log(e.stack)
    if (captured.length > 0) {
      writeFileSync(join(ARTIFACT_DIR, 'network-partial.json'), JSON.stringify(captured, null, 2))
      log(`Wrote ${captured.length} partial network captures`)
    }
    if (browser) await browser.close().catch(() => undefined)
    process.exit(1)
  } finally {
    if (browser) await browser.close().catch(() => undefined)
  }
}

main()
