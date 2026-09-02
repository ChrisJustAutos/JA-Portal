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
import { T, alpha } from '../../../../lib/ui/theme'
import { A, RADIUS, SHADOW, cardStyle, Banner, StatusPill as Pill, orderStatusColor, orderStatusLabel } from '../../../../components/b2b/ui'
import { awaitingDespatch as awaitingDespatchFor, isManifested as isManifestedFor } from '../../../../lib/b2b-despatch-state'

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
  refunded_qty: number
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
  machship_manifest_id: string | null
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
  dropship_pos: Array<{ supplier_uid: string; supplier_name: string; myob_po_number: string | null; myob_po_uid: string | null; line_count: number; created_at: string; email_status?: 'sent' | 'no_email' | 'failed'; emailed_to?: string | null; myob_bill_uid?: string | null; myob_bill_number?: string | null; billed_at?: string | null }>
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
    invoice_uid: string | null
    invoice_number: string | null
    payment_uid: string | null
    payment_at: string | null
  }
  lines: OrderLine[]
  events: OrderEvent[]
  refunds: RefundRow[]
}

// Per-status labels for transitions + the timeline (Picking vs Packed must
// stay distinct there); the header status pill uses the kit's vocabulary.
const STATUS_LABEL: Record<string, string> = {
  pending_payment: 'Checkout not finished',
  paid: 'Paid', picking: 'Picking', packed: 'Packed',
  shipped: 'Shipped', delivered: 'Delivered',
  cancelled: 'Cancelled', refunded: 'Refunded',
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
  // Despatch (Chris 2026-09-03). Managers ship freight but do not approve
  // orders, mark them paid or refund them - so the shipping panel is gated on
  // this and its two money buttons on canRefund. The card itself renders on
  // canEdit, and offering a button whose API then answers "Forbidden -
  // insufficient permissions" is how Terry found this out.
  const canShip   = roleHasPermission(user.role, 'ship:b2b_orders')

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
  const [timelineOpen, setTimelineOpen] = useState(false)

  // Internal notes were removed from this page 2026-09-02 (Chris: "I don't
  // think it's going to get used"). The b2b_orders.internal_notes COLUMN and
  // the PATCH that writes it are untouched, so anything already typed is
  // still there and this is a one-line revert if it turns out to be wanted.

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

  // ── Refund action — either an amount (null = full) or an item selection,
  // never both (the server derives the amount from the lines).
  const doRefund = useCallback(async (amount: number | null, reason: string | undefined, notes: string | undefined, lines?: Array<{ line_id: string; qty: number }>) => {
    setActionBusy(true); setActionError(null)
    try {
      const r = await fetch(`/api/b2b/admin/orders/${orderId}/refund`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(lines && lines.length > 0 ? { lines, reason, notes } : { amount, reason, notes }),
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

  // Ask Stripe whether the money has actually cleared.
  //
  // Settlement normally arrives via the async_payment_succeeded webhook, which
  // means a missed webhook leaves a BECS order reading "unsettled" forever -
  // Ship Now keeps warning about credit risk and the MYOB payment is never
  // receipted. This is the way to ask directly.
  const [payCheckBusy, setPayCheckBusy] = useState(false)
  async function checkPayment() {
    if (payCheckBusy) return
    setPayCheckBusy(true); setActionError(null)
    try {
      const r = await fetch(`/api/b2b/admin/orders/${orderId}/check-payment`, {
        method: 'POST', credentials: 'same-origin',
      })
      const j = await r.json()
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`)
      // Cleared is good news; still-clearing is neutral, not an error.
      flashMsg(j.message || 'Checked.')
      if (j.changed) await load()
    } catch (e: any) {
      setActionError(e?.message || String(e))
    } finally {
      setPayCheckBusy(false)
    }
  }

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


  const allowedTransitions = data ? (ALLOWED_TRANSITIONS[data.status] || []) : []
  // Shipped orders can't be cancelled (goods are gone) — refund instead.
  const canCancel  = data && canEdit && ['pending_payment','paid','picking','packed'].includes(data.status)
  const canDoRefund = data && canRefund && data.paid_at && (Number(data.refunded_total || 0) < Number(data.total_inc || 0) - 0.005)

  // THE ACTIONS BLOCK NOW LIVES IN THE SHIPPING PANEL (Chris 2026-09-03:
  // "lets fold the actions tab into the Shipping area"). It was its own card
  // at the top of the rail - a title, its own padding and a 14px gap - to
  // hold one button and a dropdown, which pushed the Timeline off the first
  // screen. Shipping is where the same person is already looking: the order
  // moves picking -> packed -> shipped right beside the freight it moves on.
  // Built here rather than inside ShippingCard because every handler and
  // modal it drives belongs to this component.
  // Takes hasOwnPrimary: when the Shipping panel is already showing a big
  // button (Ship now / Book Shipment / Approve order), the status transition
  // does NOT get one too - it drops into the dropdown with everything else.
  // That is Chris's "Mark as shipped and Ship now are the same buttons": on a
  // pending consignment they are two ways to say despatch it, and only one of
  // them does the whole job (manifest + invoice + email), so only that one is
  // offered. Mark as shipped stays reachable in the menu for freight booked
  // outside the portal.
  const actionsNode = !canEdit ? null : (hasOwnPrimary: boolean) => (
    <>
      {/* ONE BUTTON AND ONE DROPDOWN (Chris 2026-09-03:
          "Actions should be a drop down selection to save
          space"). Up to five full-width buttons stacked down the
          rail cost about 230px at the very top of the page and
          pushed Shipping — the panel with the job in it — and the
          Timeline off the screen.

          The PRIMARY transition keeps its button: it is the one
          that actually gets pressed, and burying "Mark as
          shipped" a click deeper to save a row is a bad trade.
          The undo, refund, cancel and delete go in the dropdown.

          A native select on purpose — it is what "Pack as" in the
          Shipping panel already uses, it cannot be clipped by the
          sticky rail the way an absolutely-positioned menu can,
          and every option behind it opens its own confirmation,
          so a stray selection still cannot refund or delete
          anything by itself. */}
      {(() => {
        const primary = hasOwnPrimary ? undefined : allowedTransitions.find(t => t.primary)
        const runTransition = (t: { to: string; needsModal?: 'shipped' }) => {
          if (t.needsModal === 'shipped') setShipModal(true)
          else doTransition(t.to)
        }
        const others: { key: string; label: string; run: () => void }[] = [
          ...allowedTransitions.filter(t => t !== primary).map(t => ({
            key: `to:${t.to}`, label: t.label, run: () => runTransition(t),
          })),
          ...(canDoRefund ? [{ key: 'refund', label: 'Refund…',       run: () => setRefundModal(true) }] : []),
          ...(canCancel   ? [{ key: 'cancel', label: 'Cancel order…', run: () => setCancelModal(true) }] : []),
          ...(canRefund   ? [{ key: 'delete', label: 'Delete order',  run: () => { void doDelete() } }] : []),
        ]

        if (!primary && others.length === 0) {
          return <div style={{fontSize:12,color:T.text3}}>No actions available for this status.</div>
        }
        return (
          <>
            {primary && (
              <button
                disabled={actionBusy}
                onClick={() => runTransition(primary)}
                className="al-press al-focus al-primary"
                style={actionBtn(true, actionBusy)}>
                {primary.label}
              </button>
            )}
            {others.length > 0 && (
              <select
                value=""
                disabled={actionBusy}
                aria-label="More actions"
                onChange={e => {
                  const pick = others.find(o => o.key === e.target.value)
                  if (pick) pick.run()
                }}
                className="al-focus"
                style={{
                  width:'100%', background:T.bg3, border:'1px solid transparent',
                  color:T.text2, borderRadius:RADIUS.pill,
                  padding: isMobile ? '11px 13px' : '9px 13px',
                  fontSize: isMobile ? 16 : 13, fontWeight:600,
                  minHeight: isMobile ? 44 : 38, outline:'none',
                  fontFamily:'inherit', cursor: actionBusy ? 'wait' : 'pointer',
                }}>
                <option value="">More actions…</option>
                {others.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
              </select>
            )}
          </>
        )
      })()}
    
    </>
  )

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
            <div style={{fontSize:12.5,color:T.text3,marginBottom:5}}>
              <a href="/admin/b2b" style={{color:T.text3,textDecoration:'none'}}>B2B Portal</a>
              {' / '}
              <a href="/admin/b2b/orders" style={{color:T.text3,textDecoration:'none'}}>Orders</a>
              {' / '}
              <span style={{color:T.text2}}>{data?.order_number || orderId}</span>
            </div>
            {data && (
              <div style={{display:'flex',alignItems:'baseline',gap:14,flexWrap:'wrap'}}>
                <h1 style={{fontSize:24,fontWeight:700,margin:0,letterSpacing:'-0.02em',fontFamily:'monospace'}}>{data.order_number}</h1>
                <StatusPill status={data.status}/>
                <span style={{color:T.text2,fontSize:13}}>· {data.distributor?.display_name || '—'}</span>
                {data.events.length > 0 && (
                  <button onClick={() => setTimelineOpen(true)}
                    className="al-press al-focus"
                    title="Everything that has happened to this order"
                    style={{background:'none',border:'none',padding:0,color:A.accent,fontSize:13,fontWeight:550,cursor:'pointer',fontFamily:'inherit'}}>
                    · Timeline ({data.events.length})
                  </button>
                )}
                {/* THE big figure sits up here (Chris 2026-09-03). It was 13px
                    in the header and 40px halfway down the page, which put the
                    money below the fold on a phone; the header is where you
                    land, so it reads first and the Totals card just itemises
                    it. Sized under the 24px order number's weight class on
                    purpose — same baseline row, so 32 not 40. */}
                <span style={{marginLeft:'auto',display:'flex',alignItems:'baseline',gap:6,minWidth:0}}>
                  <span style={{
                    fontSize: isMobile ? 26 : 32, lineHeight:1, fontWeight:750,
                    letterSpacing:'-0.03em', color:T.text, fontVariantNumeric:'tabular-nums',
                  }}>${money(data.total_inc)}</span>
                  <span style={{fontSize:12,color:T.text3}}>{data.currency}</span>
                </span>
              </div>
            )}
          </header>

          {flash && (
            <div style={{marginBottom:14}}>
              <Banner tone="success">{flash}</Banner>
            </div>
          )}
          {error && (
            <div style={{marginBottom:14}}>
              <Banner tone="error">{error}</Banner>
            </div>
          )}
          {actionError && (
            <div style={{marginBottom:14}}>
              <Banner tone="error" onDismiss={() => setActionError(null)}>{actionError}</Banner>
            </div>
          )}

          {loading && !data && (
            <div style={{padding:40,textAlign:'center',color:T.text3,fontSize:13}}>Loading…</div>
          )}

          {/* The rail only holds staff panels, and the Timeline has left it for a
              popup - so for a read-only role (sales or accountant on view:b2b)
              there is nothing to put in it. Collapse to one column rather than
              leaving 360px of empty page. */}
          {data && (
            <div style={{display:'grid',gridTemplateColumns: (isMobile || !canEdit) ? '1fr' : '1fr 360px',gap: isMobile ? 14 : 18,alignItems:'start',minWidth:0}}>

              {/* ── LEFT COLUMN ── */}
              <div style={{display:'flex',flexDirection:'column',gap:14,minWidth:0}}>

                {/* Summary and Ship to sit SIDE BY SIDE on a desktop (Chris
                    2026-09-03: "re jig the order page so that it can be seen
                    easily without scrolling"). Both are short and narrow, and
                    stacking them full-width down a 1500px column is what pushed
                    everything else below the fold - while leaving a hand's width
                    of nothing between every label and its figure. */}
                <div style={{display:'grid',gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr',gap:14,alignItems:'stretch',minWidth:0}}>

                {/* Order summary header */}
                <Card title="Summary">
                  {/* The MYOB invoice number is what accounts, the distributor
                      and MYOB itself all quote — "Cutlers JAWSB2B0055". It used
                      to live only in the MYOB diagnostics card down the right
                      rail, so the order you were looking at and the invoice
                      someone was asking about had nothing visibly in common.
                      It leads the summary now, above the PO. */}
                  <KV label="MYOB invoice"
                      value={data.myob.order_number || 'Not written to MYOB yet'}
                      mono={!!data.myob.order_number}
                      valueColor={data.myob.order_number ? undefined : A.warn}/>
                  {data.myob.order_number && data.myob.written_at && (
                    <KV label="Invoiced" value={fullDate(data.myob.written_at)} mono small/>
                  )}
                  {/* The MYOB write ERROR is the one thing the old MYOB card
                      carried that nothing else does — company file, order
                      number, written date and attempt count were all either
                      already in this card or in the Timeline, which is why that
                      card is gone (Chris 2026-09-03). So the error stays, under
                      the invoice row it explains, and only when there is one.
                      retry-myob is admin:b2b, so a manager sees the error but
                      not the button. */}
                  {data.myob.write_error && (
                    <div style={{margin:'6px 0 2px',padding:'8px 10px',background:alpha(A.bad,'14'),borderRadius:RADIUS.sm,color:A.bad,fontSize:12.5,lineHeight:1.5}}>
                      {data.myob.write_error}
                      {!!data.myob.write_attempts && (
                        <span style={{color:T.text3}}> ({data.myob.write_attempts} attempt{data.myob.write_attempts === 1 ? '' : 's'})</span>
                      )}
                      {canRefund && (
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
                            className="al-press al-focus"
                            style={{padding:'6px 13px',borderRadius:RADIUS.pill,border:'1px solid transparent',background:alpha(A.bad,'14'),color:A.bad,fontSize:12.5,fontWeight:600,fontFamily:'inherit',cursor:'pointer',minHeight:32}}>
                            {actionBusy ? 'Retrying…' : 'Retry MYOB write'}
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                  <KV label="Distributor"    value={data.distributor?.display_name || '—'}/>
                  <KV label="Customer PO"    value={data.customer_po || '—'} mono/>
                  {(() => {
                    const m = data.payment_method || 'card'
                    const label = m === 'becs' ? 'Bank Direct Debit' : m === 'payto' ? 'PayTo' : 'Card'
                    const settled = !!data.payment_settled_at
                    const state = settled ? 'Settled' : (m === 'becs' ? 'Awaiting settlement' : m === 'payto' ? 'Awaiting confirmation' : 'Unsettled')
                    return <KV label="Payment" value={`${label} · ${state}`} valueColor={settled ? A.good : (m === 'card' ? undefined : A.warn)}/>
                  })()}
                  {/* All the old Stripe card was ever used for. The payment
                      intent and session id are on the far side of this link. */}
                  {data.stripe.payment_intent_id && (
                    <div style={{display:'flex', justifyContent:'flex-end'}}>
                      <a href={`https://dashboard.stripe.com/payments/${data.stripe.payment_intent_id}`}
                        target="_blank" rel="noopener noreferrer"
                        title={`Payment intent ${data.stripe.payment_intent_id}`}
                        style={{fontSize:12,color:A.accent,textDecoration:'none'}}>
                        Open in Stripe →
                      </a>
                    </div>
                  )}
                  {/* Offered while there is something to find out (a paid order
                      whose funds aren't confirmed cleared) AND when the money
                      HAS cleared but never reached MYOB — the second case is
                      the repair for a payment the webhook skipped, and it used
                      to have no button at all (JAWSB2B0059). payment_at without
                      a uid means someone receipted it by hand in MYOB — done,
                      not outstanding. */}
                  {data.paid_at && data.status !== 'cancelled' && data.status !== 'refunded'
                    && (!data.payment_settled_at || (!data.myob.payment_uid && !data.myob.payment_at)) && (
                    <div style={{display:'flex', justifyContent:'flex-end', padding:'6px 0 2px'}}>
                      <button onClick={checkPayment} disabled={payCheckBusy}
                        className="al-press al-focus"
                        title={data.payment_settled_at ? 'The funds have cleared but no customer payment exists in MYOB — apply it now' : 'Ask Stripe whether the funds have actually cleared, rather than waiting for the webhook'}
                        style={{
                          padding:'5px 12px', minHeight:30, borderRadius:RADIUS.pill,
                          border:`1px solid ${alpha(A.warn, '66')}`, background:alpha(A.warn, '14'),
                          color:A.warn, fontSize:12, fontWeight:600, fontFamily:'inherit',
                          cursor: payCheckBusy ? 'wait' : 'pointer',
                        }}>
                        {payCheckBusy
                          ? (data.payment_settled_at ? 'Receipting in MYOB…' : 'Checking Stripe…')
                          : (data.payment_settled_at ? 'Receipt payment in MYOB' : 'Check if payment cleared')}
                      </button>
                    </div>
                  )}
                  <KV label="Placed"         value={fullDate(data.placed_at)} mono/>
                  {data.paid_at && <KV label="Paid"      value={fullDate(data.paid_at)}      mono valueColor={A.good}/>}
                  {data.shipped_at && <KV label="Shipped" value={fullDate(data.shipped_at)} mono valueColor={A.accent}/>}
                  {data.cancelled_at && <KV label="Cancelled" value={fullDate(data.cancelled_at)} mono valueColor={A.bad}/>}
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
                        <div style={{fontSize:12,color:T.text3,marginTop:6,fontStyle:'italic'}}>From the distributor's ship address (no per-order delivery address on file).</div>
                      )}
                    </div>
                  ) : (
                    <div style={{fontSize:12.5,color:A.warn}}>No delivery address — add a ship address to the distributor before booking freight.</div>
                  )}
                </Card>

                </div>

                {/* Lines */}
                <Card title={`Items (${data.lines.length})`}>
                  {/* PHONE: a card per line. The table below is five columns wide
                      and had to be dragged sideways to reach the money, which is
                      exactly what a phone should not ask (Chris 2026-09-02). Same
                      figures, stacked, nothing hidden — the desktop table is
                      still there for reading several lines at once. */}
                  {isMobile && (
                    <div style={{display:'flex',flexDirection:'column',gap:10}}>
                      {data.lines.map((ln, i) => (
                        <div key={ln.id} style={{
                          borderTop: i > 0 ? `1px solid ${T.border}` : 'none',
                          paddingTop: i > 0 ? 10 : 0,
                        }}>
                          <div style={{display:'flex',alignItems:'baseline',gap:10}}>
                            <div style={{flex:1,minWidth:0,fontSize:13.5,color:T.text,fontWeight:550,lineHeight:1.35,overflowWrap:'anywhere'}}>
                              {ln.name}
                            </div>
                            <div style={{fontSize:14,color:T.text,fontWeight:650,fontVariantNumeric:'tabular-nums',flexShrink:0}}>
                              ${money(ln.line_total_inc)}
                            </div>
                          </div>
                          <div style={{fontSize:12,color:T.text3,marginTop:3,fontVariantNumeric:'tabular-nums',overflowWrap:'anywhere'}}>
                            <span style={{fontFamily:'monospace'}}>{ln.sku}</span>
                            {' · '}{ln.qty} × ${money(incGstAmt(ln.unit_trade_price_ex_gst, ln.is_taxable))} inc GST
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  <div style={{display: isMobile ? 'none' : 'block', overflowX:'auto',margin:'0 -22px',padding:'0 22px'}}>
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

                  {/* TOTALS LIVE IN THE ITEMS CARD (Chris 2026-09-03). They were
                      a full-width card of their own, so "Items (inc GST)" sat at
                      the far left with its figure at the far right and a 1200px
                      gap between them — and it cost another card's height on a
                      page that already scrolled. Capped at 360 and pushed right,
                      the block sits under the Line (inc GST) column it sums,
                      which is how an invoice reads.

                      The stored subtotal_ex_gst includes freight, so freight is
                      broken out as its own line and items-only shown above it.
                      The total is the bold last row — the big figure moved to
                      the page header, and two hero totals on one screen was one
                      too many. */}
                  <div style={{display:'flex', justifyContent:'flex-end', marginTop:14, paddingTop:14, borderTop:`1px solid ${T.border2}`}}>
                    <div style={{width:'100%', maxWidth:360, minWidth:0}}>
                      {(() => {
                        const itemsInc = data.lines.reduce((s, l) => s + (Number(l.line_total_inc) || 0), 0)
                        const freightInc = data.freight_cost_ex_gst != null ? round2x(data.freight_cost_ex_gst * 1.10) : 0
                        return (
                          <>
                            <Row label="Items (inc GST)" value={`$${money(itemsInc)}`}/>
                            {freightInc > 0 && (
                              <Row label={`Freight${data.freight_service_label || data.freight_method_label ? ` — ${data.freight_service_label || data.freight_method_label}` : ' (inc GST)'}`} value={`$${money(freightInc)}`}/>
                            )}
                          </>
                        )
                      })()}
                      <Row label="Card surcharge" value={`$${money(data.card_fee_inc)}`} muted/>
                      <Row label={data.paid_at ? 'Total paid' : 'Order total'}
                           value={`$${money(data.total_inc)}`} bold/>
                      <div style={{fontSize:11,color:T.text3,textAlign:'right'}}>
                        includes ${money(data.gst)} GST
                        {data.currency && data.currency !== 'AUD' ? ` · ${data.currency}` : ''}
                      </div>
                      {Number(data.refunded_total || 0) > 0 && (
                        <Row label={`Refunded${Number(data.refunded_total) >= data.total_inc - 0.005 ? ' (full)' : ' (partial)'}`}
                             value={`-$${money(Number(data.refunded_total))}`} valueColor={A.bad}/>
                      )}
                    </div>
                  </div>
                </Card>

                {/* Refund history */}
                {data.refunds.length > 0 && (
                  <Card title={`Refunds (${data.refunds.length})`}>
                    {data.refunds.map(rf => (
                      <div key={rf.id} style={{display:'flex',justifyContent:'space-between',gap:14,padding:'8px 0',borderTop:`1px solid ${T.border}`,fontSize:13}}>
                        <div>
                          <div style={{color:T.text}}>${money(rf.amount)} <span style={{color:T.text3,fontSize:12}}>{rf.currency.toUpperCase()}</span></div>
                          <div style={{fontSize:12,color:T.text3,marginTop:2,fontFamily:'monospace'}}>
                            {rf.id} · {new Date(rf.created * 1000).toLocaleString('en-AU')}
                          </div>
                        </div>
                        <div style={{textAlign:'right'}}>
                          <Pill color={rf.status === 'succeeded' ? A.good : A.warn}>{rf.status}</Pill>
                          {rf.reason && <div style={{fontSize:12,color:T.text3,marginTop:3}}>{rf.reason.replace(/_/g,' ')}</div>}
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

                {/* Shipping panel — always shown for staff so they can book / edit */}
                {canEdit && (
                  <ShippingCard
                    order={data}
                    canShip={canShip}
                    canAdmin={!!canRefund}
                    actions={actionsNode}
                    onEdit={() => setShipModal(true)}
                    onReloaded={() => { void load() }}
                    onFlash={flashMsg}
                  />
                )}

                {/* Drop-ship purchase orders */}
                {canEdit && data.has_drop_ship && (
                  <DropShipCard order={data} canAdmin={!!canRefund} onReloaded={() => { void load() }} onFlash={flashMsg}/>
                )}

                {/* The Timeline is a POPUP now, opened from the header (Chris
                    2026-09-03: "there is no reason for timeline so just remove
                    or hide so that you can view as a pop up if need be"). It is
                    the page's only piece of pure history, it was the tallest
                    thing in the rail, and it is read perhaps once an order -
                    when something has gone wrong. */}


              </div>
            </div>
          )}

        </main>
      </div>

      {/* ── Modals ── */}
      {data && shipModal   && <ShipModal   order={data} busy={actionBusy} onClose={() => setShipModal(false)}   onConfirm={(body) => { setShipModal(false); shipOrder(body) }}/>}
      {data && refundModal && <RefundModal order={data} busy={actionBusy} onClose={() => setRefundModal(false)} onConfirm={doRefund}/>}
      {data && timelineOpen && (
        <Backdrop onClose={() => setTimelineOpen(false)}>
          <h2 style={modalTitle()}>Timeline</h2>
          <p style={modalDesc()}>Everything that has happened to {data.order_number}, newest last.</p>
          <div style={{maxHeight:'60vh', overflowY:'auto', marginTop:4}}>
            <Timeline events={data.events} showAll/>
          </div>
        </Backdrop>
      )}
      {data && cancelModal && <CancelModal order={data} busy={actionBusy} canRefund={!!canDoRefund} onClose={() => setCancelModal(false)} onConfirm={doCancel}/>}
    </>
  )
}

// ─── Components ────────────────────────────────────────────────────────

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ ...cardStyle(true), padding:'16px 22px' }}>
      <div style={{fontSize:13,fontWeight:650,color:T.text2,marginBottom:12}}>{title}</div>
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
        fontSize: small ? 12 : 12.5,
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
  return <Pill color={orderStatusColor(status)}>{orderStatusLabel(status)}</Pill>
}

// How many of the most recent events to show before you ask for the rest.
// A busy order (drop-ship + freight polls + refunds) can run to dozens, and
// the answer you actually want is nearly always "what happened last".
const TIMELINE_RECENT = 3

function Timeline({ events, showAll }: { events: OrderEvent[]; showAll?: boolean }) {
  // showAll: the popup has room, so it opens expanded instead of making you
  // press "show all N events" every single time.
  const [open, setOpen] = useState(!!showAll)
  if (events.length === 0) return <div style={{fontSize:12,color:T.text3}}>No events yet.</div>

  // Events arrive oldest-first, so the recent ones are the tail.
  const hidden  = Math.max(0, events.length - TIMELINE_RECENT)
  const shown   = open || hidden === 0 ? events : events.slice(-TIMELINE_RECENT)
  const toggle  = hidden > 0 ? (
    <button
      onClick={() => setOpen(o => !o)}
      aria-expanded={open}
      style={{
        alignSelf:'flex-start', marginTop:2, padding:'4px 10px', minHeight:28,
        background:'transparent', border:`1px solid ${T.border}`, borderRadius:RADIUS.pill,
        color:T.text3, fontSize:12, cursor:'pointer', fontFamily:'inherit',
      }}>
      {open ? 'Show less' : `Show all ${events.length} events`}
    </button>
  ) : null

  return (
    <div style={{display:'flex',flexDirection:'column',gap:10}}>
      {!open && hidden > 0 && (
        <div style={{fontSize:12,color:T.text3}}>
          {hidden} earlier {hidden === 1 ? 'event' : 'events'} hidden
        </div>
      )}
      {shown.map((ev, i) => {
        const isStatus = ev.event_type === 'status_changed'
        const color    = isStatus && ev.to_status ? orderStatusColor(ev.to_status) :
                         ev.event_type === 'myob_credit_note_written' ? A.bad :
                         ev.event_type === 'myob_credit_note_failed'  ? A.bad :
                         ev.event_type === 'refund_failed'            ? A.bad :
                         ev.event_type.startsWith('refund') ? A.bad :
                         ev.event_type === 'admin_edited' ? T.text3 :
                         ev.event_type === 'checkout_started' ? A.warn :
                         A.accent
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
              <div style={{color:T.text3,fontSize:12,marginTop:2}}>
                {new Date(ev.created_at).toLocaleString('en-AU')}
                {' · '}{ev.actor_name}
              </div>
              {ev.notes && (
                <div style={{color:T.text2,fontSize:12,marginTop:3,fontStyle:'italic',lineHeight:1.4,overflowWrap:'anywhere',wordBreak:'break-word'}}>{ev.notes}</div>
              )}
              {ev.event_type === 'status_changed' && ev.metadata?.tracking_number && (
                <div style={{color:T.text3,fontSize:12,marginTop:3,fontFamily:'monospace',overflowWrap:'anywhere'}}>
                  {ev.metadata.carrier && `${ev.metadata.carrier} · `}{ev.metadata.tracking_number}
                </div>
              )}
            </div>
          </div>
        )
      })}
      {toggle}
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
        background:T.bg2,border:`1px solid ${T.border}`,borderRadius:RADIUS.md,
        padding:20, width:'calc(100vw - 24px)', maxWidth:500, boxSizing:'border-box',
        maxHeight:'calc(100vh - 32px)', overflowY:'auto', zIndex:1001,
        boxShadow:SHADOW.md,
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
//     consignment, pulls the label, stores tracking + ETA on the order. It
//     leaves the consignment UNMANIFESTED: nothing reaches the carrier and no
//     tax invoice is raised, so the order can be picked and packed first.
//   - "Ship now" — the despatch step (Chris 2026-08-20). Manifests the
//     consignment (which also books the carrier pickup), converts the MYOB
//     order → tax invoice, receipts the payment, prints the invoice and emails
//     the distributor. Bulk equivalent lives on the orders list.
//   - "Refresh from MachShip" — calls /refresh-freight to re-fetch the
//     current status + ETA. The 30-min cron does this automatically;
//     the button is for when admin wants it RIGHT NOW.
function ShippingCard({ order, canShip, canAdmin, actions, onEdit, onReloaded, onFlash }: {
  order: OrderDetail
  canShip: boolean          // ship:b2b_orders - book, despatch, label, refresh
  canAdmin: boolean         // admin:b2b - approve an order, bill a drop-ship PO
  /** The status buttons, folded in from their own card. Told whether the panel
   *  is already showing a primary button, so we never offer two. */
  actions: ((hasOwnPrimary: boolean) => React.ReactNode) | null
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
  // Booking now leaves the consignment Unmanifested — nothing reaches the
  // carrier and no tax invoice is raised until "Ship Now" (Chris 2026-08-20).
  //
  // Whether the freight has left is decided in lib/b2b-despatch-state, shared
  // with the orders list and with the Ship Now guard itself — see that file for
  // why our own manifest id is not enough to go on.
  const awaitingDespatch = awaitingDespatchFor(order)
  // The pack plan is editable right up until the consignment is MANIFESTED.
  // Booked-but-unmanifested still has nothing with the carrier, so re-boxing
  // then is normal packing work - it just needs a Re-book to apply.
  const planLocked = isManifestedFor(order)
  const [shipNowBusy,  setShipNowBusy]  = useState(false)
  const [approveBusy,  setApproveBusy]  = useState(false)

  // Large orders (migration 218) arrive unpaid and do NOTHING until approved.
  // Approving releases them to the warehouse and writes the MYOB sale order;
  // drop-ship POs still wait for the bank transfer to be recorded.
  async function approveOrder() {
    if (!await confirmDialog({
      title: 'Approve this order?',
      message: `${order.order_number} was submitted without payment because it is over the manual-processing threshold. Approving releases it to the warehouse and writes the MYOB sale order. Drop-ship POs are NOT raised until you record the bank transfer.`,
      confirmLabel: 'Approve',
    })) return
    setApproveBusy(true); setActionError(null)
    try {
      const r = await fetch(`/api/b2b/admin/orders/${order.id}/approve`, { method: 'POST', credentials: 'same-origin' })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`)
      onFlash(j?.myob?.ok === false
        ? `Approved — but the MYOB write failed (${j.myob.error}). Use Retry MYOB.`
        : 'Approved — released to the warehouse. Record the bank transfer when it lands.')
      onReloaded()
    } catch (e: any) {
      setActionError(e?.message || String(e))
    } finally {
      setApproveBusy(false)
    }
  }
  const [bookingBusy,  setBookingBusy]  = useState(false)
  const [refreshBusy,  setRefreshBusy]  = useState(false)
  const [pickBusy,     setPickBusy]     = useState(false)
  // Optional carrier pickup. Blank = let MachShip choose its own window (and
  // roll to the next business day if today's cut-off has gone). Filled in = we
  // send exactly this and MachShip's refusal, if any, is reported as-is.
  const [pickupModal, setPickupModal] = useState(false)
  const [pickDone,     setPickDone]     = useState(false)
  // Ship Now — manifests the consignment with MachShip (which also books the
  // carrier pickup) and then converts the MYOB order to a tax invoice, receipts
  // the payment, prints the A4 invoice and emails/pushes the distributor.
  // `pickupAt` is chosen in PickupModal, which is also the confirmation step -
  // pressing Ship now opens it rather than a yes/no dialog (Chris 2026-09-01:
  // "Ship now and then a window pops up to set your time"). Blank = let the
  // carrier pick its next window, which is what it always did.
  async function shipNow(acceptUnsettled = false, pickupAt: string | null = null) {
    setShipNowBusy(true); setActionError(null)
    try {
      const r = await fetch('/api/b2b/admin/orders/ship-now', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [order.id], ...(acceptUnsettled ? { accept_unsettled: true } : {}), ...(pickupAt ? { pickup_at: pickupAt } : {}) }),
      })
      const j = await r.json()
      const first = Array.isArray(j?.results) ? j.results[0] : null
      // BECS credit gate: the debit hasn't cleared. Offer the explicit admin
      // approval rather than a dead end — the acceptance is logged on the order.
      // (This gate used to sit on booking; it belongs here, where the goods
      // actually leave and the tax invoice is raised.)
      if (first?.becsUnsettled && !acceptUnsettled) {
        setShipNowBusy(false)
        if (await confirmDialog({
          title: 'BECS payment hasn’t settled yet',
          message: 'Funds take 2–3 business days to clear. Ship now anyway? This despatches on an unsettled direct debit and raises the tax invoice — admin accepts the credit risk (logged on the order).',
          confirmLabel: 'Ship anyway',
          danger: true,
        })) {
          return shipNow(true, pickupAt)
        }
        return
      }
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`)
      const one = first
      if (one?.already) onFlash('Already manifested — nothing re-sent.')
      else onFlash(one?.warning ? `Shipped, with a warning: ${one.warning}` : 'Shipped — manifested, invoiced and distributor notified.')
      onReloaded()
    } catch (e: any) {
      setActionError(e?.message || String(e))
    } finally {
      setShipNowBusy(false)
    }
  }

  async function printPickList() {
    setPickBusy(true)
    setActionError(null)
    try {
      const r = await fetch(`/api/b2b/admin/orders/${order.id}/print-picklist`, { method: 'POST', credentials: 'same-origin' })
      const j = await r.json()
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`)
      setPickDone(true)
      setTimeout(() => setPickDone(false), 5000)
    } catch (e: any) {
      setActionError(e?.message || String(e))
    } finally {
      setPickBusy(false)
    }
  }
  const [actionError,  setActionError]  = useState<string | null>(null)
  const [receiveBusy,  setReceiveBusy]  = useState(false)

  // Drop-ship receiving: POs raised in MYOB but not yet billed. "Supplier
  // confirmed" converts each PO → Bill (receives stock into the supplier's DS
  // location) then retries the sale order → invoice conversion + payment.
  const dropshipPos      = (order.dropship_pos || []).filter(p => p.myob_po_uid)
  const unbilledDropship = dropshipPos.filter(p => !p.myob_bill_uid)
  const lastBilledAt     = dropshipPos.map(p => p.billed_at).filter((d): d is string => !!d).sort().pop() || null

  async function receiveDropship() {
    if (receiveBusy) return
    setReceiveBusy(true); setActionError(null)
    try {
      const r = await fetch(`/api/b2b/admin/orders/${order.id}/receive-dropship`, { method: 'POST', credentials: 'same-origin' })
      const j = await r.json()
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`)
      const stepsRun: { step: string; ok: boolean; detail: string }[] = Array.isArray(j.steps) ? j.steps : []
      const failed = stepsRun.filter(s => !s.ok)
      if (failed.length > 0) setActionError(failed.map(s => `${s.step}: ${s.detail}`).join(' · '))
      if (stepsRun.some(s => s.ok)) {
        onFlash(failed.length > 0
          ? `Ran with ${failed.length} failed step${failed.length === 1 ? '' : 's'} — details below`
          : 'Supplier PO billed — invoice conversion + payment receipting run')
      }
      onReloaded()
    } catch (e: any) {
      setActionError(e?.message || String(e))
    } finally {
      setReceiveBusy(false)
    }
  }

  const [dispatchAt,   setDispatchAt]   = useState('')   // datetime-local; blank = collect ASAP
  const [packMode,     setPackMode]     = useState<string>(order.freight_pack_mode || 'auto')
  const [laterOpen,    setLaterOpen]    = useState(false) // mobile "book later" sheet
  const [laterTime,    setLaterTime]    = useState('')

  // Combine consignments — manual pack plan editor. Loads the effective plan
  // (saved override or a fresh cartonizer run), lets admin tick 2+ consignments
  // and merge them into one box; booking + the pick list then use the saved
  // plan verbatim (e.g. oil + sump in one box to save a consignment).
  type PlanContent = { sku: string; name: string; qty: number }
  // `boxes` is set on pallets only: the cartons stacked on the deck.
  type PlanBox = { name: string; ownPackaging?: boolean; weight_g: number; length_mm: number; width_mm: number; height_mm: number; contents?: PlanContent[] }
  type PlanUnit = { itemType: string; name: string; ownPackaging?: boolean; quantity: number; weight_g: number; length_mm: number; width_mm: number; height_mm: number; contents?: PlanContent[]; boxes?: PlanBox[] }
  const [planOpen,       setPlanOpen]       = useState(false)
  const [detailsOpen,    setDetailsOpen]    = useState(false)
  const [planBusy,       setPlanBusy]       = useState(false)
  const [planUnits,      setPlanUnits]      = useState<PlanUnit[] | null>(null)
  const [planOverridden, setPlanOverridden] = useState(false)
  const [planBoxes,      setPlanBoxes]      = useState<{ name: string; length_mm: number; width_mm: number; height_mm: number; max_weight_g: number }[]>([])
  const [planSel,        setPlanSel]        = useState<number[]>([])
  const [planBox,        setPlanBox]        = useState('')

  async function loadPlan() {
    setPlanBusy(true); setActionError(null)
    try {
      const r = await fetch(`/api/b2b/admin/orders/${order.id}/pack-plan`, { credentials: 'same-origin' })
      const j = await r.json()
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`)
      setPlanUnits(j.units || []); setPlanOverridden(!!j.overridden); setPlanBoxes(j.boxes || []); setPlanSel([])
      // Default the target box to the largest configured one — combining is
      // usually "put these in the big box".
      const bs = (j.boxes || []) as any[]
      if (bs.length > 0) setPlanBox(bs.reduce((a, b) => (a.length_mm * a.width_mm * a.height_mm >= b.length_mm * b.width_mm * b.height_mm ? a : b)).name)
    } catch (e: any) {
      setActionError(e?.message || String(e))
    } finally {
      setPlanBusy(false)
    }
  }

  async function combinePlan() {
    if (planBusy || planLocked || planSel.length < 2) return
    setPlanBusy(true); setActionError(null)
    try {
      const r = await fetch(`/api/b2b/admin/orders/${order.id}/pack-plan`, {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'combine', indexes: planSel, box: planBox || undefined }),
      })
      const j = await r.json()
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`)
      if (j.warning) toast(j.warning, 'error')
      onFlash('Consignments combined — reprint the pick list so the warehouse packs the new plan')
      await loadPlan()
    } catch (e: any) {
      setActionError(e?.message || String(e))
      setPlanBusy(false)
    }
  }

  // Re-box ONE consignment. The cartonizer picks the smallest box an item
  // fits, which is often not the box the warehouse actually reaches for — and
  // the box's dimensions are what MachShip prices and the carrier bills.
  async function setPlanUnitBox(index: number, box: string) {
    if (planBusy || planLocked) return
    setPlanBusy(true); setActionError(null)
    try {
      const r = await fetch(`/api/b2b/admin/orders/${order.id}/pack-plan`, {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'setbox', index, box }),
      })
      const j = await r.json()
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`)
      if (j.warning) toast(j.warning, 'error')
      onFlash('Box changed — reprint the pick list so the warehouse packs the new plan')
      await loadPlan()
    } catch (e: any) {
      setActionError(e?.message || String(e))
      setPlanBusy(false)
    }
  }

  async function resetPlan() {
    if (planBusy) return
    if (!(await confirmDialog({ title: 'Reset to automatic packing?', message: 'Removes the manual consignment plan — booking and the pick list go back to the cartonizer’s plan.' }))) return
    setPlanBusy(true); setActionError(null)
    try {
      const r = await fetch(`/api/b2b/admin/orders/${order.id}/pack-plan`, {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reset' }),
      })
      const j = await r.json()
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`)
      await loadPlan()
    } catch (e: any) {
      setActionError(e?.message || String(e))
      setPlanBusy(false)
    }
  }

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
      if (!r.ok) {
        throw new Error(j.error || `HTTP ${r.status}`)
      }
      // Booking no longer despatches — it leaves the consignment Unmanifested so
      // the order can be picked and packed. Say so, or staff will assume it's gone.
      if (j.label_warning) onFlash(`Booked (not manifested), but label fetch warning: ${j.label_warning}`)
      else                 onFlash(`Shipment booked: ${j.consignment_number || j.consignment_id} — press “Ship now” once it's packed`)
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
        /* ONE PRIMARY ACTION, THEN AN EVEN GRID (Chris 2026-09-03: "Mark as
           shipped and ship now are the same buttons... the ship now, manual
           book, print label, print pick list could be laid out better and
           cleaner").

           Before, up to eight buttons of different colours wrapped across the
           rail in whatever order the conditions happened to fire, and on a
           pending consignment two of them - Ship now and Mark as shipped -
           claimed to do the same thing while only one of them manifests the
           freight, raises the invoice and emails the distributor.

           Now: the status pill on its own line, then exactly one accent button
           for the thing to do next, then the dropdown, then the standing tools
           in a two-column grid so they line up instead of ragging. The status
           transition only gets its own button when there is no bigger action
           in play - see the actions render prop. */
        const primary =
          awaitingDespatch && canShip
            ? { label: shipNowBusy ? 'Shipping…' : 'Ship now', busy: shipNowBusy, color: A.accent,
                title: 'Manifests the consignment with MachShip (books the carrier pickup), raises the MYOB tax invoice, prints it and emails the distributor',
                run: () => setPickupModal(true) }
          : hasLiveQuote && !hasConsignment && canShip
            ? { label: bookingBusy ? 'Booking…' : 'Book Shipment', busy: bookingBusy, color: A.accent,
                title: 'Creates the consignment and pulls the label. Nothing reaches the carrier until Ship now.',
                run: () => bookViaMachShip(false) }
          : order.status === 'awaiting_approval' && canAdmin
            ? { label: approveBusy ? 'Approving…' : 'Approve order', busy: approveBusy, color: A.warn,
                title: 'Release this large order to the warehouse and write the MYOB sale order. Drop-ship POs wait for payment.',
                run: approveOrder }
          : null

        const mb = (extra: React.CSSProperties = {}): React.CSSProperties => ({
          borderRadius: RADIUS.pill, fontFamily: 'inherit', cursor: 'pointer', fontWeight: 600,
          border: '1px solid transparent', whiteSpace: 'nowrap', width: '100%',
          background: 'transparent', color: A.accent, textAlign: 'center',
          ...(isMobile ? { padding: '11px 14px', fontSize: 13, minHeight: 44 } : { padding: '7px 10px', fontSize: 12.5, minHeight: 34 }),
          ...extra,
        })
        return (
          <>
          <div style={{ marginBottom: 10 }}>
            {awaitingDespatch ? (
              <Pill color={A.warn}>Pending consignment — not manifested</Pill>
            ) : order.delivered_at ? (
              <Pill color={A.good}>Delivered {fullDate(order.delivered_at)}</Pill>
            ) : isShipped ? (
              <Pill color={A.accent}>Shipped {order.shipped_at ? fullDate(order.shipped_at) : ''}</Pill>
            ) : (
              <span style={{ fontSize: 12.5, color: T.text3 }}>Not shipped yet</span>
            )}
          </div>

          {primary && (
            <button onClick={primary.run} disabled={primary.busy} title={primary.title}
              className="al-press al-focus al-primary"
              style={actionBtn(true, primary.busy, primary.color)}>
              {primary.label}
            </button>
          )}

          {actions && actions(!!primary)}

          {/* The standing tools. Two even columns, so they read as a set
              rather than a wrapped paragraph of buttons. */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr',
            gap: 8, marginTop: 10, marginBottom: 10,
          }}>
            {hasConsignment && canShip && (
              <button onClick={refreshFromMachShip} disabled={refreshBusy}
                className="al-press al-focus al-ghost"
                style={mb({ background: T.bg3, cursor: refreshBusy ? 'wait' : 'pointer' })}>
                {refreshBusy ? 'Refreshing…' : 'Refresh'}
              </button>
            )}
            {canShip && (
              <button onClick={onEdit} className="al-press al-focus al-ghost" style={mb({ background: T.bg3 })}>
                {isShipped ? 'Edit shipping' : 'Manual book'}
              </button>
            )}
            {order.label_pdf_path && canShip && (
              <button onClick={openLabel} className="al-press al-focus al-ghost" style={mb({ background: T.bg3 })}>
                Print label
              </button>
            )}
            <button onClick={printPickList} disabled={pickBusy}
              title="Prints the box-by-box pick list on the upstairs printer (auto-prints on payment; this is a reprint)"
              className="al-press al-focus al-ghost"
              style={mb({ background: T.bg3, color: pickDone ? A.good : A.accent, cursor: pickBusy ? 'wait' : 'pointer' })}>
              {pickDone ? 'Pick list queued' : pickBusy ? 'Queuing…' : 'Print pick list'}
            </button>
            {unbilledDropship.length > 0 && canAdmin && (
              <button onClick={receiveDropship} disabled={receiveBusy}
                title="Supplier confirmed the drop-ship order — converts the PO to a bill in MYOB (receives the stock into the supplier's DS location), then converts this order to a tax invoice and receipts the payment"
                className="al-press al-focus"
                style={mb({ gridColumn: isMobile ? undefined : '1 / -1', background: alpha(A.warn, '15'), color: A.warn, cursor: receiveBusy ? 'wait' : 'pointer' })}>
                {receiveBusy ? 'Billing PO…' : 'Supplier confirmed — bill PO + invoice'}
              </button>
            )}
          </div>

          {dropshipPos.length > 0 && unbilledDropship.length === 0 && (
            <div style={{ marginBottom: 10 }}
              title={dropshipPos.map(p => `${p.supplier_name}: bill ${p.myob_bill_number || p.myob_bill_uid}`).join(' · ')}>
              <Pill color={A.good}>PO billed{lastBilledAt ? ` ${fullDate(lastBilledAt)}` : ''}</Pill>
            </div>
          )}
          {awaitingDespatch && pickupModal && (
            <PickupModal
              consignment={order.machship_consignment_number || order.machship_consignment_id || ''}
              busy={shipNowBusy}
              onClose={() => setPickupModal(false)}
              onConfirm={(pickup) => { setPickupModal(false); shipNow(false, pickup) }}
            />
          )}
          </>
        )
      })()}

      {/* Pack mode — override the cartonizer for this order before booking. */}
      {hasLiveQuote && !hasConsignment && canShip && (
        <div style={{display:'flex', alignItems:'center', gap:8, marginBottom:10, flexWrap:'wrap'}}>
          <span style={{fontSize:12, color:T.text3, whiteSpace:'nowrap'}}>Pack as</span>
          <select value={packMode} onChange={e => setPackMode(e.target.value)}
            className="al-focus"
            style={{flex: isMobile ? 1 : undefined, minWidth: isMobile ? 0 : undefined, background:T.bg3, border:'1px solid transparent', color:T.text, borderRadius:RADIUS.sm, padding: isMobile ? '9px 10px' : '6px 9px', fontSize: isMobile ? 16 : 12.5, outline:'none', fontFamily:'inherit'}}>
            <option value="auto">Auto (weight/volume)</option>
            <option value="cartons">Cartons</option>
            <option value="pallet">Pallet</option>
          </select>
          {!isMobile && <span style={{fontSize:12, color:T.text3}}>used when you book below</span>}
        </div>
      )}

      {/* Boxes and consignments - the pack plan. Shown ALWAYS, because you need
          to be able to SEE what an order ships in even after it's booked; it
          goes read-only at that point because the consignment is already
          lodged with MachShip at those dimensions (the API refuses edits too).
          Not gated on having a live MachShip quote either: the cartonizer
          packs lines into boxes regardless of which carrier was chosen, and
          hiding the plan from static/satchel orders hid it from most of them. */}
      {(
        <div style={{marginBottom:10}}>
          <button onClick={() => { const v = !planOpen; setPlanOpen(v); if (v && planUnits === null) loadPlan() }}
            className="al-press al-focus"
            style={{background:'none', border:'none', padding:0, color:A.accent, fontSize:12.5, fontWeight:550, cursor:'pointer', fontFamily:'inherit'}}>
            {planOpen ? '▾' : '▸'} Boxes and consignments{planOverridden ? ' — manual plan set' : ''}
          </button>
          {planOpen && (
            <div style={{marginTop:8, borderRadius:RADIUS.sm, padding:'10px 12px', background:T.bg3}}>
              {planBusy && planUnits === null && <div style={{fontSize:12, color:T.text3}}>Loading pack plan…</div>}
              {planUnits !== null && (
                <>
                  <div style={{fontSize:12, color:T.text3, marginBottom:8, lineHeight:1.5}}>
                    {planLocked
                      ? 'Manifested with the carrier - these are the boxes the order ships in, and they can no longer be changed.'
                      : hasConsignment
                      ? 'Freight is already booked, but nothing has reached the carrier yet - you can still change the boxes. Press Re-book freight afterwards to lodge the new plan, then reprint the pick list and labels.'
                      : planOverridden
                      ? 'Manual plan - freight books and the pick list print exactly these consignments.'
                      : 'Automatic plan (what the cartonizer will book). Change the box on any consignment, or tick two or more to merge them into one box - e.g. oil and a sump together to save a consignment.'}
                  </div>
                  {(() => { let n = 0; return planUnits.map((u, i) => {
                    const qty = Math.max(1, u.quantity)
                    const first = n + 1; n += qty
                    const label = qty > 1 ? `${first}-${n}` : String(first)
                    // A pallet is not a box: it can't be merged or re-boxed
                    // here (the packer stacks real cartons on it) - pack mode
                    // and the pallet config decide those.
                    const selectable = qty === 1 && u.itemType !== 'Pallet'
                    const checked = planSel.includes(i)
                    return (
                      <label key={i} style={{display:'flex', alignItems:'flex-start', gap:8, padding:'6px 4px', borderTop: i > 0 ? `1px dashed ${T.border}` : 'none', cursor: selectable ? 'pointer' : 'default', opacity: selectable ? 1 : 0.6}}>
                        <input type="checkbox" disabled={!selectable || planLocked} checked={checked}
                          onChange={() => setPlanSel(s => checked ? s.filter(x => x !== i) : [...s, i])}
                          style={{marginTop:2, accentColor:A.accent}}/>
                        <span style={{fontSize:12, lineHeight:1.5}}>
                          <span style={{fontWeight:600}}>Consignment {label}</span>
                          <span style={{color:T.text3}}> — {u.itemType === 'Pallet' ? (u.name || 'Pallet') : (u.ownPackaging ? 'own packaging' : u.name)} · {Math.round(u.length_mm)}×{Math.round(u.width_mm)}×{Math.round(u.height_mm)} mm · {((u.weight_g * qty) / 1000).toFixed(1)} kg</span>
                          {/* Pallets show the boxes stacked on them; everything
                              else shows the products packed in it. */}
                          {(u.boxes || []).length > 0 ? (
                            <span style={{display:'block', fontSize:12, color:T.text2, marginTop:2}}>
                              {(u.boxes || []).length} {(u.boxes || []).length === 1 ? 'box' : 'boxes'} on this pallet:
                              {(u.boxes || []).map((b, bi) => (
                                <span key={bi} style={{display:'block', paddingLeft:10}}>
                                  {b.ownPackaging ? `${b.name} (own packaging)` : b.name} — {(b.contents || []).map(cl => `${cl.qty}× ${cl.name}`).join(' · ')}
                                </span>
                              ))}
                            </span>
                          ) : (u.contents || []).length > 0 && (
                            <span style={{display:'block', fontSize:12, color:T.text2}}>
                              {(u.contents || []).map(cl => `${cl.qty}× ${cl.name}`).join(' · ')}
                            </span>
                          )}
                          {/* Change the box this one consignment ships in.
                              Grouped pallet units can't be re-boxed — pack
                              mode decides those. */}
                          {selectable && (
                            <span style={{display:'flex', alignItems:'center', gap:6, marginTop:4}}
                              onClick={e => e.preventDefault()}>
                              <span style={{fontSize:11.5, color:T.text3}}>ships in</span>
                              <select
                                value={u.ownPackaging ? '' : u.name}
                                disabled={planBusy || planLocked}
                                onChange={e => setPlanUnitBox(i, e.target.value)}
                                className="al-focus"
                                style={{background:T.bg2, border:'1px solid transparent', color:T.text, borderRadius:RADIUS.sm, padding:'4px 7px', fontSize:11.5, outline:'none', fontFamily:'inherit', maxWidth:340}}>
                                {planBoxes.some(b => b.name === u.name) ? null : <option value={u.name}>{u.name} (current)</option>}
                                {planBoxes.map(b => (
                                  <option key={b.name} value={b.name}>{b.name} ({Math.round(b.length_mm)}×{Math.round(b.width_mm)}×{Math.round(b.height_mm)} mm, max {(b.max_weight_g / 1000).toFixed(0)} kg)</option>
                                ))}
                                <option value="">Own packaging (no standard box)</option>
                              </select>
                            </span>
                          )}
                        </span>
                      </label>
                    )
                  }) })()}
                  {!planLocked && (
                  <div style={{display:'flex', alignItems:'center', gap:8, marginTop:10, flexWrap:'wrap'}}>
                    <span style={{fontSize:12, color:T.text3}}>into</span>
                    <select value={planBox} onChange={e => setPlanBox(e.target.value)}
                      className="al-focus"
                      style={{background:T.bg2, border:'1px solid transparent', color:T.text, borderRadius:RADIUS.sm, padding:'6px 9px', fontSize:12.5, outline:'none', fontFamily:'inherit'}}>
                      {planBoxes.map(b => (
                        <option key={b.name} value={b.name}>{b.name} ({Math.round(b.length_mm)}×{Math.round(b.width_mm)}×{Math.round(b.height_mm)} mm, max {(b.max_weight_g / 1000).toFixed(0)} kg)</option>
                      ))}
                      <option value="">One parcel, own packaging (no standard box)</option>
                    </select>
                    <button onClick={combinePlan} disabled={planBusy || planSel.length < 2}
                      className="al-press al-focus al-primary"
                      style={{border:'1px solid transparent', borderRadius:RADIUS.pill, padding:'7px 14px', fontSize:12.5, fontWeight:600, fontFamily:'inherit', minHeight:32, background: planSel.length >= 2 && !planBusy ? A.accent : T.bg4, color: planSel.length >= 2 && !planBusy ? '#fff' : T.text3, cursor: planSel.length >= 2 && !planBusy ? 'pointer' : 'not-allowed'}}>
                      {planBusy ? 'Saving…' : `Combine${planSel.length >= 2 ? ` ${planSel.length}` : ''}`}
                    </button>
                    {planOverridden && (
                      <button onClick={resetPlan} disabled={planBusy}
                        className="al-press al-focus"
                        style={{background:'none', border:'none', color:T.text3, fontSize:12, cursor:'pointer', fontFamily:'inherit', textDecoration:'underline'}}>
                        Reset to automatic
                      </button>
                    )}
                  </div>
                  )}
                  {planOverridden && (
                    <div style={{fontSize:12, color:A.warn, marginTop:8}}>Reprint the pick list after changing the plan so the warehouse packs it the same way.</div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}

      {/* Collection time — optional. Blank = collect ASAP; a future time sets
          MachShip's desired despatch so the carrier collects then. */}
      {hasLiveQuote && !hasConsignment && (
        <div style={{display:'flex', alignItems:'center', gap:8, marginBottom:10, flexWrap:'wrap'}}>
          <span style={{fontSize:12, color:T.text3, whiteSpace:'nowrap'}}>Collection time</span>
          <input
            type="datetime-local"
            value={dispatchAt}
            min={localNow()}
            onChange={e => setDispatchAt(e.target.value)}
            className="al-focus"
            style={{flex:1, minWidth: isMobile ? 0 : 160, background:T.bg3, border:'1px solid transparent', color:T.text, borderRadius:RADIUS.sm, padding: isMobile ? '9px 10px' : '6px 9px', fontSize: isMobile ? 16 : 12.5, outline:'none', fontFamily:'inherit', colorScheme:'dark'}}
          />
          {dispatchAt
            ? <button onClick={() => setDispatchAt('')} className="al-press al-focus" style={{background:'none', border:'none', color:T.text3, fontSize:12, cursor:'pointer', fontFamily:'inherit'}}>clear (ASAP)</button>
            : <span style={{fontSize:12, color:T.text3}}>blank = ASAP</span>}
        </div>
      )}

      {actionError && (
        <div style={{fontSize:12.5, color:A.bad, marginBottom:10, lineHeight:1.5}}>{actionError}</div>
      )}

      {/* Method and Carrier were printing the same string on every MachShip
         order — "TNT Express — Road Express" twice, a row of the rail spent
         saying nothing (Chris 2026-09-03). */}
      {(() => {
        const method  = order.freight_service_label || order.freight_method_label || ''
        const carrier = order.carrier || ''
        const same = !!method && !!carrier && method.trim().toLowerCase() === carrier.trim().toLowerCase()
        return (
          <>
            <KV label={same ? 'Carrier' : 'Method'} value={method || carrier || '—'}/>
            {!same && <KV label="Carrier" value={carrier || '—'}/>}
          </>
        )
      })()}
      <KV label="Tracking" value={order.tracking_number || '—'} mono/>
      {effectiveTrackingUrl && order.tracking_number && (
        <div style={{display:'grid', gridTemplateColumns:'90px 1fr', gap:'4px 12px', alignItems:'baseline'}}>
          <span style={{fontSize:12, color:T.text3}}>Track</span>
          <a href={effectiveTrackingUrl} target="_blank" rel="noopener noreferrer" style={{color:A.accent, fontSize:13, textDecoration:'none'}}>Open tracking page →</a>
        </div>
      )}
      <KV label="Cost ex"  value={order.freight_cost_ex_gst != null ? `$${money(order.freight_cost_ex_gst)}` : '—'} mono/>
      {order.dropship_freight_ex_gst != null && order.dropship_freight_ex_gst > 0 && (
        <KV label="  incl. drop-ship" value={`$${money(order.dropship_freight_ex_gst)}`} mono/>
      )}

      {/* ETA is the one anybody asks about, so it stays out. The consignment
          number, the freight status and the poll clock are diagnostics - useful
          when something is wrong, three rows of nothing when it isn't - and
          they were part of what kept the Timeline off the first screen
          (Chris 2026-09-03). Folded, and closed by default. */}
      {hasConsignment && (
        <div style={{marginTop:10, paddingTop:10, borderTop:`1px dashed ${T.border}`}}>
          <KV label="ETA" value={order.freight_eta_at ? fullDate(order.freight_eta_at) : '—'}/>
          <button onClick={() => setDetailsOpen(o => !o)}
            className="al-press al-focus"
            style={{background:'none', border:'none', padding:'2px 0 0', color:T.text3, fontSize:12, fontWeight:550, cursor:'pointer', fontFamily:'inherit'}}>
            {detailsOpen ? '▾' : '▸'} Consignment details
          </button>
          {detailsOpen && (
            <div style={{marginTop:4}}>
              <KV label="Consignment" value={order.machship_consignment_number || order.machship_consignment_id || '—'} mono/>
              <KV label="Status"      value={prettyFreightStatus(order.freight_status)}/>
              <KV label="Last poll"   value={order.last_freight_poll_at ? fullDate(order.last_freight_poll_at) : 'never'}/>
            </div>
          )}
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
            className="al-press al-focus al-primary"
            style={{ flex: 2, minHeight: 50, borderRadius: RADIUS.pill, border: 'none', background: bookingBusy ? T.bg4 : A.accent, color: bookingBusy ? T.text3 : '#fff', fontWeight: 700, fontSize: 15.5, cursor: bookingBusy ? 'wait' : 'pointer', fontFamily: 'inherit' }}>
            {bookingBusy ? 'Booking…' : 'Book now'}
          </button>
          <button onClick={() => { setLaterTime(''); setLaterOpen(true) }} disabled={bookingBusy}
            className="al-press al-focus"
            style={{ flex: 1, minHeight: 50, borderRadius: RADIUS.pill, border: 'none', background: T.bg3, color: T.text, fontWeight: 600, fontSize: 14, cursor: 'pointer', fontFamily: 'inherit' }}>
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
            <div style={{ fontSize: 12.5, color: T.text3, marginBottom: 14 }}>Books the consignment now; the carrier collects at the time you choose.</div>
            <label style={{ fontSize: 12, fontWeight: 650, color: T.text2, display: 'block', marginBottom: 5 }}>Collection time</label>
            <input type="datetime-local" value={laterTime} min={localNow()} onChange={e => setLaterTime(e.target.value)}
              className="al-focus"
              style={{ width: '100%', boxSizing: 'border-box', background: T.bg3, border: '1px solid transparent', color: T.text, borderRadius: RADIUS.sm, padding: '11px 13px', fontSize: 16, outline: 'none', fontFamily: 'inherit', colorScheme: 'dark', marginBottom: 12, minHeight: 44 }}/>
            <label style={{ fontSize: 12, fontWeight: 650, color: T.text2, display: 'block', marginBottom: 5 }}>Pack as</label>
            <select value={packMode} onChange={e => setPackMode(e.target.value)}
              className="al-focus"
              style={{ width: '100%', boxSizing: 'border-box', background: T.bg3, border: '1px solid transparent', color: T.text, borderRadius: RADIUS.sm, padding: '11px 13px', fontSize: 16, outline: 'none', fontFamily: 'inherit', marginBottom: 16, minHeight: 44 }}>
              <option value="auto">Auto (weight/volume)</option>
              <option value="cartons">Cartons</option>
              <option value="pallet">Pallet</option>
            </select>
            <button disabled={!laterTime || bookingBusy} onClick={() => { setLaterOpen(false); bookViaMachShip(false, laterTime) }}
              className="al-press al-focus al-primary"
              style={{ width: '100%', minHeight: 50, borderRadius: RADIUS.pill, border: 'none', background: (!laterTime || bookingBusy) ? T.bg4 : A.accent, color: (!laterTime || bookingBusy) ? T.text3 : '#fff', fontWeight: 700, fontSize: 15.5, cursor: (!laterTime || bookingBusy) ? 'not-allowed' : 'pointer', fontFamily: 'inherit', marginBottom: 8 }}>
              Book for this time
            </button>
            <button onClick={() => setLaterOpen(false)} className="al-press al-focus" style={{ width: '100%', background: 'none', border: 'none', color: T.text3, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit', padding: 6 }}>Cancel</button>
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
function DropShipCard({ order, canAdmin, onReloaded, onFlash }: {
  order: OrderDetail
  canAdmin: boolean         // admin:b2b - raising and re-sending a PO
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
      {err && <div style={{fontSize:12.5, color:A.bad, marginBottom:10, lineHeight:1.5}}>{err}</div>}
      {raised.length > 0 ? (
        <div style={{display:'flex', flexDirection:'column', gap:6, marginBottom:10}}>
          {raised.map((po, i) => (
            <div key={i} style={{display:'flex', alignItems:'center', gap:8, fontSize:12, flexWrap:'wrap'}}>
              <span style={{color:T.text}}>{po.supplier_name}</span>
              <span style={{flex:1}}/>
              <span style={{fontFamily:'monospace', color:T.text2}}>{po.myob_po_number || po.myob_po_uid?.slice(0, 8) || 'PO'}</span>
              <span style={{color:T.text3}}>{po.line_count} line{po.line_count === 1 ? '' : 's'}</span>
              {po.email_status === 'sent'    && <span title={po.emailed_to || ''} style={{color:A.good}}>emailed</span>}
              {po.email_status === 'no_email'&& <span title="No email on the MYOB supplier card" style={{color:A.warn}}>no email</span>}
              {po.email_status === 'failed'  && <span style={{color:A.bad}}>email failed</span>}
              {canAdmin && <button
                onClick={() => resend(po.supplier_uid)}
                disabled={resendingUid === po.supplier_uid}
                title="Re-send the PO email to this supplier"
                className="al-press al-focus al-ghost"
                style={{background:'none', border:'1px solid transparent', color:T.text2, borderRadius:RADIUS.pill, padding:'3px 10px', fontSize:12, fontWeight:600, cursor: resendingUid === po.supplier_uid ? 'wait' : 'pointer', fontFamily:'inherit'}}>
                {resendingUid === po.supplier_uid ? 'Sending…' : 'Re-send'}
              </button>}
            </div>
          ))}
        </div>
      ) : (
        <div style={{fontSize:12, color:T.text3, marginBottom:10}}>No POs raised yet.</div>
      )}
      {canAdmin && (
        <button
          onClick={() => raise(alreadyRaised)}
          disabled={busy}
          className="al-press al-focus"
          style={{padding:'7px 14px', borderRadius:RADIUS.pill, border:'1px solid transparent', background:alpha(A.accent,'15'), color:A.accent, fontSize:12.5, minHeight:32, cursor: busy ? 'wait' : 'pointer', fontFamily:'inherit', fontWeight:600}}>
          {busy ? 'Raising…' : alreadyRaised ? 'Re-raise drop-ship PO' : 'Raise drop-ship PO'}
        </button>
      )}
    </Card>
  )
}

// Ship now opens this instead of a yes/no dialog: it is both the pickup
// chooser and the confirmation (Chris 2026-09-01 - "Ship now and then a window
// pops up to set your time"). The time is OPTIONAL and defaults to the
// carrier's next available window, which is exactly what Ship now did before,
// so nothing is blocked when someone is despatching at 4:55pm.
function PickupModal({ consignment, busy, onClose, onConfirm }: {
  consignment: string; busy: boolean; onClose: () => void; onConfirm: (pickupAt: string | null) => void
}) {
  const [mode, setMode] = useState<'auto' | 'choose'>('auto')
  const [date, setDate] = useState(new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Brisbane' }))
  const [time, setTime] = useState('09:00')
  const chosen = mode === 'choose' && date && time ? `${date}T${time}` : null
  const canGo = mode === 'auto' || !!chosen

  const row = (active: boolean): React.CSSProperties => ({
    display: 'flex', alignItems: 'flex-start', gap: 10, padding: '11px 12px',
    border: `1px solid ${active ? A.accent : T.border2}`, borderRadius: 8,
    background: active ? alpha(A.accent, '10') : T.bg2, cursor: 'pointer', marginBottom: 8,
  })

  return (
    <Backdrop onClose={onClose}>
      <h2 style={modalTitle()}>Ship now</h2>
      <p style={modalDesc()}>
        Manifests consignment <strong>{consignment || 'this order'}</strong> with the carrier, raises the MYOB tax
        invoice, prints it and emails the distributor. It can&rsquo;t be undone from here.
      </p>

      <label style={row(mode === 'auto')} onClick={() => setMode('auto')}>
        <input type="radio" checked={mode === 'auto'} onChange={() => setMode('auto')} style={{ marginTop: 3 }} />
        <span>
          <span style={{ fontSize: 13, fontWeight: 600, color: T.text }}>Carrier&rsquo;s next available pickup</span>
          <span style={{ display: 'block', fontSize: 11.5, color: T.text3, lineHeight: 1.5, marginTop: 2 }}>
            MachShip books its next window, rolling to the next business day if today&rsquo;s cut-off has passed.
          </span>
        </span>
      </label>

      <label style={row(mode === 'choose')} onClick={() => setMode('choose')}>
        <input type="radio" checked={mode === 'choose'} onChange={() => setMode('choose')} style={{ marginTop: 3 }} />
        <span style={{ flex: 1 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: T.text }}>Choose a time</span>
          <span style={{ display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
            <input type="date" value={date} onChange={e => { setMode('choose'); setDate(e.target.value) }}
              style={{ background: T.bg3, border: `1px solid ${T.border2}`, borderRadius: 6, color: T.text, fontSize: 12.5, padding: '6px 9px', fontFamily: 'inherit' }} />
            <input type="time" value={time} onChange={e => { setMode('choose'); setTime(e.target.value) }}
              style={{ background: T.bg3, border: `1px solid ${T.border2}`, borderRadius: 6, color: T.text, fontSize: 12.5, padding: '6px 9px', fontFamily: 'inherit' }} />
          </span>
          <span style={{ display: 'block', fontSize: 11.5, color: T.text3, lineHeight: 1.5, marginTop: 6 }}>
            Brisbane time, sent as-is. If the carrier refuses it (TNT collects from Burnside until 2:00pm)
            you&rsquo;ll get their reason back.
          </span>
        </span>
      </label>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
        <button onClick={onClose} className="al-press al-focus al-ghost"
          style={{ background: 'transparent', border: `1px solid ${T.border2}`, borderRadius: 8, color: T.text2, fontSize: 13, padding: '8px 14px', cursor: 'pointer', fontFamily: 'inherit' }}>
          Cancel
        </button>
        <button onClick={() => onConfirm(chosen)} disabled={busy || !canGo} className="al-press al-focus"
          style={{ background: A.accent, border: 'none', borderRadius: 8, color: '#fff', fontSize: 13, fontWeight: 600, padding: '8px 16px', cursor: busy || !canGo ? 'not-allowed' : 'pointer', opacity: busy || !canGo ? 0.6 : 1, fontFamily: 'inherit' }}>
          {busy ? 'Shipping…' : 'Ship now'}
        </button>
      </div>
    </Backdrop>
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
      <h2 style={modalTitle()}>{order.shipped_at ? 'Edit shipping' : 'Book Shipment / mark as shipped'}</h2>
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
            style={{flex:1, fontSize:12.5, color:T.text2}}/>
          {labelName && <span style={{fontSize:12, color:T.text3}}>{labelName}</span>}
        </div>
        {labelErr && <div style={{marginTop:4, fontSize:12, color:A.bad}}>{labelErr}</div>}
        {order.label_pdf_path && !labelB64 && (
          <div style={{marginTop:4, fontSize:12, color:T.text3}}>A label is already attached. Pick a new file to replace it.</div>
        )}
      </Field>

      <ModalButtons>
        <button onClick={onClose} disabled={busy} className="al-press al-focus" style={modalBtnSecondary()}>Cancel</button>
        <button
          onClick={() => onConfirm({
            carrier: carrier.trim(),
            tracking_number: tracking.trim(),
            tracking_url: trackingUrl.trim() || undefined,
            freight_cost_ex_gst: cost ? Number(cost) : undefined,
            label_pdf_base64: labelB64 || undefined,
            label_filename: labelName || undefined,
          })}
          disabled={!ok || busy} className="al-press al-focus al-primary" style={modalBtnPrimary(ok && !busy, A.accent)}>
          {busy ? 'Saving…' : order.shipped_at ? 'Save shipping' : 'Mark as shipped'}
        </button>
      </ModalButtons>
    </Backdrop>
  )
}

// Refund amount for qty units of a line — MUST mirror the server's pricing
// exactly (refund.ts): a whole untouched line uses the stored checkout values;
// partial quantities re-derive from the unit price with per-line rounding.
function lineRefundInc(ln: OrderLine, qty: number): number {
  if (qty === ln.qty && Number(ln.refunded_qty || 0) === 0) return round2x(ln.line_total_inc)
  const ex = round2x(ln.unit_trade_price_ex_gst * qty)
  const gst = ln.is_taxable !== false ? round2x(ex * 0.10) : 0
  return round2x(ex + gst)
}

function RefundModal({ order, busy, onClose, onConfirm }: { order: OrderDetail; busy: boolean; onClose: () => void; onConfirm: (amount: number | null, reason: string | undefined, notes: string | undefined, lines?: Array<{ line_id: string; qty: number }>) => void }) {
  const remaining = Math.max(0, order.total_inc - Number(order.refunded_total || 0))
  const [mode, setMode]     = useState<'full' | 'items' | 'partial'>('full')
  const [amount, setAmount] = useState<string>(remaining.toFixed(2))
  const [reason, setReason] = useState<string>('requested_by_customer')
  const [notes, setNotes]   = useState<string>('')
  // Items mode: selected line_id → units to refund
  const [sel, setSel]       = useState<Record<string, number>>({})

  const itemsTotal = round2x(order.lines.reduce((s, ln) => sel[ln.id] ? s + lineRefundInc(ln, sel[ln.id]) : s, 0))
  const selCount   = Object.keys(sel).length

  const amt = mode === 'full' ? null : mode === 'items' ? itemsTotal : (Number(amount) || 0)
  const finalAmount = amt === null ? remaining : amt
  const valid = (mode !== 'items' || selCount > 0) && finalAmount > 0 && finalAmount <= remaining + 0.005

  return (
    <Backdrop onClose={onClose}>
      <h2 style={modalTitle()}>Refund order</h2>
      <p style={modalDesc()}>
        Refundable: <strong style={{color:T.text}}>${money(remaining)}</strong> (paid: ${money(order.total_inc)} · already refunded: ${money(Number(order.refunded_total || 0))})
      </p>

      {/* Seg-style mode picker */}
      <div style={{display:'flex',background:T.bg3,borderRadius:RADIUS.pill,padding:3,marginBottom:14}}>
        <button onClick={() => setMode('full')}    className="al-press al-focus" style={modeBtn(mode === 'full',    A.bad)}>Full refund</button>
        <button onClick={() => setMode('items')}   className="al-press al-focus" style={modeBtn(mode === 'items',   A.bad)}>Items</button>
        <button onClick={() => setMode('partial')} className="al-press al-focus" style={modeBtn(mode === 'partial', A.bad)}>Partial</button>
      </div>

      {mode === 'items' && (
        <div style={{marginBottom:14}}>
          <div style={{border:`1px solid ${T.border}`,borderRadius:RADIUS.sm,maxHeight:280,overflowY:'auto'}}>
            {order.lines.map((ln, i) => {
              const maxQty = ln.qty - Number(ln.refunded_qty || 0)
              const done = maxQty <= 0
              const checked = ln.id in sel
              const qty = sel[ln.id] || maxQty
              const setQty = (q: number) => setSel(s => ({ ...s, [ln.id]: Math.min(maxQty, Math.max(1, q)) }))
              return (
                <div key={ln.id} style={{display:'flex',alignItems:'center',gap:10,padding:'9px 10px',borderTop: i > 0 ? `1px solid ${T.border}` : 'none',opacity: done ? 0.5 : 1}}>
                  <input type="checkbox" disabled={done || busy} checked={checked}
                    onChange={e => setSel(s => { const n = { ...s }; if (e.target.checked) n[ln.id] = maxQty; else delete n[ln.id]; return n })}
                    style={{cursor: done ? 'default' : 'pointer',flexShrink:0}}/>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontSize:13,color:T.text,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{ln.name}</div>
                    <div style={{fontSize:12,color:T.text3,fontFamily:'monospace'}}>
                      {ln.sku}
                      {done ? ' · Refunded' : Number(ln.refunded_qty || 0) > 0 ? ` · refundable ${maxQty} of ${ln.qty}` : ''}
                    </div>
                  </div>
                  {checked && !done && (
                    <div style={{display:'flex',alignItems:'center',gap:6,flexShrink:0}}>
                      <button onClick={() => setQty(qty - 1)} disabled={busy || qty <= 1} style={stepBtn(qty > 1)}>−</button>
                      <span style={{fontSize:13,fontVariantNumeric:'tabular-nums',minWidth:18,textAlign:'center'}}>{qty}</span>
                      <button onClick={() => setQty(qty + 1)} disabled={busy || qty >= maxQty} style={stepBtn(qty < maxQty)}>+</button>
                    </div>
                  )}
                  <div style={{width:76,textAlign:'right',fontFamily:'monospace',fontSize:12,color: checked ? T.text : T.text3,flexShrink:0}}>
                    {done ? '—' : `$${money(lineRefundInc(ln, checked ? qty : maxQty))}`}
                  </div>
                </div>
              )
            })}
            <div style={{display:'flex',justifyContent:'space-between',gap:10,padding:'9px 10px',borderTop:`1px solid ${T.border2}`,fontSize:13}}>
              <span style={{color:T.text2}}>Refund total ({selCount} {selCount === 1 ? 'line' : 'lines'})</span>
              <strong style={{fontFamily:'monospace',color: itemsTotal > remaining + 0.005 ? A.bad : T.text}}>${money(itemsTotal)}</strong>
            </div>
          </div>
          <div style={{fontSize:12,color:T.text3,marginTop:6}}>
            Freight and card surcharge aren't part of item refunds — use Partial for those.
          </div>
        </div>
      )}

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
        <button onClick={onClose} disabled={busy} className="al-press al-focus" style={modalBtnSecondary()}>Cancel</button>
        <button onClick={() => onConfirm(
            mode === 'full' ? null : finalAmount,
            reason,
            notes || undefined,
            mode === 'items' ? Object.entries(sel).map(([line_id, qty]) => ({ line_id, qty })) : undefined,
          )}
          disabled={!valid || busy} className="al-press al-focus al-primary" style={modalBtnPrimary(valid && !busy, A.bad)}>
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
        <label style={{display:'flex',gap:10,padding:12,borderRadius:RADIUS.sm,border:`1px solid ${alsoRefund ? A.bad : T.border2}`,background:alsoRefund ? alpha(A.bad,'10') : 'transparent',cursor:'pointer',marginBottom:14}}>
          <input type="checkbox" checked={alsoRefund} onChange={e => setAlsoRefund(e.target.checked)} style={{marginTop:2}}/>
          <span style={{fontSize:13,color:T.text2,lineHeight:1.5}}>
            Also refund the remaining <strong style={{color:T.text}}>${money(remaining)}</strong> via Stripe.
          </span>
        </label>
      )}

      {isPaid && !canRefund && (
        <div style={{marginBottom:14}}>
          <Banner tone="warn">
            This order is paid, but you don't have refund permissions. You can cancel without refund (money stays in Stripe), or ask an admin to issue the refund first.
          </Banner>
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
        <button onClick={onClose} disabled={busy} className="al-press al-focus" style={modalBtnSecondary()}>Don't cancel</button>
        <button onClick={() => onConfirm(alsoRefund, alsoRefund ? reason : undefined, notes || undefined)}
          disabled={busy} className="al-press al-focus al-primary" style={modalBtnPrimary(!busy, A.bad)}>
          {busy ? 'Cancelling…' : alsoRefund ? `Refund & cancel` : 'Cancel order'}
        </button>
      </ModalButtons>
    </Backdrop>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label style={{display:'flex',flexDirection:'column',gap:5,marginBottom:14}}>
      <span style={{fontSize:12,color:T.text2,fontWeight:650}}>{label}</span>
      {children}
      {hint && <span style={{fontSize:12,color:T.text3,lineHeight:1.45}}>{hint}</span>}
    </label>
  )
}

function ModalButtons({ children }: { children: React.ReactNode }) {
  return (
    <div style={{display:'flex',gap:8,justifyContent:'flex-end',marginTop:18}}>{children}</div>
  )
}

// ─── Style helpers ─────────────────────────────────────────────────────

// Full-width pill action. Primary = solid accent; a colour on a non-primary
// button gives it that colour's tinted-pill treatment (refund/cancel = bad).
function actionBtn(primary: boolean, busy: boolean, color?: string): React.CSSProperties {
  const c = color || A.accent
  return {
    width:'100%',padding:'10px 16px',borderRadius:RADIUS.pill,marginBottom:6,
    border:'1px solid transparent',
    background: primary && !busy ? c : color ? alpha(c,'14') : T.bg3,
    color: primary && !busy ? '#fff' : (color || T.text2),
    fontSize:13,fontWeight:600,minHeight:40,
    cursor: busy ? 'wait' : 'pointer',
    fontFamily:'inherit',
    opacity: busy ? 0.6 : 1,
  }
}

function modalTitle(): React.CSSProperties {
  return { fontSize:17,fontWeight:700,margin:'0 0 6px',color:T.text,letterSpacing:'-0.01em' }
}
function modalDesc(): React.CSSProperties {
  return { fontSize:13,color:T.text3,margin:'0 0 18px',lineHeight:1.5 }
}
// Kit inputStyle look at modal density.
function modalInput(): React.CSSProperties {
  return {
    width:'100%',boxSizing:'border-box',
    background:T.bg3,border:'1px solid transparent',color:T.text,
    borderRadius:RADIUS.sm,padding:'10px 12px',fontSize:14,minHeight:40,
    outline:'none',fontFamily:'inherit',
  }
}
function modalBtnPrimary(enabled: boolean, color: string): React.CSSProperties {
  return {
    padding:'10px 18px',borderRadius:RADIUS.pill,
    border:'1px solid transparent',
    background: enabled ? color : T.bg3,
    color: enabled ? '#fff' : T.text3,
    fontSize:13,fontWeight:600,minHeight:40,
    cursor: enabled ? 'pointer' : 'not-allowed',
    fontFamily:'inherit',
  }
}
function modalBtnSecondary(): React.CSSProperties {
  return {
    padding:'10px 18px',borderRadius:RADIUS.pill,
    border:'1px solid transparent',
    background:T.bg3,color:T.text,
    fontSize:13,fontWeight:600,minHeight:40,fontFamily:'inherit',cursor:'pointer',
  }
}
function stepBtn(enabled: boolean): React.CSSProperties {
  return {
    width:26,height:26,padding:0,borderRadius:RADIUS.pill,lineHeight:1,
    border:'1px solid transparent',
    background:T.bg3,color: enabled ? T.text : T.text3,
    fontSize:14,fontFamily:'inherit',
    display:'inline-flex',alignItems:'center',justifyContent:'center',
    cursor: enabled ? 'pointer' : 'default',
  }
}
// Segmented-control option pill (container supplies the bg3 track).
function modeBtn(active: boolean, _color: string): React.CSSProperties {
  return {
    flex:1,padding:'9px 6px',borderRadius:RADIUS.pill,minHeight:38,
    border:'none',
    background: active ? T.bg4 : 'transparent',
    color: active ? T.text : T.text2,
    boxShadow: active ? SHADOW.sm : 'none',
    fontSize:12.5,fontWeight:600,textAlign:'center',
    cursor:'pointer',fontFamily:'inherit',
  }
}
function th(width?: number): React.CSSProperties {
  return {
    fontSize:12,color:T.text3,padding:'9px 12px',
    textAlign:'left',fontWeight:600,
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
