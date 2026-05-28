// pages/workshop/invoice/[id].tsx
// Workshop invoice detail — historical imported invoices (those without a
// booking link). Shows the invoice header, lines, and payments side-by-side.
// Soft-delete + restore lives here too.

import { useEffect, useState } from 'react'
import Head from 'next/head'
import Link from 'next/link'
import { useRouter } from 'next/router'
import PortalTopBar from '../../../lib/PortalTopBar'
import { requirePageAuth } from '../../../lib/authServer'
import { roleHasPermission } from '../../../lib/permissions'

interface PortalUserSSR { id: string; email: string; displayName: string | null; role: 'admin'|'manager'|'sales'|'accountant'|'viewer'|'workshop'; visibleTabs?: string[] | null }

const T = {
  bg: '#0d0f12', bg2: '#131519', bg3: '#1a1d23', bg4: '#21252d',
  border: 'rgba(255,255,255,0.07)', border2: 'rgba(255,255,255,0.12)',
  text: '#e8eaf0', text2: '#8b90a0', text3: '#545968',
  blue: '#4f8ef7', teal: '#2dd4bf', green: '#34c77b', amber: '#f5a623', red: '#f04e4e', purple: '#a78bfa',
}
const money = (n: any) => `$${(Number(n) || 0).toFixed(2)}`
const fmtDate = (iso: string | null) => iso ? new Date(iso).toLocaleDateString('en-AU', { day:'numeric', month:'short', year:'2-digit' }) : '—'

export default function InvoiceDetailPage({ user }: { user: PortalUserSSR }) {
  const router = useRouter()
  const id = String(router.query.id || '')
  const canEdit = roleHasPermission(user.role, 'edit:bookings')
  const [data, setData] = useState<{ invoice: any; lines: any[]; payments: any[] } | null>(null)
  const [err, setErr] = useState('')

  async function load() {
    if (!id) return
    try {
      const r = await fetch(`/api/workshop/invoices/${id}`)
      const d = await r.json()
      if (r.ok) setData(d); else setErr(d.error || 'Load failed')
    } catch (e: any) { setErr(e?.message || 'Load failed') }
  }
  useEffect(() => { load() }, [id])

  async function softDelete() {
    if (!confirm('Move this invoice to Trash? Restorable from the invoices Trash view.')) return
    const r = await fetch(`/api/workshop/invoices/${id}`, { method: 'DELETE' })
    if (r.ok) router.push('/workshop/invoices')
    else { const d = await r.json().catch(()=>({})); setErr(d.error || 'Delete failed') }
  }
  async function restore() {
    const r = await fetch(`/api/workshop/invoices/${id}/restore`, { method: 'POST' })
    if (r.ok) load()
  }
  async function deletePayment(pid: string) {
    if (!confirm('Move this payment to Trash?')) return
    const r = await fetch(`/api/workshop/payments/${pid}`, { method: 'DELETE' })
    if (r.ok) load()
  }
  async function restorePayment(pid: string) {
    const r = await fetch(`/api/workshop/payments/${pid}?restore=1`, { method: 'POST' })
    if (r.ok) load()
  }

  const inv = data?.invoice
  const totalPaid = (data?.payments || []).filter(p => !p.deleted_at).reduce((s, p) => s + (Number(p.amount) || 0), 0)
  const outstanding = inv ? (Number(inv.total) || 0) - totalPaid : 0
  const isPaid = outstanding <= 0.01
  const isDeleted = !!inv?.deleted_at

  return (
    <>
      <Head><title>{inv ? `Invoice ${inv.md_id || inv.id.slice(0,8)} — Just Autos` : 'Invoice — Just Autos'}</title></Head>
      <div style={{ display:'flex', flexDirection:'column', height:'100vh', overflow:'hidden', fontFamily:"'DM Sans',system-ui,sans-serif", color:T.text }}>
        <PortalTopBar activeId="workshop-invoices" currentUserRole={user.role} currentUserVisibleTabs={user.visibleTabs} currentUserName={user.displayName} currentUserEmail={user.email} />
        <div style={{ flex:1, overflow:'auto', background:T.bg }}>
          <div style={{ maxWidth:1400, margin:'0 auto', padding:'24px 28px' }}>
            <Link href="/workshop/invoices" style={{ fontSize:11, color:T.text3, textDecoration:'none', fontFamily:'monospace' }}>← Invoices</Link>
            {err && <div style={{ marginTop:14, padding:12, background:'#3a1d1d', border:`1px solid ${T.red}`, borderRadius:6, color:T.red, fontSize:13 }}>{err}</div>}
            {!data && !err && <div style={{ marginTop:14, fontSize:13, color:T.text3 }}>Loading…</div>}

            {data && inv && (
              <>
                <div style={{ marginTop:10, marginBottom:18, padding:18, background:T.bg2, border:`1px solid ${isDeleted ? T.red + '55' : T.border}`, borderRadius:10, display:'flex', gap:20, flexWrap:'wrap', alignItems:'flex-start' }}>
                  <div style={{ flex:1, minWidth:240 }}>
                    <div style={{ fontSize:11, color:T.text3, fontFamily:'monospace' }}>Invoice {inv.md_id ? `#${inv.md_id}` : inv.id.slice(0,8)}</div>
                    <div style={{ fontSize:18, fontWeight:600, marginTop:4 }}>{inv.customer?.name || 'No customer linked'}</div>
                    <div style={{ fontSize:12, color:T.text3, marginTop:3 }}>
                      {[inv.customer?.mobile, inv.customer?.phone, inv.customer?.email].filter(Boolean).join(' · ') || '—'}
                    </div>
                    <div style={{ fontSize:11, color:T.text3, marginTop:8, fontFamily:'monospace' }}>
                      Issued {fmtDate(inv.created_at)}{inv.due_date ? ` · Due ${fmtDate(inv.due_date)}` : ''}
                      {inv.myob_invoice_uid && ' · MYOB linked'}
                    </div>
                  </div>
                  <div style={{ textAlign:'right' }}>
                    <div style={{ fontSize:10, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em' }}>Status</div>
                    <div style={{ fontSize:14, fontWeight:600, color: isPaid ? T.green : T.amber, marginTop:2 }}>{isPaid ? 'PAID' : (inv.status || 'open').toUpperCase()}</div>
                    {isDeleted && <div style={{ fontSize:10, color:T.red, marginTop:4, fontFamily:'monospace' }}>IN TRASH</div>}
                  </div>
                </div>

                {/* Totals */}
                <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(140px, 1fr))', gap:12, marginBottom:18 }}>
                  <Tile label="Subtotal" value={money(inv.subtotal)} />
                  <Tile label="GST" value={money(inv.gst)} />
                  <Tile label="Total" value={money(inv.total)} accent={T.text} />
                  <Tile label="Paid" value={money(totalPaid)} accent={T.green} />
                  <Tile label="Outstanding" value={isPaid ? '—' : money(outstanding)} accent={isPaid ? T.green : T.amber} />
                </div>

                {/* Lines */}
                <Card title="Line items" count={data.lines.length}>
                  {data.lines.length === 0 ? (
                    <div style={{ padding:20, textAlign:'center', color:T.text3, fontSize:12 }}>No line items.</div>
                  ) : (
                    <>
                      <Hdr cols="80px 1fr 110px 60px 90px 90px" labels={['Type','Description','Part #','Qty','Unit ex','Total ex']} />
                      {data.lines.map((l: any) => (
                        <Row key={l.id} cols="80px 1fr 110px 60px 90px 90px">
                          <div style={{ fontSize:11, color:T.text3, textTransform:'uppercase' }}>{l.line_type || ''}</div>
                          <div style={{ overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{l.description || '—'}</div>
                          <div style={{ fontSize:11, color:T.text3, fontFamily:'monospace' }}>{l.part_number || ''}</div>
                          <div style={{ textAlign:'right', fontVariantNumeric:'tabular-nums' }}>{l.qty}</div>
                          <div style={{ textAlign:'right', fontVariantNumeric:'tabular-nums', color:T.text2 }}>{money(l.unit_price_ex_gst)}</div>
                          <div style={{ textAlign:'right', fontVariantNumeric:'tabular-nums' }}>{money(l.total_ex_gst)}</div>
                        </Row>
                      ))}
                    </>
                  )}
                </Card>

                {/* Payments */}
                <Card title="Payments" count={data.payments.length}>
                  {data.payments.length === 0 ? (
                    <div style={{ padding:20, textAlign:'center', color:T.text3, fontSize:12 }}>No payments recorded.</div>
                  ) : (
                    <>
                      <Hdr cols="100px 1fr 100px 90px 90px 90px" labels={['Date','Method / Ref','Tender','Amount','Status','']} />
                      {data.payments.map((p: any) => (
                        <Row key={p.id} cols="100px 1fr 100px 90px 90px 90px">
                          <div style={{ fontSize:11, color:T.text2, fontFamily:'monospace' }}>{fmtDate(p.created_at)}</div>
                          <div style={{ color:T.text2, fontSize:11 }}>{p.method || (p.md_id ? `#${p.md_id}` : '—')}</div>
                          <div style={{ fontSize:11, color:T.text3, textTransform:'uppercase' }}>{p.tender}</div>
                          <div style={{ textAlign:'right', fontVariantNumeric:'tabular-nums', fontWeight:600 }}>{money(p.amount)}</div>
                          <div style={{ textAlign:'right', fontSize:10, color: p.deleted_at ? T.red : T.green, textTransform:'uppercase' }}>{p.deleted_at ? 'trash' : 'active'}</div>
                          <div style={{ textAlign:'right' }}>
                            {canEdit && (p.deleted_at
                              ? <button onClick={() => restorePayment(p.id)} style={miniBtn(T.green)}>Restore</button>
                              : <button onClick={() => deletePayment(p.id)} style={miniBtn(T.red)}>Delete</button>)}
                          </div>
                        </Row>
                      ))}
                    </>
                  )}
                </Card>

                {/* Actions */}
                <div style={{ marginTop:18, display:'flex', gap:8 }}>
                  {canEdit && !isDeleted && <button onClick={softDelete} style={qbtn(T.red)}>🗑 Move to Trash</button>}
                  {canEdit && isDeleted && <button onClick={restore} style={qbtn(T.green)}>↩ Restore</button>}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </>
  )
}

function Tile({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div style={{ padding:12, background:T.bg2, border:`1px solid ${T.border}`, borderRadius:8 }}>
      <div style={{ fontSize:10, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em' }}>{label}</div>
      <div style={{ fontSize:18, fontWeight:600, color: accent || T.text2, fontVariantNumeric:'tabular-nums', marginTop:3 }}>{value}</div>
    </div>
  )
}
function Card({ title, count, children }: { title: string; count: number; children: any }) {
  return (
    <div style={{ marginBottom:18 }}>
      <div style={{ display:'flex', alignItems:'baseline', justifyContent:'space-between', marginBottom:8 }}>
        <h2 style={{ fontSize:14, fontWeight:600, margin:0 }}>{title}</h2>
        <div style={{ fontSize:10, color:T.text3, fontFamily:'monospace' }}>{count}</div>
      </div>
      <div style={{ background:T.bg2, border:`1px solid ${T.border}`, borderRadius:8, overflow:'hidden' }}>{children}</div>
    </div>
  )
}
function Hdr({ cols, labels }: { cols: string; labels: string[] }) {
  return (
    <div style={{ display:'grid', gridTemplateColumns:cols, gap:12, padding:'8px 14px', fontSize:9, color:T.text3, fontWeight:600, textTransform:'uppercase', letterSpacing:'0.05em', borderBottom:`1px solid ${T.border}`, background:T.bg3 }}>
      {labels.map((l, i) => <div key={i} style={{ textAlign: i >= 3 ? 'right' : 'left' }}>{l}</div>)}
    </div>
  )
}
function Row({ cols, children }: { cols: string; children: any }) {
  return <div style={{ display:'grid', gridTemplateColumns:cols, gap:12, padding:'9px 14px', borderTop:`1px solid ${T.border}`, alignItems:'center', fontSize:12 }}>{children}</div>
}
const qbtn = (c: string): React.CSSProperties => ({
  padding:'7px 14px', borderRadius:5, fontSize:12, fontFamily:'inherit', fontWeight:600,
  background:'transparent', color: c, border: `1px solid ${c}55`, cursor:'pointer',
})
const miniBtn = (c: string): React.CSSProperties => ({
  padding:'3px 8px', borderRadius:4, fontSize:10, fontFamily:'inherit', fontWeight:600,
  background:'transparent', color: c, border: `1px solid ${c}55`, cursor:'pointer',
})

export async function getServerSideProps(context: any) {
  return requirePageAuth(context, 'view:diary')
}
