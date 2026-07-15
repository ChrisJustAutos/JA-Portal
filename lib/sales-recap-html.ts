// lib/sales-recap-html.ts
// Renders a SalesRecap to email-safe inline-styled HTML (also used as the
// portal Reports → Sales Report body). Mirrors the source doc's sections.

import type { SalesRecap } from './sales-recap'

const NAVY = '#1F4E79'
const money = (n: number | null | undefined) =>
  n == null ? 'TBC' : `$${Math.round(Number(n)).toLocaleString('en-AU')}`
const esc = (s: string) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const dayLabel = (ymd: string) => new Date(ymd + 'T00:00:00Z').toLocaleDateString('en-AU', { weekday: 'short', day: '2-digit', month: 'short' })

function table(headers: string[], rows: string[][], opts: { footer?: string[] } = {}): string {
  const th = headers.map(h => `<th style="background:${NAVY};color:#fff;font:600 13px Arial,sans-serif;padding:8px 12px;text-align:left;border:1px solid #ccc">${esc(h)}</th>`).join('')
  const trs = rows.map((r, i) => `<tr style="background:${i % 2 ? '#f5f7fa' : '#fff'}">${r.map(c => `<td style="font:13px Arial,sans-serif;padding:7px 12px;border:1px solid #e2e5e9;color:#1a1d23">${c}</td>`).join('')}</tr>`).join('')
  const foot = opts.footer ? `<tr style="background:#eef2f7;font-weight:700">${opts.footer.map(c => `<td style="font:600 13px Arial,sans-serif;padding:7px 12px;border:1px solid #e2e5e9">${c}</td>`).join('')}</tr>` : ''
  return `<table style="border-collapse:collapse;width:100%;margin:6px 0 18px">${`<tr>${th}</tr>`}${trs}${foot}</table>`
}
function h2(n: number, t: string): string {
  return `<h2 style="font:700 16px Arial,sans-serif;color:${NAVY};margin:22px 0 4px">${n}. ${esc(t)}</h2>`
}
const tick = (v: number, target: number) => v >= target ? '<span style="color:#00875a">✓</span>' : '<span style="color:#d92d20">✗</span>'

export function renderRecapHtml(r: SalesRecap): string {
  const wkLabel = `${dayLabel(r.week.start)} – ${dayLabel(r.week.end)}`
  const parts: string[] = []
  parts.push(`<div style="max-width:820px;margin:0 auto;font-family:Arial,sans-serif;color:#1a1d23">`)
  parts.push(`<h1 style="font:700 22px Arial,sans-serif;color:${NAVY};margin:0 0 2px">Weekly Sales Recap</h1>`)
  parts.push(`<div style="color:#6b7280;font-size:13px;margin-bottom:8px">Week ${esc(wkLabel)} · generated ${new Date(r.generatedAt).toLocaleString('en-AU', { timeZone: 'Australia/Brisbane', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })} · daily target ${money(r.dailyTarget)}</div>`)

  // Overnight leads panel (unnumbered — sits above the recap sections so the
  // Monday 7am email leads with what came in since Friday close).
  if (r.overnight) {
    const o = r.overnight
    parts.push(`<h2 style="font:700 16px Arial,sans-serif;color:${NAVY};margin:18px 0 2px">🌙 Overnight Leads — ${o.leads.length ? `<span style="color:#d92d20">${o.leads.length} new</span>` : 'none'}</h2>`)
    parts.push(`<div style="color:#6b7280;font-size:12px;margin-bottom:4px">New quote-channel enquiries in Monday, ${esc(o.label)}</div>`)
    if (o.leads.length) {
      // Condensed to per-NIGHT totals (Chris 2026-07-15/16) — bucket by the
      // morning the lead was waiting for: an evening lead (≥5:30pm) belongs to
      // the NEXT day's row, an early-morning lead (<7am) to its own day, so
      // "Thu 16" = the whole Wed-night→Thu-7am window. Shifting by 6h30m
      // before taking the Brisbane date does exactly that (17:30 + 6:30 =
      // midnight). Daytime weekend leads stay on their own calendar day.
      const byDay = new Map<string, Map<string, number>>()
      for (const l of o.leads) {
        const day = new Date(Date.parse(l.createdAt) + 6.5 * 3600 * 1000).toLocaleDateString('en-CA', { timeZone: 'Australia/Brisbane' })
        const ch = byDay.get(day) || new Map<string, number>()
        ch.set(l.channel, (ch.get(l.channel) || 0) + 1)
        byDay.set(day, ch)
      }
      const days = Array.from(byDay.keys()).sort()
      parts.push(table(
        ['Overnight into', 'Leads', 'By channel'],
        days.map(day => {
          const ch = byDay.get(day)!
          const count = Array.from(ch.values()).reduce((a, b) => a + b, 0)
          const split = Array.from(ch.entries()).sort((a, b) => b[1] - a[1]).map(([c, n]) => `${esc(c)} ${n}`).join(' · ')
          return [dayLabel(day), `<b>${count}</b>`, `<span style="color:#6b7280">${split}</span>`]
        }),
        { footer: ['TOTAL', `<b>${o.leads.length}</b>`, ''] },
      ))
    } else {
      parts.push(`<p style="color:#6b7280;font-size:13px;margin:4px 0 14px">No overnight leads in this period.</p>`)
    }
  }

  // Customer feedback panels (unnumbered) — everything posted in the
  // positive / negative feedback Slack channels over the period: automation
  // cards and manual staff posts alike. Each panel is omitted entirely when
  // its pull wasn't supplied (older stored recaps / Slack unreachable).
  const feedbackPanel = (
    fb: NonNullable<SalesRecap['negativeFeedback']>,
    o: { emoji: string; title: string; channel: string; countColor: string; emptyText: string },
  ) => {
    parts.push(`<h2 style="font:700 16px Arial,sans-serif;color:${NAVY};margin:18px 0 2px">${o.emoji} ${esc(o.title)} — ${fb.items.length ? `<span style="color:${o.countColor}">${fb.items.length}</span>` : 'none'}</h2>`)
    parts.push(`<div style="color:#6b7280;font-size:12px;margin-bottom:4px">Posts in ${esc(o.channel)}, ${esc(fb.label)}</div>`)
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
      parts.push(`<p style="color:#6b7280;font-size:13px;margin:4px 0 14px">${o.emptyText}</p>`)
    }
  }
  if (r.positiveFeedback) feedbackPanel(r.positiveFeedback, {
    emoji: '👍', title: 'Positive Customer Feedback', channel: '#customer-feedback-positive',
    countColor: '#00875a', emptyText: 'Nothing posted in the positive channel this period.',
  })
  if (r.negativeFeedback) feedbackPanel(r.negativeFeedback, {
    emoji: '👎', title: 'Negative Customer Feedback', channel: '#customer-feedback-negative',
    countColor: '#d92d20', emptyText: 'Nothing posted in the negative channel this period. 🎉',
  })

  // 1. Current week at a glance
  parts.push(h2(1, `Week at a Glance — ${wkLabel}`))
  parts.push(table(
    ['Day', 'JA Orders', 'Distributor', 'Daily Total', `vs ${money(r.dailyTarget)}`],
    r.daily.map(d => [
      dayLabel(d.date),
      d.total ? `${money(d.orders)}<br><span style="color:#6b7280;font-size:11px">N ${money(d.ordersNormal)} · U ${money(d.ordersUpsell)} · AM ${money(d.ordersAddMaint)}</span>` : 'TBC',
      d.total ? money(d.distributor) : 'TBC',
      d.total ? `<b>${money(d.total)}</b>` : 'TBC',
      d.total ? `${tick(d.total, r.dailyTarget)} ${money(d.total - r.dailyTarget)}` : 'TBC',
    ]),
    { footer: ['TOTAL', money(r.weekTotal.orders), money(r.weekTotal.distributor), money(r.weekTotal.total), `Avg ${money(r.weekTotal.dailyAvg)}/day`] },
  ))

  // 2. Rolling 4-week comparison
  parts.push(h2(2, 'Rolling 4-Week Comparison'))
  parts.push(table(
    ['Week', 'JA Orders', 'Distributor', 'Total', 'Days', 'Daily Avg'],
    r.rolling.map(w => [esc(w.label), money(w.orders), money(w.distributor), `<b>${money(w.total)}</b>`, String(w.tradingDays), money(w.dailyAvg)]),
  ))

  // 3. Monthly summary
  parts.push(h2(3, 'Monthly Summary'))
  parts.push(table(
    ['Month', 'JA Orders', 'Distributor', 'Total'],
    r.monthly.map(m => {
      const [y, mo] = m.month.split('-')
      const label = new Date(Date.UTC(Number(y), Number(mo) - 1, 1)).toLocaleDateString('en-AU', { month: 'long', year: 'numeric' })
      return [esc(label), money(m.orders), money(m.distributor), `<b>${money(m.total)}</b>`]
    }),
  ))

  // 4. Diary overview
  parts.push(h2(4, 'Diary Overview'))
  if (r.diaryNotes.length) {
    parts.push(table(
      ['Applies', 'Scope', 'Note'],
      r.diaryNotes.map(n => [
        n.start ? `${dayLabel(n.start.slice(0, 10))}${n.end && n.end.slice(0, 10) !== n.start.slice(0, 10) ? ' – ' + dayLabel(n.end.slice(0, 10)) : ''}` : '—',
        n.scope === 'all' ? 'All' : n.scope[0].toUpperCase() + n.scope.slice(1),
        esc(n.content),
      ]),
    ))
  } else parts.push(`<p style="color:#6b7280;font-size:13px">No diary notes for this week.</p>`)

  // 5. Forecast
  parts.push(h2(5, 'HQ Forecast Bookings — Future Months'))
  parts.push(table(
    ['Month', 'Forecast Bookings', 'Jobs'],
    r.forecast.length ? r.forecast.map(f => [esc(f.label), `<b>${money(f.value)}</b>`, String(f.jobCount)]) : [['—', 'No forward bookings', '0']],
  ))

  // 6. Flags
  parts.push(h2(6, 'Key Flags & Watch Items'))
  const badge = (p: string) => {
    const c = p === 'HIGH' ? '#d92d20' : p === 'MED' ? '#dc9a00' : '#0b7285'
    return `<span style="background:${c};color:#fff;font:600 11px Arial;padding:2px 7px;border-radius:3px">${p}</span>`
  }
  parts.push(table(['Priority', 'Item'], r.flags.map(f => [badge(f.priority), esc(f.item)])))

  parts.push(`<div style="color:#9aa0a6;font-size:11px;margin-top:20px">"Sales" = orders/bookings placed (Monday), not invoiced turnover. Diary + forecast from MechanicDesk. Auto-generated by JA Portal.</div>`)
  parts.push(`</div>`)
  return parts.join('\n')
}
