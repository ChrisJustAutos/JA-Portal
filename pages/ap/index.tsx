// pages/ap/index.tsx
// AP Invoice Processor — triage list page with upload, filters, and delete.

import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/router'
import { GetServerSideProps } from 'next'
import PortalSidebar from '../../lib/PortalSidebar'
import { requirePageAuth } from '../../lib/authServer'
import { UserRole, roleHasPermission } from '../../lib/permissions'

const T = {
  bg:'#0d0f12', bg2:'#131519', bg3:'#1a1d23', bg4:'#21252d',
  border:'rgba(255,255,255,0.07)', border2:'rgba(255,255,255,0.12)',
  text:'#e8eaf0', text2:'#8b90a0', text3:'#545968',
  blue:'#4f8ef7', teal:'#2dd4bf', green:'#34c77b',
  amber:'#f5a623', red:'#f04e4e', purple:'#a78bfa', accent:'#4f8ef7',
}

interface InvoiceRow {
  id: string
  source: 'email' | 'upload'
  received_at: string
  pdf_filename: string | null
  vendor_name_parsed: string | null
  invoice_number: string | null
  invoice_date: string | null
  due_date: string | null
  subtotal_ex_gst: number | null
  gst_amount: number | null
  total_inc_gst: number | null
  via_capricorn: boolean
  capricorn_reference: string | null
  parse_confidence: 'high' | 'medium' | 'low' | null
  resolved_supplier_name: string | null
  resolved_account_code: string | null
  triage_status: 'pending' | 'green' | 'yellow' | 'red'
  triage_reasons: string[] | null
  status: 'parsing' | 'pending_review' | 'ready' | 'posted' | 'rejected' | 'escalated' | 'error'
  myob_company_file: 'VPS' | 'JAWS'
  myob_bill_uid: string | null
  myob_posted_at: string | null
}

interface ListResponse {
  invoices: InvoiceRow[]
  total: number
  limit: number
  offset: number
  counts: {
    red: number; yellow: number; green: number
    pending: number; ready: number; posted: number
  }
}

interface PageProps {
  user: { id: string; email: string; displayName: string | null; role: UserRole; visibleTabs: string[] | null }
}

export const getServerSideProps: GetServerSideProps<PageProps> = async (ctx) => {
  return requirePageAuth(ctx, 'view:supplier_invoices') as any
}

export default function APListPage({ user }: PageProps) {
  const router = useRouter()
  const [data, setData] = useState<ListResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<string>('')
  const [triageFilter, setTriageFilter] = useState<string>('')
  const [search, setSearch] = useState<string>('')
  const [uploading, setUploading] = useState(false)
  const [uploadMessage, setUploadMessage] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const canEdit = roleHasPermission(user.role, 'edit:supplier_invoices')

  async function fetchData() {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (statusFilter) params.set('status', statusFilter)
      if (triageFilter) params.set('triage', triageFilter)
      if (search.trim()) params.set('q', search.trim())
      const res = await fetch(`/api/ap?${params.toString()}`, { credentials: 'same-origin' })
      if (!res.ok) {
        const txt = await res.text()
        throw new Error(`HTTP ${res.status}: ${txt.slice(0, 200)}`)
      }
      const json: ListResponse = await res.json()
      setData(json)
      setError(null)
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchData() }, [statusFilter, triageFilter])
  useEffect(() => {
    const t = setTimeout(fetchData, 300)
    return () => clearTimeout(t)
  }, [search])

  async function handleFile(file: File) {
    if (!file) return
    setUploading(true)
    setUploadMessage(null)
    try {
      const buf = await file.arrayBuffer()
      const bytes = new Uint8Array(buf)
      let binary = ''
      const chunkSize = 32 * 1024
      for (let i = 0; i < bytes.length; i += chunkSize) {
        const slice = bytes.subarray(i, Math.min(i + chunkSize, bytes.length))
        binary += String.fromCharCode.apply(null, slice as any)
      }
      const pdfBase64 = btoa(binary)

      const res = await fetch('/api/ap/upload', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pdfBase64, filename: file.name }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
      setUploadMessage(`✅ Uploaded "${file.name}" — vendor: ${json.extraction?.vendor?.name || 'unknown'}, total: $${json.extraction?.totalIncGst?.toFixed(2) || '?'}`)
      fetchData()
      if (json.invoiceId) {
        setTimeout(() => router.push(`/ap/${json.invoiceId}`), 800)
      }
    } catch (e: any) {
      setUploadMessage(`❌ Upload failed: ${e?.message || e}`)
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  async function handleDelete(inv: InvoiceRow, e: React.MouseEvent) {
    e.stopPropagation()
    e.preventDefault()
    const label = `${inv.vendor_name_parsed || 'this invoice'} ${inv.invoice_number || ''}`.trim()
    const ok = confirm(`Delete ${label}?\n\nThis permanently removes the invoice, its lines, and the PDF. This cannot be undone.`)
    if (!ok) return
    setDeletingId(inv.id)
    try {
      const res = await fetch(`/api/ap/${inv.id}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
      // Optimistic: drop from current view immediately
      if (data) {
        setData({ ...data, invoices: data.invoices.filter(i => i.id !== inv.id), total: Math.max(0, data.total - 1) })
      }
      // Refresh to update counts
      fetchData()
    } catch (err: any) {
      alert('Delete failed: ' + (err?.message || err))
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <div style={{display:'flex', minHeight:'100vh', background:T.bg, color:T.text, fontFamily:"'DM Sans', system-ui, sans-serif"}}>
      <PortalSidebar
        activeId="ap"
        currentUserRole={user.role}
        currentUserVisibleTabs={user.visibleTabs}
        currentUserName={user.displayName || user.email}
        currentUserEmail={user.email}
      />

      <div style={{flex:1, padding:'24px 32px', overflow:'auto'}}>
        <div style={{display:'flex', alignItems:'baseline', justifyContent:'space-between', marginBottom:6}}>
          <h1 style={{fontSize:22, fontWeight:600, margin:0}}>AP Invoices</h1>
          <div style={{fontSize:11, color:T.text3}}>VPS · supplier invoices via email + manual upload</div>
        </div>
        <div style={{fontSize:12, color:T.text3, marginBottom:18}}>Triage incoming invoices, edit lines, and post to MYOB.</div>

        {data && (
          <div style={{background:T.bg2, border:`1px solid ${T.border}`, borderRadius:10, padding:'14px 18px', marginBottom:14, display:'flex', flexWrap:'wrap', gap:24, alignItems:'center'}}>
            <Stat n={data.counts.red}     label="Red"     color={T.red}/>
            <Stat n={data.counts.yellow}  label="Yellow"  color={T.amber}/>
            <Stat n={data.counts.green}   label="Green"   color={T.green}/>
            <span style={{flex:1}}/>
            <Stat n={data.counts.pending} label="Pending review" color={T.text2}/>
            <Stat n={data.counts.ready}   label="Ready"          color={T.blue}/>
            <Stat n={data.counts.posted}  label="Posted"         color={T.text3}/>
          </div>
        )}

        <div style={{display:'flex', flexWrap:'wrap', gap:8, alignItems:'center', marginBottom:14}}>
          <Pill active={statusFilter===''}                 onClick={()=>setStatusFilter('')}                  label="All statuses"/>
          <Pill active={statusFilter==='pending_review'}   onClick={()=>setStatusFilter('pending_review')}    label="Pending review"/>
          <Pill active={statusFilter==='ready'}            onClick={()=>setStatusFilter('ready')}             label="Ready"/>
          <Pill active={statusFilter==='posted'}           onClick={()=>setStatusFilter('posted')}            label="Posted"/>
          <Pill active={statusFilter==='rejected'}         onClick={()=>setStatusFilter('rejected')}          label="Rejected"/>
          <span style={{width:14}}/>
          <Pill active={triageFilter===''}       onClick={()=>setTriageFilter('')}        label="All triage"/>
          <Pill active={triageFilter==='red'}    onClick={()=>setTriageFilter('red')}     label="🔴 Red"     color={T.red}/>
          <Pill active={triageFilter==='yellow'} onClick={()=>setTriageFilter('yellow')}  label="🟡 Yellow"  color={T.amber}/>
          <Pill active={triageFilter==='green'}  onClick={()=>setTriageFilter('green')}   label="🟢 Green"   color={T.green}/>
          <span style={{flex:1}}/>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search vendor / invoice #…"
            style={{
              background: T.bg2, border: `1px solid ${T.border2}`, color: T.text,
              padding: '7px 11px', borderRadius: 6, fontSize: 12, fontFamily:'inherit', minWidth: 240, outline:'none',
            }}
          />
          {canEdit && (
            <>
              <input
                ref={fileRef}
                type="file"
                accept="application/pdf"
                onChange={e => e.target.files?.[0] && handleFile(e.target.files[0])}
                style={{display:'none'}}
              />
              <button
                disabled={uploading}
                onClick={() => fileRef.current?.click()}
                style={{
                  background: T.blue, color: '#fff', border:'none',
                  padding: '8px 14px', borderRadius: 6, fontSize: 12, fontWeight: 500, fontFamily:'inherit',
                  cursor: uploading ? 'wait' : 'pointer',
                  opacity: uploading ? 0.6 : 1,
                }}
              >
                {uploading ? 'Uploading…' : '+ Upload PDF'}
              </button>
            </>
          )}
        </div>

        {uploadMessage && (
          <div style={{
            background: uploadMessage.startsWith('❌') ? `${T.red}15` : `${T.green}15`,
            border:`1px solid ${uploadMessage.startsWith('❌') ? T.red : T.green}40`,
            borderRadius: 7, padding: 10, marginBottom: 12, fontSize: 12,
            color: uploadMessage.startsWith('❌') ? T.red : T.green,
          }}>
            {uploadMessage}
          </div>
        )}

        {error && (
          <div style={{background:`${T.red}15`, border:`1px solid ${T.red}40`, borderRadius:7, padding:10, color:T.red, fontSize:12, marginBottom:12}}>
            <strong>Failed to load:</strong> {error}
          </div>
        )}

        <div style={{background:T.bg2, border:`1px solid ${T.border}`, borderRadius:10, overflow:'hidden'}}>
          <div style={{overflowX:'auto'}}>
            <table style={{width:'100%', borderCollapse:'collapse'}}>
              <thead>
                <tr style={{borderBottom:`1px solid ${T.border2}`}}>
                  <th style={th(80)}>Triage</th>
                  <th style={th(110)}>Received</th>
                  <th style={th()}>Vendor</th>
                  <th style={th(140)}>Invoice #</th>
                  <th style={th(90)}>Inv Date</th>
                  <th style={th()}>Supplier (MYOB)</th>
                  <th style={{...th(100), textAlign:'right'}}>Total inc GST</th>
                  <th style={th(110)}>Status</th>
                  {canEdit && <th style={th(40)}/>}
                </tr>
              </thead>
              <tbody>
                {loading && !data && (
                  <tr><td colSpan={canEdit ? 9 : 8} style={{padding:30, textAlign:'center', color:T.text3, fontSize:12}}>Loading…</td></tr>
                )}
                {data && data.invoices.length === 0 && (
                  <tr><td colSpan={canEdit ? 9 : 8} style={{padding:30, textAlign:'center', color:T.text3, fontSize:12}}>No invoices match the current filters.</td></tr>
                )}
                {data && data.invoices.map((inv, i) => {
                  const isDeleting = deletingId === inv.id
                  const isPosted = inv.status === 'posted'
                  return (
                    <tr
                      key={inv.id}
                      onClick={() => router.push(`/ap/${inv.id}`)}
                      style={{
                        borderTop: i > 0 ? `1px solid ${T.border}` : 'none',
                        cursor: 'pointer',
                        opacity: isDeleting ? 0.4 : 1,
                      }}
                      onMouseEnter={e => (e.currentTarget.style.background = T.bg3)}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                    >
                      <td style={td()}><TriagePill status={inv.triage_status}/></td>
                      <td style={{...td(), fontSize:11, color:T.text3, fontFamily:'monospace', whiteSpace:'nowrap'}}>
                        {fmtDateTime(inv.received_at)}
                      </td>
                      <td style={td()}>
                        <div style={{fontSize:13, color:T.text}}>{inv.vendor_name_parsed || <span style={{color:T.text3}}>—</span>}</div>
                        {inv.via_capricorn && (
                          <div style={{fontSize:10, color:T.amber, marginTop:2}}>via Capricorn{inv.capricorn_reference ? ` ${inv.capricorn_reference}` : ''}</div>
                        )}
                      </td>
                      <td style={{...td(), fontFamily:'monospace', fontSize:12}}>
                        {inv.invoice_number || <span style={{color:T.text3}}>—</span>}
                      </td>
                      <td style={{...td(), fontSize:11, color:T.text2, whiteSpace:'nowrap'}}>{inv.invoice_date || '—'}</td>
                      <td style={td()}>
                        {inv.resolved_supplier_name ? (
                          <div>
                            <div style={{fontSize:12, color:T.text}}>{inv.resolved_supplier_name}</div>
                            <div style={{fontSize:10, color:T.text3, fontFamily:'monospace', marginTop:2}}>{inv.resolved_account_code || ''}</div>
                          </div>
                        ) : (
                          <span style={{fontSize:11, color:T.text3, fontStyle:'italic'}}>not mapped</span>
                        )}
                      </td>
                      <td style={{...td(), textAlign:'right', fontFamily:'monospace', fontSize:13, fontWeight:500}}>
                        {inv.total_inc_gst !== null ? `$${Number(inv.total_inc_gst).toFixed(2)}` : '—'}
                      </td>
                      <td style={td()}>
                        <StatusPill status={inv.status}/>
                      </td>
                      {canEdit && (
                        <td style={{...td(), textAlign:'center', padding:'8px 6px'}}>
                          {isPosted ? (
                            <span title="Posted invoices can't be deleted" style={{color:T.text3, fontSize:14}}>—</span>
                          ) : (
                            <button
                              onClick={(e) => handleDelete(inv, e)}
                              disabled={isDeleting}
                              title="Delete invoice + PDF"
                              style={{
                                background:'none', border:'none',
                                color: isDeleting ? T.text3 : T.text2,
                                cursor: isDeleting ? 'wait' : 'pointer',
                                fontSize:16, padding:'2px 6px', borderRadius:4,
                                fontFamily:'inherit',
                              }}
                              onMouseEnter={e => { if (!isDeleting) (e.currentTarget.style.color = T.red) }}
                              onMouseLeave={e => { if (!isDeleting) (e.currentTarget.style.color = T.text2) }}
                            >
                              {isDeleting ? '…' : '×'}
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>

        {data && (
          <div style={{marginTop:10, fontSize:11, color:T.text3, textAlign:'right'}}>
            {data.invoices.length} of {data.total} {data.total === 1 ? 'invoice' : 'invoices'}
          </div>
        )}
      </div>
    </div>
  )
}

// ── UI primitives ──
function Stat({ n, label, color }: { n: number; label: string; color: string }) {
  return (
    <div style={{display:'flex', alignItems:'baseline', gap:6}}>
      <span style={{fontSize:22, fontWeight:600, color, fontVariantNumeric:'tabular-nums'}}>{n}</span>
      <span style={{fontSize:10, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em'}}>{label}</span>
    </div>
  )
}

function Pill({ active, onClick, label, color }: { active: boolean; onClick: () => void; label: string; color?: string }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: active ? (color ? `${color}25` : 'rgba(255,255,255,0.07)') : 'transparent',
        border: `1px solid ${active ? (color || T.border2) : T.border}`,
        color: active ? (color || T.text) : T.text2,
        padding: '6px 11px', borderRadius: 6, fontSize: 11, fontFamily: 'inherit', cursor: 'pointer',
      }}
    >{label}</button>
  )
}

function TriagePill({ status }: { status: string }) {
  const conf = status === 'green'  ? { c: T.green,  label: '🟢 GREEN' } :
               status === 'yellow' ? { c: T.amber,  label: '🟡 YELLOW' } :
               status === 'red'    ? { c: T.red,    label: '🔴 RED' } :
                                     { c: T.text3,  label: '— PENDING' }
  return (
    <span style={{
      display:'inline-block', padding:'2px 8px', borderRadius:3,
      background: `${conf.c}15`, border:`1px solid ${conf.c}40`,
      color: conf.c, fontSize:10, fontWeight:600, letterSpacing:'0.05em', whiteSpace:'nowrap',
    }}>{conf.label}</span>
  )
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, string> = {
    parsing: T.text3, pending_review: T.text2, ready: T.blue,
    posted: T.green, rejected: T.text3, escalated: T.amber, error: T.red,
  }
  const c = map[status] || T.text3
  return (
    <span style={{
      display:'inline-block', padding:'2px 8px', borderRadius:3,
      background:`${c}15`, border:`1px solid ${c}40`, color:c,
      fontSize:10, fontWeight:500, textTransform:'uppercase', letterSpacing:'0.04em', whiteSpace:'nowrap',
    }}>{status.replace('_',' ')}</span>
  )
}

function fmtDateTime(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleString('en-AU', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' })
  } catch { return iso }
}

function th(width?: number): React.CSSProperties {
  return { fontSize:10, color:T.text3, padding:'10px 12px', textAlign:'left', fontWeight:500, textTransform:'uppercase', letterSpacing:'0.05em', width }
}
function td(): React.CSSProperties {
  return { padding:'11px 12px', verticalAlign:'top' }
}
