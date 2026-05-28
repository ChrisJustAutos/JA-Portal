// pages/workshop/invoices.tsx
// Workshop invoices board — historical imported + portal-created in one list.
// Filters: active / trash · paid / unpaid · finalised / open · search.

import { useCallback, useEffect, useState } from 'react'
import Head from 'next/head'
import Link from 'next/link'
import { useRouter } from 'next/router'
import PortalTopBar from '../../lib/PortalTopBar'
import { requirePageAuth } from '../../lib/authServer'
import { roleHasPermission } from '../../lib/permissions'

interface PortalUserSSR { id: string; email: string; displayName: string | null; role: 'admin'|'manager'|'sales'|'accountant'|'viewer'|'workshop'; visibleTabs?: string[] | null }

const T = {
  bg: '#0d0f12', bg2: '#131519', bg3: '#1a1d23', bg4: '#21252d',
  border: 'rgba(255,255,255,0.07)', border2: 'rgba(255,255,255,0.12)',
  text: '#e8eaf0', text2: '#8b90a0', text3: '#545968',
  blue: '#4f8ef7', teal: '#2dd4bf', green: '#34c77b', amber: '#f5a623', red: '#f04e4e', purple: '#a78bfa', accent: '#4f8ef7',
}
const money = (n: any) => `$${(Number(n) || 0).toFixed(2)}`
const fmtDate = (iso: string | null) => iso ? new Date(iso).toLocaleDateString('en-AU', { day:'numeric', month:'short', year:'2-digit' }) : '—'

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
    if (!confirm('Move this invoice to Trash? You can restore it later from the trash view.')) return
    const r = await fetch(`/api/workshop/invoices/${id}`, { method: 'DELETE' })
    if (r.ok) load()
  }

  return (
    <>
      <Head><title>Invoices — Just Autos</title><meta name="robots" content="noindex,nofollow"/></Head>
      <div style={{ display:'flex', flexDirection:'column', height:'100vh', overflow:'hidden', fontFamily:"'DM Sans',system-ui,sans-serif", color:T.text }}>
        <PortalTopBar activeId="workshop-invoices" lastRefresh={lastRefresh} onRefresh={load} refreshing={loading}
          currentUserRole={user.role} currentUserVisibleTabs={user.visibleTabs} currentUserName={user.displayName} currentUserEmail={user.email} />

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
            <div style={{ maxWidth:1600, margin:'0 auto', background:T.bg2, border:`1px solid ${T.border}`, borderRadius:10, overflow:'hidden' }}>
              <div style={{ display:'grid', gridTemplateColumns:'100px 1fr 90px 110px 110px 110px 110px 70px', gap:8, padding:'9px 16px', background:T.bg3, borderBottom:`1px solid ${T.border}`, fontSize:9, color:T.text3, fontWeight:600, textTransform:'uppercase', letterSpacing:'0.05em' }}>
                <div>Date</div><div>Customer</div><div>Status</div><div style={{ textAlign:'right' }}>Total</div><div style={{ textAlign:'right' }}>Paid</div><div style={{ textAlign:'right' }}>Outstanding</div><div style={{ textAlign:'right' }}>Ext / MYOB</div><div style={{ textAlign:'right' }}></div>
              </div>
              {loading && invoices.length === 0 ? (
                <div style={{ padding:40, textAlign:'center', color:T.text3, fontSize:12 }}>Loading…</div>
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
          </div>
        </div>
      </div>
    </>
  )
}

function Chip({ label, active, onClick, c }: { label: string; active: boolean; onClick: () => void; c?: string }) {
  const accent = c || T.blue
  return (
    <button onClick={onClick} style={{
      padding:'4px 10px', borderRadius:4, fontSize:11, fontFamily:'inherit', fontWeight:600,
      background: active ? `${accent}1f` : 'transparent', color: active ? accent : T.text2,
      border: `1px solid ${active ? accent + '55' : T.border}`, cursor:'pointer',
    }}>{label}</button>
  )
}

function StatusPill({ v }: { v: string }) {
  const map: Record<string, string> = { finalised: T.teal, completed: T.teal, paid: T.green, open: T.amber, draft: T.text3 }
  const c = map[v] || T.text3
  return <span style={{ display:'inline-flex', padding:'2px 7px', borderRadius:3, background:`${c}1e`, color:c, fontSize:10, fontWeight:600, textTransform:'uppercase' }}>{v}</span>
}

const miniBtn = (c: string): React.CSSProperties => ({
  padding:'3px 8px', borderRadius:4, fontSize:10, fontFamily:'inherit', fontWeight:600,
  background:'transparent', color: c, border: `1px solid ${c}55`, cursor:'pointer',
})

export async function getServerSideProps(context: any) {
  return requirePageAuth(context, 'view:diary')
}
