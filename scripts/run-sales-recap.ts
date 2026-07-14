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

    const wk = prevWeek()
    const diaryNotes = await fetchDiaryNotes(client, wk.start, wk.end)
    log(`diary notes: ${diaryNotes.length}`)

    const todayYmd = new Date(Date.now() + 10 * 3600 * 1000).toISOString().slice(0, 10)
    const forecast = await fetchForwardBookingForecast(client, todayYmd, FORECAST_MONTHS, log)
    log(`forecast months: ${forecast.length}`)

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
