// scripts/recon-mechanicdesk-stocktake.ts
// One-off reconnaissance script that captures everything about Mechanics
// Desk's stocktake page so we can design the auto-fill flow correctly.
//
// Captures:
//   1. All XHR/fetch network requests (URL, method, status, request payload,
//      response body) — we want to know if MD has internal JSON APIs we can
//      call directly instead of driving the form.
//   2. Page HTML snapshots at key states (list view, opened stocktake, scroll
//      to load more items if it's a virtualised list).
//   3. Console logs (in case the SPA logs anything useful about its API calls).
//   4. Cookies (for understanding session shape).
//
// This script does NOT modify any data — it only observes.
//
// Run via .github/workflows/recon-mechanicdesk-stocktake.yml workflow_dispatch.
// Output uploaded as a debug artifact for offline analysis.

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
}

const captured: CapturedRequest[] = []
const requestStartTimes = new Map<Request, number>()

async function setupNetworkCapture(context: BrowserContext): Promise<void> {
  context.on('request', (request) => {
    requestStartTimes.set(request, Date.now())
  })

  context.on('response', async (response) => {
    const request = response.request()
    const startMs = requestStartTimes.get(request)
    requestStartTimes.delete(request)

    const url = request.url()
    // Filter out static asset noise — we only care about API-ish traffic.
    if (/\.(png|jpg|jpeg|gif|svg|webp|ico|css|woff2?|ttf|otf|eot|map)(\?|$)/i.test(url)) return
    if (/google-analytics|googletagmanager|hotjar|fullstory|sentry/.test(url)) return

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
    }

    // Capture response body for things that look like JSON APIs
    const ct = (response.headers()['content-type'] || '').toLowerCase()
    if (
      ct.includes('json') ||
      ct.includes('javascript') ||
      ct.includes('text/html') && url.includes('/auto_workshop/')
    ) {
      try {
        const body = await response.text()
        // Cap at 200KB per response so we don't blow up the artifact
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
    const url = page.url()
    writeFileSync(join(ARTIFACT_DIR, `${label}.url.txt`), url)
  } catch (e: any) {
    log(`Snapshot ${label} failed: ${e?.message || e}`)
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
  log(`Navigating to stocktakes: ${STOCKTAKES_URL}`)
  await page.goto(STOCKTAKES_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => {
    log(`(initial nav: ${e?.message})`)
  })

  // SPA route — give it a moment to render
  await page.waitForTimeout(3000)
  await snapshotPage(page, '03-stocktakes-list')

  // Try to find any clickable stocktake row, button, or link
  log('Looking for stocktake list entries / action buttons…')

  // Capture the list page HTML so we can see what selectors are available
  const listInteractables = await page.evaluate(() => {
    const items: Array<{ tag: string; text: string; classes: string; href?: string; id?: string; dataAttrs: Record<string, string> }> = []
    const candidates = document.querySelectorAll('a, button, tr[ng-click], tr[data-id], [ng-click]:not(input)')
    candidates.forEach((el) => {
      const e = el as HTMLElement
      const text = (e.textContent || '').trim().slice(0, 120)
      if (!text && !e.getAttribute('href')) return
      const dataAttrs: Record<string, string> = {}
      for (const a of e.attributes) {
        if (a.name.startsWith('data-') || a.name.startsWith('ng-')) {
          dataAttrs[a.name] = a.value.slice(0, 200)
        }
      }
      items.push({
        tag: e.tagName,
        text,
        classes: e.className,
        href: (e as HTMLAnchorElement).href || undefined,
        id: e.id || undefined,
        dataAttrs,
      })
    })
    return items.slice(0, 200)
  })
  writeFileSync(join(ARTIFACT_DIR, '03-stocktakes-list-interactables.json'), JSON.stringify(listInteractables, null, 2))
  log(`Captured ${listInteractables.length} interactable elements on list page`)

  // Try to click into the first stocktake — multiple selector strategies
  log('Attempting to open the first stocktake…')
  let clicked = false
  const clickStrategies = [
    'a[href*="/stocktakes/"]:not([href$="/stocktakes"]):not([href$="/stocktakes/"])',
    'a[href*="stocktakes/"][href*="/edit"]',
    'tr.stocktake-row',
    'tr[data-id]',
    'button:has-text("Edit"):first-of-type',
    'button:has-text("Open"):first-of-type',
    'a:has-text("View"):first-of-type',
    'a:has-text("Edit"):first-of-type',
    'a.btn:not([href$="/stocktakes"]):first-of-type',
  ]

  for (const selector of clickStrategies) {
    const el = await page.$(selector).catch(() => null)
    if (el) {
      log(`Clicking via "${selector}"`)
      try {
        await el.click()
        clicked = true
        break
      } catch (e: any) {
        log(`  click failed: ${e?.message}`)
      }
    }
  }

  if (!clicked) {
    // Fallback: click whatever looks most like a row
    log('No selectors matched — trying first stocktake-like element via JS')
    clicked = await page.evaluate(() => {
      // Look for elements that mention "stocktake" in their class or have a stocktake-ish href
      const candidates = Array.from(document.querySelectorAll('a, [ng-click]'))
      for (const el of candidates) {
        const e = el as HTMLElement
        const href = (e as HTMLAnchorElement).href || ''
        const ngClick = e.getAttribute('ng-click') || ''
        const klass = e.className || ''
        if (
          (href.match(/\/stocktakes\/\d+/) ||
           ngClick.includes('stocktake') ||
           klass.includes('stocktake'))
          && !href.endsWith('/stocktakes')
        ) {
          (el as HTMLElement).click()
          return true
        }
      }
      return false
    })
  }

  if (!clicked) {
    log('WARN: could not find/click any stocktake row. The list may be empty or the script needs hand-tuning.')
    await snapshotPage(page, '04-couldnt-open-stocktake')
    return
  }

  // Wait for the stocktake detail to render
  await page.waitForTimeout(4000)
  await snapshotPage(page, '04-stocktake-detail')

  // Capture interactables on the detail page too
  const detailInteractables = await page.evaluate(() => {
    const items: any[] = []

    // Inputs (likely where counts are entered)
    document.querySelectorAll('input').forEach((el) => {
      const dataAttrs: Record<string, string> = {}
      for (const a of el.attributes) {
        if (a.name.startsWith('data-') || a.name.startsWith('ng-')) {
          dataAttrs[a.name] = a.value.slice(0, 200)
        }
      }
      items.push({
        kind: 'input',
        type: el.type,
        name: el.name,
        id: el.id,
        placeholder: el.placeholder,
        classes: el.className,
        value: el.value?.slice(0, 100),
        dataAttrs,
      })
    })

    // Look for table-like structures and how many rows they have
    document.querySelectorAll('table, .table, [role="table"]').forEach((el) => {
      const rows = el.querySelectorAll('tr, [role="row"]').length
      items.push({
        kind: 'table',
        tag: (el as HTMLElement).tagName,
        classes: (el as HTMLElement).className,
        rowCount: rows,
      })
    })

    // Buttons (save, add, etc)
    document.querySelectorAll('button, input[type="submit"], a.btn').forEach((el) => {
      const e = el as HTMLElement
      items.push({
        kind: 'button',
        text: (e.textContent || '').trim().slice(0, 80),
        classes: e.className,
        ngClick: e.getAttribute('ng-click') || undefined,
      })
    })
    return items.slice(0, 300)
  })
  writeFileSync(join(ARTIFACT_DIR, '04-stocktake-detail-interactables.json'), JSON.stringify(detailInteractables, null, 2))
  log(`Captured ${detailInteractables.length} elements on detail page`)

  // Scroll to bottom in case it's a virtualised list — captures any
  // pagination/infinite scroll API calls
  log('Scrolling to bottom to trigger any lazy-loading…')
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    await page.waitForTimeout(1500)
  }
  await snapshotPage(page, '05-stocktake-detail-after-scroll')

  // Try typing into the first text input on the detail page (probably the
  // "search by SKU" or "add product" field)
  log('Attempting to type into the first text-like input on the detail page…')
  const firstInput = await page.$('input[type="text"]:not([disabled]):not([readonly]), input:not([type]):not([disabled]):not([readonly])')
  if (firstInput) {
    try {
      await firstInput.click()
      await firstInput.fill('TEST_SKU_DO_NOT_SAVE')
      await page.waitForTimeout(2000)  // wait for any autocomplete API
      await snapshotPage(page, '06-after-input-typed')
      // Clear it
      await firstInput.fill('')
    } catch (e: any) {
      log(`Couldn't interact with first input: ${e?.message}`)
    }
  } else {
    log('No input field found on detail page')
  }

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
      acceptDownloads: true,
      viewport: { width: 1400, height: 1000 },
    })

    // Capture browser console messages too
    const consoleMessages: Array<{ ts: string; type: string; text: string }> = []
    context.on('weberror', (err) => {
      consoleMessages.push({ ts: new Date().toISOString(), type: 'pageerror', text: err.error().message })
    })

    await setupNetworkCapture(context)

    const page = await context.newPage()
    page.on('console', (msg) => {
      consoleMessages.push({ ts: new Date().toISOString(), type: msg.type(), text: msg.text().slice(0, 500) })
    })

    await login(page, workshopId, username, password)
    await exploreStocktakes(page)

    // Dump network capture
    log(`Captured ${captured.length} network requests — writing to disk`)
    writeFileSync(join(ARTIFACT_DIR, 'network.json'), JSON.stringify(captured, null, 2))

    // Compact summary table
    const summary = captured
      .filter(c => c.url.includes('/auto_workshop/') || c.url.includes('/api/'))
      .map(c => ({
        method: c.method,
        status: c.status,
        url: c.url.replace(MD_BASE, ''),
        ms: c.durationMs,
        ct: c.responseHeaders?.['content-type']?.split(';')[0],
        size: c.responseBody?.length,
      }))
    writeFileSync(join(ARTIFACT_DIR, 'network-summary.json'), JSON.stringify(summary, null, 2))
    log(`Wrote ${summary.length} app/api requests to network-summary.json`)

    // Console messages
    writeFileSync(join(ARTIFACT_DIR, 'console.json'), JSON.stringify(consoleMessages, null, 2))

    // Cookies
    const cookies = await context.cookies(MD_BASE)
    writeFileSync(join(ARTIFACT_DIR, 'cookies.json'), JSON.stringify(cookies.map(c => ({
      name: c.name,
      domain: c.domain,
      path: c.path,
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite: c.sameSite,
      // Don't dump the actual value — just indicate length
      valueLength: c.value?.length || 0,
    })), null, 2))

    log('Done — all artifacts written to ' + ARTIFACT_DIR)
    process.exit(0)
  } catch (e: any) {
    log(`FATAL: ${e?.message || String(e)}`)
    if (e?.stack) log(e.stack)
    // Still write what we captured even on failure
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
