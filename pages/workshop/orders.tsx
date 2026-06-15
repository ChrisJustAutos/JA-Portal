// pages/workshop/orders.tsx
// Parts-ordering worklist: upcoming bookings whose parts HAVEN'T been marked
// ordered yet (default view), grouped by day, each showing its part lines
// with stock on hand so short items jump out. "Mark ordered" moves the
// booking to the Ordered view; unmark brings it back.

import { useCallback, useEffect, useState } from 'react'
import Head from 'next/head'
import Link from 'next/link'
import PortalTopBar from '../../lib/PortalTopBar'
import WorkshopTabs from '../../components/WorkshopTabs'
import { requirePageAuth } from '../../lib/authServer'
import type { PortalUserSSR } from '../../lib/authServer'
import { roleHasPermission } from '../../lib/permissions'
import { BOOKING_STATUS_META, BookingStatus, vehicleLabel, ymdBrisbane } from '../../lib/workshop'
import { T, Chip } from '../../components/ui'
import { useToast } from '../../components/ui/Feedback'

interface OrderBooking {
  id: string
  starts_at: string
  status: BookingStatus
  job_type: string | null
  description: string | null
  technician_ext: string | null
  parts_ordered_at: string | null
  parts_ordered_by: string | null
  customer: { id: string; name: string; mobile: string | null; phone: string | null } | null
  vehicle: { id: string; rego: string | null; make: string | null; model: string | null; year: number | null } | null
  part_lines: Array<{
    id: string; description: string | null; part_number: string | null; qty: number
    ordered_at: string | null; ordered_by: string | null; po_id: string | null
    inventory: { id: string; sku: string | null; part_name: string | null; supplier: string | null; available: number | null; on_order: number | null } | null
  }>
}

function bneDayLabel(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString('en-AU', { weekday: 'long', day: '2-digit', month: 'short', timeZone: 'Australia/Brisbane' })
}
function bneTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Australia/Brisbane' })
}

export default function WorkshopOrdersPage({ user }: { user: PortalUserSSR }) {
  const canEdit = roleHasPermission(user.role, 'edit:bookings')
  const toast = useToast()
  const [show, setShow] = useState<'pending' | 'ordered'>('pending')
  const [days, setDays] = useState(14)
  const [bookings, setBookings] = useState<OrderBooking[]>([])
  const [loading, setLoading] = useState(true)
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [lineBusy, setLineBusy] = useState(false)

  function toggleLine(id: string) {
    setSel(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  }
  function clearSel() { setSel(new Set()) }

  async function markLines(ordered: boolean) {
    const line_ids = Array.from(sel)
    if (!line_ids.length) return
    setLineBusy(true)
    try {
      const r = await fetch('/api/workshop/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'mark_lines', line_ids, ordered }) })
      if (r.ok) { toast(ordered ? `${line_ids.length} item(s) marked ordered ✓` : 'Items un-marked', 'success'); clearSel(); load() }
      else toast((await r.json()).error || 'Failed', 'error')
    } catch (e: any) { toast(e?.message || 'Failed', 'error') } finally { setLineBusy(false) }
  }

  async function createPo() {
    const line_ids = Array.from(sel)
    if (!line_ids.length) return
    setLineBusy(true)
    try {
      const r = await fetch('/api/workshop/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'create_po', line_ids }) })
      const d = await r.json()
      if (r.ok) {
        const n = (d.created || []).length
        toast(n ? `Created ${n} draft PO${n === 1 ? '' : 's'} — open Purchase orders to send` : 'No PO created', n ? 'success' : 'error')
        clearSel(); load()
      } else toast(d.error || 'Failed', 'error')
    } catch (e: any) { toast(e?.message || 'Failed', 'error') } finally { setLineBusy(false) }
  }

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await fetch(`/api/workshop/orders?show=${show}&days=${days}`)
      const d = await r.json()
      if (r.ok) setBookings(d.bookings || [])
      setLastRefresh(new Date())
    } catch { /* ignore */ } finally { setLoading(false) }
  }, [show, days])
  useEffect(() => { load() }, [load])

  async function mark(b: OrderBooking, ordered: boolean) {
    setBusyId(b.id)
    try {
      const r = await fetch('/api/workshop/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ booking_id: b.id, ordered }) })
      if (r.ok) {
        setBookings(prev => prev.filter(x => x.id !== b.id))
        toast(ordered ? 'Parts marked ordered ✓' : 'Moved back to To order', 'success')
      } else toast((await r.json()).error || 'Failed', 'error')
    } catch (e: any) { toast(e?.message || 'Failed', 'error') } finally { setBusyId(null) }
  }

  // Group by Brisbane day
  const groups: { ymd: string; label: string; items: OrderBooking[] }[] = []
  for (const b of bookings) {
    const ymd = new Date(new Date(b.starts_at).getTime() + 10 * 3600 * 1000).toISOString().slice(0, 10)
    let g = groups.find(x => x.ymd === ymd)
    if (!g) { g = { ymd, label: bneDayLabel(b.starts_at), items: [] }; groups.push(g) }
    g.items.push(b)
  }
  const today = ymdBrisbane(new Date())

  return (
    <>
      <Head><title>Parts orders — Just Autos</title><meta name="robots" content="noindex,nofollow"/></Head>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden', fontFamily: "'DM Sans',system-ui,sans-serif", color: T.text }}>
        <PortalTopBar activeId="diary" lastRefresh={lastRefresh} onRefresh={load} refreshing={loading}
          currentUserRole={user.role} currentUserVisibleTabs={user.visibleTabs} currentUserName={user.displayName} currentUserEmail={user.email} />
        <WorkshopTabs active="orders" role={user.role} />

        <div style={{ flex: 1, overflow: 'auto', background: T.bg }}>
          <div style={{ maxWidth: 1100, margin: '0 auto', padding: '20px 24px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
              <span style={{ fontSize: 15, fontWeight: 600 }}>Parts orders</span>
              <div style={{ display: 'flex', gap: 4, marginLeft: 8 }}>
                <Chip label="To order" active={show === 'pending'} onClick={() => setShow('pending')} />
                <Chip label="Ordered" active={show === 'ordered'} onClick={() => setShow('ordered')} />
              </div>
              <div style={{ flex: 1 }} />
              <span style={{ fontSize: 11, color: T.text3 }}>Looking ahead</span>
              <select value={days} onChange={e => setDays(Number(e.target.value))} style={{ padding: '5px 8px', background: T.bg3, border: `1px solid ${T.border}`, borderRadius: 5, color: T.text, fontSize: 12, fontFamily: 'inherit' }}>
                <option value={7}>7 days</option><option value={14}>14 days</option><option value={30}>30 days</option><option value={60}>60 days</option>
              </select>
            </div>

            {loading && bookings.length === 0 && <div style={{ textAlign: 'center', color: T.text3, padding: 50, fontSize: 13 }}>Loading…</div>}
            {!loading && bookings.length === 0 && (
              <div style={{ textAlign: 'center', color: T.text3, padding: 50, fontSize: 13 }}>
                {show === 'pending' ? 'Nothing to order — every upcoming booking is marked ✓' : 'No bookings marked ordered in this window.'}
              </div>
            )}

            {groups.map(g => (
              <div key={g.ymd} style={{ marginBottom: 18 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: g.ymd < today ? T.red : T.text2, textTransform: 'uppercase', letterSpacing: '0.06em', padding: '0 2px 6px' }}>
                  {g.label}{g.ymd === today ? ' · today' : ''}{g.ymd < today ? ' · past' : ''}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {g.items.map(b => {
                    const meta = BOOKING_STATUS_META[b.status] || { label: b.status, color: T.text3 }
                    return (
                      <div key={b.id} style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 10, padding: '12px 16px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                          <span style={{ fontFamily: 'monospace', fontSize: 12, color: T.text2 }}>{bneTime(b.starts_at)}</span>
                          <Link href={`/workshop/job/${b.id}`} style={{ fontSize: 13, fontWeight: 600, color: T.text, textDecoration: 'none' }}>
                            {b.vehicle ? vehicleLabel(b.vehicle) : (b.customer?.name || 'Booking')}
                          </Link>
                          {b.customer && <span style={{ fontSize: 12, color: T.text2 }}>{b.customer.name}{b.customer.mobile || b.customer.phone ? ` · ${b.customer.mobile || b.customer.phone}` : ''}</span>}
                          <span style={{ fontSize: 10, fontWeight: 700, color: meta.color, background: `${meta.color}1e`, padding: '2px 8px', borderRadius: 4, textTransform: 'uppercase' }}>{meta.label}</span>
                          {b.technician_ext && <span style={{ fontSize: 11, color: T.text3 }}>{b.technician_ext}</span>}
                          <div style={{ flex: 1 }} />
                          {show === 'ordered' && b.parts_ordered_at && (
                            <span style={{ fontSize: 11, color: T.green }}>✓ {new Date(b.parts_ordered_at).toLocaleDateString('en-AU')}{b.parts_ordered_by ? ` · ${b.parts_ordered_by}` : ''}</span>
                          )}
                          {canEdit && (
                            <button onClick={() => mark(b, show === 'pending')} disabled={busyId === b.id}
                              style={{ padding: '6px 14px', borderRadius: 6, fontSize: 12, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer', background: show === 'pending' ? `${T.green}1e` : 'transparent', color: show === 'pending' ? T.green : T.text3, border: `1px solid ${show === 'pending' ? T.green : T.border2}55` }}>
                              {busyId === b.id ? '…' : show === 'pending' ? '✓ Mark ordered' : '↩ Unmark'}
                            </button>
                          )}
                        </div>
                        {b.description && <div style={{ fontSize: 12, color: T.text2, marginTop: 6, whiteSpace: 'pre-wrap' }}>{b.description.slice(0, 300)}</div>}
                        {b.part_lines.length > 0 ? (
                          <div style={{ marginTop: 8, borderTop: `1px solid ${T.border}`, paddingTop: 6 }}>
                            {b.part_lines.map(l => {
                              const avail = l.inventory?.available != null ? Number(l.inventory.available) : null
                              const short = avail != null && Number(l.qty) > avail
                              const isOrdered = !!l.ordered_at
                              return (
                                <div key={l.id} style={{ display: 'flex', gap: 8, fontSize: 12, padding: '3px 0', alignItems: 'baseline' }}>
                                  {canEdit && (
                                    isOrdered
                                      ? <span title={l.po_id ? 'On a purchase order' : 'Marked ordered'} style={{ width: 16, textAlign: 'center', color: T.green, alignSelf: 'center' }}>{l.po_id ? '🛒' : '✓'}</span>
                                      : <input type="checkbox" checked={sel.has(l.id)} onChange={() => toggleLine(l.id)} style={{ cursor: 'pointer', alignSelf: 'center' }} />
                                  )}
                                  <span style={{ fontFamily: 'monospace', color: T.text3, minWidth: 30, textAlign: 'right' }}>{Number(l.qty)}×</span>
                                  <span style={{ color: isOrdered ? T.text3 : T.text, textDecoration: isOrdered ? 'line-through' : 'none' }}>{l.description || l.inventory?.part_name || l.part_number || 'Part'}</span>
                                  {(l.part_number || l.inventory?.sku) && <span style={{ fontFamily: 'monospace', fontSize: 11, color: T.text3 }}>{l.part_number || l.inventory?.sku}</span>}
                                  {l.inventory?.supplier && <span style={{ fontSize: 11, color: T.text3 }}>· {l.inventory.supplier.split(',')[0]}</span>}
                                  <span style={{ marginLeft: 'auto', fontSize: 11, color: isOrdered ? T.green : short ? T.red : T.text3, fontWeight: short && !isOrdered ? 700 : 400 }}>
                                    {isOrdered ? 'ordered' : (avail != null ? `${avail} in stock${short ? ' — SHORT' : ''}` : 'not stocked')}
                                    {!isOrdered && l.inventory?.on_order ? ` · ${Number(l.inventory.on_order)} on order` : ''}
                                  </span>
                                </div>
                              )
                            })}
                          </div>
                        ) : (
                          <div style={{ marginTop: 8, fontSize: 11, color: T.text3, fontStyle: 'italic' }}>No part lines on the job yet.</div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>

        {canEdit && sel.size > 0 && (
          <div style={{ position: 'fixed', bottom: 20, left: '50%', transform: 'translateX(-50%)', zIndex: 50, display: 'flex', alignItems: 'center', gap: 10, background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 12, padding: '10px 14px', boxShadow: '0 8px 28px rgba(0,0,0,0.35)' }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: T.text }}>{sel.size} item{sel.size === 1 ? '' : 's'} selected</span>
            <button onClick={() => markLines(true)} disabled={lineBusy} style={{ padding: '7px 14px', borderRadius: 6, fontSize: 12, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer', background: `${T.green}22`, color: T.green, border: `1px solid ${T.green}55` }}>✓ Mark ordered</button>
            <button onClick={createPo} disabled={lineBusy} style={{ padding: '7px 14px', borderRadius: 6, fontSize: 12, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer', background: T.accent, color: '#fff', border: 'none' }}>🛒 Create PO</button>
            <button onClick={clearSel} style={{ padding: '7px 10px', borderRadius: 6, fontSize: 12, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer', background: 'transparent', color: T.text3, border: `1px solid ${T.border2}` }}>Clear</button>
          </div>
        )}
      </div>
    </>
  )
}

export async function getServerSideProps(context: any) {
  return requirePageAuth(context, 'view:diary')
}
