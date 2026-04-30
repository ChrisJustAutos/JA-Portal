// scripts/pull-mechanicdesk-report.ts
// Headless Chromium task that:
//   1. Logs into Mechanics Desk
//   2. Downloads the Job Report XLSX (rolling date range)
//   3. POSTs it to the JA Portal upload endpoint
//
// Run via GitHub Actions on a schedule. See .github/workflows/mechanicdesk-pull.yml.
//
// Required env vars:
//   MECHANICDESK_USERNAME       — login email
//   MECHANICDESK_PASSWORD       — login password
//   JA_PORTAL_API_KEY           — service token with scope 'upload:job-report'
//   JA_PORTAL_BASE_URL          — e.g. https://ja-portal.vercel.app
//   SLACK_WEBHOOK_URL           — incoming webhook for failure notifications (optional)
//
// Exit codes:
//   0  — success (or already-up-to-date)
//   1  — failure that was reported to Slack
//   2  — failure that could NOT be reported (e.g. Slack webhook itself failed)

import { chromium, Browser, BrowserContext, Page, Download } from 'playwright'
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'

// ── Config ─────────────────────────────────────────────────────────────

const MD_BASE = 'https://www.mechanicdesk.com.au'
const MD_LOGIN_URL = `${MD_BASE}/users/sign_in`
// Date range: today minus 30 days through today plus 365 days.
// Format the URL exactly as Mechanics Desk uses (matches what the
// browser's natural download flow generates).
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
  // Mechanics Desk expects a string formatted like JS Date.toString() with a
  // specific timezone marker. The format that the UI generates is:
  //   "Tue Mar 31 2026 00:00:00 GMT+1000 (Australian Eastern Standard Time)"
  // We replicate that format.
  const fmt = (d: Date): string => {
    // Force AEST (UTC+10, no DST in QLD). All MD reporting runs on this offset.
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
    if (!r.ok) {
      log(`Slack webhook returned ${r.status}: ${await r.text().catch(() => '')}`)
    }
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

// ── Main flow ──────────────────────────────────────────────────────────

async function login(page: Page, username: string, password: string): Promise<void> {
  log(`Navigating to ${MD_LOGIN_URL}`)
  await page.goto(MD_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 })

  // Mechanics Desk uses Devise — typical field names are user[email] and user[password].
  // We try the most common selectors first; if MD changes the UI, this is the
  // first place to update.
  const emailSelectors = ['input[name="user[email]"]', 'input[type="email"]', 'input#user_email']
  const passwordSelectors = ['input[name="user[password]"]', 'input[type="password"]', 'input#user_password']
  const submitSelectors = ['input[type="submit"]', 'button[type="submit"]', 'button:has-text("Sign in")', 'button:has-text("Log in")']

  async function fillFirst(selectors: string[], value: string, label: string) {
    for (const sel of selectors) {
      const el = await page.$(sel)
      if (el) { await el.fill(value); log(`Filled ${label} via "${sel}"`); return }
    }
    throw new Error(`Could not find ${label} field. Tried: ${selectors.join(', ')}`)
  }

  await fillFirst(emailSelectors, username, 'email')
  await fillFirst(passwordSelectors, password, 'password')

  // Submit and wait for navigation
  let submitted = false
  for (const sel of submitSelectors) {
    const el = await page.$(sel)
    if (el) {
      log(`Clicking submit "${sel}"`)
      await Promise.all([
        page.waitForLoadState('networkidle', { timeout: 30000 }),
        el.click(),
      ])
      submitted = true
      break
    }
  }
  if (!submitted) throw new Error(`Could not find submit button. Tried: ${submitSelectors.join(', ')}`)

  // Verify we're past login. Mechanics Desk redirects to /diary or /dashboard
  // on success; on failure it stays on /users/sign_in with a flash message.
  const url = page.url()
  if (url.includes('/users/sign_in') || url.includes('/sign_in')) {
    await saveDebugArtifacts(page, 'login-failed')
    // Try to extract the error message
    const errorText = await page.locator('.alert, .flash, .error, [role="alert"]').first().textContent().catch(() => null)
    throw new Error(`Login failed — still on sign-in page. Error: "${errorText || 'unknown'}"`)
  }

  log(`Login OK — landed on ${url}`)
}

async function downloadReport(context: BrowserContext): Promise<{ filename: string; buffer: Buffer }> {
  const reportUrl = buildReportUrl()
  log(`Triggering download: ${reportUrl}`)

  // Use a fresh page so the download handler is clean. The session cookies
  // from the login flow are shared via the context.
  const dlPage = await context.newPage()

  // Mechanics Desk responds with the file directly (no HTML page). Playwright's
  // download event will fire when the response is downloadable.
  let download: Download
  try {
    [download] = await Promise.all([
      dlPage.waitForEvent('download', { timeout: 60000 }),
      dlPage.goto(reportUrl, { waitUntil: 'commit', timeout: 60000 }).catch((e: Error) => {
        // page.goto often throws "net::ERR_ABORTED" once the download starts,
        // because the navigation aborts in favour of the file download.
        // That's expected — swallow it and let the download event resolve.
        if (!/ERR_ABORTED|interrupted|net::/i.test(e.message)) throw e
        log(`(expected) goto aborted by download: ${e.message}`)
        return null
      }),
    ])
  } catch (e: any) {
    await saveDebugArtifacts(dlPage, 'download-failed')
    throw new Error(`Download did not start: ${e?.message || e}`)
  }

  const filename = download.suggestedFilename() || `job_report_${Date.now()}.xls`

  // Stream the download to memory rather than disk
  const tmpPath = join(ARTIFACT_DIR, `dl-${filename}`)
  if (!existsSync(ARTIFACT_DIR)) mkdirSync(ARTIFACT_DIR, { recursive: true })
  await download.saveAs(tmpPath)
  const buffer = readFileSync(tmpPath)

  if (buffer.length < 1024) {
    throw new Error(`Downloaded file is suspiciously small (${buffer.length} bytes) — likely a login redirect or error page`)
  }

  log(`Downloaded ${filename} (${(buffer.length / 1024).toFixed(1)} KB)`)
  await dlPage.close()
  return { filename, buffer }
}

async function uploadToPortal(filename: string, buffer: Buffer): Promise<{ jobCount: number; runId: string; warnings: string[] }> {
  const baseUrl = process.env.JA_PORTAL_BASE_URL
  const apiKey = process.env.JA_PORTAL_API_KEY
  if (!baseUrl) throw new Error('JA_PORTAL_BASE_URL env var is required')
  if (!apiKey) throw new Error('JA_PORTAL_API_KEY env var is required')

  const url = `${baseUrl.replace(/\/+$/, '')}${PORTAL_UPLOAD_PATH}`
  log(`Uploading to ${url}`)

  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Service-Token': apiKey,
    },
    body: JSON.stringify({
      filename,
      file_base64: buffer.toString('base64'),
      notes: `GitHub Actions auto-pull · run ${process.env.GITHUB_RUN_ID || 'local'} · ${new Date().toISOString()}`,
    }),
  })

  const responseText = await r.text()
  let body: any
  try { body = JSON.parse(responseText) } catch { body = { raw: responseText } }

  if (!r.ok) {
    throw new Error(`Portal upload failed (${r.status}): ${body.error || responseText.slice(0, 500)}`)
  }
  if (!body.ok || !body.run_id) {
    throw new Error(`Portal returned 200 but response is malformed: ${responseText.slice(0, 500)}`)
  }

  log(`Portal accepted: ${body.job_count} jobs, run_id ${body.run_id}, warnings: ${body.warnings?.length || 0}`)
  return { jobCount: body.job_count, runId: body.run_id, warnings: body.warnings || [] }
}

async function main(): Promise<void> {
  const username = process.env.MECHANICDESK_USERNAME
  const password = process.env.MECHANICDESK_PASSWORD
  if (!username || !password) {
    throw new Error('MECHANICDESK_USERNAME and MECHANICDESK_PASSWORD env vars are required')
  }

  let browser: Browser | null = null
  try {
    log('Launching headless Chromium')
    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({
      // Modern desktop UA so MD doesn't serve us a mobile or "browser-too-old" page
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      acceptDownloads: true,
      viewport: { width: 1280, height: 900 },
    })
    const page = await context.newPage()

    await login(page, username, password)
    const { filename, buffer } = await downloadReport(context)
    const result = await uploadToPortal(filename, buffer)

    const summary = `Pulled "${filename}" — ${result.jobCount} jobs ingested${result.warnings.length ? ` (${result.warnings.length} warnings)` : ''}`
    log(summary)

    // Only ping Slack on success if env says so, otherwise stay quiet.
    // (Default: stay quiet on success, only alert on failure.)
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
