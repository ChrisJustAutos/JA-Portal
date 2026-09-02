// pages/b2b/orders/[id].tsx
//
// Order detail. Also serves as the Stripe Checkout success-redirect target:
// when the URL contains `?session_id=cs_...`, we know the user just came
// back from Stripe.
//
// Eventual-consistency note: Stripe webhooks are usually delivered within
// 1-2 seconds, but can take longer. If the user lands here before the
// webhook fires, the order will still show 'pending_payment' for a moment.
// We auto-refresh until status is 'paid' (or 5 attempts elapse).
//
// Look: condensed single column (Chris: "keep order page condensed and
// simple") — a delivery timeline tells the story, tracking is the primary
// action while in transit, items + totals share one card.

import { useEffect, useState } from 'react'
import Head from 'next/head'
import { useRouter } from 'next/router'
import type { GetServerSideProps } from 'next'
import B2BLayout from '../../../components/b2b/B2BLayout'
import { requireB2BPageAuth } from '../../../lib/b2bAuthServer'
import { T, alpha } from '../../../lib/ui/theme'
import { A, RADIUS, Banner, Card, Row, StatusPill, btnStyle, orderStatusColor, orderStatusLabel } from '../../../components/b2b/ui'
import { useIsMobile } from '../../../lib/useIsMobile'

interface Props {
  b2bUser: {
    id: string
    email: string
    fullName: string | null
    role: 'owner' | 'member'
    distributor: { id: string; displayName: string }
  }
}

interface OrderDetail {
  id: string
  order_number: string
  status: string
  placed_at: string
  paid_at: string | null
  shipped_at: string | null
  delivered_at: string | null
  currency: string
  subtotal_ex_gst: number
  gst: number
  card_fee_inc: number
  total_inc: number
  stripe: {
    checkout_session_id: string | null
    payment_intent_id: string | null
    payment_status: string | null
    receipt_url: string | null
  }
  myob: {
    invoice_uid: string | null
    invoice_number: string | null
    written_at: string | null
    write_error: string | null
  }
  shipping?: {
    carrier: string | null
    method_label: string | null
    tracking_number: string | null
    tracking_url: string | null
    consignment_number: string | null
    eta_at: string | null
    status: string | null
    freight_cost_ex_gst: number | null
  }
  lines: Array<{
    id: string
    sku: string
    name: string
    qty: number
    unit_trade_price_ex_gst: number
    line_subtotal_ex_gst: number
    line_gst: number
    line_total_inc: number
    is_taxable: boolean
  }>
}

export default function OrderDetailPage({ b2bUser }: Props) {
  const isMobile = useIsMobile()
  const router = useRouter()
  const orderId = String(router.query.id || '')
  const sessionIdParam = router.query.session_id ? String(router.query.session_id) : null
  const justReturnedFromStripe = !!sessionIdParam

  const [order, setOrder] = useState<OrderDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pollCount, setPollCount] = useState(0)

  async function load() {
    if (!orderId) return
    setError(null)
    try {
      const url = sessionIdParam
        ? `/api/b2b/orders/${orderId}?session_id=${encodeURIComponent(sessionIdParam)}`
        : `/api/b2b/orders/${orderId}`
      const r = await fetch(url, { credentials: 'same-origin' })
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`)
      const j = await r.json()
      setOrder(j.order)
    } catch (e: any) {
      setError(e?.message || String(e))
    }
  }
  useEffect(() => { load() }, [orderId])

  // If we just got back from Stripe but the order still shows pending_payment,
  // poll every 2s up to 5 times — gives the webhook time to fire.
  useEffect(() => {
    if (!justReturnedFromStripe) return
    if (!order) return
    if (order.status !== 'pending_payment') return
    if (pollCount >= 5) return
    const t = setTimeout(() => {
      setPollCount(c => c + 1)
      load()
    }, 2000)
    return () => clearTimeout(t)
  }, [order, justReturnedFromStripe, pollCount])

  // Totals are presented inc GST (see the totals block). Freight is folded into
  // subtotal_ex_gst at checkout, so recover it as the remainder: items inc +
  // freight inc == subtotal_ex_gst + gst, no matter what tax code each line
  // carries. Deriving it beats re-taxing freight_cost_ex_gst by a fixed 10%.
  const itemsInc = (order?.lines || []).reduce((t, l) => t + Number(l.line_total_inc || 0), 0)
  const freightInc = order
    ? Math.round((Number(order.subtotal_ex_gst) + Number(order.gst) - itemsInc) * 100) / 100
    : 0

  const terminal = order && (order.status === 'cancelled' || order.status === 'refunded')
  const inTransit = order && order.status === 'shipped'
  const trackingUrl = order?.shipping?.tracking_url || null

  return (
    <>
      <Head><title>Order {order?.order_number || ''} · Just Autos B2B</title></Head>
      <B2BLayout user={b2bUser} active="orders">
        <div style={{maxWidth:660, margin:'0 auto'}}>

          {error && <div style={{marginBottom:14}}><Banner tone="error">{error}</Banner></div>}

          {!order && !error && (
            <div style={{padding:44,textAlign:'center',color:T.text3,fontSize:13.5}}>Loading…</div>
          )}

          {order && (
            <>
              {/* Heading */}
              <div style={{marginBottom:16}}>
                <a href="/b2b/orders" style={{fontSize:13,color:T.text3,textDecoration:'none'}}>‹ Orders</a>
                <div style={{display:'flex',alignItems:'center',gap:12,flexWrap:'wrap',margin:'8px 0 4px'}}>
                  <h1 style={{fontSize:24,fontWeight:700,margin:0,letterSpacing:'-0.02em'}}>{order.order_number}</h1>
                  <StatusPill color={orderStatusColor(order.status)}>{orderStatusLabel(order.status)}</StatusPill>
                </div>
                <div style={{fontSize:12.5,color:T.text3}}>Placed {formatDate(order.placed_at)}</div>
              </div>

              {/* Just-paid success banner */}
              {justReturnedFromStripe && order.status === 'paid' && (
                <div style={{marginBottom:14}}>
                  <Banner tone="success">
                    <div style={{fontWeight:600}}>Payment received</div>
                    <div style={{color:T.text2,marginTop:2}}>
                      A receipt has been emailed to {b2bUser.email}. We'll process and dispatch your order shortly.
                    </div>
                  </Banner>
                </div>
              )}

              {/* Webhook-pending banners */}
              {justReturnedFromStripe && order.status === 'pending_payment' && pollCount < 5 && (
                <div style={{marginBottom:14}}>
                  <Banner tone="warn">
                    <div style={{fontWeight:600}}>Confirming your payment with Stripe…</div>
                    <div style={{color:T.text2,marginTop:2}}>This usually takes a couple of seconds. Please don't close this page.</div>
                  </Banner>
                </div>
              )}
              {justReturnedFromStripe && order.status === 'pending_payment' && pollCount >= 5 && (
                <div style={{marginBottom:14}}>
                  <Banner tone="warn">
                    Stripe confirmation is taking longer than expected. Your payment is likely fine — refresh in a minute,
                    or contact your account manager if it doesn't update.
                  </Banner>
                </div>
              )}

              {/* Delivery story: timeline + tracking + shipping meta */}
              <Card style={{marginBottom:14}}>
                {terminal ? (
                  <div style={{fontSize:13.5,color:T.text2,lineHeight:1.5}}>
                    This order was {order.status === 'cancelled' ? 'cancelled' : 'refunded'}.
                    {order.status === 'refunded' && ' The refund has been returned to your original payment method.'}
                    {' '}Questions? Contact your account manager.
                  </div>
                ) : (
                  <>
                    <Timeline order={order}/>
                    {trackingUrl && (
                      <div style={{marginTop:16}}>
                        <a href={trackingUrl} target="_blank" rel="noopener noreferrer"
                          style={{...btnStyle(inTransit ? 'primary' : 'secondary', 'md'), textDecoration:'none', width:'100%', boxSizing:'border-box'}}>
                          {order.shipping?.carrier ? `Track with ${order.shipping.carrier}` : 'Track shipment'}
                        </a>
                      </div>
                    )}
                    {(order.shipping?.tracking_number || order.shipping?.consignment_number || order.shipping?.method_label) && (
                      <div style={{marginTop:12,paddingTop:10,borderTop:`1px solid ${T.border}`}}>
                        {order.shipping?.method_label && <Row label="Service" value={order.shipping.method_label} muted/>}
                        {order.shipping?.tracking_number && <Row label="Tracking #" value={order.shipping.tracking_number} muted/>}
                        {order.shipping?.consignment_number && <Row label="Consignment" value={order.shipping.consignment_number} muted/>}
                        {order.shipping?.eta_at && <Row label="Estimated delivery" value={formatDateShort(order.shipping.eta_at)} muted/>}
                      </div>
                    )}
                  </>
                )}
              </Card>

              {/* Items + totals — one condensed card */}
              <Card pad={false} style={{marginBottom:14}}>
                <div style={{padding:'6px 0'}}>
                  {order.lines.map((l, i) => (
                    <div key={l.id} style={{
                      display:'flex',alignItems:'baseline',gap:12,
                      padding: isMobile ? '11px 14px' : '11px 20px',
                      borderTop: i === 0 ? 'none' : `1px solid ${T.border}`,
                    }}>
                      <div style={{flex:1,minWidth:0}}>
                        {/* overflowWrap is the fix for the sideways scroll: a long
                            product name has no space to break at, so the row grew
                            wider than the phone and took the page with it. The
                            flex/minWidth:0 pair was already right — it was the
                            text that could not be broken. */}
                        <div style={{fontSize:14,color:T.text,fontWeight:550,lineHeight:1.35,overflowWrap:'anywhere'}}>{l.name}</div>
                        <div style={{fontSize:12,color:T.text3,marginTop:2,fontVariantNumeric:'tabular-nums',overflowWrap:'anywhere'}}>
                          {l.sku} · {l.qty} × ${lineUnitInc(l).toFixed(2)}
                        </div>
                      </div>
                      <div style={{fontSize:14,color:T.text,fontWeight:600,fontVariantNumeric:'tabular-nums',flexShrink:0}}>
                        ${Number(l.line_total_inc).toFixed(2)}
                      </div>
                    </div>
                  ))}
                </div>
                <div style={{padding:'12px 20px 16px',borderTop:`1px solid ${T.border2}`}}>
                  {/* Inc GST throughout, matching the catalogue and the cart —
                      the portal quotes distributors GST-inclusive prices, so an
                      ex-GST subtotal here read like a different (cheaper) order.
                      Freight is folded into subtotal_ex_gst at checkout, so it
                      is recovered as the remainder rather than re-taxed: items
                      inc + freight inc == subtotal_ex_gst + gst, whatever tax
                      code the individual lines carry. */}
                  <Row label="Items (inc GST)" value={`$${itemsInc.toFixed(2)}`} muted/>
                  {freightInc > 0.005 && <Row label="Freight (inc GST)" value={`$${freightInc.toFixed(2)}`} muted/>}
                  {Number(order.card_fee_inc) > 0 && <Row label="Card surcharge" value={`$${Number(order.card_fee_inc).toFixed(2)}`} muted/>}
                  {/* HERO TOTAL. This is the number the distributor came to the
                      page for, and it used to be one 17px row among four. Big,
                      tabular, tight tracking, on desktop as well as mobile —
                      Chris 2026-09-02. The itemisation above it stays muted so
                      the hierarchy does the reading for you. */}
                  <div style={{
                    marginTop: 10, paddingTop: 12, borderTop: `1px solid ${T.border}`,
                    display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap',
                  }}>
                    <div style={{minWidth:0}}>
                      <div style={{
                        fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase',
                        color: T.text3, marginBottom: 2,
                      }}>
                        {order.paid_at ? 'Total paid' : 'Order total'}
                      </div>
                      <div style={{fontSize:12,color:T.text3}}>
                        Includes ${Number(order.gst).toFixed(2)} GST
                      </div>
                    </div>
                    <div style={{
                      fontSize: isMobile ? 34 : 40, lineHeight: 1,
                      fontWeight: 750, letterSpacing: '-0.03em',
                      color: T.text, fontVariantNumeric: 'tabular-nums',
                      marginLeft: 'auto',
                    }}>
                      ${Number(order.total_inc).toFixed(2)}
                    </div>
                  </div>
                </div>
              </Card>

              {/* Paper trail */}
              <Card>
                <Row
                  label="Tax invoice"
                  value={order.myob.invoice_number
                    ? `${order.myob.invoice_number}${order.myob.written_at ? ` · issued ${formatDateShort(order.myob.written_at)}` : ''}`
                    : order.status === 'paid' ? 'Being generated…' : 'Generated after payment'}
                  muted={!order.myob.invoice_number}/>
                {order.stripe.receipt_url && (
                  <div style={{marginTop:6}}>
                    <a href={order.stripe.receipt_url} target="_blank" rel="noopener noreferrer"
                      style={{fontSize:13,color:A.accent,textDecoration:'none',fontWeight:550}}>
                      View Stripe payment receipt ↗
                    </a>
                  </div>
                )}
              </Card>
            </>
          )}

        </div>
      </B2BLayout>
    </>
  )
}

// ── Delivery timeline ───────────────────────────────────────────────────
// Placed → Paid → Prepared → Shipped → Delivered. "Prepared" covers the
// picking/packed stages (no per-stage timestamps are exposed to distributors).
function Timeline({ order }: { order: OrderDetail }) {
  const preparing = order.status === 'picking' || order.status === 'packed'
  const shippedOn = ['shipped', 'delivered', 'completed'].includes(order.status) || !!order.shipped_at
  const delivered = ['delivered', 'completed'].includes(order.status) || !!order.delivered_at

  const steps: Array<{ label: string; done: boolean; date?: string | null }> = [
    { label: 'Placed',    done: true,                        date: order.placed_at },
    { label: 'Paid',      done: !!order.paid_at,             date: order.paid_at },
    { label: 'Prepared',  done: shippedOn },
    { label: 'Shipped',   done: shippedOn,                   date: order.shipped_at },
    { label: 'Delivered', done: delivered,                   date: order.delivered_at },
  ]
  // Current = the first not-done step after the last done one (the stage in
  // progress right now); "Prepared" is current while picking/packed.
  const lastDone = steps.reduce((acc, s, i) => (s.done ? i : acc), 0)
  const currentIdx = preparing ? 2 : Math.min(lastDone + 1, steps.length - 1)

  return (
    <div style={{display:'flex'}}>
      {steps.map((s, i) => {
        const isCurrent = !s.done && i === currentIdx
        const c = s.done ? A.accent : T.text3
        return (
          <div key={s.label} style={{flex:1,display:'flex',flexDirection:'column',alignItems:'center',gap:6,position:'relative'}}>
            {i > 0 && (
              <span style={{
                position:'absolute', top:5, right:'50%', width:'100%', height:2,
                background: s.done ? A.accent : T.bg4,
              }}/>
            )}
            <span style={{
              width:12, height:12, borderRadius:RADIUS.pill, zIndex:1,
              background: s.done ? A.accent : T.bg4,
              boxShadow: isCurrent ? `0 0 0 4px ${alpha(A.accent, '30')}` : undefined,
            }}/>
            <span style={{
              fontSize:11.5, fontWeight: s.done || isCurrent ? 650 : 500,
              color: s.done ? T.text : isCurrent ? T.text2 : T.text3,
              textAlign:'center',
            }}>
              {s.label}
            </span>
            <span style={{fontSize:11.5,color:T.text3,fontVariantNumeric:'tabular-nums',textAlign:'center',minHeight:14}}>
              {s.date
                ? formatDateShort(s.date)
                : s.label === 'Delivered' && order.shipping?.eta_at && !s.done
                  ? `ETA ${formatDateShort(order.shipping.eta_at)}`
                  : ''}
            </span>
          </div>
        )
      })}
    </div>
  )
}

// Per-unit price inc GST, derived from the line totals so it matches what
// was actually charged (unit_trade_price is ex GST).
function lineUnitInc(l: OrderDetail['lines'][number]): number {
  if (l.qty > 0) return Math.round((Number(l.line_total_inc) / l.qty) * 100) / 100
  return Number(l.line_total_inc)
}

function formatDate(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleString('en-AU', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  })
}

function formatDateShort(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })
}

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  return await requireB2BPageAuth(ctx) as any
}
