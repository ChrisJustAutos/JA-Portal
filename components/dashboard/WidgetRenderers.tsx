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

// ── New widgets (calls / todos / inventory / vehicles / reports) ──────────

// Format seconds as "Hh Mm" or "Mm Ss" depending on size
function fmtTalkTime(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || isNaN(seconds as any)) return '—'
  const s = Math.round(Number(seconds))
  if (s < 60) return s + 's'
  const m = Math.floor(s / 60)
  const rs = s % 60
  if (m < 60) return m + 'm' + (rs ? ' ' + rs + 's' : '')
  const h = Math.floor(m / 60)
  const rm = m % 60
  return h + 'h' + (rm ? ' ' + rm + 'm' : '')
}

function fmtRelTime(iso: string): string {
  if (!iso) return ''
  const t = new Date(iso).getTime()
  const diff = Date.now() - t
  const m = Math.round(diff / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return m + 'm ago'
  const h = Math.round(m / 60)
  if (h < 24) return h + 'h ago'
  const d = Math.round(h / 24)
  if (d < 7) return d + 'd ago'
  return new Date(iso).toLocaleDateString('en-AU', { day: '2-digit', month: 'short' })
}

export function CallsKpi({ config, data }: any) {
  const total    = Number(data?.total || 0)
  const answered = Number(data?.answered || 0)
  const missed   = Number(data?.missed_inbound || 0)
  const talk     = Number(data?.talk_seconds || 0)
  const tiles = [
    { label: 'Total',    value: fmtCount(total),         color: T.text  },
    { label: 'Answered', value: fmtCount(answered),      color: T.green },
    { label: 'Missed',   value: fmtCount(missed),        color: missed > 0 ? T.red : T.text3 },
    { label: 'Talk',     value: fmtTalkTime(talk),       color: T.blue  },
  ]
  return (
    <div style={{display:'flex', flexDirection:'column', height:'100%'}}>
      <div style={{display:'flex', alignItems:'baseline', gap:8, marginBottom:10}}>
        <div style={{fontSize:10, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em', fontWeight:600}}>{config?.title || 'Calls'}</div>
        {config?.extension && <div style={{fontSize:9, color:T.text3, fontFamily:'monospace'}}>ext {config.extension}</div>}
      </div>
      <div style={{display:'grid', gridTemplateColumns:'repeat(4, 1fr)', gap:8, flex:1}}>
        {tiles.map(t => (
          <div key={t.label} style={{background:T.bg3, borderRadius:6, padding:'8px 10px'}}>
            <div style={{fontSize:9, color:T.text3, textTransform:'uppercase', letterSpacing:'0.04em'}}>{t.label}</div>
            <div style={{fontSize:18, fontWeight:700, fontVariantNumeric:'tabular-nums', color:t.color, lineHeight:1.2}}>{t.value}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

export function CallsAgentLeaderboard({ config, data }: any) {
  const items: { name: string, extension: string, talk_seconds: number, total: number }[] = data?.agents || []
  const max = Math.max(1, ...items.map(i => i.talk_seconds))
  return (
    <div style={{display:'flex', flexDirection:'column', height:'100%'}}>
      <div style={{fontSize:10, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em', fontWeight:600, marginBottom:8}}>{config?.title || 'Top agents'}</div>
      <div style={{flex:1, overflow:'auto'}}>
        {items.length === 0 ? (
          <div style={{color:T.text3, fontSize:11, textAlign:'center', padding:20}}>No call data for this period</div>
        ) : items.map((a, i) => (
          <div key={i} style={{marginBottom:7}}>
            <div style={{display:'flex', justifyContent:'space-between', fontSize:11, marginBottom:2}}>
              <span style={{color:T.text}}>
                <span style={{color:T.text3, marginRight:6}}>{i+1}.</span>{a.name}
                <span style={{color:T.text3, marginLeft:6, fontFamily:'monospace', fontSize:10}}>ext {a.extension}</span>
              </span>
              <span style={{color:T.text, fontVariantNumeric:'tabular-nums', fontWeight:500}}>
                {fmtTalkTime(a.talk_seconds)}
                <span style={{color:T.text3, marginLeft:6, fontSize:10}}>{a.total} calls</span>
              </span>
            </div>
            <div style={{height:3, background:T.bg3, borderRadius:2, overflow:'hidden'}}>
              <div style={{height:'100%', width:`${(a.talk_seconds/max)*100}%`, background:T.blue, opacity:0.7}}/>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export function CallsMissedRecent({ config, data }: any) {
  const items: { id: string, call_date: string, external_number: string, caller_name: string | null, agent_ext: string | null }[] = data?.calls || []
  return (
    <div style={{display:'flex', flexDirection:'column', height:'100%'}}>
      <div style={{fontSize:10, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em', fontWeight:600, marginBottom:8}}>{config?.title || 'Missed calls'}</div>
      <div style={{flex:1, overflow:'auto'}}>
        {items.length === 0 ? (
          <div style={{color:T.text3, fontSize:11, textAlign:'center', padding:20}}>No missed calls</div>
        ) : items.map((c, i) => (
          <a key={c.id || i} href={`/calls?id=${c.id}`} style={{display:'block', padding:'6px 0', borderBottom:`1px solid ${T.border}`, textDecoration:'none'}}>
            <div style={{display:'flex', justifyContent:'space-between', alignItems:'baseline', gap:8}}>
              <div style={{fontSize:11, color:T.text, flex:1, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis'}}>
                <span style={{color:T.red, marginRight:6}}>●</span>
                {c.caller_name || c.external_number || 'Unknown'}
              </div>
              <div style={{fontSize:10, color:T.text3, whiteSpace:'nowrap'}}>{fmtRelTime(c.call_date)}</div>
            </div>
            {(c.agent_ext || c.external_number) && (
              <div style={{fontSize:9, color:T.text3, marginTop:2, fontFamily:'monospace'}}>
                {c.external_number}{c.agent_ext ? ` → ext ${c.agent_ext}` : ''}
              </div>
            )}
          </a>
        ))}
      </div>
    </div>
  )
}

export function TodosKpi({ config, data }: any) {
  const tiles = [
    { label: 'Open',      value: fmtCount(data?.openTotal),       color: T.text  },
    { label: 'Critical',  value: fmtCount(data?.critical),        color: Number(data?.critical || 0) > 0 ? T.red : T.text3 },
    { label: 'Completed', value: fmtCount(data?.completedInPeriod), color: T.green },
  ]
  return (
    <div style={{display:'flex', flexDirection:'column', height:'100%'}}>
      <div style={{display:'flex', alignItems:'baseline', gap:8, marginBottom:10}}>
        <div style={{fontSize:10, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em', fontWeight:600}}>{config?.title || 'To-Dos'}</div>
        {config?.manager && <div style={{fontSize:9, color:T.text3}}>{config.manager}</div>}
      </div>
      <div style={{display:'grid', gridTemplateColumns:'repeat(3, 1fr)', gap:8, flex:1}}>
        {tiles.map(t => (
          <div key={t.label} style={{background:T.bg3, borderRadius:6, padding:'8px 10px'}}>
            <div style={{fontSize:9, color:T.text3, textTransform:'uppercase', letterSpacing:'0.04em'}}>{t.label}</div>
            <div style={{fontSize:22, fontWeight:700, fontVariantNumeric:'tabular-nums', color:t.color, lineHeight:1.2}}>{t.value}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

export function TodosManagerScorecard({ config, data }: any) {
  const items: { manager: string, openTotal: number, critical: number, completedInPeriod: number, avgAgeDays: number | null }[] = data?.managers || []
  const max = Math.max(1, ...items.map(m => m.openTotal))
  return (
    <div style={{display:'flex', flexDirection:'column', height:'100%'}}>
      <div style={{fontSize:10, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em', fontWeight:600, marginBottom:8}}>{config?.title || 'Manager scorecard'}</div>
      <div style={{flex:1, overflow:'auto'}}>
        {items.length === 0 ? (
          <div style={{color:T.text3, fontSize:11, textAlign:'center', padding:20}}>No manager data</div>
        ) : items.map((m, i) => (
          <div key={i} style={{marginBottom:8, padding:'6px 0', borderBottom:`1px solid ${T.border}`}}>
            <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', fontSize:11, marginBottom:3}}>
              <span style={{color:T.text, fontWeight:500}}>{m.manager}</span>
              <span style={{display:'flex', alignItems:'center', gap:8}}>
                {m.critical > 0 && <span style={{fontSize:9, padding:'1px 6px', borderRadius:3, background:`${T.red}20`, color:T.red, border:`1px solid ${T.red}40`, fontFamily:'monospace'}}>{m.critical} critical</span>}
                <span style={{color:T.text, fontVariantNumeric:'tabular-nums', fontWeight:600}}>{m.openTotal}</span>
                <span style={{color:T.text3, fontSize:9}}>open</span>
              </span>
            </div>
            <div style={{height:3, background:T.bg3, borderRadius:2, overflow:'hidden', marginBottom:3}}>
              <div style={{height:'100%', width:`${(m.openTotal/max)*100}%`, background:m.critical > 0 ? T.amber : T.green, opacity:0.7}}/>
            </div>
            <div style={{display:'flex', justifyContent:'space-between', fontSize:9, color:T.text3, fontFamily:'monospace'}}>
              <span>{m.completedInPeriod} done in period</span>
              {m.avgAgeDays !== null && <span>avg age {Math.round(m.avgAgeDays)}d</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export function StockHealthKpi({ config, data }: any) {
  const tiles = [
    { label: 'Stock value', value: fmtMoney(data?.stockValue, true), color: T.blue,  hint: `${fmtCount(data?.totalSkus)} SKUs` },
    { label: 'Low stock',   value: fmtCount(data?.lowStockCount),     color: Number(data?.lowStockCount || 0) > 0 ? T.amber : T.text3, hint: 'below reorder' },
    { label: 'Out',         value: fmtCount(data?.outOfStockCount),   color: Number(data?.outOfStockCount || 0) > 0 ? T.red   : T.text3, hint: 'zero on hand' },
    { label: 'Dead 180d',   value: fmtMoney(data?.deadStock180dValue, true), color: Number(data?.deadStock180dValue || 0) > 0 ? T.red : T.text3, hint: `${fmtCount(data?.deadStock180dCount)} items` },
  ]
  return (
    <div style={{display:'flex', flexDirection:'column', height:'100%'}}>
      <div style={{fontSize:10, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em', fontWeight:600, marginBottom:10}}>{config?.title || 'Stock health'}</div>
      <div style={{display:'grid', gridTemplateColumns:'repeat(4, 1fr)', gap:8, flex:1}}>
        {tiles.map(t => (
          <div key={t.label} style={{background:T.bg3, borderRadius:6, padding:'8px 10px'}}>
            <div style={{fontSize:9, color:T.text3, textTransform:'uppercase', letterSpacing:'0.04em'}}>{t.label}</div>
            <div style={{fontSize:16, fontWeight:700, fontVariantNumeric:'tabular-nums', color:t.color, lineHeight:1.2, marginTop:2}}>{t.value}</div>
            <div style={{fontSize:9, color:T.text3, marginTop:2}}>{t.hint}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

export function StockCriticalReorder({ config, data }: any) {
  const items: { sku: string, name: string, qtyOnHand: number, qtyOnOrder: number, daysOfCover: number | null, supplier: string | null }[] = data?.items || []
  return (
    <div style={{display:'flex', flexDirection:'column', height:'100%'}}>
      <div style={{display:'flex', alignItems:'baseline', justifyContent:'space-between', marginBottom:8}}>
        <div style={{fontSize:10, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em', fontWeight:600}}>{config?.title || 'Critical reorder'}</div>
        <div style={{fontSize:9, color:T.text3, fontFamily:'monospace'}}>within {config?.days || 30}d</div>
      </div>
      <div style={{flex:1, overflow:'auto'}}>
        {items.length === 0 ? (
          <div style={{color:T.green, fontSize:11, textAlign:'center', padding:20}}>Nothing critical</div>
        ) : (
          <table style={{width:'100%', borderCollapse:'collapse'}}>
            <thead>
              <tr style={{borderBottom:`1px solid ${T.border}`}}>
                <th style={{textAlign:'left',  fontSize:9, color:T.text3, padding:'4px 6px', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.04em'}}>SKU</th>
                <th style={{textAlign:'left',  fontSize:9, color:T.text3, padding:'4px 6px', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.04em'}}>Name</th>
                <th style={{textAlign:'right', fontSize:9, color:T.text3, padding:'4px 6px', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.04em'}}>OH</th>
                <th style={{textAlign:'right', fontSize:9, color:T.text3, padding:'4px 6px', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.04em'}}>OO</th>
                <th style={{textAlign:'right', fontSize:9, color:T.text3, padding:'4px 6px', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.04em'}}>Cover</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it, i) => {
                const dc = it.daysOfCover
                const dcColor = dc === null ? T.text3 : dc < 7 ? T.red : dc < 14 ? T.amber : T.text2
                return (
                  <tr key={i} style={{borderBottom:`1px solid ${T.border}`}}>
                    <td style={{fontSize:10, padding:'4px 6px', color:T.text2, fontFamily:'monospace'}}>{it.sku}</td>
                    <td style={{fontSize:10, padding:'4px 6px', color:T.text, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis', maxWidth:200}}>{it.name}</td>
                    <td style={{fontSize:10, padding:'4px 6px', color:T.text, fontVariantNumeric:'tabular-nums', textAlign:'right'}}>{it.qtyOnHand}</td>
                    <td style={{fontSize:10, padding:'4px 6px', color:T.text2, fontVariantNumeric:'tabular-nums', textAlign:'right'}}>{it.qtyOnOrder || ''}</td>
                    <td style={{fontSize:10, padding:'4px 6px', color:dcColor, fontVariantNumeric:'tabular-nums', textAlign:'right', fontWeight:500}}>{dc === null ? '—' : Math.round(dc) + 'd'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

export function StockDeadTop({ config, data }: any) {
  const items: { sku: string, name: string, stockValue: number, qtyOnHand: number, daysSinceLastSold: number | null }[] = data?.items || []
  const max = Math.max(1, ...items.map(i => i.stockValue))
  return (
    <div style={{display:'flex', flexDirection:'column', height:'100%'}}>
      <div style={{display:'flex', alignItems:'baseline', justifyContent:'space-between', marginBottom:8}}>
        <div style={{fontSize:10, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em', fontWeight:600}}>{config?.title || 'Dead stock'}</div>
        <div style={{fontSize:9, color:T.text3}}>180d+ no sales</div>
      </div>
      <div style={{flex:1, overflow:'auto'}}>
        {items.length === 0 ? (
          <div style={{color:T.green, fontSize:11, textAlign:'center', padding:20}}>No dead stock</div>
        ) : items.map((it, i) => (
          <div key={i} style={{marginBottom:7}}>
            <div style={{display:'flex', justifyContent:'space-between', fontSize:11, marginBottom:2}}>
              <span style={{color:T.text, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis', maxWidth:'70%'}}>
                <span style={{color:T.text3, marginRight:6, fontFamily:'monospace', fontSize:10}}>{it.sku}</span>
                {it.name}
              </span>
              <span style={{color:T.red, fontVariantNumeric:'tabular-nums', fontWeight:500}}>{fmtMoney(it.stockValue, true)}</span>
            </div>
            <div style={{height:3, background:T.bg3, borderRadius:2, overflow:'hidden', marginBottom:2}}>
              <div style={{height:'100%', width:`${(it.stockValue/max)*100}%`, background:T.red, opacity:0.6}}/>
            </div>
            <div style={{fontSize:9, color:T.text3, fontFamily:'monospace'}}>
              {it.qtyOnHand} on hand{it.daysSinceLastSold ? ` · last sold ${it.daysSinceLastSold}d ago` : ' · never sold'}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export function TopActiveLeads({ config, data }: any) {
  const items: { name: string, rep: string, value: number, status: string, url: string | null }[] = data?.leads || []
  const STATUS_COLOURS: Record<string, string> = {
    'Quote Sent': T.blue, '3 Days': T.blue, '14 Days': T.amber,
    'Follow Up Done': T.pink, 'On Hold': T.amber, 'Quote On Hold': T.amber,
    'Not Done': T.text3, 'Quote Not Issued': '#ff6d3b', 'RLMNA': '#007eb5',
  }
  return (
    <div style={{display:'flex', flexDirection:'column', height:'100%'}}>
      <div style={{fontSize:10, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em', fontWeight:600, marginBottom:8}}>{config?.title || 'Top active leads'}</div>
      <div style={{flex:1, overflow:'auto'}}>
        {items.length === 0 ? (
          <div style={{color:T.text3, fontSize:11, textAlign:'center', padding:20}}>No open quotes in this period</div>
        ) : items.map((l, i) => {
          const Tag = (
            <span style={{fontSize:9, padding:'1px 6px', borderRadius:3, background:`${STATUS_COLOURS[l.status] || T.text3}20`, color:STATUS_COLOURS[l.status] || T.text3, border:`1px solid ${STATUS_COLOURS[l.status] || T.text3}40`, fontFamily:'monospace', whiteSpace:'nowrap'}}>{l.status}</span>
          )
          const Row = (
            <div style={{padding:'6px 0', borderBottom:`1px solid ${T.border}`}}>
              <div style={{display:'flex', justifyContent:'space-between', alignItems:'baseline', gap:8, marginBottom:2}}>
                <div style={{fontSize:11, color:T.text, flex:1, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis'}}>{l.name}</div>
                <div style={{fontSize:11, color:T.text, fontVariantNumeric:'tabular-nums', fontWeight:500, whiteSpace:'nowrap'}}>{fmtMoney(l.value, true)}</div>
              </div>
              <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', gap:8}}>
                <div style={{fontSize:10, color:T.text3}}>{l.rep}</div>
                {Tag}
              </div>
            </div>
          )
          return l.url
            ? <a key={i} href={l.url} target="_blank" rel="noopener noreferrer" style={{display:'block', textDecoration:'none', color:'inherit'}}>{Row}</a>
            : <div key={i}>{Row}</div>
        })}
      </div>
    </div>
  )
}

export function DistributorTrendMini({ config, data }: any) {
  const series: { label: string, value: number }[] = data?.series || []
  const total = series.reduce((s, p) => s + p.value, 0)
  const last  = series[series.length - 1]?.value || 0
  const max   = Math.max(1, ...series.map(p => p.value))
  // Build SVG sparkline polyline (84 wide × 28 tall — fits in tile)
  const width = 240
  const height = 36
  const pad = 2
  const points = series.length > 1
    ? series.map((p, i) => {
        const x = pad + (i / (series.length - 1)) * (width - 2 * pad)
        const y = height - pad - (p.value / max) * (height - 2 * pad)
        return `${x},${y}`
      }).join(' ')
    : ''
  return (
    <div style={{display:'flex', flexDirection:'column', height:'100%', justifyContent:'space-between'}}>
      <div>
        <div style={{fontSize:10, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em', fontWeight:600}}>{config?.title || data?.distributor || 'Distributor'}</div>
        {config?.title && data?.distributor && <div style={{fontSize:10, color:T.text3, marginTop:2}}>{data.distributor}</div>}
      </div>
      <div>
        <div style={{display:'flex', alignItems:'baseline', justifyContent:'space-between', gap:8, marginBottom:4}}>
          <div style={{fontSize:22, fontWeight:700, fontVariantNumeric:'tabular-nums', color:T.text, lineHeight:1}}>{fmtMoney(last, true)}</div>
          <div style={{fontSize:10, color:T.text3, fontFamily:'monospace'}}>{fmtMoney(total, true)} 12mo</div>
        </div>
        {points && (
          <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" style={{display:'block'}}>
            <polyline points={points} fill="none" stroke={T.blue} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round"/>
            {series.map((p, i) => {
              const x = pad + (i / Math.max(1, series.length - 1)) * (width - 2 * pad)
              const y = height - pad - (p.value / max) * (height - 2 * pad)
              return <circle key={i} cx={x} cy={y} r="1.5" fill={i === series.length - 1 ? T.blue : 'transparent'}/>
            })}
          </svg>
        )}
      </div>
    </div>
  )
}

export function ReportsQuickLaunch({ config, data }: any) {
  const items: { type: string, label: string, description: string }[] = data?.items || []
  return (
    <div style={{display:'flex', flexDirection:'column', height:'100%'}}>
      <div style={{fontSize:10, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em', fontWeight:600, marginBottom:8}}>{config?.title || 'Generate a report'}</div>
      <div style={{flex:1, overflow:'auto'}}>
        {items.length === 0 ? (
          <div style={{color:T.text3, fontSize:11, textAlign:'center', padding:20}}>No reports available for your role</div>
        ) : items.map((r, i) => (
          <a key={i} href={`/reports?type=${encodeURIComponent(r.type)}`}
             style={{display:'block', padding:'8px 10px', marginBottom:6, background:T.bg3, borderRadius:6, textDecoration:'none', border:`1px solid ${T.border}`}}>
            <div style={{fontSize:12, color:T.text, fontWeight:500, marginBottom:2}}>{r.label}</div>
            <div style={{fontSize:10, color:T.text3, lineHeight:1.4}}>{r.description}</div>
          </a>
        ))}
      </div>
    </div>
  )
}

export function VehicleSalesKpi({ config, data }: any) {
  const total      = Number(data?.total_ex_gst || 0)
  const classified = Number(data?.classified_total || 0)
  const unclass    = Number(data?.unclassified_total || 0)
  const invCount   = Number(data?.invoice_count || 0)
  const classPct   = total > 0 ? classified / total : 0
  const tiles = [
    { label: 'Total ex GST',  value: fmtMoney(total, true),      color: T.text },
    { label: 'Classified',    value: fmtMoney(classified, true), color: T.green },
    { label: 'Unclassified',  value: fmtMoney(unclass, true),    color: unclass > 0 ? T.amber : T.text3 },
    { label: 'Class. rate',   value: fmtPct(classPct),           color: classPct >= 0.95 ? T.green : classPct >= 0.8 ? T.amber : T.red },
  ]
  return (
    <div style={{display:'flex', flexDirection:'column', height:'100%'}}>
      <div style={{display:'flex', alignItems:'baseline', justifyContent:'space-between', marginBottom:10}}>
        <div style={{fontSize:10, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em', fontWeight:600}}>{config?.title || 'Vehicle sales'}</div>
        <div style={{fontSize:9, color:T.text3, fontFamily:'monospace'}}>{invCount} invoices</div>
      </div>
      <div style={{display:'grid', gridTemplateColumns:'repeat(4, 1fr)', gap:8, flex:1}}>
        {tiles.map(t => (
          <div key={t.label} style={{background:T.bg3, borderRadius:6, padding:'8px 10px'}}>
            <div style={{fontSize:9, color:T.text3, textTransform:'uppercase', letterSpacing:'0.04em'}}>{t.label}</div>
            <div style={{fontSize:16, fontWeight:700, fontVariantNumeric:'tabular-nums', color:t.color, lineHeight:1.2, marginTop:2}}>{t.value}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

// Registry — dashboard uses this to pick the renderer for a widget type
export const RENDERERS: Record<string, React.ComponentType<any>> = {
  kpi_number:                KpiNumber,
  kpi_comparison:            KpiComparison,
  progress_target:           ProgressTarget,
  quotes_received:           QuotesReceived,
  sales_scorecard:           SalesScorecard,
  pipeline_value:            PipelineValue,
  line_chart:                LineChart,
  bar_chart:                 BarChart,
  donut_chart:               DonutChart,
  distributor_total:         DistributorTotal,
  top_distributors:          TopDistributors,
  job_status_breakdown:      JobStatusBreakdown,
  supplier_invoice_queue:    SupplierInvoiceQueue,
  recent_activity:           RecentActivity,
  leaderboard:               Leaderboard,
  markdown_note:             MarkdownNote,
  // New widgets
  calls_kpi:                 CallsKpi,
  calls_agent_leaderboard:   CallsAgentLeaderboard,
  calls_missed_recent:       CallsMissedRecent,
  todos_kpi:                 TodosKpi,
  todos_manager_scorecard:   TodosManagerScorecard,
  stock_health_kpi:          StockHealthKpi,
  stock_critical_reorder:    StockCriticalReorder,
  stock_dead_top:            StockDeadTop,
  top_active_leads:          TopActiveLeads,
  distributor_trend_mini:    DistributorTrendMini,
  reports_quick_launch:      ReportsQuickLaunch,
  vehicle_sales_kpi:         VehicleSalesKpi,
}
