// components/dashboard/WidgetRenderers.tsx
// One renderer per widget type. Each gets the resolver's `data` object plus
// the widget's config. Everything displayed on the dashboard.

import React from 'react'
import { METRICS } from '../../lib/dashboard/catalog'

const T = {
  bg:'#0d0f12', bg2:'#131519', bg3:'#1a1d23', bg4:'#21252d',
  border:'rgba(255,255,255,0.07)', border2:'rgba(255,255,255,0.12)',
  text:'#e8eaf0', text2:'#8b90a0', text3:'#545968',
  blue:'#4f8ef7', teal:'#2dd4bf', green:'#34c77b',
  amber:'#f5a623', red:'#f04e4e', purple:'#a78bfa', pink:'#ff5ac4',
  accent:'#4f8ef7',
}

const DONUT_COLORS = [T.blue, T.teal, T.amber, T.purple, T.green, T.pink, T.red, '#60a5fa', '#f472b6', '#a3e635']

function metricReturns(metricId: string): 'money'|'count'|'percentage' {
  return METRICS.find(m => m.id === metricId)?.returns || 'count'
}

function fmtMoney(n: number | null | undefined, compact = false): string {
  if (n === null || n === undefined || isNaN(n as any)) return '—'
  const v = Number(n)
  if (compact && Math.abs(v) >= 1_000_000) return '$' + (v / 1_000_000).toFixed(1) + 'M'
  if (compact && Math.abs(v) >= 10_000)    return '$' + (v / 1_000).toFixed(1) + 'k'
  return '$' + v.toLocaleString('en-AU', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
}
function fmtCount(n: number | null | undefined): string {
  if (n === null || n === undefined || isNaN(n as any)) return '—'
  return Number(n).toLocaleString('en-AU')
}
function fmtPct(n: number | null | undefined): string {
  if (n === null || n === undefined || isNaN(n as any)) return '—'
  return (Number(n) * 100).toFixed(1) + '%'
}
function fmtByKind(n: number | null | undefined, kind: 'money'|'count'|'percentage'): string {
  if (kind === 'money') return fmtMoney(n, true)
  if (kind === 'percentage') return fmtPct(n)
  return fmtCount(n)
}

function TrendDelta({ current, compare, kind }: { current: number, compare: number | null, kind: 'money'|'count'|'percentage' }) {
  if (compare === null || compare === undefined) return null
  const delta = current - compare
  if (compare === 0 && delta === 0) return <span style={{fontSize:11, color:T.text3}}>— no change</span>
  const pct = compare !== 0 ? delta / Math.abs(compare) : (delta > 0 ? 1 : -1)
  const isUp = delta >= 0
  const color = isUp ? T.green : T.red
  return (
    <div style={{display:'flex', alignItems:'baseline', gap:6}}>
      <span style={{color, fontSize:12, fontWeight:600}}>
        {isUp ? '▲' : '▼'} {Math.abs(pct * 100).toFixed(1)}%
      </span>
      <span style={{color:T.text3, fontSize:10}}>vs {fmtByKind(compare, kind)}</span>
    </div>
  )
}

// ── Individual renderers ──────────────────────────────────────────────────

export function KpiNumber({ config, data }: any) {
  const kind = metricReturns(config?.metric)
  return (
    <div style={{display:'flex', flexDirection:'column', justifyContent:'space-between', height:'100%'}}>
      <div style={{fontSize:10, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em', fontWeight:600}}>{config?.title || '—'}</div>
      <div>
        <div style={{fontSize:32, fontWeight:700, fontVariantNumeric:'tabular-nums', lineHeight:1, color:T.text}}>
          {fmtByKind(data?.value, kind)}
        </div>
        <div style={{marginTop:6}}>
          <TrendDelta current={Number(data?.value || 0)} compare={data?.compareValue ?? null} kind={kind}/>
        </div>
      </div>
    </div>
  )
}

export function KpiComparison({ config, data }: any) {
  const kind = metricReturns(config?.metric)
  return (
    <div style={{display:'flex', flexDirection:'column', height:'100%'}}>
      <div style={{fontSize:10, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em', fontWeight:600, marginBottom:12}}>{config?.title || '—'}</div>
      <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, flex:1, alignItems:'center'}}>
        <div>
          <div style={{fontSize:9, color:T.text3, textTransform:'uppercase', letterSpacing:'0.04em', marginBottom:3}}>{config?.periodA || 'A'}</div>
          <div style={{fontSize:24, fontWeight:700, fontVariantNumeric:'tabular-nums', color:T.text}}>{fmtByKind(data?.valueA, kind)}</div>
        </div>
        <div style={{borderLeft:`1px solid ${T.border}`, paddingLeft:12}}>
          <div style={{fontSize:9, color:T.text3, textTransform:'uppercase', letterSpacing:'0.04em', marginBottom:3}}>{config?.periodB || 'B'}</div>
          <div style={{fontSize:24, fontWeight:700, fontVariantNumeric:'tabular-nums', color:T.text2}}>{fmtByKind(data?.valueB, kind)}</div>
        </div>
      </div>
    </div>
  )
}

export function ProgressTarget({ config, data }: any) {
  const kind = metricReturns(config?.metric)
  const pct = Number(data?.pct || 0)
  return (
    <div style={{display:'flex', flexDirection:'column', height:'100%'}}>
      <div style={{fontSize:10, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em', fontWeight:600}}>{config?.title || '—'}</div>
      <div style={{marginTop:'auto'}}>
        <div style={{display:'flex', alignItems:'baseline', gap:8, marginBottom:6}}>
          <span style={{fontSize:22, fontWeight:700, fontVariantNumeric:'tabular-nums'}}>{fmtByKind(data?.value, kind)}</span>
          <span style={{fontSize:11, color:T.text3}}>/ {fmtByKind(data?.target, kind)}</span>
        </div>
        <div style={{height:8, background:T.bg3, borderRadius:4, overflow:'hidden', border:`1px solid ${T.border}`}}>
          <div style={{width: `${Math.min(100, pct * 100)}%`, height:'100%', background: pct >= 1 ? T.green : pct >= 0.75 ? T.teal : pct >= 0.5 ? T.amber : T.red}}/>
        </div>
        <div style={{fontSize:10, color:T.text3, marginTop:4}}>{(pct * 100).toFixed(1)}% of target</div>
      </div>
    </div>
  )
}

export function QuotesReceived({ config, data }: any) {
  const series: { label: string, value: number }[] = data?.series || []
  const max = Math.max(1, ...series.map(p => p.value))
  const todayN = Number(data?.todayCount || 0)
  const yestN = Number(data?.yesterdayCount || 0)
  const delta = todayN - yestN
  return (
    <div style={{display:'flex', flexDirection:'column', height:'100%'}}>
      <div style={{display:'flex', alignItems:'center', gap:12, marginBottom:10}}>
        <div style={{fontSize:10, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em', fontWeight:600}}>{config?.title || 'Quotes received'}</div>
      </div>
      <div style={{display:'flex', gap:20, marginBottom:12, flexWrap:'wrap'}}>
        <div>
          <div style={{fontSize:9, color:T.text3, textTransform:'uppercase', marginBottom:2}}>Today</div>
          <div style={{fontSize:28, fontWeight:700, fontVariantNumeric:'tabular-nums', color:T.text, lineHeight:1}}>{todayN}</div>
        </div>
        <div>
          <div style={{fontSize:9, color:T.text3, textTransform:'uppercase', marginBottom:2}}>Yesterday</div>
          <div style={{fontSize:22, fontWeight:600, fontVariantNumeric:'tabular-nums', color:T.text2, lineHeight:1}}>{yestN}</div>
        </div>
        <div>
          <div style={{fontSize:9, color:T.text3, textTransform:'uppercase', marginBottom:2}}>Δ</div>
          <div style={{fontSize:18, fontWeight:600, color: delta >= 0 ? T.green : T.red, lineHeight:1}}>{delta >= 0 ? '+' : ''}{delta}</div>
        </div>
      </div>
      {/* Sparkline */}
      <div style={{flex:1, minHeight:40, display:'flex', alignItems:'flex-end', gap:2}}>
        {series.map((p, i) => (
          <div key={i} style={{flex:1, background: i === series.length-1 ? T.teal : T.blue, opacity: 0.8, minHeight:1, height: `${(p.value / max) * 100}%`, borderRadius:2}} title={`${p.label}: ${p.value}`}/>
        ))}
      </div>
      <div style={{fontSize:9, color:T.text3, marginTop:4}}>Last {data?.days || series.length} days</div>
    </div>
  )
}

export function SalesScorecard({ config, data }: any) {
  const reps = data?.reps || []
  const maxRev = Math.max(1, ...reps.map((r: any) => Number(r.revenue || 0)))
  return (
    <div style={{display:'flex', flexDirection:'column', height:'100%'}}>
      <div style={{fontSize:10, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em', fontWeight:600, marginBottom:8}}>{config?.title || 'Sales scorecard'}</div>
      <div style={{flex:1, overflow:'auto'}}>
        {reps.length === 0 ? (
          <div style={{color:T.text3, fontSize:11, textAlign:'center', padding:20}}>No data</div>
        ) : (
          reps.map((r: any, i: number) => (
            <div key={i} style={{display:'grid', gridTemplateColumns:'20px 1fr auto auto', gap:8, padding:'5px 0', borderBottom:`1px solid ${T.border}`, alignItems:'center', fontSize:11}}>
              <div style={{color:T.text3}}>{i+1}</div>
              <div style={{color:T.text, fontWeight:500}}>{r.name || r.rep || '—'}</div>
              <div style={{color:T.text3, fontSize:10, whiteSpace:'nowrap'}}>{r.quotes_count || 0} quotes</div>
              <div style={{color:T.text, fontVariantNumeric:'tabular-nums', fontWeight:500, whiteSpace:'nowrap'}}>{fmtMoney(r.revenue, true)}</div>
              <div style={{gridColumn:'1 / -1', height:3, background:T.bg3, borderRadius:2, overflow:'hidden', marginTop:2}}>
                <div style={{height:'100%', width:`${(Number(r.revenue||0) / maxRev) * 100}%`, background:T.blue, opacity:0.7}}/>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

export function PipelineValue({ config, data }: any) {
  return (
    <div style={{display:'flex', flexDirection:'column', height:'100%', justifyContent:'space-between'}}>
      <div style={{fontSize:10, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em', fontWeight:600}}>{config?.title || 'Open pipeline'}</div>
      <div>
        <div style={{fontSize:32, fontWeight:700, fontVariantNumeric:'tabular-nums', color:T.text, lineHeight:1}}>{fmtMoney(data?.value, true)}</div>
        <div style={{fontSize:11, color:T.text3, marginTop:4}}>{fmtCount(data?.count)} open opportunities</div>
      </div>
    </div>
  )
}

export function LineChart({ config, data }: any) {
  const series: { label: string, value: number }[] = data?.series || []
  const kind = metricReturns(config?.metric)
  const max = Math.max(1, ...series.map(p => p.value))
  const min = Math.min(0, ...series.map(p => p.value))
  const range = max - min || 1
  const points = series.map((p, i) => {
    const x = series.length > 1 ? (i / (series.length - 1)) * 100 : 50
    const y = 100 - ((p.value - min) / range) * 100
    return { x, y, ...p }
  })
  const pathD = points.map((p, i) => (i === 0 ? 'M' : 'L') + p.x.toFixed(2) + ',' + p.y.toFixed(2)).join(' ')
  const areaD = pathD + ` L100,100 L0,100 Z`

  return (
    <div style={{display:'flex', flexDirection:'column', height:'100%'}}>
      <div style={{display:'flex', alignItems:'baseline', gap:10, marginBottom:8}}>
        <div style={{fontSize:10, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em', fontWeight:600}}>{config?.title || 'Chart'}</div>
        <div style={{fontSize:11, color:T.text, fontVariantNumeric:'tabular-nums', fontWeight:600, marginLeft:'auto'}}>
          Total: {fmtByKind(series.reduce((s,p) => s + p.value, 0), kind)}
        </div>
      </div>
      <div style={{flex:1, minHeight:80, position:'relative'}}>
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{width:'100%', height:'100%', display:'block'}}>
          <defs>
            <linearGradient id="lineGrad" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={T.blue} stopOpacity="0.35"/>
              <stop offset="100%" stopColor={T.blue} stopOpacity="0"/>
            </linearGradient>
          </defs>
          {series.length > 1 && <path d={areaD} fill="url(#lineGrad)"/>}
          {series.length > 1 && <path d={pathD} stroke={T.blue} strokeWidth="1.5" fill="none" vectorEffect="non-scaling-stroke"/>}
          {points.length <= 20 && points.map((p, i) => (
            <circle key={i} cx={p.x} cy={p.y} r="1.5" fill={T.blue} vectorEffect="non-scaling-stroke"/>
          ))}
        </svg>
      </div>
      <div style={{display:'flex', justifyContent:'space-between', fontSize:9, color:T.text3, marginTop:4}}>
        <span>{series[0]?.label || ''}</span>
        <span>{series[series.length - 1]?.label || ''}</span>
      </div>
    </div>
  )
}

export function BarChart({ config, data }: any) {
  const series: { label: string, value: number }[] = data?.series || []
  const kind = metricReturns(config?.metric)
  const max = Math.max(1, ...series.map(p => p.value))
  return (
    <div style={{display:'flex', flexDirection:'column', height:'100%'}}>
      <div style={{fontSize:10, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em', fontWeight:600, marginBottom:8}}>{config?.title || 'Chart'}</div>
      <div style={{flex:1, display:'flex', alignItems:'flex-end', gap:3, minHeight:60}}>
        {series.map((p, i) => (
          <div key={i} style={{flex:1, display:'flex', flexDirection:'column', alignItems:'center', gap:3}}>
            <div style={{width:'100%', height:`${(p.value / max) * 100}%`, background:T.blue, opacity:0.8, borderRadius:'3px 3px 0 0', minHeight:1}} title={`${p.label}: ${fmtByKind(p.value, kind)}`}/>
          </div>
        ))}
      </div>
      <div style={{display:'flex', justifyContent:'space-between', fontSize:9, color:T.text3, marginTop:4}}>
        <span>{series[0]?.label || ''}</span>
        <span>{series[series.length - 1]?.label || ''}</span>
      </div>
    </div>
  )
}

export function DonutChart({ config, data }: any) {
  const segments: { label: string, value: number }[] = data?.segments || []
  const total = segments.reduce((s, p) => s + p.value, 0) || 1
  let cumulative = 0
  const r = 42, cx = 50, cy = 50, strokeW = 14
  const circ = 2 * Math.PI * r
  return (
    <div style={{display:'flex', flexDirection:'column', height:'100%'}}>
      <div style={{fontSize:10, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em', fontWeight:600, marginBottom:8}}>{config?.title || 'Breakdown'}</div>
      <div style={{flex:1, display:'flex', gap:12, alignItems:'center'}}>
        <div style={{width:90, height:90, flexShrink:0}}>
          <svg viewBox="0 0 100 100">
            <circle cx={cx} cy={cy} r={r} stroke={T.bg3} strokeWidth={strokeW} fill="none"/>
            {segments.map((seg, i) => {
              const pct = seg.value / total
              const off = circ * cumulative
              const len = circ * pct
              cumulative += pct
              return (
                <circle key={i} cx={cx} cy={cy} r={r} stroke={DONUT_COLORS[i % DONUT_COLORS.length]} strokeWidth={strokeW} fill="none"
                  strokeDasharray={`${len} ${circ - len}`} strokeDashoffset={-off}
                  transform={`rotate(-90 ${cx} ${cy})`}/>
              )
            })}
          </svg>
        </div>
        <div style={{flex:1, overflow:'auto', maxHeight:160}}>
          {segments.length === 0 ? (
            <div style={{color:T.text3, fontSize:11}}>No data</div>
          ) : segments.map((seg, i) => (
            <div key={i} style={{display:'flex', alignItems:'center', gap:8, padding:'3px 0', fontSize:11}}>
              <div style={{width:8, height:8, borderRadius:2, background:DONUT_COLORS[i % DONUT_COLORS.length], flexShrink:0}}/>
              <div style={{color:T.text, flex:1, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis'}}>{seg.label}</div>
              <div style={{color:T.text2, fontVariantNumeric:'tabular-nums'}}>{seg.value}</div>
              <div style={{color:T.text3, fontSize:9, fontVariantNumeric:'tabular-nums', minWidth:36, textAlign:'right'}}>{((seg.value/total)*100).toFixed(0)}%</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

export function DistributorTotal({ config, data }: any) {
  return (
    <div style={{display:'flex', flexDirection:'column', height:'100%', justifyContent:'space-between'}}>
      <div>
        <div style={{fontSize:10, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em', fontWeight:600}}>{config?.title || data?.distributor || 'Distributor'}</div>
        {config?.title && data?.distributor && (
          <div style={{fontSize:10, color:T.text3, marginTop:2}}>{data.distributor}</div>
        )}
      </div>
      <div>
        <div style={{fontSize:28, fontWeight:700, fontVariantNumeric:'tabular-nums', color:T.text, lineHeight:1}}>{fmtMoney(data?.value, true)}</div>
        <div style={{marginTop:6}}>
          <TrendDelta current={Number(data?.value || 0)} compare={data?.compareValue ?? null} kind="money"/>
        </div>
      </div>
    </div>
  )
}

export function TopDistributors({ config, data }: any) {
  const items: { name: string, value: number }[] = data?.items || []
  const max = Math.max(1, ...items.map(i => i.value))
  return (
    <div style={{display:'flex', flexDirection:'column', height:'100%'}}>
      <div style={{fontSize:10, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em', fontWeight:600, marginBottom:8}}>{config?.title || 'Top distributors'}</div>
      <div style={{flex:1, overflow:'auto'}}>
        {items.length === 0 ? (
          <div style={{color:T.text3, fontSize:11, textAlign:'center', padding:20}}>No data</div>
        ) : items.map((item, i) => (
          <div key={i} style={{marginBottom:7}}>
            <div style={{display:'flex', justifyContent:'space-between', fontSize:11, marginBottom:2}}>
              <span style={{color:T.text}}><span style={{color:T.text3, marginRight:6}}>{i+1}.</span>{item.name}</span>
              <span style={{color:T.text, fontVariantNumeric:'tabular-nums', fontWeight:500}}>{fmtMoney(item.value, true)}</span>
            </div>
            <div style={{height:3, background:T.bg3, borderRadius:2, overflow:'hidden'}}>
              <div style={{height:'100%', width:`${(item.value/max)*100}%`, background:T.blue, opacity:0.7}}/>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export function JobStatusBreakdown({ config, data }: any) {
  if (!data?.hasReport) {
    return <div style={{color:T.amber, fontSize:11, textAlign:'center', padding:20}}>No job report uploaded — go to Job Reports → upload your Mechanics Desk export.</div>
  }
  const segments: { label: string, value: number }[] = data?.segments || []
  const total = segments.reduce((s, p) => s + p.value, 0) || 1
  return (
    <div style={{display:'flex', flexDirection:'column', height:'100%'}}>
      <div style={{fontSize:10, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em', fontWeight:600, marginBottom:8}}>{config?.title || 'Jobs'}</div>
      <div style={{flex:1, overflow:'auto'}}>
        {segments.map((s, i) => (
          <div key={i} style={{marginBottom:6}}>
            <div style={{display:'flex', justifyContent:'space-between', fontSize:11, marginBottom:2}}>
              <span style={{color:T.text}}>{s.label}</span>
              <span style={{color:T.text, fontVariantNumeric:'tabular-nums', fontWeight:500}}>{s.value}</span>
            </div>
            <div style={{height:4, background:T.bg3, borderRadius:2, overflow:'hidden'}}>
              <div style={{height:'100%', width:`${(s.value/total)*100}%`, background:DONUT_COLORS[i % DONUT_COLORS.length], opacity:0.85}}/>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export function SupplierInvoiceQueue({ config, data }: any) {
  const statuses: { key: string, label: string, color: string }[] = [
    { key: 'parsed',          label: 'Pending',       color: T.amber },
    { key: 'auto_approved',   label: 'Auto-approved', color: T.teal },
    { key: 'approved',        label: 'Approved',      color: T.green },
    { key: 'queued_myob',     label: 'Queued MYOB',   color: T.blue },
    { key: 'pushed_to_myob',  label: 'Pushed',        color: T.purple },
    { key: 'push_failed',     label: 'Failed',        color: T.red },
  ]
  return (
    <div style={{display:'flex', flexDirection:'column', height:'100%'}}>
      <div style={{fontSize:10, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em', fontWeight:600, marginBottom:10}}>{config?.title || 'Supplier invoices'}</div>
      <div style={{display:'grid', gridTemplateColumns:'repeat(3, 1fr)', gap:8, flex:1}}>
        {statuses.map(s => (
          <div key={s.key} style={{background:T.bg3, borderRadius:6, padding:'8px 10px', borderLeft:`2px solid ${s.color}`}}>
            <div style={{fontSize:9, color:T.text3, textTransform:'uppercase', letterSpacing:'0.04em'}}>{s.label}</div>
            <div style={{fontSize:18, fontWeight:700, fontVariantNumeric:'tabular-nums', color:T.text, lineHeight:1.2}}>{data?.[s.key] || 0}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

export function RecentActivity({ config, data }: any) {
  const events = data?.events || []
  return (
    <div style={{display:'flex', flexDirection:'column', height:'100%'}}>
      <div style={{fontSize:10, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em', fontWeight:600, marginBottom:8}}>{config?.title || 'Recent activity'}</div>
      <div style={{flex:1, overflow:'auto'}}>
        {events.length === 0 ? (
          <div style={{color:T.text3, fontSize:11, textAlign:'center', padding:20}}>No recent activity</div>
        ) : events.map((e: any, i: number) => (
          <a key={i} href={e.link || '#'} style={{display:'block', padding:'6px 0', borderBottom:`1px solid ${T.border}`, textDecoration:'none'}}>
            <div style={{display:'flex', justifyContent:'space-between', alignItems:'baseline', gap:8}}>
              <div style={{fontSize:11, color:T.text, flex:1, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis'}}>{e.title}</div>
              {e.value !== undefined && e.value !== null && <div style={{fontSize:11, color:T.text2, fontVariantNumeric:'tabular-nums', whiteSpace:'nowrap'}}>{fmtMoney(e.value, true)}</div>}
            </div>
            <div style={{fontSize:9, color:T.text3, marginTop:2}}>{new Date(e.time).toLocaleString('en-AU')}</div>
          </a>
        ))}
      </div>
    </div>
  )
}

export function Leaderboard({ config, data }: any) {
  const items = data?.items || []
  const kind: 'money'|'count' = data?.metricKind || 'count'
  const max = Math.max(1, ...items.map((i: any) => i.value))
  return (
    <div style={{display:'flex', flexDirection:'column', height:'100%'}}>
      <div style={{fontSize:10, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em', fontWeight:600, marginBottom:8}}>{config?.title || 'Leaderboard'}</div>
      <div style={{flex:1, overflow:'auto'}}>
        {items.length === 0 ? (
          <div style={{color:T.text3, fontSize:11, textAlign:'center', padding:20}}>No data</div>
        ) : items.map((x: any, i: number) => (
          <div key={i} style={{marginBottom:7}}>
            <div style={{display:'flex', justifyContent:'space-between', fontSize:11, marginBottom:2}}>
              <span style={{color:T.text}}><span style={{color:T.text3, marginRight:6}}>{i+1}.</span>{x.name}</span>
              <span style={{color:T.text, fontVariantNumeric:'tabular-nums', fontWeight:500}}>{kind === 'money' ? fmtMoney(x.value, true) : fmtCount(x.value)}</span>
            </div>
            <div style={{height:3, background:T.bg3, borderRadius:2, overflow:'hidden'}}>
              <div style={{height:'100%', width:`${(x.value/max)*100}%`, background:T.blue, opacity:0.7}}/>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export function MarkdownNote({ config, data }: any) {
  const content = String(data?.content || config?.content || '')
  // Very basic markdown: bold/italic/headers/linebreaks — no need for a full parser
  const html = content
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/^### (.+)$/gm, '<h4>$1</h4>')
    .replace(/^## (.+)$/gm, '<h3>$1</h3>')
    .replace(/^# (.+)$/gm, '<h2>$1</h2>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/\n/g, '<br/>')
  return (
    <div style={{display:'flex', flexDirection:'column', height:'100%', overflow:'auto'}}>
      {config?.title && <div style={{fontSize:10, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em', fontWeight:600, marginBottom:8}}>{config.title}</div>}
      <div style={{fontSize:12, color:T.text2, lineHeight:1.5}} dangerouslySetInnerHTML={{ __html: html }}/>
    </div>
  )
}

// Registry — dashboard uses this to pick the renderer for a widget type
export const RENDERERS: Record<string, React.ComponentType<any>> = {
  kpi_number:              KpiNumber,
  kpi_comparison:          KpiComparison,
  progress_target:         ProgressTarget,
  quotes_received:         QuotesReceived,
  sales_scorecard:         SalesScorecard,
  pipeline_value:          PipelineValue,
  line_chart:              LineChart,
  bar_chart:               BarChart,
  donut_chart:             DonutChart,
  distributor_total:       DistributorTotal,
  top_distributors:        TopDistributors,
  job_status_breakdown:    JobStatusBreakdown,
  supplier_invoice_queue:  SupplierInvoiceQueue,
  recent_activity:         RecentActivity,
  leaderboard:             Leaderboard,
  markdown_note:           MarkdownNote,
}
