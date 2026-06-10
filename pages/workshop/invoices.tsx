// pages/workshop/invoices.tsx
// Workshop invoices board — historical imported + portal-created in one list.
// Filters: active / trash · paid / unpaid · finalised / open · search.

import { useCallback, useEffect, useState } from 'react'
import Head from 'next/head'
import Link from 'next/link'
import { useRouter } from 'next/router'
import PortalTopBar from '../../lib/PortalTopBar'
import WorkshopTabs from '../../components/WorkshopTabs'
import { requirePageAuth } from '../../lib/authServer'
import type { PortalUserSSR } from '../../lib/authServer'
import { roleHasPermission } from '../../lib/permissions'
import { T, Chip, StatusPill as UIStatusPill, miniBtn, SkeletonRows } from '../../components/ui'
import { money2 as money, fmtDate } from '../../lib/ui/format'
import { useConfirm } from '../../components/ui/Feedback'
import { useIsMobile } from '../../lib/useIsMobile'

type View = 'active' | 'trash'
type PaidFilter = 'all' | 'paid' | 'unpaid'
type StatusFilter = 'all' | 'finalised' | 'open'
type SourceFilter = 'all' | 'imported' | 'portal'

export default function InvoicesPage({ user }: { user: PortalUserSSR }) {
  const router = useRouter()
  const canEdit = roleHasPermission(user.role, 'edit:bookings')
  const [invoices, setInvoices] = useState<any[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [view, setView] = useState<View>('active')
  const [paid, setPaid] = useState<PaidFilter>('all')
  const [status, setStatus] = useState<StatusFilter>('all')
  const [source, setSource] = useState<SourceFilter>('all')
  const [q, setQ] = useState('')
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null)
  const confirmDialog = useConfirm()
  const isMobile = useIsMobile()

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      params.set('view', view)
      if (paid !== 'all') params.set('paid', paid)
      if (status === 'finalised') params.set('status', 'finalised')
      else if (status === 'open') params.set('status', 'open')
      if (source !== 'all') params.set('source', source)
      if (q.trim()) params.set('q', q.trim())
      const r = await fetch(`/api/workshop/invoices?${params}`)
      const d = await r.json()
      if (r.ok) { setInvoices(d.invoices || []); setTotal(d.total || 0) }
      setLastRefresh(new Date())
    } catch { /* keep prior */ } finally { setLoading(false) }
  }, [view, paid, status, source, q])

  useEffect(() => { load() }, [load])

  async function restore(id: string, e: React.MouseEvent) {
    e.preventDefault(); e.stopPropagation()
    const r = await fetch(`/api/workshop/invoices/${id}/restore`, { method: 'POST' })
    if (r.ok) load()
  }
  async function softDelete(id: string, e: React.MouseEvent) {
    e.preventDefault(); e.stopPropagation()
    if (!(await confirmDialog({ title: 'Move this invoice to Trash?', message: 'You can restore it later from the trash view.', danger: true }))) return
    const r = await fetch(`/api/workshop/invoices/${id}`, { method: 'DELETE' })
    if (r.ok) load()
  }

  return (
    <>
      <Head><title>Invoices — Just Autos</title><meta name="robots" content="noindex,nofollow"/></Head>
      <div style={{ display:'flex', flexDirection:'column', height:'100vh', overflow:'hidden', fontFamily:"'DM Sans',system-ui,sans-serif", color:T.text }}>
        <PortalTopBar activeId="diary" lastRefresh={lastRefresh} onRefresh={load} refreshing={loading}
          currentUserRole={user.role} currentUserVisibleTabs={user.visibleTabs} currentUserName={user.displayName} currentUserEmail={user.email} />
        <WorkshopTabs active="invoices" role={user.role} />

        <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden', background:T.bg }}>
          <div style={{ background:T.bg2, borderBottom:`1px solid ${T.border}`, padding:'10px 20px', display:'flex', alignItems:'center', gap:10, flexWrap:'wrap', flexShrink:0 }}>
            <span style={{ fontSize:14, fontWeight:600 }}>Invoices</span>
            <span style={{ fontSize:11, color:T.text3 }}>· {invoices.length}{total !== invoices.length ? `/${total.toLocaleString()}` : ''}</span>

            <div style={{ display:'flex', gap:4, marginLeft:8 }}>
              <Chip label="Active" active={view==='active'} onClick={() => setView('active')} />
              <Chip label="Trash" active={view==='trash'} onClick={() => setView('trash')} c={T.red} />
            </div>

            {view === 'active' && (
              <>
                <div style={{ width:1, height:18, background:T.border }} />
                <div style={{ display:'flex', gap:4 }}>
                  <Chip label="All" active={paid==='all'} onClick={() => setPaid('all')} />
                  <Chip label="Unpaid" active={paid==='unpaid'} onClick={() => setPaid('unpaid')} c={T.amber} />
                  <Chip label="Paid" active={paid==='paid'} onClick={() => setPaid('paid')} c={T.green} />
                </div>
                <div style={{ width:1, height:18, background:T.border }} />
                <div style={{ display:'flex', gap:4 }}>
                  <Chip label="Any status" active={status==='all'} onClick={() => setStatus('all')} />
                  <Chip label="Unfinalised" active={status==='open'} onClick={() => setStatus('open')} c={T.amber} />
                  <Chip label="Finalised" active={status==='finalised'} onClick={() => setStatus('finalised')} c={T.teal} />
                </div>
                <div style={{ width:1, height:18, background:T.border }} />
                <div style={{ display:'flex', gap:4 }}>
                  <Chip label="All sources" active={source==='all'} onClick={() => setSource('all')} />
                  <Chip label="Imported" active={source==='imported'} onClick={() => setSource('imported')} c={T.purple} />
                  <Chip label="Portal" active={source==='portal'} onClick={() => setSource('portal')} c={T.blue} />
                </div>
              </>
            )}

            <div style={{ flex:1 }} />
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search customer or invoice #…" style={{ padding:'5px 10px', background:T.bg3, border:`1px solid ${T.border2}`, borderRadius:4, color:T.text, fontSize:12, fontFamily:'inherit', width:240 }} />
          </div>

          <div style={{ flex:1, overflow:'auto', padding:20 }}>
            {isMobile ? (
              /* ─── MOBILE: card stack ─── */
              <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
                {loading && invoices.length === 0 ? (
                  <div style={{ background:T.bg2, border:`1px solid ${T.border}`, borderRadius:10, overflow:'hidden' }}><SkeletonRows rows={8} /></div>
                ) : invoices.length === 0 ? (
                  <div style={{ padding:40, textAlign:'center', color:T.text3, fontSize:12, background:T.bg2, border:`1px solid ${T.border}`, borderRadius:10 }}>{view === 'trash' ? 'Trash is empty.' : 'No invoices match these filters.'}</div>
                ) : invoices.map(inv => {
                  const href = inv.booking_id ? `/workshop/job/${inv.booking_id}` : `/workshop/invoice/${inv.id}`
                  return (
                    <Link key={inv.id} href={href} style={{ display:'block', background:T.bg2, border:`1px solid ${T.border}`, borderRadius:10, padding:'12px 14px', textDecoration:'none', color:'inherit', opacity: view === 'trash' ? 0.7 : 1 }}>
                      <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:6 }}>
                        <StatusPill v={inv.status} />
                        <span style={{ fontSize:11, color:T.text2, fontFamily:'monospace' }}>{fmtDate(inv.created_at)}</span>
                        <span style={{ flex:1 }} />
                        <span style={{ fontSize:10, fontFamily:'monospace', color:T.text3 }}>{inv.md_id ? `#${inv.md_id}` : inv.myob_invoice_uid ? 'MYOB' : ''}</span>
                      </div>
                      <div style={{ fontSize:13, fontWeight:600, color:T.text, marginBottom:8 }}>{inv.customer?.name || '—'}</div>
                      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'baseline', fontSize:12, marginBottom:2 }}>
                        <span style={{ fontSize:10, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em' }}>Total</span>
                        <span style={{ fontFamily:'monospace', color:T.text, fontVariantNumeric:'tabular-nums' }}>{money(inv.total)}</span>
                      </div>
                      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'baseline', fontSize:11, marginBottom:2 }}>
                        <span style={{ fontSize:10, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em' }}>Paid</span>
                        <span style={{ fontFamily:'monospace', color:T.text3, fontVariantNumeric:'tabular-nums' }}>{money(inv.paid_total)}</span>
                      </div>
                      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'baseline', fontSize:12 }}>
                        <span style={{ fontSize:10, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em' }}>Outstanding</span>
                        <span style={{ fontFamily:'monospace', fontVariantNumeric:'tabular-nums', color: inv.is_paid ? T.green : (inv.outstanding > 0.01 ? T.amber : T.text3), fontWeight: inv.is_paid ? 400 : 600 }}>{inv.is_paid ? 'PAID' : money(inv.outstanding)}</span>
                      </div>
                      {canEdit && (
                        <div style={{ display:'flex', justifyContent:'flex-end', gap:6, marginTop:8 }}>
                          {view === 'trash' && <button onClick={e => restore(inv.id, e)} style={miniBtn(T.green)}>Restore</button>}
                          {view === 'active' && <button onClick={e => softDelete(inv.id, e)} title="Move to Trash" style={miniBtn(T.text3)}>×</button>}
                        </div>
                      )}
                    </Link>
                  )
                })}
              </div>
            ) : (
              /* ─── DESKTOP: grid table ─── */
              <div style={{ maxWidth:1600, margin:'0 auto', background:T.bg2, border:`1px solid ${T.border}`, borderRadius:10, overflow:'hidden' }}>
                <div style={{ display:'grid', gridTemplateColumns:'100px 1fr 90px 110px 110px 110px 110px 70px', gap:8, padding:'9px 16px', background:T.bg3, borderBottom:`1px solid ${T.border}`, fontSize:9, color:T.text3, fontWeight:600, textTransform:'uppercase', letterSpacing:'0.05em' }}>
                  <div>Date</div><div>Customer</div><div>Status</div><div style={{ textAlign:'right' }}>Total</div><div style={{ textAlign:'right' }}>Paid</div><div style={{ textAlign:'right' }}>Outstanding</div><div style={{ textAlign:'right' }}>Ext / MYOB</div><div style={{ textAlign:'right' }}></div>
                </div>
                {loading && invoices.length === 0 ? (
                  <SkeletonRows rows={8} />
                ) : invoices.length === 0 ? (
                  <div style={{ padding:40, textAlign:'center', color:T.text3, fontSize:12 }}>{view === 'trash' ? 'Trash is empty.' : 'No invoices match these filters.'}</div>
                ) : invoices.map(inv => {
                  const href = inv.booking_id ? `/workshop/job/${inv.booking_id}` : `/workshop/invoice/${inv.id}`
                  return (
                    <Link key={inv.id} href={href} style={{ display:'grid', gridTemplateColumns:'100px 1fr 90px 110px 110px 110px 110px 70px', gap:8, padding:'10px 16px', borderTop:`1px solid ${T.border}`, alignItems:'center', textDecoration:'none', color:'inherit', opacity: view === 'trash' ? 0.7 : 1 }}>
                      <div style={{ fontSize:11, color:T.text2, fontFamily:'monospace' }}>{fmtDate(inv.created_at)}</div>
                      <div style={{ fontSize:12, color:T.text, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{inv.customer?.name || '—'}</div>
                      <div><StatusPill v={inv.status} /></div>
                      <div style={{ fontSize:12, fontFamily:'monospace', color:T.text, textAlign:'right', fontVariantNumeric:'tabular-nums' }}>{money(inv.total)}</div>
                      <div style={{ fontSize:11, fontFamily:'monospace', color:T.text3, textAlign:'right', fontVariantNumeric:'tabular-nums' }}>{money(inv.paid_total)}</div>
                      <div style={{ fontSize:12, fontFamily:'monospace', textAlign:'right', fontVariantNumeric:'tabular-nums', color: inv.is_paid ? T.green : (inv.outstanding > 0.01 ? T.amber : T.text3), fontWeight: inv.is_paid ? 400 : 600 }}>{inv.is_paid ? 'PAID' : money(inv.outstanding)}</div>
                      <div style={{ fontSize:10, fontFamily:'monospace', color:T.text3, textAlign:'right' }}>{inv.md_id ? `#${inv.md_id}` : inv.myob_invoice_uid ? 'MYOB' : ''}</div>
                      <div style={{ textAlign:'right' }}>
                        {view === 'trash' && canEdit && <button onClick={e => restore(inv.id, e)} style={miniBtn(T.green)}>Restore</button>}
                        {view === 'active' && canEdit && <button onClick={e => softDelete(inv.id, e)} title="Move to Trash" style={miniBtn(T.text3)}>×</button>}
                      </div>
                    </Link>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  )
}

function StatusPill({ v }: { v: string }) {
  const map: Record<string, string> = { finalised: T.teal, completed: T.teal, paid: T.green, open: T.amber, draft: T.text3 }
  return <UIStatusPill label={v} color={map[v] || T.text3} />
}

export async function getServerSideProps(context: any) {
  return requirePageAuth(context, 'view:diary')
}
