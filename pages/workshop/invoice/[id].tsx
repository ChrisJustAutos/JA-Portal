// pages/workshop/invoice/[id].tsx
// Workshop invoice detail — historical imported invoices (those without a
// booking link). Shows the invoice header, lines, and payments side-by-side.
// Soft-delete + restore lives here too.

import { useEffect, useState } from 'react'
import Head from 'next/head'
import Link from 'next/link'
import { useRouter } from 'next/router'
import PortalTopBar from '../../../lib/PortalTopBar'
import WorkshopTabs from '../../../components/WorkshopTabs'
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
  const [creditNotes, setCreditNotes] = useState<any[]>([])
  const [credit, setCredit] = useState<{ open: boolean; mode: 'lines' | 'amount'; sel: Record<string, boolean>; qty: Record<string, string>; amount: string; reason: string; refund: boolean; tender: string; busy: boolean; msg: string }>({ open: false, mode: 'lines', sel: {}, qty: {}, amount: '', reason: '', refund: false, tender: 'card', busy: false, msg: '' })

  async function load() {
    if (!id) return
    try {
      const r = await fetch(`/api/workshop/invoices/${id}`)
      const d = await r.json()
      if (r.ok) setData(d); else setErr(d.error || 'Load failed')
    } catch (e: any) { setErr(e?.message || 'Load failed') }
    try { const r = await fetch(`/api/workshop/credit-notes?invoice_id=${id}`); if (r.ok) setCreditNotes((await r.json()).creditNotes || []) } catch { /* ignore */ }
  }
  useEffect(() => { load() }, [id])

  async function submitCredit() {
    setCredit(s => ({ ...s, busy: true, msg: '' }))
    const lineIds = Object.keys(credit.sel).filter(k => credit.sel[k])
    const qtyOverrides: Record<string, number> = {}
    for (const lid of lineIds) { const v = Number(credit.qty[lid]); if (isFinite(v) && v > 0) qtyOverrides[lid] = v }
    const r = await fetch('/api/workshop/credit-notes', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        invoice_id: id, kind: credit.mode, line_ids: lineIds, qty_overrides: qtyOverrides,
        amount: Number(credit.amount) || 0, reason: credit.reason,
        refund: credit.refund ? { tender: credit.tender } : null,
      }),
    })
    const d = await r.json()
    if (!r.ok) { setCredit(s => ({ ...s, busy: false, msg: d.error || 'Credit failed' })); return }
    setCredit(s => ({ ...s, open: false, busy: false, sel: {}, qty: {}, amount: '', reason: '', msg: d.myob_warning || `${d.cn_number} recorded` }))
    await load()
  }

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
  const creditTotal = creditNotes.reduce((s, cn) => s + (Number(cn.total_inc) || 0), 0)
  const outstanding = inv ? (Number(inv.total) || 0) - creditTotal - totalPaid : 0
  const isPaid = outstanding <= 0.01
  const isDeleted = !!inv?.deleted_at

  return (
    <>
      <Head><title>{inv ? `Invoice ${inv.md_id || inv.id.slice(0,8)} — Just Autos` : 'Invoice — Just Autos'}</title></Head>
      <div style={{ display:'flex', flexDirection:'column', height:'100vh', overflow:'hidden', fontFamily:"'DM Sans',system-ui,sans-serif", color:T.text }}>
        <PortalTopBar activeId="diary" currentUserRole={user.role} currentUserVisibleTabs={user.visibleTabs} currentUserName={user.displayName} currentUserEmail={user.email} />
        <WorkshopTabs active="invoices" role={user.role} />
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
                  {creditTotal > 0 && <Tile label="Credited" value={`−${money(creditTotal)}`} accent={T.red} />}
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

                {/* Credit notes */}
                {creditNotes.length > 0 && (
                  <Card title="Credit notes" count={creditNotes.length}>
                    <Hdr cols="100px 90px 1fr 110px 90px" labels={['Date','CN #','Reason','Amount','MYOB']} />
                    {creditNotes.map((cn: any) => (
                      <Row key={cn.id} cols="100px 90px 1fr 110px 90px">
                        <div style={{ fontSize:11, color:T.text2, fontFamily:'monospace' }}>{fmtDate(cn.created_at)}</div>
                        <div style={{ fontSize:11, fontFamily:'monospace', color:T.red }}>CN-{cn.cn_seq}</div>
                        <div style={{ overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', color:T.text2 }}>{cn.reason || '—'}{cn.refunded ? ' · refunded' : ''}</div>
                        <div style={{ textAlign:'right', fontVariantNumeric:'tabular-nums', color:T.red, fontWeight:600 }}>−{money(cn.total_inc)}</div>
                        <div style={{ textAlign:'right', fontSize:10, color: cn.myob_credit_uid ? T.green : T.text3 }}>{cn.myob_credit_uid ? (cn.myob_credit_number || 'posted') : 'local'}</div>
                      </Row>
                    ))}
                  </Card>
                )}

                {/* Credit / refund panel */}
                {credit.open && (
                  <div style={{ marginBottom:18, padding:14, background:T.bg2, border:`1px solid ${T.red}55`, borderRadius:8 }}>
                    <div style={{ display:'flex', gap:8, alignItems:'center', marginBottom:10 }}>
                      <span style={{ fontSize:12, fontWeight:600, color:T.red }}>↩ Credit note</span>
                      <button onClick={() => setCredit(s => ({ ...s, mode:'lines' }))} style={qbtn(credit.mode === 'lines' ? T.red : T.text3)}>Credit lines</button>
                      <button onClick={() => setCredit(s => ({ ...s, mode:'amount' }))} style={qbtn(credit.mode === 'amount' ? T.red : T.text3)}>Fixed amount</button>
                    </div>
                    {credit.mode === 'lines' ? (
                      <div style={{ marginBottom:10 }}>
                        {(data.lines || []).map((l: any) => {
                          const on = !!credit.sel[l.id]
                          return (
                            <div key={l.id} style={{ display:'flex', gap:8, alignItems:'center', padding:'4px 0', fontSize:12 }}>
                              <input type="checkbox" checked={on} onChange={e => setCredit(s => ({ ...s, sel: { ...s.sel, [l.id]: e.target.checked } }))} />
                              <span style={{ flex:1, color: on ? T.text : T.text3, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{l.description || l.line_type}</span>
                              <span style={{ fontSize:10, color:T.text3 }}>qty</span>
                              <input value={credit.qty[l.id] ?? String(l.qty)} disabled={!on}
                                onChange={e => setCredit(s => ({ ...s, qty: { ...s.qty, [l.id]: e.target.value } }))}
                                style={{ ...cinp, width:56, opacity: on ? 1 : 0.4 }} inputMode="decimal" />
                              <span style={{ fontFamily:'monospace', color:T.text3, minWidth:70, textAlign:'right' }}>{money((Number(l.total_ex_gst) || 0) * 1.1)}</span>
                            </div>
                          )
                        })}
                      </div>
                    ) : (
                      <div style={{ display:'flex', gap:8, alignItems:'center', marginBottom:10 }}>
                        <span style={{ fontSize:11, color:T.text3 }}>Amount (inc GST)</span>
                        <input value={credit.amount} inputMode="decimal" onChange={e => setCredit(s => ({ ...s, amount: e.target.value }))} style={{ ...cinp, width:120 }} />
                      </div>
                    )}
                    <div style={{ display:'flex', gap:8, alignItems:'center', flexWrap:'wrap' }}>
                      <input value={credit.reason} onChange={e => setCredit(s => ({ ...s, reason: e.target.value }))} placeholder="Reason…" style={{ ...cinp, flex:1, minWidth:200 }} />
                      <label style={{ display:'flex', gap:5, alignItems:'center', fontSize:11, color:T.text2, cursor:'pointer' }}>
                        <input type="checkbox" checked={credit.refund} onChange={e => setCredit(s => ({ ...s, refund: e.target.checked }))} /> refund via
                      </label>
                      <select value={credit.tender} disabled={!credit.refund} onChange={e => setCredit(s => ({ ...s, tender: e.target.value }))} style={{ ...cinp, opacity: credit.refund ? 1 : 0.4 }}>
                        {['cash','eftpos','card','bank_transfer','direct_deposit','direct_debit','paypal','other'].map(t => <option key={t} value={t}>{t.replace(/_/g,' ')}</option>)}
                      </select>
                      <button onClick={() => setCredit(s => ({ ...s, open:false }))} style={qbtn(T.text3)}>Cancel</button>
                      <button onClick={submitCredit} disabled={credit.busy} style={{ ...qbtn(T.red), background:`${T.red}1e` }}>{credit.busy ? 'Saving…' : 'Issue credit'}</button>
                    </div>
                    {credit.msg && <div style={{ fontSize:11, color:T.amber, marginTop:8 }}>{credit.msg}</div>}
                  </div>
                )}
                {credit.msg && !credit.open && <div style={{ fontSize:11, color:T.text2, marginBottom:10 }}>{credit.msg}</div>}

                {/* Actions */}
                <div style={{ marginTop:18, display:'flex', gap:8 }}>
                  {canEdit && !isDeleted && <button onClick={() => setCredit(s => ({ ...s, open: !s.open, msg:'' }))} style={qbtn(T.red)}>↩ Credit / refund</button>}
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
const cinp: React.CSSProperties = {
  padding:'6px 9px', background:T.bg3, border:`1px solid ${T.border2}`, borderRadius:5,
  color:T.text, fontSize:12, fontFamily:'inherit', outline:'none',
}

export async function getServerSideProps(context: any) {
  return requirePageAuth(context, 'view:diary')
}
