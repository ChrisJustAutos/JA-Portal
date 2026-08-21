// components/reports/SalesManagementView.tsx
// Reports → Sales Dashboard, MANAGEMENT view — the portal rebuild of the Monday
// "Management Dashboard" (321206), widget for widget:
//
//   Monthly Sales Orders Target P/M   → sales per month vs the monthly target
//   Monthly Sales Orders Target P/P   → sales per salesperson vs their target
//   Monthly Sales Order Target P/D    → sales per day vs the daily target
//   Cancelled Order · Postponed Orders → exception totals (Orders board groups)
//   Staff Parts Owing                  → source not yet identified, see below
//
// Each chart keeps its own natural period, exactly as Monday's do, because each
// target is stated per that period:
//   • P/M — last 18 months
//   • P/P — the CURRENT MONTH (the per-person target is a monthly one; the five
//     reps summing to roughly one month's total is what gave this away)
//   • P/D — last 30 days
// That is why this view makes two calls rather than sharing one date range.
//
// Colour: the validated blue/amber pair used across these reports. Monday
// stacks Orders (blue) under Distributor - Booking (orange) and so does this.
// GOTCHA: CSS-var colours don't resolve in SVG presentation ATTRIBUTES — every
// fill goes through style={{}}.

import React, { useEffect, useState } from 'react'
import { T } from '../../lib/ui/theme'
import { KPI, Skeleton } from '../ui'

interface DayRow { date: string; ordersValue: number; distValue: number; total: number }
interface MonthRow { month: string; ordersValue: number; distValue: number; total: number }
interface PersonRow { person: string; ordersValue: number; distValue: number; total: number }
interface Targets { perMonth: number; perPerson: number; perDay: number }
interface Exceptions {
  cancelled: { count: number; value: number }
  postponed: { count: number; value: number }
  includesPreviousYears: boolean
}
interface Resp {
  daily: DayRow[]; monthly: MonthRow[]; people: PersonRow[]
  targets: Targets; exceptions: Exceptions | null
  period: { since: string; until: string }
}

const fmtMoney = (n: number) => (n < 0 ? '-$' : '$') + Math.round(Math.abs(n)).toLocaleString('en-AU')
const fmtMoneyShort = (n: number) => {
  const a = Math.abs(n), s = n < 0 ? '-$' : '$'
  if (a >= 1e6) return s + (a / 1e6).toFixed(1) + 'M'
  if (a >= 10000) return s + Math.round(a / 1000) + 'k'
  if (a >= 1000) return s + (a / 1000).toFixed(1) + 'k'
  return s + Math.round(a)
}
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
const monthLabel = (k: string) => { const [y, m] = k.split('-'); return `${MON[Number(m) - 1] || m} ${y.slice(2)}` }
const dayLabel = (k: string) => { const d = new Date(k + 'T00:00:00Z'); return `${d.getUTCDate()} ${MON[d.getUTCMonth()]}` }
const ymd = (d: Date) => d.toISOString().slice(0, 10)

function niceMax(v: number): number {
  if (v <= 0) return 1
  const exp = Math.pow(10, Math.floor(Math.log10(v)))
  const f = v / exp
  const nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10
  return nf * exp
}

/** Stacked orders+distributor bars against a target line. */
function TargetChart({ rows, target, labelOf, height = 250, stacked = true }: {
  rows: Array<{ key: string; ordersValue: number; distValue: number; total: number }>
  target: number
  labelOf: (k: string) => string
  height?: number
  stacked?: boolean
}) {
  if (!rows.length) {
    return <div style={{ padding: '40px 0', textAlign: 'center', fontSize: 12, color: T.text3 }}>Nothing in this period.</div>
  }
  const W = 780, H = height
  const pad = { t: 18, r: 14, b: 34, l: 58 }
  const plotW = W - pad.l - pad.r, plotH = H - pad.t - pad.b
  // The target must always be visible, even in a bad month.
  const max = niceMax(Math.max(...rows.map(r => r.total), target))
  const y = (v: number) => pad.t + plotH - (v / max) * plotH
  const slot = plotW / rows.length
  const barW = Math.min(44, Math.max(3, slot - (slot > 14 ? 8 : 2)))
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(f => f * max)
  const every = Math.max(1, Math.ceil(rows.length / 14))

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img"
         aria-label="Sales against target">
      {ticks.map((t, i) => (
        <g key={i}>
          <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} strokeWidth={1} style={{ stroke: 'var(--t-border)' }} />
          <text x={pad.l - 6} y={y(t) + 3} textAnchor="end" fontSize={9} style={{ fill: 'var(--t-text3)' }}>{fmtMoneyShort(t)}</text>
        </g>
      ))}

      {rows.map((r, i) => {
        const x = pad.l + i * slot + (slot - barW) / 2
        const hOrders = r.ordersValue > 0 ? Math.max(1, (r.ordersValue / max) * plotH) : 0
        const hDist = r.distValue > 0 ? Math.max(1, (r.distValue / max) * plotH) : 0
        const hTotal = Math.max(1, (r.total / max) * plotH)
        const met = r.total >= target
        return (
          <g key={r.key}>
            {stacked ? (
              <>
                {hOrders > 0 && (
                  <rect x={x} y={pad.t + plotH - hOrders} width={barW} height={hOrders} rx={2} style={{ fill: 'var(--sm-orders)' }}>
                    <title>{`${labelOf(r.key)} — orders ${fmtMoney(r.ordersValue)}`}</title>
                  </rect>
                )}
                {hDist > 0 && (
                  // 2px gap so the segments never read as one block.
                  <rect x={x} y={pad.t + plotH - hOrders - hDist - (hOrders > 0 ? 2 : 0)} width={barW} height={hDist} rx={2}
                        style={{ fill: 'var(--sm-dist)' }}>
                    <title>{`${labelOf(r.key)} — distributor ${fmtMoney(r.distValue)}`}</title>
                  </rect>
                )}
              </>
            ) : (
              <rect x={x} y={pad.t + plotH - hTotal} width={barW} height={hTotal} rx={2}
                    style={{ fill: met ? 'var(--sm-orders)' : 'var(--sm-under)' }}>
                <title>{`${labelOf(r.key)} — ${fmtMoney(r.total)} (${met ? 'target met' : `${fmtMoney(target - r.total)} short`})`}</title>
              </rect>
            )}
            {/* Total sits above the bar, and says whether target was met — so
                the comparison never rests on bar height alone. */}
            {rows.length <= 14 && (
              <text x={x + barW / 2} y={pad.t + plotH - hTotal - 5} textAnchor="middle" fontSize={8.5}
                    style={{ fill: met ? 'var(--t-text2)' : 'var(--t-text3)' }}>
                {fmtMoneyShort(r.total)}
              </text>
            )}
            {i % every === 0 && (
              <text x={x + barW / 2} y={H - pad.b + 14} textAnchor="middle" fontSize={8.5} style={{ fill: 'var(--t-text3)' }}>
                {labelOf(r.key)}
              </text>
            )}
          </g>
        )
      })}

      {/* Target line last, so it sits over the bars. */}
      <line x1={pad.l} x2={W - pad.r} y1={y(target)} y2={y(target)} strokeWidth={1.5} strokeDasharray="5 3"
            style={{ stroke: 'var(--sm-target)' }} />
      <text x={W - pad.r} y={y(target) - 5} textAnchor="end" fontSize={9} style={{ fill: 'var(--sm-target)' }}>
        Target {fmtMoneyShort(target)}
      </text>
    </svg>
  )
}

function Legend({ stacked }: { stacked: boolean }) {
  const items = stacked
    ? [['Orders', 'var(--sm-orders)'], ['Distributor - Booking', 'var(--sm-dist)'], ['Target', 'var(--sm-target)']]
    : [['At or over target', 'var(--sm-orders)'], ['Under target', 'var(--sm-under)'], ['Target', 'var(--sm-target)']]
  return (
    <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
      {items.map(([l, c]) => (
        <div key={l} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 10, height: 10, borderRadius: 2, background: c, display: 'inline-block' }} />
          <span style={{ fontSize: 11.5, color: T.text2 }}>{l}</span>
        </div>
      ))}
    </div>
  )
}

const card: React.CSSProperties = { background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 10, padding: 16 }
const cardHead: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, gap: 12, flexWrap: 'wrap' }

export default function SalesManagementView() {
  const [wide, setWide] = useState<Resp | null>(null)   // 18 months + 30 days + exceptions
  const [month, setMonth] = useState<Resp | null>(null) // current month, for per-person
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    const now = new Date()
    const firstOfMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`
    const today = ymd(now)

    const get = async (qs: string) => {
      const r = await fetch(`/api/reports/sales-figures?${qs}`)
      const j = await r.json()
      if (!r.ok) throw new Error(j?.message || j?.error || `HTTP ${r.status}`)
      return j as Resp
    }

    Promise.all([
      get('months=18&days=30&exceptions=1'),
      get(`start=${firstOfMonth}&end=${today}&days=31`),
    ])
      .then(([w, m]) => { if (live) { setWide(w); setMonth(m) } })
      .catch(e => { if (live) setErr(e.message || String(e)) })
    return () => { live = false }
  }, [])

  if (err) return <div style={{ padding: 24, color: T.red, fontSize: 13 }}>Management figures unavailable — {err}</div>

  if (!wide || !month) {
    return (
      <div style={{ padding: 20, display: 'grid', gap: 14 }}>
        <Skeleton height={250} /><Skeleton height={250} /><Skeleton height={120} />
      </div>
    )
  }

  const t = wide.targets
  const monthlyRows = wide.monthly.map(m => ({ key: m.month, ordersValue: m.ordersValue, distValue: m.distValue, total: m.total }))
  const dailyRows = wide.daily.map(d => ({ key: d.date, ordersValue: d.ordersValue, distValue: d.distValue, total: d.total }))
  // Per person, current month only — Unassigned excluded so the rep comparison
  // isn't distorted by rows with nobody set (it's reported on the Figures view).
  const peopleRows = month.people
    .filter(p => p.person !== 'Unassigned')
    .map(p => ({ key: p.person, ordersValue: p.ordersValue, distValue: p.distValue, total: p.total }))

  const monthName = new Date().toLocaleDateString('en-AU', { month: 'long', year: 'numeric' })
  const metCount = peopleRows.filter(p => p.total >= t.perPerson).length

  return (
    <div style={{ height: '100%', overflowY: 'auto', padding: 20 }}>
      <style>{`
        .sm { --sm-orders: #4f8ef7; --sm-dist: #f5a623; --sm-target: #e0567c; --sm-under: #8b90a0; }
        html[data-theme="light"] .sm { --sm-orders: #3f7ae0; --sm-dist: #b06f08; --sm-target: #c02e57; --sm-under: #9097a6; }
      `}</style>

      <div className="sm" style={{ display: 'grid', gap: 16, maxWidth: 1180, margin: '0 auto' }}>

        <div style={card}>
          <div style={cardHead}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: T.text }}>Sales orders vs target — per month</div>
              <div style={{ fontSize: 11.5, color: T.text3 }}>last 18 months · target {fmtMoney(t.perMonth)} a month</div>
            </div>
            <Legend stacked />
          </div>
          <TargetChart rows={monthlyRows} target={t.perMonth} labelOf={monthLabel} />
        </div>

        <div style={card}>
          <div style={cardHead}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: T.text }}>Sales orders vs target — per salesperson</div>
              <div style={{ fontSize: 11.5, color: T.text3 }}>
                {monthName} to date · target {fmtMoney(t.perPerson)} each · {metCount} of {peopleRows.length} at target
              </div>
            </div>
            <Legend stacked={false} />
          </div>
          <TargetChart rows={peopleRows} target={t.perPerson} labelOf={k => k} stacked={false} height={230} />
        </div>

        <div style={card}>
          <div style={cardHead}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: T.text }}>Sales orders vs target — per day</div>
              <div style={{ fontSize: 11.5, color: T.text3 }}>last 30 days · target {fmtMoney(t.perDay)} a day</div>
            </div>
            <Legend stacked />
          </div>
          <TargetChart rows={dailyRows} target={t.perDay} labelOf={dayLabel} height={220} />
        </div>

        {/* Exception totals. Deliberately NOT part of any sales figure —
            cancelled and postponed work isn't revenue. */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: 12 }}>
          <KPI label="Cancelled orders"
               value={wide.exceptions ? fmtMoney(wide.exceptions.cancelled.value) : '—'}
               sub={wide.exceptions ? `${wide.exceptions.cancelled.count} orders${wide.exceptions.includesPreviousYears ? ', incl. previous years' : ''}` : undefined} />
          <KPI label="Postponed orders"
               value={wide.exceptions ? fmtMoney(wide.exceptions.postponed.value) : '—'}
               sub={wide.exceptions ? `${wide.exceptions.postponed.count} orders` : undefined} />
          <KPI label="Staff parts owing" value="—" sub="source not wired up — see below" />
        </div>

        <div style={{ fontSize: 11.5, color: T.text3, lineHeight: 1.6 }}>
          Cancelled and postponed are whole-board group totals with no date filter, matching the Monday widgets — the
          group is the authority, not the status column, so an order sitting in Postponed still counts even if its status
          says Done. They are <strong>excluded from every sales figure</strong>: cancelled and postponed work isn’t
          revenue. <strong>Staff parts owing is not built</strong> — there is no board of that name, so it must be a
          filtered view on one of the connected boards; tell me which and it’s a five-minute addition. Targets are
          {' '}{fmtMoney(t.perMonth)}/month, {fmtMoney(t.perPerson)}/salesperson/month and {fmtMoney(t.perDay)}/day, and
          are changeable without a deploy (<code>SALES_TARGET_PER_MONTH</code>, <code>_PER_PERSON</code>,
          {' '}<code>_PER_DAY</code>). Per-salesperson covers the current month only, because the target is a monthly one;
          rows with nobody set are left out of that comparison and reported on the Figures view instead.
        </div>
      </div>
    </div>
  )
}
