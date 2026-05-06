// pages/admin/b2b/orders/[id].tsx
//
// Staff order detail. Two columns:
//   Left:  header info, lines, totals, Stripe, MYOB, refund history
//   Right: status timeline, action buttons, internal notes (autosave on blur)
//
// Modals: Mark as Shipped (carrier + tracking), Refund, Cancel.

import { useEffect, useState, useMemo, useCallback } from 'react'
import Head from 'next/head'
import { useRouter } from 'next/router'
import PortalSidebar from '../../../../lib/PortalSidebar'
import { requirePageAuth } from '../../../../lib/authServer'
import { roleHasPermission, type UserRole } from '../../../../lib/permissions'

const T = {
  bg:'#0d0f12', bg2:'#131519', bg3:'#1a1d23', bg4:'#21252d',
  border:'rgba(255,255,255,0.07)', border2:'rgba(255,255,255,0.12)',
  text:'#e8eaf0', text2:'#8b90a0', text3:'#545968',
  blue:'#4f8ef7', teal:'#2dd4bf', green:'#34c77b',
  amber:'#f5a623', red:'#f04e4e', purple:'#a78bfa',
}

interface Props {
  user: {
    id: string
    email: string
    displayName: string | null
    role: UserRole
    visibleTabs: string[] | null
  }
}

interface OrderLine {
  id: string
  sku: string
  name: string
  qty: number
  unit_trade_price_ex_gst: number
  line_subtotal_ex_gst: number
  line_gst: number
  line_total_inc: number
  is_taxable: boolean
  sort_order: number
  myob_item_uid: string | null
}

interface OrderEvent {
  id: string
  event_type: string
  from_status: string | null
  to_status: string | null
  actor_type: string
  actor_id: string | null
  actor_name: string
  notes: string | null
  metadata: any
  created_at: string
}

interface RefundRow {
  id: string
  amount: number
  currency: string
  status: string
  reason: string | null
  created: number
}

interface OrderDetail {
  id: string
  order_number: string
  status: string
  placed_at: string
  paid_at: string | null
  picked_at: string | null
  packed_at: string | null
  shipped_at: string | null
  delivered_at: string | null
  cancelled_at: string | null
  refunded_at: string | null
  currency: string
  customer_po: string | null
  subtotal_ex_gst: number
  gst: number
  card_fee_inc: number
  total_inc: number
  refunded_total: number
  carrier: string | null
  tracking_number: string | null
  customer_notes: string | null
  internal_notes: string | null
  distributor: { id: string; display_name: string; myob_customer_uid: string | null } | null
  stripe: { checkout_session_id: string | null; payment_intent_id: string | null; charge_id: string | null }
  myob: {
    company_file: string | null
    order_uid: string | null
    order_number: string | null
    written_at: string | null
    write_attempts: number | null
    write_error: string | null
  }
  lines: OrderLine[]
  events: OrderEvent[]
  refunds: RefundRow[]
}

const STATUS_LABEL: Record<string, string> = {
  pending_payment: 'Pending payment',
  paid: 'Paid', picking: 'Picking', packed: 'Packed',
  shipped: 'Shipped', delivered: 'Delivered',
  cancelled: 'Cancelled', refunded: 'Refunded',
}
const STATUS_COLOR: Record<string, string> = {
  pending_payment: T.text3,
  paid: T.blue, picking: T.amber, packed: T.amber,
  shipped: T.teal, delivered: T.green,
  cancelled: T.red, refunded: T.purple,
}

// What status transitions are allowed from a given status (must mirror server)
const ALLOWED_TRANSITIONS: Record<string, { to: string; label: string; primary?: boolean; needsModal?: 'shipped' }[]> = {
  paid:      [{ to: 'picking', label: 'Mark as picking', primary: true }],
  picking:   [{ to: 'packed',  label: 'Mark as packed',  primary: true }, { to: 'paid',    label: 'Undo (back to paid)' }],
  packed:    [{ to: 'shipped', label: 'Mark as shipped', primary: true, needsModal: 'shipped' }, { to: 'picking', label: 'Undo (back to picking)' }],
  shipped:   [{ to: 'delivered', label: 'Mark as delivered', primary: true }, { to: 'packed', label: 'Undo (back to packed)' }],
  delivered: [{ to: 'shipped', label: 'Undo (back to shipped)' }],
}

export default function AdminOrderDetailPage({ user }: Props) {
  const router = useRouter()
  const orderId = String(router.query.id || '')
  const canEdit   = roleHasPermission(user.role, 'edit:b2b_orders')
  const canRefund = roleHasPermission(user.role, 'admin:b2b')

  const [data, setData]       = useState<OrderDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)
  const [actionBusy, setActionBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [flash, setFlash]     = useState<string | null>(null)

  // Modals
  const [shipModal, setShipModal]     = useState(false)
  const [refundModal, setRefundModal] = useState(false)
  const [cancelModal, setCancelModal] = useState(false)

  // Internal notes draft (autosave on blur)
  const [notesDraft, setNotesDraft] = useState('')
  const [notesBusy, setNotesBusy]   = useState(false)
  const [notesError, setNotesError] = useState<string | null>(null)

  async function load() {
    if (!orderId) return
    setLoading(true); setError(null)
    try {
      const r = await fetch(`/api/b2b/admin/orders/${orderId}`, { credentials: 'same-origin' })
      if (!r.ok) {
        const t = await r.text()
        throw new Error(`HTTP ${r.status}: ${t.substring(0, 200)}`)
      }
      const j = await r.json()
      setData(j.order)
      setNotesDraft(j.order.internal_notes || '')
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [orderId])

  function flashMsg(msg: string) {
    setFlash(msg)
    setTimeout(() => setFlash(null), 3000)
  }

  // ── Status transition action
  const doTransition = useCallback(async (toStatus: string, extras: Record<string, any> = {}) => {
    setActionBusy(true); setActionError(null)
    try {
      const r = await fetch(`/api/b2b/admin/orders/${orderId}/transition`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to_status: toStatus, ...extras }),
      })
      const j = await r.json()
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`)
      flashMsg(`Status changed to ${STATUS_LABEL[toStatus] || toStatus}`)
      await load()
    } catch (e: any) {
      setActionError(e?.message || String(e))
    } finally {
      setActionBusy(false)
    }
  }, [orderId])

  // ── Refund action
  const doRefund = useCallback(async (amount: number | null, reason: string | undefined, notes: string | undefined) => {
    setActionBusy(true); setActionError(null)
    try {
      const r = await fetch(`/api/b2b/admin/orders/${orderId}/refund`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount, reason, notes }),
      })
      const j = await r.json()
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`)
      const amt = j.refund?.amount
      flashMsg(amt != null ? `Refund of $${money(amt)} issued` : 'Refund issued')
      setRefundModal(false)
      await load()
    } catch (e: any) {
      setActionError(e?.message || String(e))
    } finally {
      setActionBusy(false)
    }
  }, [orderId])

  // ── Cancel action: refund first if requested, then transition to cancelled
  const doCancel = useCallback(async (alsoRefund: boolean, reason: string | undefined, notes: string | undefined) => {
    if (!data) return
    setActionBusy(true); setActionError(null)
    try {
      // 1. Refund (full) if requested
      if (alsoRefund) {
        const refundResp = await fetch(`/api/b2b/admin/orders/${orderId}/refund`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ amount: null, reason, notes }),  // null = full
        })
        const j = await refundResp.json()
        if (!refundResp.ok) throw new Error(`Refund failed: ${j?.error || refundResp.status}`)
      }
      // 2. Transition to cancelled
      const tResp = await fetch(`/api/b2b/admin/orders/${orderId}/transition`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to_status: 'cancelled',
          notes,
          confirm_cancel_without_refund: !alsoRefund,
        }),
      })
      const j2 = await tResp.json()
      if (!tResp.ok) throw new Error(j2?.error || `Cancel failed: HTTP ${tResp.status}`)

      flashMsg('Order cancelled')
      setCancelModal(false)
      await load()
    } catch (e: any) {
      setActionError(e?.message || String(e))
    } finally {
      setActionBusy(false)
    }
  }, [orderId, data])

  // ── Internal notes save
  const saveNotes = useCallback(async () => {
    if (!data) return
    if (notesDraft === (data.internal_notes || '')) return
    setNotesBusy(true); setNotesError(null)
    try {
      const r = await fetch(`/api/b2b/admin/orders/${orderId}`, {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ internal_notes: notesDraft || null }),
      })
      const j = await r.json()
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`)
      // refresh just the events; cheap option is full reload
      await load()
    } catch (e: any) {
      setNotesError(e?.message || String(e))
    } finally {
      setNotesBusy(false)
    }
  }, [orderId, data, notesDraft])

  const allowedTransitions = data ? (ALLOWED_TRANSITIONS[data.status] || []) : []
  const canCancel  = data && canEdit && ['paid','picking','packed','shipped'].includes(data.status)
  const canDoRefund = data && canRefund && data.paid_at && (Number(data.refunded_total || 0) < Number(data.total_inc || 0) - 0.005)

  return (
    <>
      <Head><title>{data ? `${data.order_number} · Orders` : 'Order · JA Portal'}</title></Head>
      <div style={{display:'flex',minHeight:'100vh',background:T.bg,color:T.text,fontFamily:'system-ui,-apple-system,sans-serif'}}>
        <PortalSidebar
          activeId="b2b"
          currentUserRole={user.role}
          currentUserVisibleTabs={user.visibleTabs}
          currentUserName={user.displayName}
          currentUserEmail={user.email}
        />
        <main style={{flex:1,padding:'28px 32px',maxWidth:1500}}>

          <header style={{marginBottom:18}}>
            <div style={{fontSize:11,color:T.text3,textTransform:'uppercase',letterSpacing:'0.08em',marginBottom:4}}>
              <a href="/admin/b2b" style={{color:T.text3,textDecoration:'none'}}>B2B Portal</a>
              {' / '}
              <a href="/admin/b2b/orders" style={{color:T.text3,textDecoration:'none'}}>Orders</a>
              {' / '}
              <span style={{color:T.text2}}>{data?.order_number || orderId}</span>
            </div>
            {data && (
              <div style={{display:'flex',alignItems:'baseline',gap:14,flexWrap:'wrap'}}>
                <h1 style={{fontSize:22,fontWeight:600,margin:0,letterSpacing:'-0.01em',fontFamily:'monospace'}}>{data.order_number}</h1>
                <StatusPill status={data.status}/>
                <span style={{color:T.text2,fontSize:13}}>· {data.distributor?.display_name || '—'}</span>
                <span style={{marginLeft:'auto',fontSize:13,color:T.text2,fontVariantNumeric:'tabular-nums'}}>
                  ${money(data.total_inc)} {data.currency}
                </span>
              </div>
            )}
          </header>

          {flash && (
            <div style={{padding:'8px 14px',background:`${T.green}15`,border:`1px solid ${T.green}40`,borderRadius:7,color:T.green,fontSize:12,marginBottom:14}}>
              ✓ {flash}
            </div>
          )}
          {error && (
            <div style={{padding:12,background:`${T.red}15`,border:`1px solid ${T.red}40`,borderRadius:7,color:T.red,fontSize:12,marginBottom:14}}>
              {error}
            </div>
          )}
          {actionError && (
            <div style={{padding:12,background:`${T.red}15`,border:`1px solid ${T.red}40`,borderRadius:7,color:T.red,fontSize:12,marginBottom:14,display:'flex',justifyContent:'space-between',gap:14}}>
              <span>{actionError}</span>
              <button onClick={() => setActionError(null)} style={{background:'transparent',border:'none',color:T.red,cursor:'pointer',fontSize:14}}>×</button>
            </div>
          )}

          {loading && !data && (
            <div style={{padding:40,textAlign:'center',color:T.text3,fontSize:12}}>Loading…</div>
          )}

          {data && (
            <div style={{display:'grid',gridTemplateColumns:'1fr 360px',gap:18,alignItems:'start'}}>

              {/* ── LEFT COLUMN ── */}
              <div style={{display:'flex',flexDirection:'column',gap:14}}>

                {/* Order summary header */}
                <Card title="Summary">
                  <KV label="Distributor"    value={data.distributor?.display_name || '—'}/>
                  <KV label="Customer PO"    value={data.customer_po || '—'} mono/>
                  <KV label="Placed"         value={fullDate(data.placed_at)} mono/>
                  {data.paid_at && <KV label="Paid"      value={fullDate(data.paid_at)}      mono valueColor={T.green}/>}
                  {data.shipped_at && <KV label="Shipped" value={fullDate(data.shipped_at)} mono valueColor={T.teal}/>}
                  {data.cancelled_at && <KV label="Cancelled" value={fullDate(data.cancelled_at)} mono valueColor={T.red}/>}
                </Card>

                {/* Lines */}
                <Card title={`Items (${data.lines.length})`}>
                  <div style={{overflowX:'auto',margin:'0 -22px',padding:'0 22px'}}>
                    <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
                      <thead>
                        <tr style={{borderBottom:`1px solid ${T.border}`}}>
                          <th style={th(140)}>SKU</th>
                          <th style={th()}>Item</th>
                          <th style={{...th(50),textAlign:'right'}}>Qty</th>
                          <th style={{...th(110),textAlign:'right'}}>Unit (ex GST)</th>
                          <th style={{...th(110),textAlign:'right'}}>Line (ex GST)</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.lines.map((ln, i) => (
                          <tr key={ln.id} style={{borderTop: i > 0 ? `1px solid ${T.border}` : 'none'}}>
                            <td style={td()}><span style={{fontFamily:'monospace',fontSize:11,color:T.text2}}>{ln.sku}</span></td>
                            <td style={td()}>{ln.name}</td>
                            <td style={{...td(),textAlign:'right',fontVariantNumeric:'tabular-nums'}}>{ln.qty}</td>
                            <td style={{...td(),textAlign:'right',fontVariantNumeric:'tabular-nums',fontFamily:'monospace'}}>${money(ln.unit_trade_price_ex_gst)}</td>
                            <td style={{...td(),textAlign:'right',fontVariantNumeric:'tabular-nums',fontFamily:'monospace'}}>${money(ln.line_subtotal_ex_gst)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Card>

                {/* Totals */}
                <Card title="Totals">
                  <Row label="Subtotal (ex GST)"  value={`$${money(data.subtotal_ex_gst)}`}/>
                  <Row label="GST"                value={`$${money(data.gst)}`}/>
                  <Row label="Card surcharge"     value={`$${money(data.card_fee_inc)}`} muted/>
                  <Row label="Total (inc GST)"    value={`$${money(data.total_inc)}`} bold/>
                  {Number(data.refunded_total || 0) > 0 && (
                    <Row label={`Refunded${Number(data.refunded_total) >= data.total_inc - 0.005 ? ' (full)' : ' (partial)'}`}
                         value={`-$${money(Number(data.refunded_total))}`} valueColor={T.purple}/>
                  )}
                </Card>

                {/* Stripe + MYOB info */}
                <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:14}}>
                  <Card title="Stripe">
                    <KV label="Status" value={data.paid_at ? 'Paid' : 'Pending'} valueColor={data.paid_at ? T.green : T.amber}/>
                    <KV label="Payment Intent" value={data.stripe.payment_intent_id || '—'} mono small/>
                    <KV label="Session ID"     value={data.stripe.checkout_session_id || '—'} mono small/>
                    {data.stripe.payment_intent_id && (
                      <div style={{marginTop:8}}>
                        <a href={`https://dashboard.stripe.com/payments/${data.stripe.payment_intent_id}`}
                          target="_blank" rel="noopener noreferrer"
                          style={{fontSize:11,color:T.blue,textDecoration:'none'}}>
                          Open in Stripe →
                        </a>
                      </div>
                    )}
                  </Card>
                  <Card title="MYOB">
                    <KV label="Company file" value={data.myob.company_file || 'JAWS'}/>
                    <KV label="Order #"      value={data.myob.order_number || '—'} mono valueColor={data.myob.order_number ? T.text2 : T.amber}/>
                    <KV label="Written"      value={data.myob.written_at ? fullDate(data.myob.written_at) : '—'} mono small/>
                    <KV label="Attempts"     value={String(data.myob.write_attempts ?? 0)}/>
                    {data.myob.write_error && (
                      <div style={{marginTop:8,padding:8,background:`${T.red}15`,border:`1px solid ${T.red}40`,borderRadius:5,color:T.red,fontSize:11}}>
                        ⚠ {data.myob.write_error}
                      </div>
                    )}
                  </Card>
                </div>

                {/* Refund history */}
                {data.refunds.length > 0 && (
                  <Card title={`Refunds (${data.refunds.length})`}>
                    {data.refunds.map(rf => (
                      <div key={rf.id} style={{display:'flex',justifyContent:'space-between',gap:14,padding:'8px 0',borderTop:`1px solid ${T.border}`,fontSize:12}}>
                        <div>
                          <div style={{color:T.text}}>${money(rf.amount)} <span style={{color:T.text3,fontSize:10}}>{rf.currency.toUpperCase()}</span></div>
                          <div style={{fontSize:10,color:T.text3,marginTop:2,fontFamily:'monospace'}}>
                            {rf.id} · {new Date(rf.created * 1000).toLocaleString('en-AU')}
                          </div>
                        </div>
                        <div style={{textAlign:'right'}}>
                          <div style={{fontSize:10,padding:'2px 7px',borderRadius:3,
                            background: rf.status === 'succeeded' ? `${T.green}15` : `${T.amber}15`,
                            color: rf.status === 'succeeded' ? T.green : T.amber,
                            display:'inline-block',textTransform:'uppercase',letterSpacing:'0.04em',fontWeight:500}}>
                            {rf.status}
                          </div>
                          {rf.reason && <div style={{fontSize:10,color:T.text3,marginTop:3}}>{rf.reason.replace(/_/g,' ')}</div>}
                        </div>
                      </div>
                    ))}
                  </Card>
                )}

                {/* Customer notes (read-only) */}
                {data.customer_notes && (
                  <Card title="Customer notes">
                    <p style={{margin:0,whiteSpace:'pre-wrap',fontSize:12,color:T.text2,lineHeight:1.5}}>{data.customer_notes}</p>
                  </Card>
                )}

              </div>

              {/* ── RIGHT COLUMN ── */}
              <div style={{display:'flex',flexDirection:'column',gap:14,position:'sticky',top:18}}>

                {/* Status timeline */}
                <Card title="Timeline">
                  <Timeline events={data.events}/>
                </Card>

                {/* Action buttons */}
                {canEdit && (
                  <Card title="Actions">
                    {allowedTransitions.length === 0 && !canCancel && !canDoRefund && (
                      <div style={{fontSize:11,color:T.text3}}>No actions available for this status.</div>
                    )}

                    {allowedTransitions.map(t => (
                      <button
                        key={t.to}
                        disabled={actionBusy}
                        onClick={() => {
                          if (t.needsModal === 'shipped') setShipModal(true)
                          else doTransition(t.to)
                        }}
                        style={actionBtn(!!t.primary, actionBusy)}>
                        {t.label}
                      </button>
                    ))}

                    {canDoRefund && (
                      <button
                        disabled={actionBusy}
                        onClick={() => setRefundModal(true)}
                        style={actionBtn(false, actionBusy, T.purple)}>
                        Refund…
                      </button>
                    )}

                    {canCancel && (
                      <button
                        disabled={actionBusy}
                        onClick={() => setCancelModal(true)}
                        style={actionBtn(false, actionBusy, T.red)}>
                        Cancel order…
                      </button>
                    )}
                  </Card>
                )}

                {/* Shipping info preview */}
                {(data.carrier || data.tracking_number) && (
                  <Card title="Shipping">
                    <KV label="Carrier"  value={data.carrier || '—'}/>
                    <KV label="Tracking" value={data.tracking_number || '—'} mono/>
                  </Card>
                )}

                {/* Internal notes */}
                {canEdit && (
                  <Card title="Internal notes">
                    <textarea
                      value={notesDraft}
                      onChange={e => setNotesDraft(e.target.value)}
                      onBlur={saveNotes}
                      placeholder="Staff-only notes about this order. Saves on blur."
                      rows={5}
                      style={{
                        width:'100%',boxSizing:'border-box',
                        background:T.bg3,border:`1px solid ${T.border}`,color:T.text,
                        borderRadius:5,padding:'8px 10px',fontSize:12,outline:'none',
                        resize:'vertical',fontFamily:'inherit',
                      }}/>
                    <div style={{fontSize:10,color: notesError ? T.red : T.text3,marginTop:4}}>
                      {notesError || (notesBusy ? 'Saving…' : 'Saves automatically when you click outside')}
                    </div>
                  </Card>
                )}

              </div>
            </div>
          )}

        </main>
      </div>

      {/* ── Modals ── */}
      {data && shipModal   && <ShipModal   order={data} busy={actionBusy} onClose={() => setShipModal(false)}   onConfirm={(c, t) => { setShipModal(false); doTransition('shipped', { carrier: c, tracking_number: t }) }}/>}
      {data && refundModal && <RefundModal order={data} busy={actionBusy} onClose={() => setRefundModal(false)} onConfirm={doRefund}/>}
      {data && cancelModal && <CancelModal order={data} busy={actionBusy} canRefund={!!canDoRefund} onClose={() => setCancelModal(false)} onConfirm={doCancel}/>}
    </>
  )
}

// ─── Components ────────────────────────────────────────────────────────

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{
      background:T.bg2,border:`1px solid ${T.border}`,borderRadius:10,
      padding:'16px 22px',
    }}>
      <div style={{fontSize:10,color:T.text3,textTransform:'uppercase',letterSpacing:'0.08em',marginBottom:12,fontWeight:500}}>{title}</div>
      {children}
    </section>
  )
}

function KV({ label, value, mono, small, valueColor }: { label: string; value: string; mono?: boolean; small?: boolean; valueColor?: string }) {
  return (
    <div style={{display:'flex',justifyContent:'space-between',gap:14,padding:'5px 0',fontSize:12,borderBottom:`1px solid ${T.border}`}}>
      <span style={{color:T.text3,flexShrink:0}}>{label}</span>
      <span style={{
        color: valueColor || T.text2,
        fontFamily: mono ? 'monospace' : 'inherit',
        fontSize: small ? 10 : 12,
        textAlign:'right',
        wordBreak: mono ? 'break-all' : 'normal',
      }}>{value}</span>
    </div>
  )
}

function Row({ label, value, bold, muted, valueColor }: { label: string; value: string; bold?: boolean; muted?: boolean; valueColor?: string }) {
  return (
    <div style={{
      display:'flex',justifyContent:'space-between',padding:'4px 0',fontSize: bold ? 14 : 12,
      color: muted ? T.text3 : T.text2,
      fontWeight: bold ? 600 : 400,
      borderTop: bold ? `1px solid ${T.border2}` : 'none',
      marginTop: bold ? 6 : 0,
      paddingTop: bold ? 8 : 4,
    }}>
      <span>{label}</span>
      <span style={{color: valueColor || (bold ? T.text : 'inherit'),fontVariantNumeric:'tabular-nums',fontFamily:'monospace'}}>{value}</span>
    </div>
  )
}

function StatusPill({ status }: { status: string }) {
  const color = STATUS_COLOR[status] || T.text3
  const label = STATUS_LABEL[status] || status
  return (
    <span style={{
      display:'inline-flex',alignItems:'center',gap:6,
      padding:'3px 10px',borderRadius:5,
      background:`${color}15`,border:`1px solid ${color}40`,color,
      fontSize:11,fontWeight:600,textTransform:'uppercase',letterSpacing:'0.05em',
    }}>
      <span style={{display:'inline-block',width:7,height:7,borderRadius:'50%',background:color}}/>
      {label}
    </span>
  )
}

function Timeline({ events }: { events: OrderEvent[] }) {
  if (events.length === 0) return <div style={{fontSize:11,color:T.text3}}>No events yet.</div>
  return (
    <div style={{display:'flex',flexDirection:'column',gap:10}}>
      {events.map((ev, i) => {
        const isStatus = ev.event_type === 'status_changed'
        const color    = isStatus && ev.to_status ? (STATUS_COLOR[ev.to_status] || T.text3) :
                         ev.event_type === 'myob_credit_note_written' ? T.purple :
                         ev.event_type === 'myob_credit_note_failed'  ? T.red :
                         ev.event_type === 'refund_failed'            ? T.red :
                         ev.event_type.startsWith('refund') ? T.purple :
                         ev.event_type === 'admin_edited' ? T.text3 :
                         ev.event_type === 'checkout_started' ? T.amber :
                         T.blue
        return (
          <div key={ev.id} style={{display:'flex',gap:10,fontSize:11}}>
            <div style={{
              width:8,height:8,borderRadius:'50%',background:color,
              flexShrink:0,marginTop:5,
            }}/>
            <div style={{flex:1,minWidth:0}}>
              <div style={{color:T.text,fontWeight:500}}>
                {labelForEvent(ev)}
              </div>
              <div style={{color:T.text3,fontSize:10,marginTop:2}}>
                {new Date(ev.created_at).toLocaleString('en-AU')}
                {' · '}{ev.actor_name}
              </div>
              {ev.notes && (
                <div style={{color:T.text2,fontSize:11,marginTop:3,fontStyle:'italic',lineHeight:1.4}}>{ev.notes}</div>
              )}
              {ev.event_type === 'status_changed' && ev.metadata?.tracking_number && (
                <div style={{color:T.text3,fontSize:10,marginTop:3,fontFamily:'monospace'}}>
                  {ev.metadata.carrier && `${ev.metadata.carrier} · `}{ev.metadata.tracking_number}
                </div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function labelForEvent(ev: OrderEvent): string {
  if (ev.event_type === 'status_changed') {
    const from = ev.from_status ? (STATUS_LABEL[ev.from_status] || ev.from_status) : '?'
    const to   = ev.to_status   ? (STATUS_LABEL[ev.to_status]   || ev.to_status)   : '?'
    return `${from} → ${to}`
  }
  if (ev.event_type === 'refunded_full')          return `Full refund · $${money(Number(ev.metadata?.amount || 0))}`
  if (ev.event_type === 'refunded_partial')       return `Partial refund · $${money(Number(ev.metadata?.amount || 0))}`
  if (ev.event_type === 'refund_failed')          return 'Refund attempt failed'
  if (ev.event_type === 'myob_credit_note_written') {
    const num = ev.metadata?.myob_credit_note_number || '?'
    return `MYOB credit note ${num} created`
  }
  if (ev.event_type === 'myob_credit_note_failed') return 'MYOB credit note failed'
  if (ev.event_type === 'admin_edited')           return 'Admin updated fields'
  if (ev.event_type === 'checkout_started')       return 'Checkout started'
  return ev.event_type.replace(/_/g, ' ')
}

// ─── Modals ────────────────────────────────────────────────────────────

function Backdrop({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <>
      <div onClick={onClose} style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.6)',zIndex:1000}}/>
      <div style={{
        position:'fixed',top:'50%',left:'50%',transform:'translate(-50%,-50%)',
        background:T.bg2,border:`1px solid ${T.border2}`,borderRadius:10,
        padding:24,minWidth:400,maxWidth:500,zIndex:1001,
        boxShadow:'0 20px 50px rgba(0,0,0,0.5)',
      }}>
        {children}
      </div>
    </>
  )
}

function ShipModal({ order, busy, onClose, onConfirm }: { order: OrderDetail; busy: boolean; onClose: () => void; onConfirm: (carrier: string, tracking: string) => void }) {
  const [carrier, setCarrier]   = useState(order.carrier || '')
  const [tracking, setTracking] = useState(order.tracking_number || '')
  const ok = carrier.trim().length > 0 && tracking.trim().length > 0
  return (
    <Backdrop onClose={onClose}>
      <h2 style={modalTitle()}>Mark as shipped</h2>
      <p style={modalDesc()}>Enter the carrier and tracking number. Required to mark as shipped.</p>

      <Field label="Carrier" hint="e.g. Australia Post, StarTrack, TNT, Toll">
        <input type="text" value={carrier} onChange={e => setCarrier(e.target.value)} maxLength={100} style={modalInput()}/>
      </Field>
      <Field label="Tracking number">
        <input type="text" value={tracking} onChange={e => setTracking(e.target.value)} maxLength={100} style={modalInput()}/>
      </Field>

      <ModalButtons>
        <button onClick={onClose} disabled={busy} style={modalBtnSecondary()}>Cancel</button>
        <button onClick={() => onConfirm(carrier.trim(), tracking.trim())} disabled={!ok || busy} style={modalBtnPrimary(ok && !busy, T.teal)}>
          {busy ? 'Saving…' : 'Mark as shipped'}
        </button>
      </ModalButtons>
    </Backdrop>
  )
}

function RefundModal({ order, busy, onClose, onConfirm }: { order: OrderDetail; busy: boolean; onClose: () => void; onConfirm: (amount: number | null, reason: string | undefined, notes: string | undefined) => void }) {
  const remaining = Math.max(0, order.total_inc - Number(order.refunded_total || 0))
  const [mode, setMode]     = useState<'full' | 'partial'>('full')
  const [amount, setAmount] = useState<string>(remaining.toFixed(2))
  const [reason, setReason] = useState<string>('requested_by_customer')
  const [notes, setNotes]   = useState<string>('')

  const amt = mode === 'full' ? null : (Number(amount) || 0)
  const finalAmount = amt === null ? remaining : amt
  const valid = finalAmount > 0 && finalAmount <= remaining + 0.005

  return (
    <Backdrop onClose={onClose}>
      <h2 style={modalTitle()}>Refund order</h2>
      <p style={modalDesc()}>
        Refundable: <strong style={{color:T.text}}>${money(remaining)}</strong> (paid: ${money(order.total_inc)} · already refunded: ${money(Number(order.refunded_total || 0))})
      </p>

      <div style={{display:'flex',gap:8,marginBottom:14}}>
        <button onClick={() => setMode('full')}    style={modeBtn(mode === 'full',    T.purple)}>Full refund</button>
        <button onClick={() => setMode('partial')} style={modeBtn(mode === 'partial', T.purple)}>Partial</button>
      </div>

      {mode === 'partial' && (
        <Field label="Amount (AUD)">
          <input type="number" value={amount} onChange={e => setAmount(e.target.value)} step="0.01" min="0" max={remaining}
            style={modalInput()}/>
        </Field>
      )}

      <Field label="Reason">
        <select value={reason} onChange={e => setReason(e.target.value)} style={{...modalInput(), cursor:'pointer'}}>
          <option value="requested_by_customer">Requested by customer</option>
          <option value="duplicate">Duplicate</option>
          <option value="fraudulent">Fraudulent</option>
        </select>
      </Field>

      <Field label="Internal notes (optional)">
        <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} maxLength={500} style={{...modalInput(), resize:'vertical'}}/>
      </Field>

      <ModalButtons>
        <button onClick={onClose} disabled={busy} style={modalBtnSecondary()}>Cancel</button>
        <button onClick={() => onConfirm(mode === 'full' ? null : finalAmount, reason, notes || undefined)}
          disabled={!valid || busy} style={modalBtnPrimary(valid && !busy, T.purple)}>
          {busy ? 'Issuing…' : `Refund $${money(finalAmount)}`}
        </button>
      </ModalButtons>
    </Backdrop>
  )
}

function CancelModal({ order, busy, canRefund, onClose, onConfirm }: { order: OrderDetail; busy: boolean; canRefund: boolean; onClose: () => void; onConfirm: (alsoRefund: boolean, reason: string | undefined, notes: string | undefined) => void }) {
  const remaining = Math.max(0, order.total_inc - Number(order.refunded_total || 0))
  const isPaid    = !!order.paid_at && remaining > 0.005
  const [alsoRefund, setAlsoRefund] = useState(isPaid)
  const [reason, setReason] = useState<string>('requested_by_customer')
  const [notes, setNotes]   = useState<string>('')

  return (
    <Backdrop onClose={onClose}>
      <h2 style={modalTitle()}>Cancel order</h2>
      <p style={modalDesc()}>
        Order <strong style={{color:T.text,fontFamily:'monospace'}}>{order.order_number}</strong> will be marked cancelled.
        {!isPaid && ' Order has not been paid, so no refund is needed.'}
      </p>

      {isPaid && canRefund && (
        <label style={{display:'flex',gap:10,padding:12,borderRadius:6,border:`1px solid ${alsoRefund ? T.purple : T.border2}`,background:alsoRefund ? `${T.purple}10` : 'transparent',cursor:'pointer',marginBottom:14}}>
          <input type="checkbox" checked={alsoRefund} onChange={e => setAlsoRefund(e.target.checked)} style={{marginTop:2}}/>
          <span style={{fontSize:12,color:T.text2,lineHeight:1.5}}>
            Also refund the remaining <strong style={{color:T.text}}>${money(remaining)}</strong> via Stripe.
          </span>
        </label>
      )}

      {isPaid && !canRefund && (
        <div style={{padding:10,borderRadius:6,background:`${T.amber}15`,border:`1px solid ${T.amber}40`,color:T.amber,fontSize:11,marginBottom:14}}>
          ⚠ This order is paid, but you don't have refund permissions. You can cancel without refund (money stays in Stripe), or ask an admin to issue the refund first.
        </div>
      )}

      {alsoRefund && (
        <Field label="Refund reason">
          <select value={reason} onChange={e => setReason(e.target.value)} style={{...modalInput(), cursor:'pointer'}}>
            <option value="requested_by_customer">Requested by customer</option>
            <option value="duplicate">Duplicate</option>
            <option value="fraudulent">Fraudulent</option>
          </select>
        </Field>
      )}

      <Field label="Notes (optional)">
        <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} maxLength={500} style={{...modalInput(), resize:'vertical'}}/>
      </Field>

      <ModalButtons>
        <button onClick={onClose} disabled={busy} style={modalBtnSecondary()}>Don't cancel</button>
        <button onClick={() => onConfirm(alsoRefund, alsoRefund ? reason : undefined, notes || undefined)}
          disabled={busy} style={modalBtnPrimary(!busy, T.red)}>
          {busy ? 'Cancelling…' : alsoRefund ? `Refund & cancel` : 'Cancel order'}
        </button>
      </ModalButtons>
    </Backdrop>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label style={{display:'flex',flexDirection:'column',gap:4,marginBottom:14}}>
      <span style={{fontSize:11,color:T.text2,fontWeight:500}}>{label}</span>
      {children}
      {hint && <span style={{fontSize:10,color:T.text3}}>{hint}</span>}
    </label>
  )
}

function ModalButtons({ children }: { children: React.ReactNode }) {
  return (
    <div style={{display:'flex',gap:8,justifyContent:'flex-end',marginTop:18}}>{children}</div>
  )
}

// ─── Style helpers ─────────────────────────────────────────────────────

function actionBtn(primary: boolean, busy: boolean, color?: string): React.CSSProperties {
  const c = color || T.blue
  return {
    width:'100%',padding:'10px 14px',borderRadius:6,marginBottom:6,
    border:`1px solid ${primary ? c : T.border2}`,
    background: primary && !busy ? c : 'transparent',
    color: primary && !busy ? '#fff' : (color || T.text2),
    fontSize:12,fontWeight: primary ? 600 : 400,
    cursor: busy ? 'wait' : 'pointer',
    fontFamily:'inherit',
    opacity: busy ? 0.6 : 1,
    textAlign:'left' as any,
  }
}

function modalTitle(): React.CSSProperties {
  return { fontSize:16,fontWeight:600,margin:'0 0 6px',color:T.text,letterSpacing:'-0.005em' }
}
function modalDesc(): React.CSSProperties {
  return { fontSize:12,color:T.text3,margin:'0 0 18px',lineHeight:1.5 }
}
function modalInput(): React.CSSProperties {
  return {
    width:'100%',boxSizing:'border-box',
    background:T.bg3,border:`1px solid ${T.border2}`,color:T.text,
    borderRadius:5,padding:'8px 10px',fontSize:13,outline:'none',fontFamily:'inherit',
  }
}
function modalBtnPrimary(enabled: boolean, color: string): React.CSSProperties {
  return {
    padding:'9px 16px',borderRadius:6,
    border:`1px solid ${enabled ? color : T.border2}`,
    background: enabled ? color : T.bg3,
    color: enabled ? '#fff' : T.text3,
    fontSize:12,fontWeight:500,
    cursor: enabled ? 'pointer' : 'not-allowed',
    fontFamily:'inherit',
  }
}
function modalBtnSecondary(): React.CSSProperties {
  return {
    padding:'9px 16px',borderRadius:6,
    border:`1px solid ${T.border2}`,
    background:'transparent',color:T.text2,
    fontSize:12,fontFamily:'inherit',cursor:'pointer',
  }
}
function modeBtn(active: boolean, color: string): React.CSSProperties {
  return {
    flex:1,padding:'8px 12px',borderRadius:5,
    border:`1px solid ${active ? color : T.border2}`,
    background: active ? `${color}20` : 'transparent',
    color: active ? color : T.text2,
    fontSize:12,fontWeight: active ? 600 : 400,
    cursor:'pointer',fontFamily:'inherit',
  }
}
function th(width?: number): React.CSSProperties {
  return {
    fontSize:10,color:T.text3,padding:'9px 12px',
    textAlign:'left',fontWeight:500,
    textTransform:'uppercase',letterSpacing:'0.05em',
    width,whiteSpace:'nowrap',
  }
}
function td(): React.CSSProperties {
  return { padding:'9px 12px',verticalAlign:'middle' }
}

// ─── Utility ───────────────────────────────────────────────────────────

function money(n: number): string {
  return n.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function fullDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString('en-AU', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' })
}

export async function getServerSideProps(context: any) {
  return requirePageAuth(context, 'view:b2b')
}
