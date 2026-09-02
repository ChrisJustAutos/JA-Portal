// lib/sales-recap-html.ts
// Renders a SalesRecap to email-safe inline-styled HTML (also used as the
// portal Reports → Sales Report body). Redesigned 2026-07-28 (Chris: "think
// picture books type of person") — headline KPI cards, big numbers, colour
// up/down pills and horizontal bars instead of dense numeric grids. Stays
// email-safe: tables + inline styles + div bars only, no flex/grid/JS.

import type { SalesRecap } from './sales-recap'

const NAVY = '#1F4E79'
const GREEN = '#00875a'
const RED = '#d92d20'
const GREEN_BG = '#e7f6ef'
const RED_BG = '#fdeceb'
const GREY = '#6b7280'

const money = (n: number | null | undefined) =>
  n == null ? 'TBC' : `$${Math.round(Number(n)).toLocaleString('en-AU')}`
const moneyK = (n: number) => n >= 1000 ? `$${Math.round(n / 1000)}k` : money(n)
const esc = (s: string) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const dayLabel = (ymd: string) => new Date(ymd + 'T00:00:00Z').toLocaleDateString('en-AU', { weekday: 'short', day: '2-digit', month: 'short' })

// ▲ +12% / ▼ -8% pill. Green when up is good (default); flip for "lower is
// better" metrics if ever needed.
function pctPill(pct: number | null | undefined): string {
  if (pct == null) return `<span style="color:${GREY};font:600 12px Arial">—</span>`
  const up = pct >= 0
  const col = up ? GREEN : RED
  const bg = up ? GREEN_BG : RED_BG
  const arrow = up ? '▲' : '▼'
  return `<span style="background:${bg};color:${col};font:700 13px Arial;padding:3px 10px;border-radius:12px;white-space:nowrap">${arrow} ${up ? '+' : ''}${pct}%</span>`
}

// Simple ✓ hit / ✗ miss pill against the daily target.
function targetPill(v: number, target: number): string {
  const hit = v >= target
  const col = hit ? GREEN : RED
  const bg = hit ? GREEN_BG : RED_BG
  const diff = v - target
  return `<span style="background:${bg};color:${col};font:700 12px Arial;padding:3px 10px;border-radius:12px;white-space:nowrap">${hit ? '✓' : '✗'} ${diff >= 0 ? '+' : '−'}${moneyK(Math.abs(diff))}</span>`
}

// Horizontal bar as a two-cell table, not a painted div: Word's HTML importer
// and Outlook both drop background paint on empty divs (the bar columns came
// out blank in .doc exports), while a real <td bgcolor> with &nbsp; content
// survives browsers, Word, Outlook and print alike.
function bar(value: number, max: number, color: string): string {
  const pct = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0
  if (pct <= 0) return `<table cellspacing="0" cellpadding="0" width="100%" style="border-collapse:collapse;width:100%;min-width:120px"><tr><td bgcolor="#eef1f5" style="background:#eef1f5;height:16px;line-height:16px;font-size:1px;border-radius:6px">&nbsp;</td></tr></table>`
  const rest = 100 - pct
  return `<table cellspacing="0" cellpadding="0" width="100%" style="border-collapse:collapse;width:100%;min-width:120px"><tr>` +
    `<td bgcolor="${color}" width="${pct}%" style="background:${color};height:16px;line-height:16px;font-size:1px;border-radius:6px">&nbsp;</td>` +
    (rest > 0 ? `<td bgcolor="#eef1f5" width="${rest}%" style="background:#eef1f5;height:16px;line-height:16px;font-size:1px;border-radius:0 6px 6px 0">&nbsp;</td>` : '') +
    `</tr></table>`
}

function sectionTitle(emoji: string, t: string, sub?: string): string {
  return `<h2 style="font:700 18px Arial,sans-serif;color:${NAVY};margin:26px 0 2px">${emoji} ${esc(t)}</h2>` +
    (sub ? `<div style="color:${GREY};font-size:12px;margin-bottom:8px">${esc(sub)}</div>` : '')
}

// Plain content table with roomy cells (used for diary / feedback / flags).
function table(headers: string[], rows: string[][], opts: { footer?: string[] } = {}): string {
  const th = headers.map(h => `<th style="background:${NAVY};color:#fff;font:600 13px Arial,sans-serif;padding:9px 12px;text-align:left;border:1px solid #ccd3dc">${esc(h)}</th>`).join('')
  const trs = rows.map((r, i) => `<tr style="background:${i % 2 ? '#f5f7fa' : '#fff'}">${r.map(c => `<td style="font:14px Arial,sans-serif;padding:9px 12px;border:1px solid #e2e5e9;color:#1a1d23;vertical-align:top">${c}</td>`).join('')}</tr>`).join('')
  const foot = opts.footer ? `<tr style="background:#eef2f7;font-weight:700">${opts.footer.map(c => `<td style="font:700 14px Arial,sans-serif;padding:9px 12px;border:1px solid #e2e5e9">${c}</td>`).join('')}</tr>` : ''
  return `<table cellspacing="0" cellpadding="0" style="border-collapse:collapse;width:100%;margin:6px 0 18px">${`<tr>${th}</tr>`}${trs}${foot}</table>`
}

// One big KPI card. Rendered inside a one-row table so email clients keep
// them side by side.
function kpiCard(label: string, value: string, extra: string): string {
  return `<td style="background:#f7f9fc;border:1px solid #e2e5e9;border-radius:10px;padding:14px 16px;vertical-align:top">
    <div style="font:600 11px Arial;color:${GREY};text-transform:uppercase;letter-spacing:0.05em">${esc(label)}</div>
    <div style="font:800 26px Arial;color:#1a1d23;margin:4px 0 6px">${value}</div>
    <div>${extra}</div>
  </td>`
}

export function renderRecapHtml(r: SalesRecap): string {
  const wkLabel = `${dayLabel(r.week.start)} – ${dayLabel(r.week.end)}`
  const parts: string[] = []
  parts.push(`<div style="max-width:840px;margin:0 auto;font-family:Arial,sans-serif;color:#1a1d23">`)
  parts.push(`<h1 style="font:800 24px Arial,sans-serif;color:${NAVY};margin:0 0 2px">Weekly Sales Recap</h1>`)
  parts.push(`<div style="color:${GREY};font-size:13px;margin-bottom:12px">Week ${esc(wkLabel)} · generated ${new Date(r.generatedAt).toLocaleString('en-AU', { timeZone: 'Australia/Brisbane', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })} · daily target ${money(r.dailyTarget)}</div>`)

  // ── Headline KPI cards ─────────────────────────────────────────────────
  // Every section is wrapped in <div data-section="…"> so the export flow can
  // include/exclude sections by tickbox (Chris 2026-07-29) — the wrappers are
  // inert in email clients.
  if (r.kpis) {
    const k = r.kpis
    parts.push(`<div data-section="kpis">`)
    parts.push(`<table cellspacing="8" cellpadding="0" style="border-collapse:separate;width:100%;margin:0 0 8px"><tr>`)
    parts.push(kpiCard('This week', money(r.weekTotal.total),
      `<span style="color:${GREY};font:12px Arial">JA ${moneyK(r.weekTotal.orders)} · Dist ${moneyK(r.weekTotal.distributor)}</span>`))
    parts.push(kpiCard('Daily average', money(k.weekDailyAvg),
      `${pctPill(k.weekVsTargetPct)} <span style="color:${GREY};font:12px Arial">vs ${moneyK(r.dailyTarget)} target</span>`))
    parts.push(kpiCard('4-week daily average', money(k.rolling4AvgDaily),
      `${pctPill(k.rolling4VsTargetPct)} <span style="color:${GREY};font:12px Arial">vs ${moneyK(r.dailyTarget)} target</span>`))
    parts.push(kpiCard(`${k.monthLabel.split(' ')[0]} so far`, money(k.monthToDate),
      k.prevMonthLabel
        ? `${pctPill(k.momPct)} <span style="color:${GREY};font:12px Arial">vs ${esc(k.prevMonthLabel.split(' ')[0])} ${moneyK(k.prevMonthTotal || 0)}</span>`
        : `<span style="color:${GREY};font:12px Arial">no previous month yet</span>`))
    parts.push(`</tr></table>`)
    parts.push(`</div>`)
  }

  // ── Overnight leads (unnumbered, leads the Monday 7am email) ──────────
  if (r.overnight) {
    const o = r.overnight
    parts.push(`<div data-section="overnight">`)
    parts.push(sectionTitle('🌙', `Overnight Leads — ${o.leads.length ? `${o.leads.length} new` : 'none'}`,
      `New quote-channel enquiries in Monday, ${o.label}`))
    if (o.leads.length) {
      // Per-day totals only (Chris 2026-07-28) — bucket by the MORNING the
      // lead was waiting for (evening leads roll to the next day: +6h30m
      // shift makes 17:30 → midnight; <7am stays; weekend daytime stays).
      const byDay = new Map<string, number>()
      for (const l of o.leads) {
        const day = new Date(Date.parse(l.createdAt) + 6.5 * 3600 * 1000).toLocaleDateString('en-CA', { timeZone: 'Australia/Brisbane' })
        byDay.set(day, (byDay.get(day) || 0) + 1)
      }
      const days = Array.from(byDay.keys()).sort()
      const maxLeads = Math.max(...Array.from(byDay.values()))
      parts.push(table(
        ['Overnight into', 'Leads', ''],
        days.map(day => [
          `<span style="font:700 14px Arial">${dayLabel(day)}</span>`,
          `<span style="font:800 18px Arial">${byDay.get(day)}</span>`,
          bar(byDay.get(day)!, maxLeads, NAVY),
        ]),
        { footer: ['TOTAL', `<span style="font:800 18px Arial">${o.leads.length}</span>`, ''] },
      ))
    } else {
      parts.push(`<p style="color:${GREY};font-size:13px;margin:4px 0 14px">No overnight leads in this period.</p>`)
    }
    parts.push(`</div>`)
  }

  // ── Customer feedback panels ──────────────────────────────────────────
  const feedbackPanel = (
    fb: NonNullable<SalesRecap['negativeFeedback']>,
    o: { emoji: string; title: string; channel: string; countColor: string; emptyText: string; sectionId: string },
  ) => {
    parts.push(`<div data-section="${o.sectionId}">`)
    parts.push(sectionTitle(o.emoji, `${o.title} — ${fb.items.length || 'none'}`, `Posts in ${o.channel}, ${fb.label}`))
    if (fb.items.length) {
      const when = (iso: string) => new Date(iso).toLocaleString('en-AU', {
        timeZone: 'Australia/Brisbane', weekday: 'short', day: '2-digit', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true,
      })
      parts.push(table(
        ['When', 'Feedback'],
        fb.items.map(i => [
          `<span style="white-space:nowrap">${esc(when(i.at))}</span>`,
          `${i.author ? `<b>${esc(i.author)}:</b> ` : ''}${esc(i.text)}`,
        ]),
      ))
    } else {
      parts.push(`<p style="color:${GREY};font-size:13px;margin:4px 0 14px">${o.emptyText}</p>`)
    }
    parts.push(`</div>`)
  }
  if (r.positiveFeedback) feedbackPanel(r.positiveFeedback, {
    emoji: '👍', title: 'Positive Customer Feedback', channel: '#customer-feedback-positive',
    countColor: GREEN, emptyText: 'Nothing posted in the positive channel this period.', sectionId: 'positive-feedback',
  })
  if (r.negativeFeedback) feedbackPanel(r.negativeFeedback, {
    emoji: '👎', title: 'Negative Customer Feedback', channel: '#customer-feedback-negative',
    countColor: RED, emptyText: 'Nothing posted in the negative channel this period. 🎉', sectionId: 'negative-feedback',
  })

  // ── 1. Week at a glance ───────────────────────────────────────────────
  // One row per day: big total, a bar sized against the best day (target
  // line implied by the pill), green/red tint by target hit.
  parts.push(`<div data-section="week">`)
  parts.push(sectionTitle('📅', `Week at a Glance — ${wkLabel}`, `Green = hit the ${money(r.dailyTarget)} daily target, red = short`))
  {
    const maxDay = Math.max(r.dailyTarget, ...r.daily.map(d => d.total))
    const rows = r.daily.map(d => {
      const tint = !d.total ? '#fff' : d.total >= r.dailyTarget ? GREEN_BG : RED_BG
      const cells = [
        `<span style="font:700 15px Arial;white-space:nowrap">${dayLabel(d.date)}</span>`,
        d.total
          ? `<span style="font:800 20px Arial">${money(d.total)}</span><br><span style="color:${GREY};font:12px Arial">JA ${moneyK(d.orders)} · Dist ${moneyK(d.distributor)}</span>`
          : `<span style="color:${GREY};font:14px Arial">TBC</span>`,
        d.total ? bar(d.total, maxDay, d.total >= r.dailyTarget ? GREEN : RED) : '',
        d.total ? targetPill(d.total, r.dailyTarget) : '',
      ]
      return `<tr style="background:${tint}">${cells.map(c => `<td style="font:14px Arial;padding:10px 12px;border:1px solid #e2e5e9;vertical-align:middle">${c}</td>`).join('')}</tr>`
    }).join('')
    const foot = `<tr style="background:#eef2f7">${[
      `<span style="font:800 14px Arial">WEEK</span>`,
      `<span style="font:800 20px Arial">${money(r.weekTotal.total)}</span><br><span style="color:${GREY};font:12px Arial">JA ${moneyK(r.weekTotal.orders)} · Dist ${moneyK(r.weekTotal.distributor)}</span>`,
      `<span style="color:${GREY};font:13px Arial">avg <b>${money(r.weekTotal.dailyAvg)}</b>/day</span>`,
      r.weekTotal.dailyAvg ? targetPill(r.weekTotal.dailyAvg, r.dailyTarget) : '',
    ].map(c => `<td style="padding:10px 12px;border:1px solid #e2e5e9;vertical-align:middle">${c}</td>`).join('')}</tr>`
    parts.push(`<table cellspacing="0" cellpadding="0" style="border-collapse:collapse;width:100%;margin:6px 0 18px">
      <tr>${['Day', 'Sales', '', 'vs target'].map(h => `<th style="background:${NAVY};color:#fff;font:600 13px Arial;padding:9px 12px;text-align:left;border:1px solid #ccd3dc">${h}</th>`).join('')}</tr>
      ${rows}${foot}</table>`)
  }
  parts.push(`</div>`)

  // ── 2. Rolling 4-week comparison ──────────────────────────────────────
  parts.push(`<div data-section="rolling">`)
  parts.push(sectionTitle('📊', 'Rolling 4-Week Comparison', 'Most recent week first — bar length = week total'))
  {
    const maxWk = Math.max(...r.rolling.map(w => w.total), 1)
    parts.push(table(
      ['Week', 'Total', '', 'Daily avg'],
      r.rolling.map(w => [
        `<span style="font:700 14px Arial;white-space:nowrap">${esc(w.label)}</span>`,
        `<span style="font:800 18px Arial">${money(w.total)}</span><br><span style="color:${GREY};font:12px Arial">JA ${moneyK(w.orders)} · Dist ${moneyK(w.distributor)}</span>`,
        bar(w.total, maxWk, NAVY),
        w.dailyAvg ? `<span style="font:700 14px Arial">${money(w.dailyAvg)}</span><br>${targetPill(w.dailyAvg, r.dailyTarget)}` : `<span style="color:${GREY}">—</span>`,
      ]),
    ))
  }

  parts.push(`</div>`)

  // ── 3. Monthly summary ────────────────────────────────────────────────
  parts.push(`<div data-section="monthly">`)
  parts.push(sectionTitle('🗓️', 'Monthly Summary', 'Bar length = month total · pill = change vs the month before'))
  {
    const maxMo = Math.max(...r.monthly.map(m => m.total), 1)
    parts.push(table(
      ['Month', 'Total', '', 'vs prior month'],
      r.monthly.map((m, i) => {
        const [y, mo] = m.month.split('-')
        const label = new Date(Date.UTC(Number(y), Number(mo) - 1, 1)).toLocaleDateString('en-AU', { month: 'long', year: 'numeric' })
        const prev = i > 0 ? r.monthly[i - 1] : null
        const pct = prev && prev.total > 0 ? Math.round(((m.total - prev.total) / prev.total) * 1000) / 10 : null
        return [
          `<span style="font:700 14px Arial;white-space:nowrap">${esc(label)}</span>`,
          `<span style="font:800 18px Arial">${money(m.total)}</span><br><span style="color:${GREY};font:12px Arial">JA ${moneyK(m.orders)} · Dist ${moneyK(m.distributor)}</span>`,
          bar(m.total, maxMo, NAVY),
          pct == null ? `<span style="color:${GREY}">—</span>` : pctPill(pct),
        ]
      }),
    ))
  }

  parts.push(`</div>`)

  // ── Distributor Areas (quotes vs booked, recap week's month) ─────────
  if (r.distributorAreas && r.distributorAreas.rows.length) {
    const da = r.distributorAreas
    parts.push(`<div data-section="distributor-areas">`)
    parts.push(sectionTitle('🗺️', `Distributor Areas — ${da.monthLabel}`,
      `JA quotes to customers within ${da.radiusKm} km of each distributor vs the jobs they booked (Monday, confirmed) · month granularity · full map: justautos.app/reports/map?view=quotes`))
    const maxQ = Math.max(...da.rows.map(x => x.quotes), 1)
    const convPill = (b: number, q: number) => {
      if (!q) return `<span style="color:${GREY};font:600 12px Arial">—</span>`
      const p = Math.round((b / q) * 100)
      const col = p >= 30 ? GREEN : p >= 15 ? '#dc9a00' : RED
      const bg = p >= 30 ? GREEN_BG : p >= 15 ? '#fdf3e0' : RED_BG
      return `<span style="background:${bg};color:${col};font:700 13px Arial;padding:3px 10px;border-radius:12px;white-space:nowrap">${p}%</span>`
    }
    parts.push(table(
      ['Distributor', 'Quotes in area', '', 'They booked', 'Booked / quotes'],
      da.rows.map(x => [
        `<span style="font:700 14px Arial">${esc(x.name)}${x.located ? '' : ' ⚠'}</span>`,
        x.located
          ? `<span style="font:800 18px Arial">${x.quotes}</span> <span style="color:${GREY};font:12px Arial">${x.quotes ? moneyK(x.quotesValue) : ''}</span>`
          : `<span style="color:${GREY};font:12px Arial">no location on file</span>`,
        x.located ? bar(x.quotes, maxQ, NAVY) : '',
        `<span style="font:800 18px Arial">${x.bookings}</span> <span style="color:${GREY};font:12px Arial">${x.bookings ? moneyK(x.bookingsValue) : ''}</span>`,
        x.located ? convPill(x.bookings, x.quotes) : `<span style="color:${GREY};font:600 12px Arial">—</span>`,
      ]),
    ))
    parts.push(`</div>`)
  }

  // ── 4. Diary overview ─────────────────────────────────────────────────
  parts.push(`<div data-section="diary">`)
  parts.push(sectionTitle('📔', 'Diary Overview'))
  if (r.diaryNotes.length) {
    parts.push(table(
      ['Applies', 'Scope', 'Note'],
      r.diaryNotes.map(n => [
        n.start ? `${dayLabel(n.start.slice(0, 10))}${n.end && n.end.slice(0, 10) !== n.start.slice(0, 10) ? ' – ' + dayLabel(n.end.slice(0, 10)) : ''}` : '—',
        n.scope === 'all' ? 'All' : n.scope[0].toUpperCase() + n.scope.slice(1),
        esc(n.content),
      ]),
    ))
  } else parts.push(`<p style="color:${GREY};font-size:13px">No diary notes for this week.</p>`)
  parts.push(`</div>`)

  // ── 5. Forecast ───────────────────────────────────────────────────────
  parts.push(`<div data-section="forecast">`)
  parts.push(sectionTitle('🔮', 'HQ Forecast Bookings — Future Months', 'Booked-in work by scheduled month, from the MechanicDesk job report'))
  if (r.forecast.length) {
    const maxF = Math.max(...r.forecast.map(f => f.value), 1)
    parts.push(table(
      ['Month', 'Booked', '', 'Jobs'],
      r.forecast.map(f => [
        `<span style="font:700 14px Arial;white-space:nowrap">${esc(f.label)}</span>`,
        `<span style="font:800 18px Arial">${money(f.value)}</span>`,
        bar(f.value, maxF, NAVY),
        `<span style="font:700 14px Arial">${f.jobCount}</span>`,
      ]),
    ))
  } else {
    parts.push(`<p style="color:${GREY};font-size:13px">No forward bookings on record.</p>`)
  }
  parts.push(`</div>`)

  // ── 6. Flags ──────────────────────────────────────────────────────────
  parts.push(`<div data-section="flags">`)
  parts.push(sectionTitle('🚩', 'Key Flags & Watch Items'))
  const badge = (p: string) => {
    const c = p === 'HIGH' ? RED : p === 'MED' ? '#dc9a00' : '#0b7285'
    return `<span style="background:${c};color:#fff;font:700 11px Arial;padding:3px 9px;border-radius:10px">${p}</span>`
  }
  parts.push(table(['Priority', 'Item'], r.flags.map(f => [badge(f.priority), esc(f.item)])))
  parts.push(`</div>`)

  parts.push(`<div style="color:#9aa0a6;font-size:11px;margin-top:20px">"Sales" = orders/bookings placed (Monday), not invoiced turnover. Distributor bookings count from the Booking - Confirmed group. Diary + forecast from MechanicDesk. Auto-generated by JA Portal.</div>`)
  parts.push(`</div>`)
  return parts.join('\n')
}
