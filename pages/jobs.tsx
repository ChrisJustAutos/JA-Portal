// pages/jobs.tsx
// Forecast by month — reads the current Mechanics Desk job report and shows
// expected revenue per calendar month, based on Job Date being today or later
// and a Total value > 0 on the job.

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

interface Report { id: string; uploaded_at: string; filename: string | null; row_count: number; notes: string | null }
interface ForecastJob {
  job_number: string; customer_name: string | null; vehicle: string | null;
  job_type: string | null; opened_date: string; estimated_total: number;
  vehicle_platform: string | null;
}
interface MonthBucket { key: string; label: string; total: number; job_count: number; jobs: ForecastJob[] }
interface PlatformBucket { key: string; label: string; total: number; job_count: number }
interface Summary {
  hasReport: boolean
  report: Report | null
  forecast: {
    total: number
    job_count: number
    future_jobs_total: number
    by_month:    MonthBucket[]
    by_platform: PlatformBucket[]
  }
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
  const parts = String(d).split('-')
  if (parts.length === 3) return `${parts[2]}/${parts[1]}/${parts[0].substring(2)}`
  return d
}

export default function JobsPage({ user }: { user: { id: string; email: string; role: UserRole; name: string } }) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [data, setData] = useState<Summary | null>(null)
  const [activeMonth, setActiveMonth] = useState<string | null>(null)
  const [activePlatform, setActivePlatform] = useState<string>('all')
  const [search, setSearch] = useState('')

  useEffect(() => {
    (async () => {
      setLoading(true); setError('')
      try {
        const r = await fetch('/api/jobs/summary')
        const d = await r.json()
        if (!r.ok) throw new Error(d.error || 'Load failed')
        setData(d)
        // Default-select the first month so the table shows something right away
        if (d.forecast?.by_month?.length > 0) setActiveMonth(d.forecast.by_month[0].key)
      } catch (e: any) { setError(e.message) }
      finally { setLoading(false) }
    })()
  }, [])

  const activeBucket = useMemo(() => {
    if (!data?.forecast?.by_month) return null
    return data.forecast.by_month.find(m => m.key === activeMonth) || null
  }, [data, activeMonth])

  const filteredJobs = useMemo(() => {
    if (!activeBucket) return []
    let rows = activeBucket.jobs
    if (activePlatform !== 'all') {
      rows = rows.filter(j => (j.vehicle_platform || 'Other') === activePlatform)
    }
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
  }, [activeBucket, search, activePlatform])

  const maxMonthValue = useMemo(() => {
    return Math.max(1, ...(data?.forecast?.by_month || []).map(m => m.total))
  }, [data])

  return (
    <>
      <Head><title>Jobs Forecast — Just Autos</title></Head>
      <div style={{display:'flex', minHeight:'100vh', background:T.bg, color:T.text, fontFamily:'system-ui, -apple-system, sans-serif'}}>
        <PortalSidebar activeId="jobs" currentUserRole={user.role}/>
        <main style={{flex:1, padding:'20px 32px 40px', overflow:'auto'}}>

          <div style={{display:'flex', alignItems:'center', gap:12, marginBottom:16, flexWrap:'wrap'}}>
            <h1 style={{margin:0, fontSize:22, fontWeight:600}}>Jobs forecast</h1>
            {data?.report && (
              <span style={{fontSize:11, color:T.text3}}>
                Report from <strong style={{color:T.text2}}>{fmtDate(data.report.uploaded_at.substring(0,10))}</strong>
                {data.report.filename && <> · {data.report.filename}</>}
                {' · '}
                <Link href="/settings?tab=data-imports" style={{color:T.blue, textDecoration:'none'}}>upload new report →</Link>
              </span>
            )}
          </div>

          {error && <div style={{background:'rgba(240,78,78,0.1)', border:`1px solid ${T.red}40`, borderRadius:8, padding:'10px 14px', color:T.red, fontSize:13, marginBottom:12}}>{error}</div>}

          {loading ? (
            <div style={{padding:40, textAlign:'center', color:T.text3}}>Loading…</div>
          ) : !data?.hasReport ? (
            <div style={{background:T.bg2, border:`1px dashed ${T.border2}`, borderRadius:12, padding:60, textAlign:'center'}}>
              <div style={{fontSize:16, fontWeight:600, marginBottom:8}}>No job report uploaded yet</div>
              <div style={{fontSize:13, color:T.text3, marginBottom:20}}>Upload a Mechanics Desk job export to see expected revenue per month.</div>
              <Link href="/settings?tab=data-imports" style={{display:'inline-block', padding:'10px 20px', borderRadius:6, background:T.accent, color:'#fff', fontSize:13, fontWeight:600, textDecoration:'none'}}>
                Go to Settings → Data Imports
              </Link>
            </div>
          ) : data.forecast.by_month.length === 0 ? (
            <div style={{background:T.bg2, border:`1px dashed ${T.border2}`, borderRadius:12, padding:60, textAlign:'center'}}>
              <div style={{fontSize:16, fontWeight:600, marginBottom:8}}>Nothing to forecast</div>
              <div style={{fontSize:13, color:T.text3}}>
                No jobs dated today or later with a dollar value.
                {data.forecast.future_jobs_total > 0 && (
                  <> There are {data.forecast.future_jobs_total} future-dated jobs but none have a Total yet.</>
                )}
              </div>
            </div>
          ) : (
            <>
              {/* KPI tiles */}
              <div style={{display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(200px, 1fr))', gap:12, marginBottom:20}}>
                <Tile label="Total forecast" value={fmtMoney(data.forecast.total, true)} subtext={`${data.forecast.job_count} jobs with a Total`} highlight={T.green}/>
                <Tile label="Months covered" value={String(data.forecast.by_month.length)} subtext={`${data.forecast.by_month[0].label} — ${data.forecast.by_month[data.forecast.by_month.length-1].label}`}/>
                <Tile label="Future-dated jobs" value={String(data.forecast.future_jobs_total)} subtext={
                  data.forecast.future_jobs_total > data.forecast.job_count
                    ? `${data.forecast.future_jobs_total - data.forecast.job_count} have no Total set`
                    : 'All have a Total'
                }/>
              </div>

              {/* Month chart + platform breakdown side by side */}
              <div style={{display:'grid', gridTemplateColumns:'minmax(0, 2fr) minmax(0, 1fr)', gap:16, marginBottom:20}}>

              {/* Bar chart — one bar per month */}
              <div style={{background:T.bg2, border:`1px solid ${T.border}`, borderRadius:10, padding:20}}>
                <div style={{fontSize:10, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em', fontWeight:600, marginBottom:16}}>Forecast by month</div>
                <div style={{display:'flex', alignItems:'flex-end', gap:12, height:200, paddingBottom:8, borderBottom:`1px solid ${T.border}`}}>
                  {data.forecast.by_month.map(m => {
                    const heightPct = (m.total / maxMonthValue) * 100
                    const isActive = m.key === activeMonth
                    return (
                      <div key={m.key}
                        onClick={() => setActiveMonth(m.key)}
                        style={{
                          flex:1, display:'flex', flexDirection:'column', alignItems:'center', gap:6,
                          cursor:'pointer', minWidth:60,
                        }}>
                        <div style={{fontSize:11, color: isActive ? T.text : T.text2, fontVariantNumeric:'tabular-nums', fontWeight: isActive ? 600 : 400}}>
                          {fmtMoney(m.total, true)}
                        </div>
                        <div style={{
                          width:'100%',
                          height:`${Math.max(2, heightPct)}%`,
                          minHeight:4,
                          background: isActive ? T.blue : T.teal,
                          borderRadius:'4px 4px 0 0',
                          opacity: isActive ? 1 : 0.7,
                          transition:'opacity 0.15s, background 0.15s',
                        }}/>
                      </div>
                    )
                  })}
                </div>
                <div style={{display:'flex', gap:12, paddingTop:8}}>
                  {data.forecast.by_month.map(m => {
                    const isActive = m.key === activeMonth
                    return (
                      <div key={m.key}
                        onClick={() => setActiveMonth(m.key)}
                        style={{
                          flex:1, minWidth:60, textAlign:'center',
                          fontSize:11,
                          color: isActive ? T.text : T.text3,
                          fontWeight: isActive ? 600 : 400,
                          cursor:'pointer',
                        }}>
                        <div>{m.label}</div>
                        <div style={{fontSize:10, color:T.text3, marginTop:2}}>{m.job_count} job{m.job_count === 1 ? '' : 's'}</div>
                      </div>
                    )
                  })}
                </div>
              </div>

              {/* Platform breakdown */}
              <div style={{background:T.bg2, border:`1px solid ${T.border}`, borderRadius:10, padding:20}}>
                <div style={{fontSize:10, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em', fontWeight:600, marginBottom:16}}>
                  By vehicle platform
                </div>
                {data.forecast.by_platform.length === 0 ? (
                  <div style={{fontSize:11, color:T.text3}}>No platform data.</div>
                ) : (() => {
                  const grandTotal = data.forecast.total || 1
                  const isFiltering = activePlatform !== 'all'
                  return (
                    <div style={{display:'flex', flexDirection:'column', gap:8}}>
                      {data.forecast.by_platform.map((p, i) => {
                        const pct = (p.total / grandTotal) * 100
                        const isActive = activePlatform === p.key
                        return (
                          <div key={p.key}
                            onClick={() => setActivePlatform(isActive ? 'all' : p.key)}
                            style={{cursor:'pointer'}}>
                            <div style={{display:'flex', justifyContent:'space-between', fontSize:12, marginBottom:3}}>
                              <span style={{color: isActive ? T.blue : T.text, fontWeight: isActive ? 600 : 400}}>{p.label}</span>
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
                        <button onClick={() => setActivePlatform('all')}
                          style={{
                            marginTop:4, padding:'4px 0', border:'none', background:'transparent',
                            color:T.text3, fontSize:10, textAlign:'left', cursor:'pointer', fontFamily:'inherit',
                          }}>× clear platform filter</button>
                      )}
                    </div>
                  )
                })()}
              </div>

              </div>
              {/* End month + platform grid */}

              {/* Month jobs table */}
              {activeBucket && (
                <div>
                  <div style={{display:'flex', alignItems:'baseline', justifyContent:'space-between', gap:12, marginBottom:10, flexWrap:'wrap'}}>
                    <div>
                      <h2 style={{margin:0, fontSize:16, fontWeight:600}}>{activeBucket.label}</h2>
                      <div style={{fontSize:11, color:T.text3, marginTop:2}}>
                        {activeBucket.job_count} jobs · {fmtMoney(activeBucket.total)} total
                      </div>
                    </div>
                    <input placeholder="Search job, customer, vehicle, type…"
                      value={search} onChange={e => setSearch(e.target.value)}
                      style={{padding:'7px 12px', background:T.bg3, border:`1px solid ${T.border2}`, color:T.text, borderRadius:6, fontSize:12, fontFamily:'inherit', outline:'none', width:280, maxWidth:'100%'}}/>
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
                        {search || activePlatform !== 'all' ? 'No jobs match these filters.' : 'No jobs.'}
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
                        <div style={{color:T.text3, fontSize:11, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>{j.job_type || '—'}</div>
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

function Tile({ label, value, subtext, highlight }: { label: string; value: string; subtext?: string; highlight?: string }) {
  return (
    <div style={{background:T.bg2, border:`1px solid ${T.border}`, borderLeft: highlight ? `3px solid ${highlight}` : `1px solid ${T.border}`, borderRadius:10, padding:'14px 16px'}}>
      <div style={{fontSize:10, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em', fontWeight:600}}>{label}</div>
      <div style={{fontSize:24, fontWeight:700, color:T.text, fontVariantNumeric:'tabular-nums', marginTop:4, lineHeight:1.1}}>{value}</div>
      {subtext && <div style={{fontSize:10, color:T.text3, marginTop:4}}>{subtext}</div>}
    </div>
  )
}
