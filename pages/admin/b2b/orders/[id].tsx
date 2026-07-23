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
import PortalTopBar from '../../../../lib/PortalTopBar'
import B2BAdminTabs from '../../../../components/b2b/B2BAdminTabs'
import { requirePageAuth } from '../../../../lib/authServer'
import { roleHasPermission, type UserRole } from '../../../../lib/permissions'
import { useIsMobile } from '../../../../lib/useIsMobile'
import { useConfirm, useToast } from '../../../../components/ui/Feedback'

const T = {
  bg:'var(--t-bg)', bg2:'var(--t-bg2)', bg3:'var(--t-bg3)', bg4:'var(--t-bg4)',
  border:'var(--t-border)', border2:'var(--t-border2)',
  text:'var(--t-text)', text2:'var(--t-text2)', text3:'var(--t-text3)',
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
  payment_method: 'card' | 'becs' | 'payto'
  payment_settled_at: string | null
  subtotal_ex_gst: number
  gst: number
  card_fee_inc: number
  total_inc: number
  refunded_total: number
  carrier: string | null
  tracking_number: string | null
  tracking_url: string | null
  freight_method_label: string | null
  freight_cost_ex_gst: number | null
  dropship_freight_ex_gst: number | null
  label_pdf_path: string | null
  // MachShip live freight
  machship_consignment_id: string | null
  machship_consignment_number: string | null
  machship_carrier_id: number | null
  machship_carrier_service_id: number | null
  freight_service_label: string | null
  freight_eta_at: string | null
  freight_status: string | null
  last_freight_poll_at: string | null
  tracking_page_access_token: string | null
  freight_chosen_quote: any | null
  freight_quote_markup_pct: number | null
  freight_pack_mode: string | null
  // Drop-ship
  has_drop_ship: boolean
  dropship_po_raised_at: string | null
  dropship_pos: Array<{ supplier_uid: string; supplier_name: string; myob_po_number: string | null; myob_po_uid: string | null; line_count: number; created_at: string; email_status?: 'sent' | 'no_email' | 'failed'; emailed_to?: string | null }>
  customer_notes: string | null
  internal_notes: string | null
  ship_to: { company: string; name: string; phone: string; email: string; line1: string; line2: string; suburb: string; state: string; postcode: string; source: 'order' | 'distributor' } | null
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
  const isMobile = useIsMobile()
  const confirmDialog = useConfirm()
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

  // Posts to the new ship endpoint that handles freight cost + label upload
  // alongside the carrier/tracking fields. Stamps shipped_at on first call,
  // updates fields in place on later calls.
  const shipOrder = useCallback(async (body: Record<string, any>) => {
    setActionBusy(true); setActionError(null)
    try {
      const r = await fetch(`/api/b2b/admin/orders/${orderId}/ship`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const j = await r.json()
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`)
      flashMsg('Shipping saved')
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
        // A full refund already lands the order in the terminal 'refunded'
        // status — a follow-up cancel transition would just 409.
        flashMsg('Order refunded and closed')
        setCancelModal(false)
        await load()
        return
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

  // ── Delete order (admin only) — permanent; removes lines/events/print jobs.
  const doDelete = useCallback(async () => {
    if (!data) return
    if (!(await confirmDialog({ title: `Permanently delete order ${data.order_number}?`, message: 'This removes it and its lines/events from the portal. Any MYOB invoice is NOT affected — void that in MYOB separately. This cannot be undone.', danger: true }))) return
    setActionBusy(true); setActionError(null)
    try {
      const r = await fetch(`/api/b2b/admin/orders/${orderId}`, { method: 'DELETE', credentials: 'same-origin' })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(j?.error || `Delete failed: HTTP ${r.status}`)
      router.push('/admin/b2b/orders')
    } catch (e: any) {
      setActionError(e?.message || String(e)); setActionBusy(false)
    }
  }, [orderId, data, router, confirmDialog])

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
  // Shipped orders can't be cancelled (goods are gone) — refund instead.
  const canCancel  = data && canEdit && ['pending_payment','paid','picking','packed'].includes(data.status)
  const canDoRefund = data && canRefund && data.paid_at && (Number(data.refunded_total || 0) < Number(data.total_inc || 0) - 0.005)

  return (
    <>
      <Head><title>{data ? `${data.order_number} · Orders` : 'Order · JA Portal'}</title></Head>
      <div style={{display:'flex',flexDirection:'column',minHeight:'100vh',background:T.bg,color:T.text,fontFamily:'system-ui,-apple-system,sans-serif'}}>
        <PortalTopBar
          activeId="b2b"
          currentUserRole={user.role}
          currentUserVisibleTabs={user.visibleTabs}
          currentUserName={user.displayName}
          currentUserEmail={user.email}
        />
        <main style={{flex:1,padding: isMobile ? '16px 14px' : '28px 32px', paddingBottom: isMobile ? 'calc(96px + env(safe-area-inset-bottom))' : undefined, width:'100%', boxSizing:'border-box', overflowX: isMobile ? 'hidden' : undefined}}>
          <B2BAdminTabs active="orders"/>

          <header style={{marginBottom:18}}>
            <div style={{fontSize:12,color:T.text3,textTransform:'uppercase',letterSpacing:'0.08em',marginBottom:4}}>
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
            <div style={{padding:'8px 14px',background:`${T.green}15`,border:`1px solid ${T.green}40`,borderRadius:7,color:T.green,fontSize:13,marginBottom:14}}>
              ✓ {flash}
            </div>
          )}
          {error && (
            <div style={{padding:12,background:`${T.red}15`,border:`1px solid ${T.red}40`,borderRadius:7,color:T.red,fontSize:13,marginBottom:14}}>
              {error}
            </div>
          )}
          {actionError && (
            <div style={{padding:12,background:`${T.red}15`,border:`1px solid ${T.red}40`,borderRadius:7,color:T.red,fontSize:13,marginBottom:14,display:'flex',justifyContent:'space-between',gap:14}}>
              <span>{actionError}</span>
              <button onClick={() => setActionError(null)} style={{background:'transparent',border:'none',color:T.red,cursor:'pointer',fontSize:14}}>×</button>
            </div>
          )}

          {loading && !data && (
            <div style={{padding:40,textAlign:'center',color:T.text3,fontSize:13}}>Loading…</div>
          )}

          {data && (
            <div style={{display:'grid',gridTemplateColumns: isMobile ? '1fr' : '1fr 360px',gap: isMobile ? 14 : 18,alignItems:'start',minWidth:0}}>

              {/* ── LEFT COLUMN ── */}
              <div style={{display:'flex',flexDirection:'column',gap:14,minWidth:0}}>

                {/* Order summary header */}
                <Card title="Summary">
                  <KV label="Distributor"    value={data.distributor?.display_name || '—'}/>
                  <KV label="Customer PO"    value={data.customer_po || '—'} mono/>
                  {(() => {
                    const m = data.payment_method || 'card'
                    const label = m === 'becs' ? 'Bank Direct Debit' : m === 'payto' ? 'PayTo' : 'Card'
                    const settled = !!data.payment_settled_at
                    const state = settled ? 'Settled' : (m === 'becs' ? 'Awaiting settlement' : m === 'payto' ? 'Awaiting confirmation' : 'Unsettled')
                    return <KV label="Payment" value={`${label} · ${state}`} valueColor={settled ? T.green : (m === 'card' ? undefined : T.amber)}/>
                  })()}
                  <KV label="Placed"         value={fullDate(data.placed_at)} mono/>
                  {data.paid_at && <KV label="Paid"      value={fullDate(data.paid_at)}      mono valueColor={T.green}/>}
                  {data.shipped_at && <KV label="Shipped" value={fullDate(data.shipped_at)} mono valueColor={T.teal}/>}
                  {data.cancelled_at && <KV label="Cancelled" value={fullDate(data.cancelled_at)} mono valueColor={T.red}/>}
                </Card>

                {/* Ship to */}
                <Card title="Ship to">
                  {data.ship_to ? (
                    <div style={{fontSize:13,color:T.text2,lineHeight:1.6}}>
                      {data.ship_to.name && <div style={{color:T.text}}>{data.ship_to.name}</div>}
                      {data.ship_to.company && data.ship_to.company !== data.ship_to.name && <div>{data.ship_to.company}</div>}
                      {data.ship_to.line1 && <div>{data.ship_to.line1}</div>}
                      {data.ship_to.line2 && <div>{data.ship_to.line2}</div>}
                      {(data.ship_to.suburb || data.ship_to.state || data.ship_to.postcode) && (
                        <div>{[data.ship_to.suburb, data.ship_to.state, data.ship_to.postcode].filter(Boolean).join(' ')}</div>
                      )}
                      {data.ship_to.phone && <div style={{color:T.text3,fontSize:12,marginTop:4}}>☎ {data.ship_to.phone}</div>}
                      {data.ship_to.email && <div style={{color:T.text3,fontSize:12}}>✉ {data.ship_to.email}</div>}
                      {data.ship_to.source === 'distributor' && (
                        <div style={{fontSize:10,color:T.text3,marginTop:6,fontStyle:'italic'}}>From the distributor's ship address (no per-order delivery address on file).</div>
                      )}
                    </div>
                  ) : (
                    <div style={{fontSize:12,color:T.amber}}>No delivery address — add a ship address to the distributor before booking freight.</div>
                  )}
                </Card>

                {/* Lines */}
                <Card title={`Items (${data.lines.length})`}>
                  <div style={{overflowX:'auto',margin:'0 -22px',padding:'0 22px'}}>
                    <table style={{width:'100%',borderCollapse:'collapse',fontSize:13}}>
                      <thead>
                        <tr style={{borderBottom:`1px solid ${T.border}`}}>
                          <th style={th(140)}>SKU</th>
                          <th style={th()}>Item</th>
                          <th style={{...th(50),textAlign:'right'}}>Qty</th>
                          <th style={{...th(110),textAlign:'right'}}>Unit (inc GST)</th>
                          <th style={{...th(110),textAlign:'right'}}>Line (inc GST)</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.lines.map((ln, i) => (
                          <tr key={ln.id} style={{borderTop: i > 0 ? `1px solid ${T.border}` : 'none'}}>
                            <td style={td()}><span style={{fontFamily:'monospace',fontSize:12,color:T.text2}}>{ln.sku}</span></td>
                            <td style={td()}>{ln.name}</td>
                            <td style={{...td(),textAlign:'right',fontVariantNumeric:'tabular-nums'}}>{ln.qty}</td>
                            <td style={{...td(),textAlign:'right',fontVariantNumeric:'tabular-nums',fontFamily:'monospace'}}>${money(incGstAmt(ln.unit_trade_price_ex_gst, ln.is_taxable))}</td>
                            <td style={{...td(),textAlign:'right',fontVariantNumeric:'tabular-nums',fontFamily:'monospace'}}>${money(ln.line_total_inc)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Card>

                {/* Totals — the stored subtotal_ex_gst includes freight, so break
                    freight out as its own line and show items-only above it. */}
                <Card title="Totals">
                  {(() => {
                    const itemsInc = data.lines.reduce((s, l) => s + (Number(l.line_total_inc) || 0), 0)
                    const freightInc = data.freight_cost_ex_gst != null ? round2x(data.freight_cost_ex_gst * 1.10) : 0
                    return (
                      <>
                        <Row label="Items (inc GST)" value={`$${money(itemsInc)}`}/>
                        {freightInc > 0 && (
                          <Row label={`Freight (inc GST)${data.freight_service_label || data.freight_method_label ? ` — ${data.freight_service_label || data.freight_method_label}` : ''}`} value={`$${money(freightInc)}`}/>
                        )}
                      </>
                    )
                  })()}
                  <Row label="Card surcharge"     value={`$${money(data.card_fee_inc)}`} muted/>
                  <Row label="Total (inc GST)"    value={`$${money(data.total_inc)}`} bold/>
                  <Row label="(includes GST)"     value={`$${money(data.gst)}`} muted/>
                  {Number(data.refunded_total || 0) > 0 && (
                    <Row label={`Refunded${Number(data.refunded_total) >= data.total_inc - 0.005 ? ' (full)' : ' (partial)'}`}
                         value={`-$${money(Number(data.refunded_total))}`} valueColor={T.purple}/>
                  )}
                </Card>

                {/* Stripe + MYOB info */}
                <div style={{display:'grid',gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr',gap:14,minWidth:0}}>
                  <Card title="Stripe">
                    <KV label="Status" value={data.paid_at ? 'Paid' : 'Pending'} valueColor={data.paid_at ? T.green : T.amber}/>
                    <KV label="Payment Intent" value={data.stripe.payment_intent_id || '—'} mono small/>
                    <KV label="Session ID"     value={data.stripe.checkout_session_id || '—'} mono small/>
                    {data.stripe.payment_intent_id && (
                      <div style={{marginTop:8}}>
                        <a href={`https://dashboard.stripe.com/payments/${data.stripe.payment_intent_id}`}
                          target="_blank" rel="noopener noreferrer"
                          style={{fontSize:12,color:T.blue,textDecoration:'none'}}>
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
                      <div style={{marginTop:8,padding:8,background:`${T.red}15`,border:`1px solid ${T.red}40`,borderRadius:5,color:T.red,fontSize:12}}>
                        ⚠ {data.myob.write_error}
                        <div style={{marginTop:8}}>
                          <button
                            disabled={actionBusy}
                            onClick={async () => {
                              setActionBusy(true); setActionError(null)
                              try {
                                const r = await fetch(`/api/b2b/admin/orders/${orderId}/retry-myob`, { method: 'POST', credentials: 'same-origin' })
                                const j = await r.json()
                                if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`)
                                flashMsg(j.myob_write_error ? 'Retry ran — MYOB failed again, see error' : 'MYOB write retried successfully')
                                await load()
                              } catch (e: any) { setActionError(e?.message || String(e)) }
                              finally { setActionBusy(false) }
                            }}
                            style={{padding:'6px 12px',borderRadius:5,border:`1px solid ${T.red}60`,background:'transparent',color:T.red,fontSize:12,cursor:'pointer'}}>
                            {actionBusy ? 'Retrying…' : '↻ Retry MYOB write'}
                          </button>
                        </div>
                      </div>
                    )}
                  </Card>
                </div>

                {/* Refund history */}
                {data.refunds.length > 0 && (
                  <Card title={`Refunds (${data.refunds.length})`}>
                    {data.refunds.map(rf => (
                      <div key={rf.id} style={{display:'flex',justifyContent:'space-between',gap:14,padding:'8px 0',borderTop:`1px solid ${T.border}`,fontSize:13}}>
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
                    <p style={{margin:0,whiteSpace:'pre-wrap',fontSize:13,color:T.text2,lineHeight:1.5}}>{data.customer_notes}</p>
                  </Card>
                )}

              </div>

              {/* ── RIGHT COLUMN ── */}
              <div style={{display:'flex',flexDirection:'column',gap:14,position: isMobile ? 'static' : 'sticky',top:18,minWidth:0}}>

                {/* Status timeline */}
                <Card title="Timeline">
                  <Timeline events={data.events}/>
                </Card>

                {/* Action buttons */}
                {canEdit && (
                  <Card title="Actions">
                    {allowedTransitions.length === 0 && !canCancel && !canDoRefund && (
                      <div style={{fontSize:12,color:T.text3}}>No actions available for this status.</div>
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

                    {canRefund && (
                      <button
                        disabled={actionBusy}
                        onClick={doDelete}
                        title="Permanently delete this order from the portal"
                        style={{ ...actionBtn(false, actionBusy, T.red), marginTop: 6, borderTop: `1px solid ${T.border}` }}>
                        🗑 Delete order
                      </button>
                    )}
                  </Card>
                )}

                {/* Shipping panel — always shown for staff so they can book / edit */}
                {canEdit && (
                  <ShippingCard
                    order={data}
                    onEdit={() => setShipModal(true)}
                    onReloaded={() => { void load() }}
                    onFlash={flashMsg}
                  />
                )}

                {/* Drop-ship purchase orders */}
                {canEdit && data.has_drop_ship && (
                  <DropShipCard order={data} onReloaded={() => { void load() }} onFlash={flashMsg}/>
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
                        borderRadius:5,padding:'8px 10px',fontSize:13,outline:'none',
                        resize:'vertical',fontFamily:'inherit',
                      }}/>
                    <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:10,marginTop:6}}>
                      <span style={{fontSize:10,color: notesError ? T.red : T.text3}}>
                        {notesError || (notesBusy ? 'Saving…' : notesDraft !== (data.internal_notes || '') ? 'Unsaved changes' : 'Saved')}
                      </span>
                      <button onClick={saveNotes} disabled={notesBusy || notesDraft === (data.internal_notes || '')}
                        style={{padding:'6px 14px',borderRadius:6,border:`1px solid ${notesDraft !== (data.internal_notes || '') ? T.blue : T.border2}`,background: notesDraft !== (data.internal_notes || '') && !notesBusy ? T.blue : 'transparent',color: notesDraft !== (data.internal_notes || '') && !notesBusy ? '#fff' : T.text3,fontSize:12,fontWeight:600,fontFamily:'inherit',cursor: notesBusy || notesDraft === (data.internal_notes || '') ? 'default' : 'pointer'}}>
                        {notesBusy ? 'Saving…' : 'Save notes'}
                      </button>
                    </div>
                  </Card>
                )}

              </div>
            </div>
          )}

        </main>
      </div>

      {/* ── Modals ── */}
      {data && shipModal   && <ShipModal   order={data} busy={actionBusy} onClose={() => setShipModal(false)}   onConfirm={(body) => { setShipModal(false); shipOrder(body) }}/>}
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
    <div style={{display:'flex',justifyContent:'space-between',gap:14,padding:'5px 0',fontSize:13,borderBottom:`1px solid ${T.border}`}}>
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
      fontSize:12,fontWeight:600,textTransform:'uppercase',letterSpacing:'0.05em',
    }}>
      <span style={{display:'inline-block',width:7,height:7,borderRadius:'50%',background:color}}/>
      {label}
    </span>
  )
}

function Timeline({ events }: { events: OrderEvent[] }) {
  if (events.length === 0) return <div style={{fontSize:12,color:T.text3}}>No events yet.</div>
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
          <div key={ev.id} style={{display:'flex',gap:10,fontSize:12}}>
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
                <div style={{color:T.text2,fontSize:12,marginTop:3,fontStyle:'italic',lineHeight:1.4}}>{ev.notes}</div>
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
        padding:20, width:'calc(100vw - 24px)', maxWidth:500, boxSizing:'border-box',
        maxHeight:'calc(100vh - 32px)', overflowY:'auto', zIndex:1001,
        boxShadow:'0 20px 50px rgba(0,0,0,0.5)',
      }}>
        {children}
      </div>
    </>
  )
}

// Always-visible shipping panel — surfaces whatever's been set + a "Book
// freight / edit" button. Once the order is shipped the panel also offers
// "Print label" (signed-URL fetch) and a tracking link.
//
// When the order was placed on a live MachShip quote (machship_carrier_id
// populated), the panel also shows:
//   - "Book via MachShip" — calls /book-freight which creates the
//     consignment, pulls the label, stores tracking + ETA on the order.
//   - "Refresh from MachShip" — calls /refresh-freight to re-fetch the
//     current status + ETA. The 30-min cron does this automatically;
//     the button is for when admin wants it RIGHT NOW.
function ShippingCard({ order, onEdit, onReloaded, onFlash }: {
  order: OrderDetail
  onEdit: () => void
  onReloaded: () => void
  onFlash: (msg: string) => void
}) {
  const isMobile        = useIsMobile()
  const toast           = useToast()
  const confirmDialog   = useConfirm()
  const isShipped       = !!order.shipped_at
  const hasLiveQuote    = !!order.machship_carrier_id && !!order.machship_carrier_service_id
  const hasConsignment  = !!order.machship_consignment_id
  const [bookingBusy,  setBookingBusy]  = useState(false)
  const [refreshBusy,  setRefreshBusy]  = useState(false)
  const [actionError,  setActionError]  = useState<string | null>(null)
  const [dispatchAt,   setDispatchAt]   = useState('')   // datetime-local; blank = collect ASAP
  const [packMode,     setPackMode]     = useState<string>(order.freight_pack_mode || 'auto')
  const [laterOpen,    setLaterOpen]    = useState(false) // mobile "book later" sheet
  const [laterTime,    setLaterTime]    = useState('')

  async function openLabel() {
    try {
      const r = await fetch(`/api/b2b/admin/orders/${order.id}/label`)
      const j = await r.json()
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`)
      window.open(j.url, '_blank', 'noopener,noreferrer')
    } catch (e: any) {
      toast(`Could not open label: ${e?.message || e}`, 'error')
    }
  }

  async function bookViaMachShip(force = false, dispatchOverride?: string | null) {
    if (bookingBusy) return
    if (hasConsignment && !force && !(await confirmDialog({ title: 'A consignment is already booked. Re-book?' }))) return
    // dispatchOverride: '' = collect ASAP (now), a value = scheduled (later);
    // undefined = use whatever's in the inline picker.
    const dispatch = dispatchOverride !== undefined ? dispatchOverride : dispatchAt
    setBookingBusy(true); setActionError(null)
    try {
      const r = await fetch(`/api/b2b/admin/orders/${order.id}/book-freight${force ? '?force=1' : ''}`, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(dispatch ? { dispatch_at: new Date(dispatch).toISOString() } : {}),
          pack_mode: packMode || 'auto',
        }),
      })
      const j = await r.json()
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`)
      if (j.label_warning) onFlash(`Booked, but label fetch warning: ${j.label_warning}`)
      else                 onFlash(`Booked: ${j.consignment_number || j.consignment_id}`)
      onReloaded()
    } catch (e: any) {
      setActionError(e?.message || String(e))
    } finally {
      setBookingBusy(false)
    }
  }

  async function refreshFromMachShip() {
    if (refreshBusy) return
    setRefreshBusy(true); setActionError(null)
    try {
      const r = await fetch(`/api/b2b/admin/orders/${order.id}/refresh-freight`, {
        method: 'POST', credentials: 'same-origin',
      })
      const j = await r.json()
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`)
      onFlash(`Refreshed — status: ${j.order?.freight_status || 'unknown'}`)
      onReloaded()
    } catch (e: any) {
      setActionError(e?.message || String(e))
    } finally {
      setRefreshBusy(false)
    }
  }

  // Tracking URL preference: MachShip's hosted tracking page if we
  // have an access token, otherwise whatever was manually set.
  const machshipTrackingUrl = order.tracking_page_access_token
    ? `https://live.machship.com/track/${encodeURIComponent(order.tracking_page_access_token)}`
    : null
  const effectiveTrackingUrl = machshipTrackingUrl || order.tracking_url

  return (
    <Card title="Shipping">
      {(() => {
        const mb = (extra: React.CSSProperties = {}): React.CSSProperties => ({
          borderRadius: 6, fontFamily: 'inherit', cursor: 'pointer', fontWeight: 600,
          ...(isMobile ? { width: '100%', padding: '11px 14px', fontSize: 13, minHeight: 44 } : { padding: '5px 12px', fontSize: 11 }),
          ...extra,
        })
        return (
          <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap', flexDirection: isMobile ? 'column' : 'row', alignItems: isMobile ? 'stretch' : 'center' }}>
            <div style={{ display: 'flex', alignItems: 'center' }}>
              {isShipped ? (
                <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 3, background: `${T.teal}20`, color: T.teal, border: `1px solid ${T.teal}40` }}>
                  ✓ Shipped {order.shipped_at ? fullDate(order.shipped_at) : ''}
                </span>
              ) : (
                <span style={{ fontSize: 11, color: T.text3 }}>Not shipped yet</span>
              )}
            </div>
            {!isMobile && <span style={{ flex: 1 }}/>}
            {hasLiveQuote && !hasConsignment && (
              <button onClick={() => bookViaMachShip(false)} disabled={bookingBusy}
                style={mb({ border: `1px solid ${T.teal}60`, background: `${T.teal}15`, color: T.teal, cursor: bookingBusy ? 'wait' : 'pointer' })}>
                {bookingBusy ? 'Booking…' : '⚡ Book via MachShip'}
              </button>
            )}
            {hasConsignment && (
              <button onClick={refreshFromMachShip} disabled={refreshBusy}
                style={mb({ border: `1px solid ${T.border2}`, background: 'transparent', color: T.blue, fontWeight: 500, cursor: refreshBusy ? 'wait' : 'pointer' })}>
                {refreshBusy ? 'Refreshing…' : '↻ Refresh from MachShip'}
              </button>
            )}
            <button onClick={onEdit} style={mb({ border: `1px solid ${T.border2}`, background: 'transparent', color: T.blue, fontWeight: 500 })}>
              {isShipped ? 'Edit shipping' : '+ Manual book'}
            </button>
            {order.label_pdf_path && (
              <button onClick={openLabel} style={mb({ border: `1px solid ${T.teal}40`, background: 'transparent', color: T.teal, fontWeight: 500 })}>
                🖨 Print label
              </button>
            )}
          </div>
        )
      })()}

      {/* Pack mode — override the cartonizer for this order before booking. */}
      {hasLiveQuote && !hasConsignment && (
        <div style={{display:'flex', alignItems:'center', gap:8, marginBottom:10, flexWrap:'wrap'}}>
          <span style={{fontSize:11, color:T.text3, whiteSpace:'nowrap'}}>Pack as</span>
          <select value={packMode} onChange={e => setPackMode(e.target.value)}
            style={{flex: isMobile ? 1 : undefined, minWidth: isMobile ? 0 : undefined, background:T.bg3, border:`1px solid ${T.border2}`, color:T.text, borderRadius:5, padding: isMobile ? '9px 10px' : '5px 8px', fontSize: isMobile ? 16 : 12, outline:'none', fontFamily:'inherit'}}>
            <option value="auto">Auto (weight/volume)</option>
            <option value="cartons">Cartons</option>
            <option value="pallet">Pallet</option>
          </select>
          {!isMobile && <span style={{fontSize:10, color:T.text3}}>used when you book below</span>}
        </div>
      )}

      {/* Collection time — optional. Blank = collect ASAP; a future time sets
          MachShip's desired despatch so the carrier collects then. */}
      {hasLiveQuote && !hasConsignment && (
        <div style={{display:'flex', alignItems:'center', gap:8, marginBottom:10, flexWrap:'wrap'}}>
          <span style={{fontSize:11, color:T.text3, whiteSpace:'nowrap'}}>Collection time</span>
          <input
            type="datetime-local"
            value={dispatchAt}
            min={localNow()}
            onChange={e => setDispatchAt(e.target.value)}
            style={{flex:1, minWidth: isMobile ? 0 : 160, background:T.bg3, border:`1px solid ${T.border2}`, color:T.text, borderRadius:5, padding: isMobile ? '9px 10px' : '5px 8px', fontSize: isMobile ? 16 : 12, outline:'none', fontFamily:'inherit', colorScheme:'dark'}}
          />
          {dispatchAt
            ? <button onClick={() => setDispatchAt('')} style={{background:'none', border:'none', color:T.text3, fontSize:11, cursor:'pointer', fontFamily:'inherit'}}>clear (ASAP)</button>
            : <span style={{fontSize:10, color:T.text3}}>blank = ASAP</span>}
        </div>
      )}

      {actionError && (
        <div style={{fontSize:11, color:T.red, marginBottom:10, lineHeight:1.5}}>{actionError}</div>
      )}

      <KV label="Method"   value={order.freight_service_label || order.freight_method_label || '—'}/>
      <KV label="Carrier"  value={order.carrier || '—'}/>
      <KV label="Tracking" value={order.tracking_number || '—'} mono/>
      {effectiveTrackingUrl && order.tracking_number && (
        <div style={{display:'grid', gridTemplateColumns:'90px 1fr', gap:'4px 12px', alignItems:'baseline'}}>
          <span style={{fontSize:11, color:T.text3}}>Track</span>
          <a href={effectiveTrackingUrl} target="_blank" rel="noopener noreferrer" style={{color:T.blue, fontSize:13, textDecoration:'none'}}>Open tracking page →</a>
        </div>
      )}
      <KV label="Cost ex"  value={order.freight_cost_ex_gst != null ? `$${money(order.freight_cost_ex_gst)}` : '—'} mono/>
      {order.dropship_freight_ex_gst != null && order.dropship_freight_ex_gst > 0 && (
        <KV label="  incl. drop-ship" value={`$${money(order.dropship_freight_ex_gst)}`} mono/>
      )}

      {hasConsignment && (
        <div style={{marginTop:10, paddingTop:10, borderTop:`1px dashed ${T.border}`}}>
          <KV label="Consignment" value={order.machship_consignment_number || order.machship_consignment_id || '—'} mono/>
          <KV label="Status"      value={prettyFreightStatus(order.freight_status)}/>
          <KV label="ETA"         value={order.freight_eta_at ? fullDate(order.freight_eta_at) : '—'}/>
          <KV label="Last poll"   value={order.last_freight_poll_at ? fullDate(order.last_freight_poll_at) : 'never'}/>
        </div>
      )}

      {/* Native-style pinned primary action on mobile: Book now (ASAP) or
          Later (pick a collection time). Lifted clear of the bottom edge. */}
      {isMobile && hasLiveQuote && !hasConsignment && !isShipped && (
        <div style={{
          position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 60,
          background: T.bg2, borderTop: `1px solid ${T.border2}`,
          padding: `12px 14px calc(22px + env(safe-area-inset-bottom))`,
          boxShadow: '0 -4px 16px rgba(0,0,0,0.4)', display: 'flex', gap: 10,
        }}>
          <button onClick={() => bookViaMachShip(false, '')} disabled={bookingBusy}
            style={{ flex: 2, minHeight: 50, borderRadius: 12, border: 'none', background: bookingBusy ? T.bg4 : T.teal, color: bookingBusy ? T.text3 : '#08110d', fontWeight: 700, fontSize: 15.5, cursor: bookingBusy ? 'wait' : 'pointer', fontFamily: 'inherit' }}>
            {bookingBusy ? 'Booking…' : '⚡ Book now'}
          </button>
          <button onClick={() => { setLaterTime(''); setLaterOpen(true) }} disabled={bookingBusy}
            style={{ flex: 1, minHeight: 50, borderRadius: 12, border: `1px solid ${T.border2}`, background: 'transparent', color: T.text, fontWeight: 600, fontSize: 14, cursor: 'pointer', fontFamily: 'inherit' }}>
            Later…
          </button>
        </div>
      )}

      {/* "Book later" bottom sheet — pick the collection time. */}
      {isMobile && laterOpen && (
        <>
          <div onClick={() => setLaterOpen(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000 }}/>
          <div style={{
            position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 1001,
            background: T.bg2, borderTop: `1px solid ${T.border2}`, borderRadius: '14px 14px 0 0',
            padding: `18px 16px calc(18px + env(safe-area-inset-bottom))`, boxShadow: '0 -10px 40px rgba(0,0,0,0.5)',
          }}>
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>Schedule collection</div>
            <div style={{ fontSize: 12, color: T.text3, marginBottom: 14 }}>Books the consignment now; the carrier collects at the time you choose.</div>
            <label style={{ fontSize: 11, color: T.text3, display: 'block', marginBottom: 4 }}>Collection time</label>
            <input type="datetime-local" value={laterTime} min={localNow()} onChange={e => setLaterTime(e.target.value)}
              style={{ width: '100%', boxSizing: 'border-box', background: T.bg3, border: `1px solid ${T.border2}`, color: T.text, borderRadius: 8, padding: '11px 12px', fontSize: 16, outline: 'none', fontFamily: 'inherit', colorScheme: 'dark', marginBottom: 12 }}/>
            <label style={{ fontSize: 11, color: T.text3, display: 'block', marginBottom: 4 }}>Pack as</label>
            <select value={packMode} onChange={e => setPackMode(e.target.value)}
              style={{ width: '100%', boxSizing: 'border-box', background: T.bg3, border: `1px solid ${T.border2}`, color: T.text, borderRadius: 8, padding: '11px 12px', fontSize: 16, outline: 'none', fontFamily: 'inherit', marginBottom: 16 }}>
              <option value="auto">Auto (weight/volume)</option>
              <option value="cartons">Cartons</option>
              <option value="pallet">Pallet</option>
            </select>
            <button disabled={!laterTime || bookingBusy} onClick={() => { setLaterOpen(false); bookViaMachShip(false, laterTime) }}
              style={{ width: '100%', minHeight: 50, borderRadius: 12, border: 'none', background: (!laterTime || bookingBusy) ? T.bg4 : T.teal, color: (!laterTime || bookingBusy) ? T.text3 : '#08110d', fontWeight: 700, fontSize: 15.5, cursor: (!laterTime || bookingBusy) ? 'not-allowed' : 'pointer', fontFamily: 'inherit', marginBottom: 8 }}>
              Book for this time
            </button>
            <button onClick={() => setLaterOpen(false)} style={{ width: '100%', background: 'none', border: 'none', color: T.text3, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit', padding: 6 }}>Cancel</button>
          </div>
        </>
      )}
    </Card>
  )
}

function prettyFreightStatus(status: string | null): string {
  if (!status) return '—'
  return status.replace(/_/g, ' ').replace(/\b\w/g, ch => ch.toUpperCase())
}

// Raise + show drop-ship purchase orders. Shown only when the order has
// drop-ship line items (see has_drop_ship from the detail API).
function DropShipCard({ order, onReloaded, onFlash }: {
  order: OrderDetail
  onReloaded: () => void
  onFlash: (msg: string) => void
}) {
  const confirmDialog = useConfirm()
  const [busy, setBusy] = useState(false)
  const [resendingUid, setResendingUid] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const raised = order.dropship_pos || []
  const alreadyRaised = raised.length > 0

  async function raise(force = false) {
    if (busy) return
    if (alreadyRaised && !force && !(await confirmDialog({ title: 'Drop-ship POs were already raised for this order. Raise again?' }))) return
    setBusy(true); setErr(null)
    try {
      const r = await fetch(`/api/b2b/admin/orders/${order.id}/dropship-po${force ? '?force=1' : ''}`, {
        method: 'POST', credentials: 'same-origin',
      })
      const j = await r.json()
      if (!r.ok) {
        const detail = Array.isArray(j.details) ? ` — ${j.details.join(', ')}` : ''
        throw new Error((j.error || `HTTP ${r.status}`) + detail)
      }
      const n = (j.raised || []).length
      if (j.failures?.length) onFlash(`Raised ${n} PO(s); ${j.failures.length} failed`)
      else                    onFlash(`Raised ${n} purchase order${n === 1 ? '' : 's'}`)
      onReloaded()
    } catch (e: any) {
      setErr(e?.message || String(e))
    } finally {
      setBusy(false)
    }
  }

  async function resend(supplierUid: string) {
    if (resendingUid) return
    setResendingUid(supplierUid); setErr(null)
    try {
      const r = await fetch(`/api/b2b/admin/orders/${order.id}/dropship-po`, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resend_supplier_uid: supplierUid }),
      })
      const j = await r.json()
      if (j.email_status === 'sent') onFlash(`Emailed ${j.emailed_to}`)
      else if (j.email_status === 'no_email') onFlash('Supplier has no email on file')
      else throw new Error(j.error || `HTTP ${r.status}`)
      onReloaded()
    } catch (e: any) {
      setErr(e?.message || String(e))
    } finally {
      setResendingUid(null)
    }
  }

  return (
    <Card title="Drop-ship purchase orders">
      <div style={{fontSize:12, color:T.text3, lineHeight:1.5, marginBottom:10}}>
        This order has drop-ship items. Raising a PO creates one MYOB purchase order per supplier, shipped direct to the distributor.
      </div>
      {err && <div style={{fontSize:11, color:T.red, marginBottom:10}}>{err}</div>}
      {raised.length > 0 ? (
        <div style={{display:'flex', flexDirection:'column', gap:6, marginBottom:10}}>
          {raised.map((po, i) => (
            <div key={i} style={{display:'flex', alignItems:'center', gap:8, fontSize:12, flexWrap:'wrap'}}>
              <span style={{color:T.text}}>{po.supplier_name}</span>
              <span style={{flex:1}}/>
              <span style={{fontFamily:'monospace', color:T.text2}}>{po.myob_po_number || po.myob_po_uid?.slice(0, 8) || 'PO'}</span>
              <span style={{color:T.text3}}>{po.line_count} line{po.line_count === 1 ? '' : 's'}</span>
              {po.email_status === 'sent'    && <span title={po.emailed_to || ''} style={{color:T.green}}>✉ emailed</span>}
              {po.email_status === 'no_email'&& <span title="No email on the MYOB supplier card" style={{color:T.amber}}>no email</span>}
              {po.email_status === 'failed'  && <span style={{color:T.red}}>✉ failed</span>}
              <button
                onClick={() => resend(po.supplier_uid)}
                disabled={resendingUid === po.supplier_uid}
                title="Re-send the PO email to this supplier"
                style={{background:'none', border:`1px solid ${T.border2}`, color:T.text2, borderRadius:5, padding:'2px 8px', fontSize:10.5, cursor: resendingUid === po.supplier_uid ? 'wait' : 'pointer', fontFamily:'inherit'}}>
                {resendingUid === po.supplier_uid ? 'Sending…' : '↻ Re-send'}
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div style={{fontSize:12, color:T.text3, marginBottom:10}}>No POs raised yet.</div>
      )}
      <button
        onClick={() => raise(alreadyRaised)}
        disabled={busy}
        style={{padding:'6px 12px', borderRadius:5, border:`1px solid ${T.teal}60`, background:`${T.teal}15`, color:T.teal, fontSize:11, cursor: busy ? 'wait' : 'pointer', fontFamily:'inherit', fontWeight:600}}>
        {busy ? 'Raising…' : alreadyRaised ? '↻ Re-raise drop-ship PO' : '⚡ Raise drop-ship PO'}
      </button>
    </Card>
  )
}

function ShipModal({ order, busy, onClose, onConfirm }: {
  order: OrderDetail
  busy: boolean
  onClose: () => void
  onConfirm: (body: {
    carrier: string
    tracking_number: string
    tracking_url?: string
    freight_cost_ex_gst?: number
    label_pdf_base64?: string
    label_filename?: string
  }) => void
}) {
  const [carrier, setCarrier]   = useState(order.carrier || '')
  const [tracking, setTracking] = useState(order.tracking_number || '')
  const [trackingUrl, setTrackingUrl] = useState(order.tracking_url || '')
  const [cost, setCost] = useState(order.freight_cost_ex_gst != null ? String(order.freight_cost_ex_gst) : '')
  const [labelB64, setLabelB64] = useState<string>('')
  const [labelName, setLabelName] = useState<string>('')
  const [labelErr, setLabelErr] = useState<string>('')
  const ok = carrier.trim().length > 0 && tracking.trim().length > 0

  function onLabelPick(file: File | null) {
    setLabelErr('')
    if (!file) { setLabelB64(''); setLabelName(''); return }
    if (file.size > 10 * 1024 * 1024) { setLabelErr('File too large (max 10MB)'); return }
    setLabelName(file.name)
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result || '')
      // strip data URL prefix
      const b64 = result.replace(/^data:[^,]+;base64,/, '')
      setLabelB64(b64)
    }
    reader.onerror = () => setLabelErr('Could not read file')
    reader.readAsDataURL(file)
  }

  return (
    <Backdrop onClose={onClose}>
      <h2 style={modalTitle()}>{order.shipped_at ? 'Edit shipping' : 'Book freight / mark as shipped'}</h2>
      <p style={modalDesc()}>
        Carrier + tracking are required. Freight cost and label PDF are optional but recommended — the cost is recorded on the order and the label is stored so you can re-print later.
      </p>

      <Field label="Carrier" hint="e.g. InXpress (DHL/Couriers Please/Aramex), StarTrack, TNT">
        <input type="text" value={carrier} onChange={e => setCarrier(e.target.value)} maxLength={80} style={modalInput()}/>
      </Field>
      <Field label="Tracking number">
        <input type="text" value={tracking} onChange={e => setTracking(e.target.value)} maxLength={120} style={modalInput()}/>
      </Field>
      <Field label="Tracking URL (optional)" hint="Direct link to the carrier's tracking page for this consignment">
        <input type="url" value={trackingUrl} onChange={e => setTrackingUrl(e.target.value)} maxLength={500} style={modalInput()} placeholder="https://..."/>
      </Field>
      <Field label="Freight cost ex GST (optional)" hint="What you paid the carrier — surfaces on the order page">
        <input type="number" value={cost} onChange={e => setCost(e.target.value)} step="0.01" min="0" style={modalInput()}/>
      </Field>
      <Field label="Shipping label (optional)" hint="PDF or image — saved to the order so it can be re-printed">
        <div style={{display:'flex', alignItems:'center', gap:8}}>
          <input type="file" accept="application/pdf,image/png,image/jpeg" onChange={e => onLabelPick(e.target.files?.[0] || null)}
            style={{flex:1, fontSize:12, color:T.text2}}/>
          {labelName && <span style={{fontSize:11, color:T.text3}}>{labelName}</span>}
        </div>
        {labelErr && <div style={{marginTop:4, fontSize:11, color:T.red}}>{labelErr}</div>}
        {order.label_pdf_path && !labelB64 && (
          <div style={{marginTop:4, fontSize:11, color:T.text3}}>A label is already attached. Pick a new file to replace it.</div>
        )}
      </Field>

      <ModalButtons>
        <button onClick={onClose} disabled={busy} style={modalBtnSecondary()}>Cancel</button>
        <button
          onClick={() => onConfirm({
            carrier: carrier.trim(),
            tracking_number: tracking.trim(),
            tracking_url: trackingUrl.trim() || undefined,
            freight_cost_ex_gst: cost ? Number(cost) : undefined,
            label_pdf_base64: labelB64 || undefined,
            label_filename: labelName || undefined,
          })}
          disabled={!ok || busy} style={modalBtnPrimary(ok && !busy, T.teal)}>
          {busy ? 'Saving…' : order.shipped_at ? 'Save shipping' : 'Mark as shipped'}
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
          <span style={{fontSize:13,color:T.text2,lineHeight:1.5}}>
            Also refund the remaining <strong style={{color:T.text}}>${money(remaining)}</strong> via Stripe.
          </span>
        </label>
      )}

      {isPaid && !canRefund && (
        <div style={{padding:10,borderRadius:6,background:`${T.amber}15`,border:`1px solid ${T.amber}40`,color:T.amber,fontSize:12,marginBottom:14}}>
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
      <span style={{fontSize:12,color:T.text2,fontWeight:500}}>{label}</span>
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
    fontSize:13,fontWeight: primary ? 600 : 400,
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
  return { fontSize:13,color:T.text3,margin:'0 0 18px',lineHeight:1.5 }
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
    fontSize:13,fontWeight:500,
    cursor: enabled ? 'pointer' : 'not-allowed',
    fontFamily:'inherit',
  }
}
function modalBtnSecondary(): React.CSSProperties {
  return {
    padding:'9px 16px',borderRadius:6,
    border:`1px solid ${T.border2}`,
    background:'transparent',color:T.text2,
    fontSize:13,fontFamily:'inherit',cursor:'pointer',
  }
}
function modeBtn(active: boolean, color: string): React.CSSProperties {
  return {
    flex:1,padding:'8px 12px',borderRadius:5,
    border:`1px solid ${active ? color : T.border2}`,
    background: active ? `${color}20` : 'transparent',
    color: active ? color : T.text2,
    fontSize:13,fontWeight: active ? 600 : 400,
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
function round2x(n: number): number { return Math.round(n * 100) / 100 }
// GST-inclusive amount (taxable +10%, FRE as-is).
function incGstAmt(ex: number, taxable: boolean): number { return taxable ? round2x(ex * 1.10) : ex }

function fullDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString('en-AU', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' })
}
// Local "YYYY-MM-DDTHH:mm" a few minutes out, for a datetime-local min.
function localNow(): string {
  const d = new Date(Date.now() + 5 * 60 * 1000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

export async function getServerSideProps(context: any) {
  return requirePageAuth(context, 'view:b2b')
}
