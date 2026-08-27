// scripts/probe-md-started-jobs.ts
//
// Follow-up recon for the Stocktake (MD) "parts on cars" checker.
//
// Chris's definition, 2026-08-27: it must be parts on a car that is ACTUALLY
// HERE — a STARTED job — not merely any job that happens to have an invoice
// with parts on it. A booking for next Tuesday with parts already listed does
// not count; that car is still in the customer's driveway.
//
// The first probe established:
//   • no usable jobs-list endpoint (/auto_workshop/* 404, /jobs.json 504s), so
//     enumeration has to come off the diary;
//   • on_hand − available_quantity == allocated_quantity exactly (30/30), so
//     MD's allocation is computable from the cached stock list — but allocation
//     covers future bookings too, which is precisely what Chris ruled out;
//   • the only statuses a weekly sample caught were 'finished' and 'preparing'.
//
// So the one thing left is the STATUS VOCABULARY, and which of those values
// means "the car is in the workshop and work has started". This probe sweeps
// the diary DAILY over a recent window (weekly sampling missed live jobs) and,
// for every job that isn't finished, reports status + the flags that decide
// whether stock has already left the books.
//
// Structure and enum values only — no customer names or regos in the log.

import { loginToMechanicDesk, type MdClient } from '../lib/mechanicdesk-stocktake'

const WS_ID = process.env.MECHANICDESK_WORKSHOP_ID || ''
const MD_USER = process.env.MECHANICDESK_USERNAME || ''
const MD_PASS = process.env.MECHANICDESK_PASSWORD || ''
const MD_BASE = 'https://www.mechanicdesk.com.au'
const BACK_DAYS = Number(process.env.BACK_DAYS || 45)
const FWD_DAYS = Number(process.env.FWD_DAYS || 14)
if (!WS_ID || !MD_USER || !MD_PASS) throw new Error('MECHANICDESK_* env vars required')

async function mdGet(client: MdClient, path: string) {
  const r = await fetch(`${MD_BASE}${path}`, {
    headers: {
      Cookie: client.cookieHeader, Accept: 'application/json',
      'X-Requested-With': 'XMLHttpRequest', Referer: `${MD_BASE}/auto_workshop/app`,
      'User-Agent': 'Mozilla/5.0 (JA probe)',
    },
  })
  const t = await r.text()
  let j: any = null
  try { j = JSON.parse(t) } catch {}
  return { status: r.status, json: j, head: j ? '' : t.slice(0, 90).replace(/\s+/g, ' ') }
}

const isoAU = (d: Date, end = false) => `${d.toISOString().slice(0, 10)}T${end ? '23:59:59' : '00:00:00'}+10:00`
const line = (s: string) => console.log(`\n${'─'.repeat(72)}\n${s}\n${'─'.repeat(72)}`)

async function mapPool<I, O>(items: I[], limit: number, fn: (i: I) => Promise<O>): Promise<O[]> {
  const out: O[] = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]) }
  }))
  return out
}

async function main() {
  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ headless: true })
  try {
    const { client } = await loginToMechanicDesk(browser, WS_ID, MD_USER, MD_PASS)
    const check = await mdGet(client, '/stocks.json?page=1')
    if (check.status !== 200) throw new Error(`session check failed: ${check.status}`)
    console.log('logged in OK — session verified')

    // ── sweep the diary DAILY ────────────────────────────────────────────
    line(`Q5 — daily diary sweep, back ${BACK_DAYS}d / forward ${FWD_DAYS}d`)
    const today = new Date()
    const days: Date[] = []
    for (let off = -BACK_DAYS; off <= FWD_DAYS; off++) {
      const d = new Date(today); d.setDate(d.getDate() + off); days.push(d)
    }
    const jobMeta = new Map<number, { status: string; day: string; future: boolean }>()
    const diaryStatus = new Map<string, number>()
    let ok = 0, bad = 0
    await mapPool(days, 6, async (d) => {
      const ymd = d.toISOString().slice(0, 10)
      const r = await mdGet(client, `/auto_workshop/diary?start=${encodeURIComponent(isoAU(d))}&end=${encodeURIComponent(isoAU(d, true))}`)
      if (r.status !== 200) { bad++; return }
      ok++
      for (const arr of [r.json?.bookings, r.json?.jobs]) {
        for (const row of (Array.isArray(arr) ? arr : [])) {
          const jid = Number(row?.job_id ?? row?.id)
          const st = String(row?.status ?? '(none)')
          diaryStatus.set(st, (diaryStatus.get(st) || 0) + 1)
          if (jid && isFinite(jid) && !jobMeta.has(jid)) {
            jobMeta.set(jid, { status: st, day: ymd, future: d > today })
          }
        }
      }
    })
    console.log(`  days 200/failed: ${ok}/${bad}`)
    console.log(`  DIARY STATUS VOCABULARY: ${JSON.stringify(Array.from(diaryStatus.entries()).sort((a, b) => b[1] - a[1]))}`)
    console.log(`  unique jobs: ${jobMeta.size}`)

    // ── job detail for everything not already finished ───────────────────
    line('Q6 — non-finished jobs: status vs stock-deduction flags vs parts')
    const candidates = Array.from(jobMeta.entries()).filter(([, m]) => m.status !== 'finished')
    console.log(`  ${candidates.length} job(s) with a non-finished diary status`)

    const details = await mapPool(candidates, 8, async ([jid, m]) => {
      const r = await mdGet(client, `/jobs/${jid}?id=${jid}`)
      if (r.status !== 200 || !r.json) return null
      const j = r.json
      const inv = j?.invoice || {}
      const items = Array.isArray(inv?.items) ? inv.items : []
      const tracked = items.filter((it: any) => it?.stock && it.stock.disable_tracking !== true && it?.stock_id && Number(it.quantity) > 0)
      return {
        job: jid,
        diary_status: m.status,
        future_booking: m.future,
        job_status: j?.status ?? null,
        finished: j?.finished ?? null,
        finished_time: j?.finished_time ? String(j.finished_time).slice(0, 10) : null,
        on_hold: j?.on_hold ?? null,
        inv_status: inv?.status ?? null,
        inv_finalized: inv?.finalized ?? null,
        inv_number: inv?.number ?? null,
        paid: j?.paid ?? null,
        tracked_lines: tracked.length,
        tracked_qty: Math.round(tracked.reduce((s: number, it: any) => s + (Number(it.quantity) || 0), 0) * 100) / 100,
      }
    })
    const rows = details.filter(Boolean) as any[]
    console.table(rows)

    // ── the shape of the answer under Chris's definition ─────────────────
    line('Q7 — candidate rule: not finished + invoice not finalized + has tracked parts')
    const live = rows.filter(r => r.finished !== true && r.inv_finalized !== true && r.tracked_lines > 0)
    const livePast = live.filter(r => !r.future_booking)
    const liveFuture = live.filter(r => r.future_booking)
    console.log(`  matching jobs: ${live.length}  (dated today-or-earlier: ${livePast.length}, future bookings: ${liveFuture.length})`)
    console.log(`  units on those jobs: past/today ${livePast.reduce((s, r) => s + r.tracked_qty, 0)}, future ${liveFuture.reduce((s, r) => s + r.tracked_qty, 0)}`)
    console.log(`  >> statuses among matching: ${JSON.stringify(Array.from(new Set(live.map(r => `${r.diary_status}/${r.job_status}`))))}`)
    console.log('  (future-booking rows are the ones Chris excludes — the car is not here yet)')

    // Cross-check against MD's own allocation total.
    line('Q8 — how the job-walk total compares with MD allocation (upper bound)')
    console.log('  MD allocation counts EVERY job with parts, including future bookings,')
    console.log('  so allocation should exceed the started-jobs figure. Portal-side compare:')
    console.log(`  started-jobs units (today-or-earlier, unfinalized): ${livePast.reduce((s, r) => s + r.tracked_qty, 0)}`)

    console.log('\nprobe complete')
  } finally {
    await browser.close()
  }
}

main().catch(e => { console.error('probe failed:', e?.message || e); process.exit(1) })
