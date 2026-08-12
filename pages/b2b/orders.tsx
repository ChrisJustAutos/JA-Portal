// pages/b2b/orders.tsx
//
// Distributor order history list. Alloy look: dot status pills, airier
// table on desktop, tappable cards on mobile.

import { useEffect, useState } from 'react'
import Head from 'next/head'
import type { GetServerSideProps } from 'next'
import B2BLayout from '../../components/b2b/B2BLayout'
import { requireB2BPageAuth } from '../../lib/b2bAuthServer'
import { useIsMobile } from '../../lib/useIsMobile'
import { T } from '../../lib/ui/theme'
import { A, RADIUS, Banner, Btn, btnStyle, Card, EmptyState, PageTitle, StatusPill, orderStatusColor, orderStatusLabel } from '../../components/b2b/ui'

interface Props {
  b2bUser: {
    id: string
    email: string
    fullName: string | null
    role: 'owner' | 'member'
    distributor: { id: string; displayName: string }
  }
}

interface OrderRow {
  id: string
  order_number: string
  status: string
  subtotal_ex_gst: number
  gst: number
  card_fee_inc: number
  total_inc: number
  currency: string
  placed_at: string
  paid_at: string | null
  myob_invoice_number: string | null
  myob_write_error: string | null
}

export default function OrdersListPage({ b2bUser }: Props) {
  const isMobile = useIsMobile()
  const [orders, setOrders] = useState<OrderRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const r = await fetch('/api/b2b/orders', { credentials: 'same-origin' })
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`)
      const j = await r.json()
      setOrders(j.orders || [])
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [])

  return (
    <>
      <Head><title>Orders · Just Autos B2B</title></Head>
      <B2BLayout user={b2bUser} active="orders">

        <PageTitle
          sub={`Recent purchases for ${b2bUser.distributor.displayName}.`}
          action={
            <Btn variant="ghost" size="sm" onClick={load} disabled={loading}>
              {loading ? 'Loading…' : 'Reload'}
            </Btn>
          }>
          Orders
        </PageTitle>

        {error && <div style={{marginBottom:14}}><Banner tone="error">{error}</Banner></div>}

        {!loading && orders.length === 0 && !error && (
          <EmptyState
            title="No orders yet"
            action={<a href="/b2b/catalogue" style={{...btnStyle('primary', 'md'), textDecoration:'none'}}>Browse the catalogue</a>}/>
        )}

        {orders.length > 0 && isMobile && (
          /* Mobile: card list (touch-friendly, easy to scan on a phone) */
          <div style={{display:'flex',flexDirection:'column',gap:12}}>
            {orders.map(o => (
              <a key={o.id} href={`/b2b/orders/${o.id}`} className="al-raise"
                style={{
                  display:'block',
                  background:T.bg2, border:`1px solid ${T.border}`, borderRadius:RADIUS.md,
                  boxShadow:'var(--a-shadow-sm)',
                  padding:'15px 17px',
                  textDecoration:'none', color: T.text,
                }}>
                <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:8,flexWrap:'wrap'}}>
                  <strong style={{fontSize:15,fontWeight:650,letterSpacing:'-0.01em'}}>{o.order_number}</strong>
                  <OrderStatus status={o.status} hasError={!!o.myob_write_error}/>
                  <span style={{flex:1}}/>
                  <span style={{fontSize:15,fontWeight:650,color:T.text,fontVariantNumeric:'tabular-nums',letterSpacing:'-0.01em'}}>
                    ${Number(o.total_inc).toFixed(2)}
                  </span>
                </div>
                <div style={{display:'flex',alignItems:'center',gap:10,fontSize:12.5,color:T.text3,flexWrap:'wrap'}}>
                  <span>{formatDate(o.placed_at)}</span>
                  <span style={{flex:1}}/>
                  <span>
                    {o.myob_invoice_number
                      ? `Invoice ${o.myob_invoice_number}`
                      : (o.status === 'paid' ? <span style={{color:A.warn}}>Processing…</span> : '')}
                  </span>
                </div>
              </a>
            ))}
          </div>
        )}

        {orders.length > 0 && !isMobile && (
          /* Desktop: traditional table */
          <Card pad={false}>
            <table style={{width:'100%',borderCollapse:'collapse'}}>
              <thead>
                <tr style={{borderBottom:`1px solid ${T.border2}`}}>
                  <Th>Order</Th>
                  <Th>Placed</Th>
                  <Th>Status</Th>
                  <Th align="right">Total</Th>
                  <Th>Invoice</Th>
                  <Th width={50}/>
                </tr>
              </thead>
              <tbody>
                {orders.map(o => (
                  <tr key={o.id} style={{borderBottom:`1px solid ${T.border}`}}>
                    <Td><a href={`/b2b/orders/${o.id}`} style={{color:T.text,textDecoration:'none',fontWeight:600}}>{o.order_number}</a></Td>
                    <Td muted>{formatDate(o.placed_at)}</Td>
                    <Td><OrderStatus status={o.status} hasError={!!o.myob_write_error}/></Td>
                    <Td align="right"><strong style={{fontWeight:600}}>${Number(o.total_inc).toFixed(2)}</strong></Td>
                    <Td muted>{o.myob_invoice_number || (o.status === 'paid' ? <span style={{color:A.warn}}>processing…</span> : '—')}</Td>
                    <Td><a href={`/b2b/orders/${o.id}`} aria-label={`View order ${o.order_number}`} style={{color:A.accent,textDecoration:'none',fontSize:15}}>›</a></Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}

      </B2BLayout>
    </>
  )
}

function Th({ children, align, width }: { children?: React.ReactNode; align?: 'left'|'right'; width?: number }) {
  return (
    <th style={{
      textAlign: align || 'left',
      fontSize:12,fontWeight:600,color:T.text3,
      padding:'13px 16px',
      width: width || 'auto',
    }}>
      {children}
    </th>
  )
}

function Td({ children, align, muted }: { children?: React.ReactNode; align?: 'left'|'right'; muted?: boolean }) {
  return (
    <td style={{
      textAlign: align || 'left',
      fontSize:13.5,color: muted ? T.text2 : T.text,
      padding:'14px 16px',
      fontVariantNumeric: align === 'right' ? 'tabular-nums' : undefined,
    }}>
      {children}
    </td>
  )
}

function OrderStatus({ status, hasError }: { status: string; hasError?: boolean }) {
  return (
    <StatusPill color={orderStatusColor(status)}>
      {orderStatusLabel(status)}
      {hasError && status === 'paid' && (
        <span title="Invoice generation is delayed — staff have been notified" style={{color:A.warn}}> ·</span>
      )}
    </StatusPill>
  )
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
