// scripts/run-sales-recap.ts
//
// Weekly Sales Recap runner (GH-Actions, Mon 7am Brisbane). The ONLY thing
// that needs Playwright is the MechanicDesk scrape (diary notes + forward
// forecast) — so this worker does just that, then POSTs the MD data to
// /api/reports/sales-recap/generate, which pulls Monday, assembles, renders,
// stores + emails the report.
//
// Env: MECHANICDESK_WORKSHOP_ID/USERNAME/PASSWORD, JA_PORTAL_BASE_URL,
//      JA_PORTAL_API_KEY, plus (optional) DRY_RUN=1, FORECAST_MONTHS.

import { loginToMechanicDesk, fetchDiaryNotes, fetchForwardBookingForecast } from '../lib/mechanicdesk-stocktake'

const WS_ID = process.env.MECHANICDESK_WORKSHOP_ID || ''
const MD_USER = process.env.MECHANICDESK_USERNAME || ''
const MD_PASS = process.env.MECHANICDESK_PASSWORD || ''
const PORTAL = process.env.JA_PORTAL_BASE_URL || ''
const TOKEN = process.env.JA_PORTAL_API_KEY || ''
const DRY_RUN = process.env.DRY_RUN === '1'
const SEND_EMAIL = process.env.SEND_EMAIL === '1' // false → store only ("refresh" dispatch)
// MD_REFRESH=1 → intraday mode: scrape MD, POST to md-refresh (updates the
// stored md_inputs only — no report regeneration, no email). Runs every ~2h
// on trading days so the live Sales Report tracks same-day bookings.
const MD_REFRESH = process.env.MD_REFRESH === '1'
const FORECAST_MONTHS = Math.max(1, Number(process.env.FORECAST_MONTHS) || 6)

if (!WS_ID || !MD_USER || !MD_PASS) throw new Error('MECHANICDESK_* env vars required')
if (!PORTAL || !TOKEN) throw new Error('JA_PORTAL_BASE_URL + JA_PORTAL_API_KEY required')

const log = (m: string) => console.log(new Date().toISOString(), m)

// The recap covers the previous trading week — its diary notes are that week's.
function prevWeek(): { start: string; end: string } {
  const b = new Date(Date.now() + 10 * 3600 * 1000)
  const dow = b.getUTCDay()
  const thisMon = new Date(Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate() - ((dow + 6) % 7)))
  const lastMon = new Date(thisMon); lastMon.setUTCDate(thisMon.getUTCDate() - 7)
  const lastFri = new Date(lastMon); lastFri.setUTCDate(lastMon.getUTCDate() + 4)
  return { start: lastMon.toISOString().slice(0, 10), end: lastFri.toISOString().slice(0, 10) }
}

async function main() {
  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ headless: true })
  try {
    const { client } = await loginToMechanicDesk(browser, WS_ID, MD_USER, MD_PASS)
    log('MD login ok')
    // MD is single-session-per-employee: another portal MD worker logging in
    // mid-scrape kills our cookie and 401s the rest of the per-job fetches
    // (this zeroed every future forecast month, 2026-07-29). The forecast
    // fetcher calls this to grab a fresh session and retry.
    const relogin = async () => {
      const l = await loginToMechanicDesk(browser, WS_ID, MD_USER, MD_PASS)
      client.cookieHeader = l.client.cookieHeader
      client.csrfToken = l.client.csrfToken
    }

    const wk = prevWeek()
    // Refresh mode scrapes a two-week diary window (previous + current week)
    // so both the "previous" and live "current" report views have notes.
    const diaryEnd = MD_REFRESH
      ? new Date(Date.parse(wk.end + 'T00:00:00Z') + 7 * 86400_000).toISOString().slice(0, 10)
      : wk.end
    const diaryNotes = await fetchDiaryNotes(client, wk.start, diaryEnd)
    log(`diary notes: ${diaryNotes.length}`)

    const todayYmd = new Date(Date.now() + 10 * 3600 * 1000).toISOString().slice(0, 10)
    const forecast = await fetchForwardBookingForecast(client, todayYmd, FORECAST_MONTHS, log, relogin)
    log(`forecast months: ${forecast.length}`)

    if (MD_REFRESH) {
      const r = await fetch(`${PORTAL}/api/reports/sales-recap/md-refresh`, {
        method: 'POST',
        headers: { 'X-Service-Token': TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ diaryNotes, forecast }),
      })
      const out = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(`md-refresh ${r.status}: ${JSON.stringify(out).slice(0, 300)}`)
      log(`MD REFRESH DONE: ok=${out.ok} notes=${out.diaryNotes} months=${out.forecastMonths}${out.note ? ` note=${out.note}` : ''}`)
      return
    }

    const r = await fetch(`${PORTAL}/api/reports/sales-recap/generate`, {
      method: 'POST',
      headers: { 'X-Service-Token': TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ diaryNotes, forecast, dryRun: DRY_RUN, email: SEND_EMAIL }),
    })
    const out = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(`generate ${r.status}: ${JSON.stringify(out).slice(0, 300)}`)
    log(`DONE: ok=${out.ok} dryRun=${out.dryRun} week=${JSON.stringify(out.week)}`)

    // On a dry run, dump the full assembled recap to the GH step summary so the
    // numbers can be eyeballed against the source docs without emailing/storing.
    if (DRY_RUN && out.recap) {
      console.log('RECAP_JSON ' + JSON.stringify(out.recap))
      if (process.env.GITHUB_STEP_SUMMARY) {
        const { writeFileSync } = await import('fs')
        writeFileSync(process.env.GITHUB_STEP_SUMMARY,
          '## Sales Recap — dry run\n\n```json\n' + JSON.stringify(out.recap, null, 2) + '\n```\n', { flag: 'a' })
      }
    }
  } finally {
    await browser.close()
  }
}
main().catch(e => { console.error('FATAL', e); process.exit(1) })
