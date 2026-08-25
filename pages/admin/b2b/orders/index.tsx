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
import { useToast, useConfirm } from '../../../../components/ui/Feedback'
import { T, alpha } from '../../../../lib/ui/theme'
import { A, RADIUS, btnStyle, cardStyle, Banner, PageTitle, StatusPill as Pill, orderStatusColor, orderStatusLabel } from '../../../../components/b2b/ui'
import { awaitingDespatch } from '../../../../lib/b2b-despatch-state'

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
  machship_consignment_id: string | null
  machship_manifest_id: string | null
  freight_status: string | null
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
// Tile labels stay per-status (Picking vs Packed are separate filter buckets);
// row pills use the kit's orderStatusLabel vocabulary.
const STATUS_LABEL: Record<string, string> = {
  pending_payment: 'Awaiting payment',
  paid: 'Paid',
  picking: 'Picking',
  packed: 'Packed',
  shipped: 'Shipped',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
  refunded: 'Refunded',
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

  const toast         = useToast()
  const confirmDialog = useConfirm()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [shipBusy, setShipBusy] = useState(false)

  const despatchable = useMemo(() => (data?.orders || []).filter(awaitingDespatch), [data])
  // Drop selections whose rows have gone (filter change, page change, shipped).
  useEffect(() => {
    setSelected(prev => {
      const live = new Set(despatchable.map(o => o.id))
      const next = new Set(Array.from(prev).filter(id => live.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [despatchable])

  const toggle = useCallback((id: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }, [])

  // Bulk "Ship now": ONE MachShip manifest for the whole run (and so one carrier
  // pickup) — the endpoint batches server-side. See lib/b2b-ship-now.ts.
  async function shipSelected() {
    const ids = Array.from(selected)
    if (!ids.length) return
    const ok = await confirmDialog({
      title: `Ship ${ids.length} order${ids.length === 1 ? '' : 's'} now?`,
      message: 'Manifests these consignments with the carrier as one despatch run (booking a single pickup), raises the MYOB tax invoices and emails each distributor. This cannot be undone from here.',
      confirmLabel: 'Ship now',
    })
    if (!ok) return
    setShipBusy(true)
    try {
      const r = await fetch('/api/b2b/admin/orders/ship-now', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      })
      const j = await r.json()
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`)
      const bits: string[] = []
      if (j.shipped_count) bits.push(`${j.shipped_count} shipped`)
      if (j.already_count) bits.push(`${j.already_count} already manifested`)
      if (j.failed_count)  bits.push(`${j.failed_count} failed`)
      toast(bits.join(' · ') || 'Nothing to do', j.failed_count ? 'error' : 'success')
      // Surface per-order detail — a partial failure is the case that matters.
      const bad = (j.results || []).filter((x: any) => !x.ok)
      for (const b of bad) toast(`${b.order_number || b.order_id}: ${b.error}`, 'error')
      const warned = (j.results || []).filter((x: any) => x.ok && x.warning)
      for (const w of warned) toast(`${w.order_number || w.order_id}: ${w.warning}`, 'error')
      setSelected(new Set())
      load()
    } catch (e: any) {
      toast(e?.message || String(e), 'error')
    } finally {
      setShipBusy(false)
    }
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
      color: orderStatusColor(g.statuses[0]), icon: 'all',
    }))
    const singleTiles: StatusTile[] = STATUS_ORDER.filter(s => !groupedStatuses.has(s)).map(s => ({
      id: s, label: STATUS_LABEL[s], statuses: [s], isGroup: false,
      color: orderStatusColor(s), icon: STATUS_ICON[s] || 'all',
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
          <PageTitle
            sub={
              <span style={{display:'inline-flex',alignItems:'center',gap:10,flexWrap:'wrap'}}>
                <span><a href="/admin/b2b" style={{color:T.text3,textDecoration:'none'}}>B2B Portal</a> / Orders</span>
                <button onClick={()=>router.push('/admin/b2b/test-order')}
                  className="al-press al-focus"
                  style={{...btnStyle('ghost','sm'),color:A.warn,background:alpha(A.warn,'14')}}>
                  Place test order
                </button>
              </span>
            }
            action={data && (
              <div style={{display:'flex',gap:24,alignItems:'baseline'}}>
                <Stat n={data.total_count}                 label="orders"/>
                <Stat n={`$${money(data.totals.total_inc_sum)}`} label="filtered total" raw/>
                <Stat n={`$${money(data.totals.paid_sum)}`}      label="paid"           raw color={A.good}/>
              </div>
            )}>
            Orders
          </PageTitle>

          {/* Status tiles — click to filter, drag one onto another to combine */}
          {data && (
            <div style={{marginBottom:14}}>
              <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:8}}>
                <span style={{fontSize:13,fontWeight:650,color:T.text2}}>Filter by status</span>
                <button onClick={() => setTileEdit(e => !e)}
                  className="al-press al-focus"
                  style={btnStyle(tileEdit ? 'primary' : 'ghost','sm')}>
                  {tileEdit ? 'Done' : 'Edit buckets'}
                </button>
                {tileEdit
                  ? <span style={{fontSize:12,color:T.text3}}>Rename or ungroup combined buckets. Drag is paused.</span>
                  : <span style={{fontSize:12,color:T.text3}}>Drag one tile onto another to combine.</span>}
              </div>
              <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill, minmax(150px, 1fr))',gap:10}}>
                {/* All */}
                <StatusCard
                  label="All orders" icon="all" color={A.accent}
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
              ...cardStyle(false),
              display:'flex',gap:10,alignItems:'center',flexWrap:'wrap',
              padding:'10px 12px',marginBottom:14,overflow:'visible',
            }}>
              <input
                type="text"
                placeholder="Search order # or PO…"
                value={searchInput}
                onChange={e => setSearchInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') applySearch() }}
                className="al-focus"
                style={{...filterInput(),flex:1,minWidth:220}}/>
              <button onClick={applySearch}
                className="al-press al-focus al-primary"
                style={btnStyle('primary','sm')}>
                Search
              </button>

              <select
                value={distributorFilter}
                onChange={e => updateFilter({ distributor: e.target.value || null })}
                className="al-focus"
                style={{...filterInput(),width:'auto',cursor:'pointer'}}>
                <option value="">All distributors</option>
                {data.distributors.map(d => (
                  <option key={d.id} value={d.id}>{d.display_name}</option>
                ))}
              </select>

              <input
                type="date"
                value={dateFromFilter}
                onChange={e => updateFilter({ from: e.target.value || null })}
                className="al-focus"
                style={{...filterInput(),width:'auto',colorScheme:'dark'}}/>
              <span style={{color:T.text3,fontSize:12}}>→</span>
              <input
                type="date"
                value={dateToFilter}
                onChange={e => updateFilter({ to: e.target.value || null })}
                className="al-focus"
                style={{...filterInput(),width:'auto',colorScheme:'dark'}}/>

              {(statusFilter || distributorFilter || dateFromFilter || dateToFilter || searchQuery) && (
                <button
                  onClick={() => router.push({ pathname: router.pathname }, undefined, { shallow: false })}
                  className="al-press al-focus"
                  style={{...btnStyle('ghost','sm'), color:A.warn}}>
                  Clear filters
                </button>
              )}
            </div>
          )}

          {/* Errors */}
          {error && (
            <div style={{marginBottom:10}}>
              <Banner tone="error">Couldn't load orders: {error}</Banner>
            </div>
          )}

          {/* Bulk despatch bar — only when something is booked-but-not-manifested */}
          {despatchable.length > 0 && (
            <div style={{
              ...cardStyle(false), padding:'10px 14px', marginBottom:10,
              display:'flex', alignItems:'center', gap:12, flexWrap:'wrap',
              background: alpha(A.warn,'0d'), border:`1px solid ${alpha(A.warn,'33')}`,
            }}>
              <span style={{fontSize:12.5,color:T.text2}}>
                <b style={{color:A.warn}}>{despatchable.length}</b> booked, awaiting despatch
              </span>
              <button
                onClick={() => setSelected(new Set(despatchable.map(o => o.id)))}
                className="al-press al-focus al-ghost"
                style={{...btnStyle('ghost','sm'), background:'transparent', color:A.accent}}>
                Select all
              </button>
              {selected.size > 0 && (
                <button onClick={() => setSelected(new Set())}
                  className="al-press al-focus al-ghost"
                  style={{...btnStyle('ghost','sm'), background:'transparent', color:T.text3}}>
                  Clear
                </button>
              )}
              <span style={{flex:1}}/>
              <button onClick={shipSelected} disabled={shipBusy || selected.size === 0}
                title="Manifests the selected consignments as ONE despatch run (one carrier pickup), raises the MYOB tax invoices and emails each distributor"
                className="al-press al-focus"
                style={{
                  ...btnStyle('primary','sm'),
                  background: selected.size ? A.accent : alpha(A.accent,'33'),
                  color:'#fff',
                  cursor: shipBusy ? 'wait' : selected.size ? 'pointer' : 'not-allowed',
                }}>
                {shipBusy ? 'Shipping…' : `Ship now${selected.size ? ` (${selected.size})` : ''}`}
              </button>
            </div>
          )}

          {/* Table */}
          <div style={cardStyle(false)}>
            <div style={{overflowX:'auto'}}>
              <table className="b2b-cards" style={{width:'100%',borderCollapse:'collapse',fontSize:13}}>
                <thead>
                  <tr style={{borderBottom:`1px solid ${T.border2}`}}>
                    <th style={th(34)}></th>
                    <th style={th(140)}>Order</th>
                    <th style={th()}>Distributor</th>
                    <th style={th(110)}>Placed</th>
                    <th style={th(130)}>Status</th>
                    <th style={{...th(110),textAlign:'right'}}>Total (inc)</th>
                    <th style={th(120)}>MYOB #</th>
                    <th style={th(60)}></th>
                  </tr>
                </thead>
                <tbody>
                  {data && data.orders.length === 0 && !loading && (
                    <tr><td colSpan={8} style={{padding:30,textAlign:'center',color:T.text3,fontSize:13}}>
                      No orders match these filters.
                    </td></tr>
                  )}
                  {data?.orders.map((o, i) => (
                    <OrderRowDisplay key={o.id} order={o} isFirst={i === 0}
                      selectable={awaitingDespatch(o)} checked={selected.has(o.id)} onToggle={toggle}/>
                  ))}
                  {loading && (
                    <tr><td colSpan={8} style={{padding:0}}><SkeletonRows rows={8}/></td></tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            {data && totalPages > 1 && (
              <div style={{
                padding:'10px 16px',borderTop:`1px solid ${T.border2}`,
                display:'flex',justifyContent:'space-between',alignItems:'center',gap:14,
                fontSize:12.5,color:T.text3,
              }}>
                <span>
                  Showing {offset + 1}–{Math.min(offset + LIMIT, data.total_count)} of {data.total_count}
                </span>
                <div style={{display:'flex',gap:6,alignItems:'center'}}>
                  <button
                    disabled={offset === 0}
                    onClick={() => updateFilter({ offset: String(Math.max(0, offset - LIMIT)) })}
                    className="al-press al-focus al-ghost"
                    style={btnStyle('ghost','sm',offset === 0)}>
                    ← Prev
                  </button>
                  <span style={{padding:'6px 10px'}}>
                    {currentPage} / {totalPages}
                  </span>
                  <button
                    disabled={offset + LIMIT >= data.total_count}
                    onClick={() => updateFilter({ offset: String(offset + LIMIT) })}
                    className="al-press al-focus al-ghost"
                    style={btnStyle('ghost','sm',offset + LIMIT >= data.total_count)}>
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
function OrderRowDisplay({ order, isFirst, selectable, checked, onToggle }: {
  order: OrderRow; isFirst: boolean
  selectable: boolean; checked: boolean; onToggle: (id: string) => void
}) {
  const dist = order.distributor?.display_name || '—'
  const placedDate = new Date(order.created_at).toLocaleDateString('en-AU', { day:'2-digit', month:'short', year:'numeric' })
  const placedTime = new Date(order.created_at).toLocaleTimeString('en-AU', { hour:'2-digit', minute:'2-digit' })

  return (
    <tr style={{
      borderTop: isFirst ? 'none' : `1px solid ${T.border}`,
      cursor:'pointer',
    }}
      onClick={() => { window.location.href = `/admin/b2b/orders/${order.id}` }}>

      {/* Select — only booked-but-unmanifested rows can join a despatch run.
          stopPropagation so ticking doesn't navigate into the order. */}
      <td data-label="" style={{...td(), width:34}} onClick={e => e.stopPropagation()}>
        {selectable ? (
          <input type="checkbox" checked={checked} onChange={() => onToggle(order.id)}
            title="Include in the next despatch run"
            style={{width:16,height:16,accentColor:A.accent,cursor:'pointer'}}/>
        ) : null}
      </td>

      <td className="b2b-card-title" style={td()}>
        <div style={{fontFamily:'monospace',fontSize:13,color:T.text}}>{order.order_number}{order.is_test && <span style={{marginLeft:6,fontFamily:'system-ui,-apple-system,sans-serif',fontSize:12,fontWeight:600,padding:'2px 9px',borderRadius:RADIUS.pill,background:alpha(A.warn,'1f'),color:A.warn,verticalAlign:'middle'}}>Test</span>}</div>
        {order.customer_po && (
          <div style={{fontSize:12,color:T.text3,marginTop:2}}>PO: {order.customer_po}</div>
        )}
      </td>

      <td data-label="Distributor" style={td()}>
        <div style={{fontSize:13,color:T.text}}>{dist}</div>
      </td>

      <td data-label="Placed" style={{...td(),fontSize:12.5,color:T.text3,fontFamily:'monospace',whiteSpace:'nowrap'}}>
        {placedDate}
        <div style={{fontSize:12,color:T.text3,opacity:0.7}}>{placedTime}</div>
      </td>

      <td data-label="Status" style={td()}>
        <Pill color={orderStatusColor(order.status)}>{orderStatusLabel(order.status)}</Pill>
        {Number(order.refunded_total) > 0 && (
          <div style={{fontSize:12,color:A.bad,marginTop:3}}>
            -${money(Number(order.refunded_total))} refunded
          </div>
        )}
      </td>

      <td data-label="Total (inc)" style={{...td(),textAlign:'right',fontFamily:'monospace',fontVariantNumeric:'tabular-nums'}}>
        ${money(Number(order.total_inc))}
      </td>

      <td data-label="MYOB #" style={{...td(),fontSize:12.5}}>
        {order.myob_invoice_number ? (
          <span style={{fontFamily:'monospace',color:T.text2}}>{order.myob_invoice_number}</span>
        ) : order.myob_write_error ? (
          <span style={{color:A.bad}}>failed</span>
        ) : order.status === 'pending_payment' ? (
          <span style={{color:T.text3}}>—</span>
        ) : (
          <span style={{color:A.warn}}>pending</span>
        )}
      </td>

      <td className="b2b-card-hide" style={{...td(),textAlign:'right'}}>
        <span style={{color:T.text3,fontSize:14}}>›</span>
      </td>

    </tr>
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
      className={editMode ? undefined : 'al-press'}
      style={{
        ...cardStyle(false),
        position:'relative',display:'flex',alignItems:'center',gap:10,padding:'11px 13px',
        background: active ? alpha(color,'18') : T.bg2,
        border:`1px solid ${isDropTarget ? color : active ? alpha(color,'66') : T.border}`,
        cursor: editMode ? 'default' : 'pointer',
        opacity: isDragging ? 0.4 : 1,
        boxShadow: isDropTarget ? `0 0 0 2px ${alpha(color,'55')}` : undefined,
        transition:'border-color 0.12s, box-shadow 0.12s',
        userSelect:'none',
      }}>
      <span style={{width:34,height:34,borderRadius:10,flexShrink:0,display:'flex',alignItems:'center',justifyContent:'center',background:alpha(color,'1f'),color,pointerEvents:'none'}}>
        <AppIcon name={icon} size={18}/>
      </span>
      <div style={{flex:1,minWidth:0}}>
        {editMode && isGroup ? (
          <input
            defaultValue={label}
            onClick={e => e.stopPropagation()}
            onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
            onBlur={e => onRename?.(e.target.value)}
            className="al-focus"
            style={{width:'100%',boxSizing:'border-box',background:T.bg3,border:'1px solid transparent',color:T.text,borderRadius:RADIUS.sm,padding:'3px 7px',fontSize:12.5,fontFamily:'inherit',outline:'none'}}
          />
        ) : (
          <div style={{fontSize:13,fontWeight:600,color:T.text,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis',pointerEvents:'none'}}>{label}</div>
        )}
        {count != null && <div style={{fontSize:12,color:T.text3,pointerEvents:'none'}}>{count} order{count === 1 ? '' : 's'}</div>}
      </div>
      {editMode && isGroup && (
        <button onClick={e => { e.stopPropagation(); onUngroup?.() }} title="Ungroup" className="al-press"
          style={{background:'none',border:'none',color:T.text3,fontSize:12,fontWeight:600,fontFamily:'inherit',cursor:'pointer',lineHeight:1,padding:'2px 4px'}}>
          Ungroup
        </button>
      )}
    </div>
  )
}

function Stat({ n, label, color, raw }: { n: number | string; label: string; color?: string; raw?: boolean }) {
  return (
    <div style={{display:'flex',alignItems:'baseline',gap:6}}>
      <span style={{fontSize:18,fontWeight:650,color: color || T.text,fontVariantNumeric:'tabular-nums'}}>
        {raw ? n : (typeof n === 'number' ? n.toLocaleString('en-AU') : n)}
      </span>
      <span style={{fontSize:12,color:T.text3}}>{label}</span>
    </div>
  )
}

function money(n: number): string {
  return n.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function th(width?: number): React.CSSProperties {
  return {
    fontSize:12,color:T.text3,padding:'10px 12px',
    textAlign:'left',fontWeight:600,
    width,whiteSpace:'nowrap',background:T.bg2,
  }
}
function td(): React.CSSProperties {
  return { padding:'10px 12px',verticalAlign:'middle' }
}
// Dense filter-bar take on the kit's inputStyle — same surfaces, staff-tool
// height (the 16px/44px rule is for mobile checkout, not desktop admin).
function filterInput(): React.CSSProperties {
  return {
    boxSizing:'border-box',
    background:T.bg3,border:'1px solid transparent',color:T.text,
    borderRadius:RADIUS.sm,padding:'8px 12px',fontSize:13.5,outline:'none',
    fontFamily:'inherit',minHeight:36,
  }
}

export async function getServerSideProps(context: any) {
  return requirePageAuth(context, 'view:b2b')
}
