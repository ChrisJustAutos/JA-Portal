// lib/workshop-map-weekly-report.ts
//
// Weekly quotes & jobs GEOGRAPHY report (Chris 2026-07-07): every Monday
// morning a digest of where last week's quotes and booked jobs came from —
// locations, vehicle mix by region, emerging hotspots, quote-heavy areas that
// aren't booking — plus Claude's read on what it means and where to market.
// EMAILED to Matt (cc Ryan + Chris) with a link to the live map
// (Reports → Workshop Map).
//
// Data: md_quotes / md_invoices fact tables (filled by the daily MechanicDesk
// pull, scripts/pull-md-workshop-map.ts). Weekly counts are RAW rows (quotes
// as issued; jobs = non-noise invoices) — the 1-per-customer-month dedup only
// applies to the dashboard's conversion view, not this digest.
//
// Mirrors lib/calls-weekly-report.ts: aggregate → Claude narrative → deliver.

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { sendMail } from './email'
import { VEHICLE_CATS } from './workshop-map/vehicle-classification'

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'
const MODEL = () => (process.env.WORKSHOP_MAP_REPORT_MODEL || 'claude-sonnet-4-6').trim()
const splitEmails = (s: string) => s.split(/[,;\s]+/).map(x => x.trim()).filter(x => x.includes('@'))
const TO = () => splitEmails(process.env.WORKSHOP_MAP_REPORT_TO || 'matt.h@justautosmechanical.com.au')
const CC = () => splitEmails(process.env.WORKSHOP_MAP_REPORT_CC ?? 'ryan@justautosmechanical.com.au, chris@justautosmechanical.com.au')
// sendMail's mailbox arg is the Graph sender / Resend fallback-from.
const FROM_MAILBOX = () => (process.env.WORKSHOP_MAP_REPORT_FROM || process.env.AP_INBOX_MAILBOX || 'accounts@justautosmechanical.com.au').trim()
const MAP_URL = () => `${(process.env.PORTAL_PUBLIC_URL || 'https://justautos.app').replace(/\/+$/, '')}/reports/map`

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

const GROUP_NAME = Object.fromEntries(VEHICLE_CATS.map(c => [c.k, c.n]))
const r0 = (n: number) => Math.round(n)
const fmtK = (n: number) => n >= 1e6 ? '$' + (n / 1e6).toFixed(2) + 'M' : n >= 1000 ? '$' + (n / 1000).toFixed(n >= 100000 ? 0 : 1) + 'k' : '$' + Math.round(n)
const ymd = (d: Date) => d.toISOString().slice(0, 10)

interface LocAgg { l: string; state: string | null; n: number; val: number; groups: Record<string, number> }
interface SideAgg {
  count: number
  value: number
  geocoded: number
  byGroup: Record<string, { n: number; val: number }>
  byState: Record<string, { n: number; val: number }>
  topLocalities: LocAgg[]
}

function aggregate(rows: { group: string; amount: number; state: string | null; locality: string | null; suburb: string | null; lat: number | null }[]): SideAgg {
  const byGroup: SideAgg['byGroup'] = {}
  const byState: SideAgg['byState'] = {}
  const byLoc: Record<string, LocAgg> = {}
  let geocoded = 0, value = 0
  for (const r of rows) {
    value += r.amount
    if (r.lat != null) geocoded++
    const g = (byGroup[r.group] ||= { n: 0, val: 0 }); g.n++; g.val += r.amount
    const st = r.state || (r.lat != null ? '?' : 'unknown')
    const s = (byState[st] ||= { n: 0, val: 0 }); s.n++; s.val += r.amount
    const locName = r.locality || r.suburb
    if (locName) {
      const key = `${locName.toUpperCase()}|${r.state || ''}`
      const o = (byLoc[key] ||= { l: locName, state: r.state, n: 0, val: 0, groups: {} })
      o.n++; o.val += r.amount
      o.groups[r.group] = (o.groups[r.group] || 0) + 1
    }
  }
  for (const k of Object.keys(byGroup)) byGroup[k].val = r0(byGroup[k].val)
  for (const k of Object.keys(byState)) byState[k].val = r0(byState[k].val)
  const topLocalities = Object.values(byLoc).sort((a, b) => b.val - a.val).slice(0, 12)
    .map(o => ({ ...o, val: r0(o.val) }))
  return { count: rows.length, value: r0(value), geocoded, byGroup, byState, topLocalities }
}

export interface MapWeeklyResult {
  weekLabel: string
  quotes: number
  jobs: number
  posted: boolean
  costMicroUsd: number
  narrative?: any
  data?: any
}

async function fetchWindow(days: number) {
  const c = sb()
  const now = new Date()
  const from = ymd(new Date(now.getTime() - days * 86400_000))
  const baseFrom = ymd(new Date(now.getTime() - (days + 28) * 86400_000))
  const jobsSince90 = ymd(new Date(now.getTime() - 90 * 86400_000))

  // Weekly quote volume is a few hundred rows; 28-day baseline a couple of
  // thousand — single selects are fine.
  const { data: quotes, error: qErr } = await c.from('md_quotes')
    .select('quote_date, total_amount, vehicle_group, state, locality, suburb, lat, status, customer_name')
    .gte('quote_date', baseFrom).eq('missing', false).limit(10000)
  if (qErr) throw qErr
  const { data: invoices, error: iErr } = await c.from('md_invoices')
    .select('issue_date, total_amount, vehicle_group, state, locality, suburb, lat, is_noise, customer_name')
    .gte('issue_date', jobsSince90 < baseFrom ? jobsSince90 : baseFrom).eq('missing', false).limit(20000)
  if (iErr) throw iErr

  const norm = (r: any, dateKey: string) => ({
    date: String(r[dateKey] || ''),
    group: String(r.vehicle_group || 'OTH'),
    amount: Number(r.total_amount) || 0,
    state: r.state ? String(r.state) : null,
    locality: r.locality ? String(r.locality) : null,
    suburb: r.suburb ? String(r.suburb) : null,
    lat: r.lat as number | null,
  })
  const q = (quotes || []).map(r => norm(r, 'quote_date'))
  const j = (invoices || []).filter(r => !r.is_noise).map(r => norm(r, 'issue_date'))

  const weekQ = q.filter(r => r.date >= from)
  const weekJ = j.filter(r => r.date >= from)
  const baseQ = q.filter(r => r.date < from)               // prior ~4 weeks of quotes

  // Marketing-target candidates: localities quoting repeatedly over the last
  // ~5 weeks with NO booked job in the last 90 days.
  const jobLocs90 = new Set(j.map(r => (r.locality || r.suburb || '').toUpperCase()).filter(Boolean))
  const quoteLocCounts: Record<string, { l: string; state: string | null; n: number; val: number }> = {}
  for (const r of q) {
    const name = r.locality || r.suburb
    if (!name) continue
    const key = name.toUpperCase()
    const o = (quoteLocCounts[key] ||= { l: name, state: r.state, n: 0, val: 0 })
    o.n++; o.val += r.amount
  }
  const quotingNotBooking = Object.entries(quoteLocCounts)
    .filter(([k, v]) => v.n >= 3 && !jobLocs90.has(k))
    .map(([, v]) => ({ ...v, val: r0(v.val) }))
    .sort((a, b) => b.val - a.val).slice(0, 10)

  // Hotspots: localities quoting notably above their prior-4-week pace.
  const basePace: Record<string, number> = {}
  for (const r of baseQ) {
    const name = (r.locality || r.suburb || '').toUpperCase()
    if (name) basePace[name] = (basePace[name] || 0) + 1
  }
  const weekAgg = aggregate(weekQ)
  const hotspots = weekAgg.topLocalities
    .filter(o => o.n >= 2 && o.n > ((basePace[o.l.toUpperCase()] || 0) / 4) * 1.5)
    .slice(0, 8)

  const weekLabel = `week ending ${now.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Australia/Brisbane' })}`
  return {
    weekLabel, from,
    quotes: weekAgg,
    jobs: aggregate(weekJ),
    baselineWeeklyQuoteAvg: Math.round(baseQ.length / 4),
    hotspots,
    quotingNotBooking,
  }
}

async function writeNarrative(data: any): Promise<{ parsed: any; costMicroUsd: number }> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set')

  const prompt = `You are the marketing/sales analyst for Just Autos (Sunshine Coast QLD workshop — Toyota LandCruiser 70/200/300, Hilux & Prado performance upgrades; customers travel and freight-in from all over Australia). Below is last week's quote & booked-job GEOGRAPHY data (${data.weekLabel}), aggregated from the live workshop map.

Vehicle group codes: 70 = LC 70 Series, 200 = LC 200 Series, 300 = LC 300 Series, HILUX, PRADO, LCNA = LandCruiser series unknown, OTH = other.
"quotingNotBooking" = localities with 3+ quotes in ~5 weeks and zero booked jobs in 90 days.
"hotspots" = localities quoting above their recent pace. Values are AUD inc GST. Quotes are gross (multi-option quotes inflate values).

DATA:
${JSON.stringify(data, null, 1)}

Return ONLY this JSON:
{
  "headline": "One punchy sentence: the week's geographic story (volumes + the standout region or vehicle).",
  "what_it_means": ["3-5 bullets interpreting the data — regional demand patterns, vehicle mix by region, week vs baseline pace, anything unusual. Cite numbers."],
  "marketing_opportunities": ["3-5 concrete, actionable suggestions — e.g. geo-targeted ad regions (name the towns/regions and the vehicle to lead with), follow-up pushes on quote-heavy/no-booking areas, content angles for hot vehicle segments. Be specific to THIS data, not generic advice."],
  "watchouts": ["0-3 bullets: caveats or risks — small samples, one-off big quotes skewing a region, geocode gaps. Empty array if none."]
}

Rules: specific and numbers-first, never invent data not present, Slack-friendly plain text (no markdown headers).`

  const r = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL(), max_tokens: 2500, messages: [{ role: 'user', content: prompt }] }),
  })
  if (!r.ok) throw new Error(`Anthropic API ${r.status}: ${(await r.text()).slice(0, 300)}`)
  const resp = await r.json()
  const text = resp.content?.[0]?.text || ''
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim()
  const first = cleaned.indexOf('{'); const last = cleaned.lastIndexOf('}')
  const parsed = JSON.parse(first >= 0 && last > first ? cleaned.slice(first, last + 1) : cleaned)
  const costMicroUsd = Math.round(((resp.usage?.input_tokens || 0) / 1e6) * 3_000_000 + ((resp.usage?.output_tokens || 0) / 1e6) * 15_000_000)
  return { parsed, costMicroUsd }
}

// ── Email rendering (simple inline-styled HTML for mail clients) ────────

const esc = (s: any) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function statCell(label: string, a: SideAgg, color: string): string {
  const groups = Object.entries(a.byGroup).sort((x, y) => y[1].val - x[1].val).slice(0, 4)
    .map(([g, v]) => `${esc(GROUP_NAME[g] || g)} ${v.n}`).join(' · ')
  return `<td style="width:50%;padding:14px 16px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;vertical-align:top">
    <div style="font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:1px">${esc(label)}</div>
    <div style="font-size:24px;font-weight:700;color:${color};margin:4px 0 2px">${a.count} <span style="font-size:14px;color:#334155">(${esc(fmtK(a.value))})</span></div>
    <div style="font-size:12px;color:#64748b">${groups || 'no rows'}</div>
  </td>`
}

function locListHtml(locs: LocAgg[], max = 8): string {
  return locs.slice(0, max).map(o => {
    const topG = Object.entries(o.groups).sort((x, y) => y[1] - x[1])[0]?.[0]
    return `<li style="margin:3px 0">${esc(o.l)}${o.state ? ` <span style="color:#64748b">${esc(o.state)}</span>` : ''} — <b>${o.n}</b> @ ${esc(fmtK(o.val))}${topG ? ` <span style="color:#64748b">(${esc(GROUP_NAME[topG] || topG)})</span>` : ''}</li>`
  }).join('')
}

function bulletsHtml(items: string[] | undefined): string {
  return (items || []).map(s => `<li style="margin:5px 0;line-height:1.5">${esc(s)}</li>`).join('')
}

function sectionHtml(title: string, inner: string): string {
  if (!inner) return ''
  return `<h3 style="font-size:14px;color:#0f172a;margin:22px 0 6px;border-bottom:1px solid #e2e8f0;padding-bottom:4px">${esc(title)}</h3>${inner}`
}

function renderEmail(data: any, parsed: any): string {
  const ul = (inner: string) => inner ? `<ul style="margin:6px 0;padding-left:20px;font-size:13px;color:#0f172a">${inner}</ul>` : ''
  const qnb = data.quotingNotBooking.slice(0, 8).map((o: any) =>
    `<li style="margin:3px 0">${esc(o.l)}${o.state ? ` <span style="color:#64748b">${esc(o.state)}</span>` : ''} — <b>${o.n}</b> quotes @ ${esc(fmtK(o.val))}, no booked job in 90d</li>`).join('')
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:640px;margin:0 auto;color:#0f172a">
    <div style="padding:18px 0 10px">
      <div style="font-size:19px;font-weight:800">Weekly Quotes &amp; Jobs Map Report</div>
      <div style="font-size:12px;color:#64748b;margin-top:2px">${esc(data.weekLabel)} · <a href="${MAP_URL()}" style="color:#0284c7">open the live map</a> · quote values are gross inc GST · baseline ~${data.baselineWeeklyQuoteAvg} quotes/wk</div>
    </div>
    ${parsed.headline ? `<div style="font-size:15px;font-weight:600;background:#eff6ff;border-left:3px solid #0284c7;padding:10px 14px;border-radius:0 8px 8px 0;margin:8px 0 14px">${esc(parsed.headline)}</div>` : ''}
    <table style="width:100%;border-collapse:separate;border-spacing:8px 0"><tr>
      ${statCell('Quotes issued', data.quotes, '#b45309')}
      ${statCell('Jobs booked', data.jobs, '#047857')}
    </tr></table>
    ${sectionHtml('Top quote locations', ul(locListHtml(data.quotes.topLocalities)))}
    ${sectionHtml('Top job locations', ul(locListHtml(data.jobs.topLocalities, 6)))}
    ${sectionHtml('What it means', ul(bulletsHtml(parsed.what_it_means)))}
    ${sectionHtml('Where to market', ul(bulletsHtml(parsed.marketing_opportunities)))}
    ${qnb ? sectionHtml('Quoting but not booking', ul(qnb)) : ''}
    ${parsed.watchouts?.length ? `<div style="font-size:11.5px;color:#64748b;margin-top:18px">${(parsed.watchouts as string[]).map(s => `⚠️ ${esc(s)}`).join('<br/>')}</div>` : ''}
    <div style="font-size:11px;color:#94a3b8;margin-top:22px;border-top:1px solid #e2e8f0;padding-top:8px">
      Auto-generated every Monday from the MechanicDesk quotes/invoices pull · <a href="${MAP_URL()}" style="color:#0284c7">Reports → Workshop Map</a>
    </div>
  </div>`
}

export async function runMapWeeklyReport(opts: { dryRun?: boolean; days?: number } = {}): Promise<MapWeeklyResult> {
  const days = Math.max(3, Math.min(Number(opts.days) || 7, 31))
  const data = await fetchWindow(days)
  if (!data.quotes.count && !data.jobs.count) {
    return { weekLabel: data.weekLabel, quotes: 0, jobs: 0, posted: false, costMicroUsd: 0 }
  }

  const { parsed, costMicroUsd } = await writeNarrative(data)
  if (opts.dryRun) {
    return { weekLabel: data.weekLabel, quotes: data.quotes.count, jobs: data.jobs.count, posted: false, costMicroUsd, narrative: parsed, data }
  }

  await sendMail(FROM_MAILBOX(), {
    to: TO(),
    cc: CC(),
    subject: `Weekly Quotes & Jobs Map Report — ${data.weekLabel}`,
    html: renderEmail(data, parsed),
  })

  return { weekLabel: data.weekLabel, quotes: data.quotes.count, jobs: data.jobs.count, posted: true, costMicroUsd }
}
