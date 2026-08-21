// components/reports/SalesFiguresView.tsx
// Reports → Sales Dashboard, FIGURES view — daily, monthly and period sales.
// The money-over-time half of the Monday "Sales Dashboard" (2079976).
//
// "Sales" means ORDERS/BOOKINGS TAKEN, not invoiced turnover — the same
// meaning the Sales Report uses. Turnover lives on the Forecast report. The
// two will not agree and are not meant to.
//
// Colour: the validated blue/amber pair shared with Forecast and the Pipeline
// view. GOTCHA: CSS-var colours don't resolve in SVG presentation ATTRIBUTES,
// so every fill goes through style={{}}.

import React, { useEffect, useState } from 'react'
import { T } from '../../lib/ui/theme'
import { KPI, Chip, Skeleton, inp } from '../ui'

interface DayRow { date: string; ordersValue: number; ordersCount: number; distValue: number; distCount: number; total: number }
interface MonthRow { month: string; ordersValue: number; ordersCount: number; distValue: number; distCount: number; total: number }
interface ProcessRow { process: string; count: number; value: number }
interface PersonRow {
  person: string
  ordersCount: number; ordersValue: number
  distCount: number; distValue: number
  total: number; sharePct: number
}
interface ApiResp {
  period: { since: string; until: string; days: number; person: string | null }
  daily: DayRow[]
  dailyWindowDays: number
  monthly: MonthRow[]
  byProcess: ProcessRow[]
  people: PersonRow[]
  totals: {
    ordersCount: number; ordersValue: number
    distCount: number; distValue: number
    total: number; monthToDate: number; yearToDate: number
    bestDay: { date: string; total: number } | null
    bestMonth: { month: string; total: number } | null
    tradingDays: number; avgPerTradingDay: number | null
  }
  generatedAt: string
}

const fmtMoney = (n: number) => (n < 0 ? '-$' : '$') + Math.round(Math.abs(n)).toLocaleString('en-AU')
const fmtMoneyShort = (n: number) => {
  const a = Math.abs(n), s = n < 0 ? '-$' : '$'
  if (a >= 1e6) return s + (a / 1e6).toFixed(1) + 'M'
  if (a >= 10000) return s + Math.round(a / 1000) + 'k'
  if (a >= 1000) return s + (a / 1000).toFixed(1) + 'k'
  return s + Math.round(a)
}
const fmtInt = (n: number) => Math.round(n).toLocaleString('en-AU')
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
const monthLabel = (k: string) => { const [y, m] = k.split('-'); return `${MON[Number(m) - 1] || m} ${y.slice(2)}` }
const dayLabel = (k: string) => { const d = new Date(k + 'T00:00:00Z'); return `${d.getUTCDate()} ${MON[d.getUTCMonth()]}` }

function niceMax(v: number): number {
  if (v <= 0) return 1
  const exp = Math.pow(10, Math.floor(Math.log10(v)))
  const f = v / exp
  const nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10
  return nf * exp
}

// ── Daily takings. One series (the day's total), so no legend — the title
//    names it; the split is in the tooltip.
function DailyBars({ daily }: { daily: DayRow[] }) {
  if (!daily.length) return <Empty>No sales in this window.</Empty>
  const W = 780, H = 210
  const pad = { t: 12, r: 12, b: 26, l: 54 }
  const plotW = W - pad.l - pad.r, plotH = H - pad.t - pad.b
  const max = niceMax(Math.max(...daily.map(d => d.total), 0))
  const y = (v: number) => pad.t + plotH - (v / max) * plotH
  const slot = plotW / daily.length
  const barW = Math.max(1.5, slot - 2)
  const ticks = [0, 0.5, 1].map(f => f * max)
  const every = Math.ceil(daily.length / 12)

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img"
         aria-label="Sales taken per day">
      {ticks.map((t, i) => (
        <g key={i}>
          <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} strokeWidth={1} style={{ stroke: 'var(--t-border)' }} />
          <text x={pad.l - 6} y={y(t) + 3} textAnchor="end" fontSize={9} style={{ fill: 'var(--t-text3)' }}>{fmtMoneyShort(t)}</text>
        </g>
      ))}
      {daily.map((d, i) => {
        const x = pad.l + i * slot
        const h = d.total > 0 ? Math.max(1, (d.total / max) * plotH) : 0
        return (
          <g key={d.date}>
            {h > 0 && (
              <rect x={x} y={pad.t + plotH - h} width={barW} height={h} rx={1.5} style={{ fill: 'var(--sd-orders)' }}>
                <title>{`${dayLabel(d.date)} — ${fmtMoney(d.total)} (workshop ${fmtMoney(d.ordersValue)} · distributor ${fmtMoney(d.distValue)})`}</title>
              </rect>
            )}
            {i % every === 0 && (
              <text x={x + barW / 2} y={H - pad.b + 13} textAnchor="middle" fontSize={8} style={{ fill: 'var(--t-text3)' }}>
                {dayLabel(d.date)}
              </text>
            )}
          </g>
        )
      })}
    </svg>
  )
}

// ── Monthly, split workshop vs distributor. Stacked: the two are parts of one
//    total, with a 2px surface gap between segments.
function MonthlyStack({ monthly }: { monthly: MonthRow[] }) {
  if (!monthly.length) return <Empty>No sales in this window.</Empty>
  const W = 780, H = 250
  const pad = { t: 12, r: 12, b: 30, l: 56 }
  const plotW = W - pad.l - pad.r, plotH = H - pad.t - pad.b
  const max = niceMax(Math.max(...monthly.map(m => m.total)))
  const y = (v: number) => pad.t + plotH - (v / max) * plotH
  const slot = plotW / monthly.length
  const barW = Math.min(46, Math.max(6, slot - 12))
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(f => f * max)
  const every = monthly.length > 14 ? 2 : 1

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img"
         aria-label="Sales taken per month, workshop and distributor">
      {ticks.map((t, i) => (
        <g key={i}>
          <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} strokeWidth={1} style={{ stroke: 'var(--t-border)' }} />
          <text x={pad.l - 6} y={y(t) + 3} textAnchor="end" fontSize={9} style={{ fill: 'var(--t-text3)' }}>{fmtMoneyShort(t)}</text>
        </g>
      ))}
      {monthly.map((m, i) => {
        const x = pad.l + i * slot + (slot - barW) / 2
        const hOrders = m.ordersValue > 0 ? Math.max(1, (m.ordersValue / max) * plotH) : 0
        const hDist = m.distValue > 0 ? Math.max(1, (m.distValue / max) * plotH) : 0
        const yOrders = pad.t + plotH - hOrders
        // 2px gap so the two segments never read as one block.
        const yDist = yOrders - hDist - (hOrders > 0 && hDist > 0 ? 2 : 0)
        return (
          <g key={m.month}>
            {hOrders > 0 && (
              <rect x={x} y={yOrders} width={barW} height={hOrders} rx={2} style={{ fill: 'var(--sd-orders)' }}>
                <title>{`${monthLabel(m.month)} — workshop ${fmtMoney(m.ordersValue)} (${fmtInt(m.ordersCount)} orders)`}</title>
              </rect>
            )}
            {hDist > 0 && (
              <rect x={x} y={yDist} width={barW} height={hDist} rx={2} style={{ fill: 'var(--sd-dist)' }}>
                <title>{`${monthLabel(m.month)} — distributor ${fmtMoney(m.distValue)} (${fmtInt(m.distCount)} bookings)`}</title>
              </rect>
            )}
            {i % every === 0 && (
              <text x={x + barW / 2} y={H - pad.b + 14} textAnchor="middle" fontSize={8.5} style={{ fill: 'var(--t-text3)' }}>
                {monthLabel(m.month)}
              </text>
            )}
          </g>
        )
      })}
    </svg>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div style={{ padding: '40px 0', textAlign: 'center', fontSize: 12, color: T.text3 }}>{children}</div>
}

function Legend() {
  return (
    <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
      {[['Workshop orders', 'var(--sd-orders)'], ['Distributor bookings', 'var(--sd-dist)']].map(([l, c]) => (
        <div key={l} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 10, height: 10, borderRadius: 2, background: c, display: 'inline-block' }} />
          <span style={{ fontSize: 11.5, color: T.text2 }}>{l}</span>
        </div>
      ))}
    </div>
  )
}

const ymd = (d: Date) => d.toISOString().slice(0, 10)

/** Preset ranges. `months` back from today; 0 = calendar year to date. */
function presetRange(months: number): { start: string; end: string } {
  const now = new Date()
  const end = ymd(now)
  if (months === 0) return { start: `${now.getFullYear()}-01-01`, end }
  const s = new Date(now)
  s.setMonth(s.getMonth() - months)
  return { start: ymd(s), end }
}

const PRESETS: Array<{ label: string; months: number }> = [
  { label: '30d', months: 1 }, { label: '3m', months: 3 }, { label: '6m', months: 6 },
  { label: 'YTD', months: 0 }, { label: '12m', months: 12 }, { label: '24m', months: 24 },
]

const card: React.CSSProperties = { background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 10, padding: 16 }

export default function SalesFiguresView() {
  const [data, setData] = useState<ApiResp | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [range, setRange] = useState(() => presetRange(12))
  const [days, setDays] = useState(60)
  const [person, setPerson] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let live = true
    setLoading(true); setErr(null)
    const qs = new URLSearchParams({ start: range.start, end: range.end, days: String(days) })
    if (person) qs.set('person', person)
    fetch(`/api/reports/sales-figures?${qs}`)
      .then(async r => {
        const j = await r.json()
        if (!r.ok) throw new Error(j?.message || j?.error || `HTTP ${r.status}`)
        return j
      })
      .then(j => { if (live) { setData(j); setLoading(false) } })
      .catch(e => { if (live) { setErr(e.message || String(e)); setLoading(false) } })
    return () => { live = false }
  }, [range.start, range.end, days, person])

  if (err) return <div style={{ padding: 24, color: T.red, fontSize: 13 }}>Sales figures unavailable — {err}</div>

  return (
    <div style={{ height: '100%', overflowY: 'auto', padding: 20 }}>
      <style>{`
        .sf { --sd-orders: #4f8ef7; --sd-dist: #f5a623; }
        html[data-theme="light"] .sf { --sd-orders: #3f7ae0; --sd-dist: #b06f08; }
      `}</style>

      <div className="sf" style={{ display: 'grid', gap: 16, maxWidth: 1180, margin: '0 auto' }}>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: T.text }}>Sales taken</div>
          <div style={{ fontSize: 11.5, color: T.text3 }}>orders and bookings placed — not invoiced turnover</div>
          <div style={{ flex: 1 }} />
          {PRESETS.map(pr => {
            const r = presetRange(pr.months)
            return (
              <Chip key={pr.label} label={pr.label}
                    active={range.start === r.start && range.end === r.end}
                    onClick={() => setRange(r)} />
            )
          })}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11.5, color: T.text3 }}>From</span>
          <input type="date" value={range.start} max={range.end} style={inp}
                 onChange={e => setRange(r => ({ ...r, start: e.target.value || r.start }))} />
          <span style={{ fontSize: 11.5, color: T.text3 }}>to</span>
          <input type="date" value={range.end} min={range.start} style={inp}
                 onChange={e => setRange(r => ({ ...r, end: e.target.value || r.end }))} />
          <div style={{ width: 12 }} />
          <span style={{ fontSize: 11.5, color: T.text3 }}>Salesperson</span>
          <select value={person} onChange={e => setPerson(e.target.value)} style={{ ...inp, minWidth: 150 }}>
            <option value="">Everyone</option>
            {(data?.people || []).map(pp => <option key={pp.person} value={pp.person}>{pp.person}</option>)}
          </select>
          {person && (
            <button onClick={() => setPerson('')} style={{
              background: 'none', border: `1px solid ${T.border2}`, borderRadius: 5, cursor: 'pointer',
              color: T.text2, fontSize: 11.5, fontFamily: 'inherit', padding: '5px 9px',
            }}>Clear</button>
          )}
          {data && (
            <span style={{ fontSize: 11.5, color: T.text3, marginLeft: 'auto' }}>
              {data.period.days} days{person ? ` · ${person} only` : ''}
            </span>
          )}
        </div>

        {loading || !data ? (
          <div style={{ display: 'grid', gap: 14 }}>
            <Skeleton height={70} /><Skeleton height={210} /><Skeleton height={250} /><Skeleton height={140} />
          </div>
        ) : (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(175px, 1fr))', gap: 12 }}>
              <KPI label={person ? `${person} · total` : 'Total for range'} value={fmtMoney(data.totals.total)} accent={T.blue}
                   sub={`${fmtInt(data.totals.ordersCount + data.totals.distCount)} orders & bookings`} />
              <KPI label="This month to date" value={fmtMoney(data.totals.monthToDate)} />
              <KPI label="This year to date" value={fmtMoney(data.totals.yearToDate)} />
              <KPI label="Average trading day"
                   value={data.totals.avgPerTradingDay == null ? '—' : fmtMoney(data.totals.avgPerTradingDay)}
                   sub={`over ${fmtInt(data.totals.tradingDays)} days with sales`} />
              <KPI label="Best day"
                   value={data.totals.bestDay ? fmtMoney(data.totals.bestDay.total) : '—'}
                   sub={data.totals.bestDay ? dayLabel(data.totals.bestDay.date) : undefined} />
              <KPI label="Best month"
                   value={data.totals.bestMonth ? fmtMoney(data.totals.bestMonth.total) : '—'}
                   sub={data.totals.bestMonth ? monthLabel(data.totals.bestMonth.month) : undefined} />
            </div>

            <div style={card}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, gap: 12, flexWrap: 'wrap' }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: T.text }}>Daily — last {data.dailyWindowDays} days</div>
                <div style={{ display: 'flex', gap: 6 }}>
                  {[30, 60, 90].map(d => <Chip key={d} label={`${d}d`} active={days === d} onClick={() => setDays(d)} />)}
                </div>
              </div>
              <DailyBars daily={data.daily} />
              <div style={{ fontSize: 11, color: T.text3, marginTop: 6 }}>
                Every calendar day is plotted, so quiet days and weekends show as gaps rather than being closed up.
              </div>
            </div>

            <div style={card}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, gap: 12, flexWrap: 'wrap' }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: T.text }}>Monthly</div>
                <Legend />
              </div>
              <MonthlyStack monthly={data.monthly} />
            </div>

            <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
              <div style={{ padding: '12px 16px', fontSize: 13, fontWeight: 600, color: T.text, borderBottom: `1px solid ${T.border}`, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'baseline' }}>
                By salesperson
                <span style={{ fontWeight: 400, color: T.text3, fontSize: 11.5 }}>
                  whole range, whoever is selected above · click a row to filter
                </span>
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                  <thead>
                    <tr style={{ background: T.bg3 }}>
                      <th style={th}>Salesperson</th>
                      <th style={thR}>Orders</th>
                      <th style={thR}>Order value</th>
                      <th style={thR}>Bookings</th>
                      <th style={thR}>Booking value</th>
                      <th style={thR}>Total</th>
                      <th style={thR}>Share</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.people.map(pp => {
                      const on = person === pp.person
                      return (
                        <tr key={pp.person} onClick={() => setPerson(on ? '' : pp.person)}
                            style={{ borderTop: `1px solid ${T.border}`, cursor: 'pointer', background: on ? T.bg3 : undefined }}>
                          <td style={{ ...td, fontWeight: on ? 600 : 400 }}>{pp.person}</td>
                          <td style={tdN}>{fmtInt(pp.ordersCount)}</td>
                          <td style={tdN}>{fmtMoney(pp.ordersValue)}</td>
                          <td style={tdN}>{fmtInt(pp.distCount)}</td>
                          <td style={tdN}>{fmtMoney(pp.distValue)}</td>
                          <td style={{ ...tdN, fontWeight: 600 }}>{fmtMoney(pp.total)}</td>
                          <td style={tdN}>{pp.sharePct.toFixed(1)}%</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16 }}>
              <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
                <div style={{ padding: '12px 16px', fontSize: 13, fontWeight: 600, color: T.text, borderBottom: `1px solid ${T.border}` }}>
                  Workshop orders by sale type
                </div>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                  <tbody>
                    {data.byProcess.map(p => (
                      <tr key={p.process} style={{ borderTop: `1px solid ${T.border}` }}>
                        <td style={td}>{p.process}</td>
                        <td style={tdN}>{fmtInt(p.count)}</td>
                        <td style={{ ...tdN, fontWeight: 600 }}>{fmtMoney(p.value)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
                <div style={{ padding: '12px 16px', fontSize: 13, fontWeight: 600, color: T.text, borderBottom: `1px solid ${T.border}` }}>
                  Split
                </div>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                  <tbody>
                    <tr style={{ borderTop: `1px solid ${T.border}` }}>
                      <td style={td}>Workshop orders</td>
                      <td style={tdN}>{fmtInt(data.totals.ordersCount)}</td>
                      <td style={{ ...tdN, fontWeight: 600 }}>{fmtMoney(data.totals.ordersValue)}</td>
                    </tr>
                    <tr style={{ borderTop: `1px solid ${T.border}` }}>
                      <td style={td}>Distributor bookings</td>
                      <td style={tdN}>{fmtInt(data.totals.distCount)}</td>
                      <td style={{ ...tdN, fontWeight: 600 }}>{fmtMoney(data.totals.distValue)}</td>
                    </tr>
                    <tr style={{ borderTop: `1px solid ${T.border}`, background: T.bg3 }}>
                      <td style={{ ...td, fontWeight: 600 }}>Total</td>
                      <td style={tdN}>{fmtInt(data.totals.ordersCount + data.totals.distCount)}</td>
                      <td style={{ ...tdN, fontWeight: 700 }}>{fmtMoney(data.totals.total)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            <div style={{ fontSize: 11.5, color: T.text3, lineHeight: 1.5 }}>
              Source: the Monday Orders board and Distributor - Booking board, live on load, using the same definition of a
              sale as the Weekly Sales Recap — cancelled and deleted orders are excluded, as are the Distributor bookings
              still sitting in pending or postponed groups. Where a row names more than one person it counts against the
              first, so the per-salesperson rows still add up to the total. <strong>These are orders and bookings taken,
              not invoiced turnover</strong>; invoiced turnover is on Reports → Forecast, and the two will not agree.
            </div>
          </>
        )}
      </div>
    </div>
  )
}

const th: React.CSSProperties = { padding: '8px 12px', textAlign: 'left', fontSize: 11, fontWeight: 600, color: T.text2, textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap' }
const thR: React.CSSProperties = { ...th, textAlign: 'right' }
const td: React.CSSProperties = { padding: '8px 12px', color: T.text, whiteSpace: 'nowrap' }
const tdN: React.CSSProperties = { ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }
