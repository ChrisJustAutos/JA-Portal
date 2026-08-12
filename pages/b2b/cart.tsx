// pages/b2b/cart.tsx
//
// Distributor cart page. Lists all current cart lines with qty steppers,
// remove buttons, and a totals panel showing subtotal/GST/card-fee/total.
//
// Checkout flow:
//   - Purchase Order field (max 20 chars — MYOB limit) — FIRST in the rail:
//     it's required, so it must not be discovered last behind a dead button
//   - "Checkout" POSTs to /api/b2b/checkout/start with { customer_po }
//   - On success, redirects browser to the returned Stripe URL
//   - On Stripe cancel, user lands back here with ?cancelled={order_id}
//     and we show a small "checkout cancelled" banner
//
// Look: Alloy kit — payment method as a segmented control, freight as
// tappable rows, the PayTo/BECS explainers behind a disclosure.

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
import { T, alpha } from '../../lib/ui/theme'
import { A, RADIUS, SHADOW, Banner, Btn, btnStyle, Card, Disclosure, Field, PageTitle, Row, Seg, Stepper, inputStyle } from '../../components/b2b/ui'

interface Props {
  b2bUser: {
    id: string
    email: string
    fullName: string | null
    role: 'owner' | 'member'
    distributor: { id: string; displayName: string; checkoutEnabled?: boolean }
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
  // Auto-included bundle component (child of the line above). Rendered nested,
  // with no qty stepper or remove button — its qty follows the parent.
  is_bundle_component?: boolean
  bundle_parent_catalogue_id?: string | null
  bundle_price_mode?: 'included' | 'added'
  // Large-order handling (migration 125).
  over_limit_qty?: number | null
  over_limit_action?: 'quote' | 'dropship' | null
  needs_quote?: boolean          // qty over a 'quote' threshold → blocks checkout
  ships_from_supplier?: boolean  // catalogue drop-ship OR over-limit drop-ship
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
  const anyLineNeedsQuote = data ? data.lines.some(l => l.needs_quote) : false

  const [quoteBusy, setQuoteBusy] = useState(false)
  const [quoteSent, setQuoteSent] = useState(false)
  async function requestQuote() {
    setQuoteBusy(true)
    try {
      const r = await fetch('/api/b2b/quote-request', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`)
      setQuoteSent(true)
      toast('Quote request sent — your account manager will be in touch.', 'success')
    } catch (e: any) {
      toast(`Couldn’t send quote request: ${e?.message || e}`, 'error')
    } finally {
      setQuoteBusy(false)
    }
  }

  return (
    <>
      <Head><title>Cart · Just Autos B2B</title></Head>
      <B2BLayout user={b2bUser} active="cart" cartCount={cartItemCount}>

        <PageTitle
          sub={data && data.lines.length > 0
            ? `${data.line_count} ${data.line_count === 1 ? 'item' : 'items'} · ${data.item_count} ${data.item_count === 1 ? 'unit' : 'units'}`
            : undefined}>
          Cart
        </PageTitle>

        {/* Stripe-cancelled banner */}
        {cancelledOrderId && (
          <div style={{marginBottom:14}}>
            <Banner tone="warn" onDismiss={() => router.replace('/b2b/cart', undefined, { shallow: true })}>
              Checkout cancelled. Your cart has been saved — you can try again whenever you're ready.
            </Banner>
          </div>
        )}

        {error && <div style={{marginBottom:14}}><Banner tone="error">{error}</Banner></div>}

        {checkoutError && (
          <div style={{marginBottom:14}}>
            <Banner tone="error">
              <div style={{fontWeight:600}}>{checkoutError}</div>
              {checkoutIssues && checkoutIssues.length > 0 && (
                <ul style={{margin:'6px 0 0',paddingLeft:18,color:T.text2}}>
                  {checkoutIssues.map((iss, i) => <li key={i}>{iss}</li>)}
                </ul>
              )}
            </Banner>
          </div>
        )}

        {loading && !data && (
          <Card pad={false}><SkeletonRows rows={8}/></Card>
        )}

        {!loading && isEmpty && (
          <Card style={{padding:'44px 24px', textAlign:'center'}}>
            <div style={{fontSize:15,fontWeight:600,color:T.text,marginBottom:16}}>Your cart is empty</div>
            <a href="/b2b/catalogue" style={{...btnStyle('primary', 'md'), textDecoration:'none'}}>Browse the catalogue</a>
          </Card>
        )}

        {data && data.lines.length > 0 && (
          <div style={{
            display:'grid',
            // Stack on mobile (lines first, totals after); 2-column with
            // a fixed 330px checkout rail on tablet/desktop.
            gridTemplateColumns: isMobile ? '1fr' : '1fr 330px',
            gap: isMobile ? 14 : 18, alignItems:'start',
          }}>

            {/* Large-order quote banner — spans both columns */}
            {anyLineNeedsQuote && (
              <div style={{gridColumn:'1 / -1'}}>
                <Banner tone="warn">
                  <div style={{display:'flex',alignItems:'center',gap:14,flexWrap:'wrap'}}>
                    <span style={{flex:1,minWidth:200}}>
                      Some items are above the quantity we can sell online — these need a manual quote.
                      Request one and we’ll get back to you with pricing and freight.
                    </span>
                    <Btn variant={quoteSent ? 'secondary' : 'primary'} size="sm" disabled={quoteBusy || quoteSent} onClick={requestQuote}>
                      {quoteSent ? '✓ Quote requested' : quoteBusy ? 'Sending…' : 'Request a quote'}
                    </Btn>
                  </div>
                </Banner>
              </div>
            )}

            {/* Lines */}
            <Card pad={false}>
              {data.lines.map((line, i) => (
                <CartLineRow
                  key={line.id}
                  line={line}
                  busy={busyLineId === line.id}
                  isFirst={i === 0}
                  isMobile={isMobile}
                  onChangeQty={qty => setLineQty(line, qty)}
                  onRemove={() => removeLine(line)}
                />
              ))}
            </Card>

            {/* Checkout rail */}
            <CheckoutRail
              totals={data.totals}
              cardFee={data.card_fee}
              customerPo={customerPo}
              onCustomerPoChange={setCustomerPo}
              paymentMethod={paymentMethod}
              onPaymentMethodChange={setPaymentMethod}
              onCheckout={startCheckout}
              checkoutBusy={checkoutBusy}
              isMobile={isMobile}
              blockedReason={
                b2bUser.distributor.checkoutEnabled === false
                  ? 'Ordering is not enabled for your account yet. Please contact Just Autos to place an order.'
                  : anyLineNeedsQuote
                  ? 'One or more items need a manual quote for the quantity ordered — request a quote or reduce the qty to check out.'
                  : anyLineOverCap
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
  line, busy, isFirst, isMobile, onChangeQty, onRemove,
}: {
  line: CartLine
  busy: boolean
  isFirst: boolean
  isMobile: boolean
  onChangeQty: (qty: number) => void
  onRemove: () => void
}) {
  // Bundle component — a child product that ships with the line above it.
  // Compact, indented, no qty stepper / remove (its qty follows the parent).
  if (line.is_bundle_component) {
    const added = line.bundle_price_mode === 'added' && line.unit_price_ex_gst > 0
    return (
      <div style={{
        display:'flex',gap:10,padding:'9px 16px 9px 44px',
        borderTop:`1px solid ${T.border}`,
        background: T.bg3,
        alignItems:'center',
      }}>
        <span style={{color:T.text3,fontSize:13}}>↳</span>
        <div style={{flex:1,minWidth:0}}>
          <div style={{fontSize:13,color:T.text2,fontWeight:550,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>
            {line.name}
          </div>
          <div style={{fontSize:12,color:T.text3,marginTop:2}}>
            × {line.qty} · included with the item above{added ? ' · charged' : ''}
          </div>
        </div>
        <div style={{fontSize:13,color: added ? T.text : A.good,fontWeight:600,fontVariantNumeric:'tabular-nums'}}>
          {added ? `$${Number(line.line_total_inc_gst).toFixed(2)}` : 'Free'}
        </div>
      </div>
    )
  }

  // Quiet sentences instead of chip clusters — worst first.
  const noticeBits: Array<{ text: string; color: string }> = []
  if (!line.currently_visible)       noticeBits.push({ text: 'No longer in the catalogue', color: A.warn })
  if (line.price_changed)            noticeBits.push({ text: 'Price changed since added', color: A.warn })
  if (line.needs_quote)              noticeBits.push({ text: `Needs a quote${line.over_limit_qty != null ? ` over ${line.over_limit_qty} units` : ''}`, color: A.warn })
  if (line.call_for_availability)    noticeBits.push({ text: 'Call for availability', color: A.warn })
  else if (line.stock_state === 'out_of_stock' && !line.is_drop_ship) noticeBits.push({ text: 'Out of stock', color: A.bad })
  else if (line.stock_state === 'low_stock' && line.stock_qty_available != null) noticeBits.push({ text: `Only ${line.stock_qty_available} left`, color: A.warn })
  if (line.is_special_order)         noticeBits.push({ text: 'Special order', color: T.text3 })
  if (line.is_drop_ship || line.ships_from_supplier) noticeBits.push({ text: 'Ships from the supplier', color: T.text3 })

  const discounted = (line.promo_active || line.volume_break_applied) && line.unit_price_ex_gst < line.trade_price_ex_gst

  return (
    <div style={{
      display:'flex',gap:14,padding:'14px 16px',
      borderTop: isFirst ? 'none' : `1px solid ${T.border}`,
      opacity: busy ? 0.6 : 1,
      pointerEvents: busy ? 'none' : 'auto',
      alignItems:'center',
    }}>
      <div style={{
        width:62,height:62,flexShrink:0,
        borderRadius:12,background:'#fff',overflow:'hidden',
        display:'flex',alignItems:'center',justifyContent:'center',
      }}>
        {line.image_url ? (
          <img src={line.image_url} alt={line.name}
            style={{maxWidth:'100%',maxHeight:'100%',objectFit:'contain'}}
            onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}/>
        ) : (
          <span style={{fontSize:10,color:'#a7adb8'}}>photo</span>
        )}
      </div>

      <div style={{flex:1,minWidth:0}}>
        <div style={{fontSize:14.5,color:T.text,fontWeight:600,letterSpacing:'-0.005em',lineHeight:1.3}}>{line.name}</div>
        <div style={{display:'flex',alignItems:'baseline',gap:8,flexWrap:'wrap',marginTop:4,fontSize:12.5,color:T.text3}}>
          <span style={{fontVariantNumeric:'tabular-nums'}}>
            ${incGst(line.unit_price_ex_gst, line.is_taxable).toFixed(2)} each
          </span>
          {discounted && (
            <span style={{textDecoration:'line-through',fontVariantNumeric:'tabular-nums'}}>
              ${incGst(line.trade_price_ex_gst, line.is_taxable).toFixed(2)}
            </span>
          )}
          {line.volume_break_applied && line.volume_break_min_qty != null ? (
            <span style={{color:A.good,fontWeight:600}}>{line.volume_break_min_qty}+ price applied</span>
          ) : line.promo_active && discounted ? (
            <span style={{color:A.good,fontWeight:600}}>Promo price</span>
          ) : null}
          {line.instructions_url && (
            <a href={line.instructions_url} target="_blank" rel="noopener noreferrer"
              style={{color:A.accent,textDecoration:'none',fontWeight:550}}>
              Fitting guide (PDF)
            </a>
          )}
        </div>
        {noticeBits.length > 0 && (
          <div style={{display:'flex',gap:10,flexWrap:'wrap',marginTop:3,fontSize:12.5}}>
            {noticeBits.map((n, i) => <span key={i} style={{color:n.color,fontWeight:550}}>{n.text}</span>)}
          </div>
        )}
        {line.effective_cap !== null && line.qty > line.effective_cap && (
          <div style={{
            marginTop:8,padding:'8px 12px',
            background:alpha(A.bad, '12'),border:`1px solid ${alpha(A.bad, '3d')}`,borderRadius:RADIUS.sm,
            display:'flex',alignItems:'center',justifyContent:'space-between',gap:10,flexWrap:'wrap',
          }}>
            <span style={{fontSize:12.5,color:A.bad,lineHeight:1.4}}>
              {line.effective_cap === 0
                ? `Not available right now.`
                : line.max_order_qty != null && line.effective_cap === line.max_order_qty
                  ? `Max ${line.max_order_qty} per order (your cart has ${line.qty}).`
                  : `Only ${line.effective_cap} available right now (your cart has ${line.qty}).`}
            </span>
            {line.effective_cap === 0 ? (
              <Btn variant="danger" size="sm" onClick={onRemove}>Remove</Btn>
            ) : (
              <Btn variant="danger" size="sm" onClick={() => onChangeQty(line.effective_cap as number)}>Reduce to {line.effective_cap}</Btn>
            )}
          </div>
        )}
      </div>

      <div style={{display:'flex',flexDirection:'column',alignItems:'flex-end',gap:7,flexShrink:0}}>
        <Stepper qty={line.qty} max={line.effective_cap ?? null} onChange={onChangeQty} compact={!isMobile}/>
        <div style={{fontSize:15,color:T.text,fontWeight:650,fontVariantNumeric:'tabular-nums',letterSpacing:'-0.01em'}}>
          ${Number(line.line_total_inc_gst).toFixed(2)}
        </div>
        <button onClick={onRemove} aria-label={`Remove ${line.name}`} className="al-press al-ghost al-focus"
          style={{
            padding:'4px 10px',minHeight:28,background:'transparent',border:'none',borderRadius:RADIUS.pill,
            color:T.text3,fontSize:12,cursor:'pointer',fontFamily:'inherit',
          }}>
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

// ─── Checkout rail ─────────────────────────────────────────────────────
function CheckoutRail({
  totals, cardFee, customerPo, onCustomerPoChange, paymentMethod, onPaymentMethodChange, onCheckout, checkoutBusy, blockedReason,
  freight, selectedFreightId, onSelectFreight, isMobile,
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
  isMobile: boolean
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
  // PayTo and BECS carry the same Stripe pricing (1% + 30c capped $3.50), so
  // they share the surcharge helper.
  const paytoFeeInc    = (paymentMethod === 'payto' || paymentMethod === 'becs') ? paytoSurchargeInc(newSubtotalInc) : 0
  const grandTotalInc  = newSubtotalInc + newCardFeeInc + paytoFeeInc

  const poTrimmed = customerPo.trim()
  const poTooLong = poTrimmed.length > 20
  const poMissing = poTrimmed.length === 0
  const canCheckout = grandTotalInc > 0 && !blockedReason && !poMissing

  return (
    <div style={{
      background:T.bg2, border:`1px solid ${T.border}`, borderRadius:RADIUS.md,
      boxShadow:SHADOW.sm,
      padding:'18px 20px', position: isMobile ? 'static' : 'sticky', top:76,
      display:'flex', flexDirection:'column', gap:16,
    }}>
      {/* PO number — required, so it leads the rail instead of hiding at the
          bottom behind a disabled button. */}
      <Field
        label="Your PO number"
        required={poMissing}
        hint={poTooLong
          ? 'Maximum 20 characters'
          : poMissing
            ? 'A PO number is required to check out'
            : `${poTrimmed.length}/20 · written to your MYOB invoice`}
        hintColor={poTooLong ? A.bad : poMissing ? A.warn : T.text3}>
        <input
          type="text"
          value={customerPo}
          onChange={e => onCustomerPoChange(e.target.value)}
          placeholder="e.g. PO-12345"
          maxLength={20}
          required
          className="al-focus"
          style={inputStyle(poTooLong)}/>
      </Field>

      {/* Payment method — the bank methods (PayTo / BECS) skip the card
          surcharge. BECS exists for banks that don't support PayTo yet —
          NAB business accounts especially (Chris 2026-08-10). */}
      <div>
        <div style={{fontSize:12,color:T.text2,fontWeight:650,marginBottom:6}}>Pay with</div>
        <Seg
          options={[
            { id: 'card',  label: 'Card' },
            { id: 'payto', label: 'PayTo' },
            { id: 'becs',  label: 'Bank debit' },
          ] as const}
          value={paymentMethod}
          onChange={onPaymentMethodChange}/>
        <div style={{marginTop:8}}>
          {applySurcharge ? (
            <div style={{fontSize:12,color:T.text3,lineHeight:1.5}}>{cardFee.note} Apple Pay and Google Pay work here too.</div>
          ) : (
            <>
              <div style={{fontSize:12,color:A.good,lineHeight:1.5,marginBottom:4}}>
                Low bank fee (1% + 30c, capped at $3.50) — cheaper than card.
                {paymentMethod === 'becs' && ' Funds take 2–3 business days to clear; your order ships once the payment settles.'}
              </div>
              <Disclosure summary={paymentMethod === 'payto' ? 'How does PayTo work?' : 'How does bank debit work?'}>
                {paymentMethod === 'payto' ? (
                  <>
                    PayTo pays securely straight from your bank account. At the next step you’ll enter your <strong style={{color:T.text}}>PayID</strong> (the
                    email or mobile linked to your bank) or your <strong style={{color:T.text}}>BSB + account number</strong>, then approve the request in
                    your banking app. Most major Australian banks support it — if yours doesn’t (e.g. NAB business accounts), choose Bank debit
                    instead. <a href="https://payto.com.au/" target="_blank" rel="noreferrer" style={{color:A.accent,textDecoration:'none'}}>Learn more ↗</a>
                  </>
                ) : (
                  <>
                    Bank debit (BECS Direct Debit) — enter your <strong style={{color:T.text}}>BSB + account number</strong> and accept the debit agreement
                    at the next step. Works with any Australian bank account, including business accounts that don’t support PayTo yet.
                  </>
                )}
              </Disclosure>
            </>
          )}
        </div>
      </div>

      {/* Freight picker */}
      {freight && (
        <div>
          <div style={{display:'flex', alignItems:'baseline', justifyContent:'space-between', marginBottom:6}}>
            <div style={{fontSize:12,color:T.text2,fontWeight:650}}>Shipping to {freight.postcode}</div>
            {freight.mode === 'live' && (
              <span title="Quoted live from MachShip" style={{fontSize:12,color:A.good,fontWeight:650}}>Live quote</span>
            )}
            {freight.mode === 'static' && (
              <span title="Postcode-zone fallback rate" style={{fontSize:12,color:T.text3,fontWeight:600}}>Estimate</span>
            )}
          </div>
          {freight.mode === 'blocked' ? (
            <div style={{fontSize:12.5, color:A.bad, lineHeight:1.5}}>
              <div style={{fontWeight:600, marginBottom:4}}>Freight quote unavailable</div>
              <div style={{color:T.text2}}>
                {freight.blocked?.reason || 'Some items in your cart are missing shipping dimensions.'}
              </div>
              {freight.blocked?.missing && freight.blocked.missing.length > 0 && (
                <ul style={{margin:'6px 0 0', paddingLeft:18, color:T.text3, fontSize:12}}>
                  {freight.blocked.missing.slice(0, 6).map(m => (
                    <li key={m.sku}>{m.sku} — {m.name} <span style={{color:T.text3}}>(needs {m.missing_fields.join(', ')})</span></li>
                  ))}
                  {freight.blocked.missing.length > 6 && (
                    <li style={{listStyle:'none', color:T.text3}}>… and {freight.blocked.missing.length - 6} more</li>
                  )}
                </ul>
              )}
              <div style={{marginTop:6, color:T.text3, fontSize:12}}>Contact your account manager to get this sorted.</div>
            </div>
          ) : freight.rates.length > 0 ? (
            <div style={{display:'flex', flexDirection:'column', gap:7}}>
              {freight.rates.map(r => {
                const on = selectedFreightId === r.id
                return (
                  <label key={r.id} className="al-press" style={{
                    display:'flex', alignItems:'center', gap:10,
                    padding:'11px 13px', borderRadius:RADIUS.sm + 2, minHeight:44, boxSizing:'border-box',
                    border:`1px solid ${on ? A.accent : 'transparent'}`,
                    background: on ? alpha(A.accent, '10') : T.bg3,
                    cursor:'pointer', fontSize:13,
                  }}>
                    <input type="radio" name="freight" checked={on}
                      onChange={() => onSelectFreight(r.id)}
                      style={{accentColor:A.accent}}/>
                    <span style={{flex:1, color: on ? T.text : T.text2, fontWeight: on ? 600 : 450}}>
                      {r.label}
                      {r.source === 'satchel' && <span style={{color:A.good, fontWeight:650}}> · flat-rate satchel</span>}
                      {r.transit_days != null && <span style={{color:T.text3, fontWeight:400}}> · {r.transit_days} day{r.transit_days === 1 ? '' : 's'}</span>}
                    </span>
                    <span style={{color: on ? T.text : T.text2, fontWeight:600, fontVariantNumeric:'tabular-nums'}}>
                      ${(r.price_ex_gst * 1.10).toFixed(2)}
                    </span>
                  </label>
                )
              })}
            </div>
          ) : (
            <div style={{fontSize:12.5, color:A.warn, lineHeight:1.5}}>
              No freight rate configured for postcode {freight.postcode}. Contact your account manager for a quote.
            </div>
          )}
        </div>
      )}

      {/* Totals */}
      <div style={{borderTop:`1px solid ${T.border}`, paddingTop:10}}>
        <Row label="Items (inc GST)" value={`$${totals.subtotal_inc_gst.toFixed(2)}`}/>
        {selectedFreight && <Row label="Freight" value={`$${freightInc.toFixed(2)}`} muted/>}
        {applySurcharge
          ? <Row label="Card surcharge" value={`$${newCardFeeInc.toFixed(2)}`} muted/>
          : <Row label={paymentMethod === 'becs' ? 'Bank debit fee' : 'PayTo fee'} value={`$${paytoFeeInc.toFixed(2)}`} muted/>}
        <Row label="Total to pay" value={`$${grandTotalInc.toFixed(2)}`} large/>
        <div style={{fontSize:12,color:T.text3,marginTop:2}}>Includes ${newGst.toFixed(2)} GST</div>
      </div>

      <div>
        <Btn full size="lg" disabled={!canCheckout || checkoutBusy || poTooLong} onClick={onCheckout}>
          {checkoutBusy ? 'Connecting to Stripe…' : 'Check Out'}
        </Btn>
        <div style={{fontSize:12,color: blockedReason ? A.bad : T.text3,marginTop:8,textAlign:'center',lineHeight:1.5}}>
          {blockedReason || 'You’ll be redirected to Stripe to pay securely.'}
        </div>
      </div>
    </div>
  )
}

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  return await requireB2BPageAuth(ctx) as any
}
