// pages/b2b/cart.tsx
//
// Distributor cart page. Lists all current cart lines with qty steppers,
// remove buttons, and a totals panel showing subtotal/GST/card-fee/total.
//
// Checkout flow:
//   - Optional Purchase Order field (max 20 chars — MYOB limit)
//   - "Checkout" POSTs to /api/b2b/checkout/start with { customer_po }
//   - On success, redirects browser to the returned Stripe URL
//   - On Stripe cancel, user lands back here with ?cancelled={order_id}
//     and we show a small "checkout cancelled" banner

import { useEffect, useState } from 'react'
import Head from 'next/head'
import { useRouter } from 'next/router'
import type { GetServerSideProps } from 'next'
import B2BLayout from '../../components/b2b/B2BLayout'
import { requireB2BPageAuth } from '../../lib/b2bAuthServer'
import { useIsMobile } from '../../lib/useIsMobile'
import { paytoSurchargeInc } from '../../lib/b2b-payment'
import { useConfirm, useToast } from '../../components/ui/Feedback'
import { SkeletonRows } from '../../components/ui'

const T = {
  bg:'#0d0f12', bg2:'#131519', bg3:'#1a1d23', bg4:'#21252d',
  border:'rgba(255,255,255,0.07)', border2:'rgba(255,255,255,0.12)',
  text:'#e8eaf0', text2:'#aab0c0', text3:'#8d93a4',
  blue:'#4f8ef7', teal:'#2dd4bf', green:'#34c77b',
  amber:'#f5a623', red:'#f04e4e', purple:'#a78bfa',
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
  trade_price_ex_gst: number
  promo_active: boolean
  volume_break_applied: boolean
  volume_break_min_qty: number | null
  is_taxable: boolean
  line_subtotal_ex_gst: number
  line_gst: number
  line_total_inc_gst: number
  currently_visible: boolean
  price_changed: boolean
  stock_state: 'in_stock' | 'low_stock' | 'out_of_stock'
  stock_qty_available: number | null
  // Available right now = MYOB qty − in-flight commitments. null = unlimited.
  available_qty: number | null
  max_order_qty: number | null
  // min(available_qty, max_order_qty) — used as the stepper ceiling
  effective_cap: number | null
  call_for_availability: boolean
  is_special_order: boolean
  is_drop_ship: boolean
  instructions_url: string | null
}

interface CartTotals {
  subtotal_ex_gst: number
  gst: number
  subtotal_inc_gst: number
  card_fee_inc: number
  total_inc: number
}

interface FreightRateOption {
  id: string
  label: string
  price_ex_gst: number
  transit_days: number | null
  source: 'machship' | 'static' | 'satchel' | 'dropship'
  // Live MachShip rates carry the route metadata so checkout/start can
  // persist the chosen carrier+service against the order.
  machship?: {
    carrierId: number
    carrierServiceId: number
    companyCarrierAccountId?: number
    routeSnapshot: any
  }
  eta_utc?: string | null
  base_price_ex_gst?: number
  markup_pct?: number
}

interface FreightPayload {
  postcode: string
  suburb:   string | null
  mode: 'live' | 'static' | 'blocked' | 'no_zone'
  rates: FreightRateOption[]
  blocked?: { reason: string; missing: Array<{ sku: string; name: string; missing_fields: string[] }> }
  zone?:    { id: string; name: string } | null
}

interface CartResponse {
  cart_id: string
  lines: CartLine[]
  line_count: number
  item_count: number
  totals: CartTotals
  card_fee: { pct: number; fixed: number; note: string }
  freight: FreightPayload | null
}

export default function B2BCartPage({ b2bUser }: Props) {
  const router = useRouter()
  const isMobile = useIsMobile()
  const toast = useToast()
  const confirmDialog = useConfirm()
  const [data, setData] = useState<CartResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyLineId, setBusyLineId] = useState<string | null>(null)
  const [paymentMethod, setPaymentMethod] = useState<'card' | 'becs' | 'payto'>('card')
  const [checkoutBusy, setCheckoutBusy] = useState(false)
  const [checkoutError, setCheckoutError] = useState<string | null>(null)
  const [checkoutIssues, setCheckoutIssues] = useState<string[] | null>(null)
  const [customerPo, setCustomerPo] = useState('')
  const [selectedFreightId, setSelectedFreightId] = useState<string | null>(null)

  // Auto-pick the cheapest rate when the quote arrives so the totals reflect
  // a real freight cost from the moment the cart loads. User can change.
  useEffect(() => {
    if (selectedFreightId) return
    const rates = data?.freight?.rates
    if (!rates || rates.length === 0) return
    const cheapest = [...rates].sort((a, b) => a.price_ex_gst - b.price_ex_gst)[0]
    if (cheapest) setSelectedFreightId(cheapest.id)
  }, [data?.freight, selectedFreightId])

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
      toast(e?.message || 'Could not update cart', 'error')
    } finally {
      setBusyLineId(null)
    }
  }

  async function removeLine(line: CartLine) {
    if (!(await confirmDialog({ title: `Remove ${line.name} from your cart?`, danger: true }))) return
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
      toast(e?.message || 'Could not remove item', 'error')
    } finally {
      setBusyLineId(null)
    }
  }

  async function startCheckout() {
    setCheckoutBusy(true)
    setCheckoutError(null)
    setCheckoutIssues(null)
    try {
      // Live MachShip rates carry a synthetic id (`ms:carrierId:serviceId`)
      // and we hand the full route snapshot back to the server so it can
      // book the exact quote the distributor saw. Static zone rates just
      // pass the rate uuid as before.
      const chosenRate = (data?.freight?.rates || []).find(r => r.id === selectedFreightId)
      const machshipRoute = chosenRate?.source === 'machship' ? {
        carrierId:                chosenRate.machship?.carrierId,
        carrierServiceId:         chosenRate.machship?.carrierServiceId,
        companyCarrierAccountId:  chosenRate.machship?.companyCarrierAccountId,
        label:                    chosenRate.label,
        price_ex_gst:             chosenRate.price_ex_gst,
        base_price_ex_gst:        chosenRate.base_price_ex_gst,
        markup_pct:               chosenRate.markup_pct,
        eta_utc:                  chosenRate.eta_utc,
        route_snapshot:           chosenRate.machship?.routeSnapshot,
      } : undefined
      const r = await fetch('/api/b2b/checkout/start', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customer_po: customerPo.trim() || undefined,
          payment_method: paymentMethod,
          freight_rate_id: chosenRate?.source === 'static' ? selectedFreightId : undefined,
          freight_satchel_id: chosenRate?.source === 'satchel' ? selectedFreightId : undefined,
          freight_machship_route: machshipRoute,
        }),
      })
      const j = await r.json()
      if (!r.ok) {
        if (j?.details && Array.isArray(j.details) && j.details.length > 0) {
          setCheckoutIssues(j.details)
        }
        throw new Error(j?.error || `HTTP ${r.status}`)
      }
      if (!j?.checkout_url) throw new Error('No checkout URL returned')
      window.location.href = j.checkout_url
    } catch (e: any) {
      setCheckoutError(e?.message || String(e))
      setCheckoutBusy(false)
    }
  }

  const cartItemCount = data ? data.item_count : 0
  const isEmpty = !data || data.lines.length === 0
  const anyLineOverCap = data ? data.lines.some(l => l.effective_cap !== null && l.qty > l.effective_cap) : false

  return (
    <>
      <Head><title>Cart · Just Autos B2B</title></Head>
      <B2BLayout user={b2bUser} active="cart" cartCount={cartItemCount}>

        <header style={{marginBottom:18}}>
          <h1 style={{fontSize:22,fontWeight:600,margin:0,letterSpacing:'-0.01em'}}>Your cart</h1>
          {data && data.lines.length > 0 && (
            <div style={{fontSize:13,color:T.text3,marginTop:4}}>
              {data.line_count} {data.line_count === 1 ? 'item' : 'items'} · {data.item_count} {data.item_count === 1 ? 'unit' : 'units'}
            </div>
          )}
        </header>

        {/* Stripe-cancelled banner */}
        {cancelledOrderId && (
          <div style={{padding:'12px 16px',background:`${T.amber}15`,border:`1px solid ${T.amber}40`,borderRadius:7,fontSize:13,color:T.text,marginBottom:14,display:'flex',alignItems:'center',justifyContent:'space-between',gap:14}}>
            <span>Checkout cancelled. Your cart has been saved — you can try again whenever you're ready.</span>
            <button
              onClick={() => router.replace('/b2b/cart', undefined, { shallow: true })}
              style={{background:'transparent',border:'none',color:T.text3,cursor:'pointer',fontSize:14,fontFamily:'inherit'}}>×</button>
          </div>
        )}

        {error && (
          <div style={{padding:12,background:`${T.red}15`,border:`1px solid ${T.red}40`,borderRadius:7,color:T.red,fontSize:13,marginBottom:14}}>
            {error}
          </div>
        )}

        {checkoutError && (
          <div style={{padding:'12px 16px',background:`${T.red}15`,border:`1px solid ${T.red}40`,borderRadius:7,color:T.red,fontSize:13,marginBottom:14}}>
            <div style={{fontWeight:500,marginBottom:4}}>{checkoutError}</div>
            {checkoutIssues && checkoutIssues.length > 0 && (
              <ul style={{margin:'4px 0 0',paddingLeft:18,color:T.text2}}>
                {checkoutIssues.map((iss, i) => <li key={i}>{iss}</li>)}
              </ul>
            )}
          </div>
        )}

        {loading && !data && (
          <div style={{background:T.bg2,border:`1px solid ${T.border}`,borderRadius:10,overflow:'hidden'}}>
            <SkeletonRows rows={8}/>
          </div>
        )}

        {!loading && isEmpty && (
          <div style={{padding:36,textAlign:'center',background:T.bg2,border:`1px solid ${T.border}`,borderRadius:10}}>
            <div style={{fontSize:14,color:T.text2,marginBottom:14}}>Your cart is empty.</div>
            <a href="/b2b/catalogue"
              style={{display:'inline-block',padding:'9px 18px',borderRadius:6,border:`1px solid ${T.blue}`,background:T.blue,color:'#fff',fontSize:13,fontWeight:500,textDecoration:'none'}}>
              Browse catalogue
            </a>
          </div>
        )}

        {data && data.lines.length > 0 && (
          <div style={{
            display:'grid',
            // Stack on mobile (lines first, totals after); 2-column with
            // a fixed 320px totals rail on tablet/desktop.
            gridTemplateColumns: isMobile ? '1fr' : '1fr 320px',
            gap: isMobile ? 14 : 18, alignItems:'start',
          }}>

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
              cardFee={data.card_fee}
              customerPo={customerPo}
              onCustomerPoChange={setCustomerPo}
              paymentMethod={paymentMethod}
              onPaymentMethodChange={setPaymentMethod}
              onCheckout={startCheckout}
              checkoutBusy={checkoutBusy}
              blockedReason={
                anyLineOverCap
                  ? 'One or more items exceed the available qty or per-order max — adjust your cart to continue.'
                  : data.freight?.mode === 'blocked'
                    ? (data.freight.blocked?.reason || 'Freight quote unavailable for this cart — contact your account manager.')
                    : null
              }
              freight={data.freight}
              selectedFreightId={selectedFreightId}
              onSelectFreight={setSelectedFreightId}
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
        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:6}}>
          <div style={{fontSize:9,color:T.text3,fontFamily:'monospace',textTransform:'uppercase',letterSpacing:'0.04em'}}>{line.sku}</div>
          {line.instructions_url && (
            <a href={line.instructions_url} target="_blank" rel="noopener noreferrer"
              style={{fontSize:10,color:T.blue,textDecoration:'none',padding:'1px 6px',borderRadius:4,background:`${T.blue}12`,border:`1px solid ${T.blue}30`}}>
              📄 PDF
            </a>
          )}
        </div>
        <div style={{fontSize:13,color:T.text,fontWeight:500,marginTop:2}}>{line.name}</div>
        <div style={{display:'flex',alignItems:'center',gap:10,flexWrap:'wrap',marginTop:5}}>
          <span style={{fontSize:12,color:T.text,fontWeight:500,fontVariantNumeric:'tabular-nums'}}>
            ${incGst(line.unit_price_ex_gst, line.is_taxable).toFixed(2)} inc GST · each
            {(line.promo_active || line.volume_break_applied) && line.unit_price_ex_gst < line.trade_price_ex_gst && (
              <span style={{fontSize:10,color:T.text3,fontWeight:400,marginLeft:5,textDecoration:'line-through'}}>
                ${incGst(line.trade_price_ex_gst, line.is_taxable).toFixed(2)}
              </span>
            )}
          </span>
          {line.promo_active && (
            <span style={{fontSize:9,fontWeight:600,padding:'1px 5px',borderRadius:6,background:`${T.green}20`,color:T.green,letterSpacing:'0.04em'}}>
              PROMO
            </span>
          )}
          {line.volume_break_applied && line.volume_break_min_qty != null && (
            <span style={{fontSize:9,fontWeight:600,padding:'1px 5px',borderRadius:6,background:`${T.green}20`,color:T.green,letterSpacing:'0.04em'}}>
              {line.volume_break_min_qty}+ PRICE
            </span>
          )}
          <span style={{
            display:'inline-block',padding:'1px 7px',borderRadius:8,fontSize:9,fontWeight:500,
            background: line.call_for_availability ? `${T.amber}18` : `${stockColor}18`,
            color: line.call_for_availability ? T.amber : stockColor,
          }}>
            {line.call_for_availability
              ? 'Call for availability'
              : line.stock_state === 'out_of_stock'
                ? 'Out of stock'
                : line.stock_state === 'low_stock' && line.stock_qty_available != null
                  ? `Low · ${line.stock_qty_available} left`
                  : 'In stock'}
          </span>
          {line.is_special_order && <span style={{fontSize:9,fontWeight:500,padding:'1px 6px',borderRadius:6,background:`${T.amber}18`,color:T.amber}}>Special order</span>}
          {line.is_drop_ship && <span style={{fontSize:9,fontWeight:500,padding:'1px 6px',borderRadius:6,background:`${T.purple}18`,color:T.purple}}>Drop ship</span>}
          {!line.currently_visible && <span style={{fontSize:10,color:T.amber}}>⚠ no longer in catalogue</span>}
          {line.price_changed && <span style={{fontSize:10,color:T.amber}}>⚠ price changed since added</span>}
        </div>
        {line.effective_cap !== null && line.qty > line.effective_cap && (
          <div style={{
            marginTop:8,padding:'7px 10px',
            background:`${T.red}12`,border:`1px solid ${T.red}40`,borderRadius:6,
            display:'flex',alignItems:'center',justifyContent:'space-between',gap:10,flexWrap:'wrap',
          }}>
            <span style={{fontSize:11,color:T.red,lineHeight:1.4}}>
              {line.effective_cap === 0
                ? `Not available right now.`
                : line.max_order_qty != null && line.effective_cap === line.max_order_qty
                  ? `Max ${line.max_order_qty} per order (your cart has ${line.qty}).`
                  : `Only ${line.effective_cap} available right now (your cart has ${line.qty}).`}
            </span>
            {line.effective_cap === 0 ? (
              <button onClick={onRemove}
                style={{padding:'4px 10px',borderRadius:5,border:`1px solid ${T.red}`,background:`${T.red}20`,color:T.red,fontSize:11,fontWeight:500,cursor:'pointer',fontFamily:'inherit'}}>
                Remove
              </button>
            ) : (
              <button onClick={() => onChangeQty(line.effective_cap as number)}
                style={{padding:'4px 10px',borderRadius:5,border:`1px solid ${T.red}`,background:`${T.red}20`,color:T.red,fontSize:11,fontWeight:500,cursor:'pointer',fontFamily:'inherit'}}>
                Reduce to {line.effective_cap}
              </button>
            )}
          </div>
        )}
      </div>

      <div style={{display:'flex',flexDirection:'column',alignItems:'flex-end',gap:6,minWidth:120}}>
        <div style={{display:'flex',alignItems:'center',border:`1px solid ${T.border2}`,borderRadius:6,background:T.bg3}}>
          <button onClick={() => onChangeQty(line.qty - 1)} style={qtyBtn()}>−</button>
          <input
            type="number" value={line.qty} min={0}
            max={line.effective_cap ?? undefined}
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
            disabled={line.effective_cap != null && line.qty >= line.effective_cap}
            style={qtyBtn(line.effective_cap != null && line.qty >= line.effective_cap)}>+</button>
        </div>
        <div style={{fontSize:13,color:T.text,fontWeight:600,fontVariantNumeric:'tabular-nums'}}>
          ${Number(line.line_total_inc_gst).toFixed(2)}
        </div>
        <button onClick={onRemove}
          style={{padding:'2px 6px',background:'transparent',border:'none',color:T.text3,fontSize:10,cursor:'pointer',fontFamily:'inherit'}}>
          Remove
        </button>
      </div>
    </div>
  )
}

// GST-inclusive display price (taxable items +10%, FRE items as-is).
function incGst(ex: number, taxable: boolean): number {
  return taxable ? Math.round(ex * 1.10 * 100) / 100 : ex
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
  totals, cardFee, customerPo, onCustomerPoChange, paymentMethod, onPaymentMethodChange, onCheckout, checkoutBusy, blockedReason,
  freight, selectedFreightId, onSelectFreight,
}: {
  totals: CartTotals
  cardFee: { pct: number; fixed: number; note: string }
  customerPo: string
  onCustomerPoChange: (v: string) => void
  paymentMethod: 'card' | 'becs' | 'payto'
  onPaymentMethodChange: (m: 'card' | 'becs' | 'payto') => void
  onCheckout: () => void
  checkoutBusy: boolean
  blockedReason: string | null
  freight: FreightPayload | null
  selectedFreightId: string | null
  onSelectFreight: (id: string | null) => void
}) {
  const applySurcharge = paymentMethod === 'card'
  const selectedFreight = freight?.rates.find(r => r.id === selectedFreightId) || null
  const freightExGst = selectedFreight ? Number(selectedFreight.price_ex_gst) : 0
  const freightGst = freightExGst * 0.10
  const freightInc = freightExGst + freightGst

  // Recompute totals with freight folded in. Mirrors the formula in
  // pages/api/b2b/checkout/start.ts so the displayed total matches what
  // the user will see in Stripe.
  const newSubtotalEx  = totals.subtotal_ex_gst + freightExGst
  const newGst         = totals.gst + freightGst
  const newSubtotalInc = newSubtotalEx + newGst
  const charged        = (applySurcharge && newSubtotalInc > 0)
    ? (newSubtotalInc + cardFee.fixed) / (1 - cardFee.pct)
    : newSubtotalInc
  const newCardFeeInc  = applySurcharge ? Math.max(0, charged - newSubtotalInc) : 0
  const paytoFeeInc    = paymentMethod === 'payto' ? paytoSurchargeInc(newSubtotalInc) : 0
  const grandTotalInc  = newSubtotalInc + newCardFeeInc + paytoFeeInc

  const poTrimmed = customerPo.trim()
  const poTooLong = poTrimmed.length > 20
  const poMissing = poTrimmed.length === 0
  const canCheckout = grandTotalInc > 0 && !blockedReason && !poMissing

  return (
    <div style={{
      background:T.bg2,border:`1px solid ${T.border}`,borderRadius:10,
      padding:'18px 20px',position:'sticky',top:74,
    }}>
      <div style={{fontSize:12,color:T.text3,textTransform:'uppercase',letterSpacing:'0.08em',marginBottom:12,fontWeight:500}}>
        Order summary
      </div>

      <Row label="Items (inc GST)"  value={`$${totals.subtotal_inc_gst.toFixed(2)}`}/>
      {selectedFreight && (
        <Row label={`Freight (${selectedFreight.label})`} value={`+$${freightInc.toFixed(2)}`} muted/>
      )}

      <div style={{height:10}}/>

      {/* Payment method — PayTo (bank) skips the card surcharge */}
      <div style={{fontSize:10,color:T.text2,textTransform:'uppercase',letterSpacing:'0.06em',fontWeight:500,marginBottom:6}}>Payment method</div>
      <div style={{display:'flex',gap:6,marginBottom:6,flexWrap:'wrap'}}>
        {([['card','Card / Apple Pay'],['payto','PayTo (bank)']] as const).map(([id,label]) => {
          const on = paymentMethod === id
          return (
            <button key={id} type="button" onClick={() => onPaymentMethodChange(id)}
              style={{flex:'1 1 0',minWidth:78,padding:'7px 8px',borderRadius:6,fontSize:11.5,fontWeight:600,fontFamily:'inherit',cursor:'pointer',
                border:`1px solid ${on ? T.blue : T.border2}`, background:on ? 'rgba(79,142,247,0.15)' : 'transparent', color:on ? T.text : T.text2}}>
              {label}
            </button>
          )
        })}
      </div>

      {applySurcharge ? (
        <>
          <Row label="Card surcharge" value={`+$${newCardFeeInc.toFixed(2)}`} muted/>
          <div style={{fontSize:10,color:T.text3,marginTop:-4,marginBottom:8,lineHeight:1.5}}>{cardFee.note}</div>
        </>
      ) : (
        <>
          <Row label="PayTo fee" value={`+$${paytoFeeInc.toFixed(2)}`} muted/>
          <div style={{fontSize:10,color:T.green,marginTop:-4,marginBottom:6,lineHeight:1.5}}>Low bank fee (1% + 30c, capped at $3.50) — cheaper than card, paid instantly from your bank.</div>
          <div style={{fontSize:11,color:T.text2,background:T.bg3,border:`1px solid ${T.border}`,borderRadius:6,padding:'8px 10px',marginBottom:8,lineHeight:1.55}}>
            <strong style={{color:T.text}}>New to PayTo?</strong> It pays securely straight from your bank account.
            <div style={{marginTop:5}}>At the next step you’ll enter your <strong>PayID</strong> (the email or mobile linked to your bank) or your <strong>BSB&nbsp;+ account number</strong>, then <strong>approve the request in your banking app</strong>. Most major Australian banks support it. <a href="https://payto.com.au/" target="_blank" rel="noreferrer" style={{color:T.blue,textDecoration:'none'}}>Learn more ↗</a></div>
          </div>
        </>
      )}

      <div style={{borderTop:`1px solid ${T.border2}`,paddingTop:10,marginTop:6}}/>
      <Row label="Total to pay (inc GST)" value={`$${grandTotalInc.toFixed(2)}`} large/>
      <div style={{fontSize:10,color:T.text3,marginTop:4}}>Includes ${newGst.toFixed(2)} GST</div>

      {/* Freight picker */}
      {freight && (
        <div style={{marginTop:14, paddingTop:12, borderTop:`1px solid ${T.border}`}}>
          <div style={{display:'flex', alignItems:'baseline', justifyContent:'space-between', marginBottom:6}}>
            <div style={{fontSize:10,color:T.text2,textTransform:'uppercase',letterSpacing:'0.06em',fontWeight:500}}>
              Shipping to {freight.postcode}
            </div>
            {freight.mode === 'live' && (
              <span title="Quoted live from MachShip" style={{fontSize:9,color:T.teal,fontWeight:600,letterSpacing:'0.05em'}}>LIVE</span>
            )}
            {freight.mode === 'static' && (
              <span title="Postcode-zone fallback rate" style={{fontSize:9,color:T.text3,fontWeight:600,letterSpacing:'0.05em'}}>EST</span>
            )}
          </div>
          {freight.mode === 'blocked' ? (
            <div style={{fontSize:11, color:T.red, lineHeight:1.5}}>
              <div style={{fontWeight:600, marginBottom:4}}>Freight quote unavailable</div>
              <div style={{color:T.text2}}>
                {freight.blocked?.reason || 'Some items in your cart are missing shipping dimensions.'}
              </div>
              {freight.blocked?.missing && freight.blocked.missing.length > 0 && (
                <ul style={{margin:'6px 0 0', paddingLeft:18, color:T.text3, fontSize:10}}>
                  {freight.blocked.missing.slice(0, 6).map(m => (
                    <li key={m.sku}>{m.sku} — {m.name} <span style={{color:T.text3}}>(needs {m.missing_fields.join(', ')})</span></li>
                  ))}
                  {freight.blocked.missing.length > 6 && (
                    <li style={{listStyle:'none', color:T.text3}}>… and {freight.blocked.missing.length - 6} more</li>
                  )}
                </ul>
              )}
              <div style={{marginTop:6, color:T.text3, fontSize:10}}>Contact your account manager to get this sorted.</div>
            </div>
          ) : freight.rates.length > 0 ? (
            <div style={{display:'flex', flexDirection:'column', gap:6}}>
              {freight.rates.map(r => {
                const on = selectedFreightId === r.id
                return (
                  <label key={r.id} style={{
                    display:'flex', alignItems:'center', gap:8,
                    padding:'8px 10px', borderRadius:6,
                    border:`1px solid ${on ? T.blue : T.border2}`,
                    background: on ? `${T.blue}12` : T.bg3,
                    cursor:'pointer', fontSize:12,
                  }}>
                    <input type="radio" name="freight" checked={on}
                      onChange={() => onSelectFreight(r.id)}/>
                    <span style={{flex:1, color:T.text}}>{r.label}</span>
                    {r.source === 'satchel' && (
                      <span title="Flat-rate satchel" style={{fontSize:9, color:T.green, fontWeight:700, letterSpacing:'0.05em', border:`1px solid ${T.green}55`, borderRadius:4, padding:'1px 4px'}}>SATCHEL</span>
                    )}
                    {r.transit_days != null && (
                      <span style={{fontSize:10, color:T.text3}}>{r.transit_days}d</span>
                    )}
                    <span style={{fontFamily:'monospace', color:T.text2}}>${r.price_ex_gst.toFixed(2)} ex</span>
                  </label>
                )
              })}
            </div>
          ) : (
            <div style={{fontSize:11, color:T.amber, lineHeight:1.5}}>
              No freight rate configured for postcode {freight.postcode}. Contact your account manager for a quote.
            </div>
          )}
        </div>
      )}

      {/* Purchase Order */}
      <div style={{marginTop:14}}>
        <label style={{display:'block',fontSize:10,color:T.text2,textTransform:'uppercase',letterSpacing:'0.06em',marginBottom:4,fontWeight:500}}>
          Your PO number <span style={{textTransform:'none',color:T.red,fontWeight:600,letterSpacing:0}}>*required</span>
        </label>
        <input
          type="text"
          value={customerPo}
          onChange={e => onCustomerPoChange(e.target.value)}
          placeholder="e.g. PO-12345"
          maxLength={20}
          required
          style={{
            width:'100%',boxSizing:'border-box',
            background:T.bg3,
            border:`1px solid ${poTooLong ? T.red : (poMissing ? `${T.amber}88` : T.border2)}`,
            color:T.text,borderRadius:5,padding:'8px 10px',fontSize:13,outline:'none',
            fontFamily:'inherit',
          }}/>
        <div style={{fontSize:10,color: poTooLong ? T.red : (poMissing ? T.amber : T.text3),marginTop:3}}>
          {poTooLong
            ? 'Maximum 20 characters'
            : poMissing
              ? 'A PO number is required to check out'
              : `${poTrimmed.length}/20 chars · written to MYOB`}
        </div>
      </div>

      <button
        onClick={onCheckout}
        disabled={!canCheckout || checkoutBusy || poTooLong}
        style={{
          width:'100%',padding:'12px 16px',borderRadius:7,marginTop:14,
          border:`1px solid ${canCheckout && !poTooLong ? T.blue : T.border2}`,
          background: canCheckout && !checkoutBusy && !poTooLong ? T.blue : T.bg3,
          color: canCheckout && !checkoutBusy && !poTooLong ? '#fff' : T.text3,
          fontSize:13,fontWeight:600,
          cursor: canCheckout && !checkoutBusy && !poTooLong ? 'pointer' : 'not-allowed',
          fontFamily:'inherit',
        }}>
        {checkoutBusy ? 'Connecting to Stripe…' : 'Checkout'}
      </button>
      {blockedReason ? (
        <div style={{fontSize:10,color:T.red,marginTop:8,textAlign:'center',lineHeight:1.5}}>
          {blockedReason}
        </div>
      ) : (
        <div style={{fontSize:10,color:T.text3,marginTop:8,textAlign:'center',lineHeight:1.5}}>
          You'll be redirected to Stripe to enter card details.
        </div>
      )}
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
