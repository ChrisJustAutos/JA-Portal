// pages/b2b/cart.tsx
//
// Distributor cart page. Lists all current cart lines with qty steppers,
// remove buttons, and a totals panel showing subtotal/GST/card-fee/total.
//
// Checkout flow:
//   - "Checkout" POSTs to /api/b2b/checkout/start
//   - On success, redirects browser to the returned Stripe URL
//   - On Stripe cancel, user lands back here with ?cancelled={order_id}
//     and we show a small "checkout cancelled" banner

import { useEffect, useState } from 'react'
import Head from 'next/head'
import { useRouter } from 'next/router'
import type { GetServerSideProps } from 'next'
import B2BLayout from '../../components/b2b/B2BLayout'
import { requireB2BPageAuth } from '../../lib/b2bAuthServer'

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

interface CartLine {
  id: string
  qty: number
  catalogue_id: string | null
  sku: string
  name: string
  image_url: string | null
  unit_price_ex_gst: number
  is_taxable: boolean
  line_subtotal_ex_gst: number
  line_gst: number
  line_total_inc_gst: number
  currently_visible: boolean
  price_changed: boolean
  stock_state: 'in_stock' | 'low_stock' | 'out_of_stock'
  stock_qty_available: number | null
}

interface CartTotals {
  subtotal_ex_gst: number
  gst: number
  subtotal_inc_gst: number
  card_fee_inc: number
  total_inc: number
}

interface CartResponse {
  cart_id: string
  lines: CartLine[]
  line_count: number
  item_count: number
  totals: CartTotals
  card_fee: { pct: number; fixed: number; note: string }
}

export default function B2BCartPage({ b2bUser }: Props) {
  const router = useRouter()
  const [data, setData] = useState<CartResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyLineId, setBusyLineId] = useState<string | null>(null)
  const [checkoutBusy, setCheckoutBusy] = useState(false)
  const [checkoutError, setCheckoutError] = useState<string | null>(null)
  const [checkoutIssues, setCheckoutIssues] = useState<string[] | null>(null)

  const cancelledOrderId = router.query.cancelled ? String(router.query.cancelled) : null

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const r = await fetch('/api/b2b/cart', { credentials: 'same-origin' })
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`)
      const j = await r.json()
      setData(j)
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [])

  async function setLineQty(line: CartLine, qty: number) {
    if (!line.catalogue_id) return
    setBusyLineId(line.id)
    try {
      const r = await fetch('/api/b2b/cart/items', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ catalogue_id: line.catalogue_id, qty }),
      })
      const j = await r.json()
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`)
      await load()
    } catch (e: any) {
      alert(e?.message || 'Could not update cart')
    } finally {
      setBusyLineId(null)
    }
  }

  async function removeLine(line: CartLine) {
    if (!confirm(`Remove ${line.name} from your cart?`)) return
    setBusyLineId(line.id)
    try {
      const r = await fetch(`/api/b2b/cart/items/${line.id}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      })
      const j = await r.json()
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`)
      await load()
    } catch (e: any) {
      alert(e?.message || 'Could not remove item')
    } finally {
      setBusyLineId(null)
    }
  }

  async function startCheckout() {
    setCheckoutBusy(true)
    setCheckoutError(null)
    setCheckoutIssues(null)
    try {
      const r = await fetch('/api/b2b/checkout/start', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
      const j = await r.json()
      if (!r.ok) {
        if (j?.details && Array.isArray(j.details) && j.details.length > 0) {
          setCheckoutIssues(j.details)
        }
        throw new Error(j?.error || `HTTP ${r.status}`)
      }
      if (!j?.checkout_url) throw new Error('No checkout URL returned')
      // Hard redirect to Stripe
      window.location.href = j.checkout_url
    } catch (e: any) {
      setCheckoutError(e?.message || String(e))
      setCheckoutBusy(false)
    }
  }

  const cartItemCount = data ? data.item_count : 0
  const isEmpty = !data || data.lines.length === 0

  return (
    <>
      <Head><title>Cart · Just Autos B2B</title></Head>
      <B2BLayout user={b2bUser} active="cart" cartCount={cartItemCount}>

        <header style={{marginBottom:18}}>
          <h1 style={{fontSize:22,fontWeight:600,margin:0,letterSpacing:'-0.01em'}}>Your cart</h1>
          {data && data.lines.length > 0 && (
            <div style={{fontSize:12,color:T.text3,marginTop:4}}>
              {data.line_count} {data.line_count === 1 ? 'item' : 'items'} · {data.item_count} {data.item_count === 1 ? 'unit' : 'units'}
            </div>
          )}
        </header>

        {/* Stripe-cancelled banner */}
        {cancelledOrderId && (
          <div style={{padding:'12px 16px',background:`${T.amber}15`,border:`1px solid ${T.amber}40`,borderRadius:7,fontSize:12,color:T.text,marginBottom:14,display:'flex',alignItems:'center',justifyContent:'space-between',gap:14}}>
            <span>Checkout cancelled. Your cart has been saved — you can try again whenever you're ready.</span>
            <button
              onClick={() => router.replace('/b2b/cart', undefined, { shallow: true })}
              style={{background:'transparent',border:'none',color:T.text3,cursor:'pointer',fontSize:14,fontFamily:'inherit'}}>×</button>
          </div>
        )}

        {error && (
          <div style={{padding:12,background:`${T.red}15`,border:`1px solid ${T.red}40`,borderRadius:7,color:T.red,fontSize:12,marginBottom:14}}>
            {error}
          </div>
        )}

        {checkoutError && (
          <div style={{padding:'12px 16px',background:`${T.red}15`,border:`1px solid ${T.red}40`,borderRadius:7,color:T.red,fontSize:12,marginBottom:14}}>
            <div style={{fontWeight:500,marginBottom:4}}>{checkoutError}</div>
            {checkoutIssues && checkoutIssues.length > 0 && (
              <ul style={{margin:'4px 0 0',paddingLeft:18,color:T.text2}}>
                {checkoutIssues.map((iss, i) => <li key={i}>{iss}</li>)}
              </ul>
            )}
          </div>
        )}

        {loading && !data && (
          <div style={{padding:36,textAlign:'center',color:T.text3,fontSize:12,background:T.bg2,border:`1px solid ${T.border}`,borderRadius:10}}>
            Loading…
          </div>
        )}

        {!loading && isEmpty && (
          <div style={{padding:36,textAlign:'center',background:T.bg2,border:`1px solid ${T.border}`,borderRadius:10}}>
            <div style={{fontSize:14,color:T.text2,marginBottom:14}}>Your cart is empty.</div>
            <a href="/b2b/catalogue"
              style={{display:'inline-block',padding:'9px 18px',borderRadius:6,border:`1px solid ${T.blue}`,background:T.blue,color:'#fff',fontSize:12,fontWeight:500,textDecoration:'none'}}>
              Browse catalogue
            </a>
          </div>
        )}

        {data && data.lines.length > 0 && (
          <div style={{display:'grid',gridTemplateColumns:'1fr 320px',gap:18,alignItems:'start'}}>

            {/* Lines */}
            <div style={{background:T.bg2,border:`1px solid ${T.border}`,borderRadius:10,overflow:'hidden'}}>
              {data.lines.map((line, i) => (
                <CartLineRow
                  key={line.id}
                  line={line}
                  busy={busyLineId === line.id}
                  isFirst={i === 0}
                  onChangeQty={qty => setLineQty(line, qty)}
                  onRemove={() => removeLine(line)}
                />
              ))}
            </div>

            {/* Totals panel */}
            <TotalsPanel
              totals={data.totals}
              cardFeeNote={data.card_fee.note}
              onCheckout={startCheckout}
              checkoutBusy={checkoutBusy}
            />

          </div>
        )}

      </B2BLayout>
    </>
  )
}

// ─── Line row ──────────────────────────────────────────────────────────
function CartLineRow({
  line, busy, isFirst, onChangeQty, onRemove,
}: {
  line: CartLine
  busy: boolean
  isFirst: boolean
  onChangeQty: (qty: number) => void
  onRemove: () => void
}) {
  const stockColor = line.stock_state === 'in_stock' ? T.green : line.stock_state === 'low_stock' ? T.amber : T.red

  return (
    <div style={{
      display:'flex',gap:14,padding:14,
      borderTop: isFirst ? 'none' : `1px solid ${T.border}`,
      opacity: busy ? 0.6 : 1,
      pointerEvents: busy ? 'none' : 'auto',
    }}>
      <div style={{
        width:74,height:74,flexShrink:0,
        borderRadius:6,background:'#fff',overflow:'hidden',
        display:'flex',alignItems:'center',justifyContent:'center',
      }}>
        {line.image_url ? (
          <img src={line.image_url} alt={line.name}
            style={{maxWidth:'100%',maxHeight:'100%',objectFit:'contain'}}
            onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}/>
        ) : (
          <span style={{fontSize:9,color:'#aaa',fontFamily:'monospace'}}>no image</span>
        )}
      </div>

      <div style={{flex:1,minWidth:0}}>
        <div style={{fontSize:9,color:T.text3,fontFamily:'monospace',textTransform:'uppercase',letterSpacing:'0.04em'}}>{line.sku}</div>
        <div style={{fontSize:13,color:T.text,fontWeight:500,marginTop:2}}>{line.name}</div>
        <div style={{display:'flex',alignItems:'center',gap:10,flexWrap:'wrap',marginTop:5}}>
          <span style={{fontSize:11,color:T.text3}}>${line.unit_price_ex_gst.toFixed(2)} ex GST · each</span>
          <span style={{
            display:'inline-block',padding:'1px 7px',borderRadius:8,fontSize:9,fontWeight:500,
            background:`${stockColor}18`,color:stockColor,
          }}>
            {line.stock_state === 'out_of_stock'
              ? 'Out of stock'
              : line.stock_state === 'low_stock' && line.stock_qty_available != null
                ? `Low · ${line.stock_qty_available} left`
                : 'In stock'}
          </span>
          {!line.currently_visible && <span style={{fontSize:10,color:T.amber}}>⚠ no longer in catalogue</span>}
          {line.price_changed && <span style={{fontSize:10,color:T.amber}}>⚠ price changed since added</span>}
        </div>
      </div>

      <div style={{display:'flex',flexDirection:'column',alignItems:'flex-end',gap:6,minWidth:120}}>
        <div style={{display:'flex',alignItems:'center',border:`1px solid ${T.border2}`,borderRadius:6,background:T.bg3}}>
          <button onClick={() => onChangeQty(line.qty - 1)} style={qtyBtn()}>−</button>
          <input
            type="number" value={line.qty} min={0}
            max={line.stock_qty_available ?? undefined}
            onChange={e => {
              const v = parseInt(e.target.value || '0', 10)
              if (isFinite(v) && v >= 0) onChangeQty(v)
            }}
            style={{
              width:42,textAlign:'center',
              background:'transparent',border:'none',color:T.text,
              fontSize:13,outline:'none',fontFamily:'inherit',padding:'6px 0',
              MozAppearance:'textfield' as any,
            }}/>
          <button onClick={() => onChangeQty(line.qty + 1)}
            disabled={line.stock_qty_available != null && line.qty >= line.stock_qty_available}
            style={qtyBtn(line.stock_qty_available != null && line.qty >= line.stock_qty_available)}>+</button>
        </div>
        <div style={{fontSize:13,color:T.text,fontWeight:600,fontVariantNumeric:'tabular-nums'}}>
          ${line.line_subtotal_ex_gst.toFixed(2)}
        </div>
        <button onClick={onRemove}
          style={{padding:'2px 6px',background:'transparent',border:'none',color:T.text3,fontSize:10,cursor:'pointer',fontFamily:'inherit'}}>
          Remove
        </button>
      </div>
    </div>
  )
}

function qtyBtn(disabled?: boolean): React.CSSProperties {
  return {
    width:30,height:30,
    border:'none',background:'transparent',color: disabled ? T.text3 : T.text,
    fontSize:14,cursor: disabled ? 'not-allowed' : 'pointer',fontFamily:'inherit',
  }
}

// ─── Totals panel ──────────────────────────────────────────────────────
function TotalsPanel({
  totals, cardFeeNote, onCheckout, checkoutBusy,
}: {
  totals: CartTotals
  cardFeeNote: string
  onCheckout: () => void
  checkoutBusy: boolean
}) {
  const canCheckout = totals.total_inc > 0
  return (
    <div style={{
      background:T.bg2,border:`1px solid ${T.border}`,borderRadius:10,
      padding:'18px 20px',position:'sticky',top:74,
    }}>
      <div style={{fontSize:11,color:T.text3,textTransform:'uppercase',letterSpacing:'0.08em',marginBottom:12,fontWeight:500}}>
        Order summary
      </div>

      <Row label="Subtotal (ex GST)"  value={`$${totals.subtotal_ex_gst.toFixed(2)}`}/>
      <Row label="GST"                value={`$${totals.gst.toFixed(2)}`}/>
      <Row label="Subtotal (inc GST)" value={`$${totals.subtotal_inc_gst.toFixed(2)}`} bold/>

      <div style={{height:10}}/>

      <Row label="Card surcharge" value={`+$${totals.card_fee_inc.toFixed(2)}`} muted/>
      <div style={{fontSize:10,color:T.text3,marginTop:-4,marginBottom:8,lineHeight:1.5}}>
        {cardFeeNote}
      </div>

      <div style={{borderTop:`1px solid ${T.border2}`,paddingTop:10,marginTop:6}}/>
      <Row label="Total to pay" value={`$${totals.total_inc.toFixed(2)}`} large/>

      <button
        onClick={onCheckout}
        disabled={!canCheckout || checkoutBusy}
        style={{
          width:'100%',padding:'12px 16px',borderRadius:7,marginTop:14,
          border:`1px solid ${canCheckout ? T.blue : T.border2}`,
          background: canCheckout && !checkoutBusy ? T.blue : T.bg3,
          color: canCheckout && !checkoutBusy ? '#fff' : T.text3,
          fontSize:13,fontWeight:600,
          cursor: canCheckout && !checkoutBusy ? 'pointer' : 'not-allowed',
          fontFamily:'inherit',
        }}>
        {checkoutBusy ? 'Connecting to Stripe…' : 'Checkout'}
      </button>
      <div style={{fontSize:10,color:T.text3,marginTop:8,textAlign:'center',lineHeight:1.5}}>
        You'll be redirected to Stripe to enter card details.
      </div>
    </div>
  )
}

function Row({ label, value, bold, muted, large }: { label: string; value: string; bold?: boolean; muted?: boolean; large?: boolean }) {
  return (
    <div style={{
      display:'flex',justifyContent:'space-between',alignItems:'baseline',padding:'4px 0',
      fontSize: large ? 14 : 12,
      color: muted ? T.text3 : T.text2,
      fontWeight: bold || large ? 600 : 400,
    }}>
      <span>{label}</span>
      <span style={{color: large ? T.text : (bold ? T.text : 'inherit'),fontVariantNumeric:'tabular-nums'}}>{value}</span>
    </div>
  )
}

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  return await requireB2BPageAuth(ctx) as any
}
