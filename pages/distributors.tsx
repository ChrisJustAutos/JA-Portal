// pages/distributors.tsx — Updated with Supabase group-aware rendering
// This version loads groupings from /api/groups and renders the Summary tab
// as sections: Distributors first, then Sundry, then Excluded (or whatever
// groups exist in the 'type' dimension).
//
// The other tabs (Distributor Sales, Detailed Sales, National P/M, National Total)
// continue to work on the filtered (non-Excluded) data.
//
// NOTE: This is the replacement for pages/distributors.tsx. Diff vs the
// existing sidebar-update version:
//   1. Adds `grouping` state + fetch on mount
//   2. Adds `typeOf(canonical)` helper to assign each line item a type group
//   3. Summary tab renders groups-of-groups; KPIs split accordingly
//   4. Top bar adds "Manage groups" link to /admin/groups

import { useEffect, useState, useRef, useCallback } from 'react'
import Head from 'next/head'
import Script from 'next/script'
import { useRouter } from 'next/router'
import PortalSidebar from '../lib/PortalSidebar'
import { requirePageAuth } from '../lib/authServer'
import { usePreferences, applyGstDisplay } from '../lib/preferences'

interface PortalUserSSR { id: string; email: string; displayName: string | null; role: 'admin'|'manager'|'sales'|'accountant'|'viewer' }

interface LineItem {
  CustomerName: string        // CANONICAL name after alias resolution
  RawCustomerName: string     // Original MYOB name (for debugging)
  Date: string
  AccountDisplayID: string
  Description: string
  Total: number
  bucket: 'Tuning' | 'Parts' | 'Oil'
  poNumber: string
  invoiceNumber: string
  // When the "distributor" is the synthetic 'Sundry' roll-up, this holds
  // the ACTUAL customer from MYOB (so drill-down shows "Vito Media" not
  // just "Sundry"). null for real distributors.
  sundryCustomer: string | null
}
interface DistData {
  fetchedAt: string
  lineItems: LineItem[]
  trendLabels: string[]
  monthlyTotals: Record<string, number>
  period: { start: string; end: string }
}

interface GroupingPayload {
  aliases: { myob_name: string; canonical_name: string }[]
  groups: { id: number; dimension: string; name: string; sort_order: number; color: string | null }[]
  members: { group_id: number; canonical_name: string }[]
}

// VIN mapping is now driven by the /api/vin-codes Supabase table.
// Matches the Power BI behaviour: prefix = first N chars of the VIN (left-anchored).
// Returns a friendly model name, or a placeholder if no rule matches.
interface VinRule { id: number; vin_prefix: string; model_code: string; friendly_name: string | null }
function vinToModel(vinOrPo: string, rules: VinRule[]): string {
  if (!vinOrPo) return 'Unknown'
  const v = vinOrPo.trim().toUpperCase()
  if (v.length < 4) return 'Unknown'
  // Longest-prefix-wins: sort rules by prefix length descending, first match returns
  const sorted = [...rules].sort((a,b) => b.vin_prefix.length - a.vin_prefix.length)
  for (const rule of sorted) {
    if (v.startsWith(rule.vin_prefix.toUpperCase())) {
      return rule.friendly_name || rule.model_code
    }
  }
  // No rule matched — expose the prefix so it's visible for classification
  return `Unmapped (${v.substring(0, 4)})`
}

const fmtD=(n:number)=>n==null?'$0':'$'+Math.round(n).toLocaleString('en-AU')
const fmtFull=(n:number)=>n==null?'$0':'$'+Number(n).toLocaleString('en-AU',{minimumFractionDigits:0,maximumFractionDigits:0})
const fmt=(n:number)=>n>=1e6?'$'+(n/1e6).toFixed(2)+'M':n>=1000?'$'+Math.round(n/1000)+'k':'$'+Math.round(n)

const T={bg:'#0d0f12',bg2:'#131519',bg3:'#1a1d23',bg4:'#21252d',border:'rgba(255,255,255,0.07)',border2:'rgba(255,255,255,0.12)',text:'#e8eaf0',text2:'#8b90a0',text3:'#545968',blue:'#4f8ef7',teal:'#2dd4bf',green:'#34c77b',amber:'#f5a623',red:'#f04e4e',purple:'#a78bfa',accent:'#4f8ef7'}

// ── Sort helpers ─────────────────────────────────────────────────────
// Shared across the three sortable tables on this page (Summary groups,
// Distributor Sales models, Detailed Sales descriptions). Click a header
// once → sort ascending; click again → descending; a third click → reset
// to the table's default order.

type SortDir = 'asc' | 'desc' | null
interface SortState { col: string | null; dir: SortDir }

function nextSortState(current: SortState, col: string): SortState {
  if (current.col !== col) return { col, dir: 'desc' }  // new column → desc first (biggest numbers at top)
  if (current.dir === 'desc') return { col, dir: 'asc' }
  if (current.dir === 'asc')  return { col: null, dir: null }  // reset to natural order
  return { col, dir: 'desc' }
}

function sortIndicator(state: SortState, col: string): string {
  if (state.col !== col) return ' ↕'           // faded default arrow to signal sortability
  if (state.dir === 'asc')  return ' ↑'
  if (state.dir === 'desc') return ' ↓'
  return ' ↕'
}

// Sortable <th>. Numeric cols use right-align, label cols use left-align.
function SortableTh({
  label, col, state, onSort, align = 'right', width,
}: { label: string; col: string; state: SortState; onSort: (col: string) => void; align?: 'left'|'right'; width?: string|number }) {
  const active = state.col === col
  return (
    <th onClick={() => onSort(col)}
      title={`Sort by ${label}`}
      style={{
        fontSize:11, color: active ? T.text : T.text3,
        padding:'10px 12px', textAlign: align, fontWeight: active ? 600 : 500,
        cursor:'pointer', userSelect:'none',
        width,
        transition:'color 0.15s',
      }}
      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = T.text }}
      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = active ? T.text : T.text3 }}>
      {label}<span style={{color: active ? T.blue : T.text3, fontSize:10, marginLeft:2}}>{sortIndicator(state, col)}</span>
    </th>
  )
}

type Tab='distributor-sales'|'detailed-sales'|'summary'|'national-pm'|'national-total'

export default function DistributorReport({ user }: { user: PortalUserSSR }) {
  const router=useRouter()
  const { prefs } = usePreferences()
  const [tab,setTab]=useState<Tab>('summary')  // default to Summary — it's the grouped view
  const [data,setData]=useState<DistData|null>(null)
  const [grouping,setGrouping]=useState<GroupingPayload|null>(null)
  const [vinRules,setVinRules]=useState<VinRule[]>([])
  const [loading,setLoading]=useState(true)
  const [error,setError]=useState('')
  const [selectedDist,setSelectedDist]=useState('ALL')
  const [refreshing,setRefreshing]=useState(false)
  const [lastRefresh,setLastRefresh]=useState<Date|null>(null)
  const [primaryDimension, setPrimaryDimension] = useState<'type'|'region'|string>('type')

  // Per-table sort state. Default = natural (backend) order.
  const [summarySort, setSummarySort] = useState<SortState>({ col: null, dir: null })
  const [modelSort, setModelSort]     = useState<SortState>({ col: null, dir: null })
  const [detailedSort, setDetailedSort] = useState<SortState>({ col: null, dir: null })

  function handleSummarySort(col: string)  { setSummarySort(prev => nextSortState(prev, col)) }
  function handleModelSort(col: string)    { setModelSort(prev => nextSortState(prev, col)) }
  function handleDetailedSort(col: string) { setDetailedSort(prev => nextSortState(prev, col)) }

  // ── Drill-down (invoice breakdown modal) ─────────────────────────
  // When the user clicks a cell on Summary / Distributor Sales / Detailed Sales
  // we show every line item that makes up that cell, grouped by source invoice.
  interface DrillSpec {
    title: string                 // modal title, e.g. "Cutlers Diesel — Tuning"
    subtitle?: string             // smaller context line
    filter: (l: LineItem) => boolean
  }
  const [drill, setDrill] = useState<DrillSpec | null>(null)

  // Date range
  const now=new Date()
  const currentFY=now.getMonth()>=6?now.getFullYear()+1:now.getFullYear()
  const pad=(n:number)=>String(n).padStart(2,'0')
  const monthStart=`${now.getFullYear()}-${pad(now.getMonth()+1)}-01`
  const monthEnd=`${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(new Date(now.getFullYear(),now.getMonth()+1,0).getDate())}`
  const [fyYear,setFyYear]=useState(currentFY)
  const [isCustomRange,setIsCustomRange]=useState(true)
  const [customStart,setCustomStart]=useState(monthStart)
  const [customEnd,setCustomEnd]=useState(monthEnd)
  const [activeDateParams,setActiveDateParams]=useState(`startDate=${monthStart}&endDate=${monthEnd}`)
  const [dateLoading,setDateLoading]=useState(false)
  const fyLabel=isCustomRange?`${new Date(customStart+'T00:00').toLocaleDateString('en-AU',{day:'2-digit',month:'short',year:'2-digit'})} – ${new Date(customEnd+'T00:00').toLocaleDateString('en-AU',{day:'2-digit',month:'short',year:'2-digit'})}`:`FY${fyYear}`

  function selectFY(y:number){setFyYear(y);setIsCustomRange(false);setCustomStart(`${y-1}-07-01`);setCustomEnd(`${y}-06-30`);setDateLoading(true);setActiveDateParams(`startDate=${y-1}-07-01&endDate=${y}-06-30`)}
  function applyCustomRange(){if(customStart&&customEnd){setIsCustomRange(true);setDateLoading(true);setActiveDateParams(`startDate=${customStart}&endDate=${customEnd}`)}}

  const load=useCallback(async(isRefresh=false)=>{
    if(isRefresh)setRefreshing(true)
    try{
      const rp=isRefresh?'&refresh=true':''
      const [distRes, groupRes, vinRes] = await Promise.all([
        fetch(`/api/distributors?${activeDateParams}${rp}`),
        fetch(`/api/groups${isRefresh?'?refresh=true':''}`),
        fetch(`/api/vin-codes${isRefresh?'?refresh=true':''}`),
      ])
      if(distRes.status===401){router.push('/login');return}
      if(!distRes.ok)throw new Error('Failed to load distributor data')
      const d=await distRes.json()
      if(d.error)throw new Error(d.error)

      // Fetch grouping — don't block if it fails, fall back to empty
      let g: GroupingPayload = {aliases:[], groups:[], members:[]}
      if (groupRes.ok) {
        g = await groupRes.json()
      }
      setGrouping(g)
      const aliasMap: Record<string,string> = {}
      g.aliases.forEach(a => { aliasMap[a.myob_name] = a.canonical_name })

      // Fetch VIN rules — don't block if it fails
      let vRules: VinRule[] = []
      if (vinRes.ok) {
        const vData = await vinRes.json()
        vRules = vData.rules || []
      }
      setVinRules(vRules)

      // Flatten distributors[].lineItems[] into a single array,
      // resolving each raw MYOB name to its canonical via the alias map.
      // Backend returns amountExGst (ex-GST after FY26 GST audit fix).
      // Apply user's gst_display preference: 'inc' → × 1.1, 'ex' → as-is.
      const gstPref = prefs.gst_display
      const flatLineItems: LineItem[] = (d.distributors || []).flatMap((dist: any) =>
        (dist.lineItems || []).map((li: any) => {
          const rawName = dist.customerBase || ''
          const canonical = aliasMap[rawName] || rawName.trim()
          return {
            CustomerName: canonical,
            RawCustomerName: rawName,
            Date: li.date,
            AccountDisplayID: li.accountCode,
            Description: li.description,
            Total: applyGstDisplay(Number(li.amountExGst) || 0, gstPref),
            bucket: li.bucket,
            poNumber: li.poNumber || '',
            invoiceNumber: li.invoiceNumber || '',
            sundryCustomer: li.sundryCustomer || null,
          }
        })
      )

      const trendLabels: string[] = (d.monthlyNational || []).map((m: any) => m.ym)
      const monthlyTotals: Record<string, number> = Object.fromEntries(
        (d.monthlyNational || []).map((m: any) => [m.ym, applyGstDisplay(Number(m.amount) || 0, gstPref)])
      )

      const normalised: DistData = {
        fetchedAt: new Date().toISOString(),
        lineItems: flatLineItems,
        trendLabels,
        monthlyTotals,
        period: {
          start: activeDateParams.match(/startDate=([^&]+)/)?.[1] || '',
          end: activeDateParams.match(/endDate=([^&]+)/)?.[1] || '',
        },
      }

      setData(normalised);setError('');setLastRefresh(new Date());setDateLoading(false)
    }catch(e:any){setError(e.message);setDateLoading(false)}
    setLoading(false);setDateLoading(false);if(isRefresh)setRefreshing(false)
  },[router,activeDateParams,prefs.gst_display])
  useEffect(()=>{load()},[load])
  useEffect(()=>{
    const intervalMs = (prefs.auto_refresh_seconds || 0) * 1000
    if (intervalMs <= 0) return
    const t=setInterval(()=>load(true),intervalMs)
    return()=>clearInterval(t)
  },[load, prefs.auto_refresh_seconds])

  // Group lookup helpers
  const groupNameFor = useCallback((canonical: string, dimension: string): string | null => {
    if (!grouping) return null
    const memberGroupIds = new Set(grouping.members.filter(m => m.canonical_name === canonical).map(m => m.group_id))
    const groupsInDim = grouping.groups.filter(g => g.dimension === dimension).sort((a,b)=>a.sort_order-b.sort_order)
    for (const g of groupsInDim) {
      if (memberGroupIds.has(g.id)) return g.name
    }
    return null  // no group assigned
  }, [grouping])

  const groupColorFor = useCallback((dimension: string, name: string): string => {
    if (!grouping) return T.text3
    const g = grouping.groups.find(gr => gr.dimension === dimension && gr.name === name)
    return g?.color || T.text3
  }, [grouping])

  // Derived — now applies exclusions via the 'type'/'Excluded' group
  const allLines = data?.lineItems || []
  const visibleLines = allLines.filter(l => groupNameFor(l.CustomerName, 'type') !== 'Excluded')
  const allDists=Array.from(new Set(visibleLines.map(l=>l.CustomerName))).filter(Boolean).sort()
  const filtered=selectedDist==='ALL'?visibleLines:visibleLines.filter(l=>l.CustomerName===selectedDist)

  interface DS{name:string;tuning:number;oil:number;parts:number;total:number;typeGroup:string|null;regionGroup:string|null}
  const distSummaries:DS[]=allDists.map(name=>{
    const dl=visibleLines.filter(l=>l.CustomerName===name)
    const tuning=dl.filter(l=>l.bucket==='Tuning').reduce((s,l)=>s+l.Total,0)
    const oil=dl.filter(l=>l.bucket==='Oil').reduce((s,l)=>s+l.Total,0)
    const parts=dl.filter(l=>l.bucket==='Parts').reduce((s,l)=>s+l.Total,0)
    return{name,tuning,oil,parts,total:tuning+oil+parts,typeGroup:groupNameFor(name,'type'),regionGroup:groupNameFor(name,'region')}
  }).filter(d=>d.total>0).sort((a,b)=>b.total-a.total)

  // Split summaries by the selected primary dimension
  const dimensionGroups = grouping ? grouping.groups.filter(g => g.dimension === primaryDimension && g.name !== 'Excluded').sort((a,b)=>a.sort_order-b.sort_order) : []
  const summariesByGroup: Record<string, DS[]> = {}
  const unclassifiedSummaries: DS[] = []
  const sundrySummaries: DS[] = []
  distSummaries.forEach(d => {
    // Synthetic 'Sundry' distributor from the backend — render in its own
    // group regardless of the grouping dimension, so it's visible but
    // clearly separated from real distributor categories.
    if (d.name === 'Sundry') { sundrySummaries.push(d); return }
    const groupName = primaryDimension === 'type' ? d.typeGroup : primaryDimension === 'region' ? d.regionGroup : groupNameFor(d.name, primaryDimension)
    if (!groupName) {
      unclassifiedSummaries.push(d)
    } else {
      if (!summariesByGroup[groupName]) summariesByGroup[groupName] = []
      summariesByGroup[groupName].push(d)
    }
  })

  const ss=selectedDist==='ALL'
    ?{tuning:distSummaries.reduce((s,d)=>s+d.tuning,0),oil:distSummaries.reduce((s,d)=>s+d.oil,0),parts:distSummaries.reduce((s,d)=>s+d.parts,0),total:distSummaries.reduce((s,d)=>s+d.total,0)}
    :distSummaries.find(d=>d.name===selectedDist)||{tuning:0,oil:0,parts:0,total:0}

  const detailedByDesc:Record<string,{qty:number;total:number;invoices:Set<string>}>={}
  filtered.filter(l=>l.Total>0).forEach(l=>{
    const k=l.Description||''
    if(!detailedByDesc[k])detailedByDesc[k]={qty:0,total:0,invoices:new Set()}
    detailedByDesc[k].qty+=1
    detailedByDesc[k].total+=l.Total
    if(l.invoiceNumber)detailedByDesc[k].invoices.add(l.invoiceNumber)
  })
  const detailedRows=Object.entries(detailedByDesc).sort((a,b)=>b[1].total-a[1].total)

  const trendLabels=data?.trendLabels||[]
  const monthlyTotals=data?.monthlyTotals||{}

  // Charts
  const barRef=useRef<HTMLCanvasElement>(null),barInst=useRef<any>(null)
  const lineRef=useRef<HTMLCanvasElement>(null),lineInst=useRef<any>(null)
  const hBarRef=useRef<HTMLCanvasElement>(null),hBarInst=useRef<any>(null)

  useEffect(()=>{
    if(!barRef.current||!(window as any).Chart||loading||tab!=='distributor-sales')return
    if(barInst.current)barInst.current.destroy()
    const tunLines=filtered.filter(l=>l.bucket==='Tuning'&&l.poNumber&&l.poNumber.trim())
    const byModel:Record<string,{total:number;vins:Set<string>;jobs:number}>={}
    tunLines.forEach(l=>{
      const model=vinToModel(l.poNumber.trim(), vinRules)
      if(!byModel[model])byModel[model]={total:0,vins:new Set(),jobs:0}
      byModel[model].total+=l.Total
      byModel[model].vins.add(l.poNumber.trim())
      byModel[model].jobs+=1
    })
    const sorted=Object.entries(byModel).sort((a,b)=>b[1].total-a[1].total)
    barInst.current=new(window as any).Chart(barRef.current,{
      type:'bar',
      data:{labels:sorted.map(s=>s[0]),datasets:[{data:sorted.map(s=>Math.round(s[1].total)),backgroundColor:'#4f8ef7',borderRadius:4,borderSkipped:false}]},
      options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:(ctx:any)=>`$${ctx.raw.toLocaleString()}`,afterLabel:(ctx:any)=>{const m=sorted[ctx.dataIndex];if(!m)return '';const[,info]=m;return `${info.vins.size} unique VIN${info.vins.size===1?'':'s'} · ${info.jobs} job${info.jobs===1?'':'s'}`}}}},scales:{x:{grid:{color:'rgba(255,255,255,0.05)'},ticks:{color:T.text3,font:{size:11}}},y:{grid:{color:'rgba(255,255,255,0.05)'},ticks:{color:T.text3,font:{size:11},callback:(v:any)=>'$'+(v>=1000?Math.round(v/1000)+'k':v)}}}}
    })
    return()=>{if(barInst.current)barInst.current.destroy()}
  },[filtered,tab,loading,vinRules])

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

  const tabs:[Tab,string][]=[['summary','Summary'],['distributor-sales','Distributor Sales'],['detailed-sales','Detailed Sales'],['national-pm','National P/M'],['national-total','National Total']]

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

  function modelRows(){
    const tunLines=filtered.filter(l=>l.bucket==='Tuning'&&l.poNumber&&l.poNumber.trim())
    const byModel:Record<string,{total:number;vins:Set<string>;jobs:number}>={}
    tunLines.forEach(l=>{
      const model=vinToModel(l.poNumber.trim(), vinRules)
      if(!byModel[model])byModel[model]={total:0,vins:new Set(),jobs:0}
      byModel[model].total+=l.Total
      byModel[model].vins.add(l.poNumber.trim())
      byModel[model].jobs+=1
    })
    return Object.entries(byModel).map(([model,v])=>({model,total:v.total,vins:v.vins.size,jobs:v.jobs})).sort((a,b)=>b.total-a.total)
  }

  // ─── Grouped Summary Table ─────────────────────────────────────
  function renderGroupedSummary() {
    const allDimensions = grouping ? Array.from(new Set(grouping.groups.map(g=>g.dimension))) : ['type']
    return <div style={{padding:24,overflowY:'auto',display:'flex',flexDirection:'column',gap:16}}>
      <style>{`
        tr.dist-row { transition: background-color 0.1s; }
        tr.dist-row:hover { background: rgba(79,142,247,0.08) !important; }
        tr.dist-row:hover td { color: #e8eaf0; }
      `}</style>
      <div style={{display:'flex',alignItems:'center',gap:10}}>
        <span style={{fontSize:11,color:T.text3,textTransform:'uppercase',letterSpacing:'0.05em'}}>Group by:</span>
        {allDimensions.map(d => (
          <button key={d} onClick={()=>setPrimaryDimension(d)}
            style={{padding:'4px 12px',borderRadius:5,border:`1px solid ${primaryDimension===d?T.accent:T.border}`,background:primaryDimension===d?T.accent:'transparent',color:primaryDimension===d?'#fff':T.text2,fontSize:11,cursor:'pointer',fontFamily:'inherit',textTransform:'capitalize'}}>
            {d}
          </button>
        ))}
        <div style={{flex:1}}/>
      </div>

      {dimensionGroups.map(g => {
        const rawRows = summariesByGroup[g.name] || []
        if (rawRows.length === 0) return null
        // Apply sort (copy so we don't mutate the original)
        const rows = (() => {
          if (!summarySort.col || !summarySort.dir) return rawRows
          const dir = summarySort.dir === 'asc' ? 1 : -1
          const col = summarySort.col
          return [...rawRows].sort((a: any, b: any) => {
            const av = a[col], bv = b[col]
            if (typeof av === 'string' && typeof bv === 'string') return av.localeCompare(bv) * dir
            return ((Number(av) || 0) - (Number(bv) || 0)) * dir
          })
        })()
        const groupTuning = rawRows.reduce((s,r)=>s+r.tuning,0)
        const groupOil = rawRows.reduce((s,r)=>s+r.oil,0)
        const groupParts = rawRows.reduce((s,r)=>s+r.parts,0)
        const groupTotal = rawRows.reduce((s,r)=>s+r.total,0)
        return <div key={g.id} style={{background:T.bg2,border:`1px solid ${T.border}`,borderRadius:10,overflowX:'auto'}}>
          <div style={{padding:'14px 16px',borderBottom:`1px solid ${T.border2}`,display:'flex',alignItems:'center',gap:10}}>
            <div style={{width:10,height:10,borderRadius:3,background:g.color||T.text3,flexShrink:0}}/>
            <div style={{fontSize:14,fontWeight:600,color:T.text}}>{g.name}</div>
            <span style={{fontSize:11,color:T.text3,fontFamily:'monospace'}}>{rows.length} distributor{rows.length===1?'':'s'} · {fmtFull(groupTotal)}</span>
          </div>
          <table style={{width:'100%',borderCollapse:'collapse'}}>
            <thead><tr style={{borderBottom:`1px solid ${T.border}`}}>
              <SortableTh label="Distributor" col="name"   state={summarySort} onSort={handleSummarySort} align="left"/>
              <SortableTh label="Oil"         col="oil"    state={summarySort} onSort={handleSummarySort}/>
              <SortableTh label="Parts"       col="parts"  state={summarySort} onSort={handleSummarySort}/>
              <SortableTh label="Tuning"      col="tuning" state={summarySort} onSort={handleSummarySort}/>
              <SortableTh label="Total"       col="total"  state={summarySort} onSort={handleSummarySort}/>
            </tr></thead>
            <tbody>{rows.map((d,i)=><tr key={i} className="dist-row" style={{borderTop:`1px solid ${T.border}`,background:selectedDist===d.name?'rgba(79,142,247,0.08)':'transparent'}}>
              <td style={{fontSize:12,color:T.text2,padding:'8px 12px',cursor:'pointer'}} onClick={()=>setSelectedDist(d.name===selectedDist?'ALL':d.name)} title="Click to filter other tabs to this distributor">{d.name}</td>
              <td style={{fontSize:12,fontFamily:'monospace',color:d.oil>0?T.text:T.text3,padding:'8px 12px',textAlign:'right',cursor:d.oil>0?'pointer':'default',textDecoration:d.oil>0?'underline dotted rgba(255,255,255,0.15)':'none'}}
                  onClick={d.oil>0?()=>setDrill({title:`${d.name} — Oil`,subtitle:`${fmtFull(d.oil)} ex-GST`,filter:l=>l.CustomerName===d.name && l.bucket==='Oil'}):undefined}
                  title={d.oil>0?'Click to see the invoices that make up this':''}>{d.oil>0?fmtFull(d.oil):'$0'}</td>
              <td style={{fontSize:12,fontFamily:'monospace',color:d.parts>0?T.text:T.text3,padding:'8px 12px',textAlign:'right',cursor:d.parts>0?'pointer':'default',textDecoration:d.parts>0?'underline dotted rgba(255,255,255,0.15)':'none'}}
                  onClick={d.parts>0?()=>setDrill({title:`${d.name} — Parts`,subtitle:`${fmtFull(d.parts)} ex-GST`,filter:l=>l.CustomerName===d.name && l.bucket==='Parts'}):undefined}
                  title={d.parts>0?'Click to see the invoices that make up this':''}>{d.parts>0?fmtFull(d.parts):'$0'}</td>
              <td style={{fontSize:12,fontFamily:'monospace',color:d.tuning>0?T.green:T.text3,padding:'8px 12px',textAlign:'right',cursor:d.tuning>0?'pointer':'default',textDecoration:d.tuning>0?'underline dotted rgba(52,199,123,0.3)':'none'}}
                  onClick={d.tuning>0?()=>setDrill({title:`${d.name} — Tuning`,subtitle:`${fmtFull(d.tuning)} ex-GST`,filter:l=>l.CustomerName===d.name && l.bucket==='Tuning'}):undefined}
                  title={d.tuning>0?'Click to see the invoices that make up this':''}>{d.tuning>0?fmtFull(d.tuning):'$0'}</td>
              <td style={{fontSize:12,fontFamily:'monospace',fontWeight:500,color:T.blue,padding:'8px 12px',textAlign:'right',cursor:'pointer',textDecoration:'underline dotted rgba(79,142,247,0.3)'}}
                  onClick={()=>setDrill({title:`${d.name} — All revenue`,subtitle:`${fmtFull(d.total)} ex-GST`,filter:l=>l.CustomerName===d.name})}
                  title="Click to see the invoices that make up this">{fmtFull(d.total)}</td>
            </tr>)}
            <tr style={{borderTop:`2px solid ${T.border2}`,background:T.bg3}}>
              <td style={{fontSize:13,fontWeight:500,color:T.text,padding:'10px 12px'}}>{g.name} Total</td>
              <td style={{fontSize:13,fontFamily:'monospace',fontWeight:500,color:T.text,padding:'10px 12px',textAlign:'right'}}>{fmtFull(groupOil)}</td>
              <td style={{fontSize:13,fontFamily:'monospace',fontWeight:500,color:T.text,padding:'10px 12px',textAlign:'right'}}>{fmtFull(groupParts)}</td>
              <td style={{fontSize:13,fontFamily:'monospace',fontWeight:500,color:T.green,padding:'10px 12px',textAlign:'right'}}>{fmtFull(groupTuning)}</td>
              <td style={{fontSize:13,fontFamily:'monospace',fontWeight:500,color:T.blue,padding:'10px 12px',textAlign:'right'}}>{fmtFull(groupTotal)}</td>
            </tr></tbody>
          </table>
        </div>
      })}

      {unclassifiedSummaries.length > 0 && (
        <div style={{background:T.bg2,border:`1px solid ${T.amber}40`,borderRadius:10,overflowX:'auto'}}>
          <div style={{padding:'14px 16px',borderBottom:`1px solid ${T.amber}40`,display:'flex',alignItems:'center',gap:10}}>
            <div style={{width:10,height:10,borderRadius:3,background:T.amber,flexShrink:0}}/>
            <div style={{fontSize:14,fontWeight:600,color:T.amber}}>Unclassified</div>
            <span style={{fontSize:11,color:T.text3,fontFamily:'monospace'}}>{unclassifiedSummaries.length} distributor{unclassifiedSummaries.length===1?'':'s'} · {fmtFull(unclassifiedSummaries.reduce((s,r)=>s+r.total,0))}</span>
            <div style={{flex:1}}/>
            <button onClick={()=>router.push('/settings?tab=groups')}
              style={{padding:'3px 10px',borderRadius:4,border:`1px solid ${T.amber}`,background:'transparent',color:T.amber,fontSize:11,cursor:'pointer',fontFamily:'inherit'}}>
              Classify now →
            </button>
          </div>
          <table style={{width:'100%',borderCollapse:'collapse'}}>
            <thead><tr style={{borderBottom:`1px solid ${T.border}`}}>
              <SortableTh label="Distributor" col="name"   state={summarySort} onSort={handleSummarySort} align="left"/>
              <SortableTh label="Oil"         col="oil"    state={summarySort} onSort={handleSummarySort}/>
              <SortableTh label="Parts"       col="parts"  state={summarySort} onSort={handleSummarySort}/>
              <SortableTh label="Tuning"      col="tuning" state={summarySort} onSort={handleSummarySort}/>
              <SortableTh label="Total"       col="total"  state={summarySort} onSort={handleSummarySort}/>
            </tr></thead>
            <tbody>{(() => {
              if (!summarySort.col || !summarySort.dir) return unclassifiedSummaries
              const dir = summarySort.dir === 'asc' ? 1 : -1
              const col = summarySort.col
              return [...unclassifiedSummaries].sort((a: any, b: any) => {
                const av = a[col], bv = b[col]
                if (typeof av === 'string' && typeof bv === 'string') return av.localeCompare(bv) * dir
                return ((Number(av) || 0) - (Number(bv) || 0)) * dir
              })
            })().map((d,i)=><tr key={i} className="dist-row" style={{borderTop:`1px solid ${T.border}`}}>
              <td style={{fontSize:12,color:T.text2,padding:'8px 12px'}}>{d.name}</td>
              <td style={{fontSize:12,fontFamily:'monospace',color:d.oil>0?T.text:T.text3,padding:'8px 12px',textAlign:'right',cursor:d.oil>0?'pointer':'default',textDecoration:d.oil>0?'underline dotted rgba(255,255,255,0.15)':'none'}}
                  onClick={d.oil>0?()=>setDrill({title:`${d.name} — Oil`,subtitle:`${fmtFull(d.oil)} ex-GST`,filter:l=>l.CustomerName===d.name && l.bucket==='Oil'}):undefined}>{d.oil>0?fmtFull(d.oil):'$0'}</td>
              <td style={{fontSize:12,fontFamily:'monospace',color:d.parts>0?T.text:T.text3,padding:'8px 12px',textAlign:'right',cursor:d.parts>0?'pointer':'default',textDecoration:d.parts>0?'underline dotted rgba(255,255,255,0.15)':'none'}}
                  onClick={d.parts>0?()=>setDrill({title:`${d.name} — Parts`,subtitle:`${fmtFull(d.parts)} ex-GST`,filter:l=>l.CustomerName===d.name && l.bucket==='Parts'}):undefined}>{d.parts>0?fmtFull(d.parts):'$0'}</td>
              <td style={{fontSize:12,fontFamily:'monospace',color:d.tuning>0?T.green:T.text3,padding:'8px 12px',textAlign:'right',cursor:d.tuning>0?'pointer':'default',textDecoration:d.tuning>0?'underline dotted rgba(52,199,123,0.3)':'none'}}
                  onClick={d.tuning>0?()=>setDrill({title:`${d.name} — Tuning`,subtitle:`${fmtFull(d.tuning)} ex-GST`,filter:l=>l.CustomerName===d.name && l.bucket==='Tuning'}):undefined}>{d.tuning>0?fmtFull(d.tuning):'$0'}</td>
              <td style={{fontSize:12,fontFamily:'monospace',fontWeight:500,color:T.blue,padding:'8px 12px',textAlign:'right',cursor:'pointer',textDecoration:'underline dotted rgba(79,142,247,0.3)'}}
                  onClick={()=>setDrill({title:`${d.name} — All revenue`,subtitle:`${fmtFull(d.total)} ex-GST`,filter:l=>l.CustomerName===d.name})}>{fmtFull(d.total)}</td>
            </tr>)}</tbody>
          </table>
        </div>
      )}

      {sundrySummaries.length > 0 && (() => {
        // There's only ever one synthetic 'Sundry' row (the backend rolled
        // every Sundry-tagged customer into it). Drill-down shows lines
        // with their real customer names via sundryCustomer.
        const d = sundrySummaries[0]
        return (
        <div style={{background:T.bg2,border:`1px solid ${T.amber}40`,borderRadius:10,overflowX:'auto'}}>
          <div style={{padding:'14px 16px',borderBottom:`1px solid ${T.amber}40`,display:'flex',alignItems:'center',gap:10}}>
            <div style={{width:10,height:10,borderRadius:3,background:T.amber,flexShrink:0}}/>
            <div style={{fontSize:14,fontWeight:600,color:T.amber}}>Sundry</div>
            <span style={{fontSize:11,color:T.text3,fontFamily:'monospace'}}>{fmtFull(d.total)} · retail, trade-in and other non-distributor sales</span>
          </div>
          <table style={{width:'100%',borderCollapse:'collapse'}}>
            <thead><tr style={{borderBottom:`1px solid ${T.border}`}}>
              <th style={{fontSize:11,color:T.text3,padding:'10px 12px',textAlign:'left',fontWeight:500}}>Category</th>
              <th style={{fontSize:11,color:T.text3,padding:'10px 12px',textAlign:'right',fontWeight:500}}>Oil</th>
              <th style={{fontSize:11,color:T.text3,padding:'10px 12px',textAlign:'right',fontWeight:500}}>Parts</th>
              <th style={{fontSize:11,color:T.text3,padding:'10px 12px',textAlign:'right',fontWeight:500}}>Tuning</th>
              <th style={{fontSize:11,color:T.text3,padding:'10px 12px',textAlign:'right',fontWeight:500}}>Total</th>
            </tr></thead>
            <tbody>
              <tr className="dist-row" style={{borderTop:`1px solid ${T.border}`}}>
                <td style={{fontSize:12,color:T.text2,padding:'8px 12px'}}>Sundry</td>
                <td style={{fontSize:12,fontFamily:'monospace',color:d.oil>0?T.text:T.text3,padding:'8px 12px',textAlign:'right',cursor:d.oil>0?'pointer':'default',textDecoration:d.oil>0?'underline dotted rgba(255,255,255,0.15)':'none'}}
                    onClick={d.oil>0?()=>setDrill({title:'Sundry — Oil',subtitle:`${fmtFull(d.oil)} ex-GST`,filter:l=>l.CustomerName==='Sundry' && l.bucket==='Oil'}):undefined}>{d.oil>0?fmtFull(d.oil):'$0'}</td>
                <td style={{fontSize:12,fontFamily:'monospace',color:d.parts>0?T.text:T.text3,padding:'8px 12px',textAlign:'right',cursor:d.parts>0?'pointer':'default',textDecoration:d.parts>0?'underline dotted rgba(255,255,255,0.15)':'none'}}
                    onClick={d.parts>0?()=>setDrill({title:'Sundry — Parts',subtitle:`${fmtFull(d.parts)} ex-GST`,filter:l=>l.CustomerName==='Sundry' && l.bucket==='Parts'}):undefined}>{d.parts>0?fmtFull(d.parts):'$0'}</td>
                <td style={{fontSize:12,fontFamily:'monospace',color:d.tuning>0?T.green:T.text3,padding:'8px 12px',textAlign:'right',cursor:d.tuning>0?'pointer':'default',textDecoration:d.tuning>0?'underline dotted rgba(52,199,123,0.3)':'none'}}
                    onClick={d.tuning>0?()=>setDrill({title:'Sundry — Tuning',subtitle:`${fmtFull(d.tuning)} ex-GST`,filter:l=>l.CustomerName==='Sundry' && l.bucket==='Tuning'}):undefined}>{d.tuning>0?fmtFull(d.tuning):'$0'}</td>
                <td style={{fontSize:12,fontFamily:'monospace',fontWeight:500,color:T.blue,padding:'8px 12px',textAlign:'right',cursor:'pointer',textDecoration:'underline dotted rgba(79,142,247,0.3)'}}
                    onClick={()=>setDrill({title:'Sundry — All revenue',subtitle:`${fmtFull(d.total)} ex-GST · ${new Set((data?.lineItems||[]).filter(l=>l.CustomerName==='Sundry').map(l=>l.sundryCustomer)).size} customers`,filter:l=>l.CustomerName==='Sundry'})}>{fmtFull(d.total)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        )
      })()}
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

    if (tab === 'summary') return renderGroupedSummary()

    if(tab==='distributor-sales'){
      const models=modelRows()
      const modelsTotal=models.reduce((s,m)=>s+m.total,0)
      const totalVins=new Set(filtered.filter(l=>l.bucket==='Tuning'&&l.poNumber&&l.poNumber.trim()).map(l=>l.poNumber.trim())).size
      return <div style={{display:'flex',height:'100%'}}>
        <div style={{flex:1,padding:24,display:'flex',flexDirection:'column',gap:16,overflowY:'auto'}}>
          <div style={{display:'flex',alignItems:'center',gap:12}}>
            <div style={{fontSize:18,fontWeight:500,color:T.text}}>{selectedDist==='ALL'?'All Distributors':selectedDist}</div>
            <div style={{fontSize:11,fontFamily:'monospace',padding:'3px 8px',borderRadius:4,background:'rgba(79,142,247,0.12)',color:T.blue,border:'1px solid rgba(79,142,247,0.2)'}}>{totalVins} unique VIN{totalVins===1?'':'s'}</div>
          </div>
          <div style={{fontSize:12,color:T.text3}}>
            <span style={{display:'inline-flex',alignItems:'center',gap:5}}>
              <span style={{width:10,height:10,borderRadius:2,background:T.blue,display:'inline-block'}}/> Tuning Revenue ex GST · grouped by vehicle model (VIN-derived)
            </span>
          </div>
          <div style={{position:'relative',height:340,background:T.bg2,border:`1px solid ${T.border}`,borderRadius:10,padding:16}}>
            <canvas ref={barRef} id="bar-chart"/>
          </div>
          {models.length>0&&<div style={{background:T.bg2,border:`1px solid ${T.border}`,borderRadius:10,overflowX:'auto'}}>
            <table style={{width:'100%',borderCollapse:'collapse'}}>
              <thead><tr style={{borderBottom:`1px solid ${T.border2}`}}>
                <SortableTh label="Model"                 col="model" state={modelSort} onSort={handleModelSort} align="left"/>
                <SortableTh label="Unique VINs"           col="vins"  state={modelSort} onSort={handleModelSort}/>
                <SortableTh label="Jobs"                  col="jobs"  state={modelSort} onSort={handleModelSort}/>
                <SortableTh label="Tuning Revenue ex GST" col="total" state={modelSort} onSort={handleModelSort}/>
                <th style={{fontSize:11,color:T.text3,padding:'10px 12px',textAlign:'right',fontWeight:500}}>%</th>
              </tr></thead>
              <tbody>{(() => {
                if (!modelSort.col || !modelSort.dir) return models
                const dir = modelSort.dir === 'asc' ? 1 : -1
                const col = modelSort.col
                return [...models].sort((a: any, b: any) => {
                  const av = a[col], bv = b[col]
                  if (typeof av === 'string' && typeof bv === 'string') return av.localeCompare(bv) * dir
                  return ((Number(av) || 0) - (Number(bv) || 0)) * dir
                })
              })().map((m,i)=>{
                // vinRules is a closure dep here but we only need the classification function
                const rowTitle = selectedDist==='ALL'
                  ? `Tuning invoices — ${m.model}`
                  : `${selectedDist} — Tuning — ${m.model}`
                const openModel = () => setDrill({
                  title: rowTitle,
                  subtitle: `${fmtFull(m.total)} ex-GST · ${m.vins} VIN${m.vins===1?'':'s'} · ${m.jobs} job${m.jobs===1?'':'s'}`,
                  filter: l => l.bucket==='Tuning'
                    && !!(l.poNumber && l.poNumber.trim())
                    && vinToModel(l.poNumber.trim(), vinRules) === m.model
                    && (selectedDist==='ALL' || l.CustomerName===selectedDist),
                })
                return <tr key={i} style={{borderTop:`1px solid ${T.border}`,cursor:'pointer'}}
                  onClick={openModel}
                  onMouseEnter={e=>((e.currentTarget as HTMLElement).style.background='rgba(79,142,247,0.04)')}
                  onMouseLeave={e=>((e.currentTarget as HTMLElement).style.background='transparent')}
                  title="Click to see invoices for this model">
                <td style={{fontSize:12,color:T.text2,padding:'8px 12px',textDecoration:'underline dotted rgba(255,255,255,0.15)'}}>{m.model}</td>
                <td style={{fontSize:12,fontFamily:'monospace',color:T.text3,padding:'8px 12px',textAlign:'right'}}>{m.vins}</td>
                <td style={{fontSize:12,fontFamily:'monospace',color:m.jobs>m.vins?T.amber:T.text3,padding:'8px 12px',textAlign:'right'}}>{m.jobs}</td>
                <td style={{fontSize:12,fontFamily:'monospace',color:T.green,padding:'8px 12px',textAlign:'right'}}>{fmtFull(m.total)}</td>
                <td style={{fontSize:12,fontFamily:'monospace',color:T.text3,padding:'8px 12px',textAlign:'right'}}>{modelsTotal>0?((m.total/modelsTotal)*100).toFixed(1)+'%':'—'}</td>
              </tr>
              })}
              <tr style={{borderTop:`2px solid ${T.border2}`,background:T.bg3}}>
                <td style={{fontSize:13,fontWeight:500,color:T.text,padding:'10px 12px'}}>Total</td>
                <td style={{fontSize:13,fontFamily:'monospace',fontWeight:500,color:T.text,padding:'10px 12px',textAlign:'right'}}>{models.reduce((s,m)=>s+m.vins,0)}</td>
                <td style={{fontSize:13,fontFamily:'monospace',fontWeight:500,color:T.text,padding:'10px 12px',textAlign:'right'}}>{models.reduce((s,m)=>s+m.jobs,0)}</td>
                <td style={{fontSize:13,fontFamily:'monospace',fontWeight:500,color:T.green,padding:'10px 12px',textAlign:'right'}}>{fmtFull(modelsTotal)}</td>
                <td style={{fontSize:13,fontFamily:'monospace',fontWeight:500,color:T.text3,padding:'10px 12px',textAlign:'right'}}>100%</td>
              </tr></tbody>
            </table>
          </div>}
          {models.length===0&&<div style={{fontSize:12,color:T.text3,fontStyle:'italic',padding:'12px 0'}}>No tuning jobs with VIN data in this period.</div>}
        </div>
        <div style={{width:220,borderLeft:`1px solid ${T.border}`,flexShrink:0}}>
          <KPIBox label="Tuning Revenue ex GST" value={ss.tuning} color={T.green}/>
          <KPIBox label="Oil Revenue ex GST" value={ss.oil}/>
          <KPIBox label="Parts Revenue ex GST" value={ss.parts}/>
          <KPIBox label="Total Revenue ex GST" value={ss.total} color={T.blue}/>
        </div>
      </div>
    }

    if(tab==='detailed-sales'){
      // Apply user sort; default is already total desc (set where detailedRows is computed)
      const sortedDetailed = (() => {
        if (!detailedSort.col || !detailedSort.dir) return detailedRows
        const dir = detailedSort.dir === 'asc' ? 1 : -1
        return [...detailedRows].sort((a, b) => {
          if (detailedSort.col === 'desc') return (a[0] || '').localeCompare(b[0] || '') * dir
          if (detailedSort.col === 'qty')  return ((a[1].qty||0) - (b[1].qty||0)) * dir
          if (detailedSort.col === 'total')return ((a[1].total||0) - (b[1].total||0)) * dir
          return 0
        })
      })()
      return <div style={{padding:24,overflowY:'auto'}}>
      <div style={{fontSize:18,fontWeight:500,color:T.text,marginBottom:16}}>{selectedDist==='ALL'?'All':selectedDist}</div>
      <div style={{background:T.bg2,border:`1px solid ${T.border}`,borderRadius:10,overflowX:'auto'}}>
        <table style={{width:'100%',borderCollapse:'collapse'}}>
          <thead><tr style={{borderBottom:`1px solid ${T.border}`}}>
            <SortableTh label="Description"   col="desc"  state={detailedSort} onSort={handleDetailedSort} align="left"/>
            <SortableTh label="Qty"           col="qty"   state={detailedSort} onSort={handleDetailedSort}/>
            <SortableTh label="Total $ ExGST" col="total" state={detailedSort} onSort={handleDetailedSort}/>
          </tr></thead>
          <tbody>{sortedDetailed.map(([desc,vals],i)=>{
            const openDetail = () => setDrill({
              title: selectedDist==='ALL' ? `Invoices: ${desc?.substring(0,60)}` : `${selectedDist} — ${desc?.substring(0,60)}`,
              subtitle: `${fmtFull(vals.total)} ex-GST · ${vals.qty} occurrence${vals.qty===1?'':'s'}`,
              filter: l => l.Description === desc && (selectedDist==='ALL' || l.CustomerName===selectedDist),
            })
            return <tr key={i} style={{borderTop:`1px solid ${T.border}`,cursor:'pointer'}}
              onClick={openDetail}
              onMouseEnter={e=>((e.currentTarget as HTMLElement).style.background='rgba(79,142,247,0.04)')}
              onMouseLeave={e=>((e.currentTarget as HTMLElement).style.background='transparent')}
              title="Click to see invoices for this line">
            <td style={{fontSize:12,color:T.text2,padding:'9px 16px',textDecoration:'underline dotted rgba(255,255,255,0.15)'}}>{desc?.substring(0,70)}</td>
            <td style={{fontSize:12,fontFamily:'monospace',color:T.text3,padding:'9px 16px',textAlign:'right'}}>{vals.qty>1?vals.qty:''}</td>
            <td style={{fontSize:12,fontFamily:'monospace',color:T.text,padding:'9px 16px',textAlign:'right'}}>{fmtFull(vals.total)}</td>
          </tr>
          })}
          <tr style={{borderTop:`2px solid ${T.border2}`,background:T.bg3}}>
            <td style={{fontSize:13,fontWeight:500,color:T.text,padding:'10px 16px'}}>Total</td>
            <td style={{fontSize:13,fontFamily:'monospace',fontWeight:500,color:T.text3,padding:'10px 16px',textAlign:'right'}}>{detailedRows.reduce((s,[,v])=>s+v.qty,0)}</td>
            <td style={{fontSize:13,fontFamily:'monospace',fontWeight:500,color:T.blue,padding:'10px 16px',textAlign:'right'}}>{fmtFull(detailedRows.reduce((s,[,v])=>s+v.total,0))}</td>
          </tr></tbody>
        </table>
      </div>
    </div>
    }

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
    <Head><title>Distributors — Just Autos</title><meta name="viewport" content="width=device-width,initial-scale=1"/><meta name="robots" content="noindex,nofollow"/></Head>
    <Script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js" strategy="beforeInteractive"/>

    <div style={{display:'flex',height:'100vh',overflow:'hidden',fontFamily:"'DM Sans',system-ui,sans-serif",color:T.text}}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet"/>

      <PortalSidebar
        activeId="distributors"
        lastRefresh={lastRefresh}
        onRefresh={()=>load(true)}
        refreshing={refreshing}
        currentUserRole={user.role} currentUserVisibleTabs={(user as any).visibleTabs}
        currentUserName={user.displayName}
        currentUserEmail={user.email}
      />

      <div style={{flex:1,display:'flex',flexDirection:'column',overflow:'hidden',background:T.bg}}>
        <div style={{height:52,background:T.bg2,borderBottom:`1px solid ${T.border}`,display:'flex',alignItems:'center',padding:'0 20px',gap:10,flexShrink:0}}>
          <div style={{width:26,height:26,borderRadius:6,background:T.blue,display:'flex',alignItems:'center',justifyContent:'center',fontSize:11,fontWeight:600,color:'#fff'}}>JA</div>
          <span style={{fontSize:14,fontWeight:600}}>Distributors</span>
          <div style={{flex:1}}/>
          {!loading&&<><div style={{width:7,height:7,borderRadius:'50%',background:T.green,boxShadow:`0 0 6px ${T.green}`}}/>
          <span style={{fontSize:10,fontFamily:'monospace',padding:'2px 8px',borderRadius:4,background:'rgba(52,199,123,0.12)',color:T.green,border:'1px solid rgba(52,199,123,0.2)'}}>MYOB live</span>
          <span style={{fontSize:10,fontFamily:'monospace',padding:'2px 8px',borderRadius:4,background:'rgba(79,142,247,0.12)',color:T.blue,border:'1px solid rgba(79,142,247,0.2)'}}>{fyLabel} · {distSummaries.length} dists</span></>}
          <div style={{width:1,height:18,background:T.border}}/>
          {[currentFY-1,currentFY].map(y=><button key={y} onClick={()=>selectFY(y)} style={{padding:'3px 10px',borderRadius:4,border:'1px solid',fontSize:11,fontFamily:'monospace',fontWeight:600,cursor:'pointer',background:fyYear===y&&!isCustomRange?T.accent:'transparent',color:fyYear===y&&!isCustomRange?'#fff':T.text2,borderColor:fyYear===y&&!isCustomRange?T.accent:T.border}}>FY{y}</button>)}
          <input type="date" value={customStart} onChange={e=>setCustomStart(e.target.value)} style={{padding:'3px 6px',borderRadius:4,border:`1px solid ${isCustomRange?T.accent:T.border}`,fontSize:11,fontFamily:'monospace',background:'transparent',color:T.text2,outline:'none',colorScheme:'dark'}}/>
          <span style={{fontSize:11,color:T.text3}}>→</span>
          <input type="date" value={customEnd} onChange={e=>setCustomEnd(e.target.value)} style={{padding:'3px 6px',borderRadius:4,border:`1px solid ${isCustomRange?T.accent:T.border}`,fontSize:11,fontFamily:'monospace',background:'transparent',color:T.text2,outline:'none',colorScheme:'dark'}}/>
          <button onClick={applyCustomRange} style={{padding:'3px 10px',borderRadius:4,border:`1px solid ${T.accent}`,fontSize:11,fontFamily:'monospace',fontWeight:600,cursor:'pointer',background:isCustomRange?T.accent:'transparent',color:isCustomRange?'#fff':T.accent}}>Apply</button>
          {dateLoading&&<span style={{fontSize:14,animation:'spin 1s linear infinite',color:T.blue}}>⟳</span>}
        </div>

        <div style={{background:T.bg2,borderBottom:`1px solid ${T.border}`,display:'flex',alignItems:'flex-end',padding:'0 20px',gap:2,flexShrink:0}}>
          {tabs.map(([id,label])=><button key={id} onClick={()=>setTab(id)} style={{fontSize:12,padding:'10px 16px',border:'none',borderBottom:tab===id?`2px solid ${T.blue}`:'2px solid transparent',background:'transparent',color:tab===id?T.blue:T.text2,cursor:'pointer',fontFamily:'inherit',whiteSpace:'nowrap'}}>{label}</button>)}
        </div>

        {showSelector&&!loading&&!error&&<DistSelector/>}

        <div style={{flex:1,overflow:'hidden',display:'flex',flexDirection:'column',position:'relative'}}>
          <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
          {dateLoading&&<div style={{position:'absolute',inset:0,background:'rgba(13,15,18,0.75)',zIndex:10,display:'flex',alignItems:'center',justifyContent:'center',flexDirection:'column',gap:12}}>
            <div style={{fontSize:28,animation:'spin 1s linear infinite',color:T.blue}}>⟳</div><div style={{color:T.text2,fontSize:13}}>Updating distributor data for {fyLabel}…</div>
          </div>}
          {renderContent()}
        </div>
      </div>
    </div>

    {/* Drill-down modal — shows every line item matching the filter, grouped by invoice */}
    {drill && (() => {
      const matching = (data?.lineItems || []).filter(drill.filter)
      // Group by invoice number. When a line belongs to the synthetic
      // 'Sundry' roll-up, show the REAL customer (from sundryCustomer) in
      // the invoice header — otherwise every Sundry invoice would just say
      // "Sundry" which is useless.
      const byInvoice = new Map<string, { invoiceNumber: string; customer: string; date: string; lines: LineItem[]; total: number }>()
      for (const l of matching) {
        const k = l.invoiceNumber || '(no invoice #)'
        const displayCustomer = l.sundryCustomer || l.CustomerName
        let grp = byInvoice.get(k)
        if (!grp) {
          grp = { invoiceNumber: k, customer: displayCustomer, date: l.Date, lines: [], total: 0 }
          byInvoice.set(k, grp)
        }
        grp.lines.push(l)
        grp.total += l.Total
      }
      const invoices = Array.from(byInvoice.values()).sort((a,b) => (b.date||'').localeCompare(a.date||''))
      const grandTotal = matching.reduce((s,l)=>s+l.Total, 0)
      return (
        <div onClick={()=>setDrill(null)} style={{
          position:'fixed',inset:0,background:'rgba(0,0,0,0.7)',zIndex:9998,
          display:'flex',alignItems:'center',justifyContent:'center',padding:16,
        }}>
          <div onClick={e=>e.stopPropagation()} style={{
            background:T.bg2,border:`1px solid ${T.border2}`,borderRadius:10,
            padding:0,width:'100%',maxWidth:900,maxHeight:'85vh',display:'flex',flexDirection:'column',
          }}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',padding:'16px 20px',borderBottom:`1px solid ${T.border2}`}}>
              <div>
                <div style={{fontSize:14,fontWeight:600,color:T.text}}>{drill.title}</div>
                {drill.subtitle && <div style={{fontSize:11,color:T.text3,marginTop:3}}>{drill.subtitle}</div>}
                <div style={{fontSize:11,color:T.text3,marginTop:4,fontFamily:'monospace'}}>
                  {invoices.length} invoice{invoices.length===1?'':'s'} · {matching.length} line{matching.length===1?'':'s'} · {fmtFull(grandTotal)} total
                </div>
              </div>
              <button onClick={()=>setDrill(null)}
                style={{background:'none',border:'none',color:T.text3,fontSize:20,cursor:'pointer',padding:0,lineHeight:1}}>×</button>
            </div>

            <div style={{overflowY:'auto',flex:1,padding:'12px 20px'}}>
              {invoices.length === 0 && (
                <div style={{padding:30,textAlign:'center',color:T.text3,fontSize:12,fontStyle:'italic'}}>
                  No line items found matching this filter.
                </div>
              )}
              {invoices.map((inv, i) => (
                <div key={i} style={{marginBottom:14,background:T.bg3,border:`1px solid ${T.border}`,borderRadius:6,overflow:'hidden'}}>
                  <div style={{display:'flex',alignItems:'center',gap:12,padding:'8px 12px',background:T.bg4,borderBottom:`1px solid ${T.border}`}}>
                    <div style={{fontSize:12,fontWeight:600,color:T.text,fontFamily:'monospace'}}>#{inv.invoiceNumber}</div>
                    <div style={{fontSize:11,color:T.text3}}>{inv.date ? new Date(inv.date).toLocaleDateString('en-AU',{day:'2-digit',month:'short',year:'numeric'}) : '—'}</div>
                    <div style={{fontSize:11,color:T.text2,flex:1}}>{inv.customer}</div>
                    <div style={{fontSize:12,fontFamily:'monospace',fontWeight:500,color:T.blue}}>{fmtFull(inv.total)}</div>
                  </div>
                  <table style={{width:'100%',borderCollapse:'collapse'}}>
                    <tbody>{inv.lines.map((l, j) => (
                      <tr key={j} style={{borderTop: j===0 ? 'none' : `1px solid ${T.border}`}}>
                        <td style={{fontSize:11,color:T.text3,padding:'5px 12px',width:70,fontFamily:'monospace'}}>{l.AccountDisplayID}</td>
                        <td style={{fontSize:11,color:T.text2,padding:'5px 12px'}}>
                          {l.Description}
                          {l.poNumber && <span style={{marginLeft:8,color:T.text3,fontSize:10}}>PO/VIN: {l.poNumber}</span>}
                        </td>
                        <td style={{fontSize:11,padding:'5px 12px',width:70,textAlign:'center'}}>
                          <span style={{padding:'1px 6px',borderRadius:3,fontSize:10,
                            background: l.bucket==='Tuning'?'rgba(52,199,123,0.15)':l.bucket==='Parts'?'rgba(79,142,247,0.15)':'rgba(245,166,35,0.15)',
                            color: l.bucket==='Tuning'?T.green:l.bucket==='Parts'?T.blue:T.amber,
                          }}>{l.bucket}</span>
                        </td>
                        <td style={{fontSize:11,fontFamily:'monospace',color:T.text,padding:'5px 12px',width:110,textAlign:'right'}}>{fmtFull(l.Total)}</td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              ))}
            </div>

            <div style={{padding:'10px 20px',borderTop:`1px solid ${T.border2}`,fontSize:10,color:T.text3,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
              <span>Amounts are ex-GST. Source: MYOB JAWS via CData.</span>
              <button onClick={()=>setDrill(null)}
                style={{padding:'5px 14px',borderRadius:4,border:`1px solid ${T.border2}`,background:'transparent',color:T.text2,fontSize:11,cursor:'pointer',fontFamily:'inherit'}}>
                Close
              </button>
            </div>
          </div>
        </div>
      )
    })()}
  </>)
}

export async function getServerSideProps(context: any) {
  return requirePageAuth(context, 'view:distributors')
}
