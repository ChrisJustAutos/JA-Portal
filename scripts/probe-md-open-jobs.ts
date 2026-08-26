// scripts/probe-md-open-jobs.ts
//
// Recon for the Stocktake (MD) "parts on cars" checker: find every job that is
// still OPEN and read the tracked parts already applied to it, so a stocktake
// can explain "counted 4, MD says 6 — the other 2 are on the Hilux on hoist 3".
//
// The one thing this probe has to settle is ENUMERATION. Pre Pick walks the
// diary day by day (collectPrePickDemand), which is date-bounded — but a job
// that has sat open since April is exactly what this checker exists to catch.
// So: is there a jobs-LIST endpoint we can filter by status, or do we have to
// sweep the diary backwards?
//
// Questions, in priority order:
//   Q1  Does a jobs-list endpoint exist, and can it be filtered/paged?
//   Q2  What does `status` actually contain, and what marks a job closed?
//   Q3  Do /stocks.json list rows carry allocated_quantity, or only /stocks/{id}?
//       (a cheap allocated>0 scan would backstop anything enumeration misses)
//   Q4  On a real open job, what do the parts lines look like vs an invoiced one?
//
// Structure only — keys and safe scalars. No customer names, regos or notes
// reach the CI log.

import { loginToMechanicDesk, type MdClient } from '../lib/mechanicdesk-stocktake'

const WS_ID = process.env.MECHANICDESK_WORKSHOP_ID || ''
const MD_USER = process.env.MECHANICDESK_USERNAME || ''
const MD_PASS = process.env.MECHANICDESK_PASSWORD || ''
const MD_BASE = 'https://www.mechanicdesk.com.au'
if (!WS_ID || !MD_USER || !MD_PASS) throw new Error('MECHANICDESK_* env vars required')

// ── redaction helpers (same convention as probe-md-diary-jobs) ─────────────
const keysOf = (v: any): any =>
  Array.isArray(v) ? (v.length ? [`array[${v.length}]`, keysOf(v[0])] : 'array[0]')
  : (v && typeof v === 'object') ? Object.keys(v)
  : typeof v

const SAFE = /^(id|.*_id|status|state|quantity|.*_quantity|.*_qty|stock_number|job_number|invoice_number|disable_tracking|deleted|archived|completed|closed|invoiced|is_.*|has_.*|total_amount|buy_price|sell_price|page|per_page|total|total_pages|count)$/i

function scalars(o: any): any {
  if (!o || typeof o !== 'object') return {}
  const out: any = {}
  for (const [k, val] of Object.entries(o)) {
    if (val === null) { out[k] = null; continue }
    if (typeof val === 'number' || typeof val === 'boolean') { out[k] = val; continue }
    if (typeof val === 'string') {
      // Dates, numbers and known-safe enum-ish fields verbatim; everything else length-only.
      if (SAFE.test(k) || /^\d{4}-\d\d-\d\d/.test(val) || /^\d+(\.\d+)?$/.test(val)) out[k] = val
      else out[k] = `str(${val.length})`
      continue
    }
    out[k] = Array.isArray(val) ? `arr[${(val as any[]).length}]` : 'obj'
  }
  return out
}

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
  const ct = r.headers.get('content-type') || ''
  return { status: r.status, json: j, ct, head: j ? '' : t.slice(0, 100).replace(/\s+/g, ' ') }
}

const isoAU = (d: Date, end = false) => `${d.toISOString().slice(0, 10)}T${end ? '23:59:59' : '00:00:00'}+10:00`
const line = (s: string) => console.log(`\n${'─'.repeat(72)}\n${s}\n${'─'.repeat(72)}`)

async function main() {
  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ headless: true })
  try {
    const client = await loginToMechanicDesk(browser, WS_ID, MD_USER, MD_PASS)
    console.log('logged in OK')

    // ── Q1: is there a jobs-list endpoint? ────────────────────────────────
    line('Q1 — jobs-list endpoint candidates')
    const listCandidates = [
      '/jobs.json?page=1',
      '/jobs.json?page=1&per_page=5',
      '/jobs.json?page=1&status=open',
      '/jobs.json?page=1&open=true',
      '/jobs.json?page=1&completed=false',
      '/jobs?page=1',
      '/auto_workshop/jobs',
      '/auto_workshop/jobs.json',
      '/auto_workshop/jobs.json?page=1',
      '/auto_workshop/job_list',
      '/auto_workshop/open_jobs',
      '/auto_workshop/current_jobs',
      '/auto_workshop/workshop_jobs',
      '/auto_workshop/jobs_in_progress',
      '/workshop_jobs.json?page=1',
      // MD's "Job Board"/WIP screens are the most likely home of an open-job list.
      '/auto_workshop/job_board',
      '/auto_workshop/job_board.json',
      '/auto_workshop/wip',
      '/auto_workshop/kanban',
    ]
    for (const p of listCandidates) {
      const r = await mdGet(client, p)
      const shape = r.json ? JSON.stringify(keysOf(r.json)).slice(0, 220) : `(${r.ct.split(';')[0]}) ${r.head}`
      console.log(`  ${String(r.status).padEnd(4)} ${p.padEnd(46)} ${shape}`)
      if (r.status === 200 && r.json) {
        const arr = Array.isArray(r.json) ? r.json
          : Array.isArray(r.json?.jobs) ? r.json.jobs
          : Array.isArray(r.json?.data) ? r.json.data : null
        if (arr && arr.length) {
          console.log(`       first row scalars: ${JSON.stringify(scalars(arr[0])).slice(0, 700)}`)
          const statuses = Array.from(new Set(arr.map((x: any) => String(x?.status ?? x?.state ?? '?'))))
          console.log(`       statuses in page: ${JSON.stringify(statuses).slice(0, 300)}  (rows=${arr.length})`)
        }
      }
    }

    // ── Q2: status vocabulary, from a wide diary sweep ────────────────────
    line('Q2 — status values seen across a 180-day diary sweep (back 150d, fwd 30d)')
    const today = new Date()
    const statusCount = new Map<string, number>()
    const jobIds: number[] = []
    const seen = new Set<number>()
    // Sample weekly rather than daily — we want the status vocabulary and a
    // pool of candidate job ids, not a complete census.
    for (let off = -150; off <= 30; off += 7) {
      const d = new Date(today); d.setDate(d.getDate() + off)
      const r = await mdGet(client, `/auto_workshop/diary?start=${encodeURIComponent(isoAU(d))}&end=${encodeURIComponent(isoAU(d, true))}`)
      for (const arr of [r.json?.bookings, r.json?.jobs]) {
        for (const row of (Array.isArray(arr) ? arr : [])) {
          const jid = Number(row?.job_id ?? row?.id)
          const st = String(row?.status ?? '(none)')
          statusCount.set(st, (statusCount.get(st) || 0) + 1)
          if (jid && isFinite(jid) && !seen.has(jid)) { seen.add(jid); jobIds.push(jid) }
        }
      }
    }
    console.log(`  diary rows by status: ${JSON.stringify(Array.from(statusCount.entries()).sort((a, b) => b[1] - a[1]))}`)
    console.log(`  unique job ids collected: ${jobIds.length}`)

    // ── Q4: what distinguishes open from invoiced on the job detail? ──────
    line('Q4 — /jobs/{id} shape: which fields mark a job closed/invoiced')
    const sample = jobIds.slice(0, 12)
    const summaries: any[] = []
    for (const jid of sample) {
      const r = await mdGet(client, `/jobs/${jid}?id=${jid}`)
      if (r.status !== 200 || !r.json) { console.log(`  job ${jid} → ${r.status}`); continue }
      const j = r.json
      const inv = j?.invoice || {}
      const items = Array.isArray(inv?.items) ? inv.items : []
      const tracked = items.filter((it: any) => it?.stock && it.stock.disable_tracking !== true && it?.stock_id && Number(it.quantity) > 0)
      const trackedQty = tracked.reduce((s: number, it: any) => s + (Number(it.quantity) || 0), 0)
      summaries.push({
        job: jid,
        job_status: j?.status ?? null,
        invoice_status: inv?.status ?? null,
        invoice_number: inv?.invoice_number ?? null,
        invoiced_at: inv?.invoiced_at ?? inv?.invoice_date ?? null,
        paid: inv?.paid ?? inv?.is_paid ?? null,
        completed: j?.completed ?? j?.completed_at ?? null,
        tracked_lines: tracked.length,
        tracked_qty: trackedQty,
      })
    }
    console.table(summaries)
    // Full key dump of one job so we can see every candidate "is closed" flag.
    if (sample.length) {
      const r = await mdGet(client, `/jobs/${sample[0]}?id=${sample[0]}`)
      if (r.json) {
        console.log(`\n  job ${sample[0]} top-level keys: ${JSON.stringify(keysOf(r.json)).slice(0, 600)}`)
        console.log(`  job scalars: ${JSON.stringify(scalars(r.json)).slice(0, 900)}`)
        if (r.json.invoice) console.log(`  invoice scalars: ${JSON.stringify(scalars(r.json.invoice)).slice(0, 900)}`)
        const it0 = (r.json.invoice?.items || [])[0]
        if (it0) {
          console.log(`  item[0] scalars: ${JSON.stringify(scalars(it0)).slice(0, 600)}`)
          if (it0.stock) console.log(`  item[0].stock scalars: ${JSON.stringify(scalars(it0.stock)).slice(0, 700)}`)
        }
      }
    }

    // ── Q3: does the stocks LIST carry allocated_quantity? ────────────────
    line('Q3 — allocated_quantity on the stocks list vs the stock detail')
    const sl = await mdGet(client, '/stocks.json?page=1')
    const stocks = Array.isArray(sl.json) ? sl.json : (sl.json?.stocks || sl.json?.data || [])
    console.log(`  /stocks.json?page=1 → ${sl.status}, rows=${Array.isArray(stocks) ? stocks.length : 'n/a'}`)
    if (Array.isArray(stocks) && stocks.length) {
      const keys = Object.keys(stocks[0])
      console.log(`  list row keys: ${JSON.stringify(keys).slice(0, 700)}`)
      const hasAlloc = keys.some(k => /allocated/i.test(k))
      const hasAvail = keys.some(k => /available/i.test(k))
      console.log(`  >> list carries allocated_quantity: ${hasAlloc}; available_quantity: ${hasAvail}`)
      const sid = Number(stocks[0]?.id)
      if (sid) {
        const d = await mdGet(client, `/stocks/${sid}`)
        if (d.json) {
          const dk = Object.keys(d.json).filter(k => /quantity|allocated|available|ordered/i.test(k))
          console.log(`  /stocks/${sid} qty-ish fields: ${JSON.stringify(dk)}`)
          console.log(`  /stocks/${sid} values: ${JSON.stringify(scalars(d.json)).slice(0, 500)}`)
        }
      }
      // How many of a page of stocks have allocation? Tells us if an
      // allocated>0 scan is cheap enough to be a real backstop.
      const probeIds = stocks.slice(0, 25).map((s: any) => Number(s.id)).filter(Boolean)
      let allocated = 0, checked = 0
      for (const sid2 of probeIds) {
        const d = await mdGet(client, `/stocks/${sid2}`)
        if (d.json) { checked++; if (Number(d.json.allocated_quantity) > 0) allocated++ }
      }
      console.log(`  of ${checked} sampled stock items, ${allocated} have allocated_quantity > 0`)
    }

    // Total catalogue size — decides whether a full allocated scan is viable.
    line('Q3b — how big is the stock catalogue (cost of a full allocated scan)?')
    for (const p of ['/stocks.json?page=1&per_page=1', '/stocks.json?page=999']) {
      const r = await mdGet(client, p)
      const arr = Array.isArray(r.json) ? r.json : (r.json?.stocks || r.json?.data || [])
      console.log(`  ${p} → ${r.status}, rows=${Array.isArray(arr) ? arr.length : 'n/a'}, meta=${JSON.stringify(scalars(Array.isArray(r.json) ? {} : r.json)).slice(0, 200)}`)
    }

    console.log('\nprobe complete')
  } finally {
    await browser.close()
  }
}

main().catch(e => { console.error('probe failed:', e?.message || e); process.exit(1) })
