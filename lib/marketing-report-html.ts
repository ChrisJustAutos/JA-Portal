// lib/marketing-report-html.ts
//
// Email HTML for the Weekly Marketing Report. Table-based, inline styles, no
// external CSS or webfonts — the house style of lib/sales-recap-html, for the
// same reason: Outlook is the reader and it ignores nearly everything else.
//
// Every block says WHICH PERIOD it covers in its own subheading. Only the
// channel table is weekly; everything else is financial-year-to-date, because
// its source is month-granular. Mixing the two without saying so is the fastest
// way to make a report untrustworthy.

import type { MarketingReport } from './marketing-report'

const BG = '#f5f6f8', CARD = '#ffffff', INK = '#14181d', MUTED = '#6b7480'
const LINE = '#e2e6eb', ACCENT = '#11ADE6', GOOD = '#1f9d69', BAD = '#c2453d'

const esc = (s: any) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const money = (n: number) => n >= 1_000_000 ? `$${(n / 1e6).toFixed(2)}M`
  : n >= 1000 ? `$${Math.round(n / 1000)}k` : `$${Math.round(n)}`
const num = (n: number) => n.toLocaleString('en-AU')
const dmy = (iso: string) => {
  const [y, m, d] = iso.split('-')
  return `${d}/${m}/${y.slice(2)}`
}

function h2(text: string, sub: string) {
  return `<tr><td style="padding:26px 24px 6px">
    <div style="font:700 15px/1.3 Arial,Helvetica,sans-serif;color:${INK}">${esc(text)}</div>
    <div style="font:400 11px/1.5 Arial,Helvetica,sans-serif;color:${MUTED};padding-top:2px">${esc(sub)}</div>
  </td></tr>`
}
const th = (t: string, align = 'left') =>
  `<th align="${align}" style="font:700 10px/1.4 Arial,Helvetica,sans-serif;color:${MUTED};text-transform:uppercase;letter-spacing:.06em;padding:0 8px 6px;border-bottom:1px solid ${LINE}">${esc(t)}</th>`
const td = (t: string, align = 'left', extra = '') =>
  `<td align="${align}" style="font:400 13px/1.5 Arial,Helvetica,sans-serif;color:${INK};padding:7px 8px;border-bottom:1px solid ${LINE};${extra}">${t}</td>`

export function renderMarketingHtml(r: MarketingReport, opts: { portalUrl?: string } = {}): string {
  const portal = opts.portalUrl || 'https://justautos.app'
  const wk = `${dmy(r.week.start)} – ${dmy(r.week.end)}`
  const deltaTot = r.weekTotal - r.priorTotal
  const arrow = (d: number) => d === 0 ? `<span style="color:${MUTED}">–</span>`
    : `<span style="color:${d > 0 ? GOOD : BAD};font-weight:700">${d > 0 ? '+' : ''}${d}</span>`

  const rows: string[] = []

  // ── Leads by channel — the only genuinely weekly block ────────────────────
  rows.push(h2('Enquiries by channel', `Week of ${wk}, against the week before. Counted per enquiry, so these are true weekly figures.`))
  rows.push(`<tr><td style="padding:6px 24px 0"><table width="100%" cellpadding="0" cellspacing="0" role="presentation">
    <tr>${th('Channel')}${th('This week', 'right')}${th('Week before', 'right')}${th('Change', 'right')}</tr>
    ${r.channels.length ? r.channels.map(c => `<tr>
      ${td(esc(c.channel))}
      ${td(`<b>${num(c.week)}</b>`, 'right')}
      ${td(`<span style="color:${MUTED}">${num(c.prior)}</span>`, 'right')}
      ${td(arrow(c.delta), 'right')}
    </tr>`).join('') : `<tr>${td(`<span style="color:${MUTED}">No enquiries recorded for this week.</span>`)}</tr>`}
    <tr>
      ${td('<b>Total</b>')}
      ${td(`<b>${num(r.weekTotal)}</b>`, 'right')}
      ${td(`<span style="color:${MUTED}">${num(r.priorTotal)}</span>`, 'right')}
      ${td(arrow(deltaTot), 'right')}
    </tr>
  </table></td></tr>`)

  // ── Coverage: the actionable section ──────────────────────────────────────
  if (r.coverage) {
    const c = r.coverage
    const tot = c.inside.quotes + c.outside.quotes
    const pctOut = tot ? Math.round((100 * c.outside.quotes) / tot) : 0
    rows.push(h2('Demand with no distributor nearby',
      `Financial year to date. Quotes further than ${c.radiusKm} km from every distributor we hold an address for.`))
    rows.push(`<tr><td style="padding:6px 24px 0">
      <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:${BG};border-radius:6px">
        <tr>
          <td style="padding:14px 16px"><div style="font:700 24px/1 Arial,Helvetica,sans-serif;color:${ACCENT}">${num(c.outside.quotes)}</div>
            <div style="font:400 11px/1.5 Arial,Helvetica,sans-serif;color:${MUTED}">quotes out of range (${pctOut}%)</div></td>
          <td style="padding:14px 16px"><div style="font:700 24px/1 Arial,Helvetica,sans-serif;color:${INK}">${money(c.outside.value)}</div>
            <div style="font:400 11px/1.5 Arial,Helvetica,sans-serif;color:${MUTED}">quoted, uncovered</div></td>
          <td style="padding:14px 16px"><div style="font:700 24px/1 Arial,Helvetica,sans-serif;color:${INK}">${num(c.inside.quotes)}</div>
            <div style="font:400 11px/1.5 Arial,Helvetica,sans-serif;color:${MUTED}">quotes inside an area</div></td>
        </tr>
      </table></td></tr>`)
    if (c.hotspots.length) {
      rows.push(`<tr><td style="padding:14px 24px 0"><table width="100%" cellpadding="0" cellspacing="0" role="presentation">
        <tr>${th('Where the uncovered demand is')}${th('State')}${th('Quotes', 'right')}${th('Quoted', 'right')}</tr>
        ${c.hotspots.map(h => `<tr>${td(esc(h.label))}${td(`<span style="color:${MUTED}">${esc(h.state)}</span>`)}${td(num(h.quotes), 'right')}${td(money(h.value), 'right')}</tr>`).join('')}
      </table></td></tr>`)
    }
  }

  // ── Model mix ─────────────────────────────────────────────────────────────
  if (r.models.length) {
    rows.push(h2('What people are asking for', 'Financial year to date, by vehicle. Conversion is quotes that became booked jobs.'))
    rows.push(`<tr><td style="padding:6px 24px 0"><table width="100%" cellpadding="0" cellspacing="0" role="presentation">
      <tr>${th('Vehicle')}${th('Quotes', 'right')}${th('Quoted', 'right')}${th('Booked', 'right')}${th('Conv', 'right')}</tr>
      ${r.models.map(m => `<tr>
        ${td(esc(m.group))}${td(num(m.quotes), 'right')}${td(money(m.value), 'right')}${td(num(m.jobs), 'right')}
        ${td(m.conv == null ? '–' : `${m.conv.toFixed(0)}%`, 'right')}
      </tr>`).join('')}
      <tr>${td('<b>Total</b>')}${td(`<b>${num(r.totals.quotes)}</b>`, 'right')}${td(`<b>${money(r.totals.value)}</b>`, 'right')}${td(`<b>${num(r.totals.jobs)}</b>`, 'right')}${td(r.totals.conv == null ? '–' : `<b>${r.totals.conv.toFixed(0)}%</b>`, 'right')}</tr>
    </table></td></tr>`)
  }

  // ── Where it comes from ───────────────────────────────────────────────────
  if (r.states.length) {
    rows.push(h2('Where the enquiries come from', 'Financial year to date, by state.'))
    rows.push(`<tr><td style="padding:6px 24px 0"><table width="100%" cellpadding="0" cellspacing="0" role="presentation">
      <tr>${th('State')}${th('Quotes', 'right')}${th('Quoted', 'right')}</tr>
      ${r.states.map(s => `<tr>${td(s.state === '?' ? '<span style="color:' + MUTED + '">Unknown</span>' : esc(s.state))}${td(num(s.quotes), 'right')}${td(money(s.value), 'right')}</tr>`).join('')}
    </table></td></tr>`)
  }

  if (r.notes.length) {
    rows.push(`<tr><td style="padding:20px 24px 0">
      <div style="background:${BG};border-left:3px solid ${LINE};border-radius:4px;padding:10px 14px;font:400 12px/1.6 Arial,Helvetica,sans-serif;color:${MUTED}">
        ${r.notes.map(n => esc(n)).join('<br>')}
      </div></td></tr>`)
  }

  return `<!doctype html><html><body style="margin:0;padding:0;background:${BG}">
<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:${BG};padding:24px 12px">
  <tr><td align="center">
    <table width="640" cellpadding="0" cellspacing="0" role="presentation" style="max-width:640px;background:${CARD};border:1px solid ${LINE};border-radius:8px">
      <tr><td style="padding:24px 24px 0">
        <div style="font:700 20px/1.2 Arial,Helvetica,sans-serif;color:${INK}">Weekly Marketing Report</div>
        <div style="font:400 12px/1.6 Arial,Helvetica,sans-serif;color:${MUTED};padding-top:4px">
          Week of ${wk} · FY${r.fy || '—'} figures to date${r.syncedAt ? ` · workshop data synced ${dmy(String(r.syncedAt).slice(0, 10))}` : ''}
        </div>
      </td></tr>
      ${rows.join('')}
      <tr><td style="padding:24px">
        <div style="border-top:1px solid ${LINE};padding-top:14px;font:400 11px/1.6 Arial,Helvetica,sans-serif;color:${MUTED}">
          Only the channel table is weekly. Everything else is financial year to date — the underlying quote data carries a month, not a day.<br>
          Live maps: <a href="${portal}/reports/map?view=quotes" style="color:${ACCENT}">Quotes map</a> ·
          <a href="${portal}/reports/map?view=conv" style="color:${ACCENT}">Conversion</a>
        </div>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`
}
