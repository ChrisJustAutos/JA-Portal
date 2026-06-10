// pages/diary.tsx
// Workshop diary — Phase 1 of the MechanicDesk replacement. Day view with
// technician lanes + week overview. Create/move bookings, attach customer +
// vehicle (with quick-add). Reads/writes via /api/workshop/* (service-role,
// gated view:diary / edit:bookings). MYOB stays the customer/stock master.

import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import Head from 'next/head'
import { useRouter } from 'next/router'
import PortalTopBar from '../lib/PortalTopBar'
import WorkshopTabs from '../components/WorkshopTabs'
import { requirePageAuth } from '../lib/authServer'
import { roleHasPermission } from '../lib/permissions'
import {
  BOOKING_STATUS_META, BOOKING_STATUSES, BookingStatus,
  vehicleLabel, customerLabel,
  ymdBrisbane, brisbaneDayBounds, addDaysYmd, weekStartYmd,
  jobTypeLabel,
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
  pickup_at: string | null
  customer: { id: string; name: string; phone: string | null; mobile: string | null } | null
  vehicle: { id: string; rego: string | null; make: string | null; model: string | null; year: number | null } | null
}

// ── Time grid config (Brisbane wall clock) — workshop hours are configurable ──
const SLOT_MIN = 30
const SLOT_PX = 30
const DEFAULT_START_MIN = 7 * 60    // 7:00
const DEFAULT_END_MIN = 18 * 60     // 18:00
interface GridCfg { startMin: number; endMin: number; gridPx: number; hourMarks: number[] }
function makeGrid(startMin: number, endMin: number): GridCfg {
  const s = Math.max(0, Math.min(startMin, endMin - SLOT_MIN))
  const e = Math.min(1440, Math.max(endMin, s + SLOT_MIN))
  const gridPx = ((e - s) / SLOT_MIN) * SLOT_PX
  const hourMarks: number[] = []
  for (let m = Math.ceil(s / 60) * 60; m <= e; m += 60) hourMarks.push(m)   // hour gridlines within range
  return { startMin: s, endMin: e, gridPx, hourMarks }
}
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
function hhmmPlus(hhmm: string, mins: number): string { const [h, m] = String(hhmm || '0:0').split(':').map(Number); const t = ((h * 60 + (m || 0)) + mins + 1440) % 1440; return minsToHHMM(t) }
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
// The visible window (configured workshop hours) of a day, in epoch ms.
function dayWindowMs(ymd: string, grid: GridCfg): { winStart: number; winEnd: number } {
  return {
    winStart: new Date(isoFromBne(ymd, minsToHHMM(grid.startMin))).getTime(),
    winEnd: new Date(isoFromBne(ymd, minsToHHMM(grid.endMin))).getTime(),
  }
}
// The slice of a (possibly multi-day) booking that falls on `ymd`, positioned
// within that day's time grid. null if it doesn't touch this day's window.
function daySegment(b: { starts_at: string; ends_at: string }, ymd: string, grid: GridCfg):
  { top: number; height: number; clipTop: boolean; clipBottom: boolean } | null {
  const { winStart, winEnd } = dayWindowMs(ymd, grid)
  const s = new Date(b.starts_at).getTime(), e = new Date(b.ends_at).getTime()
  if (!(e > winStart && s < winEnd)) return null
  const segS = Math.max(s, winStart), segE = Math.min(e, winEnd)
  const top = (segS - winStart) / 60000 / SLOT_MIN * SLOT_PX
  const height = Math.max(SLOT_PX * 0.6, (segE - segS) / 60000 / SLOT_MIN * SLOT_PX - 2)
  return { top, height, clipTop: s < winStart, clipBottom: e > winEnd }
}
function segmentHours(b: { starts_at: string; ends_at: string }, ymd: string, grid: GridCfg): number {
  const { winStart, winEnd } = dayWindowMs(ymd, grid)
  const s = new Date(b.starts_at).getTime(), e = new Date(b.ends_at).getTime()
  if (!(e > winStart && s < winEnd)) return 0
  return (Math.min(e, winEnd) - Math.max(s, winStart)) / 3600000
}

// ── Booking block (positioned in a lane for a given day's segment) ──────
// Resize: pointer events on a bottom handle (HTML5 drag stays owned by the
// move gesture). While resizing the block is non-draggable, and a just-resized
// flag swallows the click that follows pointerup so the editor doesn't open.
function BookingBlock({ b, seg, onClick, showTech, draggable, onDragEnd, resizable, onResize, clocked }: { b: BookingRow; seg: { top: number; height: number; clipTop?: boolean; clipBottom?: boolean }; onClick: () => void; showTech?: boolean; draggable?: boolean; onDragEnd?: () => void; resizable?: boolean; onResize?: (newEndIso: string) => void; clocked?: boolean }) {
  const { top, height } = seg
  const c = BOOKING_STATUS_META[b.status].color
  const veh = b.vehicle ? vehicleLabel(b.vehicle) : ''
  const cust = b.customer ? customerLabel(b.customer) : ''
  const spans = seg.clipTop || seg.clipBottom
  const [resizing, setResizing] = useState<{ startY: number; delta: number } | null>(null)
  const justResized = useRef(false)

  const durMin = Math.max(SLOT_MIN, Math.round((new Date(b.ends_at).getTime() - new Date(b.starts_at).getTime()) / 60000))
  const deltaSlots = resizing ? Math.round(resizing.delta / SLOT_PX) : 0
  const previewDurMin = Math.max(SLOT_MIN, durMin + deltaSlots * SLOT_MIN)
  const previewEndIso = new Date(new Date(b.starts_at).getTime() + previewDurMin * 60000).toISOString()
  const dispHeight = resizing ? Math.max(SLOT_PX * 0.6, height + (previewDurMin - durMin) / SLOT_MIN * SLOT_PX) : height

  return (
    <div
      draggable={!!draggable && !resizing}
      onDragStart={draggable ? (e) => { e.dataTransfer.setData('text/plain', b.id); e.dataTransfer.effectAllowed = 'move' } : undefined}
      onDragEnd={onDragEnd}
      onClick={(e) => { e.stopPropagation(); if (justResized.current) { justResized.current = false; return } onClick() }}
      title={`${fmtDateTimeShort(b.starts_at)} – ${fmtDateTimeShort(b.ends_at)} · ${cust} · ${veh}`}
      style={{
        position: 'absolute', top, left: 2, right: 2, height: dispHeight, overflow: 'hidden',
        background: `${c}1c`, borderLeft: `3px solid ${c}`, border: `1px solid ${c}44`,
        borderTopLeftRadius: seg.clipTop ? 0 : 4, borderTopRightRadius: seg.clipTop ? 0 : 4,
        borderBottomLeftRadius: seg.clipBottom ? 0 : 4, borderBottomRightRadius: seg.clipBottom ? 0 : 4,
        padding: '3px 6px', cursor: draggable ? 'grab' : 'pointer', fontSize: 11, lineHeight: 1.25,
        zIndex: resizing ? 8 : undefined,
      }}>
      <div style={{ color: T.text, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {clocked ? '⏱ ' : ''}{seg.clipTop ? '↑ ' : ''}{veh || cust || 'Booking'}{spans ? ' ⇕' : ''}
      </div>
      <div style={{ color: T.text2, fontSize: 10, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {seg.clipTop ? 'cont.' : bneTimeStr(b.starts_at)} · {b.description || jobTypeLabel(b.job_type) || cust || '—'}{showTech && b.technician_ext ? ` · ${b.technician_ext}` : ''}{seg.clipBottom ? ' →' : ''}
      </div>
      {resizing && (
        <span style={{ position: 'absolute', bottom: 8, right: 4, background: T.accent, color: '#fff', fontSize: 10, fontWeight: 700, padding: '1px 5px', borderRadius: 3, fontFamily: 'monospace', pointerEvents: 'none' }}>
          → {bneTimeStr(previewEndIso)}
        </span>
      )}
      {resizable && !seg.clipBottom && (
        <div
          onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); setResizing({ startY: e.clientY, delta: 0 }) }}
          onPointerMove={(e) => { if (resizing) setResizing(r => r && { ...r, delta: e.clientY - r.startY }) }}
          onPointerUp={() => {
            if (!resizing) return
            const changed = previewDurMin !== durMin
            setResizing(null)
            justResized.current = true
            if (changed && onResize) onResize(previewEndIso)
          }}
          onClick={(e) => e.stopPropagation()}
          title="Drag to change duration"
          style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 8, cursor: 'ns-resize', touchAction: 'none' }}
        />
      )}
    </div>
  )
}
function fmtDateTimeShort(iso: string): string {
  try { return new Date(iso).toLocaleString('en-AU', { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }) } catch { return iso }
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
  const [clockedOn, setClockedOn] = useState<Set<string>>(() => new Set())
  const [techs, setTechs] = useState<Tech[]>([])
  const [notes, setNotes] = useState<any[]>([])
  const [capacity, setCapacity] = useState<Record<string, number>>({})
  const [techFilter, setTechFilter] = useState<string | null>(null)
  const [deptFilter, setDeptFilter] = useState<string | null>(null)
  const [grid, setGrid] = useState<GridCfg>(() => makeGrid(DEFAULT_START_MIN, DEFAULT_END_MIN))
  const [loading, setLoading] = useState(true)
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null)
  const [editing, setEditing] = useState<Partial<BookingRow> | null>(null) // open modal when non-null

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
      const [bRes, nRes] = await Promise.all([
        fetch(`/api/workshop/bookings?from=${encodeURIComponent(range.fromIso)}&to=${encodeURIComponent(range.toIso)}`),
        fetch(`/api/workshop/diary-notes?from=${encodeURIComponent(range.fromIso)}&to=${encodeURIComponent(range.toIso)}`),
      ])
      const d = await bRes.json()
      if (bRes.ok) {
        setBookings(Array.isArray(d.bookings) ? d.bookings : [])
        setClockedOn(new Set<string>(Array.isArray(d.clocked_on) ? d.clocked_on : []))
        const techList = Array.isArray(d.technicians) ? d.technicians : []
        setTechs(techList)
        // Capacity lives on workshop_technicians.daily_hours — already in this
        // payload, so no separate tech-capacity fetch.
        setCapacity(Object.fromEntries(techList.map((t: any) => [String(t.ext), Number(t.daily_hours ?? 8)])))
        if (d.diary) setGrid(makeGrid(Number(d.diary.startMin), Number(d.diary.endMin)))
      }
      const nd = await nRes.json().catch(() => ({})); if (nRes.ok) setNotes(Array.isArray(nd.notes) ? nd.notes : [])
      setLastRefresh(new Date())
    } catch { /* leave previous data */ } finally { setLoading(false) }
  }, [range])

  useEffect(() => { load() }, [load])

  const weekDays = useMemo(() => {
    const ws = weekStartYmd(date)
    return Array.from({ length: 7 }, (_, i) => addDaysYmd(ws, i))
  }, [date])

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
    openNew({ ymd, startMin: grid.startMin + slot * SLOT_MIN, techExt })
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
    const startMin = grid.startMin + slot * SLOT_MIN
    const durMin = Math.max(30, Math.round((new Date(b.ends_at).getTime() - new Date(b.starts_at).getTime()) / 60000))
    const startIso = isoFromBne(ymd, minsToHHMM(startMin))
    const endIso = new Date(new Date(startIso).getTime() + durMin * 60000).toISOString()
    const patch: any = { starts_at: startIso, ends_at: endIso }
    if (setTech) patch.technician_ext = techExt
    fetch(`/api/workshop/bookings/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }).then(load)
  }

  // Drag-resize a booking's bottom edge in the day view → new end time.
  function resizeBooking(b: BookingRow, endIso: string) {
    if (!canEdit) return
    fetch(`/api/workshop/bookings/${b.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ends_at: endIso }) }).then(load)
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
        <WorkshopTabs active="diary" role={user.role} />

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
            <div style={{ flex: 1 }} />
            {isAdmin && (
              <>
                <button onClick={() => router.push('/workshop/activity')} style={btn(false)} title="Workshop activity log — who did what, when">≡ Activity</button>
                <button onClick={() => router.push('/settings?tab=workshop')} style={btn(false)} title="Workshop settings — technicians, MYOB, business details, SMS">⚙ Settings</button>
              </>
            )}
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
                date={date} grid={grid} capacity={capacity} canEdit={canEdit} canEditCapacity={isAdmin} onSetCapacity={setLaneCapacity}
                onLaneClick={laneClick} onBooking={(b) => canEdit && setEditing(b)}
                onDropBooking={(e, techExt) => dropMove(e, date, techExt, true)}
                canReorder={canEdit && !techFilter && !deptFilter} onReorder={reorderTechs}
                onResize={resizeBooking} clockedOn={clockedOn} />
            ) : view === 'week' ? (
              <WeekGrid bookings={displayBookings} days={weekDays} grid={grid} canEdit={canEdit}
                onDayClick={(ymd) => { setDate(ymd); setView('day') }}
                onSlotClick={(ymd, e) => laneClick(e, ymd, null)}
                onBooking={(b) => canEdit && setEditing(b)}
                onDropBooking={(e, ymd) => dropMove(e, ymd, null, false)} clockedOn={clockedOn} />
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
function DayGrid({ bookings, techs, date, grid, capacity, canEdit, canEditCapacity, onSetCapacity, onLaneClick, onBooking, onDropBooking, showUnassigned, canReorder, onReorder, onResize, clockedOn }: {
  bookings: BookingRow[]; techs: Tech[]; date: string; grid: GridCfg
  capacity: Record<string, number>; canEdit: boolean; canEditCapacity: boolean; onSetCapacity: (ext: string) => void
  onLaneClick: (e: React.MouseEvent<HTMLDivElement>, ymd: string, techExt: string | null) => void
  onBooking: (b: BookingRow) => void
  onDropBooking: (e: React.DragEvent<HTMLDivElement>, techExt: string | null) => void
  showUnassigned: boolean
  canReorder: boolean
  onReorder: (codes: string[]) => void
  onResize: (b: BookingRow, endIso: string) => void
  clockedOn: Set<string>
}) {
  // "Unassigned" lane catches bookings with no technician (hidden when filtered to a tech).
  const lanes: Tech[] = showUnassigned ? [{ ext: '', name: 'Unassigned' }, ...techs] : [...techs]
  const byLane = (ext: string) => bookings.filter(b => (b.technician_ext || '') === ext)
  // Live drop hint: which lane + the time the booking would land at.
  const [dropHint, setDropHint] = useState<{ ext: string; top: number; label: string } | null>(null)
  const [hoverExt, setHoverExt] = useState<string | null>(null)
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
        <div style={{ position: 'relative', height: grid.gridPx }}>
          {grid.hourMarks.map(m => (
            <div key={m} style={{ position: 'absolute', top: (m - grid.startMin) / SLOT_MIN * SLOT_PX - 6, right: 6, fontSize: 10, color: T.text3, fontFamily: 'monospace' }}>{pad(Math.floor(m / 60))}:00</div>
          ))}
        </div>
      </div>
      {/* lanes */}
      {lanes.map(lane => {
        const laneBookings = byLane(lane.ext)
        const booked = laneBookings.reduce((s, b) => s + segmentHours(b, date, grid), 0)
        const cap = lane.ext ? (capacity[lane.ext] ?? 8) : 0
        const pct = cap > 0 ? Math.min(100, (booked / cap) * 100) : 0
        const over = cap > 0 && booked > cap
        const barColor = over ? T.red : pct > 80 ? T.amber : T.green
        const laneKey = lane.ext || '__unassigned'
        const hov = hoverExt === laneKey
        const laneColor = lane.color || T.blue
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
              onMouseEnter={() => setHoverExt(laneKey)} onMouseLeave={() => setHoverExt(h => h === laneKey ? null : h)}
              onDragOver={(e) => { e.preventDefault(); const rect = e.currentTarget.getBoundingClientRect(); const slot = Math.max(0, Math.floor((e.clientY - rect.top) / SLOT_PX)); setDropHint({ ext: lane.ext || '', top: slot * SLOT_PX, label: minsToHHMM(grid.startMin + slot * SLOT_MIN) }) }}
              onDrop={(e) => { setDropHint(null); onDropBooking(e, lane.ext || null) }}
              style={{ position: 'relative', height: grid.gridPx, cursor: 'copy', borderLeft: `3px solid ${over ? T.red : hov ? laneColor : 'transparent'}`, background: over ? (hov ? 'rgba(240,78,78,0.10)' : 'rgba(240,78,78,0.04)') : (hov ? `${laneColor}14` : 'transparent'), transition: 'background 0.12s ease, border-color 0.12s ease' }}>
              {grid.hourMarks.map(m => (
                <div key={m} style={{ position: 'absolute', top: (m - grid.startMin) / SLOT_MIN * SLOT_PX, left: 0, right: 0, borderTop: `1px solid ${T.border}` }} />
              ))}
              {laneBookings.map(b => { const seg = daySegment(b, date, grid); return seg ? <BookingBlock key={b.id} b={b} seg={seg} draggable={canEdit} onClick={() => onBooking(b)} onDragEnd={() => setDropHint(null)} resizable={canEdit} onResize={(iso) => onResize(b, iso)} clocked={clockedOn.has(b.id)} /> : null })}
              {dropHint && dropHint.ext === (lane.ext || '') && (
                <div style={{ position: 'absolute', top: dropHint.top, left: 0, right: 0, borderTop: `2px solid ${T.accent}`, pointerEvents: 'none', zIndex: 6 }}>
                  <span style={{ position: 'absolute', top: -9, left: 2, background: T.accent, color: '#fff', fontSize: 10, fontWeight: 700, padding: '1px 5px', borderRadius: 3, fontFamily: 'monospace' }}>{dropHint.label}</span>
                </div>
              )}
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
function WeekGrid({ bookings, days, grid, canEdit, onDayClick, onSlotClick, onBooking, onDropBooking, clockedOn }: {
  bookings: BookingRow[]; days: string[]; grid: GridCfg; canEdit: boolean
  onDayClick: (ymd: string) => void
  onSlotClick: (ymd: string, e: React.MouseEvent<HTMLDivElement>) => void
  onBooking: (b: BookingRow) => void
  onDropBooking: (e: React.DragEvent<HTMLDivElement>, ymd: string) => void
  clockedOn: Set<string>
}) {
  const today = ymdBrisbane(new Date())
  const [dropHint, setDropHint] = useState<{ ymd: string; top: number; label: string } | null>(null)
  return (
    <div style={{ display: 'flex', minWidth: 'fit-content', border: `1px solid ${T.border}`, borderRadius: 8, overflow: 'hidden', background: T.bg2 }}>
      <div style={{ width: 56, flexShrink: 0, borderRight: `1px solid ${T.border}` }}>
        <div style={{ height: 32, borderBottom: `1px solid ${T.border}` }} />
        <div style={{ position: 'relative', height: grid.gridPx }}>
          {grid.hourMarks.map(m => (
            <div key={m} style={{ position: 'absolute', top: (m - grid.startMin) / SLOT_MIN * SLOT_PX - 6, right: 6, fontSize: 10, color: T.text3, fontFamily: 'monospace' }}>{pad(Math.floor(m / 60))}:00</div>
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
            onDragOver={(e) => { e.preventDefault(); const rect = e.currentTarget.getBoundingClientRect(); const slot = Math.max(0, Math.floor((e.clientY - rect.top) / SLOT_PX)); setDropHint({ ymd, top: slot * SLOT_PX, label: minsToHHMM(grid.startMin + slot * SLOT_MIN) }) }}
            onDrop={(e) => { setDropHint(null); onDropBooking(e, ymd) }}
            style={{ position: 'relative', height: grid.gridPx, cursor: 'copy' }}>
            {grid.hourMarks.map(m => (
              <div key={m} style={{ position: 'absolute', top: (m - grid.startMin) / SLOT_MIN * SLOT_PX, left: 0, right: 0, borderTop: `1px solid ${T.border}` }} />
            ))}
            {bookings.map(b => { const seg = daySegment(b, ymd, grid); return seg ? <BookingBlock key={b.id} b={b} seg={seg} draggable={canEdit} onClick={() => onBooking(b)} onDragEnd={() => setDropHint(null)} showTech clocked={clockedOn.has(b.id)} /> : null })}
            {dropHint && dropHint.ymd === ymd && (
              <div style={{ position: 'absolute', top: dropHint.top, left: 0, right: 0, borderTop: `2px solid ${T.accent}`, pointerEvents: 'none', zIndex: 6 }}>
                <span style={{ position: 'absolute', top: -9, left: 2, background: T.accent, color: '#fff', fontSize: 10, fontWeight: 700, padding: '1px 5px', borderRadius: 3, fontFamily: 'monospace' }}>{dropHint.label}</span>
              </div>
            )}
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
  const [endYmd, setEndYmd] = useState<string>(initial.ends_at ? bneYmd(initial.ends_at) : (initial.starts_at ? bneYmd(initial.starts_at) : ymdBrisbane(new Date())))
  const [finish, setFinish] = useState<string>(initial.ends_at ? bneTimeStr(initial.ends_at) : hhmmPlus(initial.starts_at ? bneTimeStr(initial.starts_at) : '09:00', 60))
  const [pickupYmd, setPickupYmd] = useState<string>(initial.pickup_at ? bneYmd(initial.pickup_at) : '')
  const [pickupTime, setPickupTime] = useState<string>(initial.pickup_at ? bneTimeStr(initial.pickup_at) : '')
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
  const [showSplit, setShowSplit] = useState(false)
  // Vehicle models + the selected vehicle's model — used to filter the job-type
  // picker so only job types assigned to this vehicle's model are offered.
  const [models, setModels] = useState<Array<{ id: string; name: string }>>([])
  const [vehicleModelId, setVehicleModelId] = useState<string | null>(null)

  // Imported job-type presets. Booking can stack multiple — each one's
  // description appends to the booking's description, and on save the lines
  // from each picked preset get applied in sequence.
  const [presets, setPresets] = useState<Array<{ id: string; name: string; description: string | null; default_duration_min: number | null; model_ids: string[] }>>([])
  const [applyPresetIds, setApplyPresetIds] = useState<string[]>([])
  const [presetToAdd, setPresetToAdd] = useState<string>('')
  useEffect(() => {
    let alive = true
    fetch('/api/workshop/job-types').then(r => r.json()).then(d => {
      if (!alive) return
      setPresets((d.jobTypes || []).filter((t: any) => t.active).map((t: any) => ({ id: t.id, name: t.name, description: t.description, default_duration_min: t.default_duration_min, model_ids: t.model_ids || [] })).sort((a: any, b: any) => a.name.localeCompare(b.name)))
    }).catch(() => undefined)
    fetch('/api/workshop/vehicle-models').then(r => r.json()).then(d => { if (alive) setModels(d.models || []) }).catch(() => undefined)
    return () => { alive = false }
  }, [])
  // Resolve the selected vehicle's model so the job-type list can filter to it.
  useEffect(() => {
    if (!vehicle?.id) { setVehicleModelId(null); return }
    let alive = true
    fetch(`/api/workshop/vehicles?id=${vehicle.id}`).then(r => r.json()).then(d => { if (alive) setVehicleModelId(d.vehicle?.model_id || null) }).catch(() => undefined)
    return () => { alive = false }
  }, [vehicle?.id])
  function addPreset(id: string) {
    if (!id) return
    if (applyPresetIds.includes(id)) { setPresetToAdd(''); return }  // already added
    setApplyPresetIds(prev => [...prev, id])
    setPresetToAdd('')
    const p = presets.find(x => x.id === id)
    if (!p?.description) return
    const jt = String(p.description).trim()
    setDescription(prev => {
      const cur = (prev || '').trim()
      if (!cur) return jt
      if (cur.includes(jt)) return cur
      return `${cur}\n\n${jt}`
    })
  }
  function removePreset(id: string) {
    setApplyPresetIds(prev => prev.filter(x => x !== id))
    // We deliberately DON'T strip the description text — the user may have
    // edited it. If they want it gone they can do so manually.
  }

  async function save() {
    setSaving(true); setErr('')
    const startIso = isoFromBne(ymd, time)
    const endIso = isoFromBne(endYmd, finish)
    if (new Date(endIso).getTime() <= new Date(startIso).getTime()) { setErr('The end (date + finish time) must be after the start.'); setSaving(false); return }
    const pickupIso = pickupTime ? isoFromBne(pickupYmd || endYmd, pickupTime) : null
    const payload: any = {
      starts_at: startIso, ends_at: endIso, pickup_at: pickupIso,
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
      // If the user added job-type presets, copy each one's labour + parts
      // lines now that we have a booking id. Description was already saved
      // above so pass lines_only to avoid touching it again.
      if (applyPresetIds.length > 0) {
        const bookingId = isNew ? (d.id || d.booking?.id) : initial.id
        if (bookingId) {
          for (const presetId of applyPresetIds) {
            await fetch(`/api/workshop/job-types/${presetId}/apply`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ booking_id: bookingId, lines_only: true }),
            }).catch(() => undefined)
          }
        }
      }
      onSaved()
    } catch (e: any) { setErr(e?.message || 'Save failed') } finally { setSaving(false) }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000, backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
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
          {models.length > 0 && (
            <Field label="Vehicle model (filters the job types below)">
              <select value={vehicleModelId || ''} disabled={!canEdit} onChange={async e => {
                const mid = e.target.value || null
                setVehicleModelId(mid)
                if (vehicle?.id) { try { await fetch(`/api/workshop/vehicles?id=${vehicle.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model_id: mid }) }) } catch { /* non-fatal */ } }
              }} style={inp} title="Pick the vehicle model to limit the job-type list to jobs for that model. If a vehicle is selected this also tags it.">
                <option value="">— All job types —</option>
                {models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            </Field>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <Field label="Start date"><input type="date" value={ymd} disabled={!canEdit} onChange={e => { const v = e.target.value; setYmd(v); if (endYmd < v) setEndYmd(v) }} style={inp} /></Field>
            <Field label="Start time"><input type="time" value={time} disabled={!canEdit} step={900} onChange={e => setTime(e.target.value)} style={inp} /></Field>
            <Field label="End date"><input type="date" value={endYmd} disabled={!canEdit} min={ymd} onChange={e => setEndYmd(e.target.value)} style={inp} /></Field>
            <Field label="Finish time"><input type="time" value={finish} disabled={!canEdit} step={900} onChange={e => setFinish(e.target.value)} style={inp} /></Field>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <Field label="Pick-up date"><input type="date" value={pickupYmd} disabled={!canEdit} onChange={e => setPickupYmd(e.target.value)} style={inp} /></Field>
            <Field label="Pick-up time"><input type="time" value={pickupTime} disabled={!canEdit} step={900} onChange={e => setPickupTime(e.target.value)} style={inp} /></Field>
          </div>
          <div style={{ fontSize: 10, color: T.text3, marginTop: -4 }}>Pick-up = customer collection time (job card only — doesn’t change the diary slot).</div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <Field label="Technician">
              <select value={tech} disabled={!canEdit} onChange={e => setTech(e.target.value)} style={inp}>
                <option value="">Unassigned</option>
                {techs.map(t => <option key={t.ext} value={t.ext}>{t.name}{t.role ? ` · ${t.role}` : ''}</option>)}
              </select>
            </Field>
            <Field label="Bay"><input value={bay} disabled={!canEdit} onChange={e => setBay(e.target.value)} placeholder="e.g. Hoist 1" style={inp} /></Field>
          </div>

          {presets.length > 0 && (
            <Field label={`Apply job types (${applyPresetIds.length} added — fills description + lines)`}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {applyPresetIds.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {applyPresetIds.map(id => {
                      const p = presets.find(x => x.id === id)
                      return (
                        <span key={id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 8px 4px 10px', background: T.bg3, border: `1px solid ${T.amber}55`, borderRadius: 4, fontSize: 11, color: T.text2 }}>
                          {p?.name || id}
                          {canEdit && <button onClick={() => removePreset(id)} title="Remove this preset" style={{ background: 'none', border: 'none', color: T.text3, cursor: 'pointer', fontSize: 13, padding: 0, lineHeight: 1 }}>×</button>}
                        </span>
                      )
                    })}
                  </div>
                )}
                <select value={presetToAdd} disabled={!canEdit} onChange={e => addPreset(e.target.value)} style={inp} title="Add a preset — its description appends to this booking and its lines get applied on save">
                  <option value="">+ Add job type…</option>
                  {(vehicleModelId ? presets.filter(p => (p.model_ids || []).includes(vehicleModelId)) : presets).filter(p => !applyPresetIds.includes(p.id)).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
            </Field>
          )}
          <Field label="Description (work to do — shows on job card + invoice)">
            <textarea value={description} disabled={!canEdit} onChange={e => setDescription(e.target.value)} rows={4} placeholder="Work to be done…" style={{ ...inp, resize: 'vertical', whiteSpace: 'pre-wrap', fontFamily: 'inherit' }} />
          </Field>

          <Field label="Status">
            <select value={status} disabled={!canEdit} onChange={e => setStatus(e.target.value as BookingStatus)} style={inp}>
              {BOOKING_STATUSES.map(s => <option key={s} value={s}>{BOOKING_STATUS_META[s].label}</option>)}
            </select>
          </Field>

          <Field label="Notes"><textarea value={notes} disabled={!canEdit} onChange={e => setNotes(e.target.value)} rows={2} style={{ ...inp, resize: 'vertical' }} /></Field>

          {!isNew && canEdit && initial.starts_at && initial.ends_at && (
            <div style={{ paddingTop: 12, borderTop: `1px solid ${T.border}` }}>
              <div style={{ fontSize: 11, color: T.text3, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Split job</div>
              <button onClick={() => setShowSplit(true)} style={{ ...btn(false), padding: '7px 14px' }} title="Split this job into parts across technicians / time">⑂ Split across techs…</button>
            </div>
          )}
          {showSplit && initial.id && initial.starts_at && initial.ends_at && (
            <SplitJobModal
              booking={{ id: initial.id, starts_at: initial.starts_at, ends_at: initial.ends_at, technician_ext: initial.technician_ext || null, description: initial.description || null }}
              techs={techs}
              onClose={() => setShowSplit(false)}
              onSaved={() => { setShowSplit(false); onSaved(); onClose() }}
            />
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

// ── Split-job modal (multi-segment across technicians / time) ───────────
function SplitJobModal({ booking, techs, onClose, onSaved }: {
  booking: { id: string; starts_at: string; ends_at: string; technician_ext: string | null; description: string | null }
  techs: Tech[]; onClose: () => void; onSaved: () => void
}) {
  const startMs = new Date(booking.starts_at).getTime()
  const totalMins = Math.max(15, Math.round((new Date(booking.ends_at).getTime() - startMs) / 60000))
  const COLORS = [T.blue, T.teal, T.green, T.amber, T.purple, T.red]
  type Seg = { tech: string; mins: number; desc: string }
  const [segs, setSegs] = useState<Seg[]>(() => {
    const a = Math.min(Math.max(15, Math.round(totalMins / 2 / 15) * 15), totalMins - 15)
    return [
      { tech: booking.technician_ext || '', mins: a, desc: booking.description || '' },
      { tech: booking.technician_ext || '', mins: totalMins - a, desc: booking.description || '' },
    ]
  })
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  const allocated = segs.reduce((s, x) => s + x.mins, 0)
  const remaining = totalMins - allocated
  const balanced = remaining === 0

  const fmtHrs = (m: number) => { const a = Math.abs(m); if (a < 60) return `${a}m`; const h = Math.floor(a / 60), mm = a % 60; return mm ? `${h}h ${mm}m` : `${h}h` }
  const clock = (ms: number) => new Date(ms).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Australia/Brisbane' })
  const segStartMs = (i: number) => { let t = startMs; for (let k = 0; k < i; k++) t += segs[k].mins * 60000; return t }
  const setSeg = (i: number, patch: Partial<Seg>) => setSegs(prev => prev.map((s, idx) => idx === i ? { ...s, ...patch } : s))
  function bump(i: number, delta: number) {
    setSegs(prev => {
      const a = prev.map(s => ({ ...s }))
      if (delta < 0) { if (a[i].mins + delta < 15) return prev; a[i].mins += delta; if (i + 1 < a.length) a[i + 1].mins -= delta }
      else { if (i + 1 < a.length && a[i + 1].mins - delta >= 15) { a[i].mins += delta; a[i + 1].mins -= delta } else if (totalMins - a.reduce((s, x) => s + x.mins, 0) >= delta) { a[i].mins += delta } else return prev }
      return a
    })
  }
  function addPart() { setSegs(prev => { if (prev.length >= 6) return prev; const a = prev.map(s => ({ ...s })); const last = a[a.length - 1]; const take = Math.max(15, Math.round(last.mins / 2 / 15) * 15); if (last.mins - take < 15) return prev; last.mins -= take; a.push({ tech: last.tech, mins: take, desc: last.desc }); return a }) }
  function removePart(i: number) { setSegs(prev => { if (prev.length <= 2) return prev; const a = prev.map(s => ({ ...s })); const [rm] = a.splice(i, 1); const t = Math.min(i, a.length - 1); a[t].mins += rm.mins; return a }) }
  function autoFill() { if (remaining === 0) return; setSegs(prev => { const a = prev.map(s => ({ ...s })); a[a.length - 1].mins += remaining; return a }) }

  async function save() {
    if (!balanced) { setErr(`Hours don't add up — ${remaining > 0 ? fmtHrs(remaining) + ' remaining' : fmtHrs(remaining) + ' over'}`); return }
    setSaving(true); setErr('')
    const segments = segs.map((s, i) => {
      const sMs = segStartMs(i)
      return { technician_ext: s.tech || null, starts_at: new Date(sMs).toISOString(), ends_at: new Date(sMs + s.mins * 60000).toISOString(), description: s.desc || null }
    })
    try {
      const r = await fetch(`/api/workshop/bookings/${booking.id}/split-multi`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ segments }) })
      const d = await r.json()
      if (!r.ok) { setErr(d.error || 'Split failed'); return }
      onSaved()
    } catch (e: any) { setErr(e?.message || 'Split failed') } finally { setSaving(false) }
  }

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 1100, background: 'rgba(8,10,13,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div onClick={e => e.stopPropagation()} style={{ width: 'min(560px,100%)', maxHeight: '90vh', overflowY: 'auto', background: T.bg2, border: `1px solid ${T.border2}`, borderRadius: 12 }}>
        <div style={{ padding: '14px 18px', borderBottom: `1px solid ${T.border}`, display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 700 }}>⑂ Split job</div>
            <div style={{ fontSize: 11, color: T.text3 }}>{clock(startMs)} – {clock(startMs + totalMins * 60000)} · {fmtHrs(totalMins)} total</div>
          </div>
          <span style={{ fontSize: 10, fontWeight: 700, padding: '4px 9px', borderRadius: 6, background: balanced ? `${T.green}22` : `${T.red}22`, color: balanced ? T.green : T.red, border: `1px solid ${balanced ? T.green : T.red}55` }}>
            {balanced ? '✓ Balanced' : remaining > 0 ? `+${fmtHrs(remaining)} left` : `-${fmtHrs(remaining)} over`}
          </span>
          {!balanced && remaining > 0 && <button onClick={autoFill} style={{ ...btn(false), padding: '4px 8px', fontSize: 10 }}>Auto-fill →</button>}
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: T.text3, fontSize: 16, cursor: 'pointer' }}>✕</button>
        </div>
        <div style={{ display: 'flex', height: 18, margin: '12px 18px 4px', borderRadius: 4, overflow: 'hidden', background: T.bg3 }}>
          {segs.map((s, i) => <div key={i} style={{ flex: s.mins, background: COLORS[i % COLORS.length], display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 8, fontWeight: 700 }}>{s.mins / totalMins > 0.12 ? fmtHrs(s.mins) : ''}</div>)}
        </div>
        <div style={{ padding: '8px 18px 0' }}>
          {segs.map((s, i) => { const sMs = segStartMs(i); const c = COLORS[i % COLORS.length]; return (
            <div key={i} style={{ background: T.bg3, borderRadius: 8, padding: 12, marginBottom: 10, borderLeft: `3px solid ${c}` }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span style={{ fontSize: 9, fontWeight: 800, color: c, background: `${c}22`, padding: '2px 7px', borderRadius: 4 }}>PART {i + 1}</span>
                <span style={{ fontSize: 11, fontFamily: 'monospace', color: T.text2 }}>{clock(sMs)} → {clock(sMs + s.mins * 60000)}</span>
                <span style={{ flex: 1 }} />
                {segs.length > 2 && <button onClick={() => removePart(i)} style={{ background: 'none', border: 'none', color: T.red, cursor: 'pointer', fontSize: 13 }}>✕</button>}
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
                <select value={s.tech} onChange={e => setSeg(i, { tech: e.target.value })} style={{ ...inp, flex: 1 }}>
                  <option value="">Unassigned</option>
                  {techs.map(t => <option key={t.ext} value={t.ext}>{t.name}{t.role ? ` · ${t.role}` : ''}</option>)}
                </select>
                <button onClick={() => bump(i, -15)} style={{ ...btn(false), padding: '5px 10px' }}>−</button>
                <span style={{ width: 56, textAlign: 'center', fontSize: 12, fontWeight: 700, color: c }}>{fmtHrs(s.mins)}</span>
                <button onClick={() => bump(i, 15)} style={{ ...btn(false), padding: '5px 10px' }}>+</button>
              </div>
              <input value={s.desc} onChange={e => setSeg(i, { desc: e.target.value })} placeholder="Description" style={inp} />
            </div>
          )})}
          {segs.length < 6 && <button onClick={addPart} style={{ ...btn(false), width: '100%', padding: 8, borderStyle: 'dashed' }}>+ Add part</button>}
        </div>
        {err && <div style={{ color: T.red, fontSize: 12, padding: '8px 18px' }}>{err}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: 14, borderTop: `1px solid ${T.border}` }}>
          <button onClick={onClose} style={{ ...btn(false), padding: '7px 14px' }}>Cancel</button>
          <button onClick={save} disabled={saving || !balanced} style={{ ...btn(true), padding: '7px 16px', background: balanced ? T.accent : T.bg3, color: '#fff', borderColor: balanced ? T.accent : T.border, opacity: saving ? 0.7 : 1, cursor: (saving || !balanced) ? 'default' : 'pointer' }}>{saving ? 'Splitting…' : 'Split job'}</button>
        </div>
      </div>
    </div>
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

  // Vehicle auto-populate: as soon as a customer is chosen, pull their vehicles
  // and auto-select when there's exactly one (mirrors autodesk_pro's "load from
  // card file"); otherwise pre-load the list so it's ready on focus.
  useEffect(() => {
    if (kind !== 'vehicle' || !customerId || value) return
    let alive = true
    fetch(`/api/workshop/vehicles?customer_id=${customerId}`).then(r => r.json()).then(d => {
      if (!alive) return
      const vs = d.vehicles || []
      if (vs.length === 1) onPick({ id: vs[0].id, label: vehicleLabel(vs[0]) })
      else setResults(vs.map((v: any) => ({ id: v.id, label: vehicleLabel(v) })))
    }).catch(() => undefined)
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, customerId, value])

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
