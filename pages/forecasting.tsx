// pages/forecasting.tsx
// Forecast by month — reads the current Mechanics Desk Job Report
// (forecast lane only — wip_snapshot lane is excluded by the API).
//
// Renders:
//   • Top tile row: total forecast / months covered / jobs without Total / target
//   • Monthly SVG chart with proper $ Y-axis, gridlines, target line overlay,
//     and inline-editable target (admin only)
//   • Two side-by-side breakdown panels: Vehicle Platform + Job Type
//   • Drill-down table of jobs in the active month, cross-filterable
//
// Bar scale:
//   • If a target is set: Y-axis goes 0 → target (so bars show progress
//     toward goal, with target line at the top edge).
//   • If no target: Y-axis scales to the largest month with nice round
//     tick marks.

import { useState, useEffect, useMemo } from 'react'
import Head from 'next/head'
import Link from 'next/link'
import PortalSidebar from '../lib/PortalSidebar'
import { requirePageAuth } from '../lib/authServer'
import { UserRole } from '../lib/permissions'

const T = {
  bg:'#0d0f12', bg2:'#131519', bg3:'#1a1d23', bg4:'#21252d',
  border:'rgba(255,255,255,0.07)', border2:'rgba(255,255,255,0.12)',
  text:'#e8eaf0', text2:'#8b90a0', text3:'#545968',
  blue:'#4f8ef7', teal:'#2dd4bf', green:'#34c77b',
  amber:'#f5a623', red:'#f04e4e', purple:'#a78bfa',
  accent:'#4f8ef7',
}

export async function getServerSideProps(ctx: any) {
  return requirePageAuth(ctx, 'view:jobs')
}

interface Report {
  id: string; uploaded_at: string; filename: string | null;
  row_count: number; notes: string | null;
  source?: string | null; report_type?: string | null;
  warnings?: string[] | null;
}
interface ForecastJob {
  job_number: string; customer_name: string | null; vehicle: string | null;
  job_type: string | null; job_type_short: string | null;
  opened_date: string; estimated_total: number;
  vehicle_platform: string | null;
}
interface MonthBucket { key: string; label: string; total: number; job_count: number; jobs: ForecastJob[] }
interface BreakdownBucket { key: string; label: string; total: number; job_count: number }
interface Summary {
  hasReport: boolean
  report: Report | null
  forecast: {
    total: number
    job_count: number
    future_jobs_total: number
    jobs_without_total: number
    by_month:    MonthBucket[]
    by_platform: BreakdownBucket[]
    by_job_type: BreakdownBucket[]
    target_monthly: number
  }
}

function fmtMoney(n: number | null | undefined, compact = false): string {
  if (n === null || n === undefined || isNaN(n as any)) return '—'
  const v = Number(n)
  if (compact && Math.abs(v) >= 1_000_000) return '$' + (v / 1_000_000).toFixed(1) + 'M'
  if (compact && Math.abs(v) >= 10_000)    return '$' + (v / 1_000).toFixed(1) + 'k'
  if (compact && Math.abs(v) >= 1_000)     return '$' + (v / 1_000).toFixed(1) + 'k'
  return '$' + v.toLocaleString('en-AU', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
}
function fmtDate(d: string | null | undefined): string {
  if (!d) return '—'
  const parts = String(d).split('-')
  if (parts.length === 3) return `${parts[2]}/${parts[1]}/${parts[0].substring(2)}`
  return d
}

// "Nice" axis algorithm — picks a round-number tick interval that gives ~5
// gridlines and rounds the chart max up to a clean number.
function niceAxis(rawMax: number, targetTicks = 5): { max: number; step: number; ticks: number[] } {
  if (rawMax <= 0) return { max: 100, step: 25, ticks: [0, 25, 50, 75, 100] }
  const roughStep = rawMax / targetTicks
  const magnitude = Math.pow(10, Math.floor(Math.log10(roughStep)))
  const normalized = roughStep / magnitude
  let niceNormalized: number
  if (normalized < 1.5)      niceNormalized = 1
  else if (normalized < 3)   niceNormalized = 2
  else if (normalized < 7)   niceNormalized = 5
  else                       niceNormalized = 10
  const step = niceNormalized * magnitude
  const max = Math.ceil(rawMax / step) * step
  const ticks: number[] = []
  for (let v = 0; v <= max; v += step) ticks.push(v)
  return { max, step, ticks }
}

// Build axis with the target as the upper bound. Generates ~5 evenly-spaced
// tick marks from 0 to target. The target itself is always one of the ticks.
function targetAnchoredAxis(target: number, targetTicks = 5): { max: number; step: number; ticks: number[] } {
  if (target <= 0) return { max: 100, step: 25, ticks: [0, 25, 50, 75, 100] }
  const step = target / targetTicks
  const ticks: number[] = []
  for (let i = 0; i <= targetTicks; i++) ticks.push(step * i)
  return { max: target, step, ticks }
}

interface SessionUser {
  id: string; email: string; role: UserRole; name: string;
  visibleTabs?: string[] | null;
}

export default function ForecastingPage({ user }: { user: SessionUser }) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [data, setData] = useState<Summary | null>(null)
  const [activeMonth, setActiveMonth] = useState<string | null>(null)
  const [activePlatform, setActivePlatform] = useState<string>('all')
  const [activeJobType,  setActiveJobType]  = useState<string>('all')
  const [search, setSearch] = useState('')

  const isAdmin = user.role === 'admin'

  async function load() {
    setLoading(true); setError('')
    try {
      const r = await fetch('/api/jobs/summary')
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || 'Load failed')
      setData(d)
      if (d.forecast?.by_month?.length > 0 && !activeMonth) {
        setActiveMonth(d.forecast.by_month[0].key)
      }
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }

  useEffect(() => { load() /* eslint-disable-next-line */ }, [])

  const activeBucket = useMemo(() => {
    if (!data?.forecast?.by_month) return null
    return data.forecast.by_month.find(m => m.key === activeMonth) || null
  }, [data, activeMonth])

  const filteredJobs = useMemo(() => {
    if (!activeBucket) return []
    let rows = activeBucket.jobs
    if (activePlatform !== 'all') rows = rows.filter(j => (j.vehicle_platform || 'Other') === activePlatform)
    if (activeJobType !== 'all')  rows = rows.filter(j => (j.job_type_short || 'Other') === activeJobType)
    const q = search.trim().toLowerCase()
    if (q) {
      rows = rows.filter(j =>
        String(j.job_number || '').toLowerCase().includes(q) ||
        String(j.customer_name || '').toLowerCase().includes(q) ||
        String(j.vehicle || '').toLowerCase().includes(q) ||
        String(j.job_type || '').toLowerCase().includes(q) ||
        String(j.vehicle_platform || '').toLowerCase().includes(q)
      )
    }
    return rows
  }, [activeBucket, search, activePlatform, activeJobType])

  const targetMonthly = data?.forecast?.target_monthly || 0
  const months = data?.forecast?.by_month || []
  const maxMonthValue = useMemo(() => Math.max(1, ...months.map(m => m.total)), [months])

  // Axis strategy:
  //  - Target set → 0 → target (5 evenly-spaced ticks). Bars show progress
  //    toward the goal. Bigger months that exceed target will visually overflow
  //    (we cap at 100% bar height with a small "overflow" indicator).
  //  - No target → "nice" axis based on max month.
  const axis = useMemo(() => {
    if (targetMonthly > 0) return targetAnchoredAxis(targetMonthly)
    return niceAxis(maxMonthValue)
  }, [targetMonthly, maxMonthValue])

  function clearFilters() { setActivePlatform('all'); setActiveJobType('all'); setSearch('') }
  const hasFilters = activePlatform !== 'all' || activeJobType !== 'all' || search.trim().length > 0

  return (
    <>
      <Head><title>Forecasting — Just Autos</title></Head>
      <div style={{display:'flex', minHeight:'100vh', background:T.bg, color:T.text, fontFamily:'system-ui, -apple-system, sans-serif'}}>
        <PortalSidebar activeId="jobs" currentUserRole={user.role} currentUserVisibleTabs={user.visibleTabs}/>
        <main style={{flex:1, padding:'20px 32px 40px', overflow:'auto'}}>

          <div style={{display:'flex', alignItems:'center', gap:12, marginBottom:16, flexWrap:'wrap'}}>
            <h1 style={{margin:0, fontSize:22, fontWeight:600}}>Forecasting</h1>
            {data?.report && (
              <span style={{fontSize:11, color:T.text3}}>
                Report from <strong style={{color:T.text2}}>{fmtDate(data.report.uploaded_at.substring(0,10))}</strong>
                {data.report.filename && <> · {data.report.filename}</>}
                {data.report.source === 'api' && (
                  <span style={{marginLeft:8, padding:'2px 6px', borderRadius:3, background:'rgba(45,212,191,0.12)', color:T.teal, fontSize:10, fontWeight:600}}>
                    Auto-pulled
                  </span>
                )}
                {' · '}
                <Link href="/settings?tab=data-imports" style={{color:T.blue, textDecoration:'none'}}>upload manually →</Link>
              </span>
            )}
            {data?.report?.warnings && data.report.warnings.length > 0 && (
              <ReportWarnings warnings={data.report.warnings}/>
            )}
          </div>

          {error && <div style={{background:'rgba(240,78,78,0.1)', border:`1px solid ${T.red}40`, borderRadius:8, padding:'10px 14px', color:T.red, fontSize:13, marginBottom:12}}>{error}</div>}

          {loading ? (
            <div style={{padding:40, textAlign:'center', color:T.text3}}>Loading…</div>
          ) : !data?.hasReport ? (
            <div style={{background:T.bg2, border:`1px dashed ${T.border2}`, borderRadius:12, padding:60, textAlign:'center'}}>
              <div style={{fontSize:16, fontWeight:600, marginBottom:8}}>No job report yet</div>
              <div style={{fontSize:13, color:T.text3, marginBottom:20}}>
                The auto-pull cron runs every 2 hours during business hours.<br/>
                You can also upload a Mechanics Desk Job Report manually now.
              </div>
              <Link href="/settings?tab=data-imports" style={{display:'inline-block', padding:'10px 20px', borderRadius:6, background:T.accent, color:'#fff', fontSize:13, fontWeight:600, textDecoration:'none'}}>
                Go to Settings → Data Imports
              </Link>
            </div>
          ) : months.length === 0 ? (
            <div style={{background:T.bg2, border:`1px dashed ${T.border2}`, borderRadius:12, padding:60, textAlign:'center'}}>
              <div style={{fontSize:16, fontWeight:600, marginBottom:8}}>Nothing to forecast</div>
              <div style={{fontSize:13, color:T.text3}}>
                No jobs dated today or later with a Total $ value.
                {data.forecast.jobs_without_total > 0 && (
                  <> {data.forecast.jobs_without_total} future-dated job{data.forecast.jobs_without_total === 1 ? ' has' : 's have'} no Total set yet.</>
                )}
              </div>
            </div>
          ) : (
            <>
              {/* ── Top tiles ─────────────────────────────────────────────── */}
              <div style={{display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(200px, 1fr))', gap:12, marginBottom:20}}>
                <Tile label="Total forecast" value={fmtMoney(data.forecast.total, true)} subtext={`${data.forecast.job_count} jobs with a Total`} highlight={T.green}/>
                <Tile label="Months covered" value={String(months.length)} subtext={months.length > 0 ? `${months[0].label} — ${months[months.length-1].label}` : ''}/>
                <Tile
                  label="Jobs without a Total"
                  value={String(data.forecast.jobs_without_total)}
                  subtext={data.forecast.jobs_without_total > 0
                    ? `Future-dated bookings not yet priced`
                    : 'All future jobs are priced'}
                  highlight={data.forecast.jobs_without_total > 0 ? T.amber : undefined}
                />
                {targetMonthly > 0 && (
                  <Tile
                    label="Monthly target"
                    value={fmtMoney(targetMonthly, true)}
                    subtext={(() => {
                      const ahead = months.filter(m => m.total >= targetMonthly).length
                      return `${ahead} of ${months.length} month${months.length === 1 ? '' : 's'} on or above target`
                    })()}
                    highlight={T.purple}
                  />
                )}
              </div>

              {/* ── Monthly chart ─────────────────────────────────────────── */}
              <div style={{background:T.bg2, border:`1px solid ${T.border}`, borderRadius:10, padding:20, marginBottom:20}}>
                <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16, gap:12, flexWrap:'wrap'}}>
                  <div style={{fontSize:10, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em', fontWeight:600}}>
                    Forecast by month
                  </div>
                  <TargetEditor
                    initial={targetMonthly}
                    isAdmin={isAdmin}
                    onSaved={async () => { await load() }}
                  />
                </div>

                <ForecastChart
                  months={months}
                  activeMonth={activeMonth}
                  setActiveMonth={setActiveMonth}
                  axis={axis}
                  targetMonthly={targetMonthly}
                />
              </div>

              {/* ── Two side-by-side breakdown panels ─────────────────────── */}
              <div style={{display:'grid', gridTemplateColumns:'minmax(0, 1fr) minmax(0, 1fr)', gap:16, marginBottom:20}}>
                <BreakdownPanel
                  title="By vehicle platform"
                  rows={data.forecast.by_platform}
                  active={activePlatform}
                  total={data.forecast.total || 1}
                  onToggle={(k) => setActivePlatform(activePlatform === k ? 'all' : k)}
                  onClear={() => setActivePlatform('all')}
                />
                <BreakdownPanel
                  title="By job type"
                  rows={data.forecast.by_job_type}
                  active={activeJobType}
                  total={data.forecast.total || 1}
                  onToggle={(k) => setActiveJobType(activeJobType === k ? 'all' : k)}
                  onClear={() => setActiveJobType('all')}
                />
              </div>

              {/* ── Drill-down table ──────────────────────────────────────── */}
              {activeBucket && (
                <div>
                  <div style={{display:'flex', alignItems:'baseline', justifyContent:'space-between', gap:12, marginBottom:10, flexWrap:'wrap'}}>
                    <div>
                      <h2 style={{margin:0, fontSize:16, fontWeight:600}}>{activeBucket.label}</h2>
                      <div style={{fontSize:11, color:T.text3, marginTop:2}}>
                        {filteredJobs.length} of {activeBucket.job_count} jobs · {fmtMoney(filteredJobs.reduce((s, j) => s + (j.estimated_total || 0), 0))} shown
                      </div>
                    </div>
                    <div style={{display:'flex', gap:8, alignItems:'center'}}>
                      {hasFilters && (
                        <button onClick={clearFilters}
                          style={{padding:'5px 10px', background:'transparent', border:`1px solid ${T.border2}`, color:T.text3, borderRadius:4, fontSize:11, cursor:'pointer', fontFamily:'inherit'}}>
                          × clear filters
                        </button>
                      )}
                      <input placeholder="Search job, customer, vehicle, type…"
                        value={search} onChange={e => setSearch(e.target.value)}
                        style={{padding:'7px 12px', background:T.bg3, border:`1px solid ${T.border2}`, color:T.text, borderRadius:6, fontSize:12, fontFamily:'inherit', outline:'none', width:280, maxWidth:'100%'}}/>
                    </div>
                  </div>

                  <div style={{background:T.bg2, border:`1px solid ${T.border}`, borderRadius:10, overflow:'hidden'}}>
                    <div style={{display:'grid', gridTemplateColumns:'100px 90px 1fr 1fr 100px 130px 110px', gap:12, padding:'10px 14px', borderBottom:`1px solid ${T.border}`, background:T.bg3, fontSize:10, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em', fontWeight:600}}>
                      <div>Job #</div>
                      <div>Date</div>
                      <div>Customer</div>
                      <div>Vehicle</div>
                      <div>Platform</div>
                      <div>Type</div>
                      <div style={{textAlign:'right'}}>Value</div>
                    </div>
                    {filteredJobs.length === 0 ? (
                      <div style={{padding:30, textAlign:'center', color:T.text3, fontSize:12}}>
                        {hasFilters ? 'No jobs match these filters.' : 'No jobs.'}
                      </div>
                    ) : filteredJobs.map((j, i) => (
                      <div key={j.job_number + i}
                        style={{display:'grid', gridTemplateColumns:'100px 90px 1fr 1fr 100px 130px 110px', gap:12, padding:'9px 14px', borderBottom:`1px solid ${T.border}`, fontSize:12, alignItems:'center'}}>
                        <div style={{fontFamily:'monospace', color:T.text}}>{j.job_number}</div>
                        <div style={{color:T.text2, fontSize:11}}>{fmtDate(j.opened_date)}</div>
                        <div style={{color:T.text, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>{j.customer_name || '—'}</div>
                        <div style={{color:T.text2, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>{j.vehicle || '—'}</div>
                        <div style={{fontSize:11}}>
                          {j.vehicle_platform
                            ? <span style={{padding:'2px 6px', borderRadius:3, background:T.bg3, color:T.teal, fontSize:10, fontWeight:500}}>{j.vehicle_platform}</span>
                            : <span style={{color:T.text3}}>—</span>}
                        </div>
                        <div style={{color:T.text3, fontSize:11, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}} title={j.job_type || ''}>{j.job_type_short || '—'}</div>
                        <div style={{color:T.text, fontVariantNumeric:'tabular-nums', textAlign:'right', fontWeight:500}}>
                          {fmtMoney(j.estimated_total)}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </main>
      </div>
    </>
  )
}

// ── SVG-based forecast chart ─────────────────────────────────────────────

function ForecastChart({ months, activeMonth, setActiveMonth, axis, targetMonthly }: {
  months: MonthBucket[]
  activeMonth: string | null
  setActiveMonth: (k: string) => void
  axis: { max: number; step: number; ticks: number[] }
  targetMonthly: number
}) {
  // Layout in SVG user-space coordinates (viewBox handles responsive scaling)
  const W = 1000
  const H = 280
  const PAD_LEFT = 70
  const PAD_RIGHT = 20
  const PAD_TOP = 20
  const PAD_BOTTOM = 50

  const plotW = W - PAD_LEFT - PAD_RIGHT
  const plotH = H - PAD_TOP - PAD_BOTTOM
  const plotX0 = PAD_LEFT
  const plotY0 = PAD_TOP
  const plotX1 = PAD_LEFT + plotW
  const plotY1 = PAD_TOP + plotH

  const showTargetLine = targetMonthly > 0
  // When axis is target-anchored, the target is at the top edge of the plot
  // (same as axis.max). When axis is auto-scaled with no target, no line.
  const targetY = plotY1 - (Math.min(targetMonthly, axis.max) / axis.max) * plotH

  // Bar geometry
  const slotW = plotW / Math.max(1, months.length)
  const barW = Math.max(8, slotW * 0.7)

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      style={{ width: '100%', height: 'auto', display: 'block' }}
      preserveAspectRatio="xMidYMid meet">

      {/* ── Y-axis gridlines + labels ──────────────────────────────────── */}
      {axis.ticks.map((tick, i) => {
        const y = plotY1 - (tick / axis.max) * plotH
        return (
          <g key={`grid-${i}`}>
            <line
              x1={plotX0} x2={plotX1}
              y1={y} y2={y}
              stroke={T.border}
              strokeWidth={1}
              strokeDasharray={tick === 0 ? '0' : '2,3'}/>
            <text
              x={plotX0 - 8} y={y}
              fill={T.text3}
              fontSize={11}
              textAnchor="end"
              dominantBaseline="middle"
              fontFamily="system-ui, -apple-system, sans-serif">
              {fmtMoney(tick, true)}
            </text>
          </g>
        )
      })}

      {/* ── Bars ───────────────────────────────────────────────────────── */}
      {months.map((m, i) => {
        const slotCenter = plotX0 + (i + 0.5) * slotW
        const barX = slotCenter - barW / 2
        // Cap bar at chart top — if a month exceeds target/axis-max, show full
        // bar height plus a small "overflow" arrow on top
        const exceeds = m.total > axis.max
        const visualValue = Math.min(m.total, axis.max)
        const barH = (visualValue / axis.max) * plotH
        const barY = plotY1 - barH
        const isActive = m.key === activeMonth
        const aboveTarget = showTargetLine && m.total >= targetMonthly
        const fill = isActive ? T.blue : (aboveTarget ? T.green : T.teal)
        return (
          <g key={m.key}
            onClick={() => setActiveMonth(m.key)}
            style={{ cursor: 'pointer' }}>
            {/* Hit area covers the whole slot */}
            <rect
              x={plotX0 + i * slotW}
              y={plotY0}
              width={slotW}
              height={plotH + PAD_BOTTOM}
              fill="transparent"/>
            {/* Bar */}
            <rect
              x={barX} y={barY}
              width={barW}
              height={Math.max(2, barH)}
              fill={fill}
              opacity={isActive ? 1 : 0.85}
              rx={3}/>
            {/* Overflow indicator if month exceeds target */}
            {exceeds && (
              <text
                x={slotCenter}
                y={barY - 22}
                fill={T.green}
                fontSize={10}
                fontWeight={700}
                textAnchor="middle"
                fontFamily="system-ui, -apple-system, sans-serif">
                ▲
              </text>
            )}
            {/* Value label above bar */}
            <text
              x={slotCenter}
              y={barY - 6}
              fill={isActive ? T.text : T.text2}
              fontSize={11}
              fontWeight={isActive ? 600 : 400}
              textAnchor="middle"
              fontFamily="system-ui, -apple-system, sans-serif">
              {fmtMoney(m.total, true)}
            </text>
            {/* Month label */}
            <text
              x={slotCenter}
              y={plotY1 + 18}
              fill={isActive ? T.text : T.text3}
              fontSize={11}
              fontWeight={isActive ? 600 : 400}
              textAnchor="middle"
              fontFamily="system-ui, -apple-system, sans-serif">
              {m.label}
            </text>
            <text
              x={slotCenter}
              y={plotY1 + 33}
              fill={T.text3}
              fontSize={10}
              textAnchor="middle"
              fontFamily="system-ui, -apple-system, sans-serif">
              {m.job_count} job{m.job_count === 1 ? '' : 's'}
            </text>
          </g>
        )
      })}

      {/* ── Target line ────────────────────────────────────────────────── */}
      {showTargetLine && (
        <g>
          <line
            x1={plotX0} x2={plotX1}
            y1={targetY} y2={targetY}
            stroke={T.purple}
            strokeWidth={1.5}
            strokeDasharray="6,4"/>
          <text
            x={plotX1 - 4}
            y={targetY - 4}
            fill={T.purple}
            fontSize={10}
            fontWeight={600}
            textAnchor="end"
            fontFamily="system-ui, -apple-system, sans-serif">
            Target {fmtMoney(targetMonthly, true)}
          </text>
        </g>
      )}
    </svg>
  )
}

// ── Inline target editor ─────────────────────────────────────────────────

function TargetEditor({ initial, isAdmin, onSaved }: {
  initial: number
  isAdmin: boolean
  onSaved: () => Promise<void> | void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(String(initial || 0))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!editing) setDraft(String(initial || 0))
  }, [initial, editing])

  const hasTarget = initial > 0

  if (!isAdmin) {
    if (!hasTarget) return null
    return (
      <div style={{fontSize:10, color:T.text3, display:'flex', alignItems:'center', gap:6}}>
        <span style={{display:'inline-block', width:14, height:0, borderTop:`2px dashed ${T.purple}`}}/>
        Target {fmtMoney(initial, true)}/mo
      </div>
    )
  }

  if (!editing) {
    return (
      <button
        onClick={() => { setEditing(true); setError(null) }}
        title={hasTarget ? 'Click to edit monthly target' : 'Click to set a monthly target'}
        style={{
          fontSize:10, color: hasTarget ? T.text2 : T.text3,
          display:'flex', alignItems:'center', gap:6,
          background:'transparent', border:`1px dashed ${T.border2}`,
          padding:'4px 10px', borderRadius:4, cursor:'pointer', fontFamily:'inherit',
        }}>
        <span style={{display:'inline-block', width:14, height:0, borderTop:`2px dashed ${T.purple}`}}/>
        {hasTarget ? `Target ${fmtMoney(initial, true)}/mo` : 'Set target'}
        <span style={{color:T.text3, fontSize:9, marginLeft:2}}>· edit</span>
      </button>
    )
  }

  async function save() {
    const num = Number(draft.replace(/[$,\s]/g, ''))
    if (!isFinite(num) || num < 0) {
      setError('Must be a non-negative number')
      return
    }
    setSaving(true); setError(null)
    try {
      const r = await fetch('/api/admin/forecasting-target', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_monthly: Math.round(num) }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || 'Save failed')
      setEditing(false)
      await onSaved()
    } catch (e: any) {
      setError(e.message || 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  function cancel() {
    setEditing(false)
    setDraft(String(initial || 0))
    setError(null)
  }

  return (
    <div style={{display:'flex', alignItems:'center', gap:6}}>
      <span style={{fontSize:10, color:T.text3}}>Target $</span>
      <input
        autoFocus
        type="text"
        inputMode="numeric"
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !saving) save()
          else if (e.key === 'Escape') cancel()
        }}
        disabled={saving}
        placeholder="0"
        style={{
          width: 100, padding:'4px 8px',
          background:T.bg3, border:`1px solid ${T.border2}`,
          color:T.text, borderRadius:4, fontSize:11,
          fontFamily:'inherit', outline:'none',
          fontVariantNumeric:'tabular-nums',
        }}/>
      <span style={{fontSize:10, color:T.text3}}>/mo</span>
      <button onClick={save} disabled={saving}
        style={{padding:'4px 10px', borderRadius:4, border:'none', background: saving ? T.bg4 : T.blue, color:'#fff', fontSize:11, fontWeight:600, cursor: saving ? 'default' : 'pointer', fontFamily:'inherit'}}>
        {saving ? '…' : 'Save'}
      </button>
      <button onClick={cancel} disabled={saving}
        style={{padding:'4px 8px', borderRadius:4, border:`1px solid ${T.border2}`, background:'transparent', color:T.text3, fontSize:11, cursor:'pointer', fontFamily:'inherit'}}>
        Cancel
      </button>
      {error && <span style={{fontSize:10, color:T.red, marginLeft:4}}>{error}</span>}
    </div>
  )
}

function ReportWarnings({ warnings }: { warnings: string[] }) {
  const [open, setOpen] = useState(false)
  const n = warnings.length
  return (
    <span style={{position:'relative', display:'inline-block'}}>
      <button
        onClick={() => setOpen(o => !o)}
        title={open ? 'Hide warnings' : 'Show parser warnings'}
        style={{
          padding:'2px 8px', borderRadius:3,
          background:'rgba(245,166,35,0.12)', color:T.amber,
          border:`1px solid ${T.amber}40`,
          fontSize:10, fontWeight:600, cursor:'pointer',
          fontFamily:'inherit',
          display:'inline-flex', alignItems:'center', gap:4,
        }}>
        ⚠ {n} warning{n === 1 ? '' : 's'}
        <span style={{fontSize:9, opacity:0.7}}>{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <div style={{
          position:'absolute', top:'calc(100% + 6px)', left:0, zIndex:10,
          minWidth:320, maxWidth:520,
          background:T.bg2, border:`1px solid ${T.border2}`, borderRadius:8,
          padding:12, boxShadow:'0 8px 24px rgba(0,0,0,0.4)',
        }}>
          <div style={{fontSize:10, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em', fontWeight:600, marginBottom:8}}>
            Parser warnings on current report
          </div>
          <ul style={{margin:0, padding:'0 0 0 16px', color:T.text2, fontSize:12, lineHeight:1.5}}>
            {warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </div>
      )}
    </span>
  )
}

function Tile({ label, value, subtext, highlight }: { label: string; value: string; subtext?: string; highlight?: string }) {
  return (
    <div style={{background:T.bg2, border:`1px solid ${T.border}`, borderLeft: highlight ? `3px solid ${highlight}` : `1px solid ${T.border}`, borderRadius:10, padding:'14px 16px'}}>
      <div style={{fontSize:10, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em', fontWeight:600}}>{label}</div>
      <div style={{fontSize:24, fontWeight:700, color:T.text, fontVariantNumeric:'tabular-nums', marginTop:4, lineHeight:1.1}}>{value}</div>
      {subtext && <div style={{fontSize:10, color:T.text3, marginTop:4}}>{subtext}</div>}
    </div>
  )
}

function BreakdownPanel({ title, rows, active, total, onToggle, onClear }: {
  title: string
  rows: BreakdownBucket[]
  active: string
  total: number
  onToggle: (key: string) => void
  onClear: () => void
}) {
  const isFiltering = active !== 'all'
  return (
    <div style={{background:T.bg2, border:`1px solid ${T.border}`, borderRadius:10, padding:20}}>
      <div style={{fontSize:10, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em', fontWeight:600, marginBottom:16}}>
        {title}
      </div>
      {rows.length === 0 ? (
        <div style={{fontSize:11, color:T.text3}}>No data.</div>
      ) : (
        <div style={{display:'flex', flexDirection:'column', gap:8, maxHeight:280, overflowY:'auto'}}>
          {rows.map((p) => {
            const pct = (p.total / total) * 100
            const isActive = active === p.key
            return (
              <div key={p.key} onClick={() => onToggle(p.key)} style={{cursor:'pointer'}}>
                <div style={{display:'flex', justifyContent:'space-between', fontSize:12, marginBottom:3}}>
                  <span style={{color: isActive ? T.blue : T.text, fontWeight: isActive ? 600 : 400, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', maxWidth:'70%'}} title={p.label}>{p.label}</span>
                  <span style={{color:T.text2, fontVariantNumeric:'tabular-nums'}}>
                    {fmtMoney(p.total, true)} <span style={{color:T.text3, fontSize:10}}>({p.job_count})</span>
                  </span>
                </div>
                <div style={{height:6, background:T.bg3, borderRadius:3, overflow:'hidden'}}>
                  <div style={{
                    height:'100%',
                    width:`${pct}%`,
                    background: isActive ? T.blue : T.teal,
                    opacity: !isFiltering || isActive ? 1 : 0.35,
                    transition:'opacity 0.15s',
                  }}/>
                </div>
              </div>
            )
          })}
          {isFiltering && (
            <button onClick={onClear} style={{marginTop:4, padding:'4px 0', border:'none', background:'transparent', color:T.text3, fontSize:10, textAlign:'left', cursor:'pointer', fontFamily:'inherit'}}>
              × clear filter
            </button>
          )}
        </div>
      )}
    </div>
  )
}
