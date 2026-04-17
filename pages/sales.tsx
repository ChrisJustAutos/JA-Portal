// pages/sales.tsx — Just Autos Sales Dashboard (portal-integrated)
import { useEffect, useState, useCallback } from 'react'
import Head from 'next/head'
import { useRouter } from 'next/router'

const T={bg:'#0d0f12',bg2:'#131519',bg3:'#1a1d23',bg4:'#21252d',border:'rgba(255,255,255,0.07)',border2:'rgba(255,255,255,0.12)',text:'#e8eaf0',text2:'#8b90a0',text3:'#545968',blue:'#4f8ef7',teal:'#2dd4bf',green:'#34c77b',amber:'#f5a623',red:'#f04e4e',purple:'#a78bfa',pink:'#ff5ac4',accent:'#4f8ef7'}
const fmt=(n:number)=>n>=1e6?'$'+(n/1e6).toFixed(2)+'M':n>=1000?'$'+Math.round(n/1000)+'k':'$'+Math.round(n)
const RC:Record<string,string>={Tyronne:T.blue,James:T.teal,Dom:T.amber,Kaleb:T.purple,Graham:T.pink}

function Tag({children,color}:{children:React.ReactNode;color:string}){return <span style={{fontSize:10,fontFamily:'monospace',padding:'2px 8px',borderRadius:4,background:`${color}20`,color,border:`1px solid ${color}40`}}>{children}</span>}
function KPI({label,value,sub,accent,subColor}:{label:string;value:string;sub?:string;accent?:string;subColor?:string}){return <div style={{background:T.bg2,border:`1px solid ${T.border}`,borderRadius:10,padding:'12px 14px',borderTop:accent?`3px solid ${accent}`:undefined}}><div style={{fontSize:9,color:T.text3,textTransform:'uppercase',letterSpacing:'0.07em',marginBottom:6}}>{label}</div><div style={{fontSize:18,fontWeight:600,fontFamily:'monospace',letterSpacing:'-0.03em',marginBottom:2,color:T.text}}>{value}</div>{sub&&<div style={{fontSize:10,color:subColor||T.text3}}>{sub}</div>}</div>}
function Card({children,style}:{children:React.ReactNode;style?:React.CSSProperties}){return <div style={{background:T.bg2,border:`1px solid ${T.border}`,borderRadius:10,padding:14,...style}}>{children}</div>}
function SH({children,right}:{children:React.ReactNode;right?:React.ReactNode}){return <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12}}><div style={{fontSize:11,fontWeight:600,color:T.text3,textTransform:'uppercase',letterSpacing:'0.08em'}}>{children}</div>{right&&<div>{right}</div>}</div>}

interface SalesData {
  fetchedAt:string
  period:{startDate:string;endDate:string}
  orders:{monthly:Record<string,{orders:number;value:number}>;byType:Record<string,{count:number;value:number}>;totalOrders:number;totalValue:number}|null
  distributors:{byDistributor:Record<string,{count:number;value:number}>;byStatus:Record<string,{count:number;value:number}>;mtdByDist:Record<string,{count:number;value:number}>;total:{count:number;value:number};mtdTotal:{count:number;value:number}}|null
  quotes:{rep:string;full:string;id:number;stats:Record<string,{count:number;value:number}>;totalItems:number;totalValue:number}[]
}

const STATUSES_ORDER=['Not Done','Quote Sent','3 Days','14 Days','Follow Up Done','On Hold','Quote On Hold','RLMNA','Quote Not Issued','Quote Won','Quote Lost']
const STATUS_COLORS:Record<string,string>={'Not Done':T.text3,'Quote Sent':'#037f4c','3 Days':T.blue,'14 Days':T.amber,'Follow Up Done':T.pink,'On Hold':'#ffcb00','Quote On Hold':'#ffcb00','RLMNA':'#007eb5','Quote Not Issued':'#ff6d3b','Quote Won':T.green,'Quote Lost':T.red}

export default function SalesDashboard(){
  const router=useRouter()
  const [data,setData]=useState<SalesData|null>(null)
  const [loading,setLoading]=useState(true)
  const [refreshing,setRefreshing]=useState(false)
  const [error,setError]=useState('')
  const [lastRefresh,setLastRefresh]=useState<Date|null>(null)
  const [view,setView]=useState<'workshop'|'distributor'>('workshop')
  const [subTab,setSubTab]=useState('overview')
  const [repFilter,setRepFilter]=useState('All')

  // Date range — default current month
  const currentFY=new Date().getMonth()>=6?new Date().getFullYear()+1:new Date().getFullYear()
  const nowD=new Date()
  const defaultStart=`${nowD.getFullYear()}-${String(nowD.getMonth()+1).padStart(2,'0')}-01`
  const defaultEnd=`${nowD.getFullYear()}-${String(nowD.getMonth()+1).padStart(2,'0')}-${new Date(nowD.getFullYear(),nowD.getMonth()+1,0).getDate()}`
  const [customStart,setCustomStart]=useState(defaultStart)
  const [customEnd,setCustomEnd]=useState(defaultEnd)
  const [isCustomRange,setIsCustomRange]=useState(true)
  const [fyYear,setFyYear]=useState(currentFY)
  const activeStart=isCustomRange?customStart:`${fyYear-1}-07-01`
  const activeEnd=isCustomRange?customEnd:`${fyYear}-06-30`
  const [activeDateParams,setActiveDateParams]=useState(`startDate=${activeStart}&endDate=${activeEnd}`)
  const [dateLoading,setDateLoading]=useState(false)

  const fyLabel=isCustomRange
    ?`${new Date(customStart+'T00:00').toLocaleDateString('en-AU',{day:'2-digit',month:'short',year:'2-digit'})} – ${new Date(customEnd+'T00:00').toLocaleDateString('en-AU',{day:'2-digit',month:'short',year:'2-digit'})}`
    :`FY${fyYear}`

  function selectFY(y:number){setFyYear(y);setIsCustomRange(false);setCustomStart(`${y-1}-07-01`);setCustomEnd(`${y}-06-30`);setDateLoading(true);setActiveDateParams(`startDate=${y-1}-07-01&endDate=${y}-06-30`)}
  function applyCustomRange(){if(customStart&&customEnd){setIsCustomRange(true);setDateLoading(true);setActiveDateParams(`startDate=${customStart}&endDate=${customEnd}`)}}

  const load=useCallback(async(isRefresh=false)=>{
    if(isRefresh)setRefreshing(true)
    try{
      const refreshParam=isRefresh?'&refresh=true':''
      const r=await fetch(`/api/sales?${activeDateParams}${refreshParam}`)
      if(r.status===401){router.push('/login');return}
      if(!r.ok){if(!isRefresh)return load(true);throw new Error('Failed to load sales data')}
      const d=await r.json()
      setData(d);setError('');setDateLoading(false);setLoading(false);setLastRefresh(new Date())
      if(isRefresh)setRefreshing(false)
    }catch(e:any){setError(e.message);setLoading(false);setDateLoading(false);if(isRefresh)setRefreshing(false)}
  },[router,activeDateParams])

  useEffect(()=>{load()},[load])

  // Derived
  const orders=data?.orders
  const dist=data?.distributors
  const quotes=data?.quotes||[]
  const filteredQuotes=repFilter==='All'?quotes:quotes.filter(q=>q.rep===repFilter)
  const totalQuotes=filteredQuotes.reduce((s,q)=>s+q.totalItems,0)
  const totalWon=filteredQuotes.reduce((s,q)=>s+(q.stats['Quote Won']?.count||0),0)
  const totalLost=filteredQuotes.reduce((s,q)=>s+(q.stats['Quote Lost']?.count||0),0)
  const totalWonVal=filteredQuotes.reduce((s,q)=>s+(q.stats['Quote Won']?.value||0),0)
  const totalPipeline=filteredQuotes.reduce((s,q)=>{let p=0;['3 Days','14 Days','On Hold','Quote On Hold','Quote Sent','Not Done'].forEach(k=>{p+=(q.stats[k]?.value||0)});return s+p},0)
  const winRate=(totalWon+totalLost)>0?Math.round((totalWon/(totalWon+totalLost))*100):0
  const monthlyArr=orders?Object.entries(orders.monthly).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>{const [y,m]=k.split('-');const d=new Date(parseInt(y),parseInt(m)-1);return{key:k,label:d.toLocaleDateString('en-AU',{month:'short',year:'2-digit'}),orders:v.orders,value:v.value}}):[]
  const maxMonthly=Math.max(...monthlyArr.map(m=>m.value),1)
  const distArr=dist?Object.entries(dist.byDistributor).sort(([,a],[,b])=>b.value-a.value).map(([name,d])=>({name,...d})):[]
  const distStatusArr=dist?Object.entries(dist.byStatus).sort(([,a],[,b])=>b.count-a.count).map(([status,d])=>({status,...d})):[]
  const distMtdArr=dist?Object.entries(dist.mtdByDist).sort(([,a],[,b])=>b.value-a.value).map(([name,d])=>({name,...d})):[]
  const maxDist=distArr[0]?.value||1

  // Sidebar nav items (linking to main portal sections)
  const sidebarNav=[
    {href:'/',label:'Overview',color:T.blue},
    {href:'/?s=jaws',label:'JAWS Wholesale',color:T.blue},
    {href:'/?s=vps',label:'VPS Workshop',color:T.teal},
    {href:'/?s=invoices',label:'Invoices',color:T.amber},
    {href:'/?s=pnl',label:'P&L — This Month',color:T.green},
    {href:'/?s=stock',label:'Stock & Inventory',color:T.purple},
    {href:'/?s=payables',label:'Payables',color:T.red},
    {href:'/?s=distributors',label:'Distributors',color:T.blue},
  ]

  return (
    <>
      <Head><title>Sales Dashboard — Just Autos</title><meta name="viewport" content="width=device-width,initial-scale=1"/><meta name="robots" content="noindex,nofollow"/></Head>
      <div style={{display:'flex',height:'100vh',overflow:'hidden',fontFamily:"'DM Sans',system-ui,sans-serif",color:T.text}}>
        <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet"/>

        {/* ═══ SIDEBAR — identical to main portal ═══ */}
        <div style={{width:220,minWidth:220,background:T.bg2,borderRight:`1px solid ${T.border}`,display:'flex',flexDirection:'column',height:'100vh',overflowY:'auto'}}>
          <div style={{padding:'20px 18px 16px',borderBottom:`1px solid ${T.border}`}}>
            <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:4}}>
              <div style={{width:30,height:30,borderRadius:8,background:T.blue,display:'flex',alignItems:'center',justifyContent:'center',fontSize:13,fontWeight:600,color:'#fff'}}>JA</div>
              <div style={{fontSize:14,fontWeight:600,color:T.text}}>Just Autos</div>
            </div>
            <div style={{fontSize:11,color:T.text3,marginLeft:40}}>Management Portal</div>
          </div>
          <div style={{padding:'14px 10px 4px',flex:1}}>
            <div style={{fontSize:9,fontWeight:600,color:T.text3,textTransform:'uppercase',letterSpacing:'0.1em',padding:'0 8px',marginBottom:6}}>Navigation</div>

            {/* Sales Dashboard — active */}
            <a href="/sales" style={{display:'flex',alignItems:'center',gap:9,padding:'8px 10px',borderRadius:7,fontSize:13,marginBottom:4,background:'rgba(167,139,250,0.15)',color:T.purple,textDecoration:'none',border:`1px solid rgba(167,139,250,0.3)`}}>
              <div style={{width:7,height:7,borderRadius:'50%',background:T.purple,flexShrink:0}}/>
              <span style={{flex:1}}>Sales Dashboard</span>
              <span style={{fontSize:9,fontFamily:'monospace',background:T.purple,color:'#fff',padding:'1px 5px',borderRadius:3}}>LIVE</span>
            </a>

            {/* Distributor Report link */}
            <a href="/distributors" style={{display:'flex',alignItems:'center',gap:9,padding:'8px 10px',borderRadius:7,fontSize:13,marginBottom:4,background:'rgba(79,142,247,0.1)',color:T.blue,textDecoration:'none',border:`1px solid rgba(79,142,247,0.2)`}}>
              <div style={{width:7,height:7,borderRadius:'50%',background:T.blue,flexShrink:0}}/>
              <span style={{flex:1}}>Distributor Report</span>
              <span style={{fontSize:9,fontFamily:'monospace',background:T.blue,color:'#fff',padding:'1px 5px',borderRadius:3}}>PBI</span>
            </a>

            {/* Main portal nav items */}
            {sidebarNav.map(item=>(
              <a key={item.label} href={item.href}
                style={{display:'flex',alignItems:'center',gap:9,padding:'8px 10px',borderRadius:7,cursor:'pointer',fontSize:13,marginBottom:1,
                  background:'transparent',color:T.text2,textDecoration:'none'}}>
                <div style={{width:7,height:7,borderRadius:'50%',background:item.color,flexShrink:0}}/>
                <span style={{flex:1}}>{item.label}</span>
              </a>
            ))}
          </div>
          <div style={{padding:'12px 14px',borderTop:`1px solid ${T.border}`}}>
            <div style={{fontSize:10,color:T.text3,marginBottom:5}}>{lastRefresh?`Updated ${lastRefresh.toLocaleTimeString('en-AU',{hour:'2-digit',minute:'2-digit'})}`:'Loading…'}</div>
            <button onClick={()=>load(true)} disabled={refreshing}
              style={{fontSize:12,color:T.blue,background:'none',border:'none',cursor:'pointer',fontFamily:'inherit',padding:0,display:'block',marginBottom:4}}>
              {refreshing?'Refreshing…':'↻ Refresh data'}
            </button>
            <button onClick={async()=>{await fetch('/api/auth/logout',{method:'POST'});router.push('/login')}}
              style={{fontSize:12,color:T.text3,background:'none',border:'none',cursor:'pointer',fontFamily:'inherit',padding:0}}>Sign out →</button>
          </div>
        </div>

        {/* ═══ MAIN CONTENT ═══ */}
        <div style={{flex:1,display:'flex',flexDirection:'column',overflow:'hidden',background:T.bg}}>
          {/* Top bar */}
          <div style={{height:52,background:T.bg2,borderBottom:`1px solid ${T.border}`,display:'flex',alignItems:'center',padding:'0 20px',gap:10,flexShrink:0}}>
            <div style={{fontSize:14,fontWeight:500,color:T.text,marginRight:8}}>Sales Dashboard</div>

            {/* View toggle */}
            <div style={{display:'flex',gap:2,background:T.bg3,borderRadius:7,padding:2}}>
              {([['workshop','Workshop Sales'],['distributor','Dist. Bookings']] as [string,string][]).map(([k,l])=>
                <button key={k} onClick={()=>{setView(k as any);setSubTab('overview')}} style={{padding:'4px 14px',borderRadius:5,border:'none',fontSize:11,fontWeight:view===k?600:400,
                  background:view===k?T.accent:'transparent',color:view===k?'#fff':T.text2,cursor:'pointer',fontFamily:'inherit'}}>{l}</button>
              )}
            </div>

            <div style={{flex:1}}/>

            {/* Date controls */}
            {[currentFY-1,currentFY].map(y=>
              <button key={y} onClick={()=>selectFY(y)} style={{padding:'3px 10px',borderRadius:4,border:'1px solid',fontSize:11,fontFamily:'monospace',fontWeight:600,cursor:'pointer',
                background:fyYear===y&&!isCustomRange?T.accent:'transparent',color:fyYear===y&&!isCustomRange?'#fff':T.text2,borderColor:fyYear===y&&!isCustomRange?T.accent:T.border}}>FY{y}</button>
            )}
            <div style={{width:1,height:18,background:T.border}}/>
            <input type="date" value={customStart} onChange={e=>setCustomStart(e.target.value)} style={{padding:'3px 6px',borderRadius:4,border:`1px solid ${isCustomRange?T.accent:T.border}`,fontSize:11,fontFamily:'monospace',background:'transparent',color:T.text2,outline:'none',colorScheme:'dark'}}/>
            <span style={{fontSize:11,color:T.text3}}>→</span>
            <input type="date" value={customEnd} onChange={e=>setCustomEnd(e.target.value)} style={{padding:'3px 6px',borderRadius:4,border:`1px solid ${isCustomRange?T.accent:T.border}`,fontSize:11,fontFamily:'monospace',background:'transparent',color:T.text2,outline:'none',colorScheme:'dark'}}/>
            <button onClick={applyCustomRange} style={{padding:'3px 10px',borderRadius:4,border:`1px solid ${T.accent}`,fontSize:11,fontFamily:'monospace',fontWeight:600,cursor:'pointer',background:isCustomRange?T.accent:'transparent',color:isCustomRange?'#fff':T.accent}}>Apply</button>
            {dateLoading&&<span style={{fontSize:14,animation:'spin 1s linear infinite',color:T.blue}}>⟳</span>}
          </div>

          {/* Content area */}
          <div style={{flex:1,padding:20,overflowY:'auto',position:'relative'}}>
            <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
            {dateLoading&&<div style={{position:'absolute',inset:0,background:'rgba(13,15,18,0.75)',zIndex:10,display:'flex',alignItems:'center',justifyContent:'center',flexDirection:'column',gap:12,borderRadius:8}}>
              <div style={{fontSize:28,animation:'spin 1s linear infinite',color:T.blue}}>⟳</div>
              <div style={{color:T.text2,fontSize:13}}>Loading sales data for {fyLabel}…</div>
            </div>}

            {loading&&!dateLoading&&<div style={{display:'flex',alignItems:'center',justifyContent:'center',height:300,flexDirection:'column',gap:12}}>
              <div style={{fontSize:28,animation:'spin 1s linear infinite',color:T.text3}}>⟳</div>
              <div style={{color:T.text3}}>Loading Monday.com data…</div>
            </div>}

            {error&&<div style={{background:'rgba(240,78,78,0.1)',border:'1px solid rgba(240,78,78,0.2)',borderRadius:10,padding:20,color:T.red}}>
              <div style={{marginBottom:10}}>Error: {error}</div>
              <button onClick={()=>{setError('');setLoading(true);load()}} style={{padding:'6px 16px',borderRadius:6,border:`1px solid ${T.blue}`,background:T.blue,color:'#fff',fontSize:12,cursor:'pointer',fontFamily:'inherit'}}>Retry</button>
            </div>}

            {!loading&&!error&&data&&<>

              {/* ═══ WORKSHOP VIEW ═══ */}
              {view==='workshop'&&<>
                {/* Sub tabs + rep filter */}
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:14}}>
                  <div style={{display:'flex',gap:4}}>
                    {[{k:'overview',l:'Overview'},{k:'orders',l:'Orders'},{k:'pipeline',l:'Quote Pipeline'}].map(t=>
                      <button key={t.k} onClick={()=>setSubTab(t.k)} style={{padding:'5px 14px',borderRadius:5,border:`1px solid ${subTab===t.k?T.accent:T.border}`,fontSize:11,fontWeight:subTab===t.k?600:400,
                        background:subTab===t.k?`${T.accent}18`:'transparent',color:subTab===t.k?T.accent:T.text2,cursor:'pointer',fontFamily:'inherit'}}>{t.l}</button>
                    )}
                  </div>
                  <div style={{display:'flex',gap:4}}>
                    {['All',...quotes.map(q=>q.rep)].map(r=>
                      <button key={r} onClick={()=>setRepFilter(r)} style={{padding:'4px 10px',borderRadius:4,border:`1px solid ${repFilter===r?RC[r]||T.accent:T.border}`,fontSize:10,
                        background:repFilter===r?(RC[r]||T.accent):'transparent',color:repFilter===r?'#fff':T.text3,cursor:'pointer',fontFamily:'inherit'}}>{r}</button>
                    )}
                  </div>
                </div>

                {/* OVERVIEW */}
                {subTab==='overview'&&<>
                  <div style={{display:'grid',gridTemplateColumns:'repeat(6,1fr)',gap:8,marginBottom:12}}>
                    <KPI label="Orders (period)" value={String(orders?.totalOrders||0)} sub={fmt(orders?.totalValue||0)} subColor={T.green} accent={T.green}/>
                    <KPI label="Avg Order" value={orders&&orders.totalOrders>0?fmt(Math.round(orders.totalValue/orders.totalOrders)):'—'} sub={fyLabel} accent={T.teal}/>
                    <KPI label="Quote Pipeline" value={fmt(totalPipeline)} sub={`${totalQuotes} quotes`} subColor={T.amber} accent={T.amber}/>
                    <KPI label="Quotes Won" value={String(totalWon)} sub={`${winRate}% win · ${fmt(totalWonVal)}`} subColor={T.green} accent={T.purple}/>
                    <KPI label="Quotes Lost" value={String(totalLost)} sub={`${(100-winRate)}% loss`} subColor={T.red} accent={T.red}/>
                    <KPI label="Dist. Bookings" value={String(dist?.mtdTotal?.count||0)} sub={fmt(dist?.mtdTotal?.value||0)+' period'} subColor={T.teal} accent={T.blue}/>
                  </div>
                  <div style={{display:'grid',gridTemplateColumns:'1.4fr 1fr',gap:10,marginBottom:12}}>
                    <Card>
                      <SH>Order Revenue by Month</SH>
                      {monthlyArr.map((m,i)=><div key={m.key} style={{display:'flex',alignItems:'center',gap:8,marginBottom:5}}>
                        <span style={{fontSize:10,color:T.text2,width:42,flexShrink:0,fontFamily:'monospace'}}>{m.label}</span>
                        <div style={{flex:1,height:16,background:T.bg4,borderRadius:3,overflow:'hidden',position:'relative'}}>
                          <div style={{height:'100%',borderRadius:3,background:i===monthlyArr.length-1?T.teal:T.blue,width:`${Math.round((m.value/maxMonthly)*100)}%`,opacity:0.8}}/>
                        </div>
                        <span style={{fontSize:10,fontFamily:'monospace',color:T.text,width:42,textAlign:'right'}}>{fmt(m.value)}</span>
                        <span style={{fontSize:9,fontFamily:'monospace',color:T.text3,width:22,textAlign:'right'}}>{m.orders}</span>
                      </div>)}
                      {monthlyArr.length===0&&<div style={{color:T.text3,fontSize:12,padding:20,textAlign:'center'}}>No orders in this period</div>}
                    </Card>
                    <Card>
                      <SH>Orders by Job Type</SH>
                      {orders&&Object.entries(orders.byType).sort(([,a],[,b])=>b.value-a.value).map(([type,d])=>{
                        const pct=orders.totalOrders>0?Math.round((d.count/orders.totalOrders)*100):0
                        const color=type==='Normal Booking'?T.amber:type==='Upsell'?T.green:type==='Additional Maintenance'?T.red:T.text3
                        return <div key={type} style={{marginBottom:10}}>
                          <div style={{display:'flex',justifyContent:'space-between',marginBottom:3}}>
                            <span style={{fontSize:11,color,fontWeight:500}}>{type||'Other'}</span>
                            <span style={{fontSize:10,fontFamily:'monospace',color:T.text2}}>{d.count} · {fmt(d.value)} · {pct}%</span>
                          </div>
                          <div style={{height:5,background:T.bg4,borderRadius:3,overflow:'hidden'}}><div style={{height:'100%',borderRadius:3,background:color,width:`${pct}%`}}/></div>
                        </div>
                      })}
                    </Card>
                  </div>
                  <Card>
                    <SH>Rep Quote Performance</SH>
                    <div style={{overflowX:'auto'}}>
                      <table style={{width:'100%',borderCollapse:'collapse'}}>
                        <thead><tr>{['Rep','Quotes','Won','Lost','Win%','Won $','Pipeline','Sent','3Day','14Day','Hold','RLMNA'].map(h=>
                          <th key={h} style={{fontSize:9,color:T.text3,textTransform:'uppercase',padding:'0 6px 6px',textAlign:h==='Rep'?'left':'right',fontWeight:500,whiteSpace:'nowrap'}}>{h}</th>
                        )}</tr></thead>
                        <tbody>{filteredQuotes.map(q=>{
                          const won=q.stats['Quote Won']?.count||0,lost=q.stats['Quote Lost']?.count||0
                          const wr=(won+lost)>0?Math.round((won/(won+lost))*100):0
                          const pipe=['3 Days','14 Days','On Hold','Quote On Hold','Quote Sent'].reduce((s,k)=>s+(q.stats[k]?.value||0),0)
                          return <tr key={q.rep} style={{borderTop:`1px solid ${T.border}`}}>
                            <td style={{fontSize:11,color:RC[q.rep],padding:'6px',fontWeight:500}}>{q.full}</td>
                            <td style={{fontSize:11,fontFamily:'monospace',color:T.text,padding:'6px',textAlign:'right'}}>{q.totalItems}</td>
                            <td style={{fontSize:11,fontFamily:'monospace',color:T.green,padding:'6px',textAlign:'right',fontWeight:600}}>{won}</td>
                            <td style={{fontSize:11,fontFamily:'monospace',color:T.red,padding:'6px',textAlign:'right'}}>{lost}</td>
                            <td style={{fontSize:11,fontFamily:'monospace',color:wr>=8?T.green:T.amber,padding:'6px',textAlign:'right',fontWeight:600}}>{wr}%</td>
                            <td style={{fontSize:11,fontFamily:'monospace',color:T.green,padding:'6px',textAlign:'right'}}>{fmt(q.stats['Quote Won']?.value||0)}</td>
                            <td style={{fontSize:11,fontFamily:'monospace',color:T.amber,padding:'6px',textAlign:'right'}}>{fmt(pipe)}</td>
                            <td style={{fontSize:11,fontFamily:'monospace',color:T.text2,padding:'6px',textAlign:'right'}}>{q.stats['Quote Sent']?.count||0}</td>
                            <td style={{fontSize:11,fontFamily:'monospace',color:T.blue,padding:'6px',textAlign:'right'}}>{q.stats['3 Days']?.count||0}</td>
                            <td style={{fontSize:11,fontFamily:'monospace',color:T.amber,padding:'6px',textAlign:'right'}}>{q.stats['14 Days']?.count||0}</td>
                            <td style={{fontSize:11,fontFamily:'monospace',color:T.text3,padding:'6px',textAlign:'right'}}>{(q.stats['On Hold']?.count||0)+(q.stats['Quote On Hold']?.count||0)}</td>
                            <td style={{fontSize:11,fontFamily:'monospace',color:T.text3,padding:'6px',textAlign:'right'}}>{q.stats['RLMNA']?.count||0}</td>
                          </tr>})}</tbody>
                      </table>
                    </div>
                  </Card>
                </>}

                {/* ORDERS TAB */}
                {subTab==='orders'&&<>
                  <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:8,marginBottom:12}}>
                    <KPI label="Period Orders" value={String(orders?.totalOrders||0)} sub={fmt(orders?.totalValue||0)} subColor={T.green} accent={T.green}/>
                    <KPI label="Avg Order" value={orders&&orders.totalOrders>0?fmt(Math.round(orders.totalValue/orders.totalOrders)):'—'} sub={fyLabel} accent={T.teal}/>
                    <KPI label="Best Month" value={monthlyArr.length>0?monthlyArr.reduce((a,b)=>b.value>a.value?b:a).label:'—'} sub={monthlyArr.length>0?fmt(monthlyArr.reduce((a,b)=>b.value>a.value?b:a).value):''} subColor={T.green} accent={T.amber}/>
                    <KPI label="Months" value={String(monthlyArr.length)} sub={fyLabel} accent={T.purple}/>
                  </div>
                  <Card>
                    <SH right={<a href="https://just-autos.monday.com/boards/1838428097" target="_blank" rel="noopener noreferrer" style={{fontSize:10,color:T.blue,textDecoration:'none'}}>Open Orders Board →</a>}>Monthly Revenue</SH>
                    {monthlyArr.map((m,i)=><div key={m.key} style={{display:'flex',alignItems:'center',gap:8,marginBottom:6}}>
                      <span style={{fontSize:11,color:T.text2,width:48,flexShrink:0,fontFamily:'monospace'}}>{m.label}</span>
                      <div style={{flex:1,height:22,background:T.bg4,borderRadius:4,overflow:'hidden',position:'relative'}}>
                        <div style={{height:'100%',borderRadius:4,background:i===monthlyArr.length-1?T.teal:T.blue,width:`${Math.round((m.value/maxMonthly)*100)}%`,opacity:0.85}}/>
                        <span style={{position:'absolute',right:8,top:3,fontSize:10,fontFamily:'monospace',color:'#fff',fontWeight:500}}>{fmt(m.value)}</span>
                      </div>
                      <span style={{fontSize:10,fontFamily:'monospace',color:T.text3,width:28,textAlign:'right'}}>{m.orders}</span>
                    </div>)}
                    {monthlyArr.length===0&&<div style={{color:T.text3,fontSize:12,padding:30,textAlign:'center'}}>No orders in selected period</div>}
                  </Card>
                </>}

                {/* PIPELINE TAB */}
                {subTab==='pipeline'&&<>
                  <div style={{display:'grid',gridTemplateColumns:`repeat(${Math.min(filteredQuotes.length,5)},1fr)`,gap:8,marginBottom:12}}>
                    {filteredQuotes.map(q=>{
                      const won=q.stats['Quote Won']?.count||0,lost=q.stats['Quote Lost']?.count||0
                      const wr=(won+lost)>0?Math.round((won/(won+lost))*100):0
                      const pipe=['3 Days','14 Days','On Hold','Quote On Hold','Quote Sent'].reduce((s,k)=>s+(q.stats[k]?.value||0),0)
                      return <Card key={q.rep} style={{borderTop:`3px solid ${RC[q.rep]}`}}>
                        <div style={{fontSize:12,fontWeight:600,color:RC[q.rep],marginBottom:8}}>{q.full}</div>
                        <div style={{fontSize:20,fontWeight:600,fontFamily:'monospace',color:T.green,marginBottom:1}}>{fmt(q.stats['Quote Won']?.value||0)}</div>
                        <div style={{fontSize:10,color:T.text3,marginBottom:8}}>Won from quotes</div>
                        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:4}}>
                          <div><div style={{fontSize:9,color:T.text3}}>Quotes</div><div style={{fontSize:13,fontFamily:'monospace',color:T.text}}>{q.totalItems}</div></div>
                          <div><div style={{fontSize:9,color:T.text3}}>Win%</div><div style={{fontSize:13,fontFamily:'monospace',color:wr>=8?T.green:T.amber}}>{wr}%</div></div>
                          <div><div style={{fontSize:9,color:T.text3}}>Pipeline</div><div style={{fontSize:13,fontFamily:'monospace',color:T.amber}}>{fmt(pipe)}</div></div>
                          <div><div style={{fontSize:9,color:T.text3}}>Active</div><div style={{fontSize:13,fontFamily:'monospace',color:T.blue}}>{(q.stats['Quote Sent']?.count||0)+(q.stats['3 Days']?.count||0)+(q.stats['14 Days']?.count||0)}</div></div>
                        </div>
                        <a href={`https://just-autos.monday.com/boards/${q.id}`} target="_blank" rel="noopener noreferrer"
                          style={{display:'block',marginTop:8,padding:'4px 8px',borderRadius:4,background:T.bg3,border:`1px solid ${T.border}`,color:T.text2,textDecoration:'none',fontSize:10,textAlign:'center'}}>Open Board →</a>
                      </Card>
                    })}
                  </div>
                  <Card>
                    <SH>Quote Status Funnel</SH>
                    {STATUSES_ORDER.map(status=>{
                      const count=filteredQuotes.reduce((s,q)=>s+(q.stats[status]?.count||0),0)
                      const val=filteredQuotes.reduce((s,q)=>s+(q.stats[status]?.value||0),0)
                      const pct=totalQuotes>0?Math.round((count/totalQuotes)*100):0
                      if(count===0) return null
                      return <div key={status} style={{display:'flex',alignItems:'center',gap:8,marginBottom:5}}>
                        <span style={{fontSize:10,color:T.text2,width:100,flexShrink:0}}>{status}</span>
                        <div style={{flex:1,height:16,background:T.bg4,borderRadius:3,overflow:'hidden',position:'relative'}}>
                          <div style={{height:'100%',borderRadius:3,background:STATUS_COLORS[status]||T.text3,width:`${pct}%`,opacity:0.8}}/>
                        </div>
                        <span style={{fontSize:10,fontFamily:'monospace',color:T.text,width:36,textAlign:'right'}}>{count}</span>
                        <span style={{fontSize:10,fontFamily:'monospace',color:T.text3,width:42,textAlign:'right'}}>{fmt(val)}</span>
                        <span style={{fontSize:9,fontFamily:'monospace',color:T.text3,width:28,textAlign:'right'}}>{pct}%</span>
                      </div>
                    })}
                  </Card>
                </>}
              </>}

              {/* ═══ DISTRIBUTOR VIEW ═══ */}
              {view==='distributor'&&<>
                <div style={{display:'grid',gridTemplateColumns:'repeat(5,1fr)',gap:8,marginBottom:12}}>
                  <KPI label="Total Bookings" value={String(dist?.total?.count||0)} sub={fmt(dist?.total?.value||0)} subColor={T.blue} accent={T.blue}/>
                  <KPI label="Confirmed" value={String(dist?.byStatus?.['Confirmed']?.count||0)} sub={fmt(dist?.byStatus?.['Confirmed']?.value||0)} subColor={T.green} accent={T.green}/>
                  <KPI label="Period Bookings" value={String(dist?.mtdTotal?.count||0)} sub={fmt(dist?.mtdTotal?.value||0)} subColor={T.teal} accent={T.teal}/>
                  <KPI label="Avg Booking" value={dist&&dist.total.count>0?fmt(Math.round(dist.total.value/dist.total.count)):'—'} sub="All time" accent={T.amber}/>
                  <KPI label="Distributors" value={String(distArr.length)} sub="Active" accent={T.purple}/>
                </div>
                <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
                  <Card>
                    <SH right={<a href="https://just-autos.monday.com/boards/1923220718" target="_blank" rel="noopener noreferrer" style={{fontSize:10,color:T.blue,textDecoration:'none'}}>Open Board →</a>}>Revenue by Distributor</SH>
                    {distArr.map(d=><div key={d.name} style={{display:'flex',alignItems:'center',gap:8,marginBottom:5}}>
                      <span style={{fontSize:10,color:T.text2,width:110,flexShrink:0,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{d.name}</span>
                      <div style={{flex:1,height:14,background:T.bg4,borderRadius:3,overflow:'hidden'}}>
                        <div style={{height:'100%',borderRadius:3,background:T.blue,width:`${Math.round((d.value/maxDist)*100)}%`,opacity:0.8}}/>
                      </div>
                      <span style={{fontSize:10,fontFamily:'monospace',color:T.text,width:42,textAlign:'right'}}>{fmt(d.value)}</span>
                      <span style={{fontSize:9,fontFamily:'monospace',color:T.text3,width:20,textAlign:'right'}}>{d.count}</span>
                    </div>)}
                  </Card>
                  <div style={{display:'flex',flexDirection:'column',gap:10}}>
                    <Card>
                      <SH>Booking Status</SH>
                      {distStatusArr.map(s=><div key={s.status} style={{display:'flex',justifyContent:'space-between',padding:'4px 0',borderBottom:`1px solid ${T.border}`}}>
                        <span style={{fontSize:11,color:T.text2}}>{s.status}</span>
                        <span style={{fontSize:11,fontFamily:'monospace',color:T.text2}}>{s.count} · {fmt(s.value)}</span>
                      </div>)}
                    </Card>
                    <Card>
                      <SH>Period Bookings — {dist?.mtdTotal?.count||0} · {fmt(dist?.mtdTotal?.value||0)}</SH>
                      {distMtdArr.slice(0,10).map(d=><div key={d.name} style={{display:'flex',justifyContent:'space-between',padding:'3px 0',borderBottom:`1px solid ${T.border}`}}>
                        <span style={{fontSize:11,color:T.text2}}>{d.name}</span>
                        <span style={{fontSize:11,fontFamily:'monospace',color:T.green}}>{d.count} · {fmt(d.value)}</span>
                      </div>)}
                      {distMtdArr.length===0&&<div style={{color:T.text3,fontSize:12,padding:10,textAlign:'center'}}>No bookings in period</div>}
                    </Card>
                  </div>
                </div>
              </>}
            </>}
          </div>
        </div>
      </div>
    </>
  )
}

export async function getServerSideProps(context:any){
  const cookie=context.req.cookies['ja_portal_auth']
  const PORTAL_PASSWORD=process.env.PORTAL_PASSWORD||'justautos2026'
  if(!cookie) return {redirect:{destination:'/login',permanent:false}}
  try{const decoded=Buffer.from(cookie,'base64').toString('utf8');if(decoded!==PORTAL_PASSWORD) return {redirect:{destination:'/login',permanent:false}}}catch{return {redirect:{destination:'/login',permanent:false}}}
  return {props:{}}
}
