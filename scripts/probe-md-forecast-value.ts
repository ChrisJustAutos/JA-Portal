// scripts/probe-md-forecast-value.ts
//
// Diagnostic for the Sales Recap forecast values (2026-07-29): future-month
// bookings show jobCount but $0 — /jobs/{id} invoice.total_amount and
// total_amount are both empty for uninvoiced forward jobs. This probe pulls a
// handful of forward diary rows + their job JSON and dumps every money-ish
// field (and the diary row's own fields) so we can pick the right value
// source (the original recon noted a `quote` field that was never wired).
// Structure + numbers only — no customer names/notes to CI logs.

import { loginToMechanicDesk, type MdClient } from '../lib/mechanicdesk-stocktake'

const WS_ID = process.env.MECHANICDESK_WORKSHOP_ID || ''
const MD_USER = process.env.MECHANICDESK_USERNAME || ''
const MD_PASS = process.env.MECHANICDESK_PASSWORD || ''
const MD_BASE = 'https://www.mechanicdesk.com.au'
if (!WS_ID || !MD_USER || !MD_PASS) throw new Error('MECHANICDESK_* env vars required')

async function mdGet(client: MdClient, path: string) {
  const r = await fetch(`${MD_BASE}${path}`, {
    headers: { Cookie: client.cookieHeader, Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', Referer: `${MD_BASE}/auto_workshop/app`, 'User-Agent': 'Mozilla/5.0 (JA probe)' },
  })
  const t = await r.text(); let j: any = null; try { j = JSON.parse(t) } catch {}
  return { status: r.status, json: j }
}

// Every numeric-looking field anywhere in the object, path-flattened, plus
// short type notes for objects/arrays that might hold the value.
function moneyish(o: any, prefix = '', out: string[] = [], depth = 0): string[] {
  if (!o || typeof o !== 'object' || depth > 3) return out
  for (const [k, v] of Object.entries(o)) {
    const p = prefix ? `${prefix}.${k}` : k
    if (typeof v === 'number' && (Math.abs(v) > 0.001)) out.push(`${p}=${v}`)
    else if (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v) && Number(v) > 0) out.push(`${p}="${v}"`)
    else if (Array.isArray(v)) {
      if (v.length && /item|line|task|part|labou?r|product/i.test(k)) {
        out.push(`${p}=arr[${v.length}]`)
        moneyish(v[0], `${p}[0]`, out, depth + 1)
      }
    } else if (v && typeof v === 'object' && /quote|invoice|estimate|total|amount|booking/i.test(k)) {
      out.push(`${p}={${Object.keys(v).join(',')}}`)
      moneyish(v, p, out, depth + 1)
    }
  }
  return out
}

async function main() {
  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ headless: true })
  try {
    const { client } = await loginToMechanicDesk(browser, WS_ID, MD_USER, MD_PASS)
    console.log('MD login ok')

    // Forward window: next month (fully uninvoiced jobs).
    const from = new Date(); from.setDate(from.getDate() + 14)
    const to = new Date(from); to.setDate(from.getDate() + 45)
    const diary = await mdGet(client, `/auto_workshop/diary?start=${encodeURIComponent(from.toISOString())}&end=${encodeURIComponent(to.toISOString())}`)
    console.log(`diary → ${diary.status}; bookings=${diary.json?.bookings?.length ?? '—'} jobs=${diary.json?.jobs?.length ?? '—'}`)
    const rows: any[] = [...(diary.json?.bookings || []), ...(diary.json?.jobs || [])].filter(r => !r?.deleted)

    for (const r of rows.slice(0, 6)) {
      const jid = Number(r?.job_id ?? r?.id)
      console.log(`\n=== diary row job ${jid} (sched ${String(r?.time || r?.start).slice(0, 10)}) — row money fields:`)
      console.log('  ' + (moneyish(r).join('  ') || '(none)'))
      if (!jid) continue
      const j = await mdGet(client, `/jobs/${jid}?id=${jid}`)
      console.log(`  /jobs/${jid} → ${j.status}; money fields:`)
      const fields = moneyish(j.json)
      for (let i = 0; i < fields.length; i += 6) console.log('  ' + fields.slice(i, i + 6).join('  '))
      if (!fields.length) console.log('  (none found)')
    }
  } finally {
    await browser.close()
  }
}
main().catch(e => { console.error('FATAL', e); process.exit(1) })
