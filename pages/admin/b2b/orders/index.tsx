// pages/admin/b2b/orders/index.tsx
//
// Staff orders dashboard. Shows every B2B order across all distributors
// with filter pills, search, distributor select, and date range.
// Click a row → /admin/b2b/orders/[id].

import { useEffect, useMemo, useState, useCallback } from 'react'
import Head from 'next/head'
import { useRouter } from 'next/router'
import PortalSidebar from '../../../../lib/PortalSidebar'
import { requirePageAuth } from '../../../../lib/authServer'
import type { UserRole } from '../../../../lib/permissions'

const T = {
  bg:'#0d0f12', bg2:'#131519', bg3:'#1a1d23', bg4:'#21252d',
  border:'rgba(255,255,255,0.07)', border2:'rgba(255,255,255,0.12)',
  text:'#e8eaf0', text2:'#8b90a0', text3:'#545968',
  blue:'#4f8ef7', teal:'#2dd4bf', green:'#34c77b',
  amber:'#f5a623', red:'#f04e4e', purple:'#a78bfa', accent:'#4f8ef7',
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

interface OrderRow {
  id: string
  order_number: string
  status: string
  customer_po: string | null
  subtotal_ex_gst: number
  gst: number
  card_fee_inc: number
  total_inc: number
  refunded_total: number
  currency: string
  created_at: string
  paid_at: string | null
  shipped_at: string | null
  cancelled_at: string | null
  myob_invoice_uid: string | null
  myob_invoice_number: string | null
  myob_write_error: string | null
  distributor: { id: string; display_name: string } | null
}

interface ListResponse {
  orders: OrderRow[]
  total_count: number
  page: { limit: number; offset: number }
  totals: { total_inc_sum: number; paid_sum: number }
  status_counts: Record<string, number>
  distributors: { id: string; display_name: string }[]
}

const STATUS_ORDER = ['pending_payment', 'paid', 'picking', 'packed', 'shipped', 'delivered', 'cancelled', 'refunded'] as const
const STATUS_LABEL: Record<string, string> = {
  pending_payment: 'Pending payment',
  paid: 'Paid',
  picking: 'Picking',
  packed: 'Packed',
  shipped: 'Shipped',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
  refunded: 'Refunded',
}
const STATUS_COLOR: Record<string, string> = {
  pending_payment: T.text3,
  paid: T.blue,
  picking: T.amber,
  packed: T.amber,
  shipped: T.teal,
  delivered: T.green,
  cancelled: T.red,
  refunded: T.purple,
}

export default function AdminOrdersListPage({ user }: Props) {
  const router = useRouter()

  // Filters from URL (so the URL is shareable + bookmarkable)
  const statusFilter      = String(router.query.status     || '')
  const distributorFilter = String(router.query.distributor || '')
  const dateFromFilter    = String(router.query.from       || '')
  const dateToFilter      = String(router.query.to         || '')
  const searchQuery       = String(router.query.q          || '')
  const offset            = parseInt(String(router.query.offset || '0'), 10) || 0
  const LIMIT = 50

  const [data, setData]       = useState<ListResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)
  const [searchInput, setSearchInput] = useState(searchQuery)

  // Sync the search input with the URL when navigation happens externally
  useEffect(() => { setSearchInput(searchQuery) }, [searchQuery])

  const updateFilter = useCallback((next: Record<string, string | null>) => {
    const q: Record<string, string> = { ...router.query as any }
    for (const k of Object.keys(next)) {
      const v = next[k]
      if (v === null || v === '') delete q[k]
      else q[k] = v
    }
    // Reset offset when filters change (unless we're explicitly setting it)
    if (!('offset' in next)) delete q.offset
    router.push({ pathname: router.pathname, query: q }, undefined, { shallow: false })
  }, [router])

  async function load() {
    setLoading(true); setError(null)
    try {
      const params = new URLSearchParams()
      if (statusFilter)      params.set('status',         statusFilter)
      if (distributorFilter) params.set('distributor_id', distributorFilter)
      if (dateFromFilter)    params.set('date_from',      dateFromFilter)
      if (dateToFilter)      params.set('date_to',        dateToFilter)
      if (searchQuery)       params.set('search',         searchQuery)
      params.set('limit',  String(LIMIT))
      params.set('offset', String(offset))

      const r = await fetch(`/api/b2b/admin/orders?${params}`, { credentials: 'same-origin' })
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`)
      const j: ListResponse = await r.json()
      setData(j)
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [statusFilter, distributorFilter, dateFromFilter, dateToFilter, searchQuery, offset])

  function applySearch() {
    const trimmed = searchInput.trim()
    updateFilter({ q: trimmed || null })
  }

  const totalPages = data ? Math.ceil(data.total_count / LIMIT) : 0
  const currentPage = Math.floor(offset / LIMIT) + 1

  return (
    <>
      <Head><title>B2B Orders · JA Portal</title></Head>
      <div style={{display:'flex',minHeight:'100vh',background:T.bg,color:T.text,fontFamily:'system-ui,-apple-system,sans-serif'}}>
        <PortalSidebar
          activeId="b2b"
          currentUserRole={user.role}
          currentUserVisibleTabs={user.visibleTabs}
          currentUserName={user.displayName}
          currentUserEmail={user.email}
        />
        <main style={{flex:1,padding:'28px 32px',maxWidth:1500}}>

          {/* Header */}
          <header style={{marginBottom:18,display:'flex',alignItems:'flex-end',justifyContent:'space-between',gap:16,flexWrap:'wrap'}}>
            <div>
              <div style={{fontSize:11,color:T.text3,textTransform:'uppercase',letterSpacing:'0.08em',marginBottom:4}}>
                <a href="/admin/b2b" style={{color:T.text3,textDecoration:'none'}}>B2B Portal</a>
                {' / '}
                <span style={{color:T.text2}}>Orders</span>
              </div>
              <h1 style={{fontSize:22,fontWeight:600,margin:0,letterSpacing:'-0.01em'}}>Orders</h1>
            </div>
            {data && (
              <div style={{display:'flex',gap:24,alignItems:'baseline'}}>
                <Stat n={data.total_count}                 label="orders"/>
                <Stat n={`$${money(data.totals.total_inc_sum)}`} label="filtered total" raw/>
                <Stat n={`$${money(data.totals.paid_sum)}`}      label="paid"           raw color={T.green}/>
              </div>
            )}
          </header>

          {/* Filter pills row */}
          {data && (
            <div style={{display:'flex',gap:6,flexWrap:'wrap',marginBottom:12}}>
              <FilterPill
                active={!statusFilter}
                onClick={() => updateFilter({ status: null })}
                count={data.status_counts['_all'] ?? null}>
                All
              </FilterPill>
              {STATUS_ORDER.map(s => (
                <FilterPill
                  key={s}
                  active={statusFilter === s}
                  onClick={() => updateFilter({ status: s })}
                  color={STATUS_COLOR[s]}
                  count={data.status_counts[s] ?? 0}>
                  {STATUS_LABEL[s]}
                </FilterPill>
              ))}
            </div>
          )}

          {/* Secondary filters */}
          {data && (
            <div style={{
              display:'flex',gap:10,alignItems:'center',flexWrap:'wrap',
              padding:'10px 12px',background:T.bg2,border:`1px solid ${T.border}`,
              borderRadius:8,marginBottom:14,
            }}>
              <input
                type="text"
                placeholder="Search order # or PO…"
                value={searchInput}
                onChange={e => setSearchInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') applySearch() }}
                style={{
                  flex:1,minWidth:220,
                  background:T.bg3,border:`1px solid ${T.border2}`,color:T.text,
                  borderRadius:5,padding:'7px 11px',fontSize:13,outline:'none',
                  fontFamily:'inherit',boxSizing:'border-box',
                }}/>
              <button onClick={applySearch}
                style={iconBtn(true)}>
                Search
              </button>

              <select
                value={distributorFilter}
                onChange={e => updateFilter({ distributor: e.target.value || null })}
                style={selectStyle()}>
                <option value="">All distributors</option>
                {data.distributors.map(d => (
                  <option key={d.id} value={d.id}>{d.display_name}</option>
                ))}
              </select>

              <input
                type="date"
                value={dateFromFilter}
                onChange={e => updateFilter({ from: e.target.value || null })}
                style={dateStyle()}/>
              <span style={{color:T.text3,fontSize:11}}>→</span>
              <input
                type="date"
                value={dateToFilter}
                onChange={e => updateFilter({ to: e.target.value || null })}
                style={dateStyle()}/>

              {(statusFilter || distributorFilter || dateFromFilter || dateToFilter || searchQuery) && (
                <button
                  onClick={() => router.push({ pathname: router.pathname }, undefined, { shallow: false })}
                  style={{...iconBtn(false), color:T.amber, borderColor:`${T.amber}40`}}>
                  Clear filters
                </button>
              )}
            </div>
          )}

          {/* Errors */}
          {error && (
            <div style={{padding:10,background:`${T.red}15`,border:`1px solid ${T.red}40`,borderRadius:7,color:T.red,fontSize:12,marginBottom:10}}>
              Couldn't load orders: {error}
            </div>
          )}

          {/* Table */}
          <div style={{
            background:T.bg2,border:`1px solid ${T.border}`,borderRadius:10,overflow:'hidden',
          }}>
            <div style={{overflowX:'auto'}}>
              <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
                <thead>
                  <tr style={{borderBottom:`1px solid ${T.border2}`}}>
                    <th style={th(140)}>Order</th>
                    <th style={th()}>Distributor</th>
                    <th style={th(110)}>Placed</th>
                    <th style={th(110)}>Status</th>
                    <th style={{...th(110),textAlign:'right'}}>Total (inc)</th>
                    <th style={th(120)}>MYOB #</th>
                    <th style={th(60)}></th>
                  </tr>
                </thead>
                <tbody>
                  {data && data.orders.length === 0 && !loading && (
                    <tr><td colSpan={7} style={{padding:30,textAlign:'center',color:T.text3,fontSize:12}}>
                      No orders match these filters.
                    </td></tr>
                  )}
                  {data?.orders.map((o, i) => (
                    <OrderRowDisplay key={o.id} order={o} isFirst={i === 0}/>
                  ))}
                  {loading && (
                    <tr><td colSpan={7} style={{padding:30,textAlign:'center',color:T.text3,fontSize:12}}>Loading…</td></tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            {data && totalPages > 1 && (
              <div style={{
                padding:'10px 16px',borderTop:`1px solid ${T.border2}`,
                display:'flex',justifyContent:'space-between',alignItems:'center',gap:14,
                fontSize:11,color:T.text3,
              }}>
                <span>
                  Showing {offset + 1}–{Math.min(offset + LIMIT, data.total_count)} of {data.total_count}
                </span>
                <div style={{display:'flex',gap:6}}>
                  <button
                    disabled={offset === 0}
                    onClick={() => updateFilter({ offset: String(Math.max(0, offset - LIMIT)) })}
                    style={iconBtn(offset > 0)}>
                    ← Prev
                  </button>
                  <span style={{padding:'6px 10px'}}>
                    {currentPage} / {totalPages}
                  </span>
                  <button
                    disabled={offset + LIMIT >= data.total_count}
                    onClick={() => updateFilter({ offset: String(offset + LIMIT) })}
                    style={iconBtn(offset + LIMIT < data.total_count)}>
                    Next →
                  </button>
                </div>
              </div>
            )}
          </div>

        </main>
      </div>
    </>
  )
}

// ─── Row component ─────────────────────────────────────────────────────
function OrderRowDisplay({ order, isFirst }: { order: OrderRow; isFirst: boolean }) {
  const dist = order.distributor?.display_name || '—'
  const placedDate = new Date(order.created_at).toLocaleDateString('en-AU', { day:'2-digit', month:'short', year:'numeric' })
  const placedTime = new Date(order.created_at).toLocaleTimeString('en-AU', { hour:'2-digit', minute:'2-digit' })

  return (
    <tr style={{
      borderTop: isFirst ? 'none' : `1px solid ${T.border}`,
      cursor:'pointer',
    }}
      onClick={() => { window.location.href = `/admin/b2b/orders/${order.id}` }}>

      <td style={td()}>
        <div style={{fontFamily:'monospace',fontSize:12,color:T.text}}>{order.order_number}</div>
        {order.customer_po && (
          <div style={{fontSize:10,color:T.text3,marginTop:2}}>PO: {order.customer_po}</div>
        )}
      </td>

      <td style={td()}>
        <div style={{fontSize:12,color:T.text}}>{dist}</div>
      </td>

      <td style={{...td(),fontSize:11,color:T.text3,fontFamily:'monospace',whiteSpace:'nowrap'}}>
        {placedDate}
        <div style={{fontSize:10,color:T.text3,opacity:0.7}}>{placedTime}</div>
      </td>

      <td style={td()}>
        <StatusPill status={order.status}/>
        {Number(order.refunded_total) > 0 && (
          <div style={{fontSize:10,color:T.purple,marginTop:3}}>
            -${money(Number(order.refunded_total))} refunded
          </div>
        )}
      </td>

      <td style={{...td(),textAlign:'right',fontFamily:'monospace',fontVariantNumeric:'tabular-nums'}}>
        ${money(Number(order.total_inc))}
      </td>

      <td style={{...td(),fontSize:11}}>
        {order.myob_invoice_number ? (
          <span style={{fontFamily:'monospace',color:T.text2}}>{order.myob_invoice_number}</span>
        ) : order.myob_write_error ? (
          <span style={{color:T.red}}>⚠ failed</span>
        ) : order.status === 'pending_payment' ? (
          <span style={{color:T.text3}}>—</span>
        ) : (
          <span style={{color:T.amber}}>pending</span>
        )}
      </td>

      <td style={{...td(),textAlign:'right'}}>
        <span style={{color:T.text3,fontSize:14}}>›</span>
      </td>

    </tr>
  )
}

function StatusPill({ status }: { status: string }) {
  const color = STATUS_COLOR[status] || T.text3
  const label = STATUS_LABEL[status] || status
  return (
    <span style={{
      display:'inline-flex',alignItems:'center',gap:5,
      padding:'2px 8px',borderRadius:4,
      background:`${color}15`,border:`1px solid ${color}40`,color,
      fontSize:10,fontWeight:600,
      textTransform:'uppercase',letterSpacing:'0.04em',whiteSpace:'nowrap',
    }}>
      <span style={{display:'inline-block',width:6,height:6,borderRadius:'50%',background:color}}/>
      {label}
    </span>
  )
}

function FilterPill({ active, onClick, color, count, children }: { active: boolean; onClick: () => void; color?: string; count?: number | null; children: React.ReactNode }) {
  return (
    <button onClick={onClick}
      style={{
        padding:'5px 10px',borderRadius:5,
        border:`1px solid ${active ? (color || T.blue) : T.border2}`,
        background: active ? `${color || T.blue}20` : 'transparent',
        color: active ? (color || T.blue) : T.text2,
        fontSize:11,fontWeight: active ? 600 : 400,
        cursor:'pointer',fontFamily:'inherit',whiteSpace:'nowrap',
        display:'inline-flex',alignItems:'center',gap:6,
      }}>
      {children}
      {count != null && (
        <span style={{
          fontSize:10,
          padding:'1px 6px',borderRadius:8,
          background: active ? `${color || T.blue}30` : T.bg3,
          color: active ? (color || T.blue) : T.text3,
        }}>
          {count}
        </span>
      )}
    </button>
  )
}

function Stat({ n, label, color, raw }: { n: number | string; label: string; color?: string; raw?: boolean }) {
  return (
    <div style={{display:'flex',alignItems:'baseline',gap:6}}>
      <span style={{fontSize:18,fontWeight:600,color: color || T.text,fontVariantNumeric:'tabular-nums'}}>
        {raw ? n : (typeof n === 'number' ? n.toLocaleString('en-AU') : n)}
      </span>
      <span style={{fontSize:10,color:T.text3,textTransform:'uppercase',letterSpacing:'0.05em'}}>{label}</span>
    </div>
  )
}

function money(n: number): string {
  return n.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function th(width?: number): React.CSSProperties {
  return {
    fontSize:10,color:T.text3,padding:'10px 12px',
    textAlign:'left',fontWeight:500,
    textTransform:'uppercase',letterSpacing:'0.05em',
    width,whiteSpace:'nowrap',background:T.bg2,
  }
}
function td(): React.CSSProperties {
  return { padding:'10px 12px',verticalAlign:'middle' }
}
function iconBtn(enabled: boolean): React.CSSProperties {
  return {
    padding:'6px 10px',borderRadius:5,
    border:`1px solid ${T.border2}`,
    background:'transparent',
    color: enabled ? T.text2 : T.text3,
    fontSize:11,fontFamily:'inherit',
    cursor: enabled ? 'pointer' : 'not-allowed',
  }
}
function selectStyle(): React.CSSProperties {
  return {
    padding:'7px 10px',borderRadius:5,
    background:T.bg3,border:`1px solid ${T.border2}`,
    color:T.text,fontSize:12,fontFamily:'inherit',
    outline:'none',cursor:'pointer',
  }
}
function dateStyle(): React.CSSProperties {
  return {
    padding:'6px 10px',borderRadius:5,
    background:T.bg3,border:`1px solid ${T.border2}`,
    color:T.text,fontSize:11,fontFamily:'inherit',
    outline:'none',colorScheme:'dark',
  }
}

export async function getServerSideProps(context: any) {
  return requirePageAuth(context, 'view:b2b')
}
