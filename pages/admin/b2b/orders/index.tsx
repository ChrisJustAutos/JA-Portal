// pages/admin/b2b/orders/index.tsx
//
// Staff orders dashboard. Shows every B2B order across all distributors
// with filter pills, search, distributor select, and date range.
// Click a row → /admin/b2b/orders/[id].

import { useEffect, useMemo, useState, useCallback } from 'react'
import Head from 'next/head'
import { useRouter } from 'next/router'
import PortalTopBar from '../../../../lib/PortalTopBar'
import B2BAdminTabs from '../../../../components/b2b/B2BAdminTabs'
import { AppIcon } from '../../../../lib/AppIcons'
import { usePreferences } from '../../../../lib/preferences'
import { useIsMobile } from '../../../../lib/useIsMobile'
import { requirePageAuth } from '../../../../lib/authServer'
import type { UserRole } from '../../../../lib/permissions'
import { SkeletonRows } from '../../../../components/ui'

const T = {
  bg:'var(--t-bg)', bg2:'var(--t-bg2)', bg3:'var(--t-bg3)', bg4:'var(--t-bg4)',
  border:'var(--t-border)', border2:'var(--t-border2)',
  text:'var(--t-text)', text2:'var(--t-text2)', text3:'var(--t-text3)',
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
  is_test: boolean | null
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
const STATUS_ICON: Record<string, string> = {
  pending_payment: 'pending',
  paid: 'payables',
  picking: 'stocktake',
  packed: 'orders',
  shipped: 'truck',
  delivered: 'check-circle',
  cancelled: 'x-circle',
  refunded: 'refund',
}

function genGroupId(): string { return 'osg_' + Math.random().toString(36).slice(2, 10) }

// A tile is either a single status or a user-defined group of statuses.
interface StatusTile { id: string; label: string; statuses: string[]; color: string; icon: string; isGroup: boolean }

export default function AdminOrdersListPage({ user }: Props) {
  const router = useRouter()
  const isMobile = useIsMobile()

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

  // Per-user combined status buckets + drag-to-combine state.
  const { prefs, update } = usePreferences()
  const [drag, setDrag] = useState<{ id: string; statuses: string[] } | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)
  const [tileEdit, setTileEdit] = useState(false)
  useEffect(() => {
    const clear = () => { setDrag(null); setDragOverId(null) }
    window.addEventListener('dragend', clear)
    window.addEventListener('drop', clear)
    return () => { window.removeEventListener('dragend', clear); window.removeEventListener('drop', clear) }
  }, [])

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

  // ── Status tiles (groups + ungrouped statuses) ──────────────────────
  const groups = (prefs.order_status_groups || []).filter(g => g.statuses.length > 0)
  const groupedStatuses = new Set<string>(groups.flatMap(g => g.statuses))
  const statusCount = (s: string) => (data?.status_counts?.[s] ?? 0)
  const tiles: StatusTile[] = useMemo(() => {
    const groupTiles: StatusTile[] = groups.map(g => ({
      id: g.id, label: g.name, statuses: g.statuses, isGroup: true,
      color: STATUS_COLOR[g.statuses[0]] || T.blue, icon: 'all',
    }))
    const singleTiles: StatusTile[] = STATUS_ORDER.filter(s => !groupedStatuses.has(s)).map(s => ({
      id: s, label: STATUS_LABEL[s], statuses: [s], isGroup: false,
      color: STATUS_COLOR[s], icon: STATUS_ICON[s] || 'all',
    }))
    return [...groupTiles, ...singleTiles]
  }, [prefs.order_status_groups, data?.status_counts])

  const activeSet = new Set(statusFilter ? statusFilter.split(',').filter(Boolean) : [])
  const sameSet = (a: string[], b: Set<string>) => a.length === b.size && a.every(x => b.has(x))

  const saveGroups = (next: typeof groups) => { update({ order_status_groups: next }).catch(() => {}) }

  function combineTiles(targetId: string, draggedId: string) {
    if (targetId === draggedId) return
    const target = tiles.find(t => t.id === targetId)
    const dragged = tiles.find(t => t.id === draggedId)
    if (!target || !dragged) return
    const union = Array.from(new Set([...target.statuses, ...dragged.statuses]))
    // Drop any existing group that overlaps the union, then add the merged one.
    const keep = groups.filter(g => !g.statuses.some(s => union.includes(s)))
    const merged = {
      id: target.isGroup ? target.id : genGroupId(),
      name: target.isGroup ? target.label : 'Group',
      statuses: union,
    }
    saveGroups([merged, ...keep])
  }
  function ungroup(groupId: string) {
    saveGroups(groups.filter(g => g.id !== groupId))
  }
  function renameGroup(groupId: string, name: string) {
    const trimmed = name.trim().slice(0, 40) || 'Group'
    saveGroups(groups.map(g => g.id === groupId ? { ...g, name: trimmed } : g))
  }

  return (
    <>
      <Head><title>B2B Orders · JA Portal</title></Head>
      <div style={{display:'flex',flexDirection:'column',minHeight:'100vh',background:T.bg,color:T.text,fontFamily:'system-ui,-apple-system,sans-serif'}}>
        <PortalTopBar
          activeId="b2b"
          currentUserRole={user.role}
          currentUserVisibleTabs={user.visibleTabs}
          currentUserName={user.displayName}
          currentUserEmail={user.email}
        />
        <main className="b2b-admin-main" style={{flex:1,padding: isMobile ? '16px 14px' : '28px 32px',width:'100%',boxSizing:'border-box'}}>
          <B2BAdminTabs active="orders"/>

          {/* Header */}
          <header style={{marginBottom:18,display:'flex',alignItems:'flex-end',justifyContent:'space-between',gap:16,flexWrap:'wrap'}}>
            <div>
              <div style={{fontSize:12,color:T.text3,textTransform:'uppercase',letterSpacing:'0.08em',marginBottom:4}}>
                <a href="/admin/b2b" style={{color:T.text3,textDecoration:'none'}}>B2B Portal</a>
                {' / '}
                <span style={{color:T.text2}}>Orders</span>
              </div>
              <h1 style={{fontSize:22,fontWeight:600,margin:0,letterSpacing:'-0.01em'}}>Orders</h1>
              <button onClick={()=>router.push('/admin/b2b/test-order')}
                style={{marginTop:8,padding:'6px 12px',borderRadius:6,border:`1px solid ${T.amber}55`,background:`${T.amber}18`,color:T.amber,fontSize:12,fontWeight:600,cursor:'pointer',fontFamily:'inherit'}}>
                + Place test order
              </button>
            </div>
            {data && (
              <div style={{display:'flex',gap:24,alignItems:'baseline'}}>
                <Stat n={data.total_count}                 label="orders"/>
                <Stat n={`$${money(data.totals.total_inc_sum)}`} label="filtered total" raw/>
                <Stat n={`$${money(data.totals.paid_sum)}`}      label="paid"           raw color={T.green}/>
              </div>
            )}
          </header>

          {/* Status tiles — click to filter, drag one onto another to combine */}
          {data && (
            <div style={{marginBottom:14}}>
              <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:8}}>
                <span style={{fontSize:10,color:T.text3,textTransform:'uppercase',letterSpacing:'0.06em',fontWeight:600}}>Filter by status</span>
                <button onClick={() => setTileEdit(e => !e)}
                  style={{background: tileEdit ? T.accent : 'transparent',border:`1px solid ${tileEdit ? T.accent : T.border2}`,color: tileEdit ? '#fff' : T.text3,borderRadius:6,padding:'3px 9px',fontSize:11,fontFamily:'inherit',cursor:'pointer'}}>
                  {tileEdit ? 'Done' : '✎ Edit buckets'}
                </button>
                {tileEdit
                  ? <span style={{fontSize:11,color:T.text3}}>Rename or ungroup combined buckets. Drag is paused.</span>
                  : <span style={{fontSize:11,color:T.text3}}>Drag one tile onto another to combine.</span>}
              </div>
              <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill, minmax(150px, 1fr))',gap:10}}>
                {/* All */}
                <StatusCard
                  label="All orders" icon="all" color={T.blue}
                  count={data.status_counts['_all'] ?? null}
                  active={activeSet.size === 0}
                  onClick={() => updateFilter({ status: null })}
                />
                {tiles.map(t => {
                  const count = t.statuses.reduce((sum, s) => sum + statusCount(s), 0)
                  return (
                    <StatusCard
                      key={t.id}
                      label={t.label} icon={t.icon} color={t.color}
                      count={count}
                      active={sameSet(t.statuses, activeSet)}
                      isGroup={t.isGroup}
                      editMode={tileEdit}
                      draggable={!tileEdit}
                      isDragging={drag?.id === t.id}
                      isDropTarget={dragOverId === t.id && !!drag && drag.id !== t.id}
                      onClick={() => updateFilter({ status: t.statuses.join(',') })}
                      onRename={(name) => renameGroup(t.id, name)}
                      onUngroup={() => ungroup(t.id)}
                      onDragStart={(e) => { e.dataTransfer.setData('text/plain', t.id); e.dataTransfer.effectAllowed = 'move'; setDrag({ id: t.id, statuses: t.statuses }) }}
                      onDragEnd={() => { setDrag(null); setDragOverId(null) }}
                      onDragOver={(e) => { if (drag && drag.id !== t.id) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDragOverId(t.id) } }}
                      onDrop={(e) => { e.preventDefault(); const d = drag; setDrag(null); setDragOverId(null); if (d && d.id !== t.id) combineTiles(t.id, d.id) }}
                    />
                  )
                })}
              </div>
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
              <span style={{color:T.text3,fontSize:12}}>→</span>
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
            <div style={{padding:10,background:`${T.red}15`,border:`1px solid ${T.red}40`,borderRadius:7,color:T.red,fontSize:13,marginBottom:10}}>
              Couldn't load orders: {error}
            </div>
          )}

          {/* Table */}
          <div style={{
            background:T.bg2,border:`1px solid ${T.border}`,borderRadius:10,overflow:'hidden',
          }}>
            <div style={{overflowX:'auto'}}>
              <table className="b2b-cards" style={{width:'100%',borderCollapse:'collapse',fontSize:13}}>
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
                    <tr><td colSpan={7} style={{padding:30,textAlign:'center',color:T.text3,fontSize:13}}>
                      No orders match these filters.
                    </td></tr>
                  )}
                  {data?.orders.map((o, i) => (
                    <OrderRowDisplay key={o.id} order={o} isFirst={i === 0}/>
                  ))}
                  {loading && (
                    <tr><td colSpan={7} style={{padding:0}}><SkeletonRows rows={8}/></td></tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            {data && totalPages > 1 && (
              <div style={{
                padding:'10px 16px',borderTop:`1px solid ${T.border2}`,
                display:'flex',justifyContent:'space-between',alignItems:'center',gap:14,
                fontSize:12,color:T.text3,
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

      <td className="b2b-card-title" style={td()}>
        <div style={{fontFamily:'monospace',fontSize:13,color:T.text}}>{order.order_number}{order.is_test && <span style={{marginLeft:6,fontFamily:'inherit',fontSize:9,padding:'1px 6px',borderRadius:8,background:`${T.amber}22`,color:T.amber,border:`1px solid ${T.amber}55`,verticalAlign:'middle'}}>TEST</span>}</div>
        {order.customer_po && (
          <div style={{fontSize:10,color:T.text3,marginTop:2}}>PO: {order.customer_po}</div>
        )}
      </td>

      <td data-label="Distributor" style={td()}>
        <div style={{fontSize:13,color:T.text}}>{dist}</div>
      </td>

      <td data-label="Placed" style={{...td(),fontSize:12,color:T.text3,fontFamily:'monospace',whiteSpace:'nowrap'}}>
        {placedDate}
        <div style={{fontSize:10,color:T.text3,opacity:0.7}}>{placedTime}</div>
      </td>

      <td data-label="Status" style={td()}>
        <StatusPill status={order.status}/>
        {Number(order.refunded_total) > 0 && (
          <div style={{fontSize:10,color:T.purple,marginTop:3}}>
            -${money(Number(order.refunded_total))} refunded
          </div>
        )}
      </td>

      <td data-label="Total (inc)" style={{...td(),textAlign:'right',fontFamily:'monospace',fontVariantNumeric:'tabular-nums'}}>
        ${money(Number(order.total_inc))}
      </td>

      <td data-label="MYOB #" style={{...td(),fontSize:12}}>
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

      <td className="b2b-card-hide" style={{...td(),textAlign:'right'}}>
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

function StatusCard({
  label, icon, color, count, active, isGroup, editMode, draggable, isDragging, isDropTarget,
  onClick, onRename, onUngroup, onDragStart, onDragEnd, onDragOver, onDrop,
}: {
  label: string
  icon: string
  color: string
  count: number | null
  active: boolean
  isGroup?: boolean
  editMode?: boolean
  draggable?: boolean
  isDragging?: boolean
  isDropTarget?: boolean
  onClick: () => void
  onRename?: (name: string) => void
  onUngroup?: () => void
  onDragStart?: (e: React.DragEvent) => void
  onDragEnd?: () => void
  onDragOver?: (e: React.DragEvent) => void
  onDrop?: (e: React.DragEvent) => void
}) {
  return (
    <div
      draggable={draggable}
      onClick={editMode ? undefined : onClick}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDrop={onDrop}
      style={{
        position:'relative',display:'flex',alignItems:'center',gap:10,padding:'11px 13px',
        background: active ? `${color}18` : T.bg2,
        border:`1px solid ${isDropTarget ? color : active ? `${color}66` : T.border}`,
        borderRadius:10,cursor: editMode ? 'default' : 'pointer',
        opacity: isDragging ? 0.4 : 1,
        boxShadow: isDropTarget ? `0 0 0 2px ${color}55` : 'none',
        transition:'border-color 0.12s, box-shadow 0.12s',
        userSelect:'none',
      }}>
      <span style={{width:34,height:34,borderRadius:9,flexShrink:0,display:'flex',alignItems:'center',justifyContent:'center',background:`${color}1f`,color,border:`1px solid ${color}33`,pointerEvents:'none'}}>
        <AppIcon name={icon} size={18}/>
      </span>
      <div style={{flex:1,minWidth:0}}>
        {editMode && isGroup ? (
          <input
            defaultValue={label}
            onClick={e => e.stopPropagation()}
            onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
            onBlur={e => onRename?.(e.target.value)}
            style={{width:'100%',boxSizing:'border-box',background:T.bg3,border:`1px solid ${T.border2}`,color:T.text,borderRadius:5,padding:'3px 6px',fontSize:12,fontFamily:'inherit',outline:'none'}}
          />
        ) : (
          <div style={{fontSize:13,fontWeight:600,color:T.text,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis',pointerEvents:'none'}}>{label}</div>
        )}
        {count != null && <div style={{fontSize:11,color:T.text3,pointerEvents:'none'}}>{count} order{count === 1 ? '' : 's'}</div>}
      </div>
      {editMode && isGroup && (
        <button onClick={e => { e.stopPropagation(); onUngroup?.() }} title="Ungroup" style={{background:'none',border:'none',color:T.text3,fontSize:15,cursor:'pointer',lineHeight:1,padding:'0 2px'}}>⊟</button>
      )}
    </div>
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
    fontSize:12,fontFamily:'inherit',
    cursor: enabled ? 'pointer' : 'not-allowed',
  }
}
function selectStyle(): React.CSSProperties {
  return {
    padding:'7px 10px',borderRadius:5,
    background:T.bg3,border:`1px solid ${T.border2}`,
    color:T.text,fontSize:13,fontFamily:'inherit',
    outline:'none',cursor:'pointer',
  }
}
function dateStyle(): React.CSSProperties {
  return {
    padding:'6px 10px',borderRadius:5,
    background:T.bg3,border:`1px solid ${T.border2}`,
    color:T.text,fontSize:12,fontFamily:'inherit',
    outline:'none',colorScheme:'dark',
  }
}

export async function getServerSideProps(context: any) {
  return requirePageAuth(context, 'view:b2b')
}
