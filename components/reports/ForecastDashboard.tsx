// components/reports/ForecastDashboard.tsx
// Reports → Forecast — portal rebuild of the Monday "Forecast Dashboard -
// Includes JAWS" (dashboard 349826 over board 1842188200). Turnover by month
// for the workshop (VPS) and wholesale (JAWS) sides, this year against last.
//
// All figures come from GET /api/reports/forecast.
//
// Chart decisions worth keeping:
//   • TWO series, not three. Three years of one hue fail the normal-vision
//     separation floor (ΔE 14 — indistinguishable even with full colour
//     vision), so the chart carries prior vs current year and 2024 lives in
//     the table underneath. Blue/amber scores ΔE 29-35 across protan, deutan
//     and tritan.
//   • Series colours are CSS vars so light mode gets its own validated steps
//     rather than an automatic flip — both modes clear 3:1 against their own
//     surface. GOTCHA: CSS-var colours don't resolve in SVG presentation
//     ATTRIBUTES, so every fill goes through style={{}}.
//   • Only completed months are compared. The in-progress month is partial,
//     and months after it hold forward bookings rather than turnover — the
//     headline would be nonsense if they were summed in.

import React, { useEffect, useMemo, useState } from 'react'
import { T } from '../../lib/ui/theme'
import { KPI, Chip, Skeleton } from '../ui'

// ── API contract (mirrors lib/forecast-monday) ───────────────────────────
interface ForecastMonth {
  month: string
  monthIndex: number
  vps: Record<string, number | null>
  jaws: Record<string, number | null>
  combined: Record<string, number | null>
  complete: boolean
  inProgress: boolean
}
interface ApiResp {
  years: string[]
  currentYear: string
  priorYear: string
  months: ForecastMonth[]
  lastCompleteMonthIndex: number
  generatedAt: string
}

type SeriesKey = 'combined' | 'vps' | 'jaws'

const SERIES_LABEL: Record<SeriesKey, string> = {
  combined: 'Combined',
  vps: 'Workshop (VPS)',
  jaws: 'Wholesale (JAWS)',
}

// ── Formatting ───────────────────────────────────────────────────────────
const fmtMoney = (n: number) => (n < 0 ? '-$' : '$') + Math.round(Math.abs(n)).toLocaleString('en-AU')
const fmtMoneyShort = (n: number) => {
  const a = Math.abs(n), s = n < 0 ? '-$' : '$'
  if (a >= 1e6) return s + (a / 1e6).toFixed(1) + 'M'
  if (a >= 10000) return s + Math.round(a / 1000) + 'k'
  if (a >= 1000) return s + (a / 1000).toFixed(1) + 'k'
  return s + Math.round(a)
}
const fmtPct = (n: number) => `${n > 0 ? '+' : ''}${n.toFixed(1)}%`

function pctChange(cur: number | null, prior: number | null): number | null {
  if (cur == null || prior == null || prior === 0) return null
  return ((cur - prior) / prior) * 100
}

function niceMax(v: number): number {
  if (v <= 0) return 1
  const exp = Math.pow(10, Math.floor(Math.log10(v)))
  const f = v / exp
  const nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10
  return nf * exp
}

// ── Year-on-year clustered bars ──────────────────────────────────────────
function YoYBars({ months, series, currentYear, priorYear, lastCompleteMonthIndex }: {
  months: ForecastMonth[]; series: SeriesKey
  currentYear: string; priorYear: string; lastCompleteMonthIndex: number
}) {
  const W = 760, H = 260
  const pad = { t: 14, r: 14, b: 34, l: 54 }
  const plotW = W - pad.l - pad.r
  const plotH = H - pad.t - pad.b

  const vals = months.flatMap(m => [m[series][priorYear], m[series][currentYear]]).filter((v): v is number => v != null)
  if (!vals.length) {
    return <div style={{ padding: '48px 0', textAlign: 'center', fontSize: 12, color: T.text3 }}>No turnover recorded on the Forecasting board yet.</div>
  }

  const max = niceMax(Math.max(...vals))
  const y = (v: number) => pad.t + plotH - (v / max) * plotH
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(f => f * max)

  const groupW = plotW / months.length
  // 2px surface gap between the two bars in a cluster, per mark spec.
  const barW = Math.max(4, (groupW - 12) / 2 - 1)

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img"
         aria-label={`Turnover by month, ${priorYear} against ${currentYear}`}>
      {ticks.map((t, i) => (
        <g key={i}>
          <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} strokeWidth={1} style={{ stroke: 'var(--t-border)' }} />
          <text x={pad.l - 6} y={y(t) + 3} textAnchor="end" fontSize={9} style={{ fill: 'var(--t-text3)' }}>{fmtMoneyShort(t)}</text>
        </g>
      ))}

      {months.map((m, i) => {
        const gx = pad.l + i * groupW + 6
        const future = m.monthIndex > lastCompleteMonthIndex && !m.inProgress
        return (
          <g key={m.month}>
            {([[priorYear, 'var(--fc-prior)'], [currentYear, 'var(--fc-current)']] as const).map(([yr, colour], si) => {
              const v = m[series][yr]
              if (v == null || v <= 0) return null
              const h = Math.max(1, (v / max) * plotH)
              const x = gx + si * (barW + 2)
              return (
                // Forward months are outlined rather than filled — they hold
                // bookings taken, not turnover earned, and must not read as
                // a like-for-like bar.
                <rect key={yr} x={x} y={pad.t + plotH - h} width={barW} height={h} rx={2}
                      style={future && yr === currentYear
                        ? { fill: 'transparent', stroke: colour, strokeWidth: 1.5, strokeDasharray: '3 2' }
                        : { fill: colour }}>
                  <title>{`${m.month} ${yr} — ${fmtMoney(v)}${future && yr === currentYear ? ' (booked, month not yet trading)' : ''}${m.inProgress && yr === currentYear ? ' (month in progress)' : ''}`}</title>
                </rect>
              )
            })}
            <text x={gx + barW + 1} y={H - pad.b + 14} textAnchor="middle" fontSize={8.5}
                  style={{ fill: m.inProgress ? 'var(--t-text2)' : 'var(--t-text3)' }}>
              {m.month.slice(0, 3)}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

function Legend({ currentYear, priorYear }: { currentYear: string; priorYear: string }) {
  const items = [
    { label: priorYear, colour: 'var(--fc-prior)' },
    { label: currentYear, colour: 'var(--fc-current)' },
  ]
  return (
    <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
      {items.map(it => (
        <div key={it.label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 10, height: 10, borderRadius: 2, background: it.colour, display: 'inline-block' }} />
          <span style={{ fontSize: 11.5, color: T.text2 }}>{it.label}</span>
        </div>
      ))}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ width: 10, height: 10, borderRadius: 2, border: '1.5px dashed var(--fc-current)', display: 'inline-block' }} />
        <span style={{ fontSize: 11.5, color: T.text3 }}>Booked, not yet trading</span>
      </div>
    </div>
  )
}

function Delta({ pct }: { pct: number | null }) {
  if (pct == null) return <span style={{ color: T.text3 }}>—</span>
  const up = pct >= 0
  return (
    <span style={{ color: up ? T.green : T.red, fontVariantNumeric: 'tabular-nums' }}>
      {up ? '▲' : '▼'} {fmtPct(pct)}
    </span>
  )
}

const card: React.CSSProperties = {
  background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 10, padding: 16,
}

export default function ForecastDashboard() {
  const [data, setData] = useState<ApiResp | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [series, setSeries] = useState<SeriesKey>('combined')

  useEffect(() => {
    let live = true
    fetch('/api/reports/forecast')
      .then(async r => {
        const j = await r.json()
        if (!r.ok) throw new Error(j?.message || j?.error || `HTTP ${r.status}`)
        return j
      })
      .then(j => { if (live) setData(j) })
      .catch(e => { if (live) setErr(e.message || String(e)) })
    return () => { live = false }
  }, [])

  const totals = useMemo(() => {
    if (!data) return null
    const through = data.lastCompleteMonthIndex
    const sum = (year: string) => {
      let s = 0, any = false
      for (const m of data.months) {
        if (m.monthIndex > through) break
        const v = m[series][year]
        if (v != null) { s += v; any = true }
      }
      return any ? s : null
    }
    const cur = sum(data.currentYear)
    const prior = sum(data.priorYear)
    const inProgress = data.months.find(m => m.inProgress)
    return {
      cur, prior, change: pctChange(cur, prior),
      through,
      throughLabel: through >= 0 && data.months[through] ? data.months[through].month : null,
      inProgressMonth: inProgress?.month ?? null,
      inProgressValue: inProgress ? inProgress[series][data.currentYear] : null,
      inProgressPrior: inProgress ? inProgress[series][data.priorYear] : null,
    }
  }, [data, series])

  if (err) {
    return <div style={{ padding: 24, color: T.red, fontSize: 13 }}>Forecast unavailable — {err}</div>
  }
  if (!data || !totals) {
    return (
      <div style={{ padding: 20, display: 'grid', gap: 14 }}>
        <Skeleton height={70} /><Skeleton height={260} /><Skeleton height={240} />
      </div>
    )
  }

  const monthsWithData = data.months
  const otherYears = data.years.filter(y => y !== data.currentYear && y !== data.priorYear)

  return (
    <div style={{ height: '100%', overflowY: 'auto', padding: 20 }}>
      {/* Series colour tokens. Dark is :root default; light gets its own
          separately validated steps (both clear 3:1 on their own surface). */}
      <style>{`
        .fc { --fc-current: #4f8ef7; --fc-prior: #f5a623; }
        html[data-theme="light"] .fc { --fc-current: #3f7ae0; --fc-prior: #b06f08; }
      `}</style>

      <div className="fc" style={{ display: 'grid', gap: 16, maxWidth: 1180, margin: '0 auto' }}>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: T.text }}>Turnover forecast</div>
          <div style={{ flex: 1 }} />
          {(['combined', 'vps', 'jaws'] as SeriesKey[]).map(k => (
            <Chip key={k} label={SERIES_LABEL[k]} active={series === k} onClick={() => setSeries(k)} />
          ))}
        </div>

        {/* Headline — completed months only, so it is like-for-like. */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 12 }}>
          <KPI label={`${data.currentYear} to end of ${totals.throughLabel ?? '—'}`}
               value={totals.cur == null ? '—' : fmtMoney(totals.cur)} accent={T.blue} />
          <KPI label={`${data.priorYear} same period`}
               value={totals.prior == null ? '—' : fmtMoney(totals.prior)} />
          <KPI label="Year on year"
               value={<Delta pct={totals.change} />}
               sub={totals.cur != null && totals.prior != null ? `${fmtMoney(totals.cur - totals.prior)} difference` : undefined} />
          <KPI label={totals.inProgressMonth ? `${totals.inProgressMonth} so far` : 'Month in progress'}
               value={totals.inProgressValue == null ? '—' : fmtMoney(totals.inProgressValue)}
               sub={totals.inProgressPrior != null ? `${data.priorYear}: ${fmtMoney(totals.inProgressPrior)} full month` : undefined} />
        </div>

        <div style={card}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, gap: 12, flexWrap: 'wrap' }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: T.text }}>
              {SERIES_LABEL[series]} — {data.priorYear} vs {data.currentYear} by month
            </div>
            <Legend currentYear={data.currentYear} priorYear={data.priorYear} />
          </div>
          <YoYBars months={monthsWithData} series={series}
                   currentYear={data.currentYear} priorYear={data.priorYear}
                   lastCompleteMonthIndex={data.lastCompleteMonthIndex} />
        </div>

        {/* Table view — the required relief for the colour-encoded chart, and
            the only place the older years are shown. */}
        <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '12px 16px', fontSize: 13, fontWeight: 600, color: T.text, borderBottom: `1px solid ${T.border}` }}>
            {SERIES_LABEL[series]} by month
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
              <thead>
                <tr style={{ background: T.bg3 }}>
                  <th style={th}>Month</th>
                  {otherYears.map(y => <th key={y} style={{ ...th, textAlign: 'right' }}>{y}</th>)}
                  <th style={{ ...th, textAlign: 'right' }}>{data.priorYear}</th>
                  <th style={{ ...th, textAlign: 'right' }}>{data.currentYear}</th>
                  <th style={{ ...th, textAlign: 'right' }}>Change</th>
                </tr>
              </thead>
              <tbody>
                {monthsWithData.map(m => {
                  const cur = m[series][data.currentYear]
                  const prior = m[series][data.priorYear]
                  const future = m.monthIndex > data.lastCompleteMonthIndex && !m.inProgress
                  return (
                    <tr key={m.month} style={{ borderTop: `1px solid ${T.border}`, opacity: future ? 0.6 : 1 }}>
                      <td style={td}>
                        {m.month}
                        {m.inProgress && <span style={tag}>in progress</span>}
                        {future && <span style={tag}>booked</span>}
                      </td>
                      {otherYears.map(y => (
                        <td key={y} style={tdNum}>{m[series][y] == null ? '—' : fmtMoney(m[series][y] as number)}</td>
                      ))}
                      <td style={tdNum}>{prior == null ? '—' : fmtMoney(prior)}</td>
                      <td style={{ ...tdNum, fontWeight: 600 }}>{cur == null ? '—' : fmtMoney(cur)}</td>
                      <td style={tdNum}>{future || m.inProgress ? <span style={{ color: T.text3 }}>—</span> : <Delta pct={pctChange(cur, prior)} />}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>

        <div style={{ fontSize: 11.5, color: T.text3, lineHeight: 1.5 }}>
          Source: Monday “Forecasting” board, live on load. Months after {totals.throughLabel ?? 'the current month'} hold
          orders already booked rather than turnover earned, so they are shown outlined and excluded from the
          year-on-year headline. Percentages are computed from the turnover figures, not the board’s hand-entered
          “% Increase/Decrease” column.
        </div>
      </div>
    </div>
  )
}

const th: React.CSSProperties = { padding: '8px 12px', textAlign: 'left', fontSize: 11, fontWeight: 600, color: T.text2, textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap' }
const td: React.CSSProperties = { padding: '8px 12px', color: T.text, whiteSpace: 'nowrap' }
const tdNum: React.CSSProperties = { ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }
const tag: React.CSSProperties = { marginLeft: 8, fontSize: 10, color: T.text3, border: `1px solid ${T.border}`, borderRadius: 4, padding: '1px 5px' }
