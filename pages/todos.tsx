// pages/todos.tsx — To-Dos Dashboard
// Aggregates 6 manager to-do boards into one view: open/stuck/completed,
// critical tasks, per-manager scorecards, completed feed.

import { useState, useCallback, useEffect } from 'react'
import Head from 'next/head'
import { useRouter } from 'next/router'
import PortalSidebar from '../lib/PortalSidebar'
import { UserRole } from '../lib/permissions'
import { requirePageAuth } from '../lib/authServer'

const T = {
  bg:'#0d0f12', bg2:'#131519', bg3:'#1a1d23', bg4:'#21252d',
  border:'rgba(255,255,255,0.07)', border2:'rgba(255,255,255,0.12)',
  text:'#e8eaf0', text2:'#8b90a0', text3:'#545968',
  blue:'#4f8ef7', teal:'#2dd4bf', green:'#34c77b',
  amber:'#f5a623', red:'#f04e4e', purple:'#a78bfa', pink:'#ff5ac4',
  accent:'#4f8ef7',
}

// Per-manager colour accent for the scorecard
const MC: Record<string, string> = {
  'Chris':  T.blue,
  'Matt H': T.purple,
  'Amanda': T.pink,
  'Morgan': T.amber,
  'Ryan':   T.teal,
  'Sam':    T.green,
}

const STATUS_COLOURS: Record<string, string> = {
  'Working on it': T.amber,
  'Done':          T.green,
  'Stuck':         T.red,
  'On Hold':       T.pink,
  'Testing Phase': T.purple,
}

interface ManagerStats {
  manager: string
  boardId: number
  totalItems: number
  openTotal: number
  openByStatus: Record<string, number>
  critical: number
  completedInPeriod: number
  avgAgeDays: number | null
}

interface TodoItem {
  id: string
  name: string
  status: string
  priority: string | null
  createdAt: string
  createdLocalDate: string
  ageDays: number | null
  manager: string
  boardId: number
}

interface TodosData {
  fetchedAt: string
  period: { startDate: string; endDate: string }
  managers: ManagerStats[]
  totals: { openTotal: number; critical: number; completedInPeriod: number; teamTotal: number }
  criticalOpen: TodoItem[]
  completedFeed: TodoItem[]
}

interface PortalUserSSR { id: string; email: string; displayName: string | null; role: UserRole }

function Card({children,style}:{children:React.ReactNode;style?:React.CSSProperties}){
  return <div style={{background:T.bg2,border:`1px solid ${T.border}`,borderRadius:12,padding:20,...style}}>{children}</div>
}
function SH({children,right}:{children:React.ReactNode;right?:React.ReactNode}){
  return <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16}}>
    <div style={{fontSize:12,fontWeight:600,color:T.text3,textTransform:'uppercase',letterSpacing:'0.08em'}}>{children}</div>
    {right && <div>{right}</div>}
  </div>
}
function KPI({label,value,sub,subColor,accent}:{label:string;value:string;sub?:string;subColor?:string;accent?:string}){
  return <div style={{background:T.bg2,border:`1px solid ${T.border}`,borderLeft:`3px solid ${accent||T.blue}`,borderRadius:10,padding:'14px 16px'}}>
    <div style={{fontSize:11,color:T.text3,textTransform:'uppercase',letterSpacing:'0.05em'}}>{label}</div>
    <div style={{fontSize:26,fontWeight:600,color:T.text,marginTop:4,fontFamily:'monospace'}}>{value}</div>
    {sub && <div style={{fontSize:11,color:subColor||T.text3,marginTop:4}}>{sub}</div>}
  </div>
}
function fmtDate(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: '2-digit' })
}

export default function TodosDashboard({ user }: { user: PortalUserSSR }) {
  const router = useRouter()
  const [data, setData] = useState<TodosData | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [managerFilter, setManagerFilter] = useState('All')

  // Date range — defaults to current month, FY buttons like /sales
  const currentFY = new Date().getMonth() >= 6 ? new Date().getFullYear() + 1 : new Date().getFullYear()
  const now = new Date()
  const defaultStart = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`
  const defaultEnd   = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${new Date(now.getFullYear(),now.getMonth()+1,0).getDate()}`
  const [customStart, setCustomStart] = useState(defaultStart)
  const [customEnd,   setCustomEnd]   = useState(defaultEnd)
  const [isCustomRange, setIsCustomRange] = useState(true)
  const [fyYear, setFyYear] = useState(currentFY)
  const [dateParams, setDateParams] = useState(`startDate=${defaultStart}&endDate=${defaultEnd}`)
  const [dateLoading, setDateLoading] = useState(false)

  const fyLabel = isCustomRange
    ? `${fmtDate(customStart+'T00:00')} – ${fmtDate(customEnd+'T00:00')}`
    : `FY${fyYear}`
  function selectFY(y: number) {
    setFyYear(y); setIsCustomRange(false)
    setCustomStart(`${y-1}-07-01`); setCustomEnd(`${y}-06-30`)
    setDateLoading(true)
    setDateParams(`startDate=${y-1}-07-01&endDate=${y}-06-30`)
  }
  function applyCustomRange() {
    if (customStart && customEnd) {
      setIsCustomRange(true); setDateLoading(true)
      setDateParams(`startDate=${customStart}&endDate=${customEnd}`)
    }
  }

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true)
    try {
      const rp = isRefresh ? '&refresh=true' : ''
      const r = await fetch(`/api/todos?${dateParams}${rp}`)
      if (r.status === 401) { router.push('/login'); return }
      if (!r.ok) throw new Error('Failed to load to-do data')
      const d = await r.json()
      setData(d); setError(''); setDateLoading(false); setLoading(false)
      if (isRefresh) setRefreshing(false)
    } catch (e: any) {
      setError(e.message); setLoading(false); setDateLoading(false)
      if (isRefresh) setRefreshing(false)
    }
  }, [router, dateParams])
  useEffect(() => { load() }, [load])

  // Derived
  const managers = data?.managers || []
  const fm = managerFilter === 'All' ? managers : managers.filter(m => m.manager === managerFilter)
  const criticalList = managerFilter === 'All'
    ? (data?.criticalOpen || [])
    : (data?.criticalOpen || []).filter(c => c.manager === managerFilter)
  const completedList = managerFilter === 'All'
    ? (data?.completedFeed || [])
    : (data?.completedFeed || []).filter(c => c.manager === managerFilter)

  const openTotal = fm.reduce((s, m) => s + m.openTotal, 0)
  const criticalTotal = fm.reduce((s, m) => s + m.critical, 0)
  const completedTotal = fm.reduce((s, m) => s + m.completedInPeriod, 0)
  const teamTotal = fm.reduce((s, m) => s + m.totalItems, 0)

  // Average age across visible managers
  const avgAgeAcross = (() => {
    const withAvg = fm.filter(m => m.avgAgeDays !== null)
    if (withAvg.length === 0) return null
    const sum = withAvg.reduce((s, m) => s + (m.avgAgeDays || 0), 0)
    return Math.round(sum / withAvg.length)
  })()

  return (
    <>
      <Head><title>To-Dos — Just Autos</title><meta name="viewport" content="width=device-width,initial-scale=1"/><meta name="robots" content="noindex,nofollow"/></Head>
      <div style={{display:'flex',height:'100vh',overflow:'hidden',fontFamily:"'DM Sans',system-ui,sans-serif",color:T.text}}>
        <PortalSidebar activeId="todos" currentUserRole={user.role}/>
        <div style={{flex:1,display:'flex',flexDirection:'column',overflow:'hidden',background:T.bg}}>
          {/* Header */}
          <div style={{height:52,background:T.bg2,borderBottom:`1px solid ${T.border}`,display:'flex',alignItems:'center',padding:'0 20px',gap:12,flexShrink:0}}>
            <div style={{fontSize:14,fontWeight:600,color:T.text,marginRight:8}}>To-Dos</div>
            <span style={{fontSize:10,fontFamily:'monospace',padding:'2px 8px',borderRadius:4,background:'rgba(245,166,35,0.12)',color:T.amber,border:`1px solid ${T.amber}40`}}>Monday</span>
            <div style={{flex:1}}/>
            <button onClick={() => load(true)} disabled={refreshing}
              style={{padding:'5px 12px',borderRadius:5,border:`1px solid ${T.border2}`,background:'transparent',color:T.text2,fontSize:11,cursor:refreshing?'wait':'pointer',fontFamily:'inherit'}}>
              {refreshing ? 'Refreshing…' : '↻ Refresh'}
            </button>
          </div>

          {/* Toolbar */}
          <div style={{display:'flex',alignItems:'center',gap:10,padding:'10px 20px',background:T.bg2,borderBottom:`1px solid ${T.border}`,flexWrap:'wrap'}}>
            <div style={{display:'flex',gap:4}}>
              {['All', 'Chris', 'Matt H', 'Amanda', 'Morgan', 'Ryan', 'Sam'].map(m =>
                <button key={m} onClick={() => setManagerFilter(m)}
                  style={{padding:'4px 12px',borderRadius:5,border:`1px solid ${managerFilter===m?(MC[m]||T.accent):T.border}`,fontSize:11,background:managerFilter===m?(MC[m]||T.accent):'transparent',color:managerFilter===m?'#fff':T.text2,cursor:'pointer',fontFamily:'inherit'}}>{m}</button>
              )}
            </div>
            <div style={{flex:1}}/>
            {[currentFY-1, currentFY].map(y =>
              <button key={y} onClick={() => selectFY(y)}
                style={{padding:'3px 10px',borderRadius:4,border:'1px solid',fontSize:11,fontFamily:'monospace',fontWeight:600,cursor:'pointer',background:fyYear===y&&!isCustomRange?T.accent:'transparent',color:fyYear===y&&!isCustomRange?'#fff':T.text2,borderColor:fyYear===y&&!isCustomRange?T.accent:T.border}}>FY{y}</button>
            )}
            <div style={{width:1,height:18,background:T.border}}/>
            <span title="Filters completed tasks by the date the task was created (creation log)." style={{fontSize:10,color:T.text3,textTransform:'uppercase',letterSpacing:'0.04em',fontWeight:500,cursor:'help'}}>Created</span>
            <input type="date" value={customStart} onChange={e=>setCustomStart(e.target.value)} style={{padding:'3px 6px',borderRadius:4,border:`1px solid ${isCustomRange?T.accent:T.border}`,fontSize:11,fontFamily:'monospace',background:'transparent',color:T.text2,outline:'none',colorScheme:'dark'}}/>
            <span style={{fontSize:11,color:T.text3}}>→</span>
            <input type="date" value={customEnd} onChange={e=>setCustomEnd(e.target.value)} style={{padding:'3px 6px',borderRadius:4,border:`1px solid ${isCustomRange?T.accent:T.border}`,fontSize:11,fontFamily:'monospace',background:'transparent',color:T.text2,outline:'none',colorScheme:'dark'}}/>
            <button onClick={applyCustomRange} style={{padding:'3px 10px',borderRadius:4,border:`1px solid ${T.accent}`,fontSize:11,fontFamily:'monospace',fontWeight:600,cursor:'pointer',background:isCustomRange?T.accent:'transparent',color:isCustomRange?'#fff':T.accent}}>Apply</button>
            {dateLoading && <span style={{fontSize:14,animation:'spin 1s linear infinite',color:T.blue}}>⟳</span>}
          </div>

          {/* Content */}
          <div style={{flex:1,padding:20,overflowY:'auto',position:'relative'}}>
            <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
            {error && <div style={{background:'rgba(240,78,78,0.1)',border:`1px solid ${T.red}40`,borderRadius:8,padding:12,marginBottom:16,color:T.red,fontSize:12}}>{error}</div>}
            {dateLoading && <div style={{position:'absolute',inset:0,background:'rgba(13,15,18,0.75)',zIndex:10,display:'flex',alignItems:'center',justifyContent:'center',flexDirection:'column',gap:12,borderRadius:8}}>
              <div style={{fontSize:28,animation:'spin 1s linear infinite',color:T.blue}}>⟳</div><div style={{color:T.text2,fontSize:13}}>Loading to-do data for {fyLabel}…</div>
            </div>}
            {loading && !dateLoading && <div style={{display:'flex',alignItems:'center',justifyContent:'center',height:300,flexDirection:'column',gap:12}}>
              <div style={{fontSize:28,animation:'spin 1s linear infinite',color:T.text3}}>⟳</div><div style={{color:T.text3}}>Loading Monday.com data…</div>
            </div>}

            {!loading && data && <>
              {/* KPIs */}
              <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(170px,1fr))',gap:12,marginBottom:16}}>
                <KPI label="Open Tasks" value={String(openTotal)} sub={`${teamTotal} total in ${managerFilter==='All'?'team':managerFilter}`} accent={T.blue}/>
                <KPI label="⚠ Critical" value={String(criticalTotal)} sub={criticalTotal>0?'Needs attention':'All clear'} subColor={criticalTotal>0?T.red:T.green} accent={T.red}/>
                <KPI label="Completed" value={String(completedTotal)} sub={`${fyLabel}`} subColor={T.green} accent={T.green}/>
                <KPI label="Avg Age (open)" value={avgAgeAcross !== null ? `${avgAgeAcross}d` : '—'} sub="Days since creation" accent={T.amber}/>
              </div>

              {/* Critical list — only shown if there are any */}
              {criticalList.length > 0 && <Card style={{marginBottom:16,borderLeft:`3px solid ${T.red}`}}>
                <SH right={<span style={{fontSize:11,color:T.text3}}>{criticalList.length} critical</span>}>⚠ Critical Open Tasks</SH>
                <div style={{display:'flex',flexDirection:'column',gap:6,maxHeight:260,overflowY:'auto'}}>
                  {criticalList.map(it => (
                    <div key={it.id} style={{display:'flex',alignItems:'center',gap:10,padding:'8px 10px',background:T.bg3,borderRadius:6,border:`1px solid ${T.border}`}}>
                      <div style={{width:4,height:28,background:MC[it.manager]||T.accent,borderRadius:2,flexShrink:0}}/>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{fontSize:13,color:T.text,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}} title={it.name}>{it.name}</div>
                        <div style={{fontSize:10,color:T.text3,marginTop:2}}>
                          <span style={{color:MC[it.manager]||T.text3}}>{it.manager}</span>
                          {' · '}<span style={{color:STATUS_COLOURS[it.status]||T.text3}}>{it.status}</span>
                          {it.ageDays !== null && <span> · {it.ageDays}d old</span>}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </Card>}

              {/* Scorecard + completed feed side by side on desktop, stacked on mobile */}
              <div style={{display:'grid',gridTemplateColumns:'1.4fr 1fr',gap:14,marginBottom:16}}>
                <Card>
                  <SH>Manager Scorecard</SH>
                  <div style={{overflowX:'auto'}}>
                    <table style={{width:'100%',borderCollapse:'collapse'}}>
                      <thead><tr>{['Manager','Open','Critical','Working','Stuck','On Hold','Other','Completed','Avg Age'].map(h =>
                        <th key={h} style={{fontSize:10,color:T.text3,textTransform:'uppercase',padding:'0 8px 10px',textAlign:h==='Manager'?'left':'right',fontWeight:500,whiteSpace:'nowrap',letterSpacing:'0.05em'}}>{h}</th>)}
                      </tr></thead>
                      <tbody>{fm.map(m => {
                        // "Other" = any open status that isn't Working/Stuck/On Hold. This
                        // catches per-board quirks: Testing Phase (Chris), On-Going (Matt H),
                        // Ongoing (Ryan), On Going (Sam), etc.
                        const COMMON = new Set(['Working on it','Stuck','On Hold'])
                        const otherCount = Object.entries(m.openByStatus)
                          .filter(([status]) => !COMMON.has(status))
                          .reduce((s, [,n]) => s + n, 0)
                        return <tr key={m.manager} style={{borderTop:`1px solid ${T.border}`}}>
                          <td style={{fontSize:13,color:MC[m.manager]||T.text,padding:'10px 8px',fontWeight:500}}>{m.manager}</td>
                          <td style={{fontSize:13,fontFamily:'monospace',color:T.text,padding:'10px 8px',textAlign:'right',fontWeight:600}}>{m.openTotal}</td>
                          <td style={{fontSize:12,fontFamily:'monospace',color:m.critical>0?T.red:T.text3,padding:'10px 8px',textAlign:'right',fontWeight:m.critical>0?600:400}}>{m.critical || ''}</td>
                          <td style={{fontSize:12,fontFamily:'monospace',color:T.amber,padding:'10px 8px',textAlign:'right'}}>{m.openByStatus['Working on it'] || 0}</td>
                          <td style={{fontSize:12,fontFamily:'monospace',color:m.openByStatus['Stuck']>0?T.red:T.text3,padding:'10px 8px',textAlign:'right'}}>{m.openByStatus['Stuck'] || 0}</td>
                          <td style={{fontSize:12,fontFamily:'monospace',color:T.pink,padding:'10px 8px',textAlign:'right'}}>{m.openByStatus['On Hold'] || 0}</td>
                          <td style={{fontSize:12,fontFamily:'monospace',color:T.purple,padding:'10px 8px',textAlign:'right'}} title="Other open statuses (Testing Phase, On-Going, etc)">{otherCount || 0}</td>
                          <td style={{fontSize:12,fontFamily:'monospace',color:T.green,padding:'10px 8px',textAlign:'right'}}>{m.completedInPeriod}</td>
                          <td style={{fontSize:12,fontFamily:'monospace',color:m.avgAgeDays!==null&&m.avgAgeDays>30?T.amber:T.text2,padding:'10px 8px',textAlign:'right'}}>{m.avgAgeDays !== null ? `${m.avgAgeDays}d` : '—'}</td>
                        </tr>
                      })}</tbody>
                    </table>
                  </div>
                </Card>

                <Card>
                  <SH right={<span style={{fontSize:11,color:T.text3}}>{completedList.length} in period</span>}>Recently Completed</SH>
                  <div style={{display:'flex',flexDirection:'column',gap:5,maxHeight:440,overflowY:'auto'}}>
                    {completedList.length === 0 && <div style={{color:T.text3,fontSize:13,padding:24,textAlign:'center'}}>No completed tasks in {fyLabel}.</div>}
                    {completedList.map(it => (
                      <div key={it.id} style={{display:'flex',alignItems:'flex-start',gap:8,padding:'8px 0',borderBottom:`1px solid ${T.border}`}}>
                        <div style={{fontSize:10,color:T.green,fontFamily:'monospace',flexShrink:0,marginTop:3,width:50}}>{fmtDate(it.createdAt)}</div>
                        <div style={{flex:1,minWidth:0}}>
                          <div style={{fontSize:12,color:T.text,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}} title={it.name}>{it.name}</div>
                          <div style={{fontSize:10,color:MC[it.manager]||T.text3,marginTop:1}}>{it.manager}</div>
                        </div>
                        <div style={{fontSize:10,color:T.green,padding:'2px 6px',borderRadius:3,background:'rgba(52,199,123,0.1)',border:`1px solid ${T.green}40`,flexShrink:0}}>✓</div>
                      </div>
                    ))}
                  </div>
                </Card>
              </div>

              {/* Status distribution chart — horizontal stacked bars per manager */}
              <Card>
                <SH>Status Distribution (Open Tasks)</SH>
                {fm.map(m => {
                  const COMMON = new Set(['Working on it','Stuck','On Hold'])
                  const otherCount = Object.entries(m.openByStatus)
                    .filter(([status]) => !COMMON.has(status))
                    .reduce((s, [,n]) => s + n, 0)
                  const segments = [
                    { status:'Working on it', count: m.openByStatus['Working on it']||0, color: T.amber },
                    { status:'Stuck',         count: m.openByStatus['Stuck']||0,         color: T.red },
                    { status:'On Hold',       count: m.openByStatus['On Hold']||0,       color: T.pink },
                    { status:'Other',         count: otherCount,                         color: T.purple },
                  ]
                  const total = m.openTotal
                  if (total === 0) return (
                    <div key={m.manager} style={{display:'flex',alignItems:'center',gap:10,marginBottom:8}}>
                      <span style={{fontSize:12,color:MC[m.manager]||T.text2,width:80,flexShrink:0,fontWeight:500}}>{m.manager}</span>
                      <div style={{flex:1,fontSize:11,color:T.text3}}>No open tasks</div>
                    </div>
                  )
                  return (
                    <div key={m.manager} style={{display:'flex',alignItems:'center',gap:10,marginBottom:8}}>
                      <span style={{fontSize:12,color:MC[m.manager]||T.text2,width:80,flexShrink:0,fontWeight:500}}>{m.manager}</span>
                      <div style={{flex:1,height:22,background:T.bg4,borderRadius:4,overflow:'hidden',display:'flex'}}>
                        {segments.map(s => s.count > 0 && (
                          <div key={s.status} title={`${s.status}: ${s.count}`}
                            style={{height:'100%',width:`${(s.count/total)*100}%`,background:s.color,opacity:0.85}}/>
                        ))}
                      </div>
                      <span style={{fontSize:12,fontFamily:'monospace',color:T.text,width:40,textAlign:'right'}}>{total}</span>
                    </div>
                  )
                })}
                <div style={{display:'flex',gap:12,marginTop:12,fontSize:11,color:T.text3,flexWrap:'wrap'}}>
                  {[['Working on it',T.amber],['Stuck',T.red],['On Hold',T.pink],['Other',T.purple]].map(([label,color]) =>
                    <span key={label as string} style={{display:'inline-flex',alignItems:'center',gap:5}}>
                      <span style={{width:10,height:10,background:color as string,borderRadius:2,display:'inline-block'}}/>{label}
                    </span>
                  )}
                </div>
              </Card>

              <div style={{marginTop:20,fontSize:11,color:T.text3,textAlign:'center'}}>
                Data fetched {fmtDate(data.fetchedAt)} · {data.totals.teamTotal} items across {data.managers.length} managers · cached 5 min
              </div>
            </>}
          </div>
        </div>
      </div>
    </>
  )
}

export async function getServerSideProps(context: any) {
  return requirePageAuth(context, 'view:todos')
}
