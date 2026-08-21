// components/reports/SalesPipelineView.tsx
// Reports → Sales Dashboard, Pipeline view — the quote pipeline across the five
// rep Quote Channel boards. The Figures view (SalesFiguresView) carries the
// daily/monthly/overall sales money; this is what is still open and unconverted.
//
// NOT the same thing as Reports → Sales Report, which counts orders taken.
// This is what is quoted and open, by stage, by rep, and what converted.
//
// Colour: the same validated blue/amber pair as the Forecast report. Green/red
// for won/lost was tested and rejected — deutan separation ΔE 7.2, i.e. the
// classic red/green trap. Blue/amber scores ΔE 27–35 across protan, deutan and
// tritan, and both modes clear 3:1 against their own surface.
// GOTCHA: CSS-var colours don't resolve in SVG presentation ATTRIBUTES — every
// fill goes through style={{}}.

import React, { useEffect, useMemo, useState } from 'react'
import { T } from '../../lib/ui/theme'
import { KPI, Chip, Skeleton } from '../ui'

interface StageBucket { stage: string; count: number; value: number }
interface RepRow {
  rep: string; boardId: string
  openCount: number; openValue: number
  wonCount: number; wonValue: number
  lostCount: number; lostValue: number
  winRatePct: number | null
}
interface MonthlyRow { month: string; wonCount: number; wonValue: number; lostCount: number; lostValue: number }
interface AgeBucket { label: string; count: number; value: number }
interface ApiResp {
  period: { since: string; until: string; months: number }
  stages: StageBucket[]
  openTotal: { count: number; value: number }
  ageBuckets: AgeBucket[]
  reps: RepRow[]
  monthly: MonthlyRow[]
  totals: { wonCount: number; wonValue: number; lostCount: number; lostValue: number; winRatePct: number | null }
  unknownGroups: { rep: string; title: string; count: number; value: number }[]
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

function niceMax(v: number): number {
  if (v <= 0) return 1
  const exp = Math.pow(10, Math.floor(Math.log10(v)))
  const f = v / exp
  const nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10
  return nf * exp
}
const monthLabel = (k: string) => {
  const [y, m] = k.split('-')
  return `${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][Number(m) - 1] || m} ${y.slice(2)}`
}

// ── Open pipeline by stage — one series, so no legend; the title names it ──
function StageBars({ stages }: { stages: StageBucket[] }) {
  if (!stages.length) return <Empty>No open quotes on the boards.</Empty>
  const max = niceMax(Math.max(...stages.map(s => s.value)))
  const rowH = 30
  const W = 720, padL = 132, padR = 92
  const H = stages.length * rowH + 8
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img"
         aria-label="Open quote value by pipeline stage">
      {stages.map((s, i) => {
        const y = i * rowH + 4
        const w = Math.max(1, (s.value / max) * (W - padL - padR))
        return (
          <g key={s.stage}>
            <text x={padL - 8} y={y + rowH / 2 + 3} textAnchor="end" fontSize={11} style={{ fill: 'var(--t-text2)' }}>{s.stage}</text>
            <rect x={padL} y={y + 5} width={w} height={rowH - 12} rx={3} style={{ fill: 'var(--sd-open)' }}>
              <title>{`${s.stage} — ${fmtMoney(s.value)} across ${fmtInt(s.count)} quote${s.count === 1 ? '' : 's'}`}</title>
            </rect>
            <text x={padL + w + 7} y={y + rowH / 2 + 3} fontSize={10.5} style={{ fill: 'var(--t-text3)' }}>
              {fmtMoneyShort(s.value)} · {fmtInt(s.count)}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

// ── Won vs lost by month — two series, legend always present ──────────────
function WonLostBars({ monthly }: { monthly: MonthlyRow[] }) {
  if (!monthly.length) return <Empty>Nothing closed in this window.</Empty>
  const W = 760, H = 240
  const pad = { t: 12, r: 12, b: 30, l: 54 }
  const plotW = W - pad.l - pad.r, plotH = H - pad.t - pad.b
  const max = niceMax(Math.max(...monthly.flatMap(m => [m.wonValue, m.lostValue])))
  const y = (v: number) => pad.t + plotH - (v / max) * plotH
  const groupW = plotW / monthly.length
  const barW = Math.max(3, (groupW - 10) / 2 - 1)
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(f => f * max)
  // Label every other month when the window is long, so labels never collide.
  const every = monthly.length > 14 ? 2 : 1

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img"
         aria-label="Quote value won and lost by month">
      {ticks.map((t, i) => (
        <g key={i}>
          <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} strokeWidth={1} style={{ stroke: 'var(--t-border)' }} />
          <text x={pad.l - 6} y={y(t) + 3} textAnchor="end" fontSize={9} style={{ fill: 'var(--t-text3)' }}>{fmtMoneyShort(t)}</text>
        </g>
      ))}
      {monthly.map((m, i) => {
        const gx = pad.l + i * groupW + 5
        return (
          <g key={m.month}>
            {([['Won', m.wonValue, m.wonCount, 'var(--sd-won)'], ['Lost', m.lostValue, m.lostCount, 'var(--sd-lost)']] as const).map(([lbl, v, c, colour], si) => {
              if (!v) return null
              const h = Math.max(1, (v / max) * plotH)
              return (
                <rect key={lbl} x={gx + si * (barW + 2)} y={pad.t + plotH - h} width={barW} height={h} rx={2} style={{ fill: colour }}>
                  <title>{`${monthLabel(m.month)} — ${lbl} ${fmtMoney(v)} (${fmtInt(c)} quote${c === 1 ? '' : 's'})`}</title>
                </rect>
              )
            })}
            {i % every === 0 && (
              <text x={gx + barW + 1} y={H - pad.b + 14} textAnchor="middle" fontSize={8.5} style={{ fill: 'var(--t-text3)' }}>
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
      {[['Won', 'var(--sd-won)'], ['Lost', 'var(--sd-lost)']].map(([l, c]) => (
        <div key={l} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 10, height: 10, borderRadius: 2, background: c, display: 'inline-block' }} />
          <span style={{ fontSize: 11.5, color: T.text2 }}>{l}</span>
        </div>
      ))}
    </div>
  )
}

const card: React.CSSProperties = { background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 10, padding: 16 }

export default function SalesPipelineView() {
  const [data, setData] = useState<ApiResp | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [months, setMonths] = useState(12)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let live = true
    setLoading(true); setErr(null)
    fetch(`/api/reports/sales-dashboard?months=${months}`)
      .then(async r => {
        const j = await r.json()
        if (!r.ok) throw new Error(j?.message || j?.error || `HTTP ${r.status}`)
        return j
      })
      .then(j => { if (live) { setData(j); setLoading(false) } })
      .catch(e => { if (live) { setErr(e.message || String(e)); setLoading(false) } })
    return () => { live = false }
  }, [months])

  const avgOpen = useMemo(
    () => (data && data.openTotal.count ? data.openTotal.value / data.openTotal.count : null),
    [data],
  )

  if (err) return <div style={{ padding: 24, color: T.red, fontSize: 13 }}>Sales dashboard unavailable — {err}</div>

  return (
    <div style={{ height: '100%', overflowY: 'auto', padding: 20 }}>
      <style>{`
        .sd { --sd-won: #4f8ef7; --sd-lost: #f5a623; --sd-open: #4f8ef7; }
        html[data-theme="light"] .sd { --sd-won: #3f7ae0; --sd-lost: #b06f08; --sd-open: #3f7ae0; }
      `}</style>

      <div className="sd" style={{ display: 'grid', gap: 16, maxWidth: 1180, margin: '0 auto' }}>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: T.text }}>Quote pipeline</div>
          <div style={{ fontSize: 11.5, color: T.text3 }}>
            Open pipeline is always current · won/lost over the selected window
          </div>
          <div style={{ flex: 1 }} />
          {[3, 6, 12, 24].map(m => (
            <Chip key={m} label={`${m}m`} active={months === m} onClick={() => setMonths(m)} />
          ))}
        </div>

        {loading || !data ? (
          <div style={{ display: 'grid', gap: 14 }}>
            <Skeleton height={70} /><Skeleton height={200} /><Skeleton height={240} /><Skeleton height={200} />
          </div>
        ) : (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
              <KPI label="Open pipeline" value={fmtMoney(data.openTotal.value)}
                   accent={T.blue} sub={`${fmtInt(data.openTotal.count)} quotes open`} />
              <KPI label={`Won · last ${data.period.months}m`} value={fmtMoney(data.totals.wonValue)}
                   sub={`${fmtInt(data.totals.wonCount)} quotes`} />
              <KPI label={`Lost · last ${data.period.months}m`} value={fmtMoney(data.totals.lostValue)}
                   sub={`${fmtInt(data.totals.lostCount)} quotes`} />
              <KPI label="Win rate"
                   value={data.totals.winRatePct == null ? '—' : `${data.totals.winRatePct.toFixed(1)}%`}
                   sub="of quotes decided in the window" />
              <KPI label="Average open quote" value={avgOpen == null ? '—' : fmtMoney(avgOpen)} />
            </div>

            <div style={card}>
              <div style={{ fontSize: 13, fontWeight: 600, color: T.text, marginBottom: 12 }}>Open quote value by stage</div>
              <StageBars stages={data.stages} />
            </div>

            <div style={card}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, gap: 12, flexWrap: 'wrap' }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: T.text }}>Won vs lost by month</div>
                <Legend />
              </div>
              <WonLostBars monthly={data.monthly} />
            </div>

            <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
              <div style={{ padding: '12px 16px', fontSize: 13, fontWeight: 600, color: T.text, borderBottom: `1px solid ${T.border}` }}>
                By rep
                <span style={{ fontWeight: 400, color: T.text3, fontSize: 11.5, marginLeft: 8 }}>
                  attributed by quote channel, not the Owner column
                </span>
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                  <thead>
                    <tr style={{ background: T.bg3 }}>
                      <th style={th}>Rep</th>
                      <th style={thR}>Open</th>
                      <th style={thR}>Open value</th>
                      <th style={thR}>Won</th>
                      <th style={thR}>Won value</th>
                      <th style={thR}>Lost</th>
                      <th style={thR}>Win rate</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.reps.map(r => (
                      <tr key={r.boardId} style={{ borderTop: `1px solid ${T.border}` }}>
                        <td style={td}>{r.rep}</td>
                        <td style={tdN}>{fmtInt(r.openCount)}</td>
                        <td style={tdN}>{fmtMoney(r.openValue)}</td>
                        <td style={tdN}>{fmtInt(r.wonCount)}</td>
                        <td style={{ ...tdN, fontWeight: 600 }}>{fmtMoney(r.wonValue)}</td>
                        <td style={tdN}>{fmtInt(r.lostCount)}</td>
                        <td style={tdN}>{r.winRatePct == null ? '—' : `${r.winRatePct.toFixed(1)}%`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div style={card}>
              <div style={{ fontSize: 13, fontWeight: 600, color: T.text, marginBottom: 10 }}>How long open quotes have been sitting</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10 }}>
                {data.ageBuckets.map(b => (
                  <div key={b.label} style={{ border: `1px solid ${T.border}`, borderRadius: 8, padding: '10px 12px' }}>
                    <div style={{ fontSize: 11, color: T.text3, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{b.label}</div>
                    <div style={{ fontSize: 16, fontWeight: 600, color: T.text, marginTop: 4 }}>{fmtMoney(b.value)}</div>
                    <div style={{ fontSize: 11.5, color: T.text2 }}>{fmtInt(b.count)} quotes</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Non-standard groups are shown, not folded away, so the totals
                can always be reconciled back to the boards. */}
            {data.unknownGroups.length > 0 && (
              <div style={{ ...card, borderColor: T.amber }}>
                <div style={{ fontSize: 12.5, fontWeight: 600, color: T.text, marginBottom: 6 }}>
                  Counted in the open pipeline, but not standard pipeline stages
                </div>
                <div style={{ fontSize: 12, color: T.text2, lineHeight: 1.6 }}>
                  {data.unknownGroups.map(u => (
                    <div key={`${u.rep}-${u.title}`}>
                      {u.rep} — “{u.title}”: {fmtInt(u.count)} quotes, {fmtMoney(u.value)}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div style={{ fontSize: 11.5, color: T.text3, lineHeight: 1.5 }}>
              Source: the five Monday Quote Channel boards, live on load. “Won/lost” counts quotes whose Date falls in the
              selected window; open pipeline is everything currently sitting in a non-closed group, whatever its date.
              Quotes are attributed to the rep whose channel they sit on — the Owner column is only populated on
              currently-active quotes, so it can’t carry history. “Quote - Not issued” is excluded from every figure.
              Distinct from Reports → Sales Report, which counts orders taken rather than quotes.
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
