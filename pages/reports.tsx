// pages/reports.tsx
// Report builder — pick sections, set date range, generate AI-narrated report
// Output renders in-page as HTML (print-friendly) + exports to XLSX via SheetJS

import { useState } from 'react'
import Head from 'next/head'
import { useRouter } from 'next/router'
import { requirePageAuth } from '../lib/authServer'

const T = {
  bg:'#0d0f12', bg2:'#131519', bg3:'#1a1d23', bg4:'#21252d',
  border:'rgba(255,255,255,0.07)', border2:'rgba(255,255,255,0.12)',
  text:'#e8eaf0', text2:'#8b90a0', text3:'#545968',
  blue:'#4f8ef7', teal:'#2dd4bf', green:'#34c77b',
  amber:'#f5a623', red:'#f04e4e', purple:'#a78bfa',
  accent:'#4f8ef7',
}

type SectionKey = 'overview'|'jaws'|'vps'|'invoices'|'pnl'|'stock'|'payables'|'distributors'|'pipeline'

const SECTIONS: { key: SectionKey; label: string; desc: string; color: string }[] = [
  { key: 'overview',     label: 'Executive Overview', desc: 'Combined JAWS + VPS headline numbers',          color: T.blue },
  { key: 'jaws',         label: 'JAWS Wholesale',     desc: 'Revenue, COS, top customers, trends',          color: T.blue },
  { key: 'vps',          label: 'VPS Workshop',       desc: 'Revenue, COS, overheads, top customers',       color: T.teal },
  { key: 'invoices',     label: 'Invoices / AR',      desc: 'Open invoices, aging, top debtors',            color: T.amber },
  { key: 'pnl',          label: 'P&L — This Period',  desc: 'Account-level P&L breakdown for both entities',color: T.green },
  { key: 'stock',        label: 'Stock & Inventory',  desc: 'Held value, reorder suggestions, dead stock',  color: T.purple },
  { key: 'payables',     label: 'Payables / AP',      desc: 'Open bills and supplier obligations',          color: T.red },
  { key: 'distributors', label: 'Distributor Network',desc: 'JAWS distributor revenue ranking',             color: T.blue },
  { key: 'pipeline',     label: 'JAWS Sales Pipeline',desc: 'Open orders, conversion rate, prepaid fulfils',color: T.purple },
]

interface Bundle {
  id: string
  data: any
  narrative: {
    executiveSummary: string
    perSection: Record<string, string>
    callouts: string[]
    recommendations: string[]
  }
  meta: { generatedAt: string; startDate: string; endDate: string; sections: SectionKey[] }
}

export default function ReportsPage({user}:{user:any}) {
  const router = useRouter()
  const [selected, setSelected] = useState<Set<SectionKey>>(new Set())
  const nowD = new Date()
  const defaultStart = `${nowD.getFullYear()}-${String(nowD.getMonth()+1).padStart(2,'0')}-01`
  const defaultEnd   = `${nowD.getFullYear()}-${String(nowD.getMonth()+1).padStart(2,'0')}-${new Date(nowD.getFullYear(), nowD.getMonth()+1, 0).getDate()}`
  const [startDate, setStartDate] = useState(defaultStart)
  const [endDate, setEndDate] = useState(defaultEnd)
  const [loading, setLoading] = useState(false)
  const [progress, setProgress] = useState('')
  const [bundle, setBundle] = useState<Bundle|null>(null)
  const [error, setError] = useState('')

  function toggle(k: SectionKey) {
    const s = new Set(selected)
    if (s.has(k)) s.delete(k); else s.add(k)
    setSelected(s)
  }

  function selectAll() {
    setSelected(new Set(SECTIONS.map(s => s.key)))
  }
  function clearAll() {
    setSelected(new Set())
  }

  async function generate() {
    if (selected.size === 0) { setError('Select at least one section.'); return }
    setLoading(true); setError(''); setBundle(null)
    setProgress('Fetching data from MYOB…')
    try {
      const r = await fetch('/api/reports/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ startDate, endDate, sections: Array.from(selected) }),
      })
      setProgress('Generating AI narrative…')
      if (!r.ok) {
        const err = await r.json().catch(()=>({error:'generate_failed'}))
        throw new Error(err.message || err.error || 'Report generation failed')
      }
      const b: Bundle = await r.json()
      setBundle(b)
      setProgress('')
    } catch (e: any) {
      setError(String(e?.message || e))
      setProgress('')
    } finally {
      setLoading(false)
    }
  }

  async function downloadXlsx() {
    if (!bundle) return
    // Dynamically import SheetJS so it's not in the main bundle
    const XLSX = await import('xlsx')
    const wb = XLSX.utils.book_new()

    // Executive summary sheet
    const summarySheet = [
      ['Just Autos — Report'],
      ['Period', `${bundle.meta.startDate} to ${bundle.meta.endDate}`],
      ['Generated', new Date(bundle.meta.generatedAt).toLocaleString('en-AU')],
      ['Sections', bundle.meta.sections.join(', ')],
      [],
      ['Executive Summary'],
      [bundle.narrative.executiveSummary],
      [],
      ['Callouts'],
      ...bundle.narrative.callouts.map(c => [c]),
      [],
      ['Recommendations'],
      ...bundle.narrative.recommendations.map(r => [r]),
    ]
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summarySheet), 'Summary')

    // JAWS sheet
    if (bundle.data.jaws) {
      const j = bundle.data.jaws
      const sheet: any[][] = [
        ['JAWS Wholesale'],
        [],
        ['Key Metrics'],
        ['Income', j.income],
        ['Cost of Sales', j.cos],
        ['Net', j.net],
        ['Net Margin %', (j.netMargin * 100).toFixed(2)],
        ['Open Invoices Count', j.openCount],
        ['Open Invoices Total', j.openTotal],
        ['Stock Value', j.stockValue],
        ['Stock SKU Count', j.stockSkuCount],
        [],
        ['Top Customers'],
        ['Customer', 'Revenue', 'Invoice Count'],
        ...j.topCustomers.slice(0, 20).map((c: any) => [c.name, c.revenue, c.invoiceCount]),
        [],
        ['Open Invoices'],
        ['Number', 'Date', 'Customer', 'Total', 'Balance Due'],
        ...j.openInvoices.slice(0, 50).map((i: any) => [i.Number, i.Date?.slice(0,10), i.CustomerName, Number(i.TotalAmount), Number(i.BalanceDueAmount)]),
        [],
        ['P&L — Income'],
        ['Account', 'Code', 'Total'],
        ...j.pnlIncome.map((r: any) => [r.name, r.accountId, r.total]),
        [],
        ['P&L — Cost of Sales'],
        ['Account', 'Code', 'Total'],
        ...j.pnlCos.map((r: any) => [r.name, r.accountId, r.total]),
      ]
      if (j.openOrders && j.openOrders.length > 0) {
        sheet.push([], ['Open Orders'], ['Number', 'Date', 'Customer', 'Total', 'Balance'])
        j.openOrders.forEach((o: any) => sheet.push([o.Number, o.Date?.slice(0,10), o.CustomerName, Number(o.TotalAmount), Number(o.BalanceDueAmount)]))
      }
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sheet), 'JAWS')
    }

    // VPS sheet
    if (bundle.data.vps) {
      const v = bundle.data.vps
      const sheet: any[][] = [
        ['VPS Workshop'],
        [],
        ['Key Metrics'],
        ['Income', v.income],
        ['Cost of Sales', v.cos],
        ['Overheads', v.overheads],
        ['Net', v.net],
        ['Gross Margin %', (v.grossMargin * 100).toFixed(2)],
        ['Open Invoices Count', v.openCount],
        ['Open Invoices Total', v.openTotal],
        [],
        ['Top Customers'],
        ['Customer', 'Revenue', 'Invoice Count'],
        ...v.topCustomers.slice(0, 20).map((c: any) => [c.name, c.revenue, c.invoiceCount]),
        [],
        ['Open Invoices'],
        ['Number', 'Date', 'Customer', 'Total', 'Balance Due'],
        ...v.openInvoices.slice(0, 50).map((i: any) => [i.Number, i.Date?.slice(0,10), i.CustomerName, Number(i.TotalAmount), Number(i.BalanceDueAmount)]),
        [],
        ['P&L — Income'],
        ['Account', 'Code', 'Total'],
        ...v.pnlIncome.map((r: any) => [r.name, r.accountId, r.total]),
        [],
        ['P&L — Cost of Sales'],
        ['Account', 'Code', 'Total'],
        ...v.pnlCos.map((r: any) => [r.name, r.accountId, r.total]),
        [],
        ['P&L — Overheads'],
        ['Account', 'Code', 'Total'],
        ...v.pnlOverheads.map((r: any) => [r.name, r.accountId, r.total]),
      ]
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sheet), 'VPS')
    }

    if (bundle.data.distributors) {
      const d = bundle.data.distributors
      const sheet: any[][] = [
        ['Distributors'],
        [],
        ['Total Revenue', d.totalRevenue],
        ['Count', d.count],
        ['Average per Distributor', d.avgRevenue],
        [],
        ['Distributor', 'Revenue', 'Invoices'],
        ...d.rows.map((r: any) => [r.name, r.revenue, r.invoiceCount]),
      ]
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sheet), 'Distributors')
    }

    if (bundle.data.inventory) {
      const i = bundle.data.inventory
      const sheet: any[][] = [
        ['Inventory'],
        [],
        ['Key Metrics'],
        ['Total SKUs', i.totalSkus],
        ['Stock Value', i.stockValue],
        ['Qty On Hand', i.qtyOnHand],
        ['Low Stock Count', i.lowStockCount],
        ['Out of Stock Count', i.outOfStockCount],
        ['Dead Stock (90d+) Count', i.deadStock90dCount],
        ['Dead Stock (90d+) Value', i.deadStock90dValue],
        ['Reorder Needed Count', i.reorderSuggestCount],
        ['Reorder Cost Est', i.reorderSuggestValue],
        [],
        ['Top Held by Value'],
        ['Number', 'Name', 'On Hand', 'Value', 'Days of Cover'],
        ...i.topHeldByValue.map((x: any) => [x.number, x.name, x.qtyOnHand, x.value, x.daysOfCover]),
        [],
        ['Reorder Needed'],
        ['Number', 'Name', 'On Hand', 'Reorder Level', 'Days of Cover'],
        ...i.reorderNeeded.map((x: any) => [x.number, x.name, x.qtyOnHand, x.reorderLevel, x.daysOfCover]),
      ]
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sheet), 'Inventory')
    }

    const filename = `just-autos-report_${bundle.meta.startDate}_to_${bundle.meta.endDate}.xlsx`
    XLSX.writeFile(wb, filename)
  }

  function printReport() {
    window.print()
  }

  return (
    <>
      <Head>
        <title>Reports — Just Autos</title>
        <meta name="viewport" content="width=device-width,initial-scale=1"/>
      </Head>
      <div style={{minHeight:'100vh',background:T.bg,color:T.text,fontFamily:"'DM Sans',system-ui,sans-serif"}}>
        {/* Header — hidden on print */}
        <div className="no-print" style={{
          background:T.bg2, borderBottom:`1px solid ${T.border}`,
          padding:'14px 20px', display:'flex', alignItems:'center', gap:12,
        }}>
          <div style={{width:30,height:30,borderRadius:8,background:T.blue,display:'flex',alignItems:'center',justifyContent:'center',fontSize:13,fontWeight:600,color:'#fff'}}>JA</div>
          <div style={{flex:1}}>
            <div style={{fontSize:15,fontWeight:600}}>Reports</div>
            <div style={{fontSize:11,color:T.text3}}>AI-narrated business reports for Just Autos</div>
          </div>
          <button onClick={()=>router.push('/')} style={{padding:'6px 12px',borderRadius:6,background:'transparent',border:`1px solid ${T.border2}`,color:T.text2,fontSize:12,cursor:'pointer',fontFamily:'inherit'}}>
            ← Back to Portal
          </button>
        </div>

        {/* Config panel — hidden on print */}
        {!bundle && (
          <div className="no-print" style={{maxWidth:900,margin:'0 auto',padding:'32px 20px'}}>
            <div style={{background:T.bg2,border:`1px solid ${T.border}`,borderRadius:12,padding:24}}>
              <div style={{fontSize:11,fontWeight:600,color:T.text3,textTransform:'uppercase',letterSpacing:'0.08em',marginBottom:12}}>1. Choose Period</div>
              <div style={{display:'flex',gap:10,alignItems:'center',marginBottom:28}}>
                <input type="date" value={startDate} onChange={e=>setStartDate(e.target.value)}
                  style={{background:T.bg3,border:`1px solid ${T.border2}`,color:T.text,borderRadius:6,padding:'8px 10px',fontSize:13,fontFamily:'inherit',colorScheme:'dark'}}/>
                <span style={{color:T.text3}}>→</span>
                <input type="date" value={endDate} onChange={e=>setEndDate(e.target.value)}
                  style={{background:T.bg3,border:`1px solid ${T.border2}`,color:T.text,borderRadius:6,padding:'8px 10px',fontSize:13,fontFamily:'inherit',colorScheme:'dark'}}/>
                <div style={{flex:1}}/>
                <button onClick={()=>{
                  const n=new Date()
                  setStartDate(`${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-01`)
                  setEndDate(`${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-${new Date(n.getFullYear(),n.getMonth()+1,0).getDate()}`)
                }} style={{padding:'6px 12px',borderRadius:6,background:'transparent',border:`1px solid ${T.border2}`,color:T.text2,fontSize:11,cursor:'pointer',fontFamily:'inherit'}}>This month</button>
                <button onClick={()=>{
                  const n=new Date();const y=n.getFullYear();const m=n.getMonth()
                  const s=new Date(y,m-1,1);const e=new Date(y,m,0)
                  setStartDate(s.toISOString().slice(0,10));setEndDate(e.toISOString().slice(0,10))
                }} style={{padding:'6px 12px',borderRadius:6,background:'transparent',border:`1px solid ${T.border2}`,color:T.text2,fontSize:11,cursor:'pointer',fontFamily:'inherit'}}>Last month</button>
                <button onClick={()=>{
                  const n=new Date()
                  const fyStart=n.getMonth()>=6?`${n.getFullYear()}-07-01`:`${n.getFullYear()-1}-07-01`
                  setStartDate(fyStart);setEndDate(n.toISOString().slice(0,10))
                }} style={{padding:'6px 12px',borderRadius:6,background:'transparent',border:`1px solid ${T.border2}`,color:T.text2,fontSize:11,cursor:'pointer',fontFamily:'inherit'}}>FY to date</button>
              </div>

              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12}}>
                <div style={{fontSize:11,fontWeight:600,color:T.text3,textTransform:'uppercase',letterSpacing:'0.08em'}}>2. Choose Sections ({selected.size})</div>
                <div style={{display:'flex',gap:8}}>
                  <button onClick={selectAll} style={{fontSize:11,color:T.blue,background:'none',border:'none',cursor:'pointer',fontFamily:'inherit'}}>Select all</button>
                  <button onClick={clearAll} style={{fontSize:11,color:T.text3,background:'none',border:'none',cursor:'pointer',fontFamily:'inherit'}}>Clear</button>
                </div>
              </div>
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,marginBottom:24}}>
                {SECTIONS.map(s => (
                  <label key={s.key} style={{
                    display:'flex',alignItems:'flex-start',gap:10,padding:'10px 12px',borderRadius:8,
                    background:selected.has(s.key)?`${s.color}15`:T.bg3,
                    border:`1px solid ${selected.has(s.key)?`${s.color}50`:T.border}`,
                    cursor:'pointer',transition:'all 0.15s',
                  }}>
                    <input type="checkbox" checked={selected.has(s.key)} onChange={()=>toggle(s.key)}
                      style={{margin:'3px 0 0 0',accentColor:s.color,cursor:'pointer'}}/>
                    <div style={{flex:1}}>
                      <div style={{fontSize:13,fontWeight:500,color:selected.has(s.key)?s.color:T.text}}>{s.label}</div>
                      <div style={{fontSize:11,color:T.text3,marginTop:2,lineHeight:1.4}}>{s.desc}</div>
                    </div>
                  </label>
                ))}
              </div>

              {error && <div style={{background:'rgba(240,78,78,0.1)',border:'1px solid rgba(240,78,78,0.25)',borderRadius:6,padding:'10px 14px',fontSize:12,color:T.red,marginBottom:14}}>{error}</div>}

              <button onClick={generate} disabled={loading || selected.size === 0}
                style={{
                  width:'100%',padding:'12px 16px',borderRadius:8,
                  background:loading||selected.size===0?T.bg3:T.blue,
                  border:'none',color:'#fff',fontSize:14,fontWeight:600,
                  cursor:loading||selected.size===0?'not-allowed':'pointer',
                  fontFamily:'inherit',
                }}>
                {loading ? (progress || 'Generating…') : `Generate Report (${selected.size} section${selected.size===1?'':'s'})`}
              </button>
              <div style={{fontSize:10,color:T.text3,marginTop:10,textAlign:'center'}}>
                Typically takes 15–30 seconds — MYOB data + Claude Sonnet narrative
              </div>
            </div>
          </div>
        )}

        {/* Report output */}
        {bundle && (
          <>
            {/* Toolbar — hidden on print */}
            <div className="no-print" style={{
              background:T.bg2, borderBottom:`1px solid ${T.border}`,
              padding:'10px 20px', display:'flex', alignItems:'center', gap:10,
              position:'sticky',top:0,zIndex:5,
            }}>
              <div style={{fontSize:12,color:T.text2}}>
                Report for <span style={{color:T.text,fontWeight:500}}>{bundle.meta.startDate} → {bundle.meta.endDate}</span>
              </div>
              <div style={{flex:1}}/>
              <button onClick={()=>setBundle(null)} style={{padding:'7px 12px',borderRadius:6,background:'transparent',border:`1px solid ${T.border2}`,color:T.text2,fontSize:12,cursor:'pointer',fontFamily:'inherit'}}>
                ← New Report
              </button>
              <button onClick={downloadXlsx} style={{padding:'7px 14px',borderRadius:6,background:T.green,border:'none',color:'#fff',fontSize:12,fontWeight:600,cursor:'pointer',fontFamily:'inherit'}}>
                ↓ Download XLSX
              </button>
              <button onClick={printReport} style={{padding:'7px 14px',borderRadius:6,background:T.blue,border:'none',color:'#fff',fontSize:12,fontWeight:600,cursor:'pointer',fontFamily:'inherit'}}>
                Print / Save as PDF
              </button>
            </div>
            <ReportView bundle={bundle}/>
          </>
        )}
      </div>

      {/* Print styles — everything not .printable gets hidden, background white, text black */}
      <style jsx global>{`
        @media print {
          .no-print { display: none !important; }
          body { background: white !important; }
          .report-container { background: white !important; color: #111 !important; padding: 0 !important; max-width: none !important; }
          .report-container * { color: #111 !important; }
          .report-container .accent-text { color: #000 !important; font-weight: 700 !important; }
          .report-card { background: white !important; border: 1px solid #ddd !important; page-break-inside: avoid; }
          .report-section { page-break-before: auto; }
          .report-section-break { page-break-before: always; }
          h1, h2, h3 { page-break-after: avoid; }
          table { page-break-inside: auto; }
          tr { page-break-inside: avoid; page-break-after: auto; }
        }
        @page { margin: 15mm; size: A4; }
      `}</style>
    </>
  )
}

// ─────────────────────────────────────────────────────────────
// Report View — the actual rendered report
// ─────────────────────────────────────────────────────────────

function ReportView({bundle}:{bundle:Bundle}) {
  const {data, narrative, meta} = bundle
  const fmt = (n:number) => n>=1e6?`$${(n/1e6).toFixed(2)}M`:n>=1000?`$${Math.round(n/1000)}k`:`$${Math.round(n)}`
  const fmtFull = (n:number) => `$${Number(n).toLocaleString('en-AU',{minimumFractionDigits:2,maximumFractionDigits:2})}`
  const fmtDate = (d:string) => new Date(d).toLocaleDateString('en-AU',{day:'numeric',month:'long',year:'numeric'})

  return (
    <div className="report-container" style={{maxWidth:900,margin:'0 auto',padding:'40px 40px 80px'}}>
      {/* Title */}
      <div style={{borderBottom:`2px solid ${T.accent}`,paddingBottom:16,marginBottom:28}}>
        <div style={{fontSize:11,fontWeight:600,color:T.text3,textTransform:'uppercase',letterSpacing:'0.1em'}}>Just Autos — Business Report</div>
        <h1 style={{fontSize:28,fontWeight:600,margin:'6px 0 10px',color:T.text}}>
          {fmtDate(meta.startDate)} — {fmtDate(meta.endDate)}
        </h1>
        <div style={{fontSize:12,color:T.text3}}>
          Generated {new Date(meta.generatedAt).toLocaleString('en-AU')} · {meta.sections.length} section{meta.sections.length===1?'':'s'} · AI-narrated by Claude Sonnet
        </div>
      </div>

      {/* Executive summary */}
      <div className="report-card report-section" style={{background:T.bg2,border:`1px solid ${T.border}`,borderRadius:10,padding:24,marginBottom:20}}>
        <div style={{fontSize:11,fontWeight:600,color:T.accent,textTransform:'uppercase',letterSpacing:'0.08em',marginBottom:12}} className="accent-text">Executive Summary</div>
        <div style={{fontSize:14,lineHeight:1.7,color:T.text,whiteSpace:'pre-wrap'}}>{narrative.executiveSummary}</div>
      </div>

      {/* Callouts + Recommendations side by side */}
      {(narrative.callouts.length > 0 || narrative.recommendations.length > 0) && (
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:16,marginBottom:20}}>
          {narrative.callouts.length > 0 && (
            <div className="report-card" style={{background:T.bg2,border:`1px solid ${T.border}`,borderRadius:10,padding:20}}>
              <div style={{fontSize:11,fontWeight:600,color:T.amber,textTransform:'uppercase',letterSpacing:'0.08em',marginBottom:12}} className="accent-text">Key Callouts</div>
              <ul style={{margin:0,paddingLeft:18,fontSize:13,lineHeight:1.7,color:T.text}}>
                {narrative.callouts.map((c,i) => <li key={i} style={{marginBottom:6}}>{c}</li>)}
              </ul>
            </div>
          )}
          {narrative.recommendations.length > 0 && (
            <div className="report-card" style={{background:T.bg2,border:`1px solid ${T.border}`,borderRadius:10,padding:20}}>
              <div style={{fontSize:11,fontWeight:600,color:T.green,textTransform:'uppercase',letterSpacing:'0.08em',marginBottom:12}} className="accent-text">Recommendations</div>
              <ul style={{margin:0,paddingLeft:18,fontSize:13,lineHeight:1.7,color:T.text}}>
                {narrative.recommendations.map((r,i) => <li key={i} style={{marginBottom:6}}>{r}</li>)}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* Headline KPIs */}
      {(data.jaws || data.vps) && (
        <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:12,marginBottom:24}}>
          {data.jaws && <KpiCard label="JAWS Revenue" value={fmt(data.jaws.income)} sub={`Net ${fmt(data.jaws.net)}`} color={T.blue}/>}
          {data.vps && <KpiCard label="VPS Revenue" value={fmt(data.vps.income)} sub={`Net ${fmt(data.vps.net)}`} color={T.teal}/>}
          {(data.jaws || data.vps) && <KpiCard label="Receivables" value={fmt((data.jaws?.openTotal||0)+(data.vps?.openTotal||0))} sub={`${(data.jaws?.openCount||0)+(data.vps?.openCount||0)} open`} color={T.amber}/>}
          {data.jaws && <KpiCard label="JAWS Stock" value={fmt(data.jaws.stockValue)} sub={`${data.jaws.stockSkuCount} SKUs`} color={T.purple}/>}
        </div>
      )}

      {/* Per-section content */}
      {meta.sections.includes('jaws') && data.jaws && (
        <Section title="JAWS Wholesale" color={T.blue} commentary={narrative.perSection.jaws}>
          <DataGrid rows={[
            ['Income', fmtFull(data.jaws.income)],
            ['Cost of Sales', fmtFull(data.jaws.cos)],
            ['Net Result', fmtFull(data.jaws.net)],
            ['Net Margin', (data.jaws.netMargin*100).toFixed(1)+'%'],
          ]}/>
          <RankedList title="Top Customers" rows={data.jaws.topCustomers.slice(0,10).map((c:any)=>({name:c.name,value:fmtFull(c.revenue),sub:`${c.invoiceCount} inv`}))}/>
          <RankedList title="Top Income Accounts" rows={data.jaws.pnlIncome.slice(0,8).map((r:any)=>({name:r.name,value:fmtFull(r.total)}))}/>
        </Section>
      )}

      {meta.sections.includes('vps') && data.vps && (
        <Section title="VPS Workshop" color={T.teal} commentary={narrative.perSection.vps}>
          <DataGrid rows={[
            ['Income', fmtFull(data.vps.income)],
            ['Cost of Sales', fmtFull(data.vps.cos)],
            ['Overheads', fmtFull(data.vps.overheads)],
            ['Net Result', fmtFull(data.vps.net)],
            ['Gross Margin', (data.vps.grossMargin*100).toFixed(1)+'%'],
          ]}/>
          <RankedList title="Top Customers" rows={data.vps.topCustomers.slice(0,10).map((c:any)=>({name:c.name,value:fmtFull(c.revenue),sub:`${c.invoiceCount} inv`}))}/>
          <RankedList title="Top Income Accounts" rows={data.vps.pnlIncome.slice(0,8).map((r:any)=>({name:r.name,value:fmtFull(r.total)}))}/>
          <RankedList title="Top Overheads" rows={data.vps.pnlOverheads.slice(0,5).map((r:any)=>({name:r.name,value:fmtFull(r.total)}))}/>
        </Section>
      )}

      {meta.sections.includes('invoices') && (data.jaws || data.vps) && (
        <Section title="Invoices / Receivables" color={T.amber} commentary={narrative.perSection.invoices}>
          {data.jaws && data.jaws.openInvoices.length > 0 && (
            <>
              <div style={{fontSize:12,color:T.text3,marginBottom:8,marginTop:10}}>JAWS — Top 10 open invoices by balance</div>
              <Table headers={['Number','Date','Customer','Balance']} rows={data.jaws.openInvoices.slice(0,10).map((i:any)=>[
                i.Number, i.Date?.slice(0,10), i.CustomerName, fmtFull(Number(i.BalanceDueAmount)||0),
              ])}/>
            </>
          )}
          {data.vps && data.vps.openInvoices.length > 0 && (
            <>
              <div style={{fontSize:12,color:T.text3,marginBottom:8,marginTop:16}}>VPS — Top 10 open invoices by balance</div>
              <Table headers={['Number','Date','Customer','Balance']} rows={data.vps.openInvoices.slice(0,10).map((i:any)=>[
                i.Number, i.Date?.slice(0,10), i.CustomerName, fmtFull(Number(i.BalanceDueAmount)||0),
              ])}/>
            </>
          )}
        </Section>
      )}

      {meta.sections.includes('pipeline') && data.jaws?.openOrders && (
        <Section title="JAWS Sales Pipeline" color={T.purple} commentary={narrative.perSection.pipeline}>
          <DataGrid rows={[
            ['Open Orders', String(data.jaws.openOrders.length)],
            ['Open Orders Value', fmtFull(data.jaws.openOrdersTotal||0)],
            ['Prepaid (awaiting shipment)', String(data.jaws.openOrdersPrepaid||0)],
            ['Converted in last 30 days', `${data.jaws.convertedOrders30d||0} orders · ${fmtFull(data.jaws.convertedTotal30d||0)}`],
          ]}/>
          {data.jaws.openOrders.length > 0 && (
            <Table headers={['Order','Date','Customer','Total','Balance']}
              rows={data.jaws.openOrders.slice(0,10).map((o:any)=>[
                o.Number, o.Date?.slice(0,10), o.CustomerName, fmtFull(Number(o.TotalAmount)||0),
                Number(o.BalanceDueAmount) > 0 ? fmtFull(Number(o.BalanceDueAmount)) : 'Paid',
              ])}/>
          )}
        </Section>
      )}

      {meta.sections.includes('stock') && data.inventory && (
        <Section title="Stock & Inventory" color={T.purple} commentary={narrative.perSection.stock}>
          <DataGrid rows={[
            ['Total SKUs', String(data.inventory.totalSkus)],
            ['Stock Value', fmtFull(data.inventory.stockValue)],
            ['Units On Hand', String(data.inventory.qtyOnHand)],
            ['Low Stock', String(data.inventory.lowStockCount)],
            ['Out of Stock', String(data.inventory.outOfStockCount)],
            ['Dead Stock (90d+)', `${data.inventory.deadStock90dCount} · ${fmtFull(data.inventory.deadStock90dValue)}`],
            ['Reorder Suggested', `${data.inventory.reorderSuggestCount} · ${fmtFull(data.inventory.reorderSuggestValue)}`],
          ]}/>
          {data.inventory.reorderNeeded.length > 0 && (
            <>
              <div style={{fontSize:12,color:T.text3,marginBottom:8,marginTop:16}}>Most urgent reorders</div>
              <Table headers={['SKU','Name','On Hand','Reorder Lvl','Days Cover']}
                rows={data.inventory.reorderNeeded.slice(0,10).map((x:any)=>[
                  x.number, x.name, String(x.qtyOnHand), String(x.reorderLevel),
                  x.daysOfCover==null?'—':Math.round(x.daysOfCover)+'d',
                ])}/>
            </>
          )}
        </Section>
      )}

      {meta.sections.includes('distributors') && data.distributors && (
        <Section title="Distributor Network" color={T.blue} commentary={narrative.perSection.distributors}>
          <DataGrid rows={[
            ['Active Distributors', String(data.distributors.count)],
            ['Combined Revenue', fmtFull(data.distributors.totalRevenue)],
            ['Average per Distributor', fmtFull(data.distributors.avgRevenue)],
          ]}/>
          <RankedList title="All Distributors" rows={data.distributors.rows.map((r:any)=>({
            name:r.name,value:fmtFull(r.revenue),sub:`${r.invoiceCount} inv`
          }))}/>
        </Section>
      )}

      {meta.sections.includes('payables') && (data.jaws?.openBills?.length || data.vps?.openBills?.length) && (
        <Section title="Payables" color={T.red} commentary={narrative.perSection.payables}>
          {data.jaws && data.jaws.openBills.length > 0 && (
            <>
              <div style={{fontSize:12,color:T.text3,marginBottom:8}}>JAWS — Top 10 open bills</div>
              <Table headers={['Bill','Date','Supplier','Balance']}
                rows={data.jaws.openBills.slice(0,10).map((b:any)=>[
                  b.Number, b.Date?.slice(0,10), b.SupplierName, fmtFull(Number(b.BalanceDueAmount)||0),
                ])}/>
            </>
          )}
          {data.vps && data.vps.openBills.length > 0 && (
            <>
              <div style={{fontSize:12,color:T.text3,marginBottom:8,marginTop:16}}>VPS — Top 10 open bills</div>
              <Table headers={['Bill','Date','Supplier','Balance']}
                rows={data.vps.openBills.slice(0,10).map((b:any)=>[
                  b.Number, b.Date?.slice(0,10), b.SupplierName, fmtFull(Number(b.BalanceDueAmount)||0),
                ])}/>
            </>
          )}
        </Section>
      )}

      {meta.sections.includes('pnl') && (data.jaws || data.vps) && (
        <Section title="P&L Breakdown" color={T.green} commentary={narrative.perSection.pnl}>
          {data.jaws && (
            <>
              <div style={{fontSize:12,color:T.text3,marginBottom:8}}>JAWS Income</div>
              <Table headers={['Account','Code','Total']}
                rows={data.jaws.pnlIncome.slice(0,15).map((r:any)=>[r.name,r.accountId,fmtFull(r.total)])}/>
              <div style={{fontSize:12,color:T.text3,marginBottom:8,marginTop:16}}>JAWS Cost of Sales</div>
              <Table headers={['Account','Code','Total']}
                rows={data.jaws.pnlCos.slice(0,15).map((r:any)=>[r.name,r.accountId,fmtFull(r.total)])}/>
            </>
          )}
          {data.vps && (
            <>
              <div style={{fontSize:12,color:T.text3,marginBottom:8,marginTop:16}}>VPS Income</div>
              <Table headers={['Account','Code','Total']}
                rows={data.vps.pnlIncome.slice(0,15).map((r:any)=>[r.name,r.accountId,fmtFull(r.total)])}/>
              <div style={{fontSize:12,color:T.text3,marginBottom:8,marginTop:16}}>VPS Cost of Sales</div>
              <Table headers={['Account','Code','Total']}
                rows={data.vps.pnlCos.slice(0,15).map((r:any)=>[r.name,r.accountId,fmtFull(r.total)])}/>
              <div style={{fontSize:12,color:T.text3,marginBottom:8,marginTop:16}}>VPS Overheads</div>
              <Table headers={['Account','Code','Total']}
                rows={data.vps.pnlOverheads.slice(0,15).map((r:any)=>[r.name,r.accountId,fmtFull(r.total)])}/>
            </>
          )}
        </Section>
      )}

      {/* Footer */}
      <div style={{marginTop:40,paddingTop:16,borderTop:`1px solid ${T.border}`,fontSize:10,color:T.text3,textAlign:'center'}}>
        Just Autos internal business report · Data sourced live from MYOB via CData · Narrative generated by Claude Sonnet 4.5
      </div>
    </div>
  )
}

function KpiCard({label,value,sub,color}:{label:string;value:string;sub?:string;color:string}) {
  return <div className="report-card" style={{background:T.bg2,border:`1px solid ${T.border}`,borderRadius:10,padding:'14px 16px',borderTop:`3px solid ${color}`}}>
    <div style={{fontSize:10,color:T.text3,textTransform:'uppercase',letterSpacing:'0.07em',marginBottom:8}}>{label}</div>
    <div style={{fontSize:20,fontWeight:500,fontFamily:'monospace',marginBottom:3}} className="accent-text">{value}</div>
    {sub && <div style={{fontSize:11,color:T.text3}}>{sub}</div>}
  </div>
}

function Section({title,color,commentary,children}:{title:string;color:string;commentary?:string;children:React.ReactNode}) {
  return <div className="report-card report-section-break" style={{background:T.bg2,border:`1px solid ${T.border}`,borderRadius:10,padding:24,marginBottom:20}}>
    <div style={{fontSize:16,fontWeight:600,marginBottom:4,color}} className="accent-text">{title}</div>
    {commentary && <div style={{fontSize:13,lineHeight:1.7,color:T.text2,marginBottom:18,whiteSpace:'pre-wrap'}}>{commentary}</div>}
    {children}
  </div>
}

function DataGrid({rows}:{rows:[string,string][]}) {
  return <div style={{display:'grid',gridTemplateColumns:'repeat(2,1fr)',gap:'0',background:T.border,marginBottom:16}}>
    {rows.map(([k,v],i)=>(
      <div key={i} style={{background:T.bg3,padding:'10px 14px',display:'flex',justifyContent:'space-between',alignItems:'center'}}>
        <span style={{fontSize:11,color:T.text3,textTransform:'uppercase',letterSpacing:'0.06em'}}>{k}</span>
        <span style={{fontSize:13,fontFamily:'monospace',color:T.text,fontWeight:500}}>{v}</span>
      </div>
    ))}
  </div>
}

function Table({headers,rows}:{headers:string[];rows:string[][]}) {
  return <div style={{overflow:'hidden',borderRadius:6,border:`1px solid ${T.border}`,marginBottom:14}}>
    <table style={{width:'100%',borderCollapse:'collapse'}}>
      <thead style={{background:T.bg3}}><tr>{headers.map(h=>(
        <th key={h} style={{fontSize:10,color:T.text3,textTransform:'uppercase',letterSpacing:'0.07em',padding:'8px 10px',textAlign:'left',fontWeight:600,borderBottom:`1px solid ${T.border}`}}>{h}</th>
      ))}</tr></thead>
      <tbody>{rows.map((r,i)=>(
        <tr key={i} style={{background:i%2===0?T.bg2:T.bg3}}>
          {r.map((c,j)=><td key={j} style={{fontSize:12,padding:'7px 10px',color:T.text,borderBottom:`1px solid ${T.border}`,fontFamily:j===r.length-1?'monospace':'inherit'}}>{c}</td>)}
        </tr>
      ))}</tbody>
    </table>
  </div>
}

function RankedList({title,rows}:{title:string;rows:{name:string;value:string;sub?:string}[]}) {
  return <div style={{marginBottom:16}}>
    <div style={{fontSize:12,color:T.text3,marginBottom:8}}>{title}</div>
    <div style={{border:`1px solid ${T.border}`,borderRadius:6,overflow:'hidden'}}>
      {rows.map((r,i)=>(
        <div key={i} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'8px 12px',background:i%2===0?T.bg2:T.bg3,borderBottom:i===rows.length-1?'none':`1px solid ${T.border}`}}>
          <div style={{fontSize:12,color:T.text,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',marginRight:12}}>{r.name}</div>
          <div style={{display:'flex',gap:10,alignItems:'center',flexShrink:0}}>
            <span style={{fontSize:12,fontFamily:'monospace',color:T.text,fontWeight:500}}>{r.value}</span>
            {r.sub && <span style={{fontSize:10,color:T.text3,fontFamily:'monospace'}}>{r.sub}</span>}
          </div>
        </div>
      ))}
    </div>
  </div>
}

// Server-side auth — redirect to login if no session
export async function getServerSideProps(context: any) {
  return requirePageAuth(context, 'view:reports')
}
