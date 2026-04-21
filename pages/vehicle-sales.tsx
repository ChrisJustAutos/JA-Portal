// pages/vehicle-sales.tsx
// Retrospective vehicle-platform breakdown from VPS MYOB invoices.
//
// Reads cached classifications from Supabase (fast). Admin can refresh the
// cache via the "Refresh from MYOB" button, which calls /api/vehicle-sales/sync
// in a loop (chunked to stay under serverless time limits).

import { useState, useEffect, useMemo } from 'react'
import Head from 'next/head'
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

const PLATFORM_COLOURS: Record<string, string> = {
  'VDJ79':'#4f8ef7', 'VDJ200':'#2dd4bf', 'VDJ76':'#60a5fa', 'VDJ70*':'#38bdf8',
  'FJA300':'#a78bfa', 'FJA250':'#c084fc',
  'GDJ70*':'#f59e0b', 'GDJ79':'#fbbf24', 'GDJ250':'#fb923c',
  'Hilux 1GD':'#34c77b', 'Hilux':'#10b981',
  'Mixed':'#f5a623', 'Unclassified':'#545968',
}

export async function getServerSideProps(ctx: any) {
  return requirePageAuth(ctx, 'view:vehicle_sales')
}

interface PlatformRow { key: string; label: string; total: number; invoice_count: number }
interface MonthRow {
  key: string; label: string; total: number; invoice_count: number;
  platforms: PlatformRow[];
}
interface Summary {
  period: { from: string; to: string }
  sync_state: {
    last_sync_at: string | null;
    last_invoice_date_synced: string | null;
    invoices_classified: number | null;
    last_sync_duration_ms: number | null;
    last_error: string | null;
  } | null
  summary: {
    invoice_count: number; total_ex_gst: number;
    classified_count: number; classified_total: number;
    unclassified_count: number; unclassified_total: number;
    mixed_count: number; mixed_total: number;
  }
  by_platform: PlatformRow[]
  by_month: MonthRow[]
}

function fmtMoney(n: number | null | undefined, compact = false): string {
  if (n === null || n === undefined || isNaN(n as any)) return '—'
  const v = Number(n)
  if (compact && Math.abs(v) >= 1_000_000) return '$' + (v / 1_000_000).toFixed(1) + 'M'
  if (compact && Math.abs(v) >= 10_000)    return '$' + (v / 1_000).toFixed(1) + 'k'
  return '$' + v.toLocaleString('en-AU', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
}

function defaultFromTo(): { from: string; to: string } {
  const now = new Date()
  const y = now.getUTCFullYear(), m = now.getUTCMonth() + 1
  const fyStartYear = m >= 7 ? y : y - 1
  const from = `${fyStartYear}-07-01`
  const to = `${y}-${String(m).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`
  return { from, to }
}

function fmtElapsed(ms: number | null | undefined): string {
  if (!ms) return '—'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60000).toFixed(1)}m`
}

function fmtRelative(iso: string | null | undefined): string {
  if (!iso) return 'never'
  const d = new Date(iso)
  const diffSec = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000))
  if (diffSec < 60) return `${diffSec}s ago`
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`
  return `${Math.floor(diffSec / 86400)}d ago`
}

export default function VehicleSalesPage({ user }: { user: { id: string; email: string; role: UserRole; name: string } }) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [data, setData] = useState<Summary | null>(null)

  const [from, setFrom] = useState<string>(() => defaultFromTo().from)
  const [to,   setTo  ] = useState<string>(() => defaultFromTo().to)
  const [activePlatform, setActivePlatform] = useState<string>('all')

  // Sync UI state
  const [syncing, setSyncing]   = useState(false)
  const [syncProgress, setSyncProgress] = useState<{ processed: number; total: number; window: { from: string; to: string } } | null>(null)
  const [syncError, setSyncError] = useState('')

  async function load(f: string, t: string) {
    setLoading(true); setError('')
    try {
      const r = await fetch(`/api/vehicle-sales/summary?from=${encodeURIComponent(f)}&to=${encodeURIComponent(t)}`)
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || 'Load failed')
      setData(d)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }

  useEffect(() => { load(from, to) }, [])

  const isAdmin = user.role === 'admin'

  async function runSync(mode: 'incremental' | 'full') {
    if (!isAdmin) return
    setSyncing(true); setSyncError(''); setSyncProgress(null)
    try {
      let offset = 0
      let total = 0
      let window: { from: string; to: string } = { from: '', to: '' }
      // Loop until done
      for (let i = 0; i < 500; i++) {  // safety cap
        const body = mode === 'full'
          ? { mode, offset, chunk_size: 30, from: '2020-01-01' }
          : { mode, offset, chunk_size: 30 }
        const r = await fetch('/api/vehicle-sales/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        const d = await r.json()
        if (!r.ok) throw new Error(d.error || `Sync failed (HTTP ${r.status})`)

        offset = d.next_offset
        total  = d.total_invoices
        window = d.window
        setSyncProgress({ processed: offset, total, window })
        if (d.done) break
      }
      // Reload
      await load(from, to)
    } catch (e: any) {
      setSyncError(e.message)
    } finally {
      setSyncing(false)
    }
  }

  const maxMonth = useMemo(() => Math.max(1, ...(data?.by_month || []).map(m => m.total)), [data])

  const filteredMonths = useMemo(() => {
    if (!data) return []
    if (activePlatform === 'all') return data.by_month
    return data.by_month.map(m => {
      const match = m.platforms.find(p => p.key === activePlatform)
      return { ...m, total: match?.total || 0, invoice_count: match?.invoice_count || 0 }
    })
  }, [data, activePlatform])

  const filteredMax = useMemo(() => Math.max(1, ...filteredMonths.map(m => m.total)), [filteredMonths])

  const quickRange = (setter: () => { from: string; to: string }) => {
    const r = setter(); setFrom(r.from); setTo(r.to); load(r.from, r.to)
  }

  return (
    <>
      <Head><title>Vehicle Sales — Just Autos</title></Head>
      <div style={{display:'flex', minHeight:'100vh', background:T.bg, color:T.text, fontFamily:'system-ui, -apple-system, sans-serif'}}>
        <PortalSidebar activeId="vehicle-sales" currentUserRole={user.role}/>
        <main style={{flex:1, padding:'20px 32px 40px', overflow:'auto'}}>

          <div style={{display:'flex', alignItems:'flex-start', justifyContent:'space-between', gap:12, marginBottom:16, flexWrap:'wrap'}}>
            <div>
              <h1 style={{margin:0, fontSize:22, fontWeight:600}}>Vehicle Sales (VPS)</h1>
              <div style={{fontSize:11, color:T.text3, marginTop:3}}>
                Actual revenue by vehicle platform, from MYOB VPS invoice lines. Ex-GST.
                {data?.sync_state && (
                  <> · Last sync: <strong style={{color:T.text2}}>{fmtRelative(data.sync_state.last_sync_at)}</strong>
                    {data.sync_state.invoices_classified != null && <> · {data.sync_state.invoices_classified} invoices</>}
                    {data.sync_state.last_sync_duration_ms != null && <> · took {fmtElapsed(data.sync_state.last_sync_duration_ms)}</>}
                  </>
                )}
              </div>
            </div>

            {isAdmin && (
              <div style={{display:'flex', gap:8, alignItems:'center'}}>
                <button onClick={() => runSync('incremental')} disabled={syncing}
                  style={{padding:'7px 14px', background:T.bg3, border:`1px solid ${T.border2}`, color:T.text, borderRadius:6, fontSize:12, fontFamily:'inherit', cursor: syncing ? 'wait' : 'pointer'}}>
                  {syncing ? 'Syncing…' : 'Refresh from MYOB'}
                </button>
                <button onClick={() => { if (confirm('Re-classify ALL VPS invoices from scratch? This may take several minutes.')) runSync('full') }} disabled={syncing}
                  style={{padding:'7px 14px', background:'transparent', border:`1px solid ${T.border2}`, color:T.text3, borderRadius:6, fontSize:12, fontFamily:'inherit', cursor: syncing ? 'wait' : 'pointer'}}>
                  Full reclassify
                </button>
              </div>
            )}
          </div>

          {/* Sync progress */}
          {(syncing || syncProgress) && (
            <div style={{background:T.bg2, border:`1px solid ${T.border}`, borderRadius:8, padding:'10px 14px', marginBottom:12, fontSize:12}}>
              {syncing && <span style={{color:T.blue}}>● Syncing </span>}
              {syncProgress && (
                <span style={{color:T.text2}}>
                  {syncProgress.processed} / {syncProgress.total} invoices
                  {syncProgress.total > 0 && <> ({Math.round(100 * syncProgress.processed / syncProgress.total)}%)</>}
                  {syncProgress.window.from && <> · range {syncProgress.window.from} → {syncProgress.window.to}</>}
                </span>
              )}
              {syncError && <div style={{color:T.red, marginTop:4}}>{syncError}</div>}
            </div>
          )}

          {/* Date range controls */}
          <div style={{display:'flex', gap:10, alignItems:'center', marginBottom:20, flexWrap:'wrap'}}>
            <label style={{fontSize:11, color:T.text3}}>From</label>
            <input type="date" value={from} onChange={e => setFrom(e.target.value)}
              style={{padding:'6px 10px', background:T.bg3, border:`1px solid ${T.border2}`, color:T.text, borderRadius:6, fontSize:12, fontFamily:'inherit', outline:'none'}}/>
            <label style={{fontSize:11, color:T.text3}}>To</label>
            <input type="date" value={to} onChange={e => setTo(e.target.value)}
              style={{padding:'6px 10px', background:T.bg3, border:`1px solid ${T.border2}`, color:T.text, borderRadius:6, fontSize:12, fontFamily:'inherit', outline:'none'}}/>
            <button onClick={() => load(from, to)} disabled={loading}
              style={{padding:'7px 14px', background:T.accent, border:'none', color:'#fff', borderRadius:6, fontSize:12, fontWeight:600, cursor: loading ? 'wait' : 'pointer', fontFamily:'inherit'}}>
              {loading ? 'Loading…' : 'Apply'}
            </button>

            <div style={{display:'flex', gap:4, marginLeft:12}}>
              <QuickBtn label="This FY"  onClick={() => quickRange(() => defaultFromTo())}/>
              <QuickBtn label="Last 90d" onClick={() => {
                const end = new Date(), start = new Date(Date.now() - 90 * 86400000)
                quickRange(() => ({ from: start.toISOString().slice(0,10), to: end.toISOString().slice(0,10) }))
              }}/>
              <QuickBtn label="Last 12m" onClick={() => {
                const end = new Date(), start = new Date(); start.setUTCFullYear(start.getUTCFullYear() - 1)
                quickRange(() => ({ from: start.toISOString().slice(0,10), to: end.toISOString().slice(0,10) }))
              }}/>
              <QuickBtn label="All time" onClick={() => quickRange(() => ({ from: '2020-01-01', to: defaultFromTo().to }))}/>
            </div>
          </div>

          {error && <div style={{background:'rgba(240,78,78,0.1)', border:`1px solid ${T.red}40`, borderRadius:8, padding:'10px 14px', color:T.red, fontSize:13, marginBottom:12}}>{error}</div>}

          {loading && !data ? (
            <div style={{padding:40, textAlign:'center', color:T.text3}}>Loading…</div>
          ) : !data || data.summary.invoice_count === 0 ? (
            <div style={{background:T.bg2, border:`1px dashed ${T.border2}`, borderRadius:12, padding:50, textAlign:'center'}}>
              <div style={{fontSize:14, fontWeight:600, marginBottom:8}}>
                {data?.sync_state?.last_sync_at ? 'No invoices classified in this range' : 'No classifications yet'}
              </div>
              <div style={{fontSize:12, color:T.text3, marginBottom:16}}>
                {data?.sync_state?.last_sync_at
                  ? 'Try widening the date window, or refresh from MYOB to pull any new invoices.'
                  : 'The cache is empty. Run a full sync to classify all VPS invoices from MYOB.'}
              </div>
              {isAdmin && !data?.sync_state?.last_sync_at && (
                <button onClick={() => runSync('full')} disabled={syncing}
                  style={{padding:'10px 20px', background:T.accent, border:'none', color:'#fff', borderRadius:6, fontSize:13, fontWeight:600, cursor: syncing ? 'wait' : 'pointer', fontFamily:'inherit'}}>
                  {syncing ? 'Syncing…' : 'Run first full sync'}
                </button>
              )}
            </div>
          ) : (
            <>
              {/* KPI tiles */}
              <div style={{display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(200px, 1fr))', gap:12, marginBottom:20}}>
                <Tile label="Total ex-GST"  value={fmtMoney(data.summary.total_ex_gst, true)}  subtext={`${data.summary.invoice_count} invoices`} highlight={T.green}/>
                <Tile label="Classified"    value={fmtMoney(data.summary.classified_total, true)}  subtext={`${data.summary.classified_count} invoices · ${pct(data.summary.classified_total, data.summary.total_ex_gst)}% of total`}/>
                <Tile label="Mixed"         value={fmtMoney(data.summary.mixed_total, true)}       subtext={`${data.summary.mixed_count} invoices with 2+ platforms`} highlight={T.amber}/>
                <Tile label="Unclassified"  value={fmtMoney(data.summary.unclassified_total, true)} subtext={`${data.summary.unclassified_count} invoices · no platform in line text`} highlight={T.text3}/>
              </div>

              <div style={{display:'grid', gridTemplateColumns:'minmax(0, 2fr) minmax(0, 1fr)', gap:16, marginBottom:20}}>

                {/* Bar chart by month */}
                <div style={{background:T.bg2, border:`1px solid ${T.border}`, borderRadius:10, padding:20}}>
                  <div style={{display:'flex', justifyContent:'space-between', alignItems:'baseline', marginBottom:16}}>
                    <div style={{fontSize:10, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em', fontWeight:600}}>
                      Revenue by month{activePlatform !== 'all' ? ` — ${activePlatform}` : ''}
                    </div>
                    <div style={{fontSize:10, color:T.text3}}>{filteredMonths.length} month{filteredMonths.length === 1 ? '' : 's'}</div>
                  </div>
                  {filteredMonths.length === 0 ? (
                    <div style={{fontSize:12, color:T.text3, padding:20, textAlign:'center'}}>No data in range.</div>
                  ) : (
                    <>
                      <div style={{display:'flex', alignItems:'flex-end', gap:6, height:200, paddingBottom:8, borderBottom:`1px solid ${T.border}`, overflowX:'auto'}}>
                        {filteredMonths.map(m => {
                          const heightPct = (m.total / filteredMax) * 100
                          const color = activePlatform !== 'all' ? (PLATFORM_COLOURS[activePlatform] || T.teal) : T.teal
                          return (
                            <div key={m.key} style={{flex:'1 0 40px', display:'flex', flexDirection:'column', alignItems:'center', gap:4, minWidth:40}}>
                              <div style={{fontSize:10, color:T.text2, fontVariantNumeric:'tabular-nums'}}>
                                {m.total > 0 ? fmtMoney(m.total, true) : ''}
                              </div>
                              <div style={{
                                width:'100%',
                                height:`${Math.max(1, heightPct)}%`,
                                minHeight:m.total > 0 ? 4 : 0,
                                background: color,
                                borderRadius:'3px 3px 0 0',
                                opacity: 0.85,
                              }}/>
                            </div>
                          )
                        })}
                      </div>
                      <div style={{display:'flex', gap:6, paddingTop:8, overflowX:'auto'}}>
                        {filteredMonths.map(m => (
                          <div key={m.key} style={{flex:'1 0 40px', minWidth:40, textAlign:'center', fontSize:10, color:T.text3}}>
                            {m.label.replace(' 20', "'")}
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </div>

                {/* Platform breakdown */}
                <div style={{background:T.bg2, border:`1px solid ${T.border}`, borderRadius:10, padding:20}}>
                  <div style={{fontSize:10, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em', fontWeight:600, marginBottom:16}}>By vehicle platform</div>
                  {data.by_platform.length === 0 ? (
                    <div style={{fontSize:11, color:T.text3}}>No platforms.</div>
                  ) : (
                    <div style={{display:'flex', flexDirection:'column', gap:8}}>
                      {data.by_platform.map(p => {
                        const pctVal = (p.total / (data.summary.total_ex_gst || 1)) * 100
                        const isActive = activePlatform === p.key
                        const isFiltering = activePlatform !== 'all'
                        const barColor = PLATFORM_COLOURS[p.key] || T.teal
                        return (
                          <div key={p.key} onClick={() => setActivePlatform(isActive ? 'all' : p.key)} style={{cursor:'pointer'}}>
                            <div style={{display:'flex', justifyContent:'space-between', fontSize:12, marginBottom:3}}>
                              <span style={{color: isActive ? T.text : T.text2, fontWeight: isActive ? 600 : 400}}>{p.label}</span>
                              <span style={{color:T.text2, fontVariantNumeric:'tabular-nums'}}>
                                {fmtMoney(p.total, true)} <span style={{color:T.text3, fontSize:10}}>({p.invoice_count})</span>
                              </span>
                            </div>
                            <div style={{height:6, background:T.bg3, borderRadius:3, overflow:'hidden'}}>
                              <div style={{height:'100%', width:`${pctVal}%`, background: barColor, opacity: !isFiltering || isActive ? 1 : 0.3, transition:'opacity 0.15s'}}/>
                            </div>
                          </div>
                        )
                      })}
                      {activePlatform !== 'all' && (
                        <button onClick={() => setActivePlatform('all')}
                          style={{marginTop:4, padding:'4px 0', border:'none', background:'transparent', color:T.text3, fontSize:10, textAlign:'left', cursor:'pointer', fontFamily:'inherit'}}>
                          × clear platform filter
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* Monthly detail */}
              <div style={{background:T.bg2, border:`1px solid ${T.border}`, borderRadius:10, overflow:'hidden'}}>
                <div style={{padding:'10px 14px', borderBottom:`1px solid ${T.border}`, background:T.bg3, fontSize:10, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em', fontWeight:600}}>
                  Monthly breakdown
                </div>
                <div style={{display:'grid', gridTemplateColumns:'140px 100px 1fr 120px', gap:12, padding:'10px 14px', borderBottom:`1px solid ${T.border}`, fontSize:10, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em', fontWeight:600}}>
                  <div>Month</div>
                  <div style={{textAlign:'right'}}>Invoices</div>
                  <div>Top platforms</div>
                  <div style={{textAlign:'right'}}>Total ex-GST</div>
                </div>
                {data.by_month.slice().reverse().map(m => {
                  const top3 = m.platforms.slice(0, 3)
                  return (
                    <div key={m.key} style={{display:'grid', gridTemplateColumns:'140px 100px 1fr 120px', gap:12, padding:'9px 14px', borderBottom:`1px solid ${T.border}`, fontSize:12, alignItems:'center'}}>
                      <div style={{color:T.text}}>{m.label}</div>
                      <div style={{color:T.text2, fontVariantNumeric:'tabular-nums', textAlign:'right'}}>{m.invoice_count}</div>
                      <div style={{display:'flex', gap:6, flexWrap:'wrap'}}>
                        {top3.map(p => (
                          <span key={p.key} onClick={() => setActivePlatform(p.key)}
                            style={{fontSize:10, padding:'2px 6px', borderRadius:3, cursor:'pointer', background:(PLATFORM_COLOURS[p.key] || T.teal) + '22', color: PLATFORM_COLOURS[p.key] || T.teal, fontWeight: 500}}>
                            {p.label} · {fmtMoney(p.total, true)}
                          </span>
                        ))}
                        {m.platforms.length > 3 && <span style={{fontSize:10, color:T.text3, alignSelf:'center'}}>+{m.platforms.length - 3} more</span>}
                      </div>
                      <div style={{color:T.text, fontVariantNumeric:'tabular-nums', textAlign:'right', fontWeight:500}}>{fmtMoney(m.total)}</div>
                    </div>
                  )
                })}
              </div>
            </>
          )}
        </main>
      </div>
    </>
  )
}

function QuickBtn({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button onClick={onClick}
      style={{padding:'5px 10px', background:'transparent', border:`1px solid ${T.border2}`, color:T.text2, borderRadius:5, fontSize:11, cursor:'pointer', fontFamily:'inherit'}}>
      {label}
    </button>
  )
}

function Tile({ label, value, subtext, highlight }: { label: string; value: string; subtext?: string; highlight?: string }) {
  return (
    <div style={{background:T.bg2, border:`1px solid ${T.border}`, borderLeft: highlight ? `3px solid ${highlight}` : `1px solid ${T.border}`, borderRadius:10, padding:'14px 16px'}}>
      <div style={{fontSize:10, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em', fontWeight:600}}>{label}</div>
      <div style={{fontSize:22, fontWeight:700, color:T.text, fontVariantNumeric:'tabular-nums', marginTop:4, lineHeight:1.1}}>{value}</div>
      {subtext && <div style={{fontSize:10, color:T.text3, marginTop:4}}>{subtext}</div>}
    </div>
  )
}

function pct(part: number, whole: number): number {
  if (!whole) return 0
  return Math.round((part / whole) * 100)
}
