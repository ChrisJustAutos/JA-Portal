// pages/sales.tsx — Just Autos Sales Dashboard (portal-integrated)
import { useEffect, useState, useCallback } from 'react'
import Head from 'next/head'
import { useRouter } from 'next/router'
import PortalSidebar from '../lib/PortalSidebar'
import { requirePageAuth } from '../lib/authServer'

interface PortalUserSSR { id: string; email: string; displayName: string | null; role: 'admin'|'manager'|'sales'|'accountant'|'viewer' }

const T={bg:'#0d0f12',bg2:'#131519',bg3:'#1a1d23',bg4:'#21252d',border:'rgba(255,255,255,0.07)',border2:'rgba(255,255,255,0.12)',text:'#e8eaf0',text2:'#8b90a0',text3:'#545968',blue:'#4f8ef7',teal:'#2dd4bf',green:'#34c77b',amber:'#f5a623',red:'#f04e4e',purple:'#a78bfa',pink:'#ff5ac4',accent:'#4f8ef7'}
const fmt=(n:number)=>n>=1e6?'$'+(n/1e6).toFixed(2)+'M':n>=1000?'$'+Math.round(n/1000)+'k':'$'+Math.round(n)
const fmtFull=(n:number)=>'$'+Number(n||0).toLocaleString('en-AU',{minimumFractionDigits:2,maximumFractionDigits:2})
const fmtDate=(d:string)=>d?new Date(d+'T00:00').toLocaleDateString('en-AU',{day:'2-digit',month:'short'}):''
const RC:Record<string,string>={Tyronne:T.blue,James:T.teal,Dom:T.amber,Kaleb:T.purple,Graham:T.pink}
const SC:Record<string,string>={'Not Done':T.text3,'Quote Sent':'#037f4c','3 Days':T.blue,'14 Days':T.amber,'Follow Up Done':T.pink,'On Hold':'#ffcb00','Quote On Hold':'#ffcb00','RLMNA':'#007eb5','Quote Not Issued':'#ff6d3b','Quote Won':T.green,'Quote Lost':T.red}
const STATUSES_ORDER=['Not Done','Quote Sent','3 Days','14 Days','Follow Up Done','On Hold','Quote On Hold','RLMNA','Quote Not Issued','Quote Won','Quote Lost']

function Tag({children,color}:{children:React.ReactNode;color:string}){return <span style={{fontSize:10,fontFamily:'monospace',padding:'2px 8px',borderRadius:4,background:`${color}20`,color,border:`1px solid ${color}40`}}>{children}</span>}
function KPI({label,value,sub,accent,subColor}:{label:string;value:string;sub?:string;accent?:string;subColor?:string}){
  return <div style={{background:T.bg2,border:`1px solid ${T.border}`,borderRadius:12,padding:'18px 20px',borderTop:accent?`3px solid ${accent}`:undefined}}>
    <div style={{fontSize:11,color:T.text3,textTransform:'uppercase',letterSpacing:'0.07em',marginBottom:10}}>{label}</div>
    <div style={{fontSize:24,fontWeight:600,fontFamily:'monospace',letterSpacing:'-0.03em',marginBottom:4,color:T.text}}>{value}</div>
    {sub&&<div style={{fontSize:12,color:subColor||T.text3}}>{sub}</div>}
  </div>}
function Card({children,style}:{children:React.ReactNode;style?:React.CSSProperties}){return <div style={{background:T.bg2,border:`1px solid ${T.border}`,borderRadius:12,padding:20,...style}}>{children}</div>}
function SH({children,right}:{children:React.ReactNode;right?:React.ReactNode}){return <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16}}><div style={{fontSize:12,fontWeight:600,color:T.text3,textTransform:'uppercase',letterSpacing:'0.08em'}}>{children}</div>{right&&<div>{right}</div>}</div>}

interface Lead { id:string;name:string;url:string;rep:string;repFull:string;phone:string;status:string;quoteValue:string;date:string;qualifyingStage:string;contactAttempts:string }
interface SalesData {
  fetchedAt:string;period:{startDate:string;endDate:string}
  orders:{monthly:Record<string,{orders:number;value:number}>;byType:Record<string,{count:number;value:number}>;totalOrders:number;totalValue:number;tracedOrders?:number}|null
  distributors:{byDistributor:Record<string,{count:number;value:number}>;byStatus:Record<string,{count:number;value:number}>;byPerson:Record<string,{count:number;value:number}>;mtdByDist:Record<string,{count:number;value:number}>;mtdByPerson:Record<string,{count:number;value:number}>;total:{count:number;value:number};mtdTotal:{count:number;value:number}}|null
  quotes:{rep:string;full:string;id:number;stats:Record<string,{count:number;value:number}>;totalItems:number}[]
  activeLeads:Lead[]
}

export default function SalesDashboard({ user }: { user: PortalUserSSR }) {
  const router=useRouter()
  const [data,setData]=useState<SalesData|null>(null)
  const [loading,setLoading]=useState(true)
  const [refreshing,setRefreshing]=useState(false)
  const [error,setError]=useState('')
  const [lastRefresh,setLastRefresh]=useState<Date|null>(null)
  const [view,setView]=useState<'workshop'|'distributor'>('workshop')
  const [subTab,setSubTab]=useState('overview')
  const [repFilter,setRepFilter]=useState('All')
  const [distPersonFilter,setDistPersonFilter]=useState('All')

  const currentFY=new Date().getMonth()>=6?new Date().getFullYear()+1:new Date().getFullYear()
  const nowD=new Date()
  const defaultStart=`${nowD.getFullYear()}-${String(nowD.getMonth()+1).padStart(2,'0')}-01`
  const defaultEnd=`${nowD.getFullYear()}-${String(nowD.getMonth()+1).padStart(2,'0')}-${new Date(nowD.getFullYear(),nowD.getMonth()+1,0).getDate()}`
  const [customStart,setCustomStart]=useState(defaultStart)
  const [customEnd,setCustomEnd]=useState(defaultEnd)
  const [isCustomRange,setIsCustomRange]=useState(true)
  const [fyYear,setFyYear]=useState(currentFY)
  const [activeDateParams,setActiveDateParams]=useState(`startDate=${defaultStart}&endDate=${defaultEnd}`)
  const [dateLoading,setDateLoading]=useState(false)

  const fyLabel=isCustomRange?`${new Date(customStart+'T00:00').toLocaleDateString('en-AU',{day:'2-digit',month:'short',year:'2-digit'})} – ${new Date(customEnd+'T00:00').toLocaleDateString('en-AU',{day:'2-digit',month:'short',year:'2-digit'})}`:`FY${fyYear}`
  function selectFY(y:number){setFyYear(y);setIsCustomRange(false);setCustomStart(`${y-1}-07-01`);setCustomEnd(`${y}-06-30`);setDateLoading(true);setActiveDateParams(`startDate=${y-1}-07-01&endDate=${y}-06-30`)}
  function applyCustomRange(){if(customStart&&customEnd){setIsCustomRange(true);setDateLoading(true);setActiveDateParams(`startDate=${customStart}&endDate=${customEnd}`)}}

  const load=useCallback(async(isRefresh=false)=>{
    if(isRefresh)setRefreshing(true)
    try{
      const rp=isRefresh?'&refresh=true':''
      const r=await fetch(`/api/sales?${activeDateParams}${rp}`)
      if(r.status===401){router.push('/login');return}
      if(!r.ok)throw new Error('Failed to load sales data')
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
  const allLeads=data?.activeLeads||[]
  const fq=repFilter==='All'?quotes:quotes.filter(q=>q.rep===repFilter)
  const filteredLeads=repFilter==='All'?allLeads:allLeads.filter(l=>l.rep===repFilter)
  const tq=fq.reduce((s,q)=>s+q.totalItems,0)
  const tWon=fq.reduce((s,q)=>s+(q.stats['Quote Won']?.count||0),0)
  const tLost=fq.reduce((s,q)=>s+(q.stats['Quote Lost']?.count||0),0)
  const tWonVal=fq.reduce((s,q)=>s+(q.stats['Quote Won']?.value||0),0)
  const tPipe=fq.reduce((s,q)=>{let p=0;['3 Days','14 Days','On Hold','Quote On Hold','Quote Sent','Not Done'].forEach(k=>{p+=(q.stats[k]?.value||0)});return s+p},0)
  const wr=(tWon+tLost)>0?Math.round((tWon/(tWon+tLost))*100):0
  // Count of quotes still "in pipeline" (neither won nor lost nor RLMNA)
  const PIPELINE_STATUSES=['3 Days','14 Days','On Hold','Quote On Hold','Quote Sent','Not Done','Follow Up Done','Quote Not Issued'] as const
  const tPipeCount=fq.reduce((s,q)=>s+PIPELINE_STATUSES.reduce((ss,k)=>ss+(q.stats[k]?.count||0),0),0)
  // Traceability — using the backfill-populated Connect column on Orders.
  // We only have a total count (per-rep attribution was dropped to keep the
  // Monday GraphQL query under the complexity ceiling).
  const totalTraced=orders?.tracedOrders||0
  const totalOrdersCount=orders?.totalOrders||0
  const tracedPct=totalOrdersCount>0?Math.round((totalTraced/totalOrdersCount)*100):0
  const mArr=orders?Object.entries(orders.monthly).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>{const [y,m]=k.split('-');return{key:k,label:new Date(parseInt(y),parseInt(m)-1).toLocaleDateString('en-AU',{month:'short',year:'2-digit'}),orders:v.orders,value:v.value}}):[]
  const maxM=Math.max(...mArr.map(m=>m.value),1)
  const distPeople=dist?Object.keys(dist.byPerson).filter(p=>p!=='Unassigned').sort():[]
  const distArr=dist?Object.entries(dist.byDistributor).sort(([,a],[,b])=>b.value-a.value).map(([name,d])=>({name,...d})):[]
  const distStatusArr=dist?Object.entries(dist.byStatus).sort(([,a],[,b])=>b.count-a.count).map(([status,d])=>({status,...d})):[]
  const distMtdArr=dist?Object.entries(dist.mtdByDist).sort(([,a],[,b])=>b.value-a.value).map(([name,d])=>({name,...d})):[]
  const maxDist=distArr[0]?.value||1

  // Active leads stats
  const leadsByStatus:Record<string,number>={}
  filteredLeads.forEach(l=>{leadsByStatus[l.status]=(leadsByStatus[l.status]||0)+1})
  const totalLeadValue=filteredLeads.reduce((s,l)=>s+(parseFloat(l.quoteValue)||0),0)

  return (<>
    <Head><title>Leads/Orders — Just Autos</title><meta name="viewport" content="width=device-width,initial-scale=1"/><meta name="robots" content="noindex,nofollow"/></Head>
    <div style={{display:'flex',height:'100vh',overflow:'hidden',fontFamily:"'DM Sans',system-ui,sans-serif",color:T.text}}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet"/>

      {/* SHARED SIDEBAR */}
      <PortalSidebar
        activeId="leads"
        lastRefresh={lastRefresh}
        onRefresh={()=>load(true)}
        refreshing={refreshing}
        currentUserRole={user.role}
        currentUserName={user.displayName}
        currentUserEmail={user.email}
      />

      {/* MAIN */}
      <div style={{flex:1,display:'flex',flexDirection:'column',overflow:'hidden',background:T.bg}}>
        {/* Top bar */}
        <div style={{height:52,background:T.bg2,borderBottom:`1px solid ${T.border}`,display:'flex',alignItems:'center',padding:'0 20px',gap:10,flexShrink:0}}>
          <div style={{fontSize:14,fontWeight:500,color:T.text,marginRight:8}}>Leads/Orders</div>
          <div style={{display:'flex',gap:2,background:T.bg3,borderRadius:7,padding:2}}>
            {([['workshop','Workshop Sales'],['distributor','Dist. Bookings']] as [string,string][]).map(([k,l])=>
              <button key={k} onClick={()=>{setView(k as any);setSubTab('overview')}} style={{padding:'4px 14px',borderRadius:5,border:'none',fontSize:11,fontWeight:view===k?600:400,background:view===k?T.accent:'transparent',color:view===k?'#fff':T.text2,cursor:'pointer',fontFamily:'inherit'}}>{l}</button>
            )}
          </div>
          <div style={{flex:1}}/>
          {[currentFY-1,currentFY].map(y=><button key={y} onClick={()=>selectFY(y)} style={{padding:'3px 10px',borderRadius:4,border:'1px solid',fontSize:11,fontFamily:'monospace',fontWeight:600,cursor:'pointer',background:fyYear===y&&!isCustomRange?T.accent:'transparent',color:fyYear===y&&!isCustomRange?'#fff':T.text2,borderColor:fyYear===y&&!isCustomRange?T.accent:T.border}}>FY{y}</button>)}
          <div style={{width:1,height:18,background:T.border}}/>
          <span title="Filters by the date each item was created in Monday (Creation Log), not by the scheduled/booking date." style={{fontSize:10,color:T.text3,textTransform:'uppercase',letterSpacing:'0.04em',fontWeight:500,cursor:'help'}}>Created</span>
          <input type="date" value={customStart} onChange={e=>setCustomStart(e.target.value)} style={{padding:'3px 6px',borderRadius:4,border:`1px solid ${isCustomRange?T.accent:T.border}`,fontSize:11,fontFamily:'monospace',background:'transparent',color:T.text2,outline:'none',colorScheme:'dark'}}/>
          <span style={{fontSize:11,color:T.text3}}>→</span>
          <input type="date" value={customEnd} onChange={e=>setCustomEnd(e.target.value)} style={{padding:'3px 6px',borderRadius:4,border:`1px solid ${isCustomRange?T.accent:T.border}`,fontSize:11,fontFamily:'monospace',background:'transparent',color:T.text2,outline:'none',colorScheme:'dark'}}/>
          <button onClick={applyCustomRange} style={{padding:'3px 10px',borderRadius:4,border:`1px solid ${T.accent}`,fontSize:11,fontFamily:'monospace',fontWeight:600,cursor:'pointer',background:isCustomRange?T.accent:'transparent',color:isCustomRange?'#fff':T.accent}}>Apply</button>
          {dateLoading&&<span style={{fontSize:14,animation:'spin 1s linear infinite',color:T.blue}}>⟳</span>}
        </div>

        {/* Content */}
        <div style={{flex:1,padding:20,overflowY:'auto',position:'relative'}}>
          <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
          {dateLoading&&<div style={{position:'absolute',inset:0,background:'rgba(13,15,18,0.75)',zIndex:10,display:'flex',alignItems:'center',justifyContent:'center',flexDirection:'column',gap:12,borderRadius:8}}>
            <div style={{fontSize:28,animation:'spin 1s linear infinite',color:T.blue}}>⟳</div><div style={{color:T.text2,fontSize:13}}>Loading sales data for {fyLabel}…</div>
          </div>}
          {loading&&!dateLoading&&<div style={{display:'flex',alignItems:'center',justifyContent:'center',height:300,flexDirection:'column',gap:12}}>
            <div style={{fontSize:28,animation:'spin 1s linear infinite',color:T.text3}}>⟳</div><div style={{color:T.text3}}>Loading Monday.com data…</div>
          </div>}
          {error&&<div style={{background:'rgba(240,78,78,0.1)',border:'1px solid rgba(240,78,78,0.2)',borderRadius:10,padding:20,color:T.red}}>
            <div style={{marginBottom:10}}>Error: {error}</div>
            <button onClick={()=>{setError('');setLoading(true);load()}} style={{padding:'6px 16px',borderRadius:6,border:`1px solid ${T.blue}`,background:T.blue,color:'#fff',fontSize:12,cursor:'pointer',fontFamily:'inherit'}}>Retry</button>
          </div>}

          {!loading&&!error&&data&&<>

            {/* ═══ WORKSHOP ═══ */}
            {view==='workshop'&&<>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16}}>
                <div style={{display:'flex',gap:6}}>
                  {[{k:'overview',l:'Overview'},{k:'orders',l:'Orders'},{k:'pipeline',l:'Quote Pipeline'},{k:'leads',l:'Active Leads'}].map(t=>
                    <button key={t.k} onClick={()=>setSubTab(t.k)} style={{padding:'6px 18px',borderRadius:6,border:`1px solid ${subTab===t.k?T.accent:T.border}`,fontSize:12,fontWeight:subTab===t.k?600:400,background:subTab===t.k?`${T.accent}18`:'transparent',color:subTab===t.k?T.accent:T.text2,cursor:'pointer',fontFamily:'inherit'}}>
                      {t.l}{t.k==='leads'&&allLeads.length>0?` (${repFilter==='All'?allLeads.length:filteredLeads.length})`:''}</button>
                  )}
                </div>
                <div style={{display:'flex',gap:4}}>
                  {['All',...quotes.map(q=>q.rep)].map(r=><button key={r} onClick={()=>setRepFilter(r)} style={{padding:'5px 12px',borderRadius:5,border:`1px solid ${repFilter===r?RC[r]||T.accent:T.border}`,fontSize:11,background:repFilter===r?(RC[r]||T.accent):'transparent',color:repFilter===r?'#fff':T.text3,cursor:'pointer',fontFamily:'inherit'}}>{r}</button>)}
                </div>
              </div>

              {/* OVERVIEW */}
              {subTab==='overview'&&<>
                <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(150px,1fr))',gap:12,marginBottom:16}}>
                  <KPI label="Orders (period)" value={String(orders?.totalOrders||0)} sub={fmt(orders?.totalValue||0)} subColor={T.green} accent={T.green}/>
                  <KPI label="Orders Traced" value={`${tracedPct}%`} sub={`${totalTraced} of ${totalOrdersCount} linked to quote`} subColor={tracedPct>=50?T.green:T.amber} accent={tracedPct>=50?T.green:T.amber}/>
                  <KPI label="Quote Pipeline" value={String(tPipeCount)} sub={`${fmt(tPipe)} open`} subColor={T.amber} accent={T.amber}/>
                  <KPI label="Quotes Won" value={String(tWon)} sub={`${wr}% win · ${fmt(tWonVal)}`} subColor={T.green} accent={T.purple}/>
                  <KPI label="Quotes Lost" value={String(tLost)} sub={tWon+tLost>0?`${100-wr}% lost`:'—'} subColor={T.red} accent={T.red}/>
                  <KPI label="Active Leads" value={String(filteredLeads.length)} sub={totalLeadValue>0?fmt(totalLeadValue)+' pipeline':'In Quote-Lead group'} subColor={T.blue} accent={T.blue}/>
                  <KPI label="Dist. Bookings" value={String(dist?.mtdTotal?.count||0)} sub={fmt(dist?.mtdTotal?.value||0)+' period'} subColor={T.teal} accent={T.pink}/>
                </div>
                <div style={{display:'grid',gridTemplateColumns:'1.4fr 1fr',gap:14,marginBottom:16}}>
                  <Card><SH>Order Revenue by Month</SH>
                    {mArr.map((m,i)=><div key={m.key} style={{display:'flex',alignItems:'center',gap:10,marginBottom:8}}>
                      <span style={{fontSize:12,color:T.text2,width:48,flexShrink:0,fontFamily:'monospace'}}>{m.label}</span>
                      <div style={{flex:1,height:22,background:T.bg4,borderRadius:4,overflow:'hidden',position:'relative'}}><div style={{height:'100%',borderRadius:4,background:i===mArr.length-1?T.teal:T.blue,width:`${Math.round((m.value/maxM)*100)}%`,opacity:0.85}}/></div>
                      <span style={{fontSize:12,fontFamily:'monospace',color:T.text,width:50,textAlign:'right'}}>{fmt(m.value)}</span>
                      <span style={{fontSize:11,fontFamily:'monospace',color:T.text3,width:28,textAlign:'right'}}>{m.orders}</span>
                    </div>)}
                    {mArr.length===0&&<div style={{color:T.text3,fontSize:13,padding:24,textAlign:'center'}}>No orders in this period</div>}
                  </Card>
                  <Card><SH>Orders by Job Type</SH>
                    {orders&&Object.entries(orders.byType).sort(([,a],[,b])=>b.value-a.value).map(([type,d])=>{
                      const pct=orders.totalOrders>0?Math.round((d.count/orders.totalOrders)*100):0
                      const color=type==='Normal Booking'?T.amber:type==='Upsell'?T.green:type==='Additional Maintenance'?T.red:T.text3
                      return <div key={type} style={{marginBottom:14}}>
                        <div style={{display:'flex',justifyContent:'space-between',marginBottom:4}}><span style={{fontSize:13,color,fontWeight:500}}>{type||'Other'}</span><span style={{fontSize:12,fontFamily:'monospace',color:T.text2}}>{d.count} · {fmt(d.value)} · {pct}%</span></div>
                        <div style={{height:8,background:T.bg4,borderRadius:4,overflow:'hidden'}}><div style={{height:'100%',borderRadius:4,background:color,width:`${pct}%`}}/></div>
                      </div>})}
                  </Card>
                </div>
                <Card><SH>Rep Quote Performance</SH>
                  <div style={{overflowX:'auto'}}><table style={{width:'100%',borderCollapse:'collapse'}}>
                    <thead><tr>{['Rep','Quotes','Won','Lost','Win%','Won $','Pipeline','Sent','3Day','14Day','Hold','RLMNA','Leads'].map(h=><th key={h} style={{fontSize:10,color:T.text3,textTransform:'uppercase',padding:'0 8px 10px',textAlign:h==='Rep'?'left':'right',fontWeight:500,whiteSpace:'nowrap'}}>{h}</th>)}</tr></thead>
                    <tbody>{fq.map(q=>{const w=q.stats['Quote Won']?.count||0,l=q.stats['Quote Lost']?.count||0,r=(w+l)>0?Math.round((w/(w+l))*100):0;const pp=['3 Days','14 Days','On Hold','Quote On Hold','Quote Sent'].reduce((s,k)=>s+(q.stats[k]?.value||0),0);const lc=allLeads.filter(ld=>ld.rep===q.rep).length;return(
                      <tr key={q.rep} style={{borderTop:`1px solid ${T.border}`}}>
                        <td style={{fontSize:13,color:RC[q.rep],padding:'10px 8px',fontWeight:500}}>{q.full}</td>
                        <td style={{fontSize:13,fontFamily:'monospace',color:T.text,padding:'10px 8px',textAlign:'right'}}>{q.totalItems}</td>
                        <td style={{fontSize:13,fontFamily:'monospace',color:T.green,padding:'10px 8px',textAlign:'right',fontWeight:600}}>{w}</td>
                        <td style={{fontSize:13,fontFamily:'monospace',color:T.red,padding:'10px 8px',textAlign:'right'}}>{l}</td>
                        <td style={{fontSize:13,fontFamily:'monospace',color:r>=8?T.green:T.amber,padding:'10px 8px',textAlign:'right',fontWeight:600}}>{r}%</td>
                        <td style={{fontSize:13,fontFamily:'monospace',color:T.green,padding:'10px 8px',textAlign:'right'}}>{fmt(q.stats['Quote Won']?.value||0)}</td>
                        <td style={{fontSize:13,fontFamily:'monospace',color:T.amber,padding:'10px 8px',textAlign:'right'}}>{fmt(pp)}</td>
                        <td style={{fontSize:12,fontFamily:'monospace',color:T.text2,padding:'10px 8px',textAlign:'right'}}>{q.stats['Quote Sent']?.count||0}</td>
                        <td style={{fontSize:12,fontFamily:'monospace',color:T.blue,padding:'10px 8px',textAlign:'right'}}>{q.stats['3 Days']?.count||0}</td>
                        <td style={{fontSize:12,fontFamily:'monospace',color:T.amber,padding:'10px 8px',textAlign:'right'}}>{q.stats['14 Days']?.count||0}</td>
                        <td style={{fontSize:12,fontFamily:'monospace',color:T.text3,padding:'10px 8px',textAlign:'right'}}>{(q.stats['On Hold']?.count||0)+(q.stats['Quote On Hold']?.count||0)}</td>
                        <td style={{fontSize:12,fontFamily:'monospace',color:T.text3,padding:'10px 8px',textAlign:'right'}}>{q.stats['RLMNA']?.count||0}</td>
                        <td style={{fontSize:12,fontFamily:'monospace',color:T.blue,padding:'10px 8px',textAlign:'right',fontWeight:600}}>{lc}</td>
                      </tr>)})}</tbody>
                  </table></div>
                </Card>
              </>}

              {/* ORDERS */}
              {subTab==='orders'&&<>
                <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:12,marginBottom:16}}>
                  <KPI label="Period Orders" value={String(orders?.totalOrders||0)} sub={fmt(orders?.totalValue||0)} subColor={T.green} accent={T.green}/>
                  <KPI label="Avg Order" value={orders&&orders.totalOrders>0?fmt(Math.round(orders.totalValue/orders.totalOrders)):'—'} sub={fyLabel} accent={T.teal}/>
                  <KPI label="Best Month" value={mArr.length>0?mArr.reduce((a,b)=>b.value>a.value?b:a).label:'—'} sub={mArr.length>0?fmt(mArr.reduce((a,b)=>b.value>a.value?b:a).value):''} subColor={T.green} accent={T.amber}/>
                  <KPI label="Months" value={String(mArr.length)} sub={fyLabel} accent={T.purple}/>
                </div>
                <Card><SH right={<a href="https://just-autos.monday.com/boards/1838428097" target="_blank" rel="noopener noreferrer" style={{fontSize:11,color:T.blue,textDecoration:'none'}}>Open Orders Board →</a>}>Monthly Revenue</SH>
                  {mArr.map((m,i)=><div key={m.key} style={{display:'flex',alignItems:'center',gap:10,marginBottom:8}}>
                    <span style={{fontSize:12,color:T.text2,width:52,flexShrink:0,fontFamily:'monospace'}}>{m.label}</span>
                    <div style={{flex:1,height:28,background:T.bg4,borderRadius:5,overflow:'hidden',position:'relative'}}><div style={{height:'100%',borderRadius:5,background:i===mArr.length-1?T.teal:T.blue,width:`${Math.round((m.value/maxM)*100)}%`,opacity:0.85}}/><span style={{position:'absolute',right:10,top:5,fontSize:12,fontFamily:'monospace',color:'#fff',fontWeight:500}}>{fmt(m.value)}</span></div>
                    <span style={{fontSize:11,fontFamily:'monospace',color:T.text3,width:30,textAlign:'right'}}>{m.orders}</span>
                  </div>)}
                  {mArr.length===0&&<div style={{color:T.text3,fontSize:13,padding:30,textAlign:'center'}}>No orders in selected period</div>}
                </Card>
              </>}

              {/* PIPELINE */}
              {subTab==='pipeline'&&<>
                <div style={{display:'grid',gridTemplateColumns:`repeat(${Math.min(fq.length,5)},1fr)`,gap:12,marginBottom:16}}>
                  {fq.map(q=>{const w=q.stats['Quote Won']?.count||0,l=q.stats['Quote Lost']?.count||0,r=(w+l)>0?Math.round((w/(w+l))*100):0;const pp=['3 Days','14 Days','On Hold','Quote On Hold','Quote Sent'].reduce((s,k)=>s+(q.stats[k]?.value||0),0);return(
                    <Card key={q.rep} style={{borderTop:`3px solid ${RC[q.rep]}`,padding:18}}>
                      <div style={{fontSize:14,fontWeight:600,color:RC[q.rep],marginBottom:10}}>{q.full}</div>
                      <div style={{fontSize:24,fontWeight:600,fontFamily:'monospace',color:T.green,marginBottom:2}}>{fmt(q.stats['Quote Won']?.value||0)}</div>
                      <div style={{fontSize:11,color:T.text3,marginBottom:10}}>Won from quotes</div>
                      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
                        <div><div style={{fontSize:10,color:T.text3}}>Quotes</div><div style={{fontSize:16,fontFamily:'monospace',color:T.text}}>{q.totalItems}</div></div>
                        <div><div style={{fontSize:10,color:T.text3}}>Win%</div><div style={{fontSize:16,fontFamily:'monospace',color:r>=8?T.green:T.amber}}>{r}%</div></div>
                        <div><div style={{fontSize:10,color:T.text3}}>Pipeline</div><div style={{fontSize:16,fontFamily:'monospace',color:T.amber}}>{fmt(pp)}</div></div>
                        <div><div style={{fontSize:10,color:T.text3}}>Active</div><div style={{fontSize:16,fontFamily:'monospace',color:T.blue}}>{(q.stats['Quote Sent']?.count||0)+(q.stats['3 Days']?.count||0)+(q.stats['14 Days']?.count||0)}</div></div>
                      </div>
                      <a href={`https://just-autos.monday.com/boards/${q.id}`} target="_blank" rel="noopener noreferrer" style={{display:'block',marginTop:10,padding:'6px 10px',borderRadius:5,background:T.bg3,border:`1px solid ${T.border}`,color:T.text2,textDecoration:'none',fontSize:11,textAlign:'center'}}>Open Board →</a>
                    </Card>)})}
                </div>
                <Card><SH>Quote Status Funnel</SH>
                  {STATUSES_ORDER.map(status=>{const count=fq.reduce((s,q)=>s+(q.stats[status]?.count||0),0);const val=fq.reduce((s,q)=>s+(q.stats[status]?.value||0),0);const pct=tq>0?Math.round((count/tq)*100):0;if(count===0)return null;return(
                    <div key={status} style={{display:'flex',alignItems:'center',gap:10,marginBottom:8}}>
                      <span style={{fontSize:12,color:T.text2,width:110,flexShrink:0}}>{status}</span>
                      <div style={{flex:1,height:22,background:T.bg4,borderRadius:4,overflow:'hidden',position:'relative'}}><div style={{height:'100%',borderRadius:4,background:SC[status]||T.text3,width:`${pct}%`,opacity:0.8}}/></div>
                      <span style={{fontSize:12,fontFamily:'monospace',color:T.text,width:40,textAlign:'right'}}>{count}</span>
                      <span style={{fontSize:11,fontFamily:'monospace',color:T.text3,width:48,textAlign:'right'}}>{fmt(val)}</span>
                      <span style={{fontSize:11,fontFamily:'monospace',color:T.text3,width:32,textAlign:'right'}}>{pct}%</span>
                    </div>)})}
                </Card>
              </>}

              {/* ═══ ACTIVE LEADS ═══ */}
              {subTab==='leads'&&<>
                <div style={{display:'grid',gridTemplateColumns:'repeat(5,1fr)',gap:12,marginBottom:16}}>
                  <KPI label="Active Leads" value={String(filteredLeads.length)} sub={repFilter==='All'?'All reps':repFilter} accent={T.blue}/>
                  <KPI label="Pipeline Value" value={totalLeadValue>0?fmt(totalLeadValue):'—'} sub="Quoted value" subColor={T.green} accent={T.green}/>
                  <KPI label="Avg Quote" value={filteredLeads.length>0&&totalLeadValue>0?fmt(Math.round(totalLeadValue/filteredLeads.filter(l=>parseFloat(l.quoteValue)>0).length)):'—'} sub="Per lead" accent={T.teal}/>
                  <KPI label="With Value" value={String(filteredLeads.filter(l=>parseFloat(l.quoteValue)>0).length)} sub={`${filteredLeads.length>0?Math.round((filteredLeads.filter(l=>parseFloat(l.quoteValue)>0).length/filteredLeads.length)*100):0}% quoted`} subColor={T.amber} accent={T.amber}/>
                  <KPI label="Reps Active" value={String(new Set(filteredLeads.map(l=>l.rep)).size)} sub="With leads" accent={T.purple}/>
                </div>

                {/* Leads by status breakdown */}
                <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:14,marginBottom:16}}>
                  <Card><SH>Leads by Status</SH>
                    {Object.entries(leadsByStatus).sort(([,a],[,b])=>b-a).map(([status,count])=>{
                      const pct=filteredLeads.length>0?Math.round((count/filteredLeads.length)*100):0
                      return <div key={status} style={{display:'flex',alignItems:'center',gap:10,marginBottom:8}}>
                        <span style={{fontSize:12,color:SC[status]||T.text2,width:100,flexShrink:0}}>{status}</span>
                        <div style={{flex:1,height:18,background:T.bg4,borderRadius:4,overflow:'hidden'}}><div style={{height:'100%',borderRadius:4,background:SC[status]||T.text3,width:`${pct}%`,opacity:0.8}}/></div>
                        <span style={{fontSize:12,fontFamily:'monospace',color:T.text,width:30,textAlign:'right'}}>{count}</span>
                        <span style={{fontSize:11,fontFamily:'monospace',color:T.text3,width:30,textAlign:'right'}}>{pct}%</span>
                      </div>})}
                  </Card>
                  <Card><SH>Leads by Rep</SH>
                    {Object.entries(allLeads.reduce((acc:Record<string,{count:number;value:number}>,l)=>{if(!acc[l.rep])acc[l.rep]={count:0,value:0};acc[l.rep].count++;acc[l.rep].value+=parseFloat(l.quoteValue)||0;return acc},{})).sort(([,a],[,b])=>b.count-a.count).map(([rep,d])=>
                      <div key={rep} style={{display:'flex',justifyContent:'space-between',padding:'6px 4px',borderBottom:`1px solid ${T.border}`,cursor:'pointer',background:repFilter===rep?'rgba(79,142,247,0.08)':'transparent',borderRadius:4}} onClick={()=>setRepFilter(repFilter===rep?'All':rep)}>
                        <span style={{fontSize:13,color:RC[rep]||T.text2,fontWeight:repFilter===rep?600:400}}>{rep}</span>
                        <span style={{fontSize:12,fontFamily:'monospace',color:T.text2}}>{d.count} leads · {d.value>0?fmt(d.value):'—'}</span>
                      </div>
                    )}
                  </Card>
                </div>

                {/* Leads table */}
                <Card><SH right={<Tag color={T.blue}>{filteredLeads.length} leads</Tag>}>Active Quote Leads {repFilter!=='All'?`— ${repFilter}`:''}</SH>
                  <div style={{overflowX:'auto'}}><table style={{width:'100%',borderCollapse:'collapse'}}>
                    <thead><tr>{['Name','Rep','Phone','Status','Quote Value','Date','Qualifying Stage','Attempts'].map(h=>
                      <th key={h} style={{fontSize:10,color:T.text3,textTransform:'uppercase',letterSpacing:'0.06em',padding:'0 8px 10px',textAlign:['Quote Value','Attempts'].includes(h)?'right':'left',fontWeight:500,whiteSpace:'nowrap'}}>{h}</th>
                    )}</tr></thead>
                    <tbody>{filteredLeads.map(l=>(
                      <tr key={l.id} style={{borderTop:`1px solid ${T.border}`,cursor:'pointer',transition:'background 0.1s'}}
                        onClick={()=>window.open(l.url,'_blank')}
                        onMouseEnter={e=>{(e.currentTarget as HTMLElement).style.background='rgba(255,255,255,0.03)'}}
                        onMouseLeave={e=>{(e.currentTarget as HTMLElement).style.background='transparent'}}>
                        <td style={{fontSize:13,color:T.text,padding:'10px 8px',fontWeight:500,maxWidth:200,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{l.name}</td>
                        <td style={{fontSize:11,padding:'10px 8px'}}><Tag color={RC[l.rep]||T.blue}>{l.rep}</Tag></td>
                        <td style={{fontSize:12,fontFamily:'monospace',color:T.text2,padding:'10px 8px'}}>{l.phone||'—'}</td>
                        <td style={{fontSize:11,padding:'10px 8px'}}><Tag color={SC[l.status]||T.text3}>{l.status||'—'}</Tag></td>
                        <td style={{fontSize:13,fontFamily:'monospace',color:parseFloat(l.quoteValue)>0?T.green:T.text3,padding:'10px 8px',textAlign:'right',fontWeight:500}}>{parseFloat(l.quoteValue)>0?fmtFull(parseFloat(l.quoteValue)):'—'}</td>
                        <td style={{fontSize:12,color:T.text2,padding:'10px 8px',whiteSpace:'nowrap'}}>{fmtDate(l.date)}</td>
                        <td style={{fontSize:11,color:T.text2,padding:'10px 8px',maxWidth:200,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{l.qualifyingStage||'—'}</td>
                        <td style={{fontSize:12,fontFamily:'monospace',color:parseInt(l.contactAttempts)>0?T.amber:T.text3,padding:'10px 8px',textAlign:'right'}}>{l.contactAttempts||'0'}</td>
                      </tr>
                    ))}</tbody>
                  </table></div>
                  {filteredLeads.length===0&&<div style={{color:T.text3,fontSize:13,padding:30,textAlign:'center'}}>No active leads in Quote-Lead group{repFilter!=='All'?` for ${repFilter}`:''}</div>}
                </Card>
              </>}
            </>}

            {/* ═══ DISTRIBUTOR ═══ */}
            {view==='distributor'&&<>
              <div style={{display:'flex',gap:4,marginBottom:16}}>
                <button onClick={()=>setDistPersonFilter('All')} style={{padding:'5px 14px',borderRadius:5,border:`1px solid ${distPersonFilter==='All'?T.accent:T.border}`,fontSize:11,background:distPersonFilter==='All'?T.accent:'transparent',color:distPersonFilter==='All'?'#fff':T.text3,cursor:'pointer',fontFamily:'inherit'}}>All Reps</button>
                {distPeople.map(p=><button key={p} onClick={()=>setDistPersonFilter(p)} style={{padding:'5px 12px',borderRadius:5,border:`1px solid ${distPersonFilter===p?T.accent:T.border}`,fontSize:11,background:distPersonFilter===p?T.accent:'transparent',color:distPersonFilter===p?'#fff':T.text3,cursor:'pointer',fontFamily:'inherit'}}>{p.split(' ')[0]}</button>)}
              </div>
              <div style={{display:'grid',gridTemplateColumns:'repeat(5,1fr)',gap:12,marginBottom:16}}>
                <KPI label="Total Bookings" value={String(distPersonFilter==='All'?dist?.total?.count||0:dist?.byPerson?.[distPersonFilter]?.count||0)} sub={fmt(distPersonFilter==='All'?dist?.total?.value||0:dist?.byPerson?.[distPersonFilter]?.value||0)} subColor={T.blue} accent={T.blue}/>
                <KPI label="Confirmed" value={String(dist?.byStatus?.['Confirmed']?.count||0)} sub={fmt(dist?.byStatus?.['Confirmed']?.value||0)} subColor={T.green} accent={T.green}/>
                <KPI label="Period Bookings" value={String(distPersonFilter==='All'?dist?.mtdTotal?.count||0:dist?.mtdByPerson?.[distPersonFilter]?.count||0)} sub={fmt(distPersonFilter==='All'?dist?.mtdTotal?.value||0:dist?.mtdByPerson?.[distPersonFilter]?.value||0)} subColor={T.teal} accent={T.teal}/>
                <KPI label="Avg Booking" value={dist&&dist.total.count>0?fmt(Math.round(dist.total.value/dist.total.count)):'—'} sub="All time" accent={T.amber}/>
                <KPI label="Distributors" value={String(distArr.length)} sub="Active" accent={T.purple}/>
              </div>
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:14}}>
                <Card><SH right={<a href="https://just-autos.monday.com/boards/1923220718" target="_blank" rel="noopener noreferrer" style={{fontSize:11,color:T.blue,textDecoration:'none'}}>Open Board →</a>}>Revenue by Distributor</SH>
                  {distArr.map(d=><div key={d.name} style={{display:'flex',alignItems:'center',gap:10,marginBottom:8}}>
                    <span style={{fontSize:12,color:T.text2,width:130,flexShrink:0,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{d.name}</span>
                    <div style={{flex:1,height:20,background:T.bg4,borderRadius:4,overflow:'hidden'}}><div style={{height:'100%',borderRadius:4,background:T.blue,width:`${Math.round((d.value/maxDist)*100)}%`,opacity:0.8}}/></div>
                    <span style={{fontSize:12,fontFamily:'monospace',color:T.text,width:50,textAlign:'right'}}>{fmt(d.value)}</span>
                    <span style={{fontSize:11,fontFamily:'monospace',color:T.text3,width:24,textAlign:'right'}}>{d.count}</span>
                  </div>)}
                </Card>
                <div style={{display:'flex',flexDirection:'column',gap:14}}>
                  <Card><SH>Booking Status</SH>
                    {distStatusArr.map(s=><div key={s.status} style={{display:'flex',justifyContent:'space-between',padding:'6px 0',borderBottom:`1px solid ${T.border}`}}><span style={{fontSize:13,color:T.text2}}>{s.status}</span><span style={{fontSize:12,fontFamily:'monospace',color:T.text2}}>{s.count} · {fmt(s.value)}</span></div>)}
                  </Card>
                  <Card><SH>Period Bookings — {distPersonFilter==='All'?dist?.mtdTotal?.count||0:dist?.mtdByPerson?.[distPersonFilter]?.count||0} · {fmt(distPersonFilter==='All'?dist?.mtdTotal?.value||0:dist?.mtdByPerson?.[distPersonFilter]?.value||0)}</SH>
                    {distMtdArr.slice(0,10).map(d=><div key={d.name} style={{display:'flex',justifyContent:'space-between',padding:'5px 0',borderBottom:`1px solid ${T.border}`}}><span style={{fontSize:13,color:T.text2}}>{d.name}</span><span style={{fontSize:12,fontFamily:'monospace',color:T.green}}>{d.count} · {fmt(d.value)}</span></div>)}
                    {distMtdArr.length===0&&<div style={{color:T.text3,fontSize:13,padding:12,textAlign:'center'}}>No bookings in period</div>}
                  </Card>
                  {dist?.byPerson&&<Card><SH>Bookings by Sales Rep</SH>
                    {Object.entries(dist.byPerson).filter(([p])=>p!=='Unassigned').sort(([,a],[,b])=>b.value-a.value).map(([person,d])=>
                      <div key={person} style={{display:'flex',justifyContent:'space-between',padding:'5px 4px',borderBottom:`1px solid ${T.border}`,background:distPersonFilter===person?'rgba(79,142,247,0.08)':'transparent',cursor:'pointer',borderRadius:4}} onClick={()=>setDistPersonFilter(distPersonFilter===person?'All':person)}>
                        <span style={{fontSize:13,color:distPersonFilter===person?T.accent:T.text2,fontWeight:distPersonFilter===person?600:400}}>{person}</span>
                        <span style={{fontSize:12,fontFamily:'monospace',color:T.text2}}>{d.count} · {fmt(d.value)}</span>
                      </div>
                    )}
                  </Card>}
                </div>
              </div>
            </>}
          </>}
        </div>
      </div>
    </div>
  </>)
}

export async function getServerSideProps(context: any) {
  return requirePageAuth(context, 'view:leads')
}
