// pages/jobs.tsx
// Jobs deep-dive page. Pulls the latest Mechanics Desk job report and breaks
// it down: counts (open/closed), forecast (open jobs estimated total), jobs
// by type, jobs by status, and a filterable list of open jobs.

import { useState, useEffect } from 'react'
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

const DONUT_COLORS = [T.blue, T.teal, T.amber, T.purple, T.green, T.red, '#ff5ac4', '#60a5fa', '#f472b6', '#a3e635']

export async function getServerSideProps(ctx: any) {
  // `as any` works around a TS narrowing quirk during Next.js build — the
  // same pattern/arg compiles fine in supplier-invoices.tsx and job-reports.tsx,
  // but Next's SWC compiler sometimes fails here at build time. Functionally
  // identical to passing the literal.
  return requirePageAuth(ctx, 'view:supplier_invoices' as any)
}

interface Report { id: string; uploaded_at: string; filename: string | null; row_count: number; notes: string | null }
interface TypeRow { label: string; count: number; open_count: number; estimated_total: number }
interface StatusRow { label: string; count: number }
interface OpenJob {
  job_number: string; customer_name: string | null; vehicle: string | null;
  status: string | null; job_type: string | null; estimated_total: number | null;
  opened_date: string | null;
}
interface Summary {
  hasReport: boolean
  report: Report | null
  counts:   { total: number; open: number; closed: number }
  forecast: { open_estimated_total: number; has_any_estimated: boolean; open_without_estimates: number }
  byType:   TypeRow[]
  byStatus: StatusRow[]
  openJobs: OpenJob[]
}

function fmtMoney(n: number | null | undefined, compact = false): string {
  if (n === null || n === undefined || isNaN(n as any)) return '—'
  const v = Number(n)
  if (compact && Math.abs(v) >= 1_000_000) return '$' + (v / 1_000_000).toFixed(1) + 'M'
  if (compact && Math.abs(v) >= 10_000)    return '$' + (v / 1_000).toFixed(1) + 'k'
  return '$' + v.toLocaleString('en-AU', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
}
function fmtDate(d: string | null | undefined): string {
  if (!d) return '—'
  try {
    const parts = d.split('-')
    if (parts.length === 3) return `${parts[2]}/${parts[1]}/${parts[0].substring(2)}`
    return d
  } catch { return d || '—' }
}
function daysAgo(d: string | null | undefined): number | null {
  if (!d) return null
  const now = new Date(); now.setHours(0,0,0,0)
  const then = new Date(d + 'T00:00:00')
  if (isNaN(then.getTime())) return null
  return Math.max(0, Math.floor((now.getTime() - then.getTime()) / 86400000))
}

export default function JobsPage({ user }: { user: { id: string; email: string; role: UserRole; name: string } }) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [data, setData] = useState<Summary | null>(null)
  const [tab, setTab] = useState<'open'|'types'|'statuses'>('open')

  // Filters for the open jobs list
  const [filterType, setFilterType]   = useState<string>('all')
  const [filterStatus, setFilterStatus] = useState<string>('all')
  const [search, setSearch] = useState('')
  const [sortBy, setSortBy] = useState<'age'|'value'|'customer'>('age')

  useEffect(() => {
    (async () => {
      setLoading(true); setError('')
      try {
        const r = await fetch('/api/jobs/summary')
        const d = await r.json()
        if (!r.ok) throw new Error(d.error || 'Load failed')
        setData(d)
      } catch (e: any) { setError(e.message) }
      finally { setLoading(false) }
    })()
  }, [])

  const typeOptions = data?.byType.map(t => t.label) || []
  const statusOptions = data?.byStatus.map(s => s.label) || []

  const filteredOpen = (() => {
    if (!data) return []
    let rows = data.openJobs.slice()
    if (filterType !== 'all')   rows = rows.filter(j => (j.job_type || '(no type)') === filterType)
    if (filterStatus !== 'all') rows = rows.filter(j => (j.status || '(no status)') === filterStatus)
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      rows = rows.filter(j =>
        String(j.job_number || '').toLowerCase().includes(q) ||
        String(j.customer_name || '').toLowerCase().includes(q) ||
        String(j.vehicle || '').toLowerCase().includes(q)
      )
    }
    if (sortBy === 'age')      rows.sort((a, b) => (a.opened_date || '9999') > (b.opened_date || '9999') ? 1 : -1)
    if (sortBy === 'value')    rows.sort((a, b) => Number(b.estimated_total || 0) - Number(a.estimated_total || 0))
    if (sortBy === 'customer') rows.sort((a, b) => String(a.customer_name || '').localeCompare(String(b.customer_name || '')))
    return rows
  })()

  const donutTotal = (data?.byType.reduce((s, t) => s + t.count, 0) || 1)
  let donutCumulative = 0

  return (
    <>
      <Head><title>Jobs — Just Autos</title></Head>
      <div style={{display:'flex', minHeight:'100vh', background:T.bg, color:T.text, fontFamily:'system-ui, -apple-system, sans-serif'}}>
        <PortalSidebar activeId="jobs" currentUserRole={user.role}/>
        <main style={{flex:1, padding:'20px 32px 40px', overflow:'auto'}}>

          <div style={{display:'flex', alignItems:'center', gap:12, marginBottom:16, flexWrap:'wrap'}}>
            <h1 style={{margin:0, fontSize:22, fontWeight:600}}>Jobs</h1>
            {data?.report && (
              <span style={{fontSize:11, color:T.text3}}>
                Report from <strong style={{color:T.text2}}>{fmtDate(data.report.uploaded_at.substring(0,10))}</strong>
                {data.report.filename && <> · {data.report.filename}</>}
                {' · '}
                <Link href="/job-reports" style={{color:T.blue, textDecoration:'none'}}>upload new report →</Link>
              </span>
            )}
          </div>

          {error && <div style={{background:'rgba(240,78,78,0.1)', border:`1px solid ${T.red}40`, borderRadius:8, padding:'10px 14px', color:T.red, fontSize:13, marginBottom:12}}>{error}</div>}

          {loading ? (
            <div style={{padding:40, textAlign:'center', color:T.text3}}>Loading…</div>
          ) : !data?.hasReport ? (
            <div style={{background:T.bg2, border:`1px dashed ${T.border2}`, borderRadius:12, padding:60, textAlign:'center'}}>
              <div style={{fontSize:16, fontWeight:600, marginBottom:8}}>No job report uploaded yet</div>
              <div style={{fontSize:13, color:T.text3, marginBottom:20}}>Upload a Mechanics Desk job export to see open jobs, type breakdowns, and forecast revenue.</div>
              <Link href="/job-reports" style={{display:'inline-block', padding:'10px 20px', borderRadius:6, background:T.accent, color:'#fff', fontSize:13, fontWeight:600, textDecoration:'none'}}>
                Go to Job Reports → upload
              </Link>
            </div>
          ) : (
            <>
              {/* KPI tiles */}
              <div style={{display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(180px, 1fr))', gap:12, marginBottom:20}}>
                <Tile label="Open jobs"     value={data.counts.open.toString()} subtext={`${data.counts.total} total · ${data.counts.closed} closed`}/>
                <Tile label="Forecast revenue (open)" value={fmtMoney(data.forecast.open_estimated_total, true)} subtext={
                  !data.forecast.has_any_estimated
                    ? 'No estimated totals in this export'
                    : data.forecast.open_without_estimates > 0
                      ? `${data.forecast.open_without_estimates} open jobs have no $ estimate`
                      : 'Based on estimated totals per job'
                } highlight={data.forecast.has_any_estimated ? T.green : T.amber}/>
                <Tile label="Job types"     value={String(data.byType.length)} subtext="Distinct job type values"/>
                <Tile label="Statuses"      value={String(data.byStatus.length)} subtext="Distinct status values"/>
              </div>

              {/* Tab bar */}
              <div style={{display:'flex', gap:2, marginBottom:14, borderBottom:`1px solid ${T.border}`}}>
                {[
                  { id: 'open',     label: 'Open jobs'     },
                  { id: 'types',    label: 'By job type'   },
                  { id: 'statuses', label: 'By status'     },
                ].map(t => (
                  <button key={t.id} onClick={() => setTab(t.id as any)}
                    style={{
                      padding:'8px 16px', border:'none', background:'transparent',
                      color: tab === t.id ? T.text : T.text3,
                      borderBottom: tab === t.id ? `2px solid ${T.blue}` : '2px solid transparent',
                      marginBottom:-1, fontSize:13, fontFamily:'inherit', cursor:'pointer', fontWeight: tab === t.id ? 600 : 400,
                    }}>
                    {t.label}
                  </button>
                ))}
              </div>

              {tab === 'open' && (
                <div>
                  {/* Filters */}
                  <div style={{display:'flex', gap:8, marginBottom:12, flexWrap:'wrap'}}>
                    <input placeholder="Search job, customer, vehicle…" value={search} onChange={e => setSearch(e.target.value)}
                      style={{flex:'1 1 260px', padding:'7px 12px', background:T.bg3, border:`1px solid ${T.border2}`, color:T.text, borderRadius:6, fontSize:12, fontFamily:'inherit', outline:'none', minWidth:200}}/>
                    <select value={filterType} onChange={e => setFilterType(e.target.value)}
                      style={{padding:'7px 12px', background:T.bg3, border:`1px solid ${T.border2}`, color:T.text, borderRadius:6, fontSize:12, fontFamily:'inherit', outline:'none'}}>
                      <option value="all">All types</option>
                      {typeOptions.map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                    <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)}
                      style={{padding:'7px 12px', background:T.bg3, border:`1px solid ${T.border2}`, color:T.text, borderRadius:6, fontSize:12, fontFamily:'inherit', outline:'none'}}>
                      <option value="all">All statuses</option>
                      {statusOptions.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                    <select value={sortBy} onChange={e => setSortBy(e.target.value as any)}
                      style={{padding:'7px 12px', background:T.bg3, border:`1px solid ${T.border2}`, color:T.text, borderRadius:6, fontSize:12, fontFamily:'inherit', outline:'none'}}>
                      <option value="age">Sort: Oldest first</option>
                      <option value="value">Sort: $ highest first</option>
                      <option value="customer">Sort: Customer A-Z</option>
                    </select>
                    <div style={{alignSelf:'center', fontSize:11, color:T.text3}}>
                      {filteredOpen.length} of {data.openJobs.length} open jobs
                    </div>
                  </div>

                  {/* Table */}
                  <div style={{background:T.bg2, border:`1px solid ${T.border}`, borderRadius:10, overflow:'hidden'}}>
                    <div style={{display:'grid', gridTemplateColumns:'100px 1fr 1fr 140px 120px 110px 80px', gap:12, padding:'10px 14px', borderBottom:`1px solid ${T.border}`, background:T.bg3, fontSize:10, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em', fontWeight:600}}>
                      <div>Job #</div><div>Customer</div><div>Vehicle</div><div>Status</div><div>Type</div><div style={{textAlign:'right'}}>Estimated</div><div style={{textAlign:'right'}}>Age</div>
                    </div>
                    {filteredOpen.length === 0 ? (
                      <div style={{padding:30, textAlign:'center', color:T.text3, fontSize:12}}>No jobs match these filters.</div>
                    ) : filteredOpen.map((j, i) => {
                      const age = daysAgo(j.opened_date)
                      const ageColor = age === null ? T.text3 : age > 30 ? T.red : age > 14 ? T.amber : T.text2
                      return (
                        <div key={j.job_number + i} style={{display:'grid', gridTemplateColumns:'100px 1fr 1fr 140px 120px 110px 80px', gap:12, padding:'9px 14px', borderBottom:`1px solid ${T.border}`, fontSize:12, alignItems:'center'}}>
                          <div style={{fontFamily:'monospace', color:T.text}}>{j.job_number}</div>
                          <div style={{color:T.text, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>{j.customer_name || '—'}</div>
                          <div style={{color:T.text2, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>{j.vehicle || '—'}</div>
                          <div style={{color:T.text2, fontSize:11}}>{j.status || '—'}</div>
                          <div style={{color:T.text3, fontSize:11}}>{j.job_type || '—'}</div>
                          <div style={{color:T.text, fontVariantNumeric:'tabular-nums', textAlign:'right'}}>{fmtMoney(j.estimated_total, true)}</div>
                          <div style={{color:ageColor, fontVariantNumeric:'tabular-nums', textAlign:'right', fontSize:11}}>{age === null ? '—' : `${age}d`}</div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}

              {tab === 'types' && (
                <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:16}}>
                  {/* Donut */}
                  <div style={{background:T.bg2, border:`1px solid ${T.border}`, borderRadius:10, padding:20}}>
                    <div style={{fontSize:10, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em', fontWeight:600, marginBottom:16}}>Distribution</div>
                    <div style={{display:'flex', gap:20, alignItems:'center'}}>
                      <div style={{width:140, height:140, flexShrink:0}}>
                        <svg viewBox="0 0 100 100">
                          <circle cx="50" cy="50" r="42" stroke={T.bg3} strokeWidth="14" fill="none"/>
                          {data.byType.map((t, i) => {
                            const pct = t.count / donutTotal
                            const off = 2 * Math.PI * 42 * donutCumulative
                            const len = 2 * Math.PI * 42 * pct
                            donutCumulative += pct
                            return <circle key={i} cx="50" cy="50" r="42" stroke={DONUT_COLORS[i % DONUT_COLORS.length]} strokeWidth="14" fill="none" strokeDasharray={`${len} ${2*Math.PI*42 - len}`} strokeDashoffset={-off} transform="rotate(-90 50 50)"/>
                          })}
                        </svg>
                      </div>
                      <div style={{flex:1, overflow:'auto', maxHeight:260}}>
                        {data.byType.map((t, i) => (
                          <div key={t.label} style={{display:'flex', alignItems:'center', gap:8, padding:'4px 0', fontSize:12}}>
                            <div style={{width:10, height:10, borderRadius:2, background:DONUT_COLORS[i % DONUT_COLORS.length], flexShrink:0}}/>
                            <div style={{flex:1, color:T.text, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>{t.label}</div>
                            <div style={{color:T.text2, fontVariantNumeric:'tabular-nums'}}>{t.count}</div>
                            <div style={{color:T.text3, fontSize:10, minWidth:40, textAlign:'right'}}>{((t.count/donutTotal)*100).toFixed(0)}%</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* Detailed table */}
                  <div style={{background:T.bg2, border:`1px solid ${T.border}`, borderRadius:10, padding:16}}>
                    <div style={{fontSize:10, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em', fontWeight:600, marginBottom:12}}>Type breakdown</div>
                    <div style={{display:'grid', gridTemplateColumns:'1fr 60px 60px 110px', gap:10, padding:'6px 0', borderBottom:`1px solid ${T.border}`, fontSize:10, color:T.text3, textTransform:'uppercase', fontWeight:600}}>
                      <div>Type</div><div style={{textAlign:'right'}}>Total</div><div style={{textAlign:'right'}}>Open</div><div style={{textAlign:'right'}}>Forecast $</div>
                    </div>
                    {data.byType.map(t => (
                      <div key={t.label} style={{display:'grid', gridTemplateColumns:'1fr 60px 60px 110px', gap:10, padding:'7px 0', borderBottom:`1px solid ${T.border}`, fontSize:12}}>
                        <div style={{color:T.text}}>{t.label}</div>
                        <div style={{color:T.text2, fontVariantNumeric:'tabular-nums', textAlign:'right'}}>{t.count}</div>
                        <div style={{color:T.amber, fontVariantNumeric:'tabular-nums', textAlign:'right'}}>{t.open_count}</div>
                        <div style={{color:T.text, fontVariantNumeric:'tabular-nums', textAlign:'right', fontWeight:500}}>{t.estimated_total > 0 ? fmtMoney(t.estimated_total, true) : '—'}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {tab === 'statuses' && (
                <div style={{background:T.bg2, border:`1px solid ${T.border}`, borderRadius:10, padding:20}}>
                  {data.byStatus.map((s, i) => {
                    const total = data.byStatus.reduce((acc, x) => acc + x.count, 0) || 1
                    return (
                      <div key={s.label} style={{marginBottom:12}}>
                        <div style={{display:'flex', justifyContent:'space-between', fontSize:12, marginBottom:3}}>
                          <span style={{color:T.text}}>{s.label}</span>
                          <span style={{color:T.text2, fontVariantNumeric:'tabular-nums'}}>{s.count} <span style={{color:T.text3, fontSize:10}}>({((s.count/total)*100).toFixed(0)}%)</span></span>
                        </div>
                        <div style={{height:6, background:T.bg3, borderRadius:3, overflow:'hidden'}}>
                          <div style={{height:'100%', width:`${(s.count/total)*100}%`, background:DONUT_COLORS[i % DONUT_COLORS.length], opacity:0.85}}/>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </>
          )}
        </main>
      </div>
    </>
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
