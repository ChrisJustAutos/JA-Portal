// components/reports/MgmtDashboard.tsx
// Reports → Management Dashboard — the portal-native rebuild of the JAWS
// weekly management Excel. KPI cards up top (cash, days-cash, MTD projection,
// stock-to-sales, headline sentence) then a responsive grid of hand-rolled SVG
// charts (rolling revenue+GP, revenue mix, weekly category stack, top-10
// inventory, parts-mix pie, top-10 customers). All figures come from
// GET /api/reports/mgmt-dashboard (?refresh=1 forces a re-pull from MYOB).
//
// Every chart has an Edit drawer (admin config): title, enabled, chart type
// and a GENERIC editor over the chart's config jsonb — any key holding an
// array of account codes renders as a searchable tick-box list of the chart
// of accounts (grouped income/COGS/asset/other), numbers render as number
// inputs, strings as text inputs, nested objects recurse. New config keys the
// backend grows later render without frontend changes. Save → PATCH → refetch.

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { T, alpha } from '../../lib/ui/theme'
import { KPI, Chip, inp, pbtn, qbtn, miniBtn, Skeleton } from '../ui'
import { useToast } from '../ui/Feedback'

// ── API contract ─────────────────────────────────────────────────────────
type KpiFormat = 'currency' | 'number' | 'days' | 'ratio' | 'text'
interface Kpi { key: string; label: string; value: number | string | null; format: KpiFormat; sub?: string }
type ChartType = 'bars' | 'stackedBars' | 'pie' | 'hbar'
interface Point { label: string; value: number }
interface Series { name: string; points: Point[] }
interface ChartData {
  key: string; title: string; type: ChartType
  series: Series[]
  options?: { stacked?: boolean; valueFormat?: string }
}
interface ChartCfg { key: string; title: string; enabled: boolean; chart_type: string; position: number; config: Record<string, any> }
interface AccountRef { code: string; name: string; kind: 'income' | 'cogs' | 'asset' | 'other' }
interface ApiResp {
  generatedAt: string
  kpis: Kpi[]
  charts: ChartData[]
  config: { charts: ChartCfg[]; accounts: AccountRef[] }
}

const API = '/api/reports/mgmt-dashboard'

// ── Formatting ───────────────────────────────────────────────────────────
const fmtMoney = (n: number) => (n < 0 ? '-$' : '$') + Math.round(Math.abs(n)).toLocaleString('en-AU')
const fmtMoneyShort = (n: number) => {
  const a = Math.abs(n), s = n < 0 ? '-$' : '$'
  if (a >= 1e6) return s + (a / 1e6).toFixed(1) + 'M'
  if (a >= 10000) return s + Math.round(a / 1000) + 'k'
  if (a >= 1000) return s + (a / 1000).toFixed(1) + 'k'
  return s + Math.round(a)
}
const fmtNum = (n: number) => Math.round(n * 100) / 100 % 1 === 0 ? Math.round(n).toLocaleString('en-AU') : n.toLocaleString('en-AU', { maximumFractionDigits: 2 })
// Axis / compact value per the chart's valueFormat (defaults to currency).
const fmtAxis = (n: number, vf?: string) => vf === 'number' ? fmtNum(n) : fmtMoneyShort(n)
const fmtFull = (n: number, vf?: string) => vf === 'number' ? fmtNum(n) : fmtMoney(n)

function fmtKpiValue(k: Kpi): string {
  if (k.format === 'text') return String(k.value ?? '—')
  const n = typeof k.value === 'number' ? k.value : Number(k.value)
  if (k.value == null || !isFinite(n)) return '—'
  switch (k.format) {
    case 'currency': return fmtMoney(n)
    case 'days': return `${Math.round(n * 10) / 10} days`
    case 'ratio': return `${Math.round(n * 100) / 100}×`
    default: return fmtNum(n)
  }
}

function relTime(iso: string | null): string {
  if (!iso) return 'never'
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs} hr${hrs === 1 ? '' : 's'} ago`
  const days = Math.round(hrs / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

// Series palette — literal hex accents (theme-stable, per lib/ui/theme note).
const SERIES_COLORS = [T.blue, T.teal, T.amber, T.purple, T.green, T.red, '#6ea8fe', '#ff5ac4', '#9cd326', '#4eccc6', '#fdab3d', '#c792ea']

// ── SVG chart primitives ─────────────────────────────────────────────────
// Hand-rolled — no chart library in the repo. GOTCHA: CSS-var theme tokens
// don't resolve in SVG presentation ATTRIBUTES; fill/stroke that use T tokens
// must go through style={{}} (accents are literal hex but styled the same
// way for consistency).

function niceMax(v: number): number {
  if (v <= 0) return 1
  const exp = Math.pow(10, Math.floor(Math.log10(v)))
  const f = v / exp
  const nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10
  return nf * exp
}

// Wrap a category label onto up to two lines (weekly ranges are long).
function wrapLabel(s: string, maxChars: number): string[] {
  if (s.length <= maxChars) return [s]
  const mid = Math.floor(s.length / 2)
  let best = -1
  for (let i = 0; i < s.length; i++) {
    if (s[i] === ' ' && (best === -1 || Math.abs(i - mid) < Math.abs(best - mid))) best = i
  }
  if (best === -1) return [s.slice(0, Math.max(1, maxChars - 1)) + '…']
  const lines = [s.slice(0, best), s.slice(best + 1)]
  return lines.map(l => (l.length > maxChars ? l.slice(0, Math.max(1, maxChars - 1)) + '…' : l))
}

function catsOf(series: Series[]): string[] {
  const seen = new Set<string>(); const out: string[] = []
  for (const s of series) for (const p of s.points) if (!seen.has(p.label)) { seen.add(p.label); out.push(p.label) }
  return out
}

function NoData() {
  return <div style={{ padding: '36px 0', textAlign: 'center', fontSize: 12, color: T.text3 }}>No data for this chart yet.</div>
}

function YAxis({ ticks, y, padL, W, vf }: { ticks: number[]; y: (v: number) => number; padL: number; W: number; vf?: string }) {
  return (
    <>
      {ticks.map((t, i) => (
        <g key={i}>
          <line x1={padL} x2={W - 10} y1={y(t)} y2={y(t)} strokeWidth={1} style={{ stroke: 'var(--t-border)' }} />
          <text x={padL - 6} y={y(t) + 3} textAnchor="end" fontSize={9} style={{ fill: 'var(--t-text3)' }}>{fmtAxis(t, vf)}</text>
        </g>
      ))}
    </>
  )
}

function CatLabel({ x, y, label, max }: { x: number; y: number; label: string; max: number }) {
  const lines = wrapLabel(label, max)
  return (
    <text x={x} y={y} textAnchor="middle" fontSize={8.5} style={{ fill: 'var(--t-text3)' }}>
      {lines.map((l, i) => <tspan key={i} x={x} dy={i === 0 ? 0 : 10}>{l}</tspan>)}
    </text>
  )
}

function ClusteredBars({ series, valueFormat }: { series: Series[]; valueFormat?: string }) {
  const cats = catsOf(series)
  const vals = series.flatMap(s => s.points.map(p => p.value))
  if (!cats.length || !vals.some(v => v > 0)) return <NoData />
  const W = 560, H = 250
  const pad = { l: 52, r: 10, t: 12, b: 36 }
  const plotW = W - pad.l - pad.r, plotH = H - pad.t - pad.b
  const max = niceMax(Math.max(...vals, 1))
  const y = (v: number) => pad.t + plotH - (Math.max(0, v) / max) * plotH
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(f => f * max)
  const groupW = plotW / cats.length
  const barW = Math.min(34, (groupW * 0.72) / Math.max(series.length, 1))
  const byCat = series.map(s => new Map(s.points.map(p => [p.label, p.value])))
  const labelMax = Math.max(6, Math.floor(groupW / 5.2))
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img">
      <YAxis ticks={ticks} y={y} padL={pad.l} W={W} vf={valueFormat} />
      {cats.map((c, ci) => {
        const gx = pad.l + ci * groupW + (groupW - barW * series.length) / 2
        return (
          <g key={c}>
            {series.map((s, si) => {
              const v = byCat[si].get(c) ?? 0
              const h = Math.max(v > 0 ? 1.5 : 0, (Math.max(0, v) / max) * plotH)
              return (
                <rect key={si} x={gx + si * barW} y={pad.t + plotH - h} width={Math.max(1, barW - 2)} height={h} rx={1.5}
                  style={{ fill: SERIES_COLORS[si % SERIES_COLORS.length] }}>
                  <title>{`${s.name} — ${c}: ${fmtFull(v, valueFormat)}`}</title>
                </rect>
              )
            })}
            <CatLabel x={pad.l + ci * groupW + groupW / 2} y={pad.t + plotH + 13} label={c} max={labelMax} />
          </g>
        )
      })}
    </svg>
  )
}

function StackedBars({ series, valueFormat }: { series: Series[]; valueFormat?: string }) {
  const cats = catsOf(series)
  if (!cats.length) return <NoData />
  const byCat = series.map(s => new Map(s.points.map(p => [p.label, p.value])))
  const sums = cats.map((c) => byCat.reduce((a, m) => a + Math.max(0, m.get(c) ?? 0), 0))
  if (!sums.some(v => v > 0)) return <NoData />
  const W = 560, H = 250
  const pad = { l: 52, r: 10, t: 12, b: 36 }
  const plotW = W - pad.l - pad.r, plotH = H - pad.t - pad.b
  const max = niceMax(Math.max(...sums, 1))
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(f => f * max)
  const y = (v: number) => pad.t + plotH - (v / max) * plotH
  const groupW = plotW / cats.length
  const barW = Math.min(52, groupW * 0.58)
  const labelMax = Math.max(6, Math.floor(groupW / 5.2))
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img">
      <YAxis ticks={ticks} y={y} padL={pad.l} W={W} vf={valueFormat} />
      {cats.map((c, ci) => {
        const x = pad.l + ci * groupW + (groupW - barW) / 2
        let acc = 0
        return (
          <g key={c}>
            {series.map((s, si) => {
              const v = Math.max(0, byCat[si].get(c) ?? 0)
              if (v <= 0) return null
              const y1 = y(acc + v), h = y(acc) - y(acc + v)
              acc += v
              return (
                <rect key={si} x={x} y={y1} width={barW} height={Math.max(1, h)} style={{ fill: SERIES_COLORS[si % SERIES_COLORS.length] }}>
                  <title>{`${s.name} — ${c}: ${fmtFull(v, valueFormat)}`}</title>
                </rect>
              )
            })}
            <CatLabel x={pad.l + ci * groupW + groupW / 2} y={pad.t + plotH + 13} label={c} max={labelMax} />
          </g>
        )
      })}
    </svg>
  )
}

function PieChart({ series, valueFormat }: { series: Series[]; valueFormat?: string }) {
  const pts = (series[0]?.points || []).filter(p => p.value > 0)
  const total = pts.reduce((a, p) => a + p.value, 0)
  if (!pts.length || total <= 0) return <NoData />
  const R = 86, CX = 100, CY = 100
  let angle = -Math.PI / 2
  const slices = pts.map((p, i) => {
    const a0 = angle, a1 = angle + (p.value / total) * Math.PI * 2
    angle = a1
    return { p, i, a0, a1 }
  })
  return (
    <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
      <svg viewBox="0 0 200 200" style={{ width: 190, height: 190, flexShrink: 0 }} role="img">
        {pts.length === 1 ? (
          <circle cx={CX} cy={CY} r={R} style={{ fill: SERIES_COLORS[0] }}>
            <title>{`${pts[0].label}: ${fmtFull(pts[0].value, valueFormat)} (100%)`}</title>
          </circle>
        ) : slices.map(({ p, i, a0, a1 }) => {
          const x0 = CX + R * Math.cos(a0), y0 = CY + R * Math.sin(a0)
          const x1 = CX + R * Math.cos(a1), y1 = CY + R * Math.sin(a1)
          const large = a1 - a0 > Math.PI ? 1 : 0
          return (
            <path key={i} d={`M ${CX} ${CY} L ${x0} ${y0} A ${R} ${R} 0 ${large} 1 ${x1} ${y1} Z`}
              strokeWidth={1} style={{ fill: SERIES_COLORS[i % SERIES_COLORS.length], stroke: 'var(--t-bg2)' }}>
              <title>{`${p.label}: ${fmtFull(p.value, valueFormat)} (${Math.round((p.value / total) * 100)}%)`}</title>
            </path>
          )
        })}
      </svg>
      <div style={{ flex: 1, minWidth: 170, display: 'flex', flexDirection: 'column', gap: 5 }}>
        {pts.map((p, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11.5 }}>
            <span style={{ width: 9, height: 9, borderRadius: 3, flexShrink: 0, background: SERIES_COLORS[i % SERIES_COLORS.length] }} />
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: T.text2 }} title={p.label}>{p.label}</span>
            <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{fmtAxis(p.value, valueFormat)}</span>
            <span style={{ color: T.text3, fontVariantNumeric: 'tabular-nums', width: 34, textAlign: 'right' }}>{Math.round((p.value / total) * 100)}%</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function HBar({ series, valueFormat }: { series: Series[]; valueFormat?: string }) {
  const pts = series[0]?.points || []
  if (!pts.length || !pts.some(p => p.value > 0)) return <NoData />
  const W = 560, rowH = 26
  const pad = { l: 168, r: 66, t: 6, b: 6 }
  const H = pad.t + pts.length * rowH + pad.b
  const plotW = W - pad.l - pad.r
  const max = Math.max(...pts.map(p => p.value), 1)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img">
      {pts.map((p, i) => {
        const yTop = pad.t + i * rowH
        const w = Math.max(p.value > 0 ? 2 : 0, (Math.max(0, p.value) / max) * plotW)
        const name = p.label.length > 26 ? p.label.slice(0, 25) + '…' : p.label
        return (
          <g key={i}>
            <text x={pad.l - 8} y={yTop + rowH / 2 + 3} textAnchor="end" fontSize={10} style={{ fill: 'var(--t-text2)' }}>
              <title>{p.label}</title>{name}
            </text>
            <rect x={pad.l} y={yTop + 5} width={w} height={rowH - 10} rx={2} style={{ fill: SERIES_COLORS[0] }}>
              <title>{`${p.label}: ${fmtFull(p.value, valueFormat)}`}</title>
            </rect>
            <text x={pad.l + w + 6} y={yTop + rowH / 2 + 3} fontSize={9.5} style={{ fill: 'var(--t-text3)' }}>{fmtAxis(p.value, valueFormat)}</text>
          </g>
        )
      })}
    </svg>
  )
}

function ChartLegend({ series }: { series: Series[] }) {
  if (series.length <= 1) return null
  return (
    <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 8 }}>
      {series.map((s, i) => (
        <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, color: T.text2 }}>
          <span style={{ width: 9, height: 9, borderRadius: 3, background: SERIES_COLORS[i % SERIES_COLORS.length] }} />
          {s.name}
        </span>
      ))}
    </div>
  )
}

function ChartBody({ chart }: { chart: ChartData }) {
  const vf = chart.options?.valueFormat
  const type = chart.options?.stacked && chart.type === 'bars' ? 'stackedBars' : chart.type
  switch (type) {
    case 'bars': return <><ClusteredBars series={chart.series} valueFormat={vf} /><ChartLegend series={chart.series} /></>
    case 'stackedBars': return <><StackedBars series={chart.series} valueFormat={vf} /><ChartLegend series={chart.series} /></>
    case 'pie': return <PieChart series={chart.series} valueFormat={vf} />
    case 'hbar': return <HBar series={chart.series} valueFormat={vf} />
    default: return <div style={{ padding: 20, fontSize: 12, color: T.text3 }}>Unknown chart type “{chart.type}”.</div>
  }
}

// ── Generic config editor ────────────────────────────────────────────────
// Renders a chart's config jsonb without knowing its shape:
//   string[]                → account tick-box list (searchable, grouped)
//   number                  → number input
//   boolean                 → checkbox
//   string                  → text input
//   plain object            → nested group (recurses)
//   anything else           → raw JSON input (validated)

function prettyKey(k: string): string {
  const s = k.replace(/_/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  return s.charAt(0).toUpperCase() + s.slice(1)
}

const KIND_ORDER: AccountRef['kind'][] = ['income', 'cogs', 'asset', 'other']
const KIND_LABELS: Record<AccountRef['kind'], string> = { income: 'Income', cogs: 'Cost of sales', asset: 'Assets', other: 'Other' }

function AccountTickList({ codes, accounts, onChange }: {
  codes: string[]; accounts: AccountRef[]; onChange: (next: string[]) => void
}) {
  const [q, setQ] = useState('')
  const sel = useMemo(() => new Set(codes), [codes])
  const ql = q.trim().toLowerCase()
  const known = useMemo(() => new Set(accounts.map(a => a.code)), [accounts])
  const orphans = codes.filter(c => !known.has(c))

  const toggle = (code: string) => {
    if (sel.has(code)) onChange(codes.filter(c => c !== code))
    else onChange([...codes, code])
  }

  const groups = KIND_ORDER.map(kind => ({
    kind,
    rows: accounts.filter(a => a.kind === kind && (!ql || a.code.toLowerCase().includes(ql) || a.name.toLowerCase().includes(ql))),
  })).filter(g => g.rows.length > 0)

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Filter accounts…" style={{ ...inp, flex: 1, fontSize: 11, padding: '5px 8px' }} />
        <span style={{ fontSize: 10, color: T.text3, whiteSpace: 'nowrap' }}>{codes.length} ticked</span>
      </div>
      <div style={{ maxHeight: 200, overflowY: 'auto', border: `1px solid ${T.border}`, borderRadius: 6, background: T.bg3, padding: '4px 0' }}>
        {orphans.length > 0 && (
          <div style={{ padding: '2px 0 4px' }}>
            <div style={groupHdr}>Not in chart of accounts</div>
            {orphans.map(c => (
              <label key={c} style={tickRow}>
                <input type="checkbox" checked onChange={() => toggle(c)} style={{ cursor: 'pointer' }} />
                <span style={{ fontFamily: 'monospace', fontSize: 10.5, color: T.amber }}>{c}</span>
              </label>
            ))}
          </div>
        )}
        {groups.map(g => (
          <div key={g.kind} style={{ padding: '2px 0 4px' }}>
            <div style={groupHdr}>{KIND_LABELS[g.kind]}</div>
            {g.rows.map(a => (
              <label key={a.code} style={tickRow}>
                <input type="checkbox" checked={sel.has(a.code)} onChange={() => toggle(a.code)} style={{ cursor: 'pointer' }} />
                <span style={{ fontFamily: 'monospace', fontSize: 10.5, color: T.text3, flexShrink: 0 }}>{a.code}</span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={a.name}>{a.name}</span>
              </label>
            ))}
          </div>
        ))}
        {groups.length === 0 && orphans.length === 0 && (
          <div style={{ padding: 10, fontSize: 11, color: T.text3 }}>No accounts match “{q}”.</div>
        )}
      </div>
    </div>
  )
}

const groupHdr: React.CSSProperties = {
  padding: '4px 10px 2px', fontSize: 9.5, fontWeight: 700, color: T.text3,
  textTransform: 'uppercase', letterSpacing: '0.06em',
}
const tickRow: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 7, padding: '3px 10px',
  fontSize: 11.5, color: T.text, cursor: 'pointer',
}
const fieldLabel: React.CSSProperties = {
  fontSize: 10.5, fontWeight: 600, color: T.text2, marginBottom: 4,
  textTransform: 'uppercase', letterSpacing: '0.04em',
}

// Fallback for config values the typed fields don't cover: raw JSON, applied
// only while it parses (invalid JSON shows a red border and isn't committed).
function JsonField({ value, onChange }: { value: any; onChange: (v: any) => void }) {
  const [text, setText] = useState(() => JSON.stringify(value))
  const [bad, setBad] = useState(false)
  return (
    <textarea
      value={text}
      onChange={e => {
        setText(e.target.value)
        try { onChange(JSON.parse(e.target.value)); setBad(false) } catch { setBad(true) }
      }}
      rows={3}
      style={{ ...inp, width: '100%', boxSizing: 'border-box', resize: 'vertical', fontFamily: 'monospace', fontSize: 10.5, borderColor: bad ? T.red : undefined }}
    />
  )
}

function ConfigField({ name, value, onChange, accounts }: {
  name: string; value: any; onChange: (v: any) => void; accounts: AccountRef[]
}) {
  // Array of strings → treat as a list of account codes (the dashboard config
  // convention); anything the accounts list doesn't know is still editable.
  if (Array.isArray(value) && value.every(x => typeof x === 'string')) {
    return (
      <div style={{ marginBottom: 14 }}>
        <div style={fieldLabel}>{prettyKey(name)}</div>
        <AccountTickList codes={value} accounts={accounts} onChange={onChange} />
      </div>
    )
  }
  if (typeof value === 'number') {
    return (
      <div style={{ marginBottom: 14 }}>
        <div style={fieldLabel}>{prettyKey(name)}</div>
        <input type="number" step="any" value={value} onChange={e => onChange(e.target.value === '' ? 0 : Number(e.target.value))}
          style={{ ...inp, width: 140 }} />
      </div>
    )
  }
  if (typeof value === 'boolean') {
    return (
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, fontSize: 12, color: T.text, cursor: 'pointer' }}>
        <input type="checkbox" checked={value} onChange={e => onChange(e.target.checked)} style={{ cursor: 'pointer' }} />
        {prettyKey(name)}
      </label>
    )
  }
  if (typeof value === 'string') {
    return (
      <div style={{ marginBottom: 14 }}>
        <div style={fieldLabel}>{prettyKey(name)}</div>
        <input value={value} onChange={e => onChange(e.target.value)} style={{ ...inp, width: '100%', boxSizing: 'border-box' }} />
      </div>
    )
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return (
      <div style={{ marginBottom: 14 }}>
        <div style={fieldLabel}>{prettyKey(name)}</div>
        <div style={{ borderLeft: `2px solid ${T.border2}`, paddingLeft: 10 }}>
          {Object.entries(value).map(([k, v]) => (
            <ConfigField key={k} name={k} value={v} accounts={accounts} onChange={nv => onChange({ ...value, [k]: nv })} />
          ))}
        </div>
      </div>
    )
  }
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={fieldLabel}>{prettyKey(name)} <span style={{ color: T.text3, fontWeight: 400, textTransform: 'none' }}>(JSON)</span></div>
      <JsonField value={value} onChange={onChange} />
    </div>
  )
}

// ── Edit drawer ──────────────────────────────────────────────────────────
const CHART_TYPES: { value: ChartType; label: string }[] = [
  { value: 'bars', label: 'Bars (clustered)' },
  { value: 'stackedBars', label: 'Bars (stacked)' },
  { value: 'pie', label: 'Pie' },
  { value: 'hbar', label: 'Horizontal bars' },
]

function EditDrawer({ cfg, accounts, saving, onSave, onClose }: {
  cfg: ChartCfg; accounts: AccountRef[]; saving: boolean
  onSave: (patch: { title: string; enabled: boolean; chart_type: string; config: Record<string, any> }) => void
  onClose: () => void
}) {
  const [title, setTitle] = useState(cfg.title)
  const [enabled, setEnabled] = useState(cfg.enabled)
  const [chartType, setChartType] = useState(cfg.chart_type)
  const [config, setConfig] = useState<Record<string, any>>(() => JSON.parse(JSON.stringify(cfg.config || {})))

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const configKeys = Object.keys(config)
  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 900 }} />
      <div style={{
        position: 'fixed', top: 0, right: 0, bottom: 0, width: 400, maxWidth: '92vw', zIndex: 901,
        background: T.bg2, borderLeft: `1px solid ${T.border2}`, boxShadow: '0 0 40px rgba(0,0,0,0.4)',
        display: 'flex', flexDirection: 'column', fontFamily: "'DM Sans', system-ui, sans-serif",
      }}>
        <div style={{ padding: '14px 18px', borderBottom: `1px solid ${T.border}`, display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: T.text }}>Edit chart</div>
            <div style={{ fontSize: 10.5, color: T.text3, fontFamily: 'monospace' }}>{cfg.key}</div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: T.text3, fontSize: 18, cursor: 'pointer', fontFamily: 'inherit', padding: 4 }} aria-label="Close">×</button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 18px' }}>
          <div style={{ marginBottom: 14 }}>
            <div style={fieldLabel}>Title</div>
            <input value={title} onChange={e => setTitle(e.target.value)} style={{ ...inp, width: '100%', boxSizing: 'border-box' }} />
          </div>

          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, fontSize: 12, color: T.text, cursor: 'pointer' }}>
            <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} style={{ cursor: 'pointer' }} />
            Show on dashboard
          </label>

          <div style={{ marginBottom: 18 }}>
            <div style={fieldLabel}>Chart type</div>
            <select value={chartType} onChange={e => setChartType(e.target.value)} style={{ ...inp, width: '100%', boxSizing: 'border-box' }}>
              {CHART_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              {!CHART_TYPES.some(t => t.value === chartType) && <option value={chartType}>{chartType}</option>}
            </select>
          </div>

          {configKeys.length > 0 && (
            <>
              <div style={{ fontSize: 11, fontWeight: 700, color: T.text2, textTransform: 'uppercase', letterSpacing: '0.06em', margin: '4px 0 10px', paddingTop: 10, borderTop: `1px solid ${T.border}` }}>
                Data configuration
              </div>
              {configKeys.map(k => (
                <ConfigField key={k} name={k} value={config[k]} accounts={accounts}
                  onChange={v => setConfig(c => ({ ...c, [k]: v }))} />
              ))}
            </>
          )}
        </div>

        <div style={{ padding: '12px 18px', borderTop: `1px solid ${T.border}`, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={qbtn(T.text2 as string)} disabled={saving}>Cancel</button>
          <button onClick={() => onSave({ title: title.trim() || cfg.title, enabled, chart_type: chartType, config })}
            style={{ ...pbtn(T.blue), opacity: saving ? 0.6 : 1 }} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </>
  )
}

// ── Main dashboard ───────────────────────────────────────────────────────
export default function MgmtDashboard() {
  const toast = useToast()
  const [data, setData] = useState<ApiResp | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<ChartCfg | null>(null)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async (refresh = false) => {
    if (refresh) setRefreshing(true); else setLoading(true)
    setError('')
    try {
      const resp = await fetch(refresh ? `${API}?refresh=1` : API)
      const d = await resp.json()
      if (!resp.ok) throw new Error(d.error || `HTTP ${resp.status}`)
      setData(d)
    } catch (e: any) {
      setError(e?.message || 'Failed to load')
    } finally {
      setLoading(false); setRefreshing(false)
    }
  }, [])
  useEffect(() => { load() }, [load])

  // Charts in configured order; enabled flag lives in config.charts.
  const charts = useMemo(() => {
    if (!data) return []
    const pos = new Map(data.config.charts.map(c => [c.key, c.position]))
    return [...data.charts].sort((a, b) => (pos.get(a.key) ?? 999) - (pos.get(b.key) ?? 999))
  }, [data])

  const hiddenCfgs = useMemo(() => (data?.config.charts || []).filter(c => !c.enabled), [data])

  const cfgFor = (chart: ChartData): ChartCfg =>
    data?.config.charts.find(c => c.key === chart.key)
      || { key: chart.key, title: chart.title, enabled: true, chart_type: chart.type, position: 999, config: {} }

  const save = async (patch: { title: string; enabled: boolean; chart_type: string; config: Record<string, any> }) => {
    if (!editing) return
    setSaving(true)
    try {
      const resp = await fetch(API, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chart_key: editing.key, patch }),
      })
      const d = await resp.json().catch(() => ({}))
      if (!resp.ok) throw new Error(d.error || `HTTP ${resp.status}`)
      toast('Chart updated', 'success')
      setEditing(null)
      await load()
    } catch (e: any) {
      toast(e?.message || 'Save failed', 'error')
    } finally {
      setSaving(false)
    }
  }

  // ── Render ──────────────────────────────────────────────────────────
  if (error && !data) {
    return (
      <div style={{ padding: 30 }}>
        <div style={{ maxWidth: 560, background: alpha(T.red, '1a'), border: `1px solid ${alpha(T.red, '33')}`, borderRadius: 10, padding: 16, color: T.red, fontSize: 13 }}>
          <div style={{ marginBottom: 10 }}>Couldn’t load the management dashboard: {error}</div>
          <button onClick={() => load()} style={pbtn(T.red)}>Retry</button>
        </div>
      </div>
    )
  }

  if (loading && !data) {
    return (
      <div style={{ padding: '20px 24px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 12, marginBottom: 18 }}>
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 10, padding: '14px 16px' }}>
              <Skeleton width="60%" height={10} /><div style={{ height: 8 }} /><Skeleton width="45%" height={20} />
            </div>
          ))}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(430px, 1fr))', gap: 16 }}>
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 10, padding: '14px 16px' }}>
              <Skeleton width="50%" height={12} /><div style={{ height: 12 }} /><Skeleton width="100%" height={180} radius={6} />
            </div>
          ))}
        </div>
      </div>
    )
  }
  if (!data) return null

  const headline = data.kpis.filter(k => k.format === 'text')
  const tiles = data.kpis.filter(k => k.format !== 'text')

  return (
    <div style={{ height: '100%', overflowY: 'auto' }}>
      <div style={{ maxWidth: 1500, margin: '0 auto', padding: '18px 24px 40px' }}>

        {/* Toolbar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ fontSize: 18, fontWeight: 700, color: T.text }}>Management Dashboard</div>
            <div style={{ fontSize: 11, color: T.text3 }}>JAWS weekly management figures — ex VPS stock transfers</div>
          </div>
          <span style={{ fontSize: 11, color: T.text3 }}>Refreshed {relTime(data.generatedAt)}</span>
          <button onClick={() => load(true)} disabled={refreshing || loading} style={{ ...qbtn(T.blue), opacity: refreshing ? 0.6 : 1 }}>
            {refreshing ? 'Refreshing…' : '↻ Refresh'}
          </button>
        </div>

        {error && (
          <div style={{ marginBottom: 14, padding: '8px 12px', borderRadius: 8, background: alpha(T.red, '1a'), border: `1px solid ${alpha(T.red, '33')}`, color: T.red, fontSize: 12 }}>
            {error}
          </div>
        )}

        {/* Headline sentence (text-format KPIs span full width) */}
        {headline.map(k => (
          <div key={k.key} style={{
            marginBottom: 12, padding: '12px 16px', borderRadius: 10, fontSize: 13.5, lineHeight: 1.55,
            background: T.bg2, border: `1px solid ${T.border}`, borderLeft: `3px solid ${T.blue}`, color: T.text,
          }}>
            {fmtKpiValue(k)}
            {k.sub && <div style={{ fontSize: 10.5, color: T.text3, marginTop: 3 }}>{k.sub}</div>}
          </div>
        ))}

        {/* KPI cards */}
        {tiles.length > 0 && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 12, marginBottom: 20, opacity: refreshing ? 0.6 : 1, transition: 'opacity 0.15s' }}>
            {tiles.map(k => <KPI key={k.key} label={k.label} value={fmtKpiValue(k)} sub={k.sub} />)}
          </div>
        )}

        {/* Charts grid */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(430px, 1fr))', gap: 16, opacity: refreshing ? 0.6 : 1, transition: 'opacity 0.15s' }}>
          {charts.map(c => (
            <div key={c.key} style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 10, padding: '14px 16px', minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 10 }}>
                <div style={{ flex: 1, fontSize: 13.5, fontWeight: 600, color: T.text }}>{c.title}</div>
                <button onClick={() => setEditing(cfgFor(c))} style={miniBtn(T.text3 as string)}>Edit</button>
              </div>
              <ChartBody chart={c} />
            </div>
          ))}
          {charts.length === 0 && (
            <div style={{ gridColumn: '1 / -1', padding: 30, textAlign: 'center', fontSize: 12.5, color: T.text3, background: T.bg2, border: `1px dashed ${T.border2}`, borderRadius: 10 }}>
              No charts enabled — re-enable one below.
            </div>
          )}
        </div>

        {/* Hidden charts */}
        {hiddenCfgs.length > 0 && (
          <div style={{ marginTop: 18, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, color: T.text3 }}>Hidden charts:</span>
            {hiddenCfgs.map(c => (
              <Chip key={c.key} label={`${c.title} ✎`} active={false} onClick={() => setEditing(c)} />
            ))}
          </div>
        )}
      </div>

      {editing && (
        <EditDrawer
          cfg={editing}
          accounts={data.config.accounts}
          saving={saving}
          onSave={save}
          onClose={() => { if (!saving) setEditing(null) }}
        />
      )}
    </div>
  )
}
