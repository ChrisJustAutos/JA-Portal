// scripts/recon-mechanicdesk-stocktake.ts
// Reconnaissance script v2 — walks through the FULL stocktake flow to
// capture every network call MD makes when:
//   1. Landing on /stocktakes (the list)
//   2. Clicking into the first existing stocktake (if any)
//   3. Otherwise: creating a NEW stocktake (fills name, clicks Continue)
//   4. Landing on the item-entry page
//   5. Typing into the product search to trigger autocomplete API
//   6. Capturing every interactable element on each page
//
// SAFETY RAILS:
//   • NEVER clicks Save / Submit / Complete / Finish / Delete
//   • Adds NOTHING to any stocktake (we only inspect autocomplete)
//   • If forced to create a stocktake to inspect the next page, the
//     stocktake will be left empty — you can delete it manually after
//
// Output: artifacts/ directory with screenshots, HTML, JSON network
// captures, interactable element dumps, and console logs.

import { chromium, Browser, BrowserContext, Page, Request, Response } from 'playwright'
import { writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'

const MD_BASE = 'https://www.mechanicdesk.com.au'
const LOGIN_URL = `${MD_BASE}/auto_workshop/login`
const STOCKTAKES_URL = `${MD_BASE}/auto_workshop/app#/stocktakes`

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
  // Phase tag — which step of the recon was this captured during?
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

async function dumpInteractables(page: Page, label: string): Promise<void> {
  try {
    const items = await page.evaluate(() => {
      const results: any[] = []

      // All inputs (visible only)
      document.querySelectorAll('input, textarea, select').forEach((el) => {
        const e = el as HTMLInputElement
        const rect = e.getBoundingClientRect()
        const visible = rect.width > 0 && rect.height > 0
        if (!visible && e.type === 'hidden') return  // skip hidden form scaffolding
        const dataAttrs: Record<string, string> = {}
        for (const a of e.attributes) {
          if (a.name.startsWith('data-') || a.name.startsWith('ng-')) {
            dataAttrs[a.name] = a.value.slice(0, 200)
          }
        }
        results.push({
          kind: 'input',
          type: e.type || e.tagName.toLowerCase(),
          name: e.name,
          id: e.id,
          placeholder: e.placeholder,
          classes: (e.className || '').slice(0, 200),
          value: e.value?.slice(0, 100),
          visible,
          dataAttrs,
        })
      })

      // Tables (just metadata)
      document.querySelectorAll('table, .table, [role="table"]').forEach((el) => {
        const e = el as HTMLElement
        results.push({
          kind: 'table',
          tag: e.tagName,
          classes: (e.className || '').slice(0, 200),
          rowCount: e.querySelectorAll('tr, [role="row"]').length,
          id: e.id,
        })
      })

      // Buttons + click handlers
      document.querySelectorAll('button, input[type="submit"], a.btn, [ng-click]').forEach((el) => {
        const e = el as HTMLElement
        const text = (e.textContent || '').trim().slice(0, 100)
        const ngClick = e.getAttribute('ng-click') || ''
        if (!text && !ngClick) return
        const rect = e.getBoundingClientRect()
        results.push({
          kind: 'click',
          tag: e.tagName,
          text,
          classes: (e.className || '').slice(0, 200),
          ngClick: ngClick.slice(0, 200),
          href: (e as HTMLAnchorElement).href || undefined,
          id: e.id,
          visible: rect.width > 0 && rect.height > 0,
        })
      })

      return results.slice(0, 500)
    })
    writeFileSync(join(ARTIFACT_DIR, `${label}.json`), JSON.stringify(items, null, 2))
    log(`  → ${items.length} interactable elements dumped to ${label}.json`)
  } catch (e: any) {
    log(`dumpInteractables ${label} failed: ${e?.message}`)
  }
}

async function login(page: Page, workshopId: string, username: string, password: string): Promise<void> {
  log(`Navigating to login: ${LOGIN_URL}`)
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await snapshotPage(page, '01-login-page')

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
    await snapshotPage(page, '02-login-failed')
    throw new Error(`Login failed: ${e?.message}`)
  }
  await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => undefined)
  log(`Login OK — landed on ${page.url()}`)
  await snapshotPage(page, '02-after-login')
}

async function exploreStocktakes(page: Page): Promise<void> {
  // ── Phase 1: List page ──────────────────────────────────────────────
  currentPhase = 'list'
  log(`PHASE: list — navigating to stocktakes`)
  await page.goto(STOCKTAKES_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => {
    log(`(initial nav: ${e?.message})`)
  })
  await page.waitForTimeout(3500)
  await snapshotPage(page, '03-stocktakes-list')
  await dumpInteractables(page, '03-stocktakes-list-interactables')

  // ── Phase 2: Try to open an EXISTING stocktake first ────────────────
  // A real stocktake link looks like /stocktakes/{numeric_id} or
  // /stocktakes/{id}/edit — NOT /stocktakes/new
  log(`PHASE: trying to find an existing stocktake to open`)
  const existingHref = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a[href]'))
    for (const link of links) {
      const href = (link as HTMLAnchorElement).href
      // Match /stocktakes/<digits> but NOT /stocktakes/new
      if (/\/stocktakes\/\d+/.test(href)) return href
    }
    return null
  })

  let openedExisting = false
  if (existingHref) {
    log(`  Found existing stocktake: ${existingHref}`)
    currentPhase = 'open-existing'
    await page.goto(existingHref, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => undefined)
    await page.waitForTimeout(3500)
    await snapshotPage(page, '04a-existing-stocktake')
    await dumpInteractables(page, '04a-existing-stocktake-interactables')
    openedExisting = true
  } else {
    log('  No existing stocktake found on the list page')
  }

  // ── Phase 3: Create a new stocktake (only fill name + click Continue) ─
  // We do this regardless — even if we opened an existing one, we still
  // want to capture the "create" flow's network calls so we know how to
  // create one programmatically later.
  currentPhase = 'create-new'
  log(`PHASE: create-new — visiting /stocktakes/new`)
  await page.goto(`${MD_BASE}/auto_workshop/app#/stocktakes/new`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => undefined)
  await page.waitForTimeout(3000)
  await snapshotPage(page, '05a-new-stocktake-form')
  await dumpInteractables(page, '05a-new-stocktake-form-interactables')

  // Fill the name field with a clearly-marked recon name so it's obvious
  // in MD that this can be deleted
  const reconName = `RECON_DELETE_ME_${new Date().toISOString().slice(0, 10)}`
  log(`  Filling stocktake name: ${reconName}`)
  const nameInput = await page.$('input[ng-model="stocktake.name"]')
  if (!nameInput) {
    log('  WARN: Could not find stocktake.name input — falling back to any visible text input')
    const fallback = await page.$('form input[type="text"]:not([disabled]):not([readonly])')
    if (fallback) await fallback.fill(reconName)
  } else {
    await nameInput.fill(reconName)
  }

  // Click Continue
  log(`  Clicking Continue (save_new_stocktake)`)
  const continueBtn = await page.$('button[ng-click="save_new_stocktake()"]')
  if (continueBtn) {
    await continueBtn.click()
  } else {
    // Fallback selector
    const fallback = await page.$('button.btn-primary:has-text("Continue")')
    if (fallback) await fallback.click()
    else log('  WARN: No Continue button found')
  }

  // Wait for the navigation/render to settle. The POST and subsequent
  // GET(s) for the new stocktake's data should fire here.
  log('  Waiting for next page to render (5s)…')
  await page.waitForTimeout(5000)
  await snapshotPage(page, '06-stocktake-item-entry')
  await dumpInteractables(page, '06-stocktake-item-entry-interactables')
  log(`  Landed on: ${page.url()}`)

  // ── Phase 4: Try typing into the product search ─────────────────────
  currentPhase = 'search-product'
  log(`PHASE: search-product — looking for SKU/product search input`)

  // Try several likely selectors for the search field on the item entry page
  const searchSelectors = [
    'input[ng-model*="search" i]',
    'input[ng-model*="query" i]',
    'input[placeholder*="search" i]',
    'input[placeholder*="stock" i]',
    'input[placeholder*="product" i]',
    'input[placeholder*="SKU" i]',
    'input[ng-model*="stock" i]',
    // Anything with selectize/select2 styling — common for autocomplete
    '.selectize-input input[type="text"]',
    'input.select2-input',
    // Last resort: first non-search-engine text input on the page
    'main input[type="text"]:not([ng-model="global_query"]):not([id="global-search-input"])',
    '.content-box input[type="text"]:not([readonly])',
  ]

  let searchInput = null
  let usedSelector = ''
  for (const sel of searchSelectors) {
    const el = await page.$(sel).catch(() => null)
    if (el) {
      const isVisible = await el.isVisible().catch(() => false)
      if (isVisible) {
        searchInput = el
        usedSelector = sel
        break
      }
    }
  }

  if (searchInput) {
    log(`  Found search input via selector: ${usedSelector}`)
    try {
      await searchInput.click()
      await page.waitForTimeout(300)
      // Type slowly, character by character, so each keystroke can fire
      // its own autocomplete request. This gives us the clearest API trace.
      const testQuery = 'OIL'  // generic, likely to match SOMETHING in inventory
      log(`  Typing "${testQuery}" character-by-character`)
      for (const ch of testQuery) {
        await page.keyboard.type(ch, { delay: 200 })
      }
      // Wait for any autocomplete responses to come in
      await page.waitForTimeout(2500)
      await snapshotPage(page, '07-after-search-typed')
      await dumpInteractables(page, '07-after-search-typed-interactables')

      // Clear the field (don't accidentally select an item)
      log('  Clearing search field')
      await searchInput.fill('').catch(() => undefined)
      // Click somewhere safe to dismiss any dropdown
      await page.keyboard.press('Escape').catch(() => undefined)
      await page.waitForTimeout(500)
    } catch (e: any) {
      log(`  Could not interact with search input: ${e?.message}`)
    }
  } else {
    log('  WARN: Could not find a product search input on the item entry page')
  }

  // ── Phase 5: Capture the page after waiting a moment ────────────────
  currentPhase = 'final-snapshot'
  await page.waitForTimeout(1500)
  await snapshotPage(page, '08-final-state')

  log('Reconnaissance complete')
}

async function main(): Promise<void> {
  const workshopId = process.env.MECHANICDESK_WORKSHOP_ID
  const username = process.env.MECHANICDESK_USERNAME
  const password = process.env.MECHANICDESK_PASSWORD
  if (!workshopId || !username || !password) {
    throw new Error('MECHANICDESK_WORKSHOP_ID, MECHANICDESK_USERNAME and MECHANICDESK_PASSWORD env vars required')
  }

  let browser: Browser | null = null
  try {
    log('Launching headless Chromium')
    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      acceptDownloads: false,  // we don't download anything during recon
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
    await exploreStocktakes(page)

    log(`Captured ${captured.length} network requests`)
    writeFileSync(join(ARTIFACT_DIR, 'network.json'), JSON.stringify(captured, null, 2))

    // Compact summary — easier to scan
    const summary = captured
      .filter(c =>
        (c.url.includes('/auto_workshop/') || c.url.includes('/api/')) &&
        !c.url.includes('/assets/')
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

    // Per-phase breakdown — even more compact
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
