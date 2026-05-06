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

import { useEffect, useState } from 'react'
import Head from 'next/head'
import { useRouter } from 'next/router'
import type { GetServerSideProps } from 'next'
import B2BLayout from '../../../components/b2b/B2BLayout'
import { requireB2BPageAuth } from '../../../lib/b2bAuthServer'

const T = {
  bg:'#0d0f12', bg2:'#131519', bg3:'#1a1d23', bg4:'#21252d',
  border:'rgba(255,255,255,0.07)', border2:'rgba(255,255,255,0.12)',
  text:'#e8eaf0', text2:'#8b90a0', text3:'#545968',
  blue:'#4f8ef7', teal:'#2dd4bf', green:'#34c77b',
  amber:'#f5a623', red:'#f04e4e',
}

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

  return (
    <>
      <Head><title>Order {order?.order_number || ''} · Just Autos B2B</title></Head>
      <B2BLayout user={b2bUser} active="orders">

        {error && (
          <div style={{padding:12,background:`${T.red}15`,border:`1px solid ${T.red}40`,borderRadius:7,color:T.red,fontSize:12,marginBottom:14}}>
            {error}
          </div>
        )}

        {!order && !error && (
          <div style={{padding:36,textAlign:'center',color:T.text3,fontSize:13}}>Loading…</div>
        )}

        {order && (
          <>
            {/* Top breadcrumb / heading */}
            <div style={{marginBottom:18}}>
              <a href="/b2b/orders" style={{fontSize:11,color:T.text3,textDecoration:'none'}}>← All orders</a>
              <h1 style={{fontSize:22,fontWeight:600,margin:'6px 0 4px',letterSpacing:'-0.01em'}}>
                {order.order_number}
              </h1>
              <div style={{display:'flex',alignItems:'center',gap:10,flexWrap:'wrap',fontSize:12,color:T.text3}}>
                <StatusPill status={order.status} hasError={!!order.myob.write_error}/>
                <span>· Placed {formatDate(order.placed_at)}</span>
                {order.paid_at && <span>· Paid {formatDate(order.paid_at)}</span>}
              </div>
            </div>

            {/* Just-paid success banner */}
            {justReturnedFromStripe && order.status === 'paid' && (
              <div style={{
                padding:'14px 18px',marginBottom:18,
                background:`${T.green}15`,border:`1px solid ${T.green}40`,borderRadius:8,
                display:'flex',alignItems:'center',gap:14,
              }}>
                <div style={{fontSize:24,color:T.green}}>✓</div>
                <div>
                  <div style={{fontSize:14,color:T.text,fontWeight:500}}>Payment received</div>
                  <div style={{fontSize:12,color:T.text2,marginTop:2}}>
                    A receipt has been emailed to {b2bUser.email}. We'll process and dispatch your order shortly.
                  </div>
                </div>
              </div>
            )}

            {/* Webhook-pending banner */}
            {justReturnedFromStripe && order.status === 'pending_payment' && pollCount < 5 && (
              <div style={{
                padding:'14px 18px',marginBottom:18,
                background:`${T.amber}10`,border:`1px solid ${T.amber}30`,borderRadius:8,
              }}>
                <div style={{fontSize:14,color:T.text}}>Confirming your payment with Stripe…</div>
                <div style={{fontSize:11,color:T.text3,marginTop:4}}>This usually takes a couple of seconds. Please don't close this page.</div>
              </div>
            )}

            {justReturnedFromStripe && order.status === 'pending_payment' && pollCount >= 5 && (
              <div style={{
                padding:'14px 18px',marginBottom:18,
                background:`${T.amber}15`,border:`1px solid ${T.amber}40`,borderRadius:8,
              }}>
                <div style={{fontSize:13,color:T.text}}>
                  Stripe confirmation is taking longer than expected. Your payment is likely fine — refresh in a minute, or contact your account manager if it doesn't update.
                </div>
              </div>
            )}

            {/* MYOB error banner — staff-side issue, not customer's */}
            {order.status === 'paid' && order.myob.write_error && !order.myob.invoice_number && (
              <div style={{
                padding:'12px 16px',marginBottom:18,
                background:T.bg2,border:`1px solid ${T.border}`,borderRadius:8,
                fontSize:12,color:T.text2,
              }}>
                Your order has been paid and is being processed. Invoice details will appear here once finalised.
              </div>
            )}

            {/* Two-column layout */}
            <div style={{display:'grid',gridTemplateColumns:'1fr 320px',gap:18,alignItems:'start'}}>

              {/* Lines */}
              <div style={{background:T.bg2,border:`1px solid ${T.border}`,borderRadius:10,overflow:'hidden'}}>
                <table style={{width:'100%',borderCollapse:'collapse'}}>
                  <thead>
                    <tr style={{background:T.bg3,borderBottom:`1px solid ${T.border2}`}}>
                      <Th>Item</Th>
                      <Th align="right">Qty</Th>
                      <Th align="right">Unit (ex)</Th>
                      <Th align="right">Line (ex)</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {order.lines.map(l => (
                      <tr key={l.id} style={{borderBottom:`1px solid ${T.border}`}}>
                        <Td>
                          <div style={{fontSize:12,color:T.text}}>{l.name}</div>
                          <div style={{fontSize:9,color:T.text3,fontFamily:'monospace',marginTop:1,letterSpacing:'0.04em'}}>{l.sku}</div>
                        </Td>
                        <Td align="right">{l.qty}</Td>
                        <Td align="right" muted>${Number(l.unit_trade_price_ex_gst).toFixed(2)}</Td>
                        <Td align="right">${Number(l.line_subtotal_ex_gst).toFixed(2)}</Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Totals + meta */}
              <div style={{display:'flex',flexDirection:'column',gap:14,position:'sticky',top:74}}>

                <div style={{background:T.bg2,border:`1px solid ${T.border}`,borderRadius:10,padding:'18px 20px'}}>
                  <SectionTitle>Totals</SectionTitle>
                  <Row label="Subtotal (ex GST)" value={`$${Number(order.subtotal_ex_gst).toFixed(2)}`}/>
                  <Row label="GST"                value={`$${Number(order.gst).toFixed(2)}`}/>
                  <Row label="Card surcharge"     value={`$${Number(order.card_fee_inc).toFixed(2)}`} muted/>
                  <div style={{borderTop:`1px solid ${T.border2}`,marginTop:8,paddingTop:8}}/>
                  <Row label="Total" value={`$${Number(order.total_inc).toFixed(2)}`} large/>
                </div>

                <div style={{background:T.bg2,border:`1px solid ${T.border}`,borderRadius:10,padding:'18px 20px'}}>
                  <SectionTitle>Invoice</SectionTitle>
                  {order.myob.invoice_number ? (
                    <div style={{fontSize:12,color:T.text}}>
                      MYOB Invoice <strong style={{color:T.text}}>{order.myob.invoice_number}</strong>
                      <div style={{fontSize:10,color:T.text3,marginTop:4}}>
                        Issued {formatDate(order.myob.written_at || '')}
                      </div>
                    </div>
                  ) : order.status === 'paid' ? (
                    <div style={{fontSize:11,color:T.text3}}>Generating invoice…</div>
                  ) : (
                    <div style={{fontSize:11,color:T.text3}}>Will be generated after payment</div>
                  )}
                </div>

              </div>
            </div>
          </>
        )}

      </B2BLayout>
    </>
  )
}

// ── Helpers ────────────────────────────────────────────────────────────
function Th({ children, align }: { children?: React.ReactNode; align?: 'left'|'right' }) {
  return (
    <th style={{
      textAlign: align || 'left',
      fontSize:10,fontWeight:500,color:T.text3,
      textTransform:'uppercase',letterSpacing:'0.06em',
      padding:'10px 14px',
    }}>
      {children}
    </th>
  )
}

function Td({ children, align, muted }: { children?: React.ReactNode; align?: 'left'|'right'; muted?: boolean }) {
  return (
    <td style={{
      textAlign: align || 'left',
      fontSize:12,color: muted ? T.text2 : T.text,
      padding:'12px 14px',
      fontVariantNumeric: align === 'right' ? 'tabular-nums' : undefined,
    }}>
      {children}
    </td>
  )
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div style={{fontSize:11,color:T.text3,textTransform:'uppercase',letterSpacing:'0.08em',marginBottom:12,fontWeight:500}}>
      {children}
    </div>
  )
}

function Row({ label, value, muted, large }: { label: string; value: string; muted?: boolean; large?: boolean }) {
  return (
    <div style={{
      display:'flex',justifyContent:'space-between',alignItems:'baseline',padding:'4px 0',
      fontSize: large ? 14 : 12,
      color: muted ? T.text3 : T.text2,
      fontWeight: large ? 600 : 400,
    }}>
      <span>{label}</span>
      <span style={{color: large ? T.text : 'inherit',fontVariantNumeric:'tabular-nums'}}>{value}</span>
    </div>
  )
}

function StatusPill({ status, hasError }: { status: string; hasError?: boolean }) {
  const c = colorFor(status)
  const label = labelFor(status)
  return (
    <span style={{display:'inline-flex',alignItems:'center',gap:5,fontSize:10,fontWeight:500,padding:'2px 8px',borderRadius:8,background:`${c}18`,color:c}}>
      {label}
      {hasError && status === 'paid' && <span title="MYOB writeback failed" style={{color:T.amber}}>⚠</span>}
    </span>
  )
}

function colorFor(status: string): string {
  switch (status) {
    case 'pending_payment': return T.amber
    case 'paid':            return T.green
    case 'picking':
    case 'packed':          return T.teal
    case 'shipped':         return T.blue
    case 'completed':       return T.green
    case 'cancelled':       return T.text3
    case 'refunded':        return T.red
    default:                return T.text2
  }
}

function labelFor(status: string): string {
  if (status === 'pending_payment') return 'Awaiting payment'
  return status.charAt(0).toUpperCase() + status.slice(1)
}

function formatDate(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleString('en-AU', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  })
}

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  return await requireB2BPageAuth(ctx) as any
}
