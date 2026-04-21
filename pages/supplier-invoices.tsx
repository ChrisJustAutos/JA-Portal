// pages/supplier-invoices.tsx
// Supplier Invoices Queue — upload PDFs, see parsed invoices with match status,
// approve/reject each one. Full list in one page with filters + search.

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
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

interface InvoiceRow {
  id: string
  received_at: string
  supplier_name: string | null
  invoice_number: string | null
  invoice_date: string | null
  po_number: string | null
  total_inc_gst: number | null
  status: string
  po_matches_job: boolean
  is_paid_on_invoice: boolean
  parse_confidence: number | null
  filename: string | null
  reviewed_at: string | null
}

interface Kpis {
  pending_review: number
  auto_approved: number
  approved: number
  pushed_to_myob: number
  push_failed: number
}

export async function getServerSideProps(ctx: any) {
  return requirePageAuth(ctx, 'view:supplier_invoices')
}

function fmtMoney(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—'
  return '$' + n.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function fmtDateShort(s: string | null): string {
  if (!s) return '—'
  const d = new Date(s)
  if (isNaN(d.getTime())) return s
  return d.toLocaleDateString('en-AU', { day:'2-digit', month:'short', year:'2-digit' })
}

function fmtRelative(s: string): string {
  const t = new Date(s).getTime()
  const diffMin = (Date.now() - t) / 60_000
  if (diffMin < 60) return `${Math.round(diffMin)}m ago`
  if (diffMin < 60*24) return `${Math.round(diffMin / 60)}h ago`
  return fmtDateShort(s)
}

function StatusBadge({ status, compact=false }: { status: string, compact?: boolean }) {
  const map: Record<string, {label: string, color: string}> = {
    parsed:          { label: 'Pending review', color: T.amber },
    auto_approved:   { label: 'Auto-approved',  color: T.teal },
    approved:        { label: 'Approved',        color: T.green },
    rejected:        { label: 'Rejected',        color: T.red },
    queued_myob:     { label: 'Queued MYOB',     color: T.blue },
    pushed_to_myob:  { label: 'Pushed to MYOB',  color: T.purple },
    push_failed:     { label: 'Push failed',     color: T.red },
  }
  const m = map[status] || { label: status, color: T.text3 }
  return (
    <span style={{
      display:'inline-block',
      padding: compact ? '2px 7px' : '3px 10px',
      borderRadius: 10,
      background: `${m.color}22`,
      color: m.color,
      border: `1px solid ${m.color}55`,
      fontSize: compact ? 10 : 11,
      fontWeight: 600,
      textTransform: 'uppercase',
      letterSpacing: '0.04em',
      whiteSpace: 'nowrap',
    }}>{m.label}</span>
  )
}

export default function SupplierInvoicesPage({ user }: { user: { id: string, email: string, role: UserRole, name: string } }) {
  const [invoices, setInvoices] = useState<InvoiceRow[]>([])
  const [kpis, setKpis] = useState<Kpis | null>(null)
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize] = useState(50)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')

  // Filters
  const [statusFilter, setStatusFilter] = useState<string>('parsed')  // default to pending
  const [matchFilter, setMatchFilter] = useState<string>('all')
  const [q, setQ] = useState('')

  // Upload
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadResult, setUploadResult] = useState<any | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const p = new URLSearchParams({
        status: statusFilter,
        match: matchFilter,
        q,
        page: String(page),
        pageSize: String(pageSize),
      })
      const r = await fetch(`/api/supplier-invoices/list?${p.toString()}`)
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || 'Load failed')
      setInvoices(d.invoices || [])
      setKpis(d.kpis || null)
      setTotal(d.total || 0)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [statusFilter, matchFilter, q, page, pageSize])

  useEffect(() => { load() }, [load])

  async function uploadPdfs(files: FileList | File[]) {
    const arr = Array.from(files).filter(f => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'))
    if (arr.length === 0) { setError('Only PDF files accepted'); return }
    setUploading(true); setError(''); setInfo(''); setUploadResult(null)
    const results: any[] = []
    try {
      for (const file of arr) {
        // Base64 encode
        const base64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => {
            const s = String(reader.result)
            resolve(s.split(',')[1] || s)
          }
          reader.onerror = reject
          reader.readAsDataURL(file)
        })
        const r = await fetch('/api/supplier-invoices/intake', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename: file.name, pdf_base64: base64, source: 'manual' }),
        })
        const d = await r.json()
        results.push({ filename: file.name, ok: r.ok, ...d })
      }
      setUploadResult({ uploaded: results.length, results })
      setInfo(`${results.filter(r => r.ok).length} of ${results.length} invoices parsed`)
      await load()
    } catch (e: any) { setError(e.message) }
    finally { setUploading(false); if (fileInputRef.current) fileInputRef.current.value = '' }
  }

  async function quickAction(id: string, action: 'approve' | 'reject') {
    if (action === 'reject' && !confirm('Reject this invoice?')) return
    try {
      const r = await fetch(`/api/supplier-invoices/${id}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      if (!r.ok) throw new Error((await r.json()).error || 'Action failed')
      await load()
    } catch (e: any) { setError(e.message) }
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  return (
    <>
      <Head><title>Supplier Invoices — Just Autos</title></Head>
      <div style={{display:'flex', minHeight:'100vh', background:T.bg, color:T.text, fontFamily:'system-ui, -apple-system, sans-serif'}}>
        <PortalSidebar activeId="supplier-invoices" currentUserRole={user.role} currentUserVisibleTabs={(user as any).visibleTabs}/>
        <main style={{flex:1, padding:'20px 32px 40px', overflow:'auto'}}>
          <div style={{display:'flex', alignItems:'center', gap:12, marginBottom:16}}>
            <h1 style={{margin:0, fontSize:22, fontWeight:600}}>Supplier Invoices</h1>
            <span style={{fontSize:12, color:T.text3}}>{total} total</span>
            <div style={{flex:1}}/>
            <input ref={fileInputRef} type="file" accept="application/pdf,.pdf" multiple style={{display:'none'}}
              onChange={e => e.target.files && uploadPdfs(e.target.files)}/>
            <button onClick={() => fileInputRef.current?.click()} disabled={uploading}
              style={{padding:'8px 18px', borderRadius:6, border:'none', background:T.accent, color:'#fff', fontSize:13, fontWeight:600, fontFamily:'inherit', cursor: uploading ? 'wait' : 'pointer'}}>
              {uploading ? 'Uploading…' : '+ Upload invoice PDF(s)'}
            </button>
          </div>

          {error && <div style={{background:'rgba(240,78,78,0.1)', border:`1px solid ${T.red}40`, borderRadius:8, padding:'10px 14px', color:T.red, fontSize:13, marginBottom:12}}>{error}</div>}
          {info  && <div style={{background:'rgba(52,199,123,0.1)', border:`1px solid ${T.green}40`, borderRadius:8, padding:'10px 14px', color:T.green, fontSize:13, marginBottom:12}}>{info}</div>}

          {/* Upload result summary */}
          {uploadResult && (
            <div style={{background:T.bg2, border:`1px solid ${T.border}`, borderRadius:10, padding:16, marginBottom:16}}>
              <div style={{fontSize:13, fontWeight:600, marginBottom:8}}>Upload results</div>
              <div style={{display:'flex', flexDirection:'column', gap:4, fontSize:12, color:T.text2, maxHeight:200, overflow:'auto'}}>
                {uploadResult.results.map((r: any, i: number) => (
                  <div key={i} style={{display:'flex', alignItems:'center', gap:10, padding:'4px 0', borderBottom: i < uploadResult.results.length-1 ? `1px solid ${T.border}` : undefined}}>
                    <span style={{color: r.ok ? T.green : T.red}}>{r.ok ? '✓' : '✗'}</span>
                    <span style={{flex:1, color:T.text}}>{r.filename}</span>
                    {r.ok ? (
                      <>
                        <span style={{color:T.text3}}>{r.parsed?.supplier_name || '?'}</span>
                        <span style={{color:T.text3}}>{fmtMoney(r.parsed?.total_inc_gst)}</span>
                        <span style={{color: r.po_matches_job ? T.green : T.amber}}>{r.po_matches_job ? '✓ PO matched' : '✗ No PO match'}</span>
                        {r.auto_approved && <span style={{color:T.teal, fontWeight:600}}>Auto-approved</span>}
                      </>
                    ) : (
                      <span style={{color:T.red}}>{r.error}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* KPIs */}
          {kpis && (
            <div style={{display:'grid', gridTemplateColumns:'repeat(5, 1fr)', gap:10, marginBottom:16}}>
              <Kpi label="Pending review" value={kpis.pending_review} color={T.amber}/>
              <Kpi label="Auto-approved"  value={kpis.auto_approved}  color={T.teal}/>
              <Kpi label="Approved"       value={kpis.approved}       color={T.green}/>
              <Kpi label="Pushed MYOB"    value={kpis.pushed_to_myob} color={T.purple}/>
              <Kpi label="Push failed"    value={kpis.push_failed}    color={T.red}/>
            </div>
          )}

          {/* Filters */}
          <div style={{display:'flex', gap:10, alignItems:'center', marginBottom:12, flexWrap:'wrap'}}>
            <FilterChipGroup label="Status" value={statusFilter} onChange={v => { setStatusFilter(v); setPage(1) }} options={[
              { value:'all',            label:'All' },
              { value:'parsed',         label:'Pending review' },
              { value:'auto_approved',  label:'Auto-approved' },
              { value:'approved',       label:'Approved' },
              { value:'rejected',       label:'Rejected' },
              { value:'queued_myob',    label:'Queued MYOB' },
              { value:'pushed_to_myob', label:'Pushed' },
              { value:'push_failed',    label:'Failed' },
            ]}/>
            <div style={{width:1, height:20, background:T.border}}/>
            <FilterChipGroup label="PO" value={matchFilter} onChange={v => { setMatchFilter(v); setPage(1) }} options={[
              { value:'all',       label:'All' },
              { value:'matched',   label:'Matched' },
              { value:'unmatched', label:'Unmatched' },
            ]}/>
            <div style={{flex:1}}/>
            <input type="text" placeholder="Search supplier / PO / invoice #"
              value={q} onChange={e => { setQ(e.target.value); setPage(1) }}
              style={{padding:'7px 12px', background:T.bg3, border:`1px solid ${T.border2}`, color:T.text, borderRadius:6, fontSize:12, fontFamily:'inherit', width:280, outline:'none'}}/>
          </div>

          {/* Table */}
          <div style={{background:T.bg2, border:`1px solid ${T.border}`, borderRadius:10, overflow:'hidden'}}>
            <div style={{display:'grid', gridTemplateColumns:'110px 1fr 130px 110px 100px 120px 110px 150px 200px', gap:10, padding:'10px 14px', borderBottom:`1px solid ${T.border}`, fontSize:10, color:T.text3, textTransform:'uppercase', fontWeight:600, letterSpacing:'0.05em'}}>
              <div>Received</div>
              <div>Supplier / Invoice</div>
              <div>PO</div>
              <div>Match</div>
              <div>Paid?</div>
              <div style={{textAlign:'right'}}>Total</div>
              <div>Inv Date</div>
              <div>Status</div>
              <div style={{textAlign:'right'}}>Actions</div>
            </div>

            {loading ? (
              <div style={{padding:40, textAlign:'center', color:T.text3, fontSize:12}}>Loading…</div>
            ) : invoices.length === 0 ? (
              <div style={{padding:40, textAlign:'center', color:T.text3, fontSize:12}}>No invoices match your filters.</div>
            ) : (
              invoices.map(inv => (
                <div key={inv.id} style={{display:'grid', gridTemplateColumns:'110px 1fr 130px 110px 100px 120px 110px 150px 200px', gap:10, padding:'12px 14px', borderBottom:`1px solid ${T.border}`, fontSize:12, alignItems:'center'}}>
                  <div style={{color:T.text3}}>{fmtRelative(inv.received_at)}</div>
                  <div>
                    <Link href={`/supplier-invoices/${inv.id}`} style={{color:T.text, textDecoration:'none', fontWeight:500}}>
                      {inv.supplier_name || '(no supplier)'}
                    </Link>
                    <div style={{fontSize:10, color:T.text3, marginTop:2}}>{inv.invoice_number || inv.filename || '—'}</div>
                  </div>
                  <div style={{fontFamily:'monospace', fontSize:11, color: inv.po_number ? T.text : T.text3}}>{inv.po_number || '—'}</div>
                  <div>{inv.po_matches_job
                    ? <span style={{color:T.green, fontWeight:600}}>✓ Matched</span>
                    : <span style={{color:T.text3}}>— No match</span>
                  }</div>
                  <div>{inv.is_paid_on_invoice ? <span style={{color:T.teal}}>✓ Paid</span> : <span style={{color:T.text3}}>—</span>}</div>
                  <div style={{textAlign:'right', fontVariantNumeric:'tabular-nums', fontWeight:500}}>{fmtMoney(inv.total_inc_gst)}</div>
                  <div style={{color:T.text2}}>{fmtDateShort(inv.invoice_date)}</div>
                  <div><StatusBadge status={inv.status} compact/></div>
                  <div style={{display:'flex', gap:6, justifyContent:'flex-end'}}>
                    {(inv.status === 'parsed') && (
                      <>
                        <button onClick={() => quickAction(inv.id, 'approve')}
                          style={{padding:'4px 10px', borderRadius:5, border:`1px solid ${T.green}`, background:'transparent', color:T.green, fontSize:11, fontFamily:'inherit', cursor:'pointer'}}>Approve</button>
                        <button onClick={() => quickAction(inv.id, 'reject')}
                          style={{padding:'4px 10px', borderRadius:5, border:`1px solid ${T.red}40`, background:'transparent', color:T.red, fontSize:11, fontFamily:'inherit', cursor:'pointer'}}>Reject</button>
                      </>
                    )}
                    <Link href={`/supplier-invoices/${inv.id}`}
                      style={{padding:'4px 10px', borderRadius:5, border:`1px solid ${T.border2}`, background:'transparent', color:T.text2, fontSize:11, textDecoration:'none'}}>View →</Link>
                  </div>
                </div>
              ))
            )}

            {/* Pagination */}
            {totalPages > 1 && (
              <div style={{padding:'10px 14px', display:'flex', alignItems:'center', justifyContent:'space-between', fontSize:11, color:T.text3}}>
                <div>Page {page} of {totalPages} — {total} total</div>
                <div style={{display:'flex', gap:6}}>
                  <button onClick={() => setPage(p => Math.max(1, p-1))} disabled={page <= 1}
                    style={{padding:'4px 10px', borderRadius:5, border:`1px solid ${T.border2}`, background:'transparent', color: page <= 1 ? T.text3 : T.text2, fontSize:11, cursor: page <= 1 ? 'not-allowed' : 'pointer', fontFamily:'inherit'}}>← Prev</button>
                  <button onClick={() => setPage(p => Math.min(totalPages, p+1))} disabled={page >= totalPages}
                    style={{padding:'4px 10px', borderRadius:5, border:`1px solid ${T.border2}`, background:'transparent', color: page >= totalPages ? T.text3 : T.text2, fontSize:11, cursor: page >= totalPages ? 'not-allowed' : 'pointer', fontFamily:'inherit'}}>Next →</button>
                </div>
              </div>
            )}
          </div>
        </main>
      </div>
    </>
  )
}

function Kpi({ label, value, color }: { label: string, value: number, color: string }) {
  return (
    <div style={{background:T.bg2, border:`1px solid ${T.border}`, borderLeft:`3px solid ${color}`, borderRadius:8, padding:'10px 14px'}}>
      <div style={{fontSize:10, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em', fontWeight:600}}>{label}</div>
      <div style={{fontSize:24, fontWeight:600, marginTop:4, color:T.text, fontVariantNumeric:'tabular-nums'}}>{value}</div>
    </div>
  )
}

function FilterChipGroup<T extends string>({ label, value, onChange, options }: { label: string, value: T, onChange: (v: T) => void, options: { value: T, label: string }[] }) {
  return (
    <div style={{display:'flex', gap:6, alignItems:'center'}}>
      <span style={{fontSize:11, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em', fontWeight:600}}>{label}:</span>
      {options.map(opt => (
        <button key={opt.value} onClick={() => onChange(opt.value)}
          style={{
            padding:'4px 10px',
            borderRadius:12,
            border:`1px solid ${value === opt.value ? T.accent : T.border2}`,
            background: value === opt.value ? `${T.accent}22` : 'transparent',
            color: value === opt.value ? T.accent : T.text2,
            fontSize:11, fontFamily:'inherit', cursor:'pointer',
            fontWeight: value === opt.value ? 600 : 500,
          }}>{opt.label}</button>
      ))}
    </div>
  )
}
