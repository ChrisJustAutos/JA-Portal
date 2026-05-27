// pages/diary.tsx
// Workshop diary — Phase 1 of the MechanicDesk replacement. Day view with
// technician lanes + week overview. Create/move bookings, attach customer +
// vehicle (with quick-add). Reads/writes via /api/workshop/* (service-role,
// gated view:diary / edit:bookings). MYOB stays the customer/stock master.

import { useEffect, useState, useCallback, useMemo } from 'react'
import Head from 'next/head'
import { useRouter } from 'next/router'
import PortalTopBar from '../lib/PortalTopBar'
import { requirePageAuth } from '../lib/authServer'
import { roleHasPermission } from '../lib/permissions'
import {
  BOOKING_STATUS_META, BOOKING_STATUSES, BookingStatus,
  vehicleLabel, customerLabel, bookingDurationMin,
  ymdBrisbane, brisbaneDayBounds, addDaysYmd, weekStartYmd,
  JOB_TYPES, jobTypeLabel,
} from '../lib/workshop'

interface PortalUserSSR { id: string; email: string; displayName: string | null; role: 'admin'|'manager'|'sales'|'accountant'|'viewer'; visibleTabs?: string[] | null }

const T = {
  bg: '#0d0f12', bg2: '#131519', bg3: '#1a1d23', bg4: '#21252d',
  border: 'rgba(255,255,255,0.07)', border2: 'rgba(255,255,255,0.12)',
  text: '#e8eaf0', text2: '#8b90a0', text3: '#545968',
  blue: '#4f8ef7', teal: '#2dd4bf', green: '#34c77b',
  amber: '#f5a623', red: '#f04e4e', purple: '#a78bfa', accent: '#4f8ef7',
}

interface Tech { ext: string; name: string; color?: string | null; daily_hours?: number; role?: string | null }
interface BookingRow {
  id: string
  customer_id: string | null
  vehicle_id: string | null
  starts_at: string
  ends_at: string
  technician_ext: string | null
  bay: string | null
  service_type: string | null
  status: BookingStatus
  notes: string | null
  job_type: string | null
  description: string | null
  internal_notes: string | null
  estimated_value: number | null
  span_techs: string | null
  customer: { id: string; name: string; phone: string | null; mobile: string | null } | null
  vehicle: { id: string; rego: string | null; make: string | null; model: string | null; year: number | null } | null
}

// ── Time grid config (Brisbane wall clock) ──────────────────────────────
const DAY_START_H = 7
const DAY_END_H = 18
const SLOT_MIN = 30
const SLOT_PX = 30
const DAY_START_MIN = DAY_START_H * 60
const GRID_PX = ((DAY_END_H - DAY_START_H) * 60 / SLOT_MIN) * SLOT_PX
const DURATIONS = [30, 60, 90, 120, 180, 240, 360, 480]
const pad = (n: number) => String(n).padStart(2, '0')

// Brisbane (UTC+10) wall-clock hour/min from an ISO timestamp.
function bneHM(iso: string): { h: number; m: number } {
  const d = new Date(new Date(iso).getTime() + 10 * 3600 * 1000)
  return { h: d.getUTCHours(), m: d.getUTCMinutes() }
}
function bneTimeStr(iso: string): string { const { h, m } = bneHM(iso); return `${pad(h)}:${pad(m)}` }
function bneYmd(iso: string): string { return ymdBrisbane(new Date(iso)) }
function isoFromBne(ymd: string, hhmm: string): string { return new Date(`${ymd}T${hhmm}:00+10:00`).toISOString() }
function minsToHHMM(mins: number): string { return `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}` }
function topPxFor(iso: string): number {
  const { h, m } = bneHM(iso)
  return Math.max(0, ((h * 60 + m) - DAY_START_MIN) / SLOT_MIN * SLOT_PX)
}
function dayLabel(ymd: string): string {
  return new Date(`${ymd}T00:00:00+10:00`).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' })
}
function monthStartYmd(ymd: string): string { return ymd.slice(0, 8) + '01' }
function addMonthsYmd(ymd: string, n: number): string {
  const [y, m] = ymd.split('-').map(Number)
  return new Date(Date.UTC(y, (m - 1) + n, 1)).toISOString().slice(0, 10)
}
function monthLabel(ymd: string): string {
  return new Date(`${monthStartYmd(ymd)}T00:00:00+10:00`).toLocaleDateString('en-AU', { month: 'long', year: 'numeric' })
}
// 6-week (42-day) grid starting on the Monday on/before the 1st.
function monthGridDays(ymd: string): string[] {
  const first = monthStartYmd(ymd)
  const dow = (new Date(`${first}T00:00:00+10:00`).getUTCDay() + 6) % 7
  const start = addDaysYmd(first, -dow)
  return Array.from({ length: 42 }, (_, i) => addDaysYmd(start, i))
}
function durationHours(b: { starts_at: string; ends_at: string }): number {
  return Math.max(0, (new Date(b.ends_at).getTime() - new Date(b.starts_at).getTime()) / 3600000)
}

// ── Booking block (positioned in a lane) ────────────────────────────────
function BookingBlock({ b, onClick, showTech, draggable }: { b: BookingRow; onClick: () => void; showTech?: boolean; draggable?: boolean }) {
  const top = topPxFor(b.starts_at)
  const height = Math.max(SLOT_PX * 0.9, bookingDurationMin(b) / SLOT_MIN * SLOT_PX - 2)
  const c = BOOKING_STATUS_META[b.status].color
  const veh = b.vehicle ? vehicleLabel(b.vehicle) : ''
  const cust = b.customer ? customerLabel(b.customer) : ''
  return (
    <div
      draggable={!!draggable}
      onDragStart={draggable ? (e) => { e.dataTransfer.setData('text/plain', b.id); e.dataTransfer.effectAllowed = 'move' } : undefined}
      onClick={(e) => { e.stopPropagation(); onClick() }}
      title={`${bneTimeStr(b.starts_at)}–${bneTimeStr(b.ends_at)} · ${cust} · ${veh}`}
      style={{
        position: 'absolute', top, left: 2, right: 2, height, overflow: 'hidden',
        background: `${c}1c`, borderLeft: `3px solid ${c}`, border: `1px solid ${c}44`,
        borderRadius: 4, padding: '3px 6px', cursor: draggable ? 'grab' : 'pointer', fontSize: 11, lineHeight: 1.25,
      }}>
      <div style={{ color: T.text, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {veh || cust || 'Booking'}
      </div>
      <div style={{ color: T.text2, fontSize: 10, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {bneTimeStr(b.starts_at)} · {b.description || jobTypeLabel(b.job_type) || cust || '—'}{showTech && b.technician_ext ? ` · ${b.technician_ext}` : ''}
      </div>
    </div>
  )
}

// ── Page ────────────────────────────────────────────────────────────────
type View = 'day' | 'week' | 'month'

export default function DiaryPage({ user }: { user: PortalUserSSR }) {
  const router = useRouter()
  const canEdit = roleHasPermission(user.role, 'edit:bookings')
  const isAdmin = roleHasPermission(user.role, 'admin:settings')
  const [view, setView] = useState<View>('day')
  const [date, setDate] = useState<string>(() => ymdBrisbane(new Date()))
  const [bookings, setBookings] = useState<BookingRow[]>([])
  const [techs, setTechs] = useState<Tech[]>([])
  const [notes, setNotes] = useState<any[]>([])
  const [capacity, setCapacity] = useState<Record<string, number>>({})
  const [techFilter, setTechFilter] = useState<string | null>(null)
  const [deptFilter, setDeptFilter] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null)
  const [editing, setEditing] = useState<Partial<BookingRow> | null>(null) // open modal when non-null
  const [sync, setSync] = useState<{ busy: boolean; msg: string }>({ busy: false, msg: '' })

  const range = useMemo(() => {
    if (view === 'day') return brisbaneDayBounds(date)
    if (view === 'month') {
      const ms = monthStartYmd(date)
      return { fromIso: brisbaneDayBounds(ms).fromIso, toIso: brisbaneDayBounds(addMonthsYmd(ms, 1)).fromIso }
    }
    const ws = weekStartYmd(date)
    return { fromIso: brisbaneDayBounds(ws).fromIso, toIso: brisbaneDayBounds(addDaysYmd(ws, 7)).fromIso }
  }, [view, date])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [bRes, nRes, cRes] = await Promise.all([
        fetch(`/api/workshop/bookings?from=${encodeURIComponent(range.fromIso)}&to=${encodeURIComponent(range.toIso)}`),
        fetch(`/api/workshop/diary-notes?from=${encodeURIComponent(range.fromIso)}&to=${encodeURIComponent(range.toIso)}`),
        fetch('/api/workshop/tech-capacity'),
      ])
      const d = await bRes.json()
      if (bRes.ok) {
        setBookings(Array.isArray(d.bookings) ? d.bookings : [])
        setTechs(Array.isArray(d.technicians) ? d.technicians : [])
      }
      const nd = await nRes.json().catch(() => ({})); if (nRes.ok) setNotes(Array.isArray(nd.notes) ? nd.notes : [])
      const cd = await cRes.json().catch(() => ({})); if (cRes.ok) setCapacity(cd.capacity || {})
      setLastRefresh(new Date())
    } catch { /* leave previous data */ } finally { setLoading(false) }
  }, [range])

  useEffect(() => { load() }, [load])

  async function doSync() {
    setSync({ busy: true, msg: 'Syncing from MYOB…' })
    try {
      const r = await fetch('/api/workshop/sync?what=all', { method: 'POST' })
      const d = await r.json()
      if (!r.ok || !d.ok) { setSync({ busy: false, msg: d.error || 'Sync failed' }); return }
      const parts = (d.results || []).map((x: any) => `${x.kind} ${x.upserted}/${x.scanned}`).join(' · ')
      setSync({ busy: false, msg: `Synced — ${parts}` })
      load()
    } catch (e: any) { setSync({ busy: false, msg: e?.message || 'Sync failed' }) }
  }

  const weekDays = useMemo(() => {
    const ws = weekStartYmd(date)
    return Array.from({ length: 7 }, (_, i) => addDaysYmd(ws, i))
  }, [date])

  const hourLines = useMemo(() => Array.from({ length: DAY_END_H - DAY_START_H + 1 }, (_, i) => DAY_START_H + i), [])

  function openNew(opts: { ymd: string; startMin: number; techExt?: string | null }) {
    if (!canEdit) return
    const startIso = isoFromBne(opts.ymd, minsToHHMM(opts.startMin))
    const endIso = new Date(new Date(startIso).getTime() + 60 * 60000).toISOString()
    setEditing({ starts_at: startIso, ends_at: endIso, technician_ext: opts.techExt || null, status: 'booking', job_type: 'general_service' })
  }

  function laneClick(e: React.MouseEvent<HTMLDivElement>, ymd: string, techExt: string | null) {
    if (!canEdit) return
    const rect = e.currentTarget.getBoundingClientRect()
    const y = e.clientY - rect.top
    const slot = Math.max(0, Math.floor(y / SLOT_PX))
    openNew({ ymd, startMin: DAY_START_MIN + slot * SLOT_MIN, techExt })
  }

  const shiftDate = (delta: number) => setDate(d => view === 'month' ? addMonthsYmd(monthStartYmd(d), delta) : addDaysYmd(d, view === 'week' ? delta * 7 : delta))

  async function openNewJob() {
    if (!canEdit) return
    const ymd = view === 'day' ? date : view === 'week' ? weekStartYmd(date) : monthStartYmd(date)
    const startIso = isoFromBne(ymd, '09:00')
    const endIso = new Date(new Date(startIso).getTime() + 60 * 60000).toISOString()
    const r = await fetch('/api/workshop/bookings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ starts_at: startIso, ends_at: endIso, status: 'booking', job_type: 'general_service' }) })
    const d = await r.json()
    if (r.ok && d.id) router.push(`/workshop/job/${d.id}`)
  }
  async function addNote(ymd: string, content: string) {
    if (!content.trim()) return
    await fetch('/api/workshop/diary-notes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content, note_date: isoFromBne(ymd, '00:00') }) })
    load()
  }
  async function delNote(id: string) { await fetch(`/api/workshop/diary-notes?id=${encodeURIComponent(id)}`, { method: 'DELETE' }); load() }
  async function setLaneCapacity(ext: string) {
    if (!isAdmin || !ext) return
    const v = window.prompt(`Daily capacity (hours) for ext ${ext}:`, String(capacity[ext] ?? 8))
    if (v == null) return
    const hours = Number(v); if (!isFinite(hours)) return
    await fetch('/api/workshop/tech-capacity', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ technician_ext: ext, daily_hours: hours }) })
    load()
  }

  // Drag a booking to a new lane (day: reassign tech + retime) or day (week: move date + retime).
  function dropMove(e: React.DragEvent<HTMLDivElement>, ymd: string, techExt: string | null, setTech: boolean) {
    e.preventDefault()
    if (!canEdit) return
    const id = e.dataTransfer.getData('text/plain'); if (!id) return
    const b = bookings.find(x => x.id === id); if (!b) return
    const rect = e.currentTarget.getBoundingClientRect()
    const slot = Math.max(0, Math.floor((e.clientY - rect.top) / SLOT_PX))
    const startMin = DAY_START_MIN + slot * SLOT_MIN
    const durMin = Math.max(30, Math.round((new Date(b.ends_at).getTime() - new Date(b.starts_at).getTime()) / 60000))
    const startIso = isoFromBne(ymd, minsToHHMM(startMin))
    const endIso = new Date(new Date(startIso).getTime() + durMin * 60000).toISOString()
    const patch: any = { starts_at: startIso, ends_at: endIso }
    if (setTech) patch.technician_ext = techExt
    fetch(`/api/workshop/bookings/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }).then(load)
  }

  // Persist a new lane order (drag-reorder in the diary day view).
  function reorderTechs(codes: string[]) {
    setTechs(prev => { const by: Record<string, Tech> = {}; prev.forEach(t => { by[t.ext] = t }); return codes.map(c => by[c]).filter(Boolean).concat(prev.filter(t => !codes.includes(t.ext))) })
    fetch('/api/workshop/technicians/reorder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ codes }) }).then(load)
  }

  // Department (technician role) tabs + single-tech pills narrow the lanes/bookings.
  const departments = Array.from(new Set(techs.map(t => (t.role || '').trim()).filter(Boolean))).sort()
  const deptTechs = deptFilter ? techs.filter(t => (t.role || '') === deptFilter) : techs
  const deptCodes = new Set(deptTechs.map(t => t.ext))
  const displayBookings = bookings.filter(b => {
    if (techFilter) return (b.technician_ext || '') === techFilter
    if (deptFilter) return deptCodes.has(b.technician_ext || '')
    return true
  })

  return (
    <>
      <Head><title>Workshop Diary — Just Autos</title><meta name="viewport" content="width=device-width,initial-scale=1"/><meta name="robots" content="noindex,nofollow"/></Head>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden', fontFamily: "'DM Sans',system-ui,sans-serif", color: T.text }}>
        <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet"/>
        <PortalTopBar
          activeId="diary"
          lastRefresh={lastRefresh}
          onRefresh={load}
          refreshing={loading}
          currentUserRole={user.role}
          currentUserVisibleTabs={user.visibleTabs}
          currentUserName={user.displayName}
          currentUserEmail={user.email}
        />

        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: T.bg }}>
          {/* Control bar */}
          <div style={{ height: 52, background: T.bg2, borderBottom: `1px solid ${T.border}`, display: 'flex', alignItems: 'center', padding: '0 20px', gap: 10, flexShrink: 0 }}>
            <span style={{ fontSize: 14, fontWeight: 600 }}>Workshop Diary</span>
            <div style={{ width: 1, height: 18, background: T.border, margin: '0 4px' }} />
            <button onClick={() => setDate(ymdBrisbane(new Date()))} style={btn(false)}>Today</button>
            <button onClick={() => shiftDate(-1)} style={btn(false)}>‹</button>
            <button onClick={() => shiftDate(1)} style={btn(false)}>›</button>
            <span style={{ fontSize: 13, color: T.text2, fontWeight: 500, minWidth: 200 }}>
              {view === 'day' ? dayLabel(date) : view === 'week' ? `Week of ${dayLabel(weekStartYmd(date))}` : monthLabel(date)}
            </span>
            {isAdmin && (
              <>
                <button onClick={doSync} disabled={sync.busy} style={btn(false)} title="Pull customers + inventory from MYOB">
                  {sync.busy ? '↻ Syncing…' : '↻ MYOB'}
                </button>
                {sync.msg && <span style={{ fontSize: 11, color: T.text3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 260 }}>{sync.msg}</span>}
                <button onClick={() => router.push('/settings?tab=workshop')} style={btn(false)} title="Workshop settings — technicians, business details, invoicing, SMS">⚙ Settings</button>
              </>
            )}
            <div style={{ flex: 1 }} />
            <div style={{ display: 'flex', gap: 4 }}>
              <button onClick={() => setView('day')} style={btn(view === 'day')}>Day</button>
              <button onClick={() => setView('week')} style={btn(view === 'week')}>Week</button>
              <button onClick={() => setView('month')} style={btn(view === 'month')}>Month</button>
            </div>
            {canEdit && (
              <>
                <button onClick={() => openNew({ ymd: view === 'day' ? date : view === 'week' ? weekStartYmd(date) : monthStartYmd(date), startMin: 9 * 60 })}
                  style={{ ...btn(true), background: T.accent, color: '#fff', borderColor: T.accent }}>+ Booking</button>
                <button onClick={openNewJob} style={btn(false)} title="Create a job and open its job card">+ Job</button>
              </>
            )}
          </div>

          {/* Grid */}
          <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
            {view !== 'month' && departments.length > 1 && (
              <DeptTabs departments={departments} active={deptFilter} onPick={(d) => { setDeptFilter(d); setTechFilter(null) }} />
            )}
            {view !== 'month' && <TechPills techs={deptTechs} active={techFilter} onPick={setTechFilter} />}
            {view === 'day' && (
              <DayNotes date={date} notes={notes} canEdit={canEdit} onAdd={(c) => addNote(date, c)} onDelete={delNote} />
            )}
            {view === 'day' ? (
              <DayGrid bookings={displayBookings} techs={techFilter ? deptTechs.filter(t => t.ext === techFilter) : deptTechs} showUnassigned={!techFilter && !deptFilter}
                date={date} hourLines={hourLines} capacity={capacity} canEdit={canEdit} canEditCapacity={isAdmin} onSetCapacity={setLaneCapacity}
                onLaneClick={laneClick} onBooking={(b) => canEdit && setEditing(b)}
                onDropBooking={(e, techExt) => dropMove(e, date, techExt, true)}
                canReorder={canEdit && !techFilter && !deptFilter} onReorder={reorderTechs} />
            ) : view === 'week' ? (
              <WeekGrid bookings={displayBookings} days={weekDays} hourLines={hourLines} canEdit={canEdit}
                onDayClick={(ymd) => { setDate(ymd); setView('day') }}
                onSlotClick={(ymd, e) => laneClick(e, ymd, null)}
                onBooking={(b) => canEdit && setEditing(b)}
                onDropBooking={(e, ymd) => dropMove(e, ymd, null, false)} />
            ) : (
              <MonthGrid date={date} bookings={displayBookings} notes={notes} onDayClick={(ymd) => { setDate(ymd); setView('day') }} />
            )}
            {!loading && bookings.length === 0 && view !== 'month' && (
              <div style={{ textAlign: 'center', color: T.text3, fontSize: 12, marginTop: 24 }}>
                No bookings {view === 'day' ? 'today' : 'this week'}.{canEdit ? ' Click a slot to add one.' : ''}
              </div>
            )}
          </div>
        </div>
      </div>

      {editing && (
        <BookingModal
          initial={editing}
          techs={techs}
          canEdit={canEdit}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load() }}
        />
      )}
    </>
  )
}

function btn(active: boolean): React.CSSProperties {
  return {
    padding: '4px 12px', borderRadius: 5, fontSize: 12, fontFamily: 'inherit', fontWeight: 600, cursor: 'pointer',
    background: active ? 'rgba(79,142,247,0.12)' : 'transparent',
    color: active ? T.blue : T.text2, border: `1px solid ${active ? T.blue + '55' : T.border2}`,
  }
}

// ── Technician filter pills (avatar chips; click to focus one tech's lane) ──
const PILL_COLORS = ['#4f8ef7', '#a78bfa', '#34c77b', '#f5a623', '#f04e4e', '#2dd4bf', '#ef7bd0', '#8b90a0']
function techInitials(name: string): string {
  const parts = name.replace(/^[A-Za-z]\s*-\s*/, '').trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return '?'
  return (parts[0][0] + (parts[1]?.[0] || '')).toUpperCase()
}
// ── Department tabs (technician role) — separate the diary by Technician / Dyno / … ──
function DeptTabs({ departments, active, onPick }: { departments: string[]; active: string | null; onPick: (d: string | null) => void }) {
  function tab(key: string | null, label: string) {
    const on = active === key
    return (
      <button key={key ?? '__all'} onClick={() => onPick(on ? null : key)} style={{
        padding: '5px 13px', borderRadius: 6, fontSize: 12, fontFamily: 'inherit', fontWeight: 600, cursor: 'pointer',
        background: on ? T.blue : T.bg2, color: on ? '#fff' : T.text2, border: `1px solid ${on ? T.blue : T.border2}`,
      }}>{label}</button>
    )
  }
  return (
    <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
      {tab(null, 'All')}
      {departments.map(d => tab(d, d))}
    </div>
  )
}

function TechPills({ techs, active, onPick }: { techs: Tech[]; active: string | null; onPick: (ext: string | null) => void }) {
  function pill(key: string | null, label: string, initials: string, color: string) {
    const on = active === key
    return (
      <button key={key ?? '__all'} onClick={() => onPick(on ? null : key)} style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 11px 3px 3px', borderRadius: 20, cursor: 'pointer', fontFamily: 'inherit',
        background: on ? `${color}22` : T.bg2, border: `1px solid ${on ? color : T.border2}`,
      }}>
        <span style={{ width: 22, height: 22, borderRadius: '50%', background: color, color: '#fff', fontSize: 9, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{initials}</span>
        <span style={{ fontSize: 11, fontWeight: 600, color: on ? color : T.text2 }}>{label}</span>
      </button>
    )
  }
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
      {pill(null, 'All techs', '✶', T.text3)}
      {techs.map((t, i) => pill(t.ext, t.name.split(/\s+/)[0] || t.ext, techInitials(t.name), t.color || PILL_COLORS[i % PILL_COLORS.length]))}
    </div>
  )
}

// ── Day grid: time axis + one lane per technician (with workload bar) ────
const LANE_HEADER_PX = 46
function DayGrid({ bookings, techs, date, hourLines, capacity, canEdit, canEditCapacity, onSetCapacity, onLaneClick, onBooking, onDropBooking, showUnassigned, canReorder, onReorder }: {
  bookings: BookingRow[]; techs: Tech[]; date: string; hourLines: number[]
  capacity: Record<string, number>; canEdit: boolean; canEditCapacity: boolean; onSetCapacity: (ext: string) => void
  onLaneClick: (e: React.MouseEvent<HTMLDivElement>, ymd: string, techExt: string | null) => void
  onBooking: (b: BookingRow) => void
  onDropBooking: (e: React.DragEvent<HTMLDivElement>, techExt: string | null) => void
  showUnassigned: boolean
  canReorder: boolean
  onReorder: (codes: string[]) => void
}) {
  // "Unassigned" lane catches bookings with no technician (hidden when filtered to a tech).
  const lanes: Tech[] = showUnassigned ? [{ ext: '', name: 'Unassigned' }, ...techs] : [...techs]
  const byLane = (ext: string) => bookings.filter(b => (b.technician_ext || '') === ext)
  // Reorder lanes: move the dragged lane to the drop target's position.
  function reorderLanes(draggedCode: string, targetCode: string) {
    if (!draggedCode || !targetCode || draggedCode === targetCode) return
    const order = techs.map(t => t.ext)
    const from = order.indexOf(draggedCode), to = order.indexOf(targetCode)
    if (from < 0 || to < 0) return
    order.splice(to, 0, order.splice(from, 1)[0])
    onReorder(order)
  }
  return (
    <div style={{ display: 'flex', minWidth: 'fit-content', border: `1px solid ${T.border}`, borderRadius: 8, overflow: 'hidden', background: T.bg2 }}>
      {/* time axis */}
      <div style={{ width: 56, flexShrink: 0, borderRight: `1px solid ${T.border}` }}>
        <div style={{ height: LANE_HEADER_PX, borderBottom: `1px solid ${T.border}` }} />
        <div style={{ position: 'relative', height: GRID_PX }}>
          {hourLines.map((h, i) => (
            <div key={h} style={{ position: 'absolute', top: i * 2 * SLOT_PX - 6, right: 6, fontSize: 10, color: T.text3, fontFamily: 'monospace' }}>{pad(h)}:00</div>
          ))}
        </div>
      </div>
      {/* lanes */}
      {lanes.map(lane => {
        const laneBookings = byLane(lane.ext)
        const booked = laneBookings.reduce((s, b) => s + durationHours(b), 0)
        const cap = lane.ext ? (capacity[lane.ext] ?? 8) : 0
        const pct = cap > 0 ? Math.min(100, (booked / cap) * 100) : 0
        const over = cap > 0 && booked > cap
        const barColor = over ? T.red : pct > 80 ? T.amber : T.green
        return (
          <div key={lane.ext || 'unassigned'} style={{ flex: 1, minWidth: 150, borderRight: `1px solid ${T.border}` }}>
            <div
              onDragOver={canReorder && lane.ext ? (e) => e.preventDefault() : undefined}
              onDrop={canReorder && lane.ext ? (e) => { const d = e.dataTransfer.getData('text/plain'); if (d.startsWith('lane:')) { e.preventDefault(); reorderLanes(d.slice(5), lane.ext) } } : undefined}
              style={{ height: LANE_HEADER_PX, borderBottom: `1px solid ${T.border}`, background: T.bg3, padding: '4px 6px', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 3 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4, minWidth: 0 }}>
                {canReorder && lane.ext && (
                  <span draggable
                    onDragStart={(e) => { e.dataTransfer.setData('text/plain', `lane:${lane.ext}`); e.dataTransfer.effectAllowed = 'move' }}
                    title="Drag to reorder this lane"
                    style={{ cursor: 'grab', color: T.text3, fontSize: 12, lineHeight: 1, flexShrink: 0, padding: '0 1px' }}>⠿</span>
                )}
                <span style={{ fontSize: 11, fontWeight: 600, color: lane.ext ? T.text2 : T.text3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{lane.name}</span>
              </div>
              {lane.ext ? (
                <div onClick={() => canEditCapacity && onSetCapacity(lane.ext)} title={canEditCapacity ? 'Click to set this technician’s hours for the day' : `${booked.toFixed(1)} of ${cap}h booked`}
                  style={{ cursor: canEditCapacity ? 'pointer' : 'default', borderRadius: 3, padding: '1px 2px', ...(canEditCapacity ? { outline: `1px solid ${T.border}` } : {}) }}>
                  <div style={{ height: 4, background: T.bg4, borderRadius: 2, overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${pct}%`, background: barColor }} />
                  </div>
                  <div style={{ fontSize: 9, color: over ? T.red : T.text3, fontFamily: 'monospace', textAlign: 'center', marginTop: 1 }}>{booked.toFixed(1)}/{cap}h{canEditCapacity ? ' ✎' : ''}</div>
                </div>
              ) : <div style={{ height: 13 }} />}
            </div>
            <div onClick={(e) => onLaneClick(e, date, lane.ext || null)}
              onDragOver={(e) => e.preventDefault()} onDrop={(e) => onDropBooking(e, lane.ext || null)}
              style={{ position: 'relative', height: GRID_PX, cursor: 'copy' }}>
              {hourLines.map((h, i) => (
                <div key={h} style={{ position: 'absolute', top: i * 2 * SLOT_PX, left: 0, right: 0, borderTop: `1px solid ${T.border}` }} />
              ))}
              {laneBookings.map(b => <BookingBlock key={b.id} b={b} draggable={canEdit} onClick={() => onBooking(b)} />)}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── Month grid: 6-week calendar, day cells with job/note counts ─────────
function MonthGrid({ date, bookings, notes, onDayClick }: { date: string; bookings: BookingRow[]; notes: any[]; onDayClick: (ymd: string) => void }) {
  const days = monthGridDays(date)
  const today = ymdBrisbane(new Date())
  const monthNum = monthStartYmd(date).slice(5, 7)
  const dow = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
  return (
    <div style={{ border: `1px solid ${T.border}`, borderRadius: 8, overflow: 'hidden', background: T.bg2 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)' }}>
        {dow.map(d => <div key={d} style={{ padding: '8px 0', textAlign: 'center', fontSize: 10, fontWeight: 600, color: T.text3, textTransform: 'uppercase', background: T.bg3, borderBottom: `1px solid ${T.border}` }}>{d}</div>)}
        {days.map((ymd, i) => {
          const inMonth = ymd.slice(5, 7) === monthNum
          const count = bookings.filter(b => bneYmd(b.starts_at) === ymd).length
          const nNotes = notes.filter((n: any) => bneYmd(n.note_date) === ymd).length
          const isToday = ymd === today
          return (
            <div key={ymd} onClick={() => onDayClick(ymd)} title="Open day"
              style={{ minHeight: 84, padding: 6, borderRight: (i % 7 !== 6) ? `1px solid ${T.border}` : 'none', borderBottom: `1px solid ${T.border}`, background: isToday ? 'rgba(79,142,247,0.06)' : 'transparent', opacity: inMonth ? 1 : 0.4, cursor: 'pointer' }}>
              <div style={{ fontSize: 11, fontWeight: isToday ? 700 : 500, color: isToday ? T.blue : T.text2 }}>{Number(ymd.slice(8, 10))}</div>
              {count > 0 && <div style={{ marginTop: 4, fontSize: 11, color: T.text }}>{count} job{count > 1 ? 's' : ''}</div>}
              {nNotes > 0 && <div style={{ marginTop: 2, fontSize: 9, color: T.amber }}>📝 {nNotes}</div>}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Notes for the day ───────────────────────────────────────────────────
function DayNotes({ date, notes, canEdit, onAdd, onDelete }: { date: string; notes: any[]; canEdit: boolean; onAdd: (c: string) => void; onDelete: (id: string) => void }) {
  const [val, setVal] = useState('')
  const dayNotes = notes.filter((n: any) => bneYmd(n.note_date) === date)
  return (
    <div style={{ marginBottom: 12, background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 8, padding: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 10, fontWeight: 600, color: T.text3, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Notes · {dayLabel(date)}</span>
        {dayNotes.length === 0 && <span style={{ fontSize: 11, color: T.text3 }}>—</span>}
        {dayNotes.map((n: any) => (
          <span key={n.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, color: T.text, background: T.bg3, border: `1px solid ${T.border}`, borderRadius: 5, padding: '3px 8px' }}>
            {n.content}{n.author_name ? <span style={{ color: T.text3 }}>· {n.author_name}</span> : null}
            {canEdit && <button onClick={() => onDelete(n.id)} style={{ background: 'transparent', border: 'none', color: T.text3, cursor: 'pointer', fontSize: 13, lineHeight: 1 }}>×</button>}
          </span>
        ))}
      </div>
      {canEdit && (
        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
          <input value={val} onChange={e => setVal(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { onAdd(val); setVal('') } }} placeholder="Add a note for this day…" style={{ flex: 1, padding: '6px 9px', background: T.bg3, border: `1px solid ${T.border}`, borderRadius: 5, color: T.text, fontSize: 12, fontFamily: 'inherit', outline: 'none' }} />
          <button onClick={() => { onAdd(val); setVal('') }} style={btn(false)}>Add</button>
        </div>
      )}
    </div>
  )
}

// ── Week grid: 7 day columns ────────────────────────────────────────────
function WeekGrid({ bookings, days, hourLines, canEdit, onDayClick, onSlotClick, onBooking, onDropBooking }: {
  bookings: BookingRow[]; days: string[]; hourLines: number[]; canEdit: boolean
  onDayClick: (ymd: string) => void
  onSlotClick: (ymd: string, e: React.MouseEvent<HTMLDivElement>) => void
  onBooking: (b: BookingRow) => void
  onDropBooking: (e: React.DragEvent<HTMLDivElement>, ymd: string) => void
}) {
  const today = ymdBrisbane(new Date())
  return (
    <div style={{ display: 'flex', minWidth: 'fit-content', border: `1px solid ${T.border}`, borderRadius: 8, overflow: 'hidden', background: T.bg2 }}>
      <div style={{ width: 56, flexShrink: 0, borderRight: `1px solid ${T.border}` }}>
        <div style={{ height: 32, borderBottom: `1px solid ${T.border}` }} />
        <div style={{ position: 'relative', height: GRID_PX }}>
          {hourLines.map((h, i) => (
            <div key={h} style={{ position: 'absolute', top: i * 2 * SLOT_PX - 6, right: 6, fontSize: 10, color: T.text3, fontFamily: 'monospace' }}>{pad(h)}:00</div>
          ))}
        </div>
      </div>
      {days.map(ymd => (
        <div key={ymd} style={{ flex: 1, minWidth: 120, borderRight: `1px solid ${T.border}` }}>
          <div onClick={() => onDayClick(ymd)} title="Open day view"
            style={{ height: 32, borderBottom: `1px solid ${T.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 600, color: ymd === today ? T.blue : T.text2, background: ymd === today ? 'rgba(79,142,247,0.08)' : T.bg3, cursor: 'pointer' }}>
            {dayLabel(ymd)}
          </div>
          <div onClick={(e) => onSlotClick(ymd, e)}
            onDragOver={(e) => e.preventDefault()} onDrop={(e) => onDropBooking(e, ymd)}
            style={{ position: 'relative', height: GRID_PX, cursor: 'copy' }}>
            {hourLines.map((h, i) => (
              <div key={h} style={{ position: 'absolute', top: i * 2 * SLOT_PX, left: 0, right: 0, borderTop: `1px solid ${T.border}` }} />
            ))}
            {bookings.filter(b => bneYmd(b.starts_at) === ymd).map(b => <BookingBlock key={b.id} b={b} draggable={canEdit} onClick={() => onBooking(b)} showTech />)}
          </div>
        </div>
      ))}
    </div>
  )
}

// ── Create / edit modal ─────────────────────────────────────────────────
function BookingModal({ initial, techs, canEdit, onClose, onSaved }: {
  initial: Partial<BookingRow>; techs: Tech[]; canEdit: boolean
  onClose: () => void; onSaved: () => void
}) {
  const isNew = !initial.id
  const [ymd, setYmd] = useState<string>(initial.starts_at ? bneYmd(initial.starts_at) : ymdBrisbane(new Date()))
  const [time, setTime] = useState<string>(initial.starts_at ? bneTimeStr(initial.starts_at) : '09:00')
  const [duration, setDuration] = useState<number>(initial.starts_at && initial.ends_at ? bookingDurationMin(initial as BookingRow) : 60)
  const [tech, setTech] = useState<string>(initial.technician_ext || '')
  const [bay, setBay] = useState<string>(initial.bay || '')
  const [jobType, setJobType] = useState<string>(initial.job_type || 'general_service')
  const [description, setDescription] = useState<string>(initial.description || '')
  const [estValue, setEstValue] = useState<string>(initial.estimated_value != null ? String(initial.estimated_value) : '')
  const [status, setStatus] = useState<BookingStatus>(initial.status || 'booking')
  const [notes, setNotes] = useState<string>(initial.notes || '')
  const [customer, setCustomer] = useState<{ id: string; name: string } | null>(initial.customer ? { id: initial.customer.id, name: initial.customer.name } : null)
  const [vehicle, setVehicle] = useState<{ id: string; label: string } | null>(initial.vehicle ? { id: initial.vehicle.id, label: vehicleLabel(initial.vehicle) } : null)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')
  const [splitTech, setSplitTech] = useState('')
  const [splitting, setSplitting] = useState(false)

  async function doSplit() {
    setSplitting(true); setErr('')
    try {
      const r = await fetch(`/api/workshop/bookings/${initial.id}/split`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ technician_ext: splitTech || null }) })
      const d = await r.json()
      if (!r.ok) { setErr(d.error || 'Split failed'); return }
      onSaved(); onClose()
    } catch (e: any) { setErr(e?.message || 'Split failed') } finally { setSplitting(false) }
  }

  async function save() {
    setSaving(true); setErr('')
    const startIso = isoFromBne(ymd, time)
    const endIso = new Date(new Date(startIso).getTime() + duration * 60000).toISOString()
    const payload: any = {
      starts_at: startIso, ends_at: endIso,
      technician_ext: tech || null, bay: bay || null,
      job_type: jobType || null, description: description || null,
      estimated_value: estValue.trim() ? (Number(estValue) || null) : null,
      status, notes: notes || null,
      customer_id: customer?.id || null, vehicle_id: vehicle?.id || null,
    }
    try {
      const r = isNew
        ? await fetch('/api/workshop/bookings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
        : await fetch(`/api/workshop/bookings/${initial.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      const d = await r.json()
      if (!r.ok) { setErr(d.error || d.message || 'Save failed'); return }
      onSaved()
    } catch (e: any) { setErr(e?.message || 'Save failed') } finally { setSaving(false) }
  }

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000, backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div onClick={e => e.stopPropagation()} style={{ width: '100%', maxWidth: 480, maxHeight: '90vh', overflowY: 'auto', background: T.bg2, border: `1px solid ${T.border2}`, borderRadius: 12, padding: 22 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div style={{ fontSize: 15, fontWeight: 600 }}>{isNew ? 'New booking' : 'Edit booking'}</div>
          <button onClick={onClose} style={{ width: 30, height: 30, borderRadius: 6, background: T.bg3, border: `1px solid ${T.border}`, color: T.text2, cursor: 'pointer', fontSize: 16 }}>×</button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <EntityPicker label="Customer" kind="customer" value={customer ? { id: customer.id, label: customer.name } : null}
            disabled={!canEdit} onPick={(v) => setCustomer(v ? { id: v.id, name: v.label } : null)} />
          <EntityPicker label="Vehicle" kind="vehicle" customerId={customer?.id || null} value={vehicle}
            disabled={!canEdit} onPick={(v) => setVehicle(v)} />

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
            <Field label="Date"><input type="date" value={ymd} disabled={!canEdit} onChange={e => setYmd(e.target.value)} style={inp} /></Field>
            <Field label="Start"><input type="time" value={time} disabled={!canEdit} step={900} onChange={e => setTime(e.target.value)} style={inp} /></Field>
            <Field label="Duration">
              <select value={duration} disabled={!canEdit} onChange={e => setDuration(Number(e.target.value))} style={inp}>
                {DURATIONS.map(m => <option key={m} value={m}>{m < 60 ? `${m}m` : `${m / 60}h${m % 60 ? ` ${m % 60}m` : ''}`}</option>)}
              </select>
            </Field>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <Field label="Technician">
              <select value={tech} disabled={!canEdit} onChange={e => setTech(e.target.value)} style={inp}>
                <option value="">Unassigned</option>
                {techs.map(t => <option key={t.ext} value={t.ext}>{t.name}{t.role ? ` · ${t.role}` : ''}</option>)}
              </select>
            </Field>
            <Field label="Bay"><input value={bay} disabled={!canEdit} onChange={e => setBay(e.target.value)} placeholder="e.g. Hoist 1" style={inp} /></Field>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 120px', gap: 8 }}>
            <Field label="Job type">
              <select value={jobType} disabled={!canEdit} onChange={e => setJobType(e.target.value)} style={inp}>
                {JOB_TYPES.map(j => <option key={j.value} value={j.value}>{j.label}</option>)}
              </select>
            </Field>
            <Field label="Est. value">
              <input value={estValue} disabled={!canEdit} inputMode="decimal" onChange={e => setEstValue(e.target.value)} placeholder="$" style={inp} />
            </Field>
          </div>
          <Field label="Description"><textarea value={description} disabled={!canEdit} onChange={e => setDescription(e.target.value)} rows={2} placeholder="Work to be done…" style={{ ...inp, resize: 'vertical' }} /></Field>

          <Field label="Status">
            <select value={status} disabled={!canEdit} onChange={e => setStatus(e.target.value as BookingStatus)} style={inp}>
              {BOOKING_STATUSES.map(s => <option key={s} value={s}>{BOOKING_STATUS_META[s].label}</option>)}
            </select>
          </Field>

          <Field label="Notes"><textarea value={notes} disabled={!canEdit} onChange={e => setNotes(e.target.value)} rows={2} style={{ ...inp, resize: 'vertical' }} /></Field>

          {!isNew && canEdit && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', paddingTop: 12, borderTop: `1px solid ${T.border}` }}>
              <span style={{ fontSize: 12, color: T.text3, whiteSpace: 'nowrap' }}>Split job to</span>
              <select value={splitTech} onChange={e => setSplitTech(e.target.value)} style={{ ...inp, flex: 1 }}>
                <option value="">Unassigned</option>
                {techs.map(t => <option key={t.ext} value={t.ext}>{t.name}{t.role ? ` · ${t.role}` : ''}</option>)}
              </select>
              <button onClick={doSplit} disabled={splitting} title="Create a linked second booking (same vehicle/job) for another technician or time" style={{ ...btn(false), padding: '7px 14px' }}>{splitting ? 'Splitting…' : 'Split'}</button>
            </div>
          )}

          {err && <div style={{ fontSize: 12, color: T.red }}>{err}</div>}

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginTop: 4 }}>
            <div>
              {!isNew && (
                <a href={`/workshop/job/${initial.id}`} style={{ fontSize: 12, color: T.blue, textDecoration: 'none', fontWeight: 600 }}>Open job card →</a>
              )}
            </div>
            {canEdit && (
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={onClose} style={{ ...btn(false), padding: '7px 14px' }}>Cancel</button>
                <button onClick={save} disabled={saving} style={{ ...btn(true), padding: '7px 16px', background: T.accent, color: '#fff', borderColor: T.accent, cursor: saving ? 'wait' : 'pointer' }}>
                  {saving ? 'Saving…' : (isNew ? 'Create booking' : 'Save changes')}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

const inp: React.CSSProperties = {
  width: '100%', padding: '7px 9px', background: T.bg3, border: `1px solid ${T.border}`, borderRadius: 5,
  color: T.text, fontSize: 12, fontFamily: 'inherit', outline: 'none', colorScheme: 'dark', boxSizing: 'border-box',
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'block' }}>
      <div style={{ fontSize: 10, color: T.text3, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>{label}</div>
      {children}
    </label>
  )
}

// ── Customer / vehicle typeahead with quick-add ─────────────────────────
function EntityPicker({ label, kind, value, customerId, disabled, onPick }: {
  label: string; kind: 'customer' | 'vehicle'; value: { id: string; label: string } | null
  customerId?: string | null; disabled?: boolean
  onPick: (v: { id: string; label: string } | null) => void
}) {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<{ id: string; label: string }[]>([])
  const [open, setOpen] = useState(false)
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open || value) return
    const t = setTimeout(async () => {
      try {
        const url = kind === 'customer'
          ? `/api/workshop/customers?q=${encodeURIComponent(q)}`
          : `/api/workshop/vehicles?${customerId ? `customer_id=${customerId}` : `q=${encodeURIComponent(q)}`}`
        const r = await fetch(url); const d = await r.json()
        if (kind === 'customer') setResults((d.customers || []).map((c: any) => ({ id: c.id, label: customerLabel(c) + (c.mobile || c.phone ? ` · ${c.mobile || c.phone}` : '') })))
        else setResults((d.vehicles || []).map((v: any) => ({ id: v.id, label: vehicleLabel(v) })))
      } catch { /* ignore */ }
    }, 250)
    return () => clearTimeout(t)
  }, [q, open, kind, customerId, value])

  async function create() {
    setBusy(true)
    try {
      if (kind === 'customer') {
        const r = await fetch('/api/workshop/customers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) })
        const d = await r.json(); if (r.ok && d.customer) { onPick({ id: d.customer.id, label: d.customer.name }); reset() }
      } else {
        const r = await fetch('/api/workshop/vehicles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...form, customer_id: customerId || null }) })
        const d = await r.json(); if (r.ok && d.vehicle) { onPick({ id: d.vehicle.id, label: vehicleLabel(d.vehicle) }); reset() }
      }
    } finally { setBusy(false) }
  }
  function reset() { setAdding(false); setForm({}); setOpen(false); setQ('') }

  if (value) {
    return (
      <Field label={label}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ flex: 1, ...inp, display: 'flex', alignItems: 'center' }}>{value.label}</div>
          {!disabled && <button onClick={() => onPick(null)} style={{ ...btn(false), padding: '6px 10px' }}>Change</button>}
        </div>
      </Field>
    )
  }

  return (
    <Field label={label}>
      {!adding ? (
        <div style={{ position: 'relative' }}>
          <input
            value={q} disabled={disabled}
            onFocus={() => setOpen(true)}
            onChange={e => { setQ(e.target.value); setOpen(true) }}
            placeholder={kind === 'customer' ? 'Search name / phone…' : (customerId ? 'Pick or add vehicle' : 'Search rego / make…')}
            style={inp}
          />
          {open && (results.length > 0 || !disabled) && (
            <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 5, background: T.bg3, border: `1px solid ${T.border2}`, borderRadius: 6, marginTop: 2, maxHeight: 200, overflowY: 'auto' }}>
              {results.map(r => (
                <div key={r.id} onClick={() => { onPick(r); setOpen(false) }} style={{ padding: '7px 10px', fontSize: 12, cursor: 'pointer', borderBottom: `1px solid ${T.border}` }}>{r.label}</div>
              ))}
              {!disabled && (
                <div onClick={() => { setAdding(true); setOpen(false) }} style={{ padding: '7px 10px', fontSize: 12, color: T.blue, cursor: 'pointer', fontWeight: 600 }}>
                  ＋ New {kind}
                </div>
              )}
            </div>
          )}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 8, background: T.bg3, border: `1px solid ${T.border}`, borderRadius: 6 }}>
          {kind === 'customer' ? (
            <>
              <input autoFocus placeholder="Name *" style={inp} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
              <input placeholder="Mobile" style={inp} onChange={e => setForm(f => ({ ...f, mobile: e.target.value }))} />
            </>
          ) : (
            <>
              <input autoFocus placeholder="Rego" style={inp} onChange={e => setForm(f => ({ ...f, rego: e.target.value }))} />
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 70px', gap: 6 }}>
                <input placeholder="Make" style={inp} onChange={e => setForm(f => ({ ...f, make: e.target.value }))} />
                <input placeholder="Model" style={inp} onChange={e => setForm(f => ({ ...f, model: e.target.value }))} />
                <input placeholder="Year" style={inp} onChange={e => setForm(f => ({ ...f, year: e.target.value }))} />
              </div>
            </>
          )}
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
            <button onClick={reset} style={{ ...btn(false), padding: '5px 10px' }}>Cancel</button>
            <button onClick={create} disabled={busy} style={{ ...btn(true), padding: '5px 12px', background: T.accent, color: '#fff', borderColor: T.accent }}>{busy ? 'Adding…' : 'Add'}</button>
          </div>
        </div>
      )}
    </Field>
  )
}

export async function getServerSideProps(context: any) {
  return requirePageAuth(context, 'view:diary')
}
