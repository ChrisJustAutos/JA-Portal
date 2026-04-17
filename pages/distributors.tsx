// pages/distributors.tsx — Just Autos Distributor Report
import { useEffect, useState, useRef, useCallback } from 'react'
import Head from 'next/head'
import Script from 'next/script'
import { useRouter } from 'next/router'

interface LineItem { CustomerName:string;Date:string;AccountName:string;AccountDisplayID:string;Description:string;Total:number;ItemName:string|null }
interface DistData { fetchedAt:string;lineItems:LineItem[];trendLabels:string[];monthlyTotals:Record<string,number>;period:{start:string;end:string} }

function getCategory(aid:string,aname:string):'Tuning'|'Oil'|'Parts'{
  if(aid?.startsWith('4-19')||aid==='4-1905'||aname?.toLowerCase().includes('tuning')||aname?.toLowerCase().includes('remap')||aname?.toLowerCase().includes('multimap')||aname?.toLowerCase().includes('easy lock')||aname?.toLowerCase().includes('multi map'))return 'Tuning'
  if(aid==='4-1060'||aname?.toLowerCase().includes('oil'))return 'Oil'
  return 'Parts'
}
function normName(n:string){return n?.replace(' (Tuning)','').replace(' (Tuning 1)','').replace(' (Tuning2)','').trim()||''}

const fmtD=(n:number)=>n==null?'$0':'$'+Math.round(n).toLocaleString('en-AU')
const fmtFull=(n:number)=>n==null?'$0':'$'+Number(n).toLocaleString('en-AU',{minimumFractionDigits:0,maximumFractionDigits:0})
const fmt=(n:number)=>n>=1e6?'$'+(n/1e6).toFixed(2)+'M':n>=1000?'$'+Math.round(n/1000)+'k':'$'+Math.round(n)

const T={bg:'#0d0f12',bg2:'#131519',bg3:'#1a1d23',bg4:'#21252d',border:'rgba(255,255,255,0.07)',border2:'rgba(255,255,255,0.12)',text:'#e8eaf0',text2:'#8b90a0',text3:'#545968',blue:'#4f8ef7',teal:'#2dd4bf',green:'#34c77b',amber:'#f5a623',red:'#f04e4e',purple:'#a78bfa',accent:'#4f8ef7'}

type Tab='distributor-sales'|'detailed-sales'|'summary'|'national-pm'|'national-total'

export default function DistributorReport(){
  const router=useRouter()
  const [tab,setTab]=useState<Tab>('distributor-sales')
  const [data,setData]=useState<DistData|null>(null)
  const [loading,setLoading]=useState(true)
  const [error,setError]=useState('')
  const [selectedDist,setSelectedDist]=useState('ALL')
  const [refreshing,setRefreshing]=useState(false)
  const [lastRefresh,setLastRefresh]=useState<Date|null>(null)

  // Date range
  const currentFY=new Date().getMonth()>=6?new Date().getFullYear()+1:new Date().getFullYear()
  const [fyYear,setFyYear]=useState(currentFY)
  const [isCustomRange,setIsCustomRange]=useState(false)
  const [customStart,setCustomStart]=useState(`${currentFY-1}-07-01`)
  const [customEnd,setCustomEnd]=useState(`${currentFY}-06-30`)
  const [activeDateParams,setActiveDateParams]=useState(`startDate=${currentFY-1}-07-01&endDate=${currentFY}-06-30`)
  const [dateLoading,setDateLoading]=useState(false)
  const fyLabel=isCustomRange?`${new Date(customStart+'T00:00').toLocaleDateString('en-AU',{day:'2-digit',month:'short',year:'2-digit'})} – ${new Date(customEnd+'T00:00').toLocaleDateString('en-AU',{day:'2-digit',month:'short',year:'2-digit'})}`:`FY${fyYear}`

  function selectFY(y:number){setFyYear(y);setIsCustomRange(false);setCustomStart(`${y-1}-07-01`);setCustomEnd(`${y}-06-30`);setDateLoading(true);setActiveDateParams(`startDate=${y-1}-07-01&endDate=${y}-06-30`)}
  function applyCustomRange(){if(customStart&&customEnd){setIsCustomRange(true);setDateLoading(true);setActiveDateParams(`startDate=${customStart}&endDate=${customEnd}`)}}

  const load=useCallback(async(isRefresh=false)=>{
    if(isRefresh)setRefreshing(true)
    try{
      const rp=isRefresh?'&refresh=true':''
      const r=await fetch(`/api/distributors?${activeDateParams}${rp}`)
      if(r.status===401){router.push('/login');return}
      if(!r.ok)throw new Error('Failed to load distributor data')
      const d=await r.json()
      if(d.error)throw new Error(d.error)
      setData(d);setError('');setLastRefresh(new Date());setDateLoading(false)
    }catch(e:any){setError(e.message);setDateLoading(false)}
    setLoading(false);if(isRefresh)setRefreshing(false)
  },[router,activeDateParams])
  useEffect(()=>{load()},[load])
  useEffect(()=>{const t=setInterval(()=>load(true),5*60*1000);return()=>clearInterval(t)},[load])

  // Derived
  const lines=data?.lineItems||[]
  const allDists=Array.from(new Set(lines.map(l=>normName(l.CustomerName)))).filter(Boolean).sort()
  const filtered=selectedDist==='ALL'?lines:lines.filter(l=>normName(l.CustomerName)===selectedDist)

  interface DS{name:string;tuning:number;oil:number;parts:number;total:number}
  const distSummaries:DS[]=allDists.map(name=>{
    const dl=lines.filter(l=>normName(l.CustomerName)===name)
    const tuning=dl.filter(l=>getCategory(l.AccountDisplayID,l.AccountName)==='Tuning').reduce((s,l)=>s+l.Total,0)
    const oil=dl.filter(l=>getCategory(l.AccountDisplayID,l.AccountName)==='Oil').reduce((s,l)=>s+l.Total,0)
    const parts=dl.filter(l=>getCategory(l.AccountDisplayID,l.AccountName)==='Parts').reduce((s,l)=>s+l.Total,0)
    return{name,tuning,oil,parts,total:tuning+oil+parts}
  }).filter(d=>d.total>0).sort((a,b)=>b.total-a.total)

  const ss=selectedDist==='ALL'
    ?{tuning:distSummaries.reduce((s,d)=>s+d.tuning,0),oil:distSummaries.reduce((s,d)=>s+d.oil,0),parts:distSummaries.reduce((s,d)=>s+d.parts,0),total:distSummaries.reduce((s,d)=>s+d.total,0)}
    :distSummaries.find(d=>d.name===selectedDist)||{tuning:0,oil:0,parts:0,total:0}

  // Detailed line items
  const detailedByDesc:Record<string,{qty:number;total:number}>={}
  filtered.filter(l=>l.Total>0).forEach(l=>{const k=l.Description||l.AccountName;if(!detailedByDesc[k])detailedByDesc[k]={qty:0,total:0};detailedByDesc[k].qty+=1;detailedByDesc[k].total+=l.Total})
  const detailedRows=Object.entries(detailedByDesc).sort((a,b)=>b[1].total-a[1].total)

  const trendLabels=data?.trendLabels||[]
  const monthlyTotals=data?.monthlyTotals||{}

  // Charts
  const barRef=useRef<HTMLCanvasElement>(null),barInst=useRef<any>(null)
  const lineRef=useRef<HTMLCanvasElement>(null),lineInst=useRef<any>(null)
  const hBarRef=useRef<HTMLCanvasElement>(null),hBarInst=useRef<any>(null)

  useEffect(()=>{
    if(!barRef.current||!(window as any).Chart||loading)return
    if(barInst.current)barInst.current.destroy()
    const tunLines=filtered.filter(l=>getCategory(l.AccountDisplayID,l.AccountName)==='Tuning')
    const byDesc:Record<string,number>={};tunLines.forEach(l=>{const k=l.Description?.substring(0,30)||'Other';byDesc[k]=(byDesc[k]||0)+l.Total})
    const sorted=Object.entries(byDesc).sort((a,b)=>b[1]-a[1]).slice(0,10)
    barInst.current=new(window as any).Chart(barRef.current,{type:'bar',data:{labels:sorted.map(s=>s[0]),datasets:[{data:sorted.map(s=>Math.round(s[1])),backgroundColor:'#4f8ef7',borderRadius:4,borderSkipped:false}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:(ctx:any)=>`$${ctx.raw.toLocaleString()}`}}},scales:{x:{grid:{color:'rgba(255,255,255,0.05)'},ticks:{color:T.text3,font:{size:10},maxRotation:45}},y:{grid:{color:'rgba(255,255,255,0.05)'},ticks:{color:T.text3,font:{size:11},callback:(v:any)=>'$'+v}}}}})
    return()=>{if(barInst.current)barInst.current.destroy()}
  },[filtered,tab,loading])

  useEffect(()=>{
    if(tab!=='national-pm'||!lineRef.current||!(window as any).Chart||!trendLabels.length)return
    if(lineInst.current)lineInst.current.destroy()
    const vals=trendLabels.map(l=>Math.round(monthlyTotals[l]||0))
    lineInst.current=new(window as any).Chart(lineRef.current,{type:'bar',data:{labels:trendLabels,datasets:[{label:'Revenue ex GST',data:vals,backgroundColor:'#4f8ef7',borderRadius:4,borderSkipped:false}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:(ctx:any)=>`$${ctx.raw.toLocaleString()}`}}},scales:{x:{grid:{color:'rgba(255,255,255,0.05)'},ticks:{color:T.text3}},y:{grid:{color:'rgba(255,255,255,0.05)'},ticks:{color:T.text3,callback:(v:any)=>'$'+Math.round(v/1000)+'k'}}}}})
    return()=>{if(lineInst.current)lineInst.current.destroy()}
  },[tab,trendLabels,monthlyTotals])

  useEffect(()=>{
    if(tab!=='national-total'||!hBarRef.current||!(window as any).Chart||!distSummaries.length)return
    if(hBarInst.current)hBarInst.current.destroy()
    const sorted=[...distSummaries].sort((a,b)=>b.total-a.total)
    hBarInst.current=new(window as any).Chart(hBarRef.current,{type:'bar',data:{labels:sorted.map(d=>d.name),datasets:[{label:'Revenue ex GST',data:sorted.map(d=>Math.round(d.total)),backgroundColor:'#4f8ef7',borderRadius:3,borderSkipped:false}]},options:{indexAxis:'y' as const,responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:(ctx:any)=>`$${ctx.raw.toLocaleString()}`}}},scales:{x:{grid:{color:'rgba(255,255,255,0.05)'},ticks:{color:T.text3,callback:(v:any)=>'$'+Math.round(v/1000)+'k'}},y:{grid:{display:false},ticks:{color:T.text2,font:{size:11}}}}}})
    return()=>{if(hBarInst.current)hBarInst.current.destroy()}
  },[tab,distSummaries])

  const tabs:[Tab,string][]=[['distributor-sales','Distributor Sales'],['detailed-sales','Detailed Sales'],['summary','Summary'],['national-pm','National P/M'],['national-total','National Total']]
  const sidebarNav=[{href:'/',label:'Overview',color:T.blue},{href:'/?s=jaws',label:'JAWS Wholesale',color:T.blue},{href:'/?s=vps',label:'VPS Workshop',color:T.teal},{href:'/?s=invoices',label:'Invoices',color:T.amber},{href:'/?s=pnl',label:'P&L',color:T.green},{href:'/?s=stock',label:'Stock & Inventory',color:T.purple},{href:'/?s=payables',label:'Payables',color:T.red},{href:'/?s=distributors',label:'Distributors',color:T.blue}]

  function KPIBox({label,value,color}:{label:string;value:number;color?:string}){
    return <div style={{textAlign:'right',padding:'16px 20px',borderBottom:`1px solid ${T.border}`}}>
      <div style={{fontSize:32,fontWeight:400,fontFamily:'monospace',color:value===0?T.red:(color||T.text),letterSpacing:'-0.03em'}}>{fmtD(value)}</div>
      <div style={{fontSize:12,color:T.text3,marginTop:4}}>{label}</div>
    </div>
  }

  function DistSelector(){
    return <div style={{borderBottom:`1px solid ${T.border}`,padding:'10px 20px',background:T.bg2,display:'flex',alignItems:'center',gap:6,overflowX:'auto',flexShrink:0}}>
      <span style={{fontSize:11,color:T.text3,flexShrink:0,marginRight:4}}>Distributor</span>
      {['ALL',...allDists].map(d=><button key={d} onClick={()=>setSelectedDist(d)}
        style={{fontSize:11,padding:'5px 10px',borderRadius:5,border:`1px solid ${selectedDist===d?T.blue:T.border}`,background:selectedDist===d?'rgba(79,142,247,0.2)':T.bg3,color:selectedDist===d?T.blue:T.text2,cursor:'pointer',fontFamily:'inherit',whiteSpace:'nowrap',flexShrink:0}}>
        {d==='ALL'?'All':d}
      </button>)}
    </div>
  }

  function renderContent(){
    if(loading)return <div style={{display:'flex',alignItems:'center',justifyContent:'center',height:400,flexDirection:'column',gap:12}}>
      <div style={{fontSize:28,animation:'spin 1s linear infinite',color:T.text3}}>⟳</div><div style={{color:T.text3}}>Loading distributor data…</div>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>

    if(error)return <div style={{padding:24}}><div style={{background:'rgba(240,78,78,0.1)',border:'1px solid rgba(240,78,78,0.2)',borderRadius:10,padding:20,color:T.red}}>
      <div style={{marginBottom:10}}>Error: {error}</div>
      <button onClick={()=>{setError('');setLoading(true);load()}} style={{padding:'6px 16px',borderRadius:6,border:`1px solid ${T.blue}`,background:T.blue,color:'#fff',fontSize:12,cursor:'pointer',fontFamily:'inherit'}}>Retry</button>
    </div></div>

    if(tab==='distributor-sales')return <div style={{display:'flex',height:'100%'}}>
      <div style={{flex:1,padding:24,display:'flex',flexDirection:'column',gap:16,overflowY:'auto'}}>
        <div style={{fontSize:18,fontWeight:500,color:T.text}}>{selectedDist==='ALL'?'All Distributors':selectedDist}</div>
        <div style={{fontSize:12,color:T.text3}}><span style={{display:'inline-flex',alignItems:'center',gap:5}}><span style={{width:10,height:10,borderRadius:2,background:T.blue,display:'inline-block'}}/> Tuning Revenue ex GST</span></div>
        <div style={{position:'relative',height:340,background:T.bg2,border:`1px solid ${T.border}`,borderRadius:10,padding:16}}>
          <canvas ref={barRef} id="bar-chart"/>
        </div>
      </div>
      <div style={{width:220,borderLeft:`1px solid ${T.border}`,flexShrink:0}}>
        <KPIBox label="Tuning Revenue ex GST" value={ss.tuning} color={T.green}/>
        <KPIBox label="Oil Revenue ex GST" value={ss.oil}/>
        <KPIBox label="Parts Revenue ex GST" value={ss.parts}/>
        <KPIBox label="Total Revenue ex GST" value={ss.total} color={T.blue}/>
      </div>
    </div>

    if(tab==='detailed-sales')return <div style={{padding:24,overflowY:'auto'}}>
      <div style={{fontSize:18,fontWeight:500,color:T.text,marginBottom:16}}>{selectedDist==='ALL'?'All':selectedDist}</div>
      <div style={{background:T.bg2,border:`1px solid ${T.border}`,borderRadius:10,overflowX:'auto'}}>
        <table style={{width:'100%',borderCollapse:'collapse'}}>
          <thead><tr style={{borderBottom:`1px solid ${T.border}`}}>
            <th style={{fontSize:12,color:T.text2,padding:'12px 16px',textAlign:'left',fontWeight:500}}>Description</th>
            <th style={{fontSize:12,color:T.text2,padding:'12px 16px',textAlign:'right',fontWeight:500}}>Qty</th>
            <th style={{fontSize:12,color:T.text2,padding:'12px 16px',textAlign:'right',fontWeight:500}}>Total $ ExGST</th>
          </tr></thead>
          <tbody>{detailedRows.map(([desc,vals],i)=><tr key={i} style={{borderTop:`1px solid ${T.border}`}}>
            <td style={{fontSize:12,color:T.text2,padding:'9px 16px'}}>{desc?.substring(0,70)}</td>
            <td style={{fontSize:12,fontFamily:'monospace',color:T.text3,padding:'9px 16px',textAlign:'right'}}>{vals.qty>1?vals.qty:''}</td>
            <td style={{fontSize:12,fontFamily:'monospace',color:T.text,padding:'9px 16px',textAlign:'right'}}>{fmtFull(vals.total)}</td>
          </tr>)}
          <tr style={{borderTop:`2px solid ${T.border2}`,background:T.bg3}}>
            <td style={{fontSize:13,fontWeight:500,color:T.text,padding:'10px 16px'}}>Total</td>
            <td style={{fontSize:13,fontFamily:'monospace',fontWeight:500,color:T.text3,padding:'10px 16px',textAlign:'right'}}>{detailedRows.reduce((s,[,v])=>s+v.qty,0)}</td>
            <td style={{fontSize:13,fontFamily:'monospace',fontWeight:500,color:T.blue,padding:'10px 16px',textAlign:'right'}}>{fmtFull(detailedRows.reduce((s,[,v])=>s+v.total,0))}</td>
          </tr></tbody>
        </table>
      </div>
    </div>

    if(tab==='summary')return <div style={{padding:24,overflowY:'auto'}}>
      <div style={{background:T.bg2,border:`1px solid ${T.border}`,borderRadius:10,overflowX:'auto'}}>
        <table style={{width:'100%',borderCollapse:'collapse'}}>
          <thead><tr style={{borderBottom:`1px solid ${T.border2}`}}>
            <th style={{fontSize:11,color:T.text3,padding:'10px 12px',textAlign:'left',fontWeight:500}}>Distributor</th>
            {['Oil','Parts','Tuning','Total'].map(h=><th key={h} style={{fontSize:11,color:T.text3,padding:'10px 12px',textAlign:'right',fontWeight:500}}>{h}</th>)}
          </tr></thead>
          <tbody>{distSummaries.map((d,i)=><tr key={i} style={{borderTop:`1px solid ${T.border}`,cursor:'pointer',background:selectedDist===d.name?'rgba(79,142,247,0.08)':'transparent'}} onClick={()=>setSelectedDist(d.name===selectedDist?'ALL':d.name)}>
            <td style={{fontSize:12,color:T.text2,padding:'8px 12px'}}>{d.name}</td>
            <td style={{fontSize:12,fontFamily:'monospace',color:d.oil>0?T.text:T.text3,padding:'8px 12px',textAlign:'right'}}>{d.oil>0?fmtFull(d.oil):'$0'}</td>
            <td style={{fontSize:12,fontFamily:'monospace',color:d.parts>0?T.text:T.text3,padding:'8px 12px',textAlign:'right'}}>{d.parts>0?fmtFull(d.parts):'$0'}</td>
            <td style={{fontSize:12,fontFamily:'monospace',color:d.tuning>0?T.green:T.text3,padding:'8px 12px',textAlign:'right'}}>{d.tuning>0?fmtFull(d.tuning):'$0'}</td>
            <td style={{fontSize:12,fontFamily:'monospace',fontWeight:500,color:T.blue,padding:'8px 12px',textAlign:'right'}}>{fmtFull(d.total)}</td>
          </tr>)}
          <tr style={{borderTop:`2px solid ${T.border2}`,background:T.bg3}}>
            <td style={{fontSize:13,fontWeight:500,color:T.text,padding:'10px 12px'}}>Total</td>
            <td style={{fontSize:13,fontFamily:'monospace',fontWeight:500,color:T.text,padding:'10px 12px',textAlign:'right'}}>{fmtFull(distSummaries.reduce((s,d)=>s+d.oil,0))}</td>
            <td style={{fontSize:13,fontFamily:'monospace',fontWeight:500,color:T.text,padding:'10px 12px',textAlign:'right'}}>{fmtFull(distSummaries.reduce((s,d)=>s+d.parts,0))}</td>
            <td style={{fontSize:13,fontFamily:'monospace',fontWeight:500,color:T.green,padding:'10px 12px',textAlign:'right'}}>{fmtFull(distSummaries.reduce((s,d)=>s+d.tuning,0))}</td>
            <td style={{fontSize:13,fontFamily:'monospace',fontWeight:500,color:T.blue,padding:'10px 12px',textAlign:'right'}}>{fmtFull(distSummaries.reduce((s,d)=>s+d.total,0))}</td>
          </tr></tbody>
        </table>
      </div>
    </div>

    if(tab==='national-pm')return <div style={{padding:24,overflowY:'auto'}}>
      <div style={{fontSize:16,fontWeight:500,color:T.text,marginBottom:20}}>National Distributor Revenue ex GST by Month</div>
      <div style={{background:T.bg2,border:`1px solid ${T.border}`,borderRadius:10,padding:20}}>
        <div style={{position:'relative',height:380}}><canvas ref={lineRef} id="line-chart"/></div>
      </div>
      <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:10,marginTop:16}}>
        {trendLabels.map(l=><div key={l} style={{background:T.bg2,border:`1px solid ${T.border}`,borderRadius:8,padding:'10px 14px'}}>
          <div style={{fontSize:11,color:T.text3,marginBottom:4}}>{l}</div>
          <div style={{fontSize:18,fontFamily:'monospace',fontWeight:500,color:T.blue}}>{fmtFull(monthlyTotals[l]||0)}</div>
        </div>)}
      </div>
    </div>

    if(tab==='national-total')return <div style={{padding:24,overflowY:'auto'}}>
      <div style={{fontSize:16,fontWeight:500,color:T.text,marginBottom:20}}>National Distributor Revenue ex GST by Customer</div>
      <div style={{background:T.bg2,border:`1px solid ${T.border}`,borderRadius:10,padding:20}}>
        <div style={{position:'relative',height:Math.max(300,distSummaries.length*36+60)}}><canvas ref={hBarRef} id="hbar-chart"/></div>
      </div>
    </div>

    return null
  }

  const showSelector=tab==='distributor-sales'||tab==='detailed-sales'

  return (<>
    <Head><title>Distributor Report — Just Autos</title><meta name="viewport" content="width=device-width,initial-scale=1"/><meta name="robots" content="noindex,nofollow"/></Head>
    <Script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js" strategy="beforeInteractive"/>

    <div style={{display:'flex',height:'100vh',overflow:'hidden',fontFamily:"'DM Sans',system-ui,sans-serif",color:T.text}}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet"/>

      {/* SIDEBAR */}
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
          <a href="/sales" style={{display:'flex',alignItems:'center',gap:9,padding:'8px 10px',borderRadius:7,fontSize:13,marginBottom:4,background:'rgba(167,139,250,0.1)',color:T.purple,textDecoration:'none',border:`1px solid rgba(167,139,250,0.2)`}}>
            <div style={{width:7,height:7,borderRadius:'50%',background:T.purple,flexShrink:0}}/><span style={{flex:1}}>Sales Dashboard</span>
          </a>
          <a href="/distributors" style={{display:'flex',alignItems:'center',gap:9,padding:'8px 10px',borderRadius:7,fontSize:13,marginBottom:4,background:'rgba(79,142,247,0.15)',color:T.blue,textDecoration:'none',border:`1px solid rgba(79,142,247,0.3)`}}>
            <div style={{width:7,height:7,borderRadius:'50%',background:T.blue,flexShrink:0}}/><span style={{flex:1}}>Distributor Report</span>
            <span style={{fontSize:9,fontFamily:'monospace',background:T.blue,color:'#fff',padding:'1px 5px',borderRadius:3}}>PBI</span>
          </a>
          {sidebarNav.map(item=><a key={item.label} href={item.href} style={{display:'flex',alignItems:'center',gap:9,padding:'8px 10px',borderRadius:7,fontSize:13,marginBottom:1,background:'transparent',color:T.text2,textDecoration:'none'}}><div style={{width:7,height:7,borderRadius:'50%',background:item.color,flexShrink:0}}/><span style={{flex:1}}>{item.label}</span></a>)}
        </div>
        <div style={{padding:'12px 14px',borderTop:`1px solid ${T.border}`}}>
          <div style={{fontSize:10,color:T.text3,marginBottom:5}}>{lastRefresh?`Updated ${lastRefresh.toLocaleTimeString('en-AU',{hour:'2-digit',minute:'2-digit'})}`:'Loading…'}</div>
          <button onClick={()=>load(true)} disabled={refreshing} style={{fontSize:12,color:T.blue,background:'none',border:'none',cursor:'pointer',fontFamily:'inherit',padding:0,display:'block',marginBottom:4}}>{refreshing?'Refreshing…':'↻ Refresh data'}</button>
          <button onClick={async()=>{await fetch('/api/auth/logout',{method:'POST'});router.push('/login')}} style={{fontSize:12,color:T.text3,background:'none',border:'none',cursor:'pointer',fontFamily:'inherit',padding:0}}>Sign out →</button>
        </div>
      </div>

      {/* MAIN */}
      <div style={{flex:1,display:'flex',flexDirection:'column',overflow:'hidden',background:T.bg}}>
        {/* Top bar */}
        <div style={{height:52,background:T.bg2,borderBottom:`1px solid ${T.border}`,display:'flex',alignItems:'center',padding:'0 20px',gap:10,flexShrink:0}}>
          <div style={{width:26,height:26,borderRadius:6,background:T.blue,display:'flex',alignItems:'center',justifyContent:'center',fontSize:11,fontWeight:600,color:'#fff'}}>JA</div>
          <span style={{fontSize:14,fontWeight:600}}>Distributor Report</span>
          <div style={{flex:1}}/>
          {!loading&&<><div style={{width:7,height:7,borderRadius:'50%',background:T.green,boxShadow:`0 0 6px ${T.green}`}}/>
          <span style={{fontSize:10,fontFamily:'monospace',padding:'2px 8px',borderRadius:4,background:'rgba(52,199,123,0.12)',color:T.green,border:'1px solid rgba(52,199,123,0.2)'}}>MYOB live</span>
          <span style={{fontSize:10,fontFamily:'monospace',padding:'2px 8px',borderRadius:4,background:'rgba(79,142,247,0.12)',color:T.blue,border:'1px solid rgba(79,142,247,0.2)'}}>{fyLabel} · {distSummaries.length} distributors</span></>}
          <div style={{width:1,height:18,background:T.border}}/>
          {[currentFY-1,currentFY].map(y=><button key={y} onClick={()=>selectFY(y)} style={{padding:'3px 10px',borderRadius:4,border:'1px solid',fontSize:11,fontFamily:'monospace',fontWeight:600,cursor:'pointer',background:fyYear===y&&!isCustomRange?T.accent:'transparent',color:fyYear===y&&!isCustomRange?'#fff':T.text2,borderColor:fyYear===y&&!isCustomRange?T.accent:T.border}}>FY{y}</button>)}
          <input type="date" value={customStart} onChange={e=>setCustomStart(e.target.value)} style={{padding:'3px 6px',borderRadius:4,border:`1px solid ${isCustomRange?T.accent:T.border}`,fontSize:11,fontFamily:'monospace',background:'transparent',color:T.text2,outline:'none',colorScheme:'dark'}}/>
          <span style={{fontSize:11,color:T.text3}}>→</span>
          <input type="date" value={customEnd} onChange={e=>setCustomEnd(e.target.value)} style={{padding:'3px 6px',borderRadius:4,border:`1px solid ${isCustomRange?T.accent:T.border}`,fontSize:11,fontFamily:'monospace',background:'transparent',color:T.text2,outline:'none',colorScheme:'dark'}}/>
          <button onClick={applyCustomRange} style={{padding:'3px 10px',borderRadius:4,border:`1px solid ${T.accent}`,fontSize:11,fontFamily:'monospace',fontWeight:600,cursor:'pointer',background:isCustomRange?T.accent:'transparent',color:isCustomRange?'#fff':T.accent}}>Apply</button>
          {dateLoading&&<span style={{fontSize:14,animation:'spin 1s linear infinite',color:T.blue}}>⟳</span>}
        </div>

        {/* Tabs */}
        <div style={{background:T.bg2,borderBottom:`1px solid ${T.border}`,display:'flex',alignItems:'flex-end',padding:'0 20px',gap:2,flexShrink:0}}>
          {tabs.map(([id,label])=><button key={id} onClick={()=>setTab(id)} style={{fontSize:12,padding:'10px 16px',border:'none',borderBottom:tab===id?`2px solid ${T.blue}`:'2px solid transparent',background:'transparent',color:tab===id?T.blue:T.text2,cursor:'pointer',fontFamily:'inherit',whiteSpace:'nowrap'}}>{label}</button>)}
        </div>

        {showSelector&&!loading&&!error&&<DistSelector/>}

        {/* Content */}
        <div style={{flex:1,overflow:'hidden',display:'flex',flexDirection:'column',position:'relative'}}>
          <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
          {dateLoading&&<div style={{position:'absolute',inset:0,background:'rgba(13,15,18,0.75)',zIndex:10,display:'flex',alignItems:'center',justifyContent:'center',flexDirection:'column',gap:12}}>
            <div style={{fontSize:28,animation:'spin 1s linear infinite',color:T.blue}}>⟳</div><div style={{color:T.text2,fontSize:13}}>Updating distributor data for {fyLabel}…</div>
          </div>}
          {renderContent()}
        </div>
      </div>
    </div>
  </>)
}

export async function getServerSideProps(context:any){
  const cookie=context.req.cookies['ja_portal_auth']
  const pw=process.env.PORTAL_PASSWORD||'justautos2026'
  if(!cookie)return{redirect:{destination:'/login',permanent:false}}
  try{if(Buffer.from(cookie,'base64').toString('utf8')!==pw)return{redirect:{destination:'/login',permanent:false}}}catch{return{redirect:{destination:'/login',permanent:false}}}
  return{props:{}}
}
