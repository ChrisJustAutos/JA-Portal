// pages/supplier-invoices/[id].tsx
// Single invoice detail + actions. Shows parsed header, all line items, and
// the matched job (if any). Approve/Reject/Push-to-MYOB actions with notes.

import { useState, useEffect, useCallback } from 'react'
import Head from 'next/head'
import Link from 'next/link'
import { useRouter } from 'next/router'
import PortalSidebar from '../../lib/PortalSidebar'
import { requirePageAuth } from '../../lib/authServer'
import { UserRole } from '../../lib/permissions'

const T = {
  bg:'#0d0f12', bg2:'#131519', bg3:'#1a1d23', bg4:'#21252d',
  border:'rgba(255,255,255,0.07)', border2:'rgba(255,255,255,0.12)',
  text:'#e8eaf0', text2:'#8b90a0', text3:'#545968',
  blue:'#4f8ef7', teal:'#2dd4bf', green:'#34c77b',
  amber:'#f5a623', red:'#f04e4e', purple:'#a78bfa',
  accent:'#4f8ef7',
}

export async function getServerSideProps(ctx: any) {
  return requirePageAuth(ctx, 'view:supplier_invoices')
}

function fmtMoney(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—'
  return '$' + Number(n).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
function fmtDate(s: string | null): string {
  if (!s) return '—'
  const d = new Date(s)
  return isNaN(d.getTime()) ? s : d.toLocaleDateString('en-AU', { day:'2-digit', month:'short', year:'numeric' })
}

export default function InvoiceDetailPage({ user }: { user: { id: string, email: string, role: UserRole, name: string } }) {
  const router = useRouter()
  const id = router.query.id as string
  const [invoice, setInvoice] = useState<any | null>(null)
  const [lines, setLines] = useState<any[]>([])
  const [matchedJob, setMatchedJob] = useState<any | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const [acting, setActing] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!id) return
    setLoading(true); setError('')
    try {
      const r = await fetch(`/api/supplier-invoices/${id}`)
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || 'Load failed')
      setInvoice(d.invoice)
      setLines(d.lines || [])
      setMatchedJob(d.matchedJob)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [id])
  useEffect(() => { load() }, [load])

  async function action(a: 'approve' | 'reject' | 'push_to_myob' | 'undo_review') {
    const confirmMsg: Record<string, string> = {
      reject: 'Reject this invoice?',
      push_to_myob: 'Queue for push to MYOB? (MYOB write currently stubbed — just flags status.)',
      undo_review: 'Reset review status back to "pending"?',
    }
    if (confirmMsg[a] && !confirm(confirmMsg[a])) return
    setActing(a); setError('')
    try {
      const r = await fetch(`/api/supplier-invoices/${id}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: a, note: note || null }),
      })
      if (!r.ok) throw new Error((await r.json()).error || 'Action failed')
      await load()
      setNote('')
    } catch (e: any) { setError(e.message) }
    finally { setActing(null) }
  }

  const statusColor: Record<string, string> = {
    parsed: T.amber,
    auto_approved: T.teal,
    approved: T.green,
    rejected: T.red,
    queued_myob: T.blue,
    pushed_to_myob: T.purple,
    push_failed: T.red,
  }
  const statusLabel: Record<string, string> = {
    parsed: 'Pending review',
    auto_approved: 'Auto-approved (PAID + PO matched)',
    approved: 'Approved',
    rejected: 'Rejected',
    queued_myob: 'Queued for MYOB push',
    pushed_to_myob: 'Pushed to MYOB',
    push_failed: 'MYOB push failed',
  }

  return (
    <>
      <Head><title>Invoice — Just Autos</title></Head>
      <div style={{display:'flex', minHeight:'100vh', background:T.bg, color:T.text, fontFamily:'system-ui, -apple-system, sans-serif'}}>
        <PortalSidebar activeId="supplier-invoices" currentUserRole={user.role} currentUserVisibleTabs={(user as any).visibleTabs}/>
        <main style={{flex:1, padding:'20px 32px 40px', overflow:'auto'}}>
          <div style={{marginBottom:12}}>
            <Link href="/supplier-invoices" style={{color:T.text3, fontSize:12, textDecoration:'none'}}>← Supplier invoices</Link>
          </div>

          {loading && <div style={{padding:40, textAlign:'center', color:T.text3}}>Loading…</div>}
          {error && <div style={{background:'rgba(240,78,78,0.1)', border:`1px solid ${T.red}40`, borderRadius:8, padding:'10px 14px', color:T.red, fontSize:13, marginBottom:12}}>{error}</div>}

          {invoice && (
            <div style={{maxWidth:1100}}>
              {/* Header card */}
              <div style={{background:T.bg2, border:`1px solid ${T.border}`, borderLeft:`4px solid ${statusColor[invoice.status] || T.text3}`, borderRadius:10, padding:20, marginBottom:16}}>
                <div style={{display:'flex', alignItems:'center', gap:12, marginBottom:14}}>
                  <h1 style={{margin:0, fontSize:22, fontWeight:600}}>{invoice.supplier_name || '(no supplier detected)'}</h1>
                  <span style={{
                    padding:'4px 10px', borderRadius:10,
                    background:`${statusColor[invoice.status]}22`,
                    color:statusColor[invoice.status],
                    border:`1px solid ${statusColor[invoice.status]}55`,
                    fontSize:11, fontWeight:600, textTransform:'uppercase', letterSpacing:'0.04em',
                  }}>{statusLabel[invoice.status] || invoice.status}</span>
                  {invoice.parse_confidence !== null && invoice.parse_confidence !== undefined && (
                    <span style={{fontSize:10, color: invoice.parse_confidence >= 0.85 ? T.green : invoice.parse_confidence >= 0.6 ? T.amber : T.red, fontWeight:600}}>
                      Parse confidence: {(invoice.parse_confidence * 100).toFixed(0)}%
                    </span>
                  )}
                </div>

                <div style={{display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(160px, 1fr))', gap:16, fontSize:12}}>
                  <Field label="Invoice #" value={invoice.invoice_number || '—'}/>
                  <Field label="Invoice date" value={fmtDate(invoice.invoice_date)}/>
                  <Field label="Due date" value={fmtDate(invoice.due_date)}/>
                  <Field label="PO number" value={invoice.po_number || '—'} mono/>
                  <Field label="ABN" value={invoice.supplier_abn || '—'} mono/>
                  <Field label="Total (inc GST)" value={fmtMoney(invoice.total_inc_gst)} highlight/>
                </div>
              </div>

              {/* Match + Paid status row */}
              <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:16, marginBottom:16}}>
                <div style={{background:T.bg2, border:`1px solid ${T.border}`, borderLeft:`3px solid ${invoice.po_matches_job ? T.green : T.text3}`, borderRadius:10, padding:16}}>
                  <div style={{fontSize:10, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em', fontWeight:600, marginBottom:8}}>PO → Job match</div>
                  {invoice.po_matches_job && matchedJob ? (
                    <div>
                      <div style={{color:T.green, fontWeight:600, marginBottom:4}}>✓ Matched to job {matchedJob.job_number}</div>
                      <div style={{fontSize:12, color:T.text2}}>
                        {matchedJob.customer_name || '(no customer)'} {matchedJob.vehicle && ` • ${matchedJob.vehicle}`}
                      </div>
                      {matchedJob.status && <div style={{fontSize:11, color:T.text3, marginTop:4}}>Job status: {matchedJob.status}</div>}
                    </div>
                  ) : invoice.po_number ? (
                    <div>
                      <div style={{color:T.amber, fontWeight:600, marginBottom:4}}>— No match for PO {invoice.po_number}</div>
                      <div style={{fontSize:11, color:T.text3}}>Either the PO isn&apos;t in the current job report, or the report needs to be updated.</div>
                    </div>
                  ) : (
                    <div style={{color:T.text3, fontSize:12}}>No PO number detected on this invoice.</div>
                  )}
                </div>

                <div style={{background:T.bg2, border:`1px solid ${T.border}`, borderLeft:`3px solid ${invoice.is_paid_on_invoice ? T.teal : T.text3}`, borderRadius:10, padding:16}}>
                  <div style={{fontSize:10, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em', fontWeight:600, marginBottom:8}}>Paid on invoice</div>
                  {invoice.is_paid_on_invoice ? (
                    <div style={{color:T.teal, fontWeight:600}}>✓ Invoice shows as paid</div>
                  ) : (
                    <div style={{color:T.text3}}>Not marked as paid (standard approval needed)</div>
                  )}
                </div>
              </div>

              {/* Line items */}
              <div style={{background:T.bg2, border:`1px solid ${T.border}`, borderRadius:10, marginBottom:16, overflow:'hidden'}}>
                <div style={{padding:'12px 16px', borderBottom:`1px solid ${T.border}`, fontSize:13, fontWeight:600}}>Line items <span style={{color:T.text3, fontWeight:400, marginLeft:8}}>({lines.length})</span></div>
                {lines.length === 0 ? (
                  <div style={{padding:30, textAlign:'center', color:T.text3, fontSize:12}}>No line items extracted.</div>
                ) : (
                  <div>
                    <div style={{display:'grid', gridTemplateColumns:'30px 2fr 60px 100px 100px 70px 90px', gap:10, padding:'8px 16px', borderBottom:`1px solid ${T.border}`, fontSize:10, color:T.text3, textTransform:'uppercase', fontWeight:600, letterSpacing:'0.05em'}}>
                      <div>#</div>
                      <div>Description</div>
                      <div style={{textAlign:'right'}}>Qty</div>
                      <div style={{textAlign:'right'}}>Unit ex</div>
                      <div style={{textAlign:'right'}}>Total ex</div>
                      <div>Tax</div>
                      <div style={{textAlign:'right'}}>GST</div>
                    </div>
                    {lines.map(l => (
                      <div key={l.id} style={{display:'grid', gridTemplateColumns:'30px 2fr 60px 100px 100px 70px 90px', gap:10, padding:'8px 16px', borderBottom:`1px solid ${T.border}`, fontSize:12, alignItems:'center'}}>
                        <div style={{color:T.text3}}>{l.line_number}</div>
                        <div>{l.description}</div>
                        <div style={{textAlign:'right', fontVariantNumeric:'tabular-nums'}}>{l.quantity ?? '—'}</div>
                        <div style={{textAlign:'right', fontVariantNumeric:'tabular-nums'}}>{fmtMoney(l.unit_price_ex)}</div>
                        <div style={{textAlign:'right', fontVariantNumeric:'tabular-nums', fontWeight:500}}>{fmtMoney(l.line_total_ex)}</div>
                        <div style={{color:T.text3, fontSize:11}}>{l.tax_code || '—'}</div>
                        <div style={{textAlign:'right', fontVariantNumeric:'tabular-nums', color:T.text3}}>{fmtMoney(l.gst_amount)}</div>
                      </div>
                    ))}
                    <div style={{padding:'10px 16px', display:'flex', gap:24, justifyContent:'flex-end', fontSize:12}}>
                      <div><span style={{color:T.text3}}>Subtotal ex:</span> <strong style={{fontVariantNumeric:'tabular-nums'}}>{fmtMoney(invoice.subtotal_ex_gst)}</strong></div>
                      <div><span style={{color:T.text3}}>GST:</span> <strong style={{fontVariantNumeric:'tabular-nums'}}>{fmtMoney(invoice.gst_amount)}</strong></div>
                      <div><span style={{color:T.text3}}>Total:</span> <strong style={{fontVariantNumeric:'tabular-nums', color:T.text}}>{fmtMoney(invoice.total_inc_gst)}</strong></div>
                    </div>
                  </div>
                )}
              </div>

              {/* Actions */}
              <div style={{background:T.bg2, border:`1px solid ${T.border}`, borderRadius:10, padding:16, marginBottom:16}}>
                <div style={{fontSize:13, fontWeight:600, marginBottom:12}}>Actions</div>
                <textarea value={note} onChange={e => setNote(e.target.value)}
                  placeholder="Optional review note (saved against this invoice)"
                  style={{width:'100%', minHeight:60, padding:10, background:T.bg3, border:`1px solid ${T.border2}`, color:T.text, borderRadius:6, fontSize:12, fontFamily:'inherit', outline:'none', boxSizing:'border-box', resize:'vertical', marginBottom:10}}/>
                <div style={{display:'flex', gap:8, flexWrap:'wrap'}}>
                  {(invoice.status === 'parsed') && (
                    <>
                      <button onClick={() => action('approve')} disabled={!!acting}
                        style={{padding:'8px 16px', borderRadius:6, border:'none', background:T.green, color:'#fff', fontSize:12, fontWeight:600, fontFamily:'inherit', cursor: acting ? 'wait' : 'pointer'}}>
                        ✓ Approve
                      </button>
                      <button onClick={() => action('reject')} disabled={!!acting}
                        style={{padding:'8px 16px', borderRadius:6, border:`1px solid ${T.red}`, background:'transparent', color:T.red, fontSize:12, fontWeight:600, fontFamily:'inherit', cursor: acting ? 'wait' : 'pointer'}}>
                        ✗ Reject
                      </button>
                    </>
                  )}
                  {(invoice.status === 'approved' || invoice.status === 'auto_approved') && (
                    <>
                      <button onClick={() => action('push_to_myob')} disabled={!!acting}
                        style={{padding:'8px 16px', borderRadius:6, border:'none', background:T.purple, color:'#fff', fontSize:12, fontWeight:600, fontFamily:'inherit', cursor: acting ? 'wait' : 'pointer'}}>
                        ↑ Push to MYOB
                      </button>
                      <button onClick={() => action('undo_review')} disabled={!!acting}
                        style={{padding:'8px 14px', borderRadius:6, border:`1px solid ${T.border2}`, background:'transparent', color:T.text2, fontSize:12, fontFamily:'inherit', cursor: acting ? 'wait' : 'pointer'}}>
                        Undo review
                      </button>
                    </>
                  )}
                  {(invoice.status === 'rejected' || invoice.status === 'queued_myob' || invoice.status === 'push_failed') && (
                    <button onClick={() => action('undo_review')} disabled={!!acting}
                      style={{padding:'8px 14px', borderRadius:6, border:`1px solid ${T.border2}`, background:'transparent', color:T.text2, fontSize:12, fontFamily:'inherit', cursor: acting ? 'wait' : 'pointer'}}>
                      Reset to pending review
                    </button>
                  )}
                </div>
                {invoice.status === 'queued_myob' && (
                  <div style={{marginTop:12, padding:10, background:`${T.blue}11`, border:`1px solid ${T.blue}40`, borderRadius:6, fontSize:11, color:T.blue}}>
                    ℹ Invoice queued. <strong>MYOB push is currently stubbed</strong> pending API activation. Once MYOB activates our app, a background worker will push queued invoices automatically.
                  </div>
                )}
                {invoice.review_note && (
                  <div style={{marginTop:12, padding:10, background:T.bg3, borderRadius:6, fontSize:11, color:T.text2}}>
                    <strong style={{color:T.text3, textTransform:'uppercase', fontSize:10, letterSpacing:'0.05em'}}>Review note:</strong><br/>
                    {invoice.review_note}
                  </div>
                )}
              </div>

              {/* Metadata */}
              <div style={{background:T.bg2, border:`1px solid ${T.border}`, borderRadius:10, padding:16, fontSize:11, color:T.text3}}>
                <div style={{fontSize:10, textTransform:'uppercase', letterSpacing:'0.05em', fontWeight:600, marginBottom:8, color:T.text3}}>Intake metadata</div>
                <div style={{display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(180px, 1fr))', gap:10}}>
                  <div><span style={{color:T.text3}}>Source:</span> {invoice.source}</div>
                  <div><span style={{color:T.text3}}>Filename:</span> {invoice.filename}</div>
                  <div><span style={{color:T.text3}}>Received:</span> {new Date(invoice.received_at).toLocaleString('en-AU')}</div>
                  {invoice.source_email_from && <div><span style={{color:T.text3}}>From email:</span> {invoice.source_email_from}</div>}
                  {invoice.parsed_at && <div><span style={{color:T.text3}}>Parsed:</span> {new Date(invoice.parsed_at).toLocaleString('en-AU')}</div>}
                  {invoice.reviewed_at && <div><span style={{color:T.text3}}>Reviewed:</span> {new Date(invoice.reviewed_at).toLocaleString('en-AU')}</div>}
                </div>
              </div>
            </div>
          )}
        </main>
      </div>
    </>
  )
}

function Field({ label, value, mono=false, highlight=false }: { label: string, value: string, mono?: boolean, highlight?: boolean }) {
  return (
    <div>
      <div style={{fontSize:10, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em', fontWeight:600}}>{label}</div>
      <div style={{marginTop:3, fontFamily: mono ? 'monospace' : 'inherit', fontSize: highlight ? 16 : 13, fontWeight: highlight ? 600 : 400, color: highlight ? T.text : T.text2}}>{value}</div>
    </div>
  )
}
