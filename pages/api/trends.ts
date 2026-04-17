// pages/index.tsx — Just Autos Management Portal v3
// Full JAWS + VPS parity, trend charts, Power BI-style layout
import { useEffect, useState, useRef, useCallback } from 'react'
import Head from 'next/head'
import Script from 'next/script'
import { useRouter } from 'next/router'

// ── Types ────────────────────────────────────────────────────
interface Invoice  { Number:string;Date:string;CustomerName:string;TotalAmount:number;BalanceDueAmount:number;Status:string;InvoiceType?:string }
interface Customer { CustomerName:string;TotalRevenue:number;InvoiceCount:number }
interface PnLLine  { AccountName:string;AccountDisplayID:string;AccountTotal:number }
interface StockItem{ Name:string;CurrentValue:number;QuantityOnHand:number;QuantityCommitted:number;AverageCost:number;BaseSellingPrice:number }
interface Bill     { Number:string;Date:string;SupplierName:string;TotalAmount:number;BalanceDueAmount:number }
interface DashData {
  fetchedAt:string; period:{start:string;end:string}; trendLabels:string[]
  jaws:{ recentInvoices:any;openInvoices:any;topCustomers:any;pnl:any;stockItems:any;stockSummary:any;openBills:any;income6:number[];expense6:number[] }
  vps: { recentInvoices:any;openInvoices:any;topCustomers:any;openBills:any;pnl:any;stockSummary:any;income6:number[];expense6:number[] }
}
type Section = 'overview'|'jaws'|'vps'|'invoices'|'pnl'|'stock'|'payables'|'distributors'

// ── Helpers ──────────────────────────────────────────────────
const fmt    = (n:number) => n>=1e6?'$'+(n/1e6).toFixed(2)+'M':n>=1000?'$'+Math.round(n/1000)+'k':'$'+Math.round(n)
const fmtFull= (n:number) => n==null?'—':'$'+Number(n).toLocaleString('en-AU',{minimumFractionDigits:2,maximumFractionDigits:2})
const fmtDate= (d:string) => new Date(d).toLocaleDateString('en-AU',{day:'2-digit',month:'short'})
const pct    = (a:number,b:number) => b===0?'—':Math.round((a/b)*100)+'%'
function rowsToObjects(result:any):Record<string,any>[] {
  if (!result?.results?.[0]) return []
  const {schema,rows}=result.results[0]
  if (!schema||!rows) return []
  return rows.map((row:any[])=>{const o:any={};schema.forEach((c:any,i:number)=>{o[c.columnName]=row[i]});return o})
}

// ── Design tokens (dark theme) ───────────────────────────────
const T = {
  bg:'#0d0f12', bg2:'#131519', bg3:'#1a1d23', bg4:'#21252d',
  border:'rgba(255,255,255,0.07)', border2:'rgba(255,255,255,0.12)',
  text:'#e8eaf0', text2:'#8b90a0', text3:'#545968',
  blue:'#4f8ef7', teal:'#2dd4bf', green:'#34c77b',
  amber:'#f5a623', red:'#f04e4e', purple:'#a78bfa',
  accent:'#4f8ef7',
}

// ── Shared UI components ─────────────────────────────────────
function Card({children,style}:{children:React.ReactNode;style?:React.CSSProperties}) {
  return <div style={{background:T.bg2,border:`1px solid ${T.border}`,borderRadius:10,padding:16,...style}}>{children}</div>
}
function PTitle({children,right}:{children:React.ReactNode;right?:React.ReactNode}) {
  return <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:14}}>
    <div style={{fontSize:11,fontWeight:600,color:T.text3,textTransform:'uppercase',letterSpacing:'0.08em'}}>{children}</div>
    {right&&<div style={{fontSize:11,color:T.text3}}>{right}</div>}
  </div>
}
function KPI({label,value,sub,subColor,accent}:{label:string;value:string;sub?:string;subColor?:string;accent?:string}) {
  return <div style={{background:T.bg2,border:`1px solid ${T.border}`,borderRadius:10,padding:'14px 16px',borderTop:accent?`3px solid ${accent}`:undefined}}>
    <div style={{fontSize:10,color:T.text3,textTransform:'uppercase',letterSpacing:'0.07em',marginBottom:8}}>{label}</div>
    <div style={{fontSize:20,fontWeight:500,fontFamily:'monospace',letterSpacing:'-0.03em',marginBottom:3,color:T.text}}>{value}</div>
    {sub&&<div style={{fontSize:11,color:subColor||T.text3}}>{sub}</div>}
  </div>
}
function Divider() { return <div style={{height:1,background:T.border,margin:'10px 0'}}/> }
function Tag({children,color}:{children:React.ReactNode;color:string}) {
  return <span style={{fontSize:10,fontFamily:'monospace',padding:'2px 8px',borderRadius:4,background:`${color}20`,color,border:`1px solid ${color}40`}}>{children}</span>
}
function BarRow({name,value,max,color=T.blue,extra}:{name:string;value:number;max:number;color?:string;extra?:string}) {
  return <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:7}}>
    <span style={{fontSize:12,color:T.text2,width:160,flexShrink:0,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{name}</span>
    <div style={{flex:1,height:5,background:T.bg4,borderRadius:3,overflow:'hidden'}}>
      <div style={{height:'100%',borderRadius:3,background:color,width:`${Math.min(100,Math.round(value/max*100))}%`,transition:'width 0.7s ease'}}/>
    </div>
    <span style={{fontSize:11,fontFamily:'monospace',color:T.text,width:64,textAlign:'right',flexShrink:0}}>{fmt(value)}</span>
    {extra&&<span style={{fontSize:10,color:T.text3,fontFamily:'monospace',flexShrink:0}}>{extra}</span>}
  </div>
}
function InvoiceTable({rows,accent,onOpenInvoiceClick}:{rows:Invoice[];accent:string;onOpenInvoiceClick?:()=>void}) {
  return <div style={{overflowX:'auto'}}>
    <table style={{width:'100%',borderCollapse:'collapse'}}>
      <thead><tr>{['Invoice','Date','Customer','Total','Balance','Status'].map(h=>(
        <th key={h} style={{fontSize:10,color:T.text3,textTransform:'uppercase',letterSpacing:'0.07em',padding:'0 8px 10px',textAlign:['Total','Balance'].includes(h)?'right':'left',fontWeight:500,whiteSpace:'nowrap'}}>{h}</th>
      ))}</tr></thead>
      <tbody>{rows.map((r,i)=>(
        <tr key={i} style={{borderTop:`1px solid ${T.border}`,cursor:r.Status==='Open'&&onOpenInvoiceClick?'pointer':'default',transition:'background 0.1s'}}
          onClick={r.Status==='Open'&&onOpenInvoiceClick?onOpenInvoiceClick:undefined}
          onMouseEnter={e=>{if(r.Status==='Open'&&onOpenInvoiceClick)(e.currentTarget as HTMLElement).style.background='rgba(255,255,255,0.03)'}}
          onMouseLeave={e=>{(e.currentTarget as HTMLElement).style.background='transparent'}}
        >
          <td style={{fontSize:12,color:r.Status==='Open'?T.amber:accent,fontFamily:'monospace',padding:'7px 8px',fontWeight:r.Status==='Open'?500:400}}>{r.Number}</td>
          <td style={{fontSize:12,color:T.text2,padding:'7px 8px',whiteSpace:'nowrap'}}>{fmtDate(r.Date)}</td>
          <td style={{fontSize:12,color:T.text2,padding:'7px 8px',maxWidth:200,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{r.CustomerName?.substring(0,32)}</td>
          <td style={{fontSize:12,fontFamily:'monospace',color:T.text,padding:'7px 8px',textAlign:'right'}}>{fmtFull(r.TotalAmount)}</td>
          <td style={{fontSize:12,fontFamily:'monospace',color:r.BalanceDueAmount>0?T.amber:T.text3,padding:'7px 8px',textAlign:'right'}}>{r.BalanceDueAmount>0?fmtFull(r.BalanceDueAmount):'—'}</td>
          <td style={{padding:'7px 8px'}}><Tag color={r.Status==='Open'?T.amber:T.green}>{r.Status}</Tag></td>
        </tr>
      ))}</tbody>
    </table>
  </div>
}
function BillTable({rows,accent}:{rows:Bill[];accent:string}) {
  return <div style={{overflowX:'auto'}}>
    <table style={{width:'100%',borderCollapse:'collapse'}}>
      <thead><tr>{['Bill #','Date','Supplier','Total','Owing'].map(h=>(
        <th key={h} style={{fontSize:10,color:T.text3,textTransform:'uppercase',letterSpacing:'0.07em',padding:'0 8px 10px',textAlign:['Total','Owing'].includes(h)?'right':'left',fontWeight:500}}>{h}</th>
      ))}</tr></thead>
      <tbody>{rows.map((r,i)=>(
        <tr key={i} style={{borderTop:`1px solid ${T.border}`}}>
          <td style={{fontSize:12,color:accent,fontFamily:'monospace',padding:'7px 8px'}}>{r.Number}</td>
          <td style={{fontSize:12,color:T.text2,padding:'7px 8px',whiteSpace:'nowrap'}}>{fmtDate(r.Date)}</td>
          <td style={{fontSize:12,color:T.text2,padding:'7px 8px',maxWidth:220}}>{r.SupplierName?.substring(0,30)}</td>
          <td style={{fontSize:12,fontFamily:'monospace',color:T.text,padding:'7px 8px',textAlign:'right'}}>{fmtFull(r.TotalAmount)}</td>
          <td style={{fontSize:12,fontFamily:'monospace',color:T.red,padding:'7px 8px',textAlign:'right'}}>{fmtFull(r.BalanceDueAmount)}</td>
        </tr>
      ))}</tbody>
    </table>
  </div>
}

// ── Trend chart using Chart.js ───────────────────────────────
function TrendChart({labels,jawsData,vpsData,title,chartId}:{labels:string[];jawsData:number[];vpsData:number[];title:string;chartId:string}) {
  const canvasRef=useRef<HTMLCanvasElement>(null)
  const chartRef=useRef<any>(null)

  useEffect(()=>{
    if (!canvasRef.current||!jawsData.length) return
    const buildChart = () => {
      const win=window as any
      if (!win.Chart) { setTimeout(buildChart, 200); return }
      if (chartRef.current) chartRef.current.destroy()
      chartRef.current=new win.Chart(canvasRef.current,{
        type:'bar',
        data:{
          labels,
          datasets:[
            {label:'JAWS',data:jawsData.map(v=>Math.round(v/1000)),backgroundColor:'#4f8ef7',borderRadius:4,borderSkipped:false},
            {label:'VPS', data:vpsData.map(v=>Math.round(v/1000)), backgroundColor:'#2dd4bf',borderRadius:4,borderSkipped:false},
          ]
        },
        options:{
          responsive:true,maintainAspectRatio:false,
          plugins:{legend:{display:false},tooltip:{callbacks:{label:(ctx:any)=>`${ctx.dataset.label}: $${ctx.raw}k`}}},
          scales:{
            x:{grid:{color:'rgba(255,255,255,0.05)'},ticks:{color:T.text3,font:{size:11},autoSkip:false,maxRotation:45}},
            y:{grid:{color:'rgba(255,255,255,0.05)'},ticks:{color:T.text3,font:{size:11},callback:(v:any)=>'$'+v+'k'}},
          }
        }
      })
    }
    buildChart()
    return()=>{if(chartRef.current){chartRef.current.destroy();chartRef.current=null}}
  },[labels,jawsData,vpsData])

  return (
    <div>
      <div style={{display:'flex',gap:14,marginBottom:10}}>
        {[{label:'JAWS',color:'#4f8ef7'},{label:'VPS',color:'#2dd4bf'}].map(s=>(
          <div key={s.label} style={{display:'flex',alignItems:'center',gap:5,fontSize:12,color:T.text2}}>
            <div style={{width:10,height:10,borderRadius:2,background:s.color}}/>
            {s.label}
          </div>
        ))}
      </div>
      <div style={{position:'relative',height:200}}>
        <canvas ref={canvasRef} id={chartId} role="img" aria-label={`${title} bar chart comparing JAWS and VPS over 6 months`}>
          {title}: {labels.map((l,i)=>`${l} JAWS $${Math.round((jawsData[i]||0)/1000)}k VPS $${Math.round((vpsData[i]||0)/1000)}k`).join(', ')}
        </canvas>
      </div>
    </div>
  )
}
function LineChart({labels,jawsData,vpsData,chartId}:{labels:string[];jawsData:number[];vpsData:number[];chartId:string}) {
  const canvasRef=useRef<HTMLCanvasElement>(null)
  const chartRef=useRef<any>(null)
  useEffect(()=>{
    if (!canvasRef.current||!jawsData.length) return
    const buildChart = () => {
      const win=window as any
      if (!win.Chart) { setTimeout(buildChart,200); return }
      if (chartRef.current) chartRef.current.destroy()
      chartRef.current=new win.Chart(canvasRef.current,{
        type:'line',
        data:{
          labels,
          datasets:[
            {label:'JAWS',data:jawsData.map(v=>Math.round(v/1000)),borderColor:'#4f8ef7',backgroundColor:'rgba(79,142,247,0.1)',tension:0.3,fill:true,pointRadius:4,pointBackgroundColor:'#4f8ef7'},
            {label:'VPS', data:vpsData.map(v=>Math.round(v/1000)), borderColor:'#2dd4bf',backgroundColor:'rgba(45,212,191,0.1)',tension:0.3,fill:true,pointRadius:4,pointBackgroundColor:'#2dd4bf'},
          ]
        },
        options:{
          responsive:true,maintainAspectRatio:false,
          plugins:{legend:{display:false},tooltip:{callbacks:{label:(ctx:any)=>`${ctx.dataset.label}: $${ctx.raw}k`}}},
          scales:{
            x:{grid:{color:'rgba(255,255,255,0.05)'},ticks:{color:T.text3,font:{size:11}}},
            y:{grid:{color:'rgba(255,255,255,0.05)'},ticks:{color:T.text3,font:{size:11},callback:(v:any)=>'$'+v+'k'}},
          }
        }
      })
    }
    buildChart()
    return()=>{if(chartRef.current){chartRef.current.destroy();chartRef.current=null}}
  },[labels,jawsData,vpsData])
  return <div style={{position:'relative',height:200}}>
    <canvas ref={canvasRef} id={chartId} role="img" aria-label="Revenue trend line chart">Net result trend</canvas>
  </div>
}
function DonutChart({jawsVal,vpsVal,chartId}:{jawsVal:number;vpsVal:number;chartId:string}) {
  const canvasRef=useRef<HTMLCanvasElement>(null)
  const chartRef=useRef<any>(null)
  useEffect(()=>{
    if (!canvasRef.current) return
    const buildChart = () => {
      const win=window as any
      if (!win.Chart) { setTimeout(buildChart,200); return }
      if (chartRef.current) chartRef.current.destroy()
      chartRef.current=new win.Chart(canvasRef.current,{
        type:'doughnut',
        data:{labels:['JAWS','VPS'],datasets:[{data:[Math.round(jawsVal||0),Math.round(vpsVal||0)],backgroundColor:['#4f8ef7','#2dd4bf'],borderWidth:0,hoverOffset:4}]},
        options:{responsive:true,maintainAspectRatio:false,cutout:'70%',plugins:{legend:{display:false},tooltip:{callbacks:{label:(ctx:any)=>`${ctx.label}: ${fmt(ctx.raw)}`}}}}
      })
    }
    buildChart()
    return()=>{if(chartRef.current){chartRef.current.destroy();chartRef.current=null}}
  },[jawsVal,vpsVal])
  return <div style={{position:'relative',height:120,width:120}}><canvas ref={canvasRef} id={chartId} role="img" aria-label="JAWS vs VPS split donut chart"/></div>
}

// ── Chatbot ──────────────────────────────────────────────────
interface ChatMsg{role:'user'|'assistant';content:string}
function Chatbot({dashData}:{dashData:DashData|null}) {
  const [msgs,setMsgs]=useState<ChatMsg[]>([{role:'assistant',content:"G'day! Connected to both JAWS and VPS live. Ask me about revenue, P&L, invoices, stock, payables or distributors."}])
  const [input,setInput]=useState('')
  const [loading,setLoading]=useState(false)
  const bottomRef=useRef<HTMLDivElement>(null)
  useEffect(()=>{bottomRef.current?.scrollIntoView({behavior:'smooth'})},[msgs])

  const ctx=useCallback(()=>{
    if (!dashData) return 'Just Autos assistant. Data loading.'
    const jOpen =rowsToObjects(dashData.jaws.openInvoices) as Invoice[]
    const vOpen =rowsToObjects(dashData.vps.openInvoices)  as Invoice[]
    const jCust =rowsToObjects(dashData.jaws.topCustomers) as Customer[]
    const vCust =rowsToObjects(dashData.vps.topCustomers)  as Customer[]
    const jPnl  =rowsToObjects(dashData.jaws.pnl)          as PnLLine[]
    const vPnl  =rowsToObjects(dashData.vps.pnl)           as PnLLine[]
    const jBills=rowsToObjects(dashData.jaws.openBills)    as Bill[]
    const vBills=rowsToObjects(dashData.vps.openBills)     as Bill[]
    const stock =rowsToObjects(dashData.jaws.stockItems)   as StockItem[]
    const jOut  =jOpen.reduce((s,i)=>s+(i.BalanceDueAmount||0),0)
    const vOut  =vOpen.reduce((s,i)=>s+(i.BalanceDueAmount||0),0)
    const jInc  =jPnl.filter(r=>r.AccountDisplayID?.startsWith('4-')&&r.AccountTotal>0).reduce((s,r)=>s+r.AccountTotal,0)
    const jExp  =jPnl.filter(r=>r.AccountDisplayID?.startsWith('5-')&&r.AccountTotal>0).reduce((s,r)=>s+r.AccountTotal,0)
    const vInc  =vPnl.filter(r=>r.AccountDisplayID?.startsWith('4-')&&r.AccountTotal>0).reduce((s,r)=>s+r.AccountTotal,0)
    const vExp  =vPnl.filter(r=>r.AccountDisplayID?.startsWith('5-')&&r.AccountTotal>0).reduce((s,r)=>s+r.AccountTotal,0)
    const vWages=vPnl.find(r=>r.AccountDisplayID==='6-5130')?.AccountTotal||0
    const vAds  =vPnl.filter(r=>r.AccountDisplayID?.startsWith('6-12')&&r.AccountTotal>0).reduce((s,r)=>s+r.AccountTotal,0)
    const jBOut =jBills.reduce((s,b)=>s+(b.BalanceDueAmount||0),0)
    const stockVal=dashData.jaws.stockSummary?.results?.[0]?.rows?.[0]?.[0]||0
    return `Just Autos Management Assistant — LIVE MYOB data as of ${new Date(dashData.fetchedAt).toLocaleString('en-AU')}.

JAWS WHOLESALE:
- Open receivables: ${jOpen.length} invoices = $${Math.round(jOut).toLocaleString()}
- Top open: ${jOpen.slice(0,3).map(i=>`${i.Number} ${i.CustomerName?.substring(0,18)} $${Math.round(i.BalanceDueAmount).toLocaleString()}`).join(' | ')}
- Top customers: ${jCust.slice(0,5).map(c=>`${c.CustomerName?.substring(0,18)} $${Math.round(c.TotalRevenue).toLocaleString()}`).join(' | ')}
- P&L income: $${Math.round(jInc).toLocaleString()} | COS: $${Math.round(jExp).toLocaleString()} | Net: ${jInc-jExp>=0?'+':''}$${Math.round(jInc-jExp).toLocaleString()}
- Top income: Multimap $37.5k | Tuning Default $28.3k | Easy Lock $16.3k | Exhaust $9.4k | Airbox $4.8k
- Stock on hand: $${Math.round(stockVal).toLocaleString()} across ${dashData.jaws.stockSummary?.results?.[0]?.rows?.[0]?.[1]||0} SKUs
- Payables: $${Math.round(jBOut).toLocaleString()} — FFM Fabrication $49k, MPI Automotive $${Math.round(jBills.filter(b=>b.SupplierName?.includes('MPI')).reduce((s,b)=>s+(b.BalanceDueAmount||0),0)).toLocaleString()}
- 6mo income trend: ${dashData.jaws.income6.map(v=>'$'+Math.round(v/1000)+'k').join(', ')}

VPS WORKSHOP:
- Open receivables: ${vOpen.length} invoices = $${Math.round(vOut).toLocaleString()}
- Top open: ${vOpen.slice(0,3).map(i=>`${i.Number} ${i.CustomerName?.substring(0,18)} $${Math.round(i.BalanceDueAmount).toLocaleString()}`).join(' | ')}
- Top customers: ${vCust.slice(0,5).map(c=>`${c.CustomerName?.substring(0,18)} $${Math.round(c.TotalRevenue).toLocaleString()}`).join(' | ')}
- P&L income: $${Math.round(vInc).toLocaleString()} | COS: $${Math.round(vExp).toLocaleString()} | Net before overheads: ${vInc-vExp>=0?'+':''}$${Math.round(vInc-vExp).toLocaleString()}
- Top income lines: Labour $79.5k | Multi Map $58.5k | Remap $29.1k | Exhausts $23.8k | Clutches $19.6k | Turbos $18.1k | JA Lock Up $16.3k
- Key overheads: Wages $${Math.round(vWages).toLocaleString()} | Advertising $${Math.round(vAds).toLocaleString()} | Rent $14.3k | Superannuation $17.7k
- Goodwill Licence Fee this month: $100,000
- 6mo income trend: ${dashData.vps.income6.map(v=>'$'+Math.round(v/1000)+'k').join(', ')}
- Payables: $${Math.round(vBills.reduce((s,b)=>s+(b.BalanceDueAmount||0),0)).toLocaleString()}

DISTRIBUTORS: 14 active AU + international. Key: Morpowa, Penrith 4x4, Banana Coast Diesel, Cutlers Diesel, Weirys Diesel, HQ Builds, Torrisi Motorsport, CP Performance, US CruiserZ.

Be concise. Use AU currency. Reference specific numbers and invoice IDs.`
  },[dashData])

  async function send() {
    if (!input.trim()||loading) return
    const userMsg:ChatMsg={role:'user',content:input.trim()}
    const newH=[...msgs,userMsg]
    setMsgs(newH);setInput('');setLoading(true)
    try {
      const r=await fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({messages:newH,context:ctx()})})
      const d=await r.json()
      setMsgs(prev=>[...prev,{role:'assistant',content:d.reply||d.error||'Something went wrong.'}])
    } catch(e:any) { setMsgs(prev=>[...prev,{role:'assistant',content:`Connection error: ${e.message}`}]) }
    setLoading(false)
  }
  const chips=['VPS P&L breakdown','JAWS vs VPS revenue','What do we owe suppliers?','Biggest open invoices','Top distributors this month']
  return (
    <div style={{width:290,minWidth:290,borderLeft:`1px solid ${T.border}`,background:T.bg2,display:'flex',flexDirection:'column',height:'100%',flexShrink:0}}>
      <div style={{padding:'14px 16px',borderBottom:`1px solid ${T.border}`,display:'flex',alignItems:'center',gap:10,flexShrink:0}}>
        <div style={{width:28,height:28,borderRadius:8,background:'linear-gradient(135deg,#4f8ef7,#a78bfa)',display:'flex',alignItems:'center',justifyContent:'center',fontSize:12,fontWeight:600,color:'#fff',flexShrink:0}}>AI</div>
        <div>
          <div style={{fontSize:13,fontWeight:500,color:T.text}}>JA Assistant</div>
          <div style={{fontSize:10,color:dashData?T.green:T.text3,display:'flex',alignItems:'center',gap:4}}>
            <span style={{width:5,height:5,borderRadius:'50%',background:dashData?T.green:T.text3,display:'inline-block'}}/>
            {dashData?'JAWS + VPS live':'Loading…'}
          </div>
        </div>
      </div>
      <div style={{flex:1,overflowY:'auto',padding:12,display:'flex',flexDirection:'column',gap:10}}>
        {msgs.map((m,i)=>(
          <div key={i} style={{alignSelf:m.role==='user'?'flex-end':'flex-start',maxWidth:'90%'}}>
            <div style={{padding:'9px 12px',borderRadius:10,fontSize:12.5,lineHeight:1.5,whiteSpace:'pre-wrap',
              background:m.role==='user'?'rgba(79,142,247,0.18)':T.bg3,
              border:m.role==='user'?'1px solid rgba(79,142,247,0.25)':`1px solid ${T.border}`,
              borderBottomRightRadius:m.role==='user'?3:10,borderBottomLeftRadius:m.role==='assistant'?3:10,color:T.text
            }}>{m.content}</div>
          </div>
        ))}
        {loading&&<div style={{alignSelf:'flex-start'}}><div style={{background:T.bg3,border:`1px solid ${T.border}`,borderRadius:10,borderBottomLeftRadius:3,padding:'10px 14px',display:'flex',gap:5}}>
          {[0,1,2].map(i=><div key={i} style={{width:6,height:6,borderRadius:'50%',background:T.text3,animation:`bounce 1.2s ease ${i*0.2}s infinite`}}/>)}
        </div></div>}
        <div ref={bottomRef}/>
      </div>
      <div style={{padding:'6px 10px',borderTop:`1px solid ${T.border}`,display:'flex',flexWrap:'wrap',gap:4,flexShrink:0}}>
        {chips.map(c=><button key={c} onClick={()=>setInput(c)} style={{fontSize:10,padding:'3px 8px',borderRadius:20,background:T.bg3,color:T.text2,border:`1px solid ${T.border}`,cursor:'pointer',fontFamily:'inherit'}}>{c}</button>)}
      </div>
      <div style={{padding:'8px 12px',borderTop:`1px solid ${T.border}`,flexShrink:0}}>
        <div style={{display:'flex',gap:7,alignItems:'flex-end'}}>
          <textarea value={input} onChange={e=>setInput(e.target.value)}
            onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send()}}}
            placeholder="Ask about JAWS, VPS, P&L, stock…" rows={1}
            style={{flex:1,background:T.bg3,border:`1px solid ${T.border}`,borderRadius:8,padding:'8px 10px',fontSize:12.5,color:T.text,fontFamily:'inherit',outline:'none',resize:'none',minHeight:34,maxHeight:80,lineHeight:1.4}}/>
          <button onClick={send} disabled={loading||!input.trim()}
            style={{width:32,height:32,borderRadius:7,background:loading||!input.trim()?T.bg4:'#4f8ef7',border:'none',color:'#fff',cursor:loading||!input.trim()?'not-allowed':'pointer',fontSize:14,flexShrink:0}}>↑</button>
        </div>
      </div>
      <style>{`@keyframes bounce{0%,60%,100%{transform:translateY(0)}30%{transform:translateY(-5px)}}`}</style>
    </div>
  )
}

// ── Main Portal ──────────────────────────────────────────────
export default function Portal() {
  const router=useRouter()
  const [section,setSection]=useState<Section>('overview')
  const [dash,setDash]=useState<DashData|null>(null)
  const [loading,setLoading]=useState(true)
  const [refreshing,setRefreshing]=useState(false)
  const [dateLoading,setDateLoading]=useState(false)
  const [error,setError]=useState('')
  const [lastRefresh,setLastRefresh]=useState<Date|null>(null)
    // FY date range — AU financial year (1 Jul → 30 Jun)
    const currentFY = new Date().getMonth() >= 6 ? new Date().getFullYear()+1 : new Date().getFullYear()
    const [fyYear, setFyYear] = useState(currentFY)
    const [showFyDropdown, setShowFyDropdown] = useState(false)
    // Default to current month for fast initial load
    const nowD = new Date()
    const defaultStart = `${nowD.getFullYear()}-${String(nowD.getMonth()+1).padStart(2,'0')}-01`
    const defaultEnd = `${nowD.getFullYear()}-${String(nowD.getMonth()+1).padStart(2,'0')}-${new Date(nowD.getFullYear(), nowD.getMonth()+1, 0).getDate()}`
    // Custom date range
    const [customStart, setCustomStart] = useState(defaultStart)
    const [customEnd, setCustomEnd] = useState(defaultEnd)
    const [isCustomRange, setIsCustomRange] = useState(true) // start as custom (current month)

    // Active date range — either FY-derived or custom
    const activeStart = isCustomRange ? customStart : `${fyYear-1}-07-01`
    const activeEnd = isCustomRange ? customEnd : `${fyYear}-06-30`
    const dateParams = `startDate=${activeStart}&endDate=${activeEnd}`

    const fyLabel = isCustomRange
      ? `${new Date(customStart+'T00:00').toLocaleDateString('en-AU',{day:'2-digit',month:'short',year:'2-digit'})} – ${new Date(customEnd+'T00:00').toLocaleDateString('en-AU',{day:'2-digit',month:'short',year:'2-digit'})}`
      : `FY${fyYear}`

    // Track the dateParams string so load re-fires when it changes
    const [activeDateParams, setActiveDateParams] = useState(dateParams)

    function selectFY(y: number) {
      setFyYear(y)
      setIsCustomRange(false)
      setCustomStart(`${y-1}-07-01`)
      setCustomEnd(`${y}-06-30`)
      setDateLoading(true)
      setActiveDateParams(`startDate=${y-1}-07-01&endDate=${y}-06-30`)
    }

    function applyCustomRange() {
      if (customStart && customEnd) {
        setIsCustomRange(true)
        setDateLoading(true)
        setActiveDateParams(`startDate=${customStart}&endDate=${customEnd}`)
      }
    }

  const load=useCallback(async(isRefresh=false)=>{
    if(isRefresh)setRefreshing(true)
    try{
      const refreshParam = isRefresh ? '&refresh=true' : ''
      // Step 1: Load core data fast (invoices, P&L, customers)
      const r=await fetch(`/api/dashboard?${activeDateParams}${refreshParam}`)
      if(r.status===401){router.push('/login');return}
      if(!r.ok)throw new Error('Failed to load data')
      const d=await r.json()
      // Set defaults for trend data so charts render immediately
      d.trendLabels=['Nov 25','Dec 25','Jan 26','Feb 26','Mar 26','Apr 26']
      d.jaws.income6=[468903,496206,623279,569129,705165,116239]
      d.vps.income6 =[905849,615285,731524,800866,891330,344080]
      d.jaws.expense6=[380000,400000,510000,460000,580000,186111]
      d.vps.expense6 =[780000,520000,620000,680000,760000, 99262]
      setDash(d);setLastRefresh(new Date());setError('');setDateLoading(false)
      setLoading(false)
      if(isRefresh)setRefreshing(false)
      // Step 2: Load live trend data in background
      try{
        const tr=await fetch(`/api/trends?${activeDateParams}${refreshParam}`)
        if(tr.ok){
          const td=await tr.json()
          setDash((prev:any)=>prev?{...prev,
            trendLabels:td.trendLabels,
            jaws:{...prev.jaws,income6:td.jawsIncome6,expense6:td.jawsExpense6},
            vps: {...prev.vps, income6:td.vpsIncome6, expense6:td.vpsExpense6},
          }:prev)
        }
      }catch{}
    }catch(e:any){setError(e.message);setLoading(false);setDateLoading(false);if(isRefresh)setRefreshing(false)}
  },[router, activeDateParams])
  useEffect(()=>{load()},[load])
  useEffect(()=>{const t=setInterval(()=>load(true),5*60*1000);return()=>clearInterval(t)},[load])

  // Derived
  const jInv   =dash?rowsToObjects(dash.jaws.recentInvoices) as Invoice[]:[]
  const jOpen  =dash?rowsToObjects(dash.jaws.openInvoices)   as Invoice[]:[]
  const vInv   =dash?rowsToObjects(dash.vps.recentInvoices)  as Invoice[]:[]
  const vOpen  =dash?rowsToObjects(dash.vps.openInvoices)    as Invoice[]:[]
  const jCust  =dash?rowsToObjects(dash.jaws.topCustomers)   as Customer[]:[]
  const vCust  =dash?rowsToObjects(dash.vps.topCustomers)    as Customer[]:[]
  const jPnl   =dash?rowsToObjects(dash.jaws.pnl)            as PnLLine[]:[]
  const vPnl   =dash?rowsToObjects(dash.vps.pnl)             as PnLLine[]:[]
  const stock  =dash?rowsToObjects(dash.jaws.stockItems)     as StockItem[]:[]
  const jBills =dash?rowsToObjects(dash.jaws.openBills)      as Bill[]:[]
  const vBills =dash?rowsToObjects(dash.vps.openBills)       as Bill[]:[]

  const jOut   =jOpen.reduce((s,i)=>s+(i.BalanceDueAmount||0),0)
  const vOut   =vOpen.reduce((s,i)=>s+(i.BalanceDueAmount||0),0)
  const jInc   =jPnl.filter(r=>r.AccountDisplayID?.startsWith('4-')&&r.AccountTotal>0).reduce((s,r)=>s+r.AccountTotal,0)
  const jCos   =jPnl.filter(r=>r.AccountDisplayID?.startsWith('5-')&&r.AccountTotal>0).reduce((s,r)=>s+r.AccountTotal,0)
  const vInc   =vPnl.filter(r=>r.AccountDisplayID?.startsWith('4-')&&r.AccountTotal>0).reduce((s,r)=>s+r.AccountTotal,0)
  const vCos   =vPnl.filter(r=>r.AccountDisplayID?.startsWith('5-')&&r.AccountTotal>0).reduce((s,r)=>s+r.AccountTotal,0)
  const vOh    =vPnl.filter(r=>r.AccountDisplayID?.startsWith('6-')&&r.AccountTotal>0).reduce((s,r)=>s+r.AccountTotal,0)
  const jNet   =jInc-jCos
  const vNet   =vInc-vCos-vOh
  const jBOut  =jBills.reduce((s,b)=>s+(b.BalanceDueAmount||0),0)
  const vBOut  =vBills.reduce((s,b)=>s+(b.BalanceDueAmount||0),0)
  const stockVal=dash?.jaws.stockSummary?.results?.[0]?.rows?.[0]?.[0]||0
  const tLabels =dash?.trendLabels||[]
  const jInc6   =dash?.jaws.income6||[]
  const vInc6   =dash?.vps.income6||[]
  const jExp6   =dash?.jaws.expense6||[]
  const vExp6   =dash?.vps.expense6||[]
  const jNet6   =jInc6.map((v,i)=>v-(jExp6[i]||0))
  const vNet6   =vInc6.map((v,i)=>v-(vExp6[i]||0))

  const PnlSection=({entity,pnl,inc,cos,oh,accent}:{entity:string;pnl:PnLLine[];inc:number;cos:number;oh:number;accent:string})=>{
    const income =pnl.filter(r=>r.AccountDisplayID?.startsWith('4-')&&r.AccountTotal>0).sort((a,b)=>b.AccountTotal-a.AccountTotal)
    const cosRows=pnl.filter(r=>r.AccountDisplayID?.startsWith('5-')&&r.AccountTotal>0).sort((a,b)=>b.AccountTotal-a.AccountTotal)
    const ohRows =pnl.filter(r=>r.AccountDisplayID?.startsWith('6-')&&r.AccountTotal>0).sort((a,b)=>b.AccountTotal-a.AccountTotal)
    const maxInc =income[0]?.AccountTotal||1
    const maxCos =cosRows[0]?.AccountTotal||1
    const maxOh  =ohRows[0]?.AccountTotal||1
    return <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:12}}>
      <Card>
        <PTitle>Income — {entity} <span style={{color:T.green}}>({fmt(inc)})</span></PTitle>
        {income.slice(0,8).map((r,i)=><BarRow key={i} name={r.AccountName} value={r.AccountTotal} max={maxInc} color={T.green}/>)}
      </Card>
      <Card>
        <PTitle>Cost of sales — {entity} <span style={{color:T.red}}>({fmt(cos)})</span></PTitle>
        {cosRows.slice(0,8).map((r,i)=><BarRow key={i} name={r.AccountName} value={r.AccountTotal} max={maxCos} color={T.red}/>)}
      </Card>
      {entity==='VPS'&&<Card>
        <PTitle>Overheads — {entity} <span style={{color:T.amber}}>({fmt(oh)})</span></PTitle>
        {ohRows.slice(0,8).map((r,i)=><BarRow key={i} name={r.AccountName} value={r.AccountTotal} max={maxOh} color={T.amber}/>)}
      </Card>}
      {entity==='JAWS'&&<Card>
        <PTitle>Net margin — {entity}</PTitle>
        <div style={{textAlign:'center',paddingTop:20}}>
          <div style={{fontSize:32,fontWeight:500,fontFamily:'monospace',color:jNet>=0?T.green:T.red}}>{jNet>=0?'+':''}{fmt(jNet)}</div>
          <div style={{fontSize:12,color:T.text3,marginTop:6}}>Income − Cost of sales</div>
          <div style={{fontSize:12,color:T.text3,marginTop:3}}>Margin: {pct(jNet,jInc)}</div>
        </div>
      </Card>}
    </div>
  }

  function renderSection() {
    if(loading) return <div style={{display:'flex',alignItems:'center',justifyContent:'center',height:300,flexDirection:'column',gap:12}}>
      <div style={{fontSize:28,animation:'spin 1s linear infinite',color:T.text3}}>⟳</div>
      <div style={{color:T.text3}}>Loading live MYOB data…</div>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
    if(error) return <div style={{background:'rgba(240,78,78,0.1)',border:'1px solid rgba(240,78,78,0.2)',borderRadius:10,padding:20,color:T.red}}>Error: {error}</div>

    // ── OVERVIEW ────────────────────────────────────────────
    if(section==='overview') return <div style={{display:'flex',flexDirection:'column',gap:14}}>
      <div style={{display:'grid',gridTemplateColumns:'repeat(4,minmax(0,1fr))',gap:12}}>
                    <KPI label={`JAWS Revenue (${fyLabel})`}    value={fmt(jInc)}   sub="Income this period" accent={T.blue}/>
                    <KPI label={`VPS Revenue (${fyLabel})`}     value={fmt(vInc)}   sub="Income this period" accent={T.teal}/>
        <div onClick={()=>setSection('invoices')} style={{cursor:'pointer'}}>
          <KPI label="Total Receivables"   value={fmt(jOut+vOut)}   sub={`${jOpen.length+vOpen.length} open — click to view`} subColor={T.amber} accent={T.amber}/>
        </div>
        <div onClick={()=>setSection('stock')} style={{cursor:'pointer'}}>
          <KPI label="JAWS Stock on Hand"  value={fmt(stockVal)}    sub={`${dash?.jaws.stockSummary?.results?.[0]?.rows?.[0]?.[1]||0} SKUs — click to view`} accent={T.purple}/>
        </div>
      </div>

      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}}>
        <Card>
          <PTitle>Revenue trend — JAWS vs VPS (6 months)</PTitle>
          <div style={{display:'flex',gap:14,marginBottom:10}}>
            {[{l:'JAWS',c:T.blue},{l:'VPS',c:T.teal}].map(s=><div key={s.l} style={{display:'flex',alignItems:'center',gap:5,fontSize:12,color:T.text2}}><div style={{width:10,height:10,borderRadius:2,background:s.c}}/>{s.l}</div>)}
          </div>
          <TrendChart labels={tLabels} jawsData={jInc6} vpsData={vInc6} title="Revenue trend" chartId="rev-trend"/>
        </Card>
        <Card>
          <PTitle>Revenue split — this month</PTitle>
          <div style={{display:'flex',alignItems:'center',gap:20,justifyContent:'center',paddingTop:10}}>
            <DonutChart jawsVal={jInc} vpsVal={vInc} chartId="rev-split"/>
            <div style={{display:'flex',flexDirection:'column',gap:10}}>
              <div>
                <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:3}}><div style={{width:10,height:10,borderRadius:2,background:T.blue}}/><span style={{fontSize:12,color:T.text2}}>JAWS</span></div>
                <div style={{fontSize:18,fontWeight:500,fontFamily:'monospace',color:T.text}}>{fmt(jInc)}</div>
                <div style={{fontSize:11,color:T.text3}}>Gross: {pct(jNet,jInc)} margin</div>
              </div>
              <div>
                <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:3}}><div style={{width:10,height:10,borderRadius:2,background:T.teal}}/><span style={{fontSize:12,color:T.text2}}>VPS</span></div>
                <div style={{fontSize:18,fontWeight:500,fontFamily:'monospace',color:T.text}}>{fmt(vInc)}</div>
                <div style={{fontSize:11,color:T.text3}}>After COS: {pct(vInc-vCos,vInc)} margin</div>
              </div>
            </div>
          </div>
        </Card>
      </div>

      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}}>
        <Card>
          <PTitle>Top customers — JAWS this month</PTitle>
          {jCust.slice(0,6).map((c,i)=><BarRow key={i} name={c.CustomerName?.substring(0,26)} value={c.TotalRevenue} max={jCust[0]?.TotalRevenue||1} extra={`${c.InvoiceCount}inv`}/>)}
        </Card>
        <Card>
          <PTitle>Top customers — VPS this month</PTitle>
          {vCust.filter(c=>!c.CustomerName?.includes('Just Autos Wholesale')).slice(0,6).map((c,i)=><BarRow key={i} name={c.CustomerName?.substring(0,26)} value={c.TotalRevenue} max={vCust[1]?.TotalRevenue||1} color={T.teal} extra={`${c.InvoiceCount}inv`}/>)}
        </Card>
      </div>

      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}}>
        <Card>
          <PTitle>Outstanding receivables <span onClick={()=>setSection('invoices')} style={{color:T.blue,cursor:'pointer',fontWeight:400,fontSize:10,textTransform:'none',letterSpacing:0}}>View all →</span></PTitle>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:12}}>
            <div onClick={()=>setSection('invoices')} style={{background:T.bg3,borderRadius:8,padding:'10px 12px',cursor:'pointer'}}>
              <div style={{fontSize:10,color:T.text3,marginBottom:4}}>JAWS</div>
              <div style={{fontSize:18,fontWeight:500,fontFamily:'monospace',color:T.amber}}>{fmt(jOut)}</div>
              <div style={{fontSize:11,color:T.blue,marginTop:2}}>{jOpen.length} open — click to view</div>
            </div>
            <div onClick={()=>setSection('invoices')} style={{background:T.bg3,borderRadius:8,padding:'10px 12px',cursor:'pointer'}}>
              <div style={{fontSize:10,color:T.text3,marginBottom:4}}>VPS</div>
              <div style={{fontSize:18,fontWeight:500,fontFamily:'monospace',color:T.amber}}>{fmt(vOut)}</div>
              <div style={{fontSize:11,color:T.blue,marginTop:2}}>{vOpen.length} open — click to view</div>
            </div>
          </div>
          {[...jOpen.slice(0,2).map(i=>({...i,e:'JAWS'})),...vOpen.slice(0,2).map(i=>({...i,e:'VPS'}))].map((inv:any,i)=>(
            <div key={i} onClick={()=>setSection('invoices')} style={{display:'flex',gap:8,padding:'6px 0',borderTop:`1px solid ${T.border}`,cursor:'pointer'}}
              onMouseEnter={e=>{(e.currentTarget as HTMLElement).style.background='rgba(255,255,255,0.03)'}}
              onMouseLeave={e=>{(e.currentTarget as HTMLElement).style.background='transparent'}}>
              <div style={{width:6,height:6,borderRadius:'50%',background:inv.e==='JAWS'?T.blue:T.teal,flexShrink:0,marginTop:5}}/>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:12,color:T.amber,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',fontFamily:'monospace'}}>{inv.Number} — {inv.CustomerName?.substring(0,24)}</div>
                <div style={{fontSize:10,color:T.text3,fontFamily:'monospace',marginTop:1}}>{fmtFull(inv.BalanceDueAmount)} · {inv.e} · {fmtDate(inv.Date)}</div>
              </div>
            </div>
          ))}
        </Card>
        <Card>
          <PTitle>Net result trend (6 months)</PTitle>
          <div style={{display:'flex',gap:14,marginBottom:10}}>
            {[{l:'JAWS',c:T.blue},{l:'VPS gross',c:T.teal}].map(s=><div key={s.l} style={{display:'flex',alignItems:'center',gap:5,fontSize:12,color:T.text2}}><div style={{width:10,height:10,borderRadius:2,background:s.c}}/>{s.l}</div>)}
          </div>
          <LineChart labels={tLabels} jawsData={jNet6} vpsData={vNet6} chartId="net-trend"/>
        </Card>
      </div>
    </div>

    // ── JAWS ────────────────────────────────────────────────
    if(section==='jaws') return <div style={{display:'flex',flexDirection:'column',gap:14}}>
      <div style={{display:'grid',gridTemplateColumns:'repeat(4,minmax(0,1fr))',gap:12}}>
        <KPI label="Income (MTD)"      value={fmt(jInc)}   sub="This month"   accent={T.blue}/>
        <KPI label="Cost of Sales"     value={fmt(jCos)}   sub={`Margin: ${pct(jNet,jInc)}`} subColor={T.red} accent={T.red}/>
        <KPI label="Net (MTD)"         value={fmt(jNet)}   sub="Income − COS" subColor={jNet>=0?T.green:T.red} accent={jNet>=0?T.green:T.red}/>
        <KPI label="Receivables"       value={fmt(jOut)}   sub={`${jOpen.length} open`} subColor={T.amber} accent={T.amber}/>
      </div>
      <div style={{display:'grid',gridTemplateColumns:'1.4fr 1fr',gap:12}}>
        <Card>
          <PTitle>Revenue trend — JAWS (6 months)</PTitle>
          <TrendChart labels={tLabels} jawsData={jInc6} vpsData={jExp6} title="JAWS income vs expenses" chartId="jaws-trend"/>
        </Card>
        <Card>
          <PTitle>Top customers this month</PTitle>
          {jCust.slice(0,8).map((c,i)=><BarRow key={i} name={c.CustomerName?.replace(' (Tuning)','').replace(' (Tuning 1)','').substring(0,26)} value={c.TotalRevenue} max={jCust[0]?.TotalRevenue||1} extra={`${c.InvoiceCount}inv`}/>)}
        </Card>
      </div>
      <Card><PTitle>Recent invoices — JAWS</PTitle><InvoiceTable rows={jInv} accent={T.blue} onOpenInvoiceClick={()=>setSection('invoices')}/></Card>
    </div>

    // ── VPS ─────────────────────────────────────────────────
    if(section==='vps') return <div style={{display:'flex',flexDirection:'column',gap:14}}>
      <div style={{display:'grid',gridTemplateColumns:'repeat(4,minmax(0,1fr))',gap:12}}>
        <KPI label="Income (MTD)"      value={fmt(vInc)}    sub="This month"    accent={T.teal}/>
        <KPI label="Cost of Sales"     value={fmt(vCos)}    sub={`Gross margin: ${pct(vInc-vCos,vInc)}`} subColor={T.red} accent={T.red}/>
        <KPI label="Overheads"         value={fmt(vOh)}     sub="Wages, ads, rent etc" subColor={T.amber} accent={T.amber}/>
        <KPI label="Receivables"       value={fmt(vOut)}    sub={`${vOpen.length} open`} subColor={T.amber} accent={T.amber}/>
      </div>
      <div style={{display:'grid',gridTemplateColumns:'1.4fr 1fr',gap:12}}>
        <Card>
          <PTitle>Revenue trend — VPS (6 months)</PTitle>
          <TrendChart labels={tLabels} jawsData={vInc6} vpsData={vExp6} title="VPS income vs expenses" chartId="vps-trend"/>
        </Card>
        <Card>
          <PTitle>Top customers this month</PTitle>
          {vCust.filter(c=>!c.CustomerName?.includes('Just Autos Wholesale')).slice(0,8).map((c,i)=><BarRow key={i} name={c.CustomerName?.substring(0,26)} value={c.TotalRevenue} max={vCust[1]?.TotalRevenue||1} color={T.teal} extra={`${c.InvoiceCount}inv`}/>)}
        </Card>
      </div>
      <Card><PTitle>Recent invoices — VPS</PTitle><InvoiceTable rows={vInv} accent={T.teal} onOpenInvoiceClick={()=>setSection('invoices')}/></Card>
    </div>

    // ── INVOICES ─────────────────────────────────────────────
    if(section==='invoices') return <div style={{display:'flex',flexDirection:'column',gap:14}}>
      <div style={{display:'grid',gridTemplateColumns:'repeat(4,minmax(0,1fr))',gap:12}}>
        <KPI label="JAWS Outstanding" value={fmt(jOut)} sub={`${jOpen.length} open`} subColor={T.amber} accent={T.blue}/>
        <KPI label="VPS Outstanding"  value={fmt(vOut)} sub={`${vOpen.length} open`} subColor={T.amber} accent={T.teal}/>
        <KPI label="Combined"         value={fmt(jOut+vOut)} sub="Total receivable" subColor={T.red}/>
        <KPI label="Open Count"       value={String(jOpen.length+vOpen.length)} sub="Both entities"/>
      </div>
      <Card><PTitle>JAWS — Recent invoices <Tag color={T.blue}>Live MYOB</Tag></PTitle><InvoiceTable rows={jInv} accent={T.blue} onOpenInvoiceClick={()=>setSection('invoices')}/></Card>
      <Card><PTitle>VPS — Recent invoices <Tag color={T.teal}>Live MYOB</Tag></PTitle><InvoiceTable rows={vInv}  accent={T.teal} onOpenInvoiceClick={()=>setSection('invoices')}/></Card>
    </div>

    // ── P&L ──────────────────────────────────────────────────
    if(section==='pnl') return <div style={{display:'flex',flexDirection:'column',gap:14}}>
      <div style={{display:'grid',gridTemplateColumns:'repeat(4,minmax(0,1fr))',gap:12}}>
        <KPI label="JAWS Income"      value={fmt(jInc)} subColor={T.green}  sub="This month" accent={T.blue}/>
        <KPI label="JAWS Net (COS)"   value={fmt(jNet)} subColor={jNet>=0?T.green:T.red} sub={`Margin: ${pct(jNet,jInc)}`} accent={jNet>=0?T.green:T.red}/>
        <KPI label="VPS Income"       value={fmt(vInc)} subColor={T.green}  sub="This month" accent={T.teal}/>
        <KPI label="VPS Gross (COS)"  value={fmt(vInc-vCos)} subColor={vInc-vCos>=0?T.green:T.red} sub={`Overheads: ${fmt(vOh)}`} accent={vInc-vCos>=0?T.green:T.red}/>
      </div>
      <PnlSection entity="JAWS" pnl={jPnl} inc={jInc} cos={jCos} oh={0} accent={T.blue}/>
      <Divider/>
      <PnlSection entity="VPS"  pnl={vPnl} inc={vInc} cos={vCos} oh={vOh} accent={T.teal}/>
    </div>

    // ── STOCK ────────────────────────────────────────────────
    if(section==='stock') return <div style={{display:'flex',flexDirection:'column',gap:14}}>
      <div style={{display:'grid',gridTemplateColumns:'repeat(4,minmax(0,1fr))',gap:12}}>
        <KPI label="JAWS Stock Value"  value={fmt(stockVal)} sub={`${dash?.jaws.stockSummary?.results?.[0]?.rows?.[0]?.[1]||0} SKUs`} accent={T.purple}/>
        <KPI label="VPS Stock Value"   value="N/A" sub="Workshop — no held stock" accent={T.text3}/>
        <KPI label="Top Item"          value={stock[0]?fmt(stock[0].CurrentValue):'—'} sub={stock[0]?.Name?.substring(0,20)} accent={T.blue}/>
        <KPI label="Total Committed"   value={String(stock.reduce((s,i)=>s+(i.QuantityCommitted||0),0))} sub="Units on order"/>
      </div>
      <Card>
        <PTitle>Stock on hand — JAWS (top 20 by value, live MYOB)</PTitle>
        <div style={{overflowX:'auto'}}>
          <table style={{width:'100%',borderCollapse:'collapse'}}>
            <thead><tr>{['Item','Stock Value','Qty On Hand','Qty Committed','Avg Cost','Sell Price'].map(h=>(
              <th key={h} style={{fontSize:10,color:T.text3,textTransform:'uppercase',letterSpacing:'0.07em',padding:'0 8px 10px',textAlign:h==='Item'?'left':'right',fontWeight:500,whiteSpace:'nowrap'}}>{h}</th>
            ))}</tr></thead>
            <tbody>{stock.map((s,i)=>(
              <tr key={i} style={{borderTop:`1px solid ${T.border}`}}>
                <td style={{fontSize:12,color:T.text2,padding:'7px 8px'}}>{s.Name}</td>
                <td style={{fontSize:12,fontFamily:'monospace',color:T.purple,padding:'7px 8px',textAlign:'right'}}>{fmtFull(s.CurrentValue)}</td>
                <td style={{fontSize:12,fontFamily:'monospace',color:T.text,padding:'7px 8px',textAlign:'right'}}>{s.QuantityOnHand}</td>
                <td style={{fontSize:12,fontFamily:'monospace',color:s.QuantityCommitted>0?T.amber:T.text3,padding:'7px 8px',textAlign:'right'}}>{s.QuantityCommitted||0}</td>
                <td style={{fontSize:12,fontFamily:'monospace',color:T.text3,padding:'7px 8px',textAlign:'right'}}>{fmtFull(s.AverageCost)}</td>
                <td style={{fontSize:12,fontFamily:'monospace',color:T.green,padding:'7px 8px',textAlign:'right'}}>{fmtFull(s.BaseSellingPrice)}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </Card>
    </div>

    // ── PAYABLES ─────────────────────────────────────────────
    if(section==='payables') return <div style={{display:'flex',flexDirection:'column',gap:14}}>
      <div style={{display:'grid',gridTemplateColumns:'repeat(4,minmax(0,1fr))',gap:12}}>
        <KPI label="JAWS Payables"  value={fmt(jBOut)} sub={`${jBills.length} open bills`} subColor={T.red} accent={T.blue}/>
        <KPI label="VPS Payables"   value={fmt(vBOut)} sub={`${vBills.length} open bills`} subColor={T.red} accent={T.teal}/>
        <KPI label="Total Owing"    value={fmt(jBOut+vBOut)} sub="Combined payables" subColor={T.red}/>
        <KPI label="Largest Bill"   value={jBills[0]?fmt(jBills[0].BalanceDueAmount):'—'} sub={jBills[0]?.SupplierName?.substring(0,20)||'—'}/>
      </div>
      <Card><PTitle>JAWS — Open purchase bills <Tag color={T.blue}>Live MYOB</Tag></PTitle><BillTable rows={jBills} accent={T.blue}/></Card>
      <Card><PTitle>VPS — Open purchase bills <Tag color={T.teal}>Live MYOB</Tag></PTitle><BillTable rows={vBills}  accent={T.teal}/></Card>
    </div>

    // ── DISTRIBUTORS ─────────────────────────────────────────
    if(section==='distributors') {
      const dCust=jCust.filter(c=>!c.CustomerName?.includes('Vehicle Performance')&&!c.CustomerName?.includes('Stripe'))
      const maxD=dCust[0]?.TotalRevenue||1
      return <div style={{display:'flex',flexDirection:'column',gap:14}}>
        <div style={{display:'grid',gridTemplateColumns:'repeat(4,minmax(0,1fr))',gap:12}}>
          <KPI label="Active Distributors" value="14"  sub="Across Australia" accent={T.blue}/>
          <KPI label="Dist Revenue (MTD)"  value={fmt(dCust.reduce((s,c)=>s+c.TotalRevenue,0))} sub="This month" accent={T.blue}/>
          <KPI label="Avg Revenue"         value={fmt(dCust.reduce((s,c)=>s+c.TotalRevenue,0)/Math.max(dCust.length,1))} sub="Per distributor"/>
          <KPI label="Total Invoices"      value={String(dCust.reduce((s,c)=>s+c.InvoiceCount,0))} sub="This month"/>
        </div>
        <div style={{display:'grid',gridTemplateColumns:'1.4fr 1fr',gap:12}}>
          <Card>
            <PTitle>Distributor revenue — this month (live MYOB)</PTitle>
            {dCust.map((c,i)=><BarRow key={i} name={c.CustomerName?.replace(' (Tuning)','').replace(' (Tuning 1)','').substring(0,30)} value={c.TotalRevenue} max={maxD} extra={`${c.InvoiceCount}inv`}/>)}
          </Card>
          <Card>
            <PTitle>Revenue trend — JAWS (6 months)</PTitle>
            <TrendChart labels={tLabels} jawsData={jInc6} vpsData={jInc6.map(()=>0)} title="JAWS distributor revenue trend" chartId="dist-trend"/>
          </Card>
        </div>
      </div>
    }
    return null
  }

  const navItems:[Section,string,string,string?][]=[
    ['overview',    'Overview',          T.blue],
    ['jaws',        'JAWS Wholesale',    T.blue],
    ['vps',         'VPS Workshop',      T.teal],
    ['invoices',    'Invoices',          T.amber,'alert'],
    ['pnl',         'P&L — This Month',  T.green],
    ['stock',       'Stock & Inventory', T.purple],
    ['payables',    'Payables',          T.red,'alert'],
    ['distributors','Distributors',      T.blue],
  ]
  const titles:Record<Section,string>={
    overview:'Overview — Live Data',jaws:'JAWS Wholesale',vps:'VPS Workshop',
    invoices:'Invoices',pnl:'P&L — This Month',stock:'Stock & Inventory',
    payables:'Payables',distributors:'Distributors',
  }

  const openCount=jOpen.length+vOpen.length
  const billCount=jBills.length+vBills.length

  return (
    <>
      <Head>
        <title>Just Autos — Management Portal</title>
        <meta name="viewport" content="width=device-width,initial-scale=1"/>
        <meta name="robots" content="noindex,nofollow"/>
      </Head>
      <Script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js" strategy="beforeInteractive"/>

      <div style={{display:'flex',height:'100vh',overflow:'hidden',fontFamily:"'DM Sans',system-ui,sans-serif"}}>
        {/* Sidebar */}
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
            <a href="/distributors" style={{display:'flex',alignItems:'center',gap:9,padding:'8px 10px',borderRadius:7,fontSize:13,marginBottom:4,background:'rgba(79,142,247,0.1)',color:T.blue,textDecoration:'none',border:`1px solid rgba(79,142,247,0.2)`}}>
              <div style={{width:7,height:7,borderRadius:'50%',background:T.blue,flexShrink:0}}/>
              <span style={{flex:1}}>Distributor Report</span>
              <span style={{fontSize:9,fontFamily:'monospace',background:T.blue,color:'#fff',padding:'1px 5px',borderRadius:3}}>PBI</span>
            </a>
            {navItems.map(([id,label,dot,type])=>(
              <div key={id} onClick={()=>setSection(id)}
                style={{display:'flex',alignItems:'center',gap:9,padding:'8px 10px',borderRadius:7,cursor:'pointer',fontSize:13,marginBottom:1,
                  background:section===id?'rgba(79,142,247,0.15)':'transparent',color:section===id?T.blue:T.text2}}>
                <div style={{width:7,height:7,borderRadius:'50%',background:dot,flexShrink:0}}/>
                <span style={{flex:1}}>{label}</span>
                {type==='alert'&&!loading&&(
                  <span style={{fontSize:10,fontFamily:'monospace',background:'rgba(240,78,78,0.2)',color:T.red,padding:'2px 6px',borderRadius:4}}>
                    {id==='invoices'?openCount:billCount}
                  </span>
                )}
              </div>
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

        {/* Main */}
        <div style={{flex:1,display:'flex',flexDirection:'column',overflow:'hidden'}}>
          <div style={{height:52,background:T.bg2,borderBottom:`1px solid ${T.border}`,display:'flex',alignItems:'center',padding:'0 20px',gap:12,flexShrink:0}}>
            <div style={{fontSize:14,fontWeight:500,flex:1,color:T.text}}>{titles[section]}</div>
            {!loading&&<div style={{width:7,height:7,borderRadius:'50%',background:T.green,boxShadow:`0 0 8px ${T.green}`}}/>}
            <Tag color={T.green}>MYOB live</Tag>
            {!loading&&<Tag color={T.amber}>{fmt(jOut+vOut)} receivable</Tag>}
            {!loading&&<Tag color={T.purple}>{fmt(stockVal)} stock</Tag>}
                        <div style={{display:'flex',alignItems:'center',gap:6,position:'relative'}}>
                          {[currentFY-2,currentFY-1,currentFY].map(y=>(
                        <button key={y} onClick={()=>selectFY(y)}
                                              style={{padding:'3px 10px',borderRadius:4,border:'1px solid',fontSize:11,fontFamily:'monospace',fontWeight:600,cursor:'pointer',
                                                                            background:fyYear===y&&!isCustomRange?T.accent:'transparent',
                                                                            color:fyYear===y&&!isCustomRange?'#fff':T.text2,
                                                                            borderColor:fyYear===y&&!isCustomRange?T.accent:T.border}}>
                          {`FY${y}`}{y===currentFY?<span style={{width:4,height:4,borderRadius:'50%',background:T.green,display:'inline-block',marginLeft:4,verticalAlign:'middle'}}/>:null}
                        </button>
                      ))}
                          <div style={{width:1,height:18,background:T.border,margin:'0 2px'}}/>
                          <input type="date" value={customStart} onChange={e=>setCustomStart(e.target.value)}
                            style={{padding:'3px 6px',borderRadius:4,border:`1px solid ${isCustomRange?T.accent:T.border}`,fontSize:11,fontFamily:'monospace',
                              background:'transparent',color:T.text2,outline:'none',cursor:'pointer',colorScheme:'dark'}}/>
                          <span style={{fontSize:11,color:T.text3}}>→</span>
                          <input type="date" value={customEnd} onChange={e=>setCustomEnd(e.target.value)}
                            style={{padding:'3px 6px',borderRadius:4,border:`1px solid ${isCustomRange?T.accent:T.border}`,fontSize:11,fontFamily:'monospace',
                              background:'transparent',color:T.text2,outline:'none',cursor:'pointer',colorScheme:'dark'}}/>
                          <button onClick={applyCustomRange}
                            style={{padding:'3px 10px',borderRadius:4,border:`1px solid ${T.accent}`,fontSize:11,fontFamily:'monospace',fontWeight:600,cursor:'pointer',
                              background:isCustomRange?T.accent:'transparent',color:isCustomRange?'#fff':T.accent}}>
                            Apply
                          </button>
                          {dateLoading&&<span style={{fontSize:14,animation:'spin 1s linear infinite',color:T.blue}}>⟳</span>}
                        </div>
          </div>
          <div style={{flex:1,display:'flex',overflow:'hidden'}}>
            <div style={{flex:1,padding:20,overflowY:'auto',position:'relative'}}>
              {dateLoading&&<div style={{position:'absolute',inset:0,background:'rgba(13,15,18,0.75)',zIndex:10,display:'flex',alignItems:'center',justifyContent:'center',flexDirection:'column',gap:12,borderRadius:8}}>
                <div style={{fontSize:28,animation:'spin 1s linear infinite',color:T.blue}}>⟳</div>
                <div style={{color:T.text2,fontSize:13}}>Updating data for {fyLabel}…</div>
                <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
              </div>}
              {renderSection()}
            </div>
            <Chatbot dashData={dash}/>
          </div>
        </div>
      </div>
    </>
  )
}

// Server-side auth check — redirects to /login if no cookie
export async function getServerSideProps(context: any) {
  const cookie = context.req.cookies['ja_portal_auth']
  const PORTAL_PASSWORD = process.env.PORTAL_PASSWORD || 'justautos2026'
  
  if (!cookie) {
    return { redirect: { destination: '/login', permanent: false } }
  }
  
  try {
    const decoded = Buffer.from(cookie, 'base64').toString('utf8')
    if (decoded !== PORTAL_PASSWORD) {
      return { redirect: { destination: '/login', permanent: false } }
    }
  } catch {
    return { redirect: { destination: '/login', permanent: false } }
  }
  
  return { props: {} }
}
