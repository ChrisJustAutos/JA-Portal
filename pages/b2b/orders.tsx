// pages/b2b/orders.tsx
//
// Distributor order history list.

import { useEffect, useState } from 'react'
import Head from 'next/head'
import type { GetServerSideProps } from 'next'
import B2BLayout from '../../components/b2b/B2BLayout'
import { requireB2BPageAuth } from '../../lib/b2bAuthServer'

const T = {
  bg:'#0d0f12', bg2:'#131519', bg3:'#1a1d23', bg4:'#21252d',
  border:'rgba(255,255,255,0.07)', border2:'rgba(255,255,255,0.12)',
  text:'#e8eaf0', text2:'#aab0c0', text3:'#8d93a4',
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

        <header style={{display:'flex',alignItems:'flex-end',justifyContent:'space-between',marginBottom:18,gap:12,flexWrap:'wrap'}}>
          <div>
            <h1 style={{fontSize:22,fontWeight:600,margin:0,letterSpacing:'-0.01em'}}>Orders</h1>
            <div style={{fontSize:13,color:T.text3,marginTop:4}}>
              Recent purchases for {b2bUser.distributor.displayName}.
            </div>
          </div>
          <button onClick={load} disabled={loading}
            style={{padding:'7px 12px',borderRadius:5,border:`1px solid ${T.border2}`,background:'transparent',color:T.text2,fontSize:12,cursor:loading?'wait':'pointer',fontFamily:'inherit'}}>
            {loading ? '…' : '↻'}
          </button>
        </header>

        {error && (
          <div style={{padding:12,background:`${T.red}15`,border:`1px solid ${T.red}40`,borderRadius:7,color:T.red,fontSize:13,marginBottom:14}}>
            {error}
          </div>
        )}

        {!loading && orders.length === 0 && !error && (
          <div style={{padding:36,textAlign:'center',background:T.bg2,border:`1px solid ${T.border}`,borderRadius:10}}>
            <div style={{fontSize:14,color:T.text2,marginBottom:14}}>No orders yet.</div>
            <a href="/b2b/catalogue"
              style={{display:'inline-block',padding:'9px 18px',borderRadius:6,border:`1px solid ${T.blue}`,background:T.blue,color:'#fff',fontSize:13,fontWeight:500,textDecoration:'none'}}>
              Browse catalogue
            </a>
          </div>
        )}

        {orders.length > 0 && (
          <div style={{background:T.bg2,border:`1px solid ${T.border}`,borderRadius:10,overflow:'hidden'}}>
            <table style={{width:'100%',borderCollapse:'collapse'}}>
              <thead>
                <tr style={{background:T.bg3,borderBottom:`1px solid ${T.border2}`}}>
                  <Th>Order</Th>
                  <Th>Placed</Th>
                  <Th>Status</Th>
                  <Th align="right">Total</Th>
                  <Th>MYOB Invoice</Th>
                  <Th width={50}/>
                </tr>
              </thead>
              <tbody>
                {orders.map(o => (
                  <tr key={o.id} style={{borderBottom:`1px solid ${T.border}`}}>
                    <Td><a href={`/b2b/orders/${o.id}`} style={{color:T.text,textDecoration:'none',fontWeight:500}}>{o.order_number}</a></Td>
                    <Td muted>{formatDate(o.placed_at)}</Td>
                    <Td><StatusPill status={o.status} hasError={!!o.myob_write_error}/></Td>
                    <Td align="right">${Number(o.total_inc).toFixed(2)}</Td>
                    <Td muted>{o.myob_invoice_number || (o.status === 'paid' ? <span style={{color:T.amber}}>processing…</span> : '—')}</Td>
                    <Td><a href={`/b2b/orders/${o.id}`} style={{color:T.blue,textDecoration:'none',fontSize:12}}>→</a></Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

      </B2BLayout>
    </>
  )
}

function Th({ children, align, width }: { children?: React.ReactNode; align?: 'left'|'right'; width?: number }) {
  return (
    <th style={{
      textAlign: align || 'left',
      fontSize:10,fontWeight:500,color:T.text3,
      textTransform:'uppercase',letterSpacing:'0.06em',
      padding:'10px 14px',
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
      fontSize:13,color: muted ? T.text2 : T.text,
      padding:'12px 14px',
      fontVariantNumeric: align === 'right' ? 'tabular-nums' : undefined,
    }}>
      {children}
    </td>
  )
}

function StatusPill({ status, hasError }: { status: string; hasError?: boolean }) {
  const c = colorFor(status)
  const label = labelFor(status)
  return (
    <span style={{
      display:'inline-flex',alignItems:'center',gap:5,
      fontSize:10,fontWeight:500,
      padding:'2px 8px',borderRadius:8,
      background:`${c}18`,color:c,
    }}>
      {label}
      {hasError && status === 'paid' && (
        <span title="MYOB writeback failed — staff have been notified" style={{color:T.amber}}>⚠</span>
      )}
    </span>
  )
}

function colorFor(status: string): string {
  switch (status) {
    case 'pending_payment': return T.amber
    case 'paid':            return T.green
    case 'picking':         return T.teal
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
