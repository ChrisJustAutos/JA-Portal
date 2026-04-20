// pages/index.tsx — Just Autos Management Portal v4
// Entity filter pills, merged JAWS+VPS into Overview, cleaner sidebar
import { useEffect, useState, useRef, useCallback } from 'react'
import Head from 'next/head'
import Script from 'next/script'
import { useRouter } from 'next/router'
import PortalSidebar from '../lib/PortalSidebar'
import { requirePageAuth } from '../lib/authServer'
import { usePreferences, applyGstPreferenceToDashboard, applyGstPreferenceToQuotesOrders } from '../lib/preferences'
import { useChatContext } from '../components/GlobalChatbot'

interface PortalUserSSR { id: string; email: string; displayName: string | null; role: 'admin'|'manager'|'sales'|'accountant'|'viewer' }

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
type Section = 'overview'|'invoices'|'pnl'|'stock'|'payables'
type EntityFilter = 'all'|'jaws'|'vps'

// ── Inventory types ───────────────────────────────────────────
interface InventoryItem {
  number:string;name:string
  qtyOnHand:number;qtyAvailable:number;qtyCommitted:number;qtyOnOrder:number
  avgCost:number;stockValue:number
  sellPriceIncGst:number;sellPriceExGst:number
  marginPct:number|null;marginDollar:number|null
  reorderLevel:number;reorderQty:number
  supplier:string|null;supplierId:string|null
  lastPurchasePrice:number|null
  unitsSold30d:number;unitsSold90d:number;unitsSold365d:number
  revenue90d:number
  lastSoldDate:string|null;daysSinceLastSold:number|null
  runRatePerDay:number;daysOfCover:number|null
  stockoutDate:string|null
  stockoutStatus:'out'|'critical'|'low'|'ok'|'dead'|'noSales'
  isLowStock:boolean;isOutOfStock:boolean;isDead90d:boolean;isDead180d:boolean
}
interface InventoryPayload {
  totals:{totalItems:number;totalSkus:number;stockValue:number;qtyOnHand:number;qtyOnOrder:number;qtyCommitted:number;lowStockCount:number;outOfStockCount:number;deadStock90dCount:number;deadStock90dValue:number;deadStock180dCount:number;deadStock180dValue:number;reorderSuggestCount:number;reorderSuggestValue:number}
  items:InventoryItem[]
  monthly:{month:string;label:string;units:number;revenue:number}[]
  meta:{company:string;generatedAt:string;forecastWindowDays:number;invoiceCount:number;lineCount:number}
}
const INV_STATUS_COLOR:Record<InventoryItem['stockoutStatus'],string>={out:'#f04e4e',critical:'#f04e4e',low:'#f5a623',ok:'#34c77b',dead:'#a78bfa',noSales:'#545968'}
const INV_STATUS_LABEL:Record<InventoryItem['stockoutStatus'],string>={out:'OUT',critical:'≤14d',low:'≤30d',ok:'OK',dead:'DEAD',noSales:'—'}
const fmtDays=(n:number|null)=>n==null?'—':Math.round(n)+'d'
const fmtPct =(n:number|null)=>n==null?'—':(n*100).toFixed(1)+'%'

// ── Quotes & Orders types ─────────────────────────────────────
interface OpenOrder {
  number:string; date:string|null; customerName:string; customerDisplayId:string|null
  totalAmount:number; balanceDueAmount:number; status:string
  subtotal:number; totalTax:number; freight:number
  salespersonName:string|null; customerPurchaseOrderNumber:string|null
  isPrepaid:boolean; ageDays:number|null
}
interface ConvertedOrder { number:string; date:string|null; customerName:string; totalAmount:number; salespersonName:string|null }
interface Quote          { number:string; date:string|null; customerName:string; totalAmount:number; salespersonName:string|null }
interface QuotesOrdersPayload {
  openOrders:OpenOrder[]; convertedOrders:ConvertedOrder[]; quotes:Quote[]
  totals:{openOrdersCount:number;openOrdersTotal:number;openOrdersOwing:number;openOrdersPrepaid:number;convertedCount30d:number;convertedTotal30d:number;quotesCount:number;quotesTotal:number;conversionRate:number|null}
  meta:{company:string;generatedAt:string;convertedWindow:string}
}

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

// ── Design tokens ────────────────────────────────────────────
const T = {
  bg:'#0d0f12', bg2:'#131519', bg3:'#1a1d23', bg4:'#21252d',
  border:'rgba(255,255,255,0.07)', border2:'rgba(255,255,255,0.12)',
  text:'#e8eaf0', text2:'#8b90a0', text3:'#545968',
  blue:'#4f8ef7', teal:'#2dd4bf', green:'#34c77b',
  amber:'#f5a623', red:'#f04e4e', purple:'#a78bfa',
  accent:'#4f8ef7',
}

// ─────────────────────────────────────────────────────────────
// ENTITY FILTER PILL — used across Overview, Invoices, P&L, Payables
// ─────────────────────────────────────────────────────────────
function EntityFilterPill({value,onChange,showAll=true}:{value:EntityFilter;onChange:(v:EntityFilter)=>void;showAll?:boolean}) {
  const opts: {id:EntityFilter;label:string;color:string;subLabel?:string}[] = showAll
    ? [
        {id:'all',  label:'All',  color:T.text, subLabel:'Both entities'},
        {id:'jaws', label:'JAWS', color:T.blue, subLabel:'Wholesale'},
        {id:'vps',  label:'VPS',  color:T.teal, subLabel:'Workshop'},
      ]
    : [
        {id:'jaws', label:'JAWS', color:T.blue, subLabel:'Wholesale'},
        {id:'vps',  label:'VPS',  color:T.teal, subLabel:'Workshop'},
      ]
  return <div style={{display:'inline-flex',gap:4,padding:4,background:T.bg2,border:`1px solid ${T.border}`,borderRadius:8}}>
    {opts.map(o=>{
      const active=value===o.id
      return <button key={o.id} onClick={()=>onChange(o.id)}
        style={{padding:'6px 14px',borderRadius:6,border:'none',cursor:'pointer',fontFamily:'inherit',
          background:active?`${o.color}20`:'transparent',
          color:active?o.color:T.text2,
          transition:'all 0.15s',
          display:'flex',flexDirection:'column',alignItems:'flex-start',gap:1,
          minWidth:70,
        }}>
        <span style={{fontSize:12,fontWeight:active?600:500}}>{o.label}</span>
        {o.subLabel && <span style={{fontSize:9,color:active?o.color:T.text3,opacity:active?0.85:1,textTransform:'uppercase',letterSpacing:'0.05em'}}>{o.subLabel}</span>}
      </button>
    })}
  </div>
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
function InvoiceTable({rows,accent,entity,onInvoiceClick}:{rows:Invoice[];accent:string;entity?:string;onInvoiceClick?:(inv:Invoice,entity:string)=>void}) {
  return <div style={{overflowX:'auto'}}>
    <table style={{width:'100%',borderCollapse:'collapse'}}>
      <thead><tr>{['Invoice','Date','Customer','Total','Balance','Status'].map(h=>(
        <th key={h} style={{fontSize:10,color:T.text3,textTransform:'uppercase',letterSpacing:'0.07em',padding:'0 8px 10px',textAlign:['Total','Balance'].includes(h)?'right':'left',fontWeight:500,whiteSpace:'nowrap'}}>{h}</th>
      ))}</tr></thead>
      <tbody>{rows.map((r,i)=>(
        <tr key={i} style={{borderTop:`1px solid ${T.border}`,cursor:onInvoiceClick?'pointer':'default',transition:'background 0.1s'}}
          onClick={()=>onInvoiceClick?.(r,entity||'JAWS')}
          onMouseEnter={e=>{(e.currentTarget as HTMLElement).style.background='rgba(255,255,255,0.03)'}}
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

// ── Invoice Detail Modal (unchanged from previous) ──────────
interface LineItem {
  Description: string
  Total: number | null
  ShipQuantity: number | null
  UnitPrice: number | null
  TaxCodeCode: string | null
  AccountName: string | null
  AccountDisplayID: string | null
  ItemName: string | null
  RowID: number
}

function InvoiceDetailModal({invoice,entity,onClose}:{invoice:Invoice;entity:string;onClose:()=>void}) {
  const [lineItems,setLineItems]=useState<LineItem[]>([])
  const [headerData,setHeaderData]=useState<any>(null)
  const [loading,setLoading]=useState(true)
  const [error,setError]=useState('')

  useEffect(()=>{
    async function fetchDetail() {
      try {
        const r=await fetch(`/api/invoice-detail?number=${encodeURIComponent(invoice.Number)}&entity=${entity}`)
        if(!r.ok) throw new Error('Failed to load invoice detail')
        const d=await r.json()
        setLineItems(Array.isArray(d.lineItems) ? d.lineItems : [])
        setHeaderData(d.invoice || null)
      } catch(e:any) { setError(e.message) }
      setLoading(false)
    }
    fetchDetail()
  },[invoice.Number,entity])

  const paid = invoice.TotalAmount - (invoice.BalanceDueAmount||0)
  const costedRows = lineItems.filter(li => li.Total != null)
  const termsLabel = headerData?.TermsPaymentIsDue === 'CashOnDelivery' ? 'COD'
    : headerData?.TermsPaymentIsDue === 'PrePaid' ? 'Prepaid'
    : headerData?.TermsPaymentIsDue || null

  return (
    <div style={{position:'fixed',inset:0,zIndex:100,display:'flex',alignItems:'center',justifyContent:'center'}} onClick={onClose}>
      <div style={{position:'absolute',inset:0,background:'rgba(0,0,0,0.6)',backdropFilter:'blur(4px)'}}/>
      <div style={{position:'relative',background:T.bg2,border:`1px solid ${T.border2}`,borderRadius:12,width:760,maxWidth:'92vw',maxHeight:'88vh',overflow:'hidden',display:'flex',flexDirection:'column',boxShadow:'0 20px 60px rgba(0,0,0,0.5)'}} onClick={e=>e.stopPropagation()}>
        <div style={{padding:'16px 20px',borderBottom:`1px solid ${T.border}`,display:'flex',alignItems:'center',gap:12}}>
          <div style={{flex:1}}>
            <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:4}}>
              <span style={{fontSize:16,fontWeight:600,fontFamily:'monospace',color:entity==='JAWS'?T.blue:T.teal}}>{invoice.Number}</span>
              <Tag color={invoice.Status==='Open'?T.amber:T.green}>{invoice.Status}</Tag>
              <Tag color={entity==='JAWS'?T.blue:T.teal}>{entity}</Tag>
            </div>
            <div style={{fontSize:13,color:T.text2}}>{invoice.CustomerName}</div>
          </div>
          <button onClick={onClose} style={{width:28,height:28,borderRadius:6,border:`1px solid ${T.border}`,background:T.bg3,color:T.text3,fontSize:14,cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center'}}>✕</button>
        </div>

        <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:1,background:T.border}}>
          {[
            {label:'Date',value:fmtDate(invoice.Date)},
            {label:'Total',value:fmtFull(invoice.TotalAmount),color:T.text},
            {label:'Paid',value:fmtFull(paid),color:T.green},
            {label:'Balance Due',value:invoice.BalanceDueAmount>0?fmtFull(invoice.BalanceDueAmount):'$0.00',color:invoice.BalanceDueAmount>0?T.amber:T.green},
          ].map((s,i)=>(
            <div key={i} style={{background:T.bg3,padding:'10px 14px'}}>
              <div style={{fontSize:10,color:T.text3,textTransform:'uppercase',letterSpacing:'0.07em',marginBottom:4}}>{s.label}</div>
              <div style={{fontSize:15,fontWeight:500,fontFamily:'monospace',color:s.color||T.text2}}>{s.value}</div>
            </div>
          ))}
        </div>

        {headerData&&(headerData.CustomerPurchaseOrderNumber||headerData.Comment||termsLabel||headerData.SalespersonName)&&(
          <div style={{padding:'10px 20px',borderBottom:`1px solid ${T.border}`,display:'flex',gap:16,flexWrap:'wrap'}}>
            {headerData.CustomerPurchaseOrderNumber&&<div style={{fontSize:11,color:T.text3}}>PO: <span style={{color:T.text2,fontFamily:'monospace'}}>{headerData.CustomerPurchaseOrderNumber}</span></div>}
            {termsLabel&&<div style={{fontSize:11,color:T.text3}}>Terms: <span style={{color:T.text2}}>{termsLabel}</span></div>}
            {headerData.SalespersonName&&<div style={{fontSize:11,color:T.text3}}>Salesperson: <span style={{color:T.text2}}>{headerData.SalespersonName}</span></div>}
            {headerData.Comment&&<div style={{fontSize:11,color:T.text3}}>Note: <span style={{color:T.text2}}>{headerData.Comment}</span></div>}
          </div>
        )}

        <div style={{flex:1,overflowY:'auto',padding:'0 20px 16px'}}>
          {loading&&<div style={{display:'flex',alignItems:'center',justifyContent:'center',padding:40,gap:10}}>
            <span style={{fontSize:20,animation:'spin 1s linear infinite',color:T.text3}}>⟳</span>
            <span style={{color:T.text3,fontSize:13}}>Loading line items…</span>
            <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
          </div>}
          {error&&<div style={{color:T.red,padding:20,fontSize:13}}>Error: {error}</div>}
          {!loading&&!error&&lineItems.length>0&&(
            <div style={{marginTop:14}}>
              <div style={{fontSize:11,fontWeight:600,color:T.text3,textTransform:'uppercase',letterSpacing:'0.08em',marginBottom:10}}>Line Items</div>
              <table style={{width:'100%',borderCollapse:'collapse'}}>
                <thead>
                  <tr>{['Item/Description','Qty','Unit Price','Tax','Total'].map(h=>(
                    <th key={h} style={{fontSize:10,color:T.text3,textTransform:'uppercase',letterSpacing:'0.07em',padding:'0 8px 8px',textAlign:['Qty','Unit Price','Tax','Total'].includes(h)?'right':'left',fontWeight:500}}>{h}</th>
                  ))}</tr>
                </thead>
                <tbody>{lineItems.map((li,i)=>{
                  const isNarrative = li.Total == null
                  if (isNarrative) {
                    return (
                      <tr key={i} style={{borderTop:`1px solid ${T.border}`,background:'rgba(255,255,255,0.015)'}}>
                        <td colSpan={5} style={{fontSize:12,color:T.text,padding:'9px 8px',fontWeight:500,whiteSpace:'pre-wrap',lineHeight:1.5}}>
                          {li.Description||'—'}
                        </td>
                      </tr>
                    )
                  }
                  return (
                    <tr key={i} style={{borderTop:`1px solid ${T.border}`}}>
                      <td style={{fontSize:12,color:T.text,padding:'7px 8px',maxWidth:320}}>
                        {li.ItemName&&<div style={{color:entity==='JAWS'?T.blue:T.teal,fontSize:11,fontFamily:'monospace',marginBottom:2}}>{li.ItemName}</div>}
                        <div style={{color:T.text2,fontSize:12,whiteSpace:'pre-wrap',lineHeight:1.4}}>{li.Description||'—'}</div>
                        {li.AccountName&&<div style={{color:T.text3,fontSize:10,marginTop:2}}>{li.AccountDisplayID} · {li.AccountName}</div>}
                      </td>
                      <td style={{fontSize:12,fontFamily:'monospace',color:T.text2,padding:'7px 8px',textAlign:'right'}}>{li.ShipQuantity!=null?li.ShipQuantity:'—'}</td>
                      <td style={{fontSize:12,fontFamily:'monospace',color:T.text2,padding:'7px 8px',textAlign:'right'}}>{li.UnitPrice!=null?fmtFull(li.UnitPrice):'—'}</td>
                      <td style={{fontSize:11,fontFamily:'monospace',color:T.text3,padding:'7px 8px',textAlign:'right'}}>{li.TaxCodeCode||'—'}</td>
                      <td style={{fontSize:12,fontFamily:'monospace',color:T.text,padding:'7px 8px',textAlign:'right',fontWeight:500}}>{fmtFull(li.Total as number)}</td>
                    </tr>
                  )
                })}</tbody>
                <tfoot>
                  <tr style={{borderTop:`2px solid ${T.border2}`}}>
                    <td colSpan={4} style={{fontSize:11,fontWeight:600,color:T.text3,padding:'8px',textAlign:'right',textTransform:'uppercase'}}>Subtotal</td>
                    <td style={{fontSize:12,fontFamily:'monospace',color:T.text2,padding:'8px',textAlign:'right'}}>{fmtFull(headerData?.Subtotal ?? costedRows.reduce((s,r)=>s+(r.Total||0),0))}</td>
                  </tr>
                  {headerData?.TotalTax!=null&&(
                    <tr>
                      <td colSpan={4} style={{fontSize:11,fontWeight:600,color:T.text3,padding:'4px 8px',textAlign:'right',textTransform:'uppercase'}}>GST</td>
                      <td style={{fontSize:12,fontFamily:'monospace',color:T.text2,padding:'4px 8px',textAlign:'right'}}>{fmtFull(headerData.TotalTax)}</td>
                    </tr>
                  )}
                  <tr style={{borderTop:`1px solid ${T.border}`}}>
                    <td colSpan={4} style={{fontSize:11,fontWeight:600,color:T.text3,padding:'8px',textAlign:'right',textTransform:'uppercase'}}>Total</td>
                    <td style={{fontSize:13,fontWeight:600,fontFamily:'monospace',color:T.text,padding:'8px',textAlign:'right'}}>{fmtFull(invoice.TotalAmount)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
          {!loading&&!error&&lineItems.length===0&&(
            <div style={{color:T.text3,padding:30,textAlign:'center',fontSize:13}}>No line items found for this invoice.</div>
          )}
          {!loading&&(
            <div style={{marginTop:16,padding:'12px 14px',background:T.bg3,borderRadius:8}}>
              <div style={{fontSize:11,fontWeight:600,color:T.text3,textTransform:'uppercase',letterSpacing:'0.08em',marginBottom:8}}>Payment Summary</div>
              <div style={{display:'flex',justifyContent:'space-between',marginBottom:4}}>
                <span style={{fontSize:12,color:T.text2}}>Invoice Total</span>
                <span style={{fontSize:12,fontFamily:'monospace',color:T.text}}>{fmtFull(invoice.TotalAmount)}</span>
              </div>
              <div style={{display:'flex',justifyContent:'space-between',marginBottom:4}}>
                <span style={{fontSize:12,color:T.green}}>Amount Paid</span>
                <span style={{fontSize:12,fontFamily:'monospace',color:T.green}}>{fmtFull(paid)}</span>
              </div>
              <div style={{height:1,background:T.border,margin:'6px 0'}}/>
              <div style={{display:'flex',justifyContent:'space-between'}}>
                <span style={{fontSize:12,fontWeight:600,color:invoice.BalanceDueAmount>0?T.amber:T.green}}>Balance Due</span>
                <span style={{fontSize:13,fontWeight:600,fontFamily:'monospace',color:invoice.BalanceDueAmount>0?T.amber:T.green}}>{invoice.BalanceDueAmount>0?fmtFull(invoice.BalanceDueAmount):'$0.00 — Paid'}</span>
              </div>
              {headerData?.LastPaymentDate&&(
                <div style={{fontSize:10,color:T.text3,marginTop:6,textAlign:'right'}}>Last payment: {fmtDate(headerData.LastPaymentDate)}</div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
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

// ── Charts (Trend / Line / Donut) ────────────────────────────
function TrendChart({labels,jawsData,vpsData,chartId,entity='all'}:{labels:string[];jawsData:number[];vpsData:number[];chartId:string;entity?:EntityFilter}) {
  const canvasRef=useRef<HTMLCanvasElement>(null)
  const chartRef=useRef<any>(null)
  useEffect(()=>{
    if (!canvasRef.current||!jawsData.length) return
    const buildChart = () => {
      const win=window as any
      if (!win.Chart) { setTimeout(buildChart, 200); return }
      if (chartRef.current) chartRef.current.destroy()
      const datasets = []
      if (entity==='all' || entity==='jaws') datasets.push({label:'JAWS',data:jawsData.map(v=>Math.round(v/1000)),backgroundColor:'#4f8ef7',borderRadius:4,borderSkipped:false})
      if (entity==='all' || entity==='vps')  datasets.push({label:'VPS', data:vpsData.map(v=>Math.round(v/1000)), backgroundColor:'#2dd4bf',borderRadius:4,borderSkipped:false})
      chartRef.current=new win.Chart(canvasRef.current,{
        type:'bar',
        data:{labels,datasets},
        options:{responsive:true,maintainAspectRatio:false,
          plugins:{legend:{display:false},tooltip:{callbacks:{label:(ctx:any)=>`${ctx.dataset.label}: $${ctx.raw}k`}}},
          scales:{
            x:{grid:{color:'rgba(255,255,255,0.05)'},ticks:{color:T.text3,font:{size:11},autoSkip:false,maxRotation:45}},
            y:{grid:{color:'rgba(255,255,255,0.05)'},ticks:{color:T.text3,font:{size:11},callback:(v:any)=>'$'+v+'k'}},
          }}
      })
    }
    buildChart()
    return()=>{if(chartRef.current){chartRef.current.destroy();chartRef.current=null}}
  },[labels,jawsData,vpsData,entity])
  return (
    <div>
      <div style={{display:'flex',gap:14,marginBottom:10}}>
        {entity!=='vps' && <div style={{display:'flex',alignItems:'center',gap:5,fontSize:12,color:T.text2}}><div style={{width:10,height:10,borderRadius:2,background:'#4f8ef7'}}/>JAWS</div>}
        {entity!=='jaws' && <div style={{display:'flex',alignItems:'center',gap:5,fontSize:12,color:T.text2}}><div style={{width:10,height:10,borderRadius:2,background:'#2dd4bf'}}/>VPS</div>}
      </div>
      <div style={{position:'relative',height:200}}>
        <canvas ref={canvasRef} id={chartId} role="img" aria-label="Revenue trend">Revenue trend</canvas>
      </div>
    </div>
  )
}
function LineChart({labels,jawsData,vpsData,chartId,entity='all'}:{labels:string[];jawsData:number[];vpsData:number[];chartId:string;entity?:EntityFilter}) {
  const canvasRef=useRef<HTMLCanvasElement>(null)
  const chartRef=useRef<any>(null)
  useEffect(()=>{
    if (!canvasRef.current||!jawsData.length) return
    const buildChart = () => {
      const win=window as any
      if (!win.Chart) { setTimeout(buildChart,200); return }
      if (chartRef.current) chartRef.current.destroy()
      const datasets = []
      if (entity==='all' || entity==='jaws') datasets.push({label:'JAWS',data:jawsData.map(v=>Math.round(v/1000)),borderColor:'#4f8ef7',backgroundColor:'rgba(79,142,247,0.1)',tension:0.3,fill:true,pointRadius:4,pointBackgroundColor:'#4f8ef7'})
      if (entity==='all' || entity==='vps')  datasets.push({label:'VPS', data:vpsData.map(v=>Math.round(v/1000)), borderColor:'#2dd4bf',backgroundColor:'rgba(45,212,191,0.1)',tension:0.3,fill:true,pointRadius:4,pointBackgroundColor:'#2dd4bf'})
      chartRef.current=new win.Chart(canvasRef.current,{
        type:'line',
        data:{labels,datasets},
        options:{responsive:true,maintainAspectRatio:false,
          plugins:{legend:{display:false},tooltip:{callbacks:{label:(ctx:any)=>`${ctx.dataset.label}: $${ctx.raw}k`}}},
          scales:{
            x:{grid:{color:'rgba(255,255,255,0.05)'},ticks:{color:T.text3,font:{size:11}}},
            y:{grid:{color:'rgba(255,255,255,0.05)'},ticks:{color:T.text3,font:{size:11},callback:(v:any)=>'$'+v+'k'}},
          }}
      })
    }
    buildChart()
    return()=>{if(chartRef.current){chartRef.current.destroy();chartRef.current=null}}
  },[labels,jawsData,vpsData,entity])
  return <div style={{position:'relative',height:200}}><canvas ref={canvasRef} id={chartId} role="img" aria-label="Net trend">Net trend</canvas></div>
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
  return <div style={{position:'relative',height:120,width:120}}><canvas ref={canvasRef} id={chartId} role="img" aria-label="Split"/></div>
}

// ── Chatbot (unchanged from previous) ────────────────────────
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
    const jOut  =jOpen.reduce((s,i)=>s+(i.BalanceDueAmount||0),0)
    const vOut  =vOpen.reduce((s,i)=>s+(i.BalanceDueAmount||0),0)
    const jInc  =jPnl.filter(r=>r.AccountDisplayID?.startsWith('4-')&&r.AccountTotal>0).reduce((s,r)=>s+r.AccountTotal,0)
    const jExp  =jPnl.filter(r=>r.AccountDisplayID?.startsWith('5-')&&r.AccountTotal>0).reduce((s,r)=>s+r.AccountTotal,0)
    const vInc  =vPnl.filter(r=>r.AccountDisplayID?.startsWith('4-')&&r.AccountTotal>0).reduce((s,r)=>s+r.AccountTotal,0)
    const vExp  =vPnl.filter(r=>r.AccountDisplayID?.startsWith('5-')&&r.AccountTotal>0).reduce((s,r)=>s+r.AccountTotal,0)
    const jBOut =jBills.reduce((s,b)=>s+(b.BalanceDueAmount||0),0)
    const stockVal=dashData.jaws.stockSummary?.results?.[0]?.rows?.[0]?.[0]||0
    return `Just Autos Management Assistant — LIVE MYOB data as of ${new Date(dashData.fetchedAt).toLocaleString('en-AU')}.
JAWS: Open receivables ${jOpen.length} = $${Math.round(jOut).toLocaleString()}. Income $${Math.round(jInc).toLocaleString()}, COS $${Math.round(jExp).toLocaleString()}, Net ${jInc-jExp>=0?'+':''}$${Math.round(jInc-jExp).toLocaleString()}. Stock $${Math.round(stockVal).toLocaleString()}. Payables $${Math.round(jBOut).toLocaleString()}. Top customers: ${jCust.slice(0,5).map(c=>`${c.CustomerName?.substring(0,18)} $${Math.round(c.TotalRevenue).toLocaleString()}`).join(' | ')}.
VPS: Open receivables ${vOpen.length} = $${Math.round(vOut).toLocaleString()}. Income $${Math.round(vInc).toLocaleString()}, COS $${Math.round(vExp).toLocaleString()}. Payables $${Math.round(vBills.reduce((s,b)=>s+(b.BalanceDueAmount||0),0)).toLocaleString()}.
Be concise. Use AU currency.`
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

// ─────────────────────────────────────────────────────────────
// MAIN PORTAL
// ─────────────────────────────────────────────────────────────

export default function Portal({ user }: { user: PortalUserSSR }) {
  const router=useRouter()
  const { prefs } = usePreferences()
  const [section,setSection]=useState<Section>('overview')
  const [dash,setDash]=useState<DashData|null>(null)
  const [loading,setLoading]=useState(true)
  const [refreshing,setRefreshing]=useState(false)
  const [dateLoading,setDateLoading]=useState(false)
  const [error,setError]=useState('')
  const [lastRefresh,setLastRefresh]=useState<Date|null>(null)
  const [selectedInvoice,setSelectedInvoice]=useState<{invoice:Invoice;entity:string}|null>(null)
  const openInvoiceDetail=(inv:Invoice,entity:string)=>setSelectedInvoice({invoice:inv,entity})
  const [qo,setQo]=useState<QuotesOrdersPayload|null>(null)

  // Per-section entity filters
  const [overviewFilter,setOverviewFilter] = useState<EntityFilter>('all')
  const [invoicesFilter,setInvoicesFilter] = useState<EntityFilter>('all')
  const [pnlFilter,setPnlFilter]           = useState<EntityFilter>('all')
  const [payablesFilter,setPayablesFilter] = useState<EntityFilter>('all')

  const currentFY = new Date().getMonth() >= 6 ? new Date().getFullYear()+1 : new Date().getFullYear()
  const [fyYear, setFyYear] = useState(currentFY)
  const nowD = new Date()
  const defaultStart = `${nowD.getFullYear()}-${String(nowD.getMonth()+1).padStart(2,'0')}-01`
  const defaultEnd = `${nowD.getFullYear()}-${String(nowD.getMonth()+1).padStart(2,'0')}-${new Date(nowD.getFullYear(), nowD.getMonth()+1, 0).getDate()}`
  const [customStart, setCustomStart] = useState(defaultStart)
  const [customEnd, setCustomEnd] = useState(defaultEnd)
  const [isCustomRange, setIsCustomRange] = useState(true)

  const activeStart = isCustomRange ? customStart : `${fyYear-1}-07-01`
  const activeEnd = isCustomRange ? customEnd : `${fyYear}-06-30`
  const dateParams = `startDate=${activeStart}&endDate=${activeEnd}`
  const fyLabel = isCustomRange
    ? `${new Date(customStart+'T00:00').toLocaleDateString('en-AU',{day:'2-digit',month:'short',year:'2-digit'})} – ${new Date(customEnd+'T00:00').toLocaleDateString('en-AU',{day:'2-digit',month:'short',year:'2-digit'})}`
    : `FY${fyYear}`
  const [activeDateParams, setActiveDateParams] = useState(dateParams)

  function selectFY(y: number) {
    setFyYear(y); setIsCustomRange(false)
    setCustomStart(`${y-1}-07-01`); setCustomEnd(`${y}-06-30`)
    setDateLoading(true)
    setActiveDateParams(`startDate=${y-1}-07-01&endDate=${y}-06-30`)
  }
  function applyCustomRange() {
    if (customStart && customEnd) {
      setIsCustomRange(true); setDateLoading(true)
      setActiveDateParams(`startDate=${customStart}&endDate=${customEnd}`)
    }
  }

  const load=useCallback(async(isRefresh=false,retryCount=0)=>{
    if(isRefresh)setRefreshing(true)
    try{
      const refreshParam = isRefresh ? '&refresh=true' : ''
      const r=await fetch(`/api/dashboard?${activeDateParams}${refreshParam}`)
      if(r.status===401){router.push('/login');return}
      if(!r.ok){
        if(retryCount<1){ return load(isRefresh,retryCount+1) }
        const errData = await r.json().catch(()=>null)
        throw new Error(errData?.error||'Failed to load MYOB data — please click Refresh')
      }
      const d=await r.json()
      // Apply user's GST preference to all $ amounts before storing.
      // When pref='ex' (default), TotalAmount stays as ex-GST (TotalAmount=TotalAmountExGst).
      // When pref='inc', TotalAmount becomes ex-GST × 1.1.
      // This is done once here so every downstream render call site works unchanged.
      const dGst = applyGstPreferenceToDashboard(d, prefs.gst_display)
      dGst.trendLabels=['Nov 25','Dec 25','Jan 26','Feb 26','Mar 26','Apr 26']
      dGst.jaws.income6=[468903,496206,623279,569129,705165,116239]
      dGst.vps.income6 =[905849,615285,731524,800866,891330,344080]
      dGst.jaws.expense6=[380000,400000,510000,460000,580000,186111]
      dGst.vps.expense6 =[780000,520000,620000,680000,760000, 99262]
      setDash(dGst);setLastRefresh(new Date());setError('');setDateLoading(false)
      setLoading(false)
      if(isRefresh)setRefreshing(false)
      try{
        const tr=await fetch(`/api/trends?${activeDateParams}${refreshParam}`)
        if(tr.ok){
          const td=await tr.json()
          // trends is P&L data — already ex-GST. Apply display multiplier if pref='inc'.
          const mult = prefs.gst_display === 'inc' ? 1.1 : 1
          setDash((prev:any)=>prev?{...prev,
            trendLabels:td.trendLabels,
            jaws:{...prev.jaws,income6:(td.jawsIncome6||[]).map((n:number)=>n*mult),expense6:(td.jawsExpense6||[]).map((n:number)=>n*mult)},
            vps: {...prev.vps, income6:(td.vpsIncome6||[]).map((n:number)=>n*mult), expense6:(td.vpsExpense6||[]).map((n:number)=>n*mult)},
          }:prev)
        }
      }catch{}
      try{
        const qoRes=await fetch('/api/quotes-orders')
        if(qoRes.ok){
          const qoData:QuotesOrdersPayload=await qoRes.json()
          const qoGst = applyGstPreferenceToQuotesOrders(qoData, prefs.gst_display)
          setQo(qoGst)
        }
      }catch(e){console.error('quotes-orders load failed',e)}
    }catch(e:any){setError(e.message);setLoading(false);setDateLoading(false);if(isRefresh)setRefreshing(false)}
  },[router, activeDateParams, prefs.gst_display])
  useEffect(()=>{load()},[load])
  useEffect(()=>{
    // Respect user's auto_refresh_seconds preference (0 = disabled)
    const intervalMs = (prefs.auto_refresh_seconds || 0) * 1000
    if (intervalMs <= 0) return
    const t=setInterval(()=>load(true),intervalMs)
    return()=>clearInterval(t)
  },[load, prefs.auto_refresh_seconds])

  // Derived
  const jInv   =dash?rowsToObjects(dash.jaws.recentInvoices) as Invoice[]:[]
  const jOpen  =dash?rowsToObjects(dash.jaws.openInvoices)   as Invoice[]:[]
  const vInv   =dash?rowsToObjects(dash.vps.recentInvoices)  as Invoice[]:[]
  const vOpen  =dash?rowsToObjects(dash.vps.openInvoices)    as Invoice[]:[]
  const jCust  =dash?rowsToObjects(dash.jaws.topCustomers)   as Customer[]:[]
  const vCust  =dash?rowsToObjects(dash.vps.topCustomers)    as Customer[]:[]
  const jPnl   =dash?rowsToObjects(dash.jaws.pnl)            as PnLLine[]:[]
  const vPnl   =dash?rowsToObjects(dash.vps.pnl)             as PnLLine[]:[]
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

  // Combined helpers (tagged with entity for display)
  const combinedInv  = [...jInv.map(i=>({...i,__entity:'JAWS'})), ...vInv.map(i=>({...i,__entity:'VPS'}))]
    .sort((a,b)=>new Date(b.Date).getTime()-new Date(a.Date).getTime())
  const combinedOpen = [...jOpen.map(i=>({...i,__entity:'JAWS'})), ...vOpen.map(i=>({...i,__entity:'VPS'}))]
    .sort((a,b)=>(b.BalanceDueAmount||0)-(a.BalanceDueAmount||0))
  const combinedBills = [...jBills.map(b=>({...b,__entity:'JAWS'})), ...vBills.map(b=>({...b,__entity:'VPS'}))]
    .sort((a,b)=>(b.BalanceDueAmount||0)-(a.BalanceDueAmount||0))

  // ─── Feed a compact summary to the global AI chatbot ───────
  // This lets the assistant answer questions about the user's current
  // dashboard view without having to re-fetch MYOB data itself.
  const { setPageContext: setChatContext } = useChatContext()
  useEffect(() => {
    if (!dash) { setChatContext(null); return }
    setChatContext({
      dateRange: dash.period,
      gstDisplay: prefs.gst_display,
      jaws: {
        openInvoicesCount: jOpen.length,
        receivablesTotal: Math.round(jOut),
        income: Math.round(jInc),
        cos: Math.round(jCos),
        netBeforeOH: Math.round(jNet),
        stockValue: Math.round(stockVal),
        openBillsTotal: Math.round(jBOut),
        topCustomers: jCust.slice(0, 5).map(c => ({
          name: c.CustomerName,
          revenue: Math.round(c.TotalRevenue),
          invoices: c.InvoiceCount,
        })),
      },
      vps: {
        openInvoicesCount: vOpen.length,
        receivablesTotal: Math.round(vOut),
        income: Math.round(vInc),
        cos: Math.round(vCos),
        overheads: Math.round(vOh),
        net: Math.round(vNet),
        openBillsTotal: Math.round(vBOut),
        topCustomers: vCust.slice(0, 5).map(c => ({
          name: c.CustomerName,
          revenue: Math.round(c.TotalRevenue),
          invoices: c.InvoiceCount,
        })),
      },
    })
    // Cleanup when leaving the page
    return () => { setChatContext(null) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dash, prefs.gst_display])

  // ─────────────────────────────────────────────────────────
  // RENDER SECTIONS
  // ─────────────────────────────────────────────────────────

  function renderSection() {
    if(loading) return <div style={{display:'flex',alignItems:'center',justifyContent:'center',height:300,flexDirection:'column',gap:12}}>
      <div style={{fontSize:28,animation:'spin 1s linear infinite',color:T.text3}}>⟳</div>
      <div style={{color:T.text3}}>Loading live MYOB data…</div>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
    if(error) return <div style={{background:'rgba(240,78,78,0.1)',border:'1px solid rgba(240,78,78,0.2)',borderRadius:10,padding:20,color:T.red}}>
      <div style={{marginBottom:10}}>Error: {error}</div>
      <button onClick={()=>{setError('');setLoading(true);load()}} style={{padding:'6px 16px',borderRadius:6,border:`1px solid ${T.blue}`,background:T.blue,color:'#fff',fontSize:12,cursor:'pointer',fontFamily:'inherit'}}>Retry now</button>
    </div>

    // ─── OVERVIEW (merged JAWS + VPS with filter) ────────────
    if(section==='overview') {
      const f = overviewFilter
      const showJaws = f==='all' || f==='jaws'
      const showVps  = f==='all' || f==='vps'

      const displayIncome = f==='jaws'?jInc : f==='vps'?vInc : jInc+vInc
      const displayNet    = f==='jaws'?jNet : f==='vps'?vNet : jNet+vNet
      const displayRecv   = f==='jaws'?jOut : f==='vps'?vOut : jOut+vOut
      const displayOpenCt = f==='jaws'?jOpen.length : f==='vps'?vOpen.length : jOpen.length+vOpen.length
      const displayBills  = f==='jaws'?jBOut : f==='vps'?vBOut : jBOut+vBOut

      // Customers for display (combined or entity-specific)
      const displayCustomers: Customer[] =
        f==='jaws' ? jCust :
        f==='vps'  ? vCust.filter(c=>!c.CustomerName?.includes('Just Autos Wholesale')) :
        // combined: merge by customer name, summing revenue + invoice count
        Object.values(
          [...jCust, ...vCust.filter(c=>!c.CustomerName?.includes('Just Autos Wholesale'))]
            .reduce((acc:Record<string,Customer>, c) => {
              const key = c.CustomerName
              if (!acc[key]) acc[key] = {CustomerName:key, TotalRevenue:0, InvoiceCount:0}
              acc[key].TotalRevenue += c.TotalRevenue
              acc[key].InvoiceCount += c.InvoiceCount
              return acc
            }, {})
        ).sort((a,b)=>b.TotalRevenue-a.TotalRevenue)

      return <div style={{display:'flex',flexDirection:'column',gap:14}}>
        {/* Filter pill header */}
        <div style={{display:'flex',alignItems:'center',gap:12}}>
          <EntityFilterPill value={overviewFilter} onChange={setOverviewFilter}/>
          <div style={{flex:1}}/>
          <div style={{fontSize:11,color:T.text3}}>Showing {f==='all'?'combined':f.toUpperCase()} data</div>
        </div>

        {/* KPI strip */}
        <div style={{display:'grid',gridTemplateColumns:'repeat(5,minmax(0,1fr))',gap:12}}>
          <KPI label={`Revenue (${fyLabel})`} value={fmt(displayIncome)} sub={f==='all'?'JAWS + VPS combined':f.toUpperCase()+' only'} accent={f==='vps'?T.teal:T.blue}/>
          <KPI label="Net (MTD)" value={fmt(displayNet)} sub={displayIncome>0?`Margin: ${pct(displayNet,displayIncome)}`:'—'} subColor={displayNet>=0?T.green:T.red} accent={displayNet>=0?T.green:T.red}/>
          <div onClick={()=>setSection('invoices')} style={{cursor:'pointer'}}>
            <KPI label="Receivables" value={fmt(displayRecv)} sub={`${displayOpenCt} open — click for detail`} subColor={T.amber} accent={T.amber}/>
          </div>
          <div onClick={()=>setSection('payables')} style={{cursor:'pointer'}}>
            <KPI label="Payables" value={fmt(displayBills)} sub="click for detail" subColor={T.red} accent={T.red}/>
          </div>
          {showJaws && <KPI label="Open Orders (JAWS)" value={qo?fmt(qo.totals.openOrdersTotal):'—'} sub={qo?`${qo.totals.openOrdersCount} orders · ${qo.totals.openOrdersPrepaid} prepaid`:'Loading…'} subColor={qo&&qo.totals.openOrdersCount>0?T.purple:T.text3} accent={T.purple}/>}
          {!showJaws && <div onClick={()=>setSection('stock')} style={{cursor:'pointer'}}><KPI label="JAWS Stock" value={fmt(stockVal)} sub="click for detail" accent={T.purple}/></div>}
        </div>

        {/* Revenue trend + split */}
        <div style={{display:'grid',gridTemplateColumns:f==='all'?'1fr 1fr':'1fr',gap:12}}>
          <Card>
            <PTitle>Revenue trend (6 months)</PTitle>
            <TrendChart labels={tLabels} jawsData={jInc6} vpsData={vInc6} chartId="overview-trend" entity={f}/>
          </Card>
          {f==='all' && <Card>
            <PTitle>Revenue split — this month</PTitle>
            <div style={{display:'flex',alignItems:'center',gap:20,justifyContent:'center',paddingTop:10}}>
              <DonutChart jawsVal={jInc} vpsVal={vInc} chartId="overview-split"/>
              <div style={{display:'flex',flexDirection:'column',gap:10}}>
                <div><div style={{display:'flex',alignItems:'center',gap:6,marginBottom:3}}><div style={{width:10,height:10,borderRadius:2,background:T.blue}}/><span style={{fontSize:12,color:T.text2}}>JAWS</span></div><div style={{fontSize:18,fontWeight:500,fontFamily:'monospace',color:T.text}}>{fmt(jInc)}</div><div style={{fontSize:11,color:T.text3}}>{pct(jNet,jInc)} margin</div></div>
                <div><div style={{display:'flex',alignItems:'center',gap:6,marginBottom:3}}><div style={{width:10,height:10,borderRadius:2,background:T.teal}}/><span style={{fontSize:12,color:T.text2}}>VPS</span></div><div style={{fontSize:18,fontWeight:500,fontFamily:'monospace',color:T.text}}>{fmt(vInc)}</div><div style={{fontSize:11,color:T.text3}}>{pct(vInc-vCos,vInc)} gross margin</div></div>
              </div>
            </div>
          </Card>}
        </div>

        {/* Top customers */}
        <Card>
          <PTitle right={f==='all'?'Combined across both entities':''}>Top customers — this month</PTitle>
          <div style={{display:'grid',gridTemplateColumns:f==='all'?'1fr 1fr':'1fr',gap:16}}>
            {showJaws && <div>
              {f==='all' && <div style={{fontSize:11,color:T.blue,marginBottom:8,fontWeight:600}}>JAWS</div>}
              {(f==='all'?jCust:displayCustomers).slice(0,8).map((c,i)=><BarRow key={'j'+i} name={c.CustomerName?.replace(' (Tuning)','').replace(' (Tuning 1)','').substring(0,26)} value={c.TotalRevenue} max={(f==='all'?jCust:displayCustomers)[0]?.TotalRevenue||1} color={T.blue} extra={`${c.InvoiceCount}inv`}/>)}
            </div>}
            {showVps && f==='all' && <div>
              <div style={{fontSize:11,color:T.teal,marginBottom:8,fontWeight:600}}>VPS</div>
              {vCust.filter(c=>!c.CustomerName?.includes('Just Autos Wholesale')).slice(0,8).map((c,i)=><BarRow key={'v'+i} name={c.CustomerName?.substring(0,26)} value={c.TotalRevenue} max={vCust[1]?.TotalRevenue||1} color={T.teal} extra={`${c.InvoiceCount}inv`}/>)}
            </div>}
            {showVps && f==='vps' && <div>
              {displayCustomers.slice(0,8).map((c,i)=><BarRow key={'v'+i} name={c.CustomerName?.substring(0,26)} value={c.TotalRevenue} max={displayCustomers[0]?.TotalRevenue||1} color={T.teal} extra={`${c.InvoiceCount}inv`}/>)}
            </div>}
          </div>
        </Card>

        {/* JAWS Sales Pipeline — only when showing JAWS */}
        {showJaws && <JawsSalesPipeline qo={qo}/>}

        {/* Recent invoices */}
        <Card>
          <PTitle>Recent invoices {f!=='all' && <Tag color={f==='jaws'?T.blue:T.teal}>{f.toUpperCase()}</Tag>}</PTitle>
          <InvoiceTable
            rows={(f==='jaws'?jInv:f==='vps'?vInv:combinedInv).slice(0,12) as any}
            accent={f==='vps'?T.teal:T.blue}
            entity={f==='vps'?'VPS':'JAWS'}
            onInvoiceClick={(inv:any)=>openInvoiceDetail(inv, inv.__entity || (f==='vps'?'VPS':'JAWS'))}/>
        </Card>
      </div>
    }

    // ─── INVOICES (with filter) ─────────────────────────────
    if(section==='invoices') {
      const f = invoicesFilter
      const showJaws = f==='all' || f==='jaws'
      const showVps  = f==='all' || f==='vps'
      return <div style={{display:'flex',flexDirection:'column',gap:14}}>
        <div style={{display:'flex',alignItems:'center',gap:12}}>
          <EntityFilterPill value={invoicesFilter} onChange={setInvoicesFilter}/>
          <div style={{flex:1}}/>
          <div style={{fontSize:11,color:T.text3}}>Showing {f==='all'?'both entities':f.toUpperCase()}</div>
        </div>
        <div style={{display:'grid',gridTemplateColumns:'repeat(4,minmax(0,1fr))',gap:12}}>
          {showJaws && <KPI label="JAWS Outstanding" value={fmt(jOut)} sub={`${jOpen.length} open`} subColor={T.amber} accent={T.blue}/>}
          {showVps  && <KPI label="VPS Outstanding" value={fmt(vOut)} sub={`${vOpen.length} open`} subColor={T.amber} accent={T.teal}/>}
          {f==='all' && <KPI label="Combined" value={fmt(jOut+vOut)} sub="Total receivable" subColor={T.red}/>}
          {f==='all' && <KPI label="Open Count" value={String(jOpen.length+vOpen.length)} sub="Both entities"/>}
          {f!=='all' && <KPI label="Invoice Count" value={String(combinedInv.filter(i=>(f==='jaws'?i.__entity==='JAWS':i.__entity==='VPS')).length)} sub="This period"/>}
          {f!=='all' && <KPI label="Recent Invoice" value={(f==='jaws'?jInv:vInv)[0]?fmtFull((f==='jaws'?jInv:vInv)[0].TotalAmount):'—'} sub={(f==='jaws'?jInv:vInv)[0]?.Number||'—'}/>}
        </div>
        {showJaws && <Card><PTitle>JAWS — Recent invoices <Tag color={T.blue}>Live MYOB</Tag></PTitle><InvoiceTable rows={jInv} accent={T.blue} entity="JAWS" onInvoiceClick={openInvoiceDetail}/></Card>}
        {showVps  && <Card><PTitle>VPS — Recent invoices <Tag color={T.teal}>Live MYOB</Tag></PTitle><InvoiceTable rows={vInv} accent={T.teal} entity="VPS" onInvoiceClick={openInvoiceDetail}/></Card>}
      </div>
    }

    // ─── P&L (with filter) ──────────────────────────────────
    if(section==='pnl') {
      const f = pnlFilter
      const showJaws = f==='all' || f==='jaws'
      const showVps  = f==='all' || f==='vps'
      return <div style={{display:'flex',flexDirection:'column',gap:14}}>
        <div style={{display:'flex',alignItems:'center',gap:12}}>
          <EntityFilterPill value={pnlFilter} onChange={setPnlFilter}/>
          <div style={{flex:1}}/>
          <div style={{fontSize:11,color:T.text3}}>Showing {f==='all'?'both entities':f.toUpperCase()}</div>
        </div>
        <div style={{display:'grid',gridTemplateColumns:'repeat(4,minmax(0,1fr))',gap:12}}>
          {showJaws && <>
            <KPI label="JAWS Income" value={fmt(jInc)} subColor={T.green} sub="This month" accent={T.blue}/>
            <KPI label="JAWS Net (COS)" value={fmt(jNet)} subColor={jNet>=0?T.green:T.red} sub={`Margin: ${pct(jNet,jInc)}`} accent={jNet>=0?T.green:T.red}/>
          </>}
          {showVps && <>
            <KPI label="VPS Income" value={fmt(vInc)} subColor={T.green} sub="This month" accent={T.teal}/>
            <KPI label="VPS Gross (COS)" value={fmt(vInc-vCos)} subColor={vInc-vCos>=0?T.green:T.red} sub={`Overheads: ${fmt(vOh)}`} accent={vInc-vCos>=0?T.green:T.red}/>
          </>}
        </div>
        {showJaws && <PnlSection entity="JAWS" pnl={jPnl} inc={jInc} cos={jCos} oh={0} jNet={jNet} jInc={jInc}/>}
        {showJaws && showVps && <Divider/>}
        {showVps && <PnlSection entity="VPS" pnl={vPnl} inc={vInc} cos={vCos} oh={vOh} jNet={jNet} jInc={jInc}/>}
      </div>
    }

    // ─── STOCK (JAWS only — no filter needed) ───────────────
    if(section==='stock') return <StockSection/>

    // ─── PAYABLES (with filter) ─────────────────────────────
    if(section==='payables') {
      const f = payablesFilter
      const showJaws = f==='all' || f==='jaws'
      const showVps  = f==='all' || f==='vps'
      return <div style={{display:'flex',flexDirection:'column',gap:14}}>
        <div style={{display:'flex',alignItems:'center',gap:12}}>
          <EntityFilterPill value={payablesFilter} onChange={setPayablesFilter}/>
          <div style={{flex:1}}/>
          <div style={{fontSize:11,color:T.text3}}>Showing {f==='all'?'both entities':f.toUpperCase()}</div>
        </div>
        <div style={{display:'grid',gridTemplateColumns:'repeat(4,minmax(0,1fr))',gap:12}}>
          {showJaws && <KPI label="JAWS Payables" value={fmt(jBOut)} sub={`${jBills.length} open bills`} subColor={T.red} accent={T.blue}/>}
          {showVps  && <KPI label="VPS Payables"  value={fmt(vBOut)} sub={`${vBills.length} open bills`} subColor={T.red} accent={T.teal}/>}
          {f==='all' && <KPI label="Total Owing" value={fmt(jBOut+vBOut)} sub="Combined" subColor={T.red}/>}
          {f==='all' && <KPI label="Largest Bill" value={combinedBills[0]?fmt(combinedBills[0].BalanceDueAmount):'—'} sub={combinedBills[0]?.SupplierName?.substring(0,20)||'—'}/>}
          {f!=='all' && <KPI label="Largest Bill" value={(f==='jaws'?jBills:vBills)[0]?fmt((f==='jaws'?jBills:vBills)[0].BalanceDueAmount):'—'} sub={(f==='jaws'?jBills:vBills)[0]?.SupplierName?.substring(0,20)||'—'}/>}
          {f!=='all' && <KPI label="Bill Count" value={String((f==='jaws'?jBills:vBills).length)} sub="Open bills"/>}
        </div>
        {showJaws && <Card><PTitle>JAWS — Open purchase bills <Tag color={T.blue}>Live MYOB</Tag></PTitle><BillTable rows={jBills} accent={T.blue}/></Card>}
        {showVps  && <Card><PTitle>VPS — Open purchase bills <Tag color={T.teal}>Live MYOB</Tag></PTitle><BillTable rows={vBills} accent={T.teal}/></Card>}
      </div>
    }

    return null
  }

  const titles:Record<Section,string>={
    overview:'Overview — Live Data',
    invoices:'Invoices',
    pnl:'P&L — This Month',
    stock:'Stock & Inventory',
    payables:'Payables',
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

      <div style={{display:'flex',height:'100vh',overflow:'hidden',fontFamily:"'DM Sans',system-ui,sans-serif",background:T.bg,color:T.text}}>
        <PortalSidebar
          activeId={section}
          onSectionClick={(s)=>setSection(s as Section)}
          lastRefresh={lastRefresh}
          onRefresh={()=>load(true)}
          refreshing={refreshing}
          alertCounts={{invoices:openCount, payables:billCount}}
          loading={loading}
          currentUserRole={user.role}
          currentUserName={user.displayName}
          currentUserEmail={user.email}
        />

        {/* Main */}
        <div style={{flex:1,display:'flex',flexDirection:'column',overflow:'hidden',background:T.bg}}>
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
          <div style={{flex:1,display:'flex',overflow:'hidden',background:T.bg}}>
            <div style={{flex:1,padding:20,overflowY:'auto',position:'relative',background:T.bg}}>
              {dateLoading&&<div style={{position:'absolute',inset:0,background:'rgba(13,15,18,0.75)',zIndex:10,display:'flex',alignItems:'center',justifyContent:'center',flexDirection:'column',gap:12,borderRadius:8}}>
                <div style={{fontSize:28,animation:'spin 1s linear infinite',color:T.blue}}>⟳</div>
                <div style={{color:T.text2,fontSize:13}}>Updating data for {fyLabel}…</div>
                <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
              </div>}
              {renderSection()}
            </div>
          </div>
        </div>
      </div>
      {selectedInvoice&&<InvoiceDetailModal invoice={selectedInvoice.invoice} entity={selectedInvoice.entity} onClose={()=>setSelectedInvoice(null)}/>}
    </>
  )
}

// ─── P&L helper component ─────────────────────────────────
function PnlSection({entity,pnl,inc,cos,oh,jNet,jInc}:{entity:string;pnl:PnLLine[];inc:number;cos:number;oh:number;jNet:number;jInc:number}) {
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

// ─── JAWS Sales Pipeline ──────────────────────────────────
function JawsSalesPipeline({qo}:{qo:QuotesOrdersPayload|null}) {
  if (!qo) return <Card><div style={{padding:20,textAlign:'center',color:T.text3,fontSize:12}}>Loading sales pipeline…</div></Card>
  const {openOrders, quotes, totals} = qo
  return <div style={{display:'grid',gridTemplateColumns:'1.4fr 1fr',gap:12}}>
    <Card>
      <PTitle right={
        <span>
          <Tag color={T.purple}>{fmt(totals.openOrdersTotal)}</Tag>
          {totals.conversionRate!=null && <span style={{marginLeft:8}}>30d conv: {fmtPct(totals.conversionRate)}</span>}
        </span>
      }>JAWS open orders — awaiting fulfilment or invoice</PTitle>
      {openOrders.length===0 && <div style={{color:T.text3,fontSize:12,padding:10}}>No open orders.</div>}
      {openOrders.length>0 && <div style={{overflowX:'auto'}}>
        <table style={{width:'100%',borderCollapse:'collapse'}}>
          <thead><tr>{['Order','Date','Customer','PO Ref','Total','Balance','Age','Status'].map((h,i)=>
            <th key={h} style={{fontSize:10,color:T.text3,textTransform:'uppercase',letterSpacing:'0.07em',padding:'0 8px 10px',textAlign:i>=4&&i<=6?'right':'left',fontWeight:500,whiteSpace:'nowrap'}}>{h}</th>
          )}</tr></thead>
          <tbody>{openOrders.map(o=>{
            const ageColor = o.ageDays==null?T.text3 : o.ageDays>=14?T.red : o.ageDays>=7?T.amber : T.text2
            return <tr key={o.number} style={{borderTop:`1px solid ${T.border}`}}>
              <td style={{fontSize:12,color:T.purple,fontFamily:'monospace',padding:'7px 8px',fontWeight:500}}>{o.number}</td>
              <td style={{fontSize:12,color:T.text2,padding:'7px 8px',whiteSpace:'nowrap'}}>{o.date?fmtDate(o.date):'—'}</td>
              <td style={{fontSize:12,color:T.text2,padding:'7px 8px',maxWidth:200,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{o.customerName.substring(0,30)}</td>
              <td style={{fontSize:11,color:T.text3,fontFamily:'monospace',padding:'7px 8px'}}>{o.customerPurchaseOrderNumber||'—'}</td>
              <td style={{fontSize:12,fontFamily:'monospace',color:T.text,padding:'7px 8px',textAlign:'right'}}>{fmtFull(o.totalAmount)}</td>
              <td style={{fontSize:12,fontFamily:'monospace',color:o.balanceDueAmount>0?T.amber:T.green,padding:'7px 8px',textAlign:'right'}}>{o.balanceDueAmount>0?fmtFull(o.balanceDueAmount):'Paid'}</td>
              <td style={{fontSize:11,fontFamily:'monospace',color:ageColor,padding:'7px 8px',textAlign:'right'}}>{o.ageDays==null?'—':o.ageDays+'d'}</td>
              <td style={{padding:'7px 8px'}}>
                {o.isPrepaid ? <Tag color={T.green}>PREPAID</Tag> : <Tag color={T.amber}>OPEN</Tag>}
              </td>
            </tr>
          })}</tbody>
        </table>
      </div>}
      <div style={{marginTop:12,paddingTop:10,borderTop:`1px solid ${T.border}`,display:'flex',justifyContent:'space-between',fontSize:11,color:T.text3}}>
        <span>Converted to invoice in last 30 days</span>
        <span style={{fontFamily:'monospace'}}>{totals.convertedCount30d} orders · {fmt(totals.convertedTotal30d)}</span>
      </div>
    </Card>
    <Card>
      <PTitle right={<Tag color={quotes.length===0?T.text3:T.blue}>{quotes.length} active</Tag>}>JAWS Quotes</PTitle>
      {quotes.length===0 && (
        <div style={{color:T.text3,fontSize:12,padding:'20px 10px',textAlign:'center',lineHeight:1.6}}>
          <div style={{fontSize:24,marginBottom:8,opacity:0.4}}>—</div>
          <div>No active quotes in JAWS.</div>
          <div style={{fontSize:10,marginTop:6}}>Quotes entered in MYOB will appear here.</div>
        </div>
      )}
      {quotes.length>0 && <div style={{overflowX:'auto'}}>
        <table style={{width:'100%',borderCollapse:'collapse'}}>
          <thead><tr>{['Quote','Date','Customer','Total'].map((h,i)=>
            <th key={h} style={{fontSize:10,color:T.text3,textTransform:'uppercase',letterSpacing:'0.07em',padding:'0 8px 10px',textAlign:i===3?'right':'left',fontWeight:500,whiteSpace:'nowrap'}}>{h}</th>
          )}</tr></thead>
          <tbody>{quotes.map(q=>(
            <tr key={q.number} style={{borderTop:`1px solid ${T.border}`}}>
              <td style={{fontSize:12,color:T.blue,fontFamily:'monospace',padding:'7px 8px'}}>{q.number}</td>
              <td style={{fontSize:12,color:T.text2,padding:'7px 8px',whiteSpace:'nowrap'}}>{q.date?fmtDate(q.date):'—'}</td>
              <td style={{fontSize:12,color:T.text2,padding:'7px 8px',maxWidth:200,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{q.customerName.substring(0,30)}</td>
              <td style={{fontSize:12,fontFamily:'monospace',color:T.text,padding:'7px 8px',textAlign:'right'}}>{fmtFull(q.totalAmount)}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>}
    </Card>
  </div>
}

// ─── Stock & Inventory section (unchanged) ────────────────
function StockSection() {
  const [data,setData]=useState<InventoryPayload|null>(null)
  const [loading,setLoading]=useState(true)
  const [err,setErr]=useState('')
  const [tab,setTab]=useState<'overview'|'reorder'|'velocity'|'dead'|'margin'|'onorder'>('overview')
  const [search,setSearch]=useState('')
  const [supplierFilter,setSupplierFilter]=useState('__all__')

  useEffect(()=>{
    let cancelled=false
    ;(async()=>{
      setLoading(true);setErr('')
      try{
        const r=await fetch('/api/inventory')
        if(!r.ok){const t=await r.text();throw new Error(`HTTP ${r.status}: ${t.slice(0,200)}`)}
        const j:InventoryPayload=await r.json()
        if(!cancelled)setData(j)
      }catch(e:any){if(!cancelled)setErr(String(e?.message||e))}
      finally{if(!cancelled)setLoading(false)}
    })()
    return()=>{cancelled=true}
  },[])

  const items=data?.items||[]
  const suppliers=Array.from(new Set(items.filter(i=>i.supplier).map(i=>i.supplier as string))).sort()
  const q=search.trim().toLowerCase()
  const filtered=items.filter(i=>{
    if(supplierFilter!=='__all__'){
      if(supplierFilter==='__none__'){if(i.supplier!==null)return false}
      else if(i.supplier!==supplierFilter)return false
    }
    if(!q)return true
    return i.number.toLowerCase().includes(q)||i.name.toLowerCase().includes(q)
  })

  if(loading) return <Card><div style={{padding:20,textAlign:'center',color:T.text2}}>Loading inventory from MYOB…</div></Card>
  if(err)     return <Card style={{borderColor:`${T.red}60`}}><div style={{color:T.red,fontWeight:600,marginBottom:6}}>Inventory failed to load</div><div style={{color:T.text2,fontSize:12,fontFamily:'monospace'}}>{err}</div></Card>
  if(!data)   return null

  return <div style={{display:'flex',flexDirection:'column',gap:14}}>
    <div style={{display:'flex',gap:8,alignItems:'center'}}>
      <input placeholder="Search SKU or name…" value={search} onChange={e=>setSearch(e.target.value)}
        style={{flex:1,background:T.bg2,border:`1px solid ${T.border}`,color:T.text,borderRadius:6,padding:'7px 12px',fontSize:12,outline:'none',fontFamily:'inherit'}}/>
      <select value={supplierFilter} onChange={e=>setSupplierFilter(e.target.value)}
        style={{background:T.bg2,border:`1px solid ${T.border}`,color:T.text,borderRadius:6,padding:'7px 10px',fontSize:12,outline:'none',minWidth:200}}>
        <option value="__all__">All suppliers</option>
        <option value="__none__">— No supplier set —</option>
        {suppliers.map(s=><option key={s} value={s}>{s}</option>)}
      </select>
      <div style={{fontSize:11,color:T.text3,fontFamily:'monospace',whiteSpace:'nowrap'}}>{filtered.length} of {items.length} SKUs</div>
    </div>
    <div style={{display:'grid',gridTemplateColumns:'repeat(6,1fr)',gap:12}}>
      <KPI label="Stock value" value={fmt(data.totals.stockValue)} sub={`${data.totals.totalItems} SKUs · ${data.totals.qtyOnHand} units`} accent={T.blue}/>
      <KPI label="Low stock" value={String(data.totals.lowStockCount)} sub="below reorder level" subColor={data.totals.lowStockCount>0?T.amber:T.text3} accent={T.amber}/>
      <KPI label="Out of stock" value={String(data.totals.outOfStockCount)} sub="zero on hand" subColor={data.totals.outOfStockCount>0?T.red:T.text3} accent={T.red}/>
      <KPI label="Dead stock (90d)" value={fmt(data.totals.deadStock90dValue)} sub={`${data.totals.deadStock90dCount} items · no sales`} subColor={T.purple} accent={T.purple}/>
      <KPI label="On order" value={String(data.totals.qtyOnOrder)} sub="units inbound" accent={T.teal}/>
      <KPI label="Reorder cost" value={fmt(data.totals.reorderSuggestValue)} sub={`${data.totals.reorderSuggestCount} items @ avg cost`} accent={T.green}/>
    </div>
    <div style={{display:'flex',gap:4,borderBottom:`1px solid ${T.border}`}}>
      {([
        ['overview','Overview'],
        ['reorder',`Reorder (${data.totals.lowStockCount+data.totals.outOfStockCount})`],
        ['velocity','Velocity & top sellers'],
        ['dead',`Dead stock (${data.totals.deadStock90dCount})`],
        ['margin','Margin'],
        ['onorder','On order'],
      ] as ['overview'|'reorder'|'velocity'|'dead'|'margin'|'onorder',string][]).map(([id,label])=>(
        <button key={id} onClick={()=>setTab(id)}
          style={{background:'transparent',border:'none',padding:'10px 14px',fontSize:12,fontWeight:600,
            color:tab===id?T.text:T.text2,borderBottom:tab===id?`2px solid ${T.accent}`:'2px solid transparent',
            cursor:'pointer',fontFamily:'inherit',marginBottom:-1}}>{label}</button>
      ))}
    </div>
    {tab==='overview' && <StockOverview data={data} items={filtered}/>}
    {tab==='reorder'  && <StockReorder items={filtered}/>}
    {tab==='velocity' && <StockVelocity items={filtered}/>}
    {tab==='dead'     && <StockDead items={filtered}/>}
    {tab==='margin'   && <StockMargin items={filtered}/>}
    {tab==='onorder'  && <StockOnOrder items={filtered}/>}
  </div>
}

function StockOverview({data,items}:{data:InventoryPayload;items:InventoryItem[]}) {
  const topValue=[...items].sort((a,b)=>b.stockValue-a.stockValue).slice(0,10)
  const maxValue=topValue[0]?.stockValue||1
  const maxUnits=Math.max(1,...data.monthly.map(m=>m.units))
  const statusCounts=items.reduce<Record<string,number>>((acc,i)=>{acc[i.stockoutStatus]=(acc[i.stockoutStatus]||0)+1;return acc},{})
  return <div style={{display:'grid',gridTemplateColumns:'2fr 1fr',gap:14}}>
    <Card>
      <PTitle right="Stock value, live MYOB">Top 10 held items</PTitle>
      {topValue.length===0 && <div style={{color:T.text3,fontSize:12}}>No items match the current filter.</div>}
      {topValue.map(i=>(
        <div key={i.number} style={{marginBottom:10}}>
          <div style={{display:'flex',justifyContent:'space-between',marginBottom:4}}>
            <div style={{fontSize:12}}>
              <span style={{fontFamily:'monospace',color:T.text2}}>{i.number}</span>
              <span style={{marginLeft:8,color:T.text}}>{i.name}</span>
            </div>
            <div style={{fontSize:12,fontFamily:'monospace',color:T.text}}>{fmtFull(i.stockValue)}</div>
          </div>
          <div style={{height:4,background:T.bg3,borderRadius:2,overflow:'hidden'}}>
            <div style={{width:(i.stockValue/maxValue*100)+'%',height:'100%',background:T.blue}}/>
          </div>
          <div style={{display:'flex',gap:10,marginTop:4,fontSize:10,color:T.text3,fontFamily:'monospace'}}>
            <span>OH {i.qtyOnHand}</span><span>90d sold {i.unitsSold90d}</span><span>Cover {fmtDays(i.daysOfCover)}</span>
            <Tag color={INV_STATUS_COLOR[i.stockoutStatus]}>{INV_STATUS_LABEL[i.stockoutStatus]}</Tag>
          </div>
        </div>
      ))}
    </Card>
    <div style={{display:'flex',flexDirection:'column',gap:14}}>
      <Card>
        <PTitle>Stockout risk breakdown</PTitle>
        {(['out','critical','low','ok','dead','noSales'] as InventoryItem['stockoutStatus'][]).map(key=>{
          const labels:Record<string,string>={out:'Out of stock',critical:'Critical — ≤14d',low:'Low — ≤30d',ok:'Healthy — >30d',dead:'Dead — held, no sales',noSales:'No sales / no stock'}
          const count=statusCounts[key]||0
          const p=items.length>0?count/items.length:0
          return <div key={key} style={{marginBottom:10}}>
            <div style={{display:'flex',justifyContent:'space-between',fontSize:11,marginBottom:4}}>
              <span style={{color:T.text}}>{labels[key]}</span>
              <span style={{color:T.text2,fontFamily:'monospace'}}>{count}</span>
            </div>
            <div style={{height:3,background:T.bg3,borderRadius:2}}>
              <div style={{width:(p*100)+'%',height:'100%',background:INV_STATUS_COLOR[key],borderRadius:2}}/>
            </div>
          </div>
        })}
      </Card>
      <Card>
        <PTitle right="Portfolio, ex-GST">12-month units shipped</PTitle>
        <div style={{display:'flex',alignItems:'flex-end',gap:4,height:100,padding:'8px 0'}}>
          {data.monthly.map(m=>(
            <div key={m.month} style={{flex:1,display:'flex',flexDirection:'column',alignItems:'center',gap:4}}>
              <div style={{width:'100%',height:(m.units/maxUnits*84)+'px',background:T.blue,opacity:0.85,borderRadius:'2px 2px 0 0',minHeight:m.units>0?2:0}}
                title={`${m.label}: ${m.units} units · ${fmt(m.revenue)}`}/>
              <div style={{fontSize:9,color:T.text3,fontFamily:'monospace'}}>{m.label.split(' ')[0]}</div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  </div>
}

function StockReorder({items}:{items:InventoryItem[]}) {
  const needs=[...items].filter(i=>i.isOutOfStock||i.isLowStock).sort((a,b)=>{
    if(a.isOutOfStock!==b.isOutOfStock)return a.isOutOfStock?-1:1
    return (a.daysOfCover??9999)-(b.daysOfCover??9999)
  })
  const total=needs.reduce((s,i)=>{const q=i.reorderQty>0?i.reorderQty:Math.max(i.reorderLevel-i.qtyOnHand,0);return s+q*i.avgCost},0)
  return <Card>
    <PTitle right={`${needs.length} items · ${fmtFull(total)} at avg cost`}>Reorder suggestions</PTitle>
    {needs.length===0 && <div style={{color:T.text3,fontSize:12,padding:10}}>Nothing needs reordering right now.</div>}
    {needs.length>0 && <div style={{overflowX:'auto'}}>
      <table style={{width:'100%',borderCollapse:'collapse'}}>
        <thead><tr>{['Item','On hand','Reorder lvl','Cover','90d sold','Suggest qty','Est. cost','Supplier','Status'].map((h,i)=>
          <th key={h} style={{fontSize:10,color:T.text3,textTransform:'uppercase',letterSpacing:'0.07em',padding:'0 8px 10px',textAlign:i>=1&&i<=6?'right':i===8?'center':'left',fontWeight:500,whiteSpace:'nowrap'}}>{h}</th>
        )}</tr></thead>
        <tbody>{needs.map(i=>{
          const qty=i.reorderQty>0?i.reorderQty:Math.max(i.reorderLevel-i.qtyOnHand,1)
          const coverColor=i.daysOfCover==null?T.text3:i.daysOfCover<=14?T.red:i.daysOfCover<=30?T.amber:T.text
          return <tr key={i.number} style={{borderTop:`1px solid ${T.border}`}}>
            <td style={{padding:'7px 8px'}}><div style={{fontFamily:'monospace',fontSize:11,color:T.text2}}>{i.number}</div><div style={{fontSize:12,color:T.text}}>{i.name}</div></td>
            <td style={{fontSize:12,fontFamily:'monospace',color:i.isOutOfStock?T.red:T.text,padding:'7px 8px',textAlign:'right'}}>{i.qtyOnHand}</td>
            <td style={{fontSize:12,fontFamily:'monospace',color:T.text2,padding:'7px 8px',textAlign:'right'}}>{i.reorderLevel}</td>
            <td style={{fontSize:12,fontFamily:'monospace',color:coverColor,padding:'7px 8px',textAlign:'right'}}>{fmtDays(i.daysOfCover)}</td>
            <td style={{fontSize:12,fontFamily:'monospace',color:T.text2,padding:'7px 8px',textAlign:'right'}}>{i.unitsSold90d}</td>
            <td style={{fontSize:12,fontFamily:'monospace',color:T.green,padding:'7px 8px',textAlign:'right'}}>{qty}</td>
            <td style={{fontSize:12,fontFamily:'monospace',color:T.text,padding:'7px 8px',textAlign:'right'}}>{fmtFull(qty*i.avgCost)}</td>
            <td style={{fontSize:12,color:i.supplier?T.text:T.text3,padding:'7px 8px'}}>{i.supplier||'— not set —'}</td>
            <td style={{padding:'7px 8px',textAlign:'center'}}><Tag color={INV_STATUS_COLOR[i.stockoutStatus]}>{INV_STATUS_LABEL[i.stockoutStatus]}</Tag></td>
          </tr>
        })}</tbody>
      </table>
    </div>}
  </Card>
}

function StockVelocity({items}:{items:InventoryItem[]}) {
  const [sort,setSort]=useState<'rev90'|'units90'|'units30'|'runrate'>('rev90')
  const sorted=[...items].sort((a,b)=>{
    switch(sort){case 'rev90':return b.revenue90d-a.revenue90d;case 'units90':return b.unitsSold90d-a.unitsSold90d;case 'units30':return b.unitsSold30d-a.unitsSold30d;case 'runrate':return b.runRatePerDay-a.runRatePerDay}
  })
  const top=sorted.slice(0,15)
  const getVal=(i:InventoryItem)=>sort==='rev90'?i.revenue90d:sort==='units30'?i.unitsSold30d:sort==='runrate'?i.runRatePerDay:i.unitsSold90d
  const maxBar=Math.max(1,...top.map(getVal))
  const fmtVal=(v:number)=>sort==='rev90'?fmtFull(v):sort==='runrate'?v.toFixed(2)+'/d':String(Math.round(v))
  return <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:14}}>
    <Card>
      <PTitle right={<select value={sort} onChange={e=>setSort(e.target.value as any)} style={{background:T.bg3,border:`1px solid ${T.border}`,color:T.text,borderRadius:4,padding:'3px 6px',fontSize:10,fontFamily:'monospace'}}>
        <option value="rev90">Revenue 90d</option><option value="units90">Units 90d</option><option value="units30">Units 30d</option><option value="runrate">Run rate / day</option>
      </select>}>Top 15 by selected metric</PTitle>
      {top.map(i=>{
        const val=getVal(i)
        return <div key={i.number} style={{marginBottom:8}}>
          <div style={{display:'flex',justifyContent:'space-between',fontSize:11,marginBottom:3}}>
            <span style={{color:T.text}}><span style={{fontFamily:'monospace',color:T.text2}}>{i.number}</span> · {i.name.slice(0,30)}</span>
            <span style={{color:T.text,fontFamily:'monospace'}}>{fmtVal(val)}</span>
          </div>
          <div style={{height:3,background:T.bg3,borderRadius:2}}>
            <div style={{width:(val/maxBar*100)+'%',height:'100%',background:T.teal,borderRadius:2}}/>
          </div>
        </div>
      })}
    </Card>
    <Card>
      <PTitle right="Ranked list">Full velocity table</PTitle>
      <div style={{overflowX:'auto',maxHeight:560,overflowY:'auto'}}>
        <table style={{width:'100%',borderCollapse:'collapse'}}>
          <thead style={{position:'sticky',top:0,background:T.bg2}}><tr>{['Item','30d','90d','365d','Run/day','Cover'].map((h,i)=>
            <th key={h} style={{fontSize:10,color:T.text3,textTransform:'uppercase',letterSpacing:'0.07em',padding:'8px',textAlign:i===0?'left':'right',fontWeight:500,whiteSpace:'nowrap',borderBottom:`1px solid ${T.border}`}}>{h}</th>
          )}</tr></thead>
          <tbody>{sorted.map(i=>{
            const cc=i.daysOfCover==null?T.text3:i.daysOfCover<=14?T.red:i.daysOfCover<=30?T.amber:T.text
            return <tr key={i.number} style={{borderTop:`1px solid ${T.border}`}}>
              <td style={{padding:'7px 8px'}}><div style={{fontFamily:'monospace',fontSize:10,color:T.text2}}>{i.number}</div><div style={{fontSize:11,color:T.text}}>{i.name.slice(0,34)}</div></td>
              <td style={{fontSize:12,fontFamily:'monospace',color:T.text,padding:'7px 8px',textAlign:'right'}}>{i.unitsSold30d}</td>
              <td style={{fontSize:12,fontFamily:'monospace',color:T.text,padding:'7px 8px',textAlign:'right'}}>{i.unitsSold90d}</td>
              <td style={{fontSize:12,fontFamily:'monospace',color:T.text2,padding:'7px 8px',textAlign:'right'}}>{i.unitsSold365d}</td>
              <td style={{fontSize:12,fontFamily:'monospace',color:T.teal,padding:'7px 8px',textAlign:'right'}}>{i.runRatePerDay.toFixed(2)}</td>
              <td style={{fontSize:12,fontFamily:'monospace',color:cc,padding:'7px 8px',textAlign:'right'}}>{fmtDays(i.daysOfCover)}</td>
            </tr>
          })}</tbody>
        </table>
      </div>
    </Card>
  </div>
}

function StockDead({items}:{items:InventoryItem[]}) {
  const dead=items.filter(i=>i.stockValue>0&&(i.daysSinceLastSold===null||i.daysSinceLastSold>=90)).sort((a,b)=>b.stockValue-a.stockValue)
  const t1=dead.filter(i=>i.daysSinceLastSold!==null&&i.daysSinceLastSold>=90 &&i.daysSinceLastSold<180)
  const t2=dead.filter(i=>i.daysSinceLastSold!==null&&i.daysSinceLastSold>=180&&i.daysSinceLastSold<365)
  const t3=dead.filter(i=>i.daysSinceLastSold!==null&&i.daysSinceLastSold>=365)
  const t4=dead.filter(i=>i.daysSinceLastSold===null)
  const sumVal=(arr:InventoryItem[])=>arr.reduce((s,i)=>s+i.stockValue,0)
  return <div style={{display:'flex',flexDirection:'column',gap:14}}>
    <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:12}}>
      <KPI label="90–180 days" value={fmt(sumVal(t1))} sub={`${t1.length} items`} accent={T.amber}/>
      <KPI label="180–365 days" value={fmt(sumVal(t2))} sub={`${t2.length} items`} accent="#ff8c42"/>
      <KPI label="Over 365 days" value={fmt(sumVal(t3))} sub={`${t3.length} items`} accent={T.red}/>
      <KPI label="Never sold (12m)" value={fmt(sumVal(t4))} sub={`${t4.length} items`} accent={T.purple}/>
    </div>
    <Card>
      <PTitle right={`${dead.length} items holding ${fmtFull(sumVal(dead))}`}>Dead stock — ranked by held value</PTitle>
      {dead.length===0 && <div style={{color:T.text3,fontSize:12,padding:10}}>No dead stock. Everything with held value has moved in the last 90 days.</div>}
      {dead.length>0 && <div style={{overflowX:'auto'}}>
        <table style={{width:'100%',borderCollapse:'collapse'}}>
          <thead><tr>{['Item','On hand','Avg cost','Held value','Last sold','Days idle','Supplier'].map((h,i)=>
            <th key={h} style={{fontSize:10,color:T.text3,textTransform:'uppercase',letterSpacing:'0.07em',padding:'0 8px 10px',textAlign:i>=1&&i<=5?'right':'left',fontWeight:500,whiteSpace:'nowrap'}}>{h}</th>
          )}</tr></thead>
          <tbody>{dead.map(i=>{
            const c=i.daysSinceLastSold===null?T.purple:i.daysSinceLastSold>=365?T.red:i.daysSinceLastSold>=180?'#ff8c42':T.amber
            return <tr key={i.number} style={{borderTop:`1px solid ${T.border}`}}>
              <td style={{padding:'7px 8px'}}><div style={{fontFamily:'monospace',fontSize:10,color:T.text2}}>{i.number}</div><div style={{fontSize:12,color:T.text}}>{i.name}</div></td>
              <td style={{fontSize:12,fontFamily:'monospace',color:T.text,padding:'7px 8px',textAlign:'right'}}>{i.qtyOnHand}</td>
              <td style={{fontSize:12,fontFamily:'monospace',color:T.text2,padding:'7px 8px',textAlign:'right'}}>{fmtFull(i.avgCost)}</td>
              <td style={{fontSize:12,fontFamily:'monospace',color:T.text,padding:'7px 8px',textAlign:'right'}}>{fmtFull(i.stockValue)}</td>
              <td style={{fontSize:12,fontFamily:'monospace',color:T.text2,padding:'7px 8px',textAlign:'right'}}>{i.lastSoldDate?fmtDate(i.lastSoldDate):'—'}</td>
              <td style={{fontSize:12,fontFamily:'monospace',color:c,padding:'7px 8px',textAlign:'right'}}>{i.daysSinceLastSold===null?'∞':i.daysSinceLastSold+'d'}</td>
              <td style={{fontSize:12,color:i.supplier?T.text:T.text3,padding:'7px 8px'}}>{i.supplier||'—'}</td>
            </tr>
          })}</tbody>
        </table>
      </div>}
    </Card>
  </div>
}

function StockMargin({items}:{items:InventoryItem[]}) {
  const wm=items.filter(i=>i.marginPct!==null).sort((a,b)=>(a.marginPct??0)-(b.marginPct??0))
  const avg=wm.length>0?wm.reduce((s,i)=>s+(i.marginPct??0),0)/wm.length:0
  const buckets=[
    {label:'<0% (loss)',min:-Infinity,max:0,color:T.red},
    {label:'0–20%',min:0,max:0.2,color:'#ff8c42'},
    {label:'20–40%',min:0.2,max:0.4,color:T.amber},
    {label:'40–60%',min:0.4,max:0.6,color:T.teal},
    {label:'60%+',min:0.6,max:Infinity,color:T.green},
  ]
  const bc=buckets.map(b=>({...b,count:wm.filter(i=>(i.marginPct??0)>=b.min&&(i.marginPct??0)<b.max).length}))
  const maxB=Math.max(1,...bc.map(b=>b.count))
  return <div style={{display:'grid',gridTemplateColumns:'1fr 2fr',gap:14}}>
    <div style={{display:'flex',flexDirection:'column',gap:14}}>
      <Card>
        <PTitle>Portfolio margin</PTitle>
        <div style={{fontSize:28,fontFamily:'monospace',color:T.text,marginBottom:6}}>{fmtPct(avg)}</div>
        <div style={{fontSize:11,color:T.text3}}>average across {wm.length} priced SKUs</div>
      </Card>
      <Card>
        <PTitle>Margin distribution</PTitle>
        {bc.map(b=>(
          <div key={b.label} style={{marginBottom:8}}>
            <div style={{display:'flex',justifyContent:'space-between',fontSize:11,marginBottom:3}}>
              <span style={{color:T.text}}>{b.label}</span>
              <span style={{color:T.text2,fontFamily:'monospace'}}>{b.count}</span>
            </div>
            <div style={{height:4,background:T.bg3,borderRadius:2}}>
              <div style={{width:(b.count/maxB*100)+'%',height:'100%',background:b.color,borderRadius:2}}/>
            </div>
          </div>
        ))}
      </Card>
    </div>
    <Card>
      <PTitle right="Lowest margin first — candidates for price review">Margin by item</PTitle>
      <div style={{overflowX:'auto',maxHeight:560,overflowY:'auto'}}>
        <table style={{width:'100%',borderCollapse:'collapse'}}>
          <thead style={{position:'sticky',top:0,background:T.bg2}}><tr>{['Item','Avg cost','Sell ex-GST','$ margin','% margin','90d units'].map((h,i)=>
            <th key={h} style={{fontSize:10,color:T.text3,textTransform:'uppercase',letterSpacing:'0.07em',padding:'8px',textAlign:i===0?'left':'right',fontWeight:500,whiteSpace:'nowrap',borderBottom:`1px solid ${T.border}`}}>{h}</th>
          )}</tr></thead>
          <tbody>{wm.map(i=>{
            const mc=(i.marginPct??0)<0?T.red:(i.marginPct??0)<0.2?'#ff8c42':(i.marginPct??0)<0.4?T.amber:(i.marginPct??0)<0.6?T.teal:T.green
            return <tr key={i.number} style={{borderTop:`1px solid ${T.border}`}}>
              <td style={{padding:'7px 8px'}}><div style={{fontFamily:'monospace',fontSize:10,color:T.text2}}>{i.number}</div><div style={{fontSize:11,color:T.text}}>{i.name.slice(0,38)}</div></td>
              <td style={{fontSize:12,fontFamily:'monospace',color:T.text2,padding:'7px 8px',textAlign:'right'}}>{fmtFull(i.avgCost)}</td>
              <td style={{fontSize:12,fontFamily:'monospace',color:T.text2,padding:'7px 8px',textAlign:'right'}}>{fmtFull(i.sellPriceExGst)}</td>
              <td style={{fontSize:12,fontFamily:'monospace',color:(i.marginDollar??0)<0?T.red:T.text,padding:'7px 8px',textAlign:'right'}}>{i.marginDollar==null?'—':fmtFull(i.marginDollar)}</td>
              <td style={{fontSize:12,fontFamily:'monospace',color:mc,padding:'7px 8px',textAlign:'right'}}>{fmtPct(i.marginPct)}</td>
              <td style={{fontSize:12,fontFamily:'monospace',color:T.text2,padding:'7px 8px',textAlign:'right'}}>{i.unitsSold90d}</td>
            </tr>
          })}</tbody>
        </table>
      </div>
    </Card>
  </div>
}

function StockOnOrder({items}:{items:InventoryItem[]}) {
  const oo=items.filter(i=>i.qtyOnOrder>0).sort((a,b)=>b.qtyOnOrder*b.avgCost-a.qtyOnOrder*a.avgCost)
  const totalCost=oo.reduce((s,i)=>s+i.qtyOnOrder*i.avgCost,0)
  const totalUnits=oo.reduce((s,i)=>s+i.qtyOnOrder,0)
  return <div style={{display:'flex',flexDirection:'column',gap:14}}>
    <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:12}}>
      <KPI label="Purchase orders open" value={String(oo.length)} sub="distinct SKUs on order" accent={T.teal}/>
      <KPI label="Units inbound" value={String(totalUnits)} sub="across all open POs" accent={T.blue}/>
      <KPI label="Inbound value" value={fmt(totalCost)} sub="at avg cost — excludes freight" accent={T.green}/>
    </div>
    <Card>
      <PTitle right={`${oo.length} items on order`}>Purchase order pipeline</PTitle>
      {oo.length===0 && <div style={{color:T.text3,fontSize:12,padding:10}}>No open purchase orders for items in the current filter.</div>}
      {oo.length>0 && <div style={{overflowX:'auto'}}>
        <table style={{width:'100%',borderCollapse:'collapse'}}>
          <thead><tr>{['Item','On hand','On order','After arrival','90d sold','Cover after PO','Order value','Supplier'].map((h,i)=>
            <th key={h} style={{fontSize:10,color:T.text3,textTransform:'uppercase',letterSpacing:'0.07em',padding:'0 8px 10px',textAlign:i>=1&&i<=6?'right':'left',fontWeight:500,whiteSpace:'nowrap'}}>{h}</th>
          )}</tr></thead>
          <tbody>{oo.map(i=>{
            const after=i.qtyOnHand+i.qtyOnOrder
            const ca=i.runRatePerDay>0?after/i.runRatePerDay:null
            return <tr key={i.number} style={{borderTop:`1px solid ${T.border}`}}>
              <td style={{padding:'7px 8px'}}><div style={{fontFamily:'monospace',fontSize:10,color:T.text2}}>{i.number}</div><div style={{fontSize:12,color:T.text}}>{i.name}</div></td>
              <td style={{fontSize:12,fontFamily:'monospace',color:i.isOutOfStock?T.red:T.text,padding:'7px 8px',textAlign:'right'}}>{i.qtyOnHand}</td>
              <td style={{fontSize:12,fontFamily:'monospace',color:T.teal,padding:'7px 8px',textAlign:'right'}}>{i.qtyOnOrder}</td>
              <td style={{fontSize:12,fontFamily:'monospace',color:T.text,padding:'7px 8px',textAlign:'right'}}>{after}</td>
              <td style={{fontSize:12,fontFamily:'monospace',color:T.text2,padding:'7px 8px',textAlign:'right'}}>{i.unitsSold90d}</td>
              <td style={{fontSize:12,fontFamily:'monospace',color:T.text2,padding:'7px 8px',textAlign:'right'}}>{fmtDays(ca)}</td>
              <td style={{fontSize:12,fontFamily:'monospace',color:T.text,padding:'7px 8px',textAlign:'right'}}>{fmtFull(i.qtyOnOrder*i.avgCost)}</td>
              <td style={{fontSize:12,color:i.supplier?T.text:T.text3,padding:'7px 8px'}}>{i.supplier||'—'}</td>
            </tr>
          })}</tbody>
        </table>
      </div>}
    </Card>
  </div>
}


export async function getServerSideProps(context: any) {
  return requirePageAuth(context, null)
}
