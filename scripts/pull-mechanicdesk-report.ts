// scripts/pull-mechanicdesk-report.ts
// Headless Chromium task that:
//   1. Logs into Mechanics Desk (Workshop ID + Username + Password)
//   2. Downloads the Job Report XLSX (rolling date range)
//   3. POSTs it to the JA Portal upload endpoint
//
// Run via GitHub Actions on a schedule. See .github/workflows/mechanicdesk-pull.yml.

import { chromium, Browser, BrowserContext, Page, Download } from 'playwright'
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'

// ── Config ─────────────────────────────────────────────────────────────

const MD_BASE = 'https://www.mechanicdesk.com.au'
const MD_LOGIN_URL_CANDIDATES = [
  process.env.MECHANICDESK_LOGIN_URL,
  `${MD_BASE}/auto_workshop/login`,
  `${MD_BASE}/users/sign_in`,
  `${MD_BASE}/login`,
  `${MD_BASE}/`,
].filter(Boolean) as string[]

const DAYS_BEHIND = 30
const DAYS_AHEAD = 365

const PORTAL_UPLOAD_PATH = '/api/job-reports/upload'

const ARTIFACT_DIR = process.env.GITHUB_WORKSPACE
  ? join(process.env.GITHUB_WORKSPACE, 'artifacts')
  : './artifacts'

// ── Helpers ────────────────────────────────────────────────────────────

function log(...args: any[]) {
  console.log(`[${new Date().toISOString()}]`, ...args)
}

function buildReportUrl(): string {
  const now = new Date()
  const from = new Date(now.getTime() - DAYS_BEHIND * 86400_000)
  const to = new Date(now.getTime() + DAYS_AHEAD * 86400_000)
  const fmt = (d: Date): string => {
    const aest = new Date(d.getTime() + 10 * 3600_000)
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    const dayName = days[aest.getUTCDay()]
    const monthName = months[aest.getUTCMonth()]
    const dayNum = String(aest.getUTCDate()).padStart(2, '0')
    const year = aest.getUTCFullYear()
    return `${dayName} ${monthName} ${dayNum} ${year} 00:00:00 GMT+1000 (Australian Eastern Standard Time)`
  }
  const params = new URLSearchParams({
    from: fmt(from),
    to: fmt(to),
    include_unfinished: 'true',
  })
  return `${MD_BASE}/reports/job/download?${params.toString()}`
}

async function notifySlack(message: string, isError = false): Promise<void> {
  const webhook = process.env.SLACK_WEBHOOK_URL
  if (!webhook) {
    log('SLACK_WEBHOOK_URL not set — skipping Slack notification')
    return
  }
  const runUrl = process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : null
  const prefix = isError ? ':rotating_light: *Mechanics Desk auto-pull FAILED*' : ':white_check_mark: Mechanics Desk auto-pull'
  const body = `${prefix}\n${message}${runUrl ? `\n<${runUrl}|View run logs>` : ''}`
  try {
    const r = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: body }),
    })
    if (!r.ok) log(`Slack webhook returned ${r.status}: ${await r.text().catch(() => '')}`)
  } catch (e: any) {
    log(`Slack webhook fetch failed: ${e?.message || e}`)
  }
}

async function saveDebugArtifacts(page: Page, label: string): Promise<void> {
  if (!existsSync(ARTIFACT_DIR)) mkdirSync(ARTIFACT_DIR, { recursive: true })
  try {
    await page.screenshot({ path: join(ARTIFACT_DIR, `${label}.png`), fullPage: true })
    const html = await page.content()
    writeFileSync(join(ARTIFACT_DIR, `${label}.html`), html)
    log(`Saved debug artifacts: ${label}.png, ${label}.html`)
  } catch (e: any) {
    log(`Failed to save artifacts: ${e?.message || e}`)
  }
}

// ── Login ──────────────────────────────────────────────────────────────

async function findFormPage(page: Page): Promise<string> {
  for (const url of MD_LOGIN_URL_CANDIDATES) {
    log(`Trying login URL: ${url}`)
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
    } catch (e: any) {
      log(`  navigation failed: ${e?.message || e}`)
      continue
    }
    const hasPassword = await page.$('input[type="password"]')
    if (hasPassword) {
      log(`  found login form at ${page.url()}`)
      return page.url()
    }
    log(`  no password field on this page (status: ${page.url()}), trying next…`)
  }
  throw new Error(`Could not find a Mechanics Desk login page. Tried: ${MD_LOGIN_URL_CANDIDATES.join(', ')}`)
}

async function login(page: Page, workshopId: string, username: string, password: string): Promise<void> {
  await findFormPage(page)
  await saveDebugArtifacts(page, 'login-page-loaded')

  const workshopSelectors = [
    'input[name="workshop_id"]',
    'input[name="user[workshop_id]"]',
    'input#workshop_id',
    'input[placeholder*="Workshop" i]',
    'input[name*="workshop" i]',
  ]
  const usernameSelectors = [
    'input[name="user[username]"]',
    'input[name="username"]',
    'input#user_username',
    'input#username',
    'input[placeholder*="Username" i]',
    'input[name="user[email]"]',
    'input[type="email"]',
    'input#user_email',
  ]
  const passwordSelectors = [
    'input[name="user[password]"]',
    'input[name="password"]',
    'input[type="password"]',
    'input#user_password',
    'input#password',
  ]
  const submitSelectors = [
    'input[type="submit"][value*="Login" i]',
    'input[type="submit"]',
    'button[type="submit"]',
    'button:has-text("Login")',
    'button:has-text("Log in")',
    'button:has-text("Sign in")',
  ]

  async function fillFirst(selectors: string[], value: string, label: string): Promise<string | null> {
    for (const sel of selectors) {
      const el = await page.$(sel)
      if (el) { await el.fill(value); log(`Filled ${label} via "${sel}"`); return sel }
    }
    return null
  }

  let workshopFilled = await fillFirst(workshopSelectors, workshopId, 'workshop ID')
  if (!workshopFilled) {
    log(`Workshop ID selector miss, trying positional fallback (first text input)`)
    const firstTextInput = await page.$('input[type="text"]:not([type="hidden"]):not([disabled])')
    if (firstTextInput) {
      await firstTextInput.fill(workshopId)
      log('Filled workshop ID via positional fallback')
    } else {
      await saveDebugArtifacts(page, 'workshop-id-not-found')
      throw new Error(`Could not find workshop ID field`)
    }
  }

  let usernameFilled = await fillFirst(usernameSelectors, username, 'username')
  if (!usernameFilled) {
    log(`Username selector miss, trying positional fallback (second text input)`)
    const allTextInputs = await page.$$('input[type="text"]:not([type="hidden"]):not([disabled])')
    if (allTextInputs.length >= 2) {
      await allTextInputs[1].fill(username)
      log('Filled username via positional fallback (second text input)')
    } else {
      await saveDebugArtifacts(page, 'username-not-found')
      throw new Error(`Could not find username field`)
    }
  }

  const passwordFilled = await fillFirst(passwordSelectors, password, 'password')
  if (!passwordFilled) {
    await saveDebugArtifacts(page, 'password-not-found')
    throw new Error(`Could not find password field`)
  }

  let clicked = false
  for (const sel of submitSelectors) {
    const el = await page.$(sel)
    if (el) {
      log(`Clicking submit "${sel}"`)
      await el.click()
      clicked = true
      break
    }
  }
  if (!clicked) throw new Error(`Could not find submit button`)

  log('Waiting for login form to disappear (password field gone)…')
  try {
    await page.waitForSelector('input[type="password"]', { state: 'detached', timeout: 30000 })
  } catch (e: any) {
    await saveDebugArtifacts(page, 'login-failed')
    const errorText = await page.locator('.alert, .flash, .error, [role="alert"], .help-block').first().textContent().catch(() => null)
    throw new Error(`Login failed — password field still visible after 30s. Error message: "${errorText?.trim() || 'none'}"`)
  }

  try {
    await page.waitForLoadState('domcontentloaded', { timeout: 10000 })
  } catch { /* not critical */ }

  log(`Login OK — landed on ${page.url()}`)
  await saveDebugArtifacts(page, 'login-success')
}

// ── Download ───────────────────────────────────────────────────────────
//
// New approach (much simpler than the goto + Promise.all dance):
// We register a download listener on the BrowserContext, then trigger
// navigation by injecting a hidden anchor and clicking it. The browser
// handles the download natively without us having to wrangle goto's
// "download started" exceptions.

async function downloadReport(context: BrowserContext, page: Page): Promise<{ filename: string; buffer: Buffer }> {
  const reportUrl = buildReportUrl()
  log(`Triggering download by clicking injected anchor: ${reportUrl}`)

  // Set up the download listener BEFORE triggering. We listen on the context
  // so we catch the download regardless of which page it fires on.
  const downloadPromise = context.waitForEvent('download', { timeout: 60000 })

  // Inject an <a> tag pointing at the download URL and click it. This is
  // exactly what a human user would do (clicking a download link), so the
  // browser handles it cleanly without any abort exceptions on the page.
  await page.evaluate((url) => {
    const a = document.createElement('a')
    a.href = url
    a.download = ''  // force download attribute
    a.style.display = 'none'
    document.body.appendChild(a)
    a.click()
    // Don't remove immediately — give the browser a tick to register the click
    setTimeout(() => a.remove(), 1000)
  }, reportUrl)

  let download: Download
  try {
    download = await downloadPromise
  } catch (e: any) {
    await saveDebugArtifacts(page, 'download-failed')
    throw new Error(`Download did not arrive within 60s: ${e?.message || e}`)
  }

  const filename = download.suggestedFilename() || `job_report_${Date.now()}.xls`
  const tmpPath = join(ARTIFACT_DIR, `dl-${filename}`)
  if (!existsSync(ARTIFACT_DIR)) mkdirSync(ARTIFACT_DIR, { recursive: true })

  // download.failure() returns null if successful, error string if failed
  const failure = await download.failure()
  if (failure) {
    await saveDebugArtifacts(page, 'download-failure-after-arrival')
    throw new Error(`Download failed mid-stream: ${failure}`)
  }

  await download.saveAs(tmpPath)
  const buffer = readFileSync(tmpPath)

  if (buffer.length < 1024) {
    log(`Suspiciously small download (${buffer.length} bytes). First 200 bytes: ${buffer.slice(0, 200).toString('utf8')}`)
    throw new Error(`Downloaded file is suspiciously small (${buffer.length} bytes) — likely a login redirect or error page`)
  }

  log(`Downloaded ${filename} (${(buffer.length / 1024).toFixed(1)} KB)`)
  return { filename, buffer }
}

// ── Upload ─────────────────────────────────────────────────────────────

async function uploadToPortal(filename: string, buffer: Buffer): Promise<{ jobCount: number; runId: string; warnings: string[] }> {
  const baseUrl = process.env.JA_PORTAL_BASE_URL
  const apiKey = process.env.JA_PORTAL_API_KEY
  if (!baseUrl) throw new Error('JA_PORTAL_BASE_URL env var is required')
  if (!apiKey) throw new Error('JA_PORTAL_API_KEY env var is required')

  const url = `${baseUrl.replace(/\/+$/, '')}${PORTAL_UPLOAD_PATH}`
  log(`Uploading to ${url}`)

  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Service-Token': apiKey },
    body: JSON.stringify({
      filename,
      file_base64: buffer.toString('base64'),
      notes: `GitHub Actions auto-pull · run ${process.env.GITHUB_RUN_ID || 'local'} · ${new Date().toISOString()}`,
    }),
  })

  const responseText = await r.text()
  let body: any
  try { body = JSON.parse(responseText) } catch { body = { raw: responseText } }

  if (!r.ok) throw new Error(`Portal upload failed (${r.status}): ${body.error || responseText.slice(0, 500)}`)
  if (!body.ok || !body.run_id) throw new Error(`Portal returned 200 but response is malformed: ${responseText.slice(0, 500)}`)

  log(`Portal accepted: ${body.job_count} jobs, run_id ${body.run_id}, warnings: ${body.warnings?.length || 0}`)
  return { jobCount: body.job_count, runId: body.run_id, warnings: body.warnings || [] }
}

// ── Main ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const workshopId = process.env.MECHANICDESK_WORKSHOP_ID
  const username = process.env.MECHANICDESK_USERNAME
  const password = process.env.MECHANICDESK_PASSWORD
  if (!workshopId || !username || !password) {
    throw new Error('MECHANICDESK_WORKSHOP_ID, MECHANICDESK_USERNAME and MECHANICDESK_PASSWORD env vars are all required')
  }

  let browser: Browser | null = null
  try {
    log('Launching headless Chromium')
    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      acceptDownloads: true,
      viewport: { width: 1280, height: 900 },
    })
    const page = await context.newPage()

    await login(page, workshopId, username, password)
    const { filename, buffer } = await downloadReport(context, page)
    const result = await uploadToPortal(filename, buffer)

    const summary = `Pulled "${filename}" — ${result.jobCount} jobs ingested${result.warnings.length ? ` (${result.warnings.length} warnings)` : ''}`
    log(summary)

    if (process.env.SLACK_NOTIFY_ON_SUCCESS === '1') {
      await notifySlack(summary, false)
    }

    process.exit(0)
  } catch (e: any) {
    const msg = e?.message || String(e)
    log(`FATAL: ${msg}`)
    if (e?.stack) log(e.stack)
    try {
      await notifySlack(msg, true)
    } catch (notifyErr: any) {
      log(`Slack notification ALSO failed: ${notifyErr?.message || notifyErr}`)
      if (browser) await browser.close().catch(() => undefined)
      process.exit(2)
    }
    if (browser) await browser.close().catch(() => undefined)
    process.exit(1)
  } finally {
    if (browser) await browser.close().catch(() => undefined)
  }
}

main()
