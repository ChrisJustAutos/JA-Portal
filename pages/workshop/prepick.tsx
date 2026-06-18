// pages/workshop/prepick.tsx
// Pre Pick — for all jobs in a date range (pulled LIVE from MechanicDesk), sum
// the parts they need, compare to current MD stock, and show green/orange/red
// tiles (like the B2B stock wall) plus a filterable, exportable list of what to
// pick / order. The snapshot is built by a GitHub Action worker; this screen
// reads the latest snapshot and can kick a fresh pull. Gated view:diary.

import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import Head from 'next/head'
import PortalTopBar from '../../lib/PortalTopBar'
import InventoryTabs from '../../components/InventoryTabs'
import WorkshopTabs from '../../components/WorkshopTabs'
import { requirePageAuth } from '../../lib/authServer'
import type { PortalUserSSR } from '../../lib/authServer'
import { T, SkeletonRows } from '../../components/ui'
import { useToast } from '../../components/ui/Feedback'

interface PrePickItem {
  id: string; md_stock_id: number | null; sku: string; part_name: string; brand: string | null; supplier: string | null
  location: string | null; buy_price: number | null; alert_qty: number | null
  to_pick: number; current_stock: number; allocated: number; on_order: number; on_order_detail: any[] | null
}
interface PrePickJob {
  md_job_id: number; job_number: string | null; customer_name: string | null; phone: string | null
  vehicle: string | null; rego: string | null; status: string | null; description: string | null
  scheduled_at: string | null; parts_count: number; parts_qty: number
}
interface JobItem { md_job_id: number; md_stock_id: number | null; sku: string; name: string; quantity: number }
type Status = 'green' | 'orange' | 'red'
type Filter = 'all' | 'green' | 'orange' | 'red' | 'toorder'
type BottomView = 'parts' | 'jobs'
type RunStatus = 'none' | 'pending' | 'running' | 'done' | 'error'

function ymd(d: Date): string { const p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` }
function addDays(d: Date, n: number): Date { const x = new Date(d); x.setDate(x.getDate() + n); return x }
const money = (n: number | null) => (n == null ? '—' : `$${(Number(n) || 0).toFixed(2)}`)
function ago(iso: string | null): string {
  if (!iso) return 'never'
  const t = new Date(iso).getTime(); if (!isFinite(t)) return 'never'
  const mins = Math.round((Date.now() - t) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hrs = Math.round(mins / 60); if (hrs < 24) return `${hrs} hr${hrs === 1 ? '' : 's'} ago`
  const days = Math.round(hrs / 24); return `${days} day${days === 1 ? '' : 's'} ago`
}
function fmtJobDate(iso: string | null): string {
  if (!iso) return '—'
  try { return new Date(iso).toLocaleString('en-AU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) } catch { return iso }
}
const num = (n: number) => String(Math.round(n * 100) / 100)

export default function PrePickPage({ user }: { user: PortalUserSSR }) {
  const toast = useToast()
  const today = new Date()
  // The picker range drives the NEXT pull from MechanicDesk.
  const [from, setFrom] = useState(ymd(today))
  const [to, setTo] = useState(ymd(addDays(today, 14)))
  const [lowThreshold, setLowThreshold] = useState(5)
  const [items, setItems] = useState<PrePickItem[]>([])
  const [jobs, setJobs] = useState<PrePickJob[]>([])
  const [jobItems, setJobItems] = useState<JobItem[]>([])
  const [view, setView] = useState<BottomView>('parts')
  const [drillStock, setDrillStock] = useState<number | null>(null)
  const [drillPO, setDrillPO] = useState<number | null>(null)
  const [expandedJobs, setExpandedJobs] = useState<Set<number>>(new Set())
  const [jobsCount, setJobsCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [pdfBusy, setPdfBusy] = useState(false)
  // Snapshot metadata (the range/time the displayed data was actually pulled for).
  const [snapFrom, setSnapFrom] = useState<string | null>(null)
  const [snapTo, setSnapTo] = useState<string | null>(null)
  const [syncedAt, setSyncedAt] = useState<string | null>(null)
  const [runStatus, setRunStatus] = useState<RunStatus>('none')
  const [runError, setRunError] = useState<string | null>(null)
  // Live pull (in-flight) state — drives the loading overlay + polling.
  const [inFlight, setInFlight] = useState(false)
  const [pendingFrom, setPendingFrom] = useState<string | null>(null)
  const [pendingTo, setPendingTo] = useState<string | null>(null)
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const didInitRange = useRef(false)
  const prevInFlight = useRef(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/workshop/prepick')
      const d = await r.json()
      if (r.ok) {
        setItems(Array.isArray(d.items) ? d.items : [])
        setJobs(Array.isArray(d.jobs) ? d.jobs : [])
        setJobItems(Array.isArray(d.job_items) ? d.job_items : [])
        setJobsCount(Number(d.jobs_count) || 0)
        setSnapFrom(d.from || null); setSnapTo(d.to || null)
        setSyncedAt(d.synced_at || null)
        setRunStatus((d.status as RunStatus) || 'none')
        setRunError(d.error || null)
        const flying = !!d.in_flight
        setInFlight(flying)
        setPendingFrom(d.pending_from || null); setPendingTo(d.pending_to || null)
        if (flying && d.started_at) { const t = new Date(d.started_at).getTime(); if (isFinite(t)) setStartedAt(t) }
        // On first load, default the picker to the last-pulled range.
        if (!didInitRange.current && d.from && d.to) {
          setFrom(d.from); setTo(d.to); didInitRange.current = true
        }
        // Completion: a pull that was in flight just landed.
        if (prevInFlight.current && !flying) {
          if (d.status === 'done') toast('Pre Pick updated from MechanicDesk', 'success')
          else if (d.status === 'error') toast('MechanicDesk pull failed — see banner', 'error')
        }
        prevInFlight.current = flying
        return flying
      }
    } catch { /* keep prior */ } finally { setLoading(false) }
    return false
  }, [toast])
  useEffect(() => { load() }, [load])

  // Poll the worker via the snapshot API while a pull is in flight.
  useEffect(() => {
    if (!inFlight) { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null } return }
    if (!pollRef.current) pollRef.current = setInterval(load, 4000)
    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null } }
  }, [inFlight, load])
  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current) }, [])

  // Tick the elapsed-time readout while pulling.
  useEffect(() => {
    if (!inFlight || !startedAt) { setElapsed(0); return }
    const tick = () => setElapsed(Math.max(0, Math.round((Date.now() - startedAt) / 1000)))
    tick(); const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [inFlight, startedAt])

  const refresh = useCallback(async () => {
    if (!from || !to) return
    if (from > to) { toast('"From" date must be on or before "To" date', 'error'); return }
    try {
      const r = await fetch('/api/workshop/prepick/refresh', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to }),
      })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) { toast(d.error || 'Could not start the pull', 'error'); return }
      toast('Pulling from MechanicDesk — this takes ~1–2 minutes.', 'info')
      // The refresh endpoint already created the pending run row, so enter the
      // loading state immediately; polling will track it through to done.
      setInFlight(true); prevInFlight.current = true
      setStartedAt(Date.now()); setPendingFrom(from); setPendingTo(to); setRunStatus('pending')
      setTimeout(load, 1500)
    } catch { toast('Could not start the pull', 'error') }
  }, [from, to, load, toast])

  const remaining = (it: PrePickItem) => Math.round((it.current_stock - it.to_pick) * 100) / 100
  // What to order nets off stock already incoming on open POs.
  const toOrder = (it: PrePickItem) => Math.max(0, Math.round((it.to_pick - it.current_stock - (it.on_order || 0)) * 100) / 100)
  const statusOf = useCallback((it: PrePickItem): Status => {
    const rem = it.current_stock - it.to_pick
    if (rem <= 0) return 'red'
    const orange = (it.alert_qty && it.alert_qty > 0) ? it.alert_qty : lowThreshold
    if (rem <= orange) return 'orange'
    return 'green'
  }, [lowThreshold])
  const colourOf = (s: Status) => s === 'red' ? T.red : s === 'orange' ? T.amber : T.green

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return items.filter(it => {
      if (needle && !(`${it.sku} ${it.part_name} ${it.brand || ''} ${it.supplier || ''}`.toLowerCase().includes(needle))) return false
      if (filter === 'all') return true
      if (filter === 'toorder') return toOrder(it) > 0
      return statusOf(it) === filter
    })
  }, [items, q, filter, statusOf])

  const counts = useMemo(() => {
    let green = 0, orange = 0, red = 0, orderCount = 0, orderValue = 0
    for (const it of items) {
      const s = statusOf(it)
      if (s === 'green') green++; else if (s === 'orange') orange++; else red++
      const ord = toOrder(it)
      if (ord > 0) { orderCount++; orderValue += ord * (it.buy_price || 0) }
    }
    return { green, orange, red, orderCount, orderValue: Math.round(orderValue * 100) / 100 }
  }, [items, statusOf])

  // ── Job ↔ part lookups (for the Jobs view + drill-down) ──────────────
  const itemByStock = useMemo(() => {
    const m = new Map<number, PrePickItem>()
    for (const it of items) if (it.md_stock_id != null) m.set(it.md_stock_id, it)
    return m
  }, [items])
  const jobsById = useMemo(() => {
    const m = new Map<number, PrePickJob>()
    for (const j of jobs) m.set(j.md_job_id, j)
    return m
  }, [jobs])
  const itemsByJob = useMemo(() => {
    const m = new Map<number, JobItem[]>()
    for (const ji of jobItems) { const a = m.get(ji.md_job_id) || []; a.push(ji); m.set(ji.md_job_id, a) }
    for (const a of Array.from(m.values())) a.sort((x, y) => y.quantity - x.quantity)
    return m
  }, [jobItems])
  // For a given stock id: the jobs needing it (+ qty on each).
  const jobsForStock = useCallback((stockId: number) => {
    const rows = jobItems.filter(ji => ji.md_stock_id === stockId)
    return rows.map(ji => ({ qty: ji.quantity, job: jobsById.get(ji.md_job_id) || null, md_job_id: ji.md_job_id }))
      .sort((a, b) => String(a.job?.scheduled_at || '').localeCompare(String(b.job?.scheduled_at || '')))
  }, [jobItems, jobsById])

  const filteredJobs = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const list = needle
      ? jobs.filter(j => `${j.job_number || ''} ${j.customer_name || ''} ${j.vehicle || ''} ${j.rego || ''} ${j.description || ''}`.toLowerCase().includes(needle))
      : jobs
    return list
  }, [jobs, q])

  const drillItem = drillStock != null ? itemByStock.get(drillStock) : undefined
  const drillJobs = drillStock != null ? jobsForStock(drillStock) : []

  // Open-PO lines for the on-order drill-down (current_purchase_items shape may
  // vary, so pull common field names defensively).
  const poItem = drillPO != null ? itemByStock.get(drillPO) : undefined
  const poRows = (poItem?.on_order_detail || []).map((e: any) => ({
    qty: e?.quantity ?? e?.qty ?? e?.ordered_quantity ?? e?.outstanding_quantity ?? e?.purchase_quantity ?? null,
    number: e?.purchase_number ?? e?.number ?? e?.purchase?.number ?? e?.purchase_id ?? e?.purchase?.id ?? null,
    supplier: e?.supplier?.name ?? e?.supplier_name ?? (typeof e?.supplier === 'string' ? e.supplier : null) ?? e?.purchase?.supplier?.name ?? null,
    date: e?.expected_date ?? e?.eta ?? e?.due_date ?? e?.expected_delivery_date ?? e?.created_at ?? e?.purchase?.created_at ?? e?.date ?? null,
    raw: e,
  }))

  function preset(kind: 'week' | 'fortnight' | 'month') {
    const t = new Date()
    if (kind === 'week') { setFrom(ymd(t)); setTo(ymd(addDays(t, 7))) }
    else if (kind === 'fortnight') { setFrom(ymd(t)); setTo(ymd(addDays(t, 14))) }
    else { const y = t.getFullYear(), m = t.getMonth(); const last = new Date(y, m + 1, 0); setFrom(ymd(new Date(y, m, 1))); setTo(ymd(last)) }
  }

  const STOCK_ONLY_NOTE = 'In-stock items only — special-order / non-stocked parts are NOT included.'
  const esc = (v: any) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
  function downloadCsv(lines: string[], suffix: string) {
    const out = [esc(STOCK_ONLY_NOTE), '', ...lines]
    const blob = new Blob([out.join('\n')], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = `pre-pick-${suffix}-${snapFrom || from}_to_${snapTo || to}.csv`; a.click(); URL.revokeObjectURL(url)
  }

  function exportCsv() {
    if (view === 'jobs') {
      const lines = [['Job #', 'Customer', 'Description', 'Phone', 'Vehicle', 'Rego', 'Scheduled', 'Job status', 'SKU', 'Part', 'Qty', 'On hand', 'Allocated', 'Available', 'Stock status'].join(',')]
      for (const j of filteredJobs) {
        const parts = itemsByJob.get(j.md_job_id) || []
        const base = [j.job_number || j.md_job_id, j.customer_name || '', j.description || '', j.phone || '', j.vehicle || '', j.rego || '', j.scheduled_at || '', j.status || '']
        if (parts.length === 0) {
          lines.push([...base, '', '(no tracked parts)', '', '', '', '', ''].map(esc).join(','))
        } else {
          for (const p of parts) {
            const owner = p.md_stock_id != null ? itemByStock.get(p.md_stock_id) : undefined
            const st = owner ? statusOf(owner) : ''
            const stLabel = st === 'red' ? 'Out' : st === 'orange' ? 'Low' : st === 'green' ? 'OK' : ''
            const onHand = owner ? owner.current_stock : ''
            const alloc = owner ? owner.allocated : ''
            const avail = owner ? owner.current_stock - owner.allocated : ''
            lines.push([...base, p.sku || '', p.name || '', p.quantity, onHand, alloc, avail, stLabel].map(esc).join(','))
          }
        }
      }
      downloadCsv(lines, 'jobs')
      return
    }
    const lines = [['SKU', 'Part', 'Brand', 'Supplier', 'To pick', 'On hand', 'Allocated', 'Available', 'On order', 'Remaining', 'To order', 'Buy price', 'Location', 'Status'].join(',')]
    for (const it of filtered) {
      lines.push([it.sku, it.part_name, it.brand || '', it.supplier || '', it.to_pick, it.current_stock, it.allocated || 0, (it.current_stock - (it.allocated || 0)), it.on_order || 0, remaining(it), toOrder(it), it.buy_price ?? '', it.location || '', statusOf(it)].map(esc).join(','))
    }
    downloadCsv(lines, 'parts')
  }

  const filterLabel = (f: Filter) => f === 'green' ? 'OK' : f === 'orange' ? 'Low' : f === 'red' ? 'Out of stock' : f === 'toorder' ? 'To order' : 'All'

  async function exportPdf() {
    const rowCount = view === 'jobs' ? filteredJobs.length : filtered.length
    if (rowCount === 0 || pdfBusy) return
    setPdfBusy(true)
    try {
      const common = { from: snapFrom, to: snapTo, synced_at: syncedAt, jobs_count: jobsCount, low_threshold: lowThreshold, filter_label: filterLabel(filter), counts }
      const payload = view === 'jobs'
        ? {
            ...common, view: 'jobs',
            jobs: filteredJobs.map(j => ({
              job_number: j.job_number, customer_name: j.customer_name, description: j.description, vehicle: j.vehicle, rego: j.rego,
              status: j.status, scheduled_at: j.scheduled_at, parts_count: j.parts_count, parts_qty: j.parts_qty,
              parts: (itemsByJob.get(j.md_job_id) || []).map(p => {
                const owner = p.md_stock_id != null ? itemByStock.get(p.md_stock_id) : undefined
                return {
                  sku: p.sku, name: p.name, quantity: p.quantity,
                  on_hand: owner ? owner.current_stock : null,
                  allocated: owner ? owner.allocated : null,
                  available: owner ? owner.current_stock - owner.allocated : null,
                  status: owner ? statusOf(owner) : null,
                }
              }),
            })),
          }
        : {
            ...common, view: 'parts',
            items: filtered.map(it => ({
              sku: it.sku, part_name: it.part_name, supplier: it.supplier, location: it.location,
              buy_price: it.buy_price, to_pick: it.to_pick, current_stock: it.current_stock,
              allocated: it.allocated || 0, on_order: it.on_order || 0,
              remaining: remaining(it), to_order: toOrder(it), status: statusOf(it),
            })),
          }
      const r = await fetch('/api/workshop/prepick/pdf', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      if (!r.ok) { const d = await r.json().catch(() => ({})); toast(d.error || 'PDF export failed', 'error'); return }
      const blob = await r.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a'); a.href = url; a.download = `pre-pick-${view === 'jobs' ? 'jobs-' : ''}${snapFrom || from}_to_${snapTo || to}.pdf`; a.click(); URL.revokeObjectURL(url)
    } catch { toast('PDF export failed', 'error') } finally { setPdfBusy(false) }
  }

  const chip = (f: Filter, label: string, c?: string) => (
    <button onClick={() => setFilter(f)} style={{
      padding: '5px 11px', borderRadius: 6, fontSize: 12, fontWeight: filter === f ? 600 : 400, cursor: 'pointer', fontFamily: 'inherit',
      background: filter === f ? (c ? `${c}22` : `${T.accent}22`) : 'transparent', color: filter === f ? (c || T.text) : T.text2,
      border: `1px solid ${filter === f ? (c || T.accent) : T.border}`,
    }}>{label}</button>
  )
  const inputStyle: React.CSSProperties = { background: T.bg3, border: `1px solid ${T.border}`, borderRadius: 6, color: T.text, fontSize: 13, padding: '6px 9px', fontFamily: 'inherit', outline: 'none', colorScheme: 'dark' }
  const GRID = '100px 1fr 88px 54px 54px 62px 60px 62px 58px 58px 80px'
  const JOBGRID = '24px 90px 1.4fr 1.3fr 100px 120px 90px 60px'
  const head: React.CSSProperties = { fontSize: 9, color: T.text3, textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 }
  const pulling = inFlight
  const exportCount = view === 'jobs' ? filteredJobs.length : filtered.length
  const fmtElapsed = (s: number) => { const m = Math.floor(s / 60), sec = s % 60; return m > 0 ? `${m}m ${sec}s` : `${sec}s` }

  return (
    <>
      <Head><title>Pre Pick — Just Autos</title><meta name="viewport" content="width=device-width,initial-scale=1"/><meta name="robots" content="noindex,nofollow"/></Head>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden', fontFamily: "'DM Sans',system-ui,sans-serif", color: T.text }}>
        <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet"/>
        <PortalTopBar activeId="diary" lastRefresh={syncedAt ? new Date(syncedAt) : null} onRefresh={load} refreshing={loading}
          currentUserRole={user.role} currentUserVisibleTabs={user.visibleTabs} currentUserName={user.displayName} currentUserEmail={user.email} />
        <WorkshopTabs active="inventory" role={user.role} />
        <InventoryTabs active="prepick" role={user.role} />

        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: T.bg, position: 'relative' }}>
          <style>{`@keyframes ppspin{to{transform:rotate(360deg)}}`}</style>

          {/* Loading overlay while a MechanicDesk pull is in flight */}
          {pulling && (
            <div style={{ position: 'absolute', inset: 0, zIndex: 30, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <div style={{ position: 'absolute', inset: 0, background: T.bg, opacity: 0.84 }} />
              <div style={{ position: 'relative', background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 16, padding: '30px 40px', textAlign: 'center', boxShadow: '0 14px 44px rgba(0,0,0,0.32)', maxWidth: 380 }}>
                <div style={{ width: 44, height: 44, margin: '0 auto 18px', border: `3px solid ${T.border}`, borderTopColor: T.accent, borderRadius: '50%', animation: 'ppspin 0.8s linear infinite' }} />
                <div style={{ fontSize: 15, fontWeight: 600, color: T.text }}>Pulling from MechanicDesk</div>
                <div style={{ fontSize: 12.5, color: T.text2, marginTop: 7, lineHeight: 1.5 }}>
                  Reading jobs &amp; live stock{pendingFrom && pendingTo ? <> for <strong style={{ color: T.text }}>{pendingFrom}</strong> → <strong style={{ color: T.text }}>{pendingTo}</strong></> : null}.<br />
                  This usually takes 1–2 minutes.
                </div>
                <div style={{ fontSize: 12, color: T.text3, marginTop: 14, fontVariantNumeric: 'tabular-nums' }}>
                  {fmtElapsed(elapsed)} elapsed · checking every few seconds
                </div>
                <div style={{ fontSize: 11, color: T.text3, marginTop: 8 }}>The list updates automatically when it&apos;s done — you can leave this page.</div>
              </div>
            </div>
          )}

          {/* Toolbar */}
          <div style={{ background: T.bg2, borderBottom: `1px solid ${T.border}`, display: 'flex', alignItems: 'center', padding: '10px 20px', gap: 12, flexWrap: 'wrap', flexShrink: 0 }}>
            <span style={{ fontSize: 14, fontWeight: 600 }}>Pre Pick</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="date" value={from} onChange={e => setFrom(e.target.value)} style={inputStyle} />
              <span style={{ color: T.text3, fontSize: 12 }}>→</span>
              <input type="date" value={to} onChange={e => setTo(e.target.value)} style={inputStyle} />
            </div>
            <div style={{ display: 'flex', gap: 4 }}>
              <button onClick={() => preset('week')} style={{ ...inputStyle, cursor: 'pointer', padding: '6px 10px' }}>7 days</button>
              <button onClick={() => preset('fortnight')} style={{ ...inputStyle, cursor: 'pointer', padding: '6px 10px' }}>14 days</button>
              <button onClick={() => preset('month')} style={{ ...inputStyle, cursor: 'pointer', padding: '6px 10px' }}>This month</button>
            </div>
            <button onClick={refresh} disabled={pulling} style={{
              background: pulling ? T.bg3 : T.accent, color: pulling ? T.text3 : '#fff', border: 'none', borderRadius: 6,
              padding: '7px 14px', fontSize: 13, fontWeight: 600, cursor: pulling ? 'wait' : 'pointer', fontFamily: 'inherit',
            }}>{pulling ? 'Pulling from MD…' : '↻ Refresh from MechanicDesk'}</button>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: T.text2 }}>
              Low warning ≤
              <input type="number" min={0} value={lowThreshold} onChange={e => setLowThreshold(Math.max(0, Number(e.target.value) || 0))} style={{ ...inputStyle, width: 56, textAlign: 'right' }} />
            </label>
            <div style={{ flex: 1 }} />
            <span style={{ fontSize: 12, color: T.text3 }}>
              {jobsCount} job{jobsCount === 1 ? '' : 's'} · {items.length} part{items.length === 1 ? '' : 's'}
              {counts.orderCount > 0 && <span style={{ color: T.red, fontWeight: 600 }}> · {counts.orderCount} to order ({money(counts.orderValue)})</span>}
            </span>
            <button onClick={exportCsv} disabled={exportCount === 0} style={{ ...inputStyle, cursor: exportCount ? 'pointer' : 'not-allowed', opacity: exportCount ? 1 : 0.5, fontWeight: 600 }}>⬇ Export CSV</button>
            <button onClick={exportPdf} disabled={exportCount === 0 || pdfBusy} style={{ ...inputStyle, cursor: exportCount && !pdfBusy ? 'pointer' : 'not-allowed', opacity: exportCount && !pdfBusy ? 1 : 0.5, fontWeight: 600 }}>{pdfBusy ? 'Building PDF…' : `⬇ Export PDF`}</button>
          </div>

          {/* Sync status line */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 20px', background: T.bg, borderBottom: `1px solid ${T.border}`, flexShrink: 0, fontSize: 12, color: T.text3 }}>
            {pulling ? (
              <span style={{ color: T.accent, fontWeight: 600 }}>● Pulling jobs &amp; stock from MechanicDesk… (~1–2 min)</span>
            ) : runStatus === 'error' ? (
              <span style={{ color: T.red }}>⚠ Last pull failed{runError ? `: ${runError}` : ''}. Try Refresh again.</span>
            ) : syncedAt ? (
              <span>Live from MechanicDesk · pulled <strong style={{ color: T.text2 }}>{ago(syncedAt)}</strong> for jobs <strong style={{ color: T.text2 }}>{snapFrom}</strong> → <strong style={{ color: T.text2 }}>{snapTo}</strong></span>
            ) : (
              <span>No snapshot yet — pick a date range and hit <strong style={{ color: T.text2 }}>Refresh from MechanicDesk</strong>.</span>
            )}
            <div style={{ flex: 1 }} />
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 10px', borderRadius: 999, background: `${T.amber}1f`, border: `1px solid ${T.amber}59`, color: T.amber, fontSize: 11.5, fontWeight: 600, whiteSpace: 'nowrap' }}
              title="Pre Pick only counts items held in stock. Special-order / non-stocked parts are not included — order those separately.">
              ⚠ In-stock items only — no special-order parts
            </span>
          </div>

          {/* View toggle + filters */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 20px', flexWrap: 'wrap', flexShrink: 0 }}>
            {/* Parts / Jobs segmented toggle */}
            <div style={{ display: 'flex', border: `1px solid ${T.border}`, borderRadius: 7, overflow: 'hidden' }}>
              {(['parts', 'jobs'] as BottomView[]).map(v => (
                <button key={v} onClick={() => setView(v)} style={{
                  padding: '6px 14px', fontSize: 12.5, fontWeight: view === v ? 600 : 400, cursor: 'pointer', fontFamily: 'inherit', border: 'none',
                  background: view === v ? T.accent : 'transparent', color: view === v ? '#fff' : T.text2,
                }}>{v === 'parts' ? `Parts (${items.length})` : `Jobs (${jobs.length})`}</button>
              ))}
            </div>
            <input value={q} onChange={e => setQ(e.target.value)} placeholder={view === 'parts' ? 'Search SKU / part / supplier…' : 'Search job # / customer / rego…'} style={{ ...inputStyle, width: 260 }} />
            <div style={{ flex: 1 }} />
            {view === 'parts' && <>
              {chip('all', `All (${items.length})`)}
              {chip('green', `OK (${counts.green})`, T.green)}
              {chip('orange', `Low (${counts.orange})`, T.amber)}
              {chip('red', `Out (${counts.red})`, T.red)}
              {chip('toorder', `To order (${counts.orderCount})`, T.red)}
            </>}
          </div>

          <div style={{ flex: 1, overflow: 'auto', padding: '4px 20px 24px' }}>
            {loading && items.length === 0 && jobs.length === 0 ? (
              <SkeletonRows rows={6} />
            ) : items.length === 0 && jobs.length === 0 ? (
              <div style={{ padding: 48, textAlign: 'center', color: T.text3, fontSize: 13 }}>
                {pulling
                  ? 'Pulling from MechanicDesk — parts will appear here shortly.'
                  : 'No tracked parts on MechanicDesk jobs in the last pulled range. Pick a date range and hit “Refresh from MechanicDesk”. Only parts linked to a tracked MD stock item are counted (labour/freight excluded).'}
              </div>
            ) : view === 'parts' ? (
              <>
                {/* Tiles — click to see the jobs needing this part */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 12, marginBottom: 22 }}>
                  {filtered.map(it => {
                    const s = statusOf(it); const c = colourOf(s); const rem = remaining(it); const ord = toOrder(it)
                    const clickable = it.md_stock_id != null
                    return (
                      <div key={it.id} onClick={() => clickable && setDrillStock(it.md_stock_id)} title={clickable ? 'Click to see the jobs needing this part' : undefined}
                        style={{ background: `${c}14`, border: `1.5px solid ${c}66`, borderRadius: 12, padding: '14px', display: 'flex', flexDirection: 'column', minHeight: 104, cursor: clickable ? 'pointer' : 'default' }}>
                        <div style={{ fontSize: 10.5, color: T.text3, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.sku || '—'}</div>
                        <div title={it.part_name} style={{ fontSize: 12.5, color: T.text2, lineHeight: 1.3, marginTop: 2, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{it.part_name}</div>
                        <div style={{ marginTop: 'auto', display: 'flex', alignItems: 'baseline', gap: 6, paddingTop: 8 }}>
                          <span style={{ fontSize: 30, fontWeight: 700, color: c, fontVariantNumeric: 'tabular-nums' }}>{it.to_pick}</span>
                          <span style={{ fontSize: 11, color: T.text3 }}>to pick</span>
                        </div>
                        <div style={{ fontSize: 11, color: T.text3, marginTop: 2 }}>
                          {it.current_stock} on hand{it.allocated > 0 ? ` · ${it.allocated} allocated` : ''} · {rem < 0 ? <span style={{ color: T.red }}>{rem} short</span> : `${rem} left`}
                        </div>
                        {it.on_order > 0 && (
                          <div onClick={e => { if (it.md_stock_id != null) { e.stopPropagation(); setDrillPO(it.md_stock_id) } }} title="Click to see the purchase orders"
                            style={{ fontSize: 11, color: T.accent, marginTop: 2, textDecoration: 'underline', cursor: 'pointer' }}>{it.on_order} on order</div>
                        )}
                        {ord > 0 && <div style={{ fontSize: 11, fontWeight: 600, color: T.red, marginTop: 3 }}>Order {ord}</div>}
                      </div>
                    )
                  })}
                </div>

                {/* Parts list — click a row to see the jobs needing it */}
                <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 10, overflow: 'hidden' }}>
                  <div style={{ display: 'grid', gridTemplateColumns: GRID, gap: 8, padding: '9px 14px', background: T.bg3, borderBottom: `1px solid ${T.border}` }}>
                    <div style={head}>SKU</div><div style={head}>Part</div><div style={head}>Supplier</div>
                    <div style={{ ...head, textAlign: 'right' }}>To pick</div><div style={{ ...head, textAlign: 'right' }}>On hand</div>
                    <div style={{ ...head, textAlign: 'right' }}>Allocated</div>
                    <div style={{ ...head, textAlign: 'right' }}>On order</div>
                    <div style={{ ...head, textAlign: 'right' }}>Remaining</div><div style={{ ...head, textAlign: 'right' }}>To order</div>
                    <div style={{ ...head, textAlign: 'right' }}>Buy $</div><div style={head}>Location</div>
                  </div>
                  {filtered.map(it => {
                    const s = statusOf(it); const c = colourOf(s); const rem = remaining(it); const ord = toOrder(it)
                    const clickable = it.md_stock_id != null
                    return (
                      <div key={it.id} onClick={() => clickable && setDrillStock(it.md_stock_id)} title={clickable ? 'Click to see the jobs needing this part' : undefined}
                        style={{ display: 'grid', gridTemplateColumns: GRID, gap: 8, padding: '9px 14px', borderTop: `1px solid ${T.border}`, alignItems: 'center', fontSize: 12.5, cursor: clickable ? 'pointer' : 'default' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontFamily: 'monospace', fontSize: 11, color: T.text2, overflow: 'hidden' }}>
                          <span style={{ width: 8, height: 8, borderRadius: '50%', background: c, flexShrink: 0 }} />
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.sku || '—'}</span>
                        </div>
                        <div title={it.part_name} style={{ color: T.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.part_name}</div>
                        <div style={{ color: T.text3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.supplier || '—'}</div>
                        <div style={{ textAlign: 'right', fontFamily: 'monospace', fontWeight: 600 }}>{it.to_pick}</div>
                        <div style={{ textAlign: 'right', fontFamily: 'monospace', color: T.text2 }}>{it.current_stock}</div>
                        <div style={{ textAlign: 'right', fontFamily: 'monospace', color: it.allocated > 0 ? T.text2 : T.text3 }}>{it.allocated > 0 ? it.allocated : '—'}</div>
                        <div onClick={e => { if (it.on_order > 0 && it.md_stock_id != null) { e.stopPropagation(); setDrillPO(it.md_stock_id) } }}
                          title={it.on_order > 0 ? 'Click to see the purchase orders' : undefined}
                          style={{ textAlign: 'right', fontFamily: 'monospace', color: it.on_order > 0 ? T.accent : T.text3, fontWeight: it.on_order > 0 ? 600 : 400, textDecoration: it.on_order > 0 ? 'underline' : 'none', cursor: it.on_order > 0 ? 'pointer' : 'inherit' }}>{it.on_order > 0 ? it.on_order : '—'}</div>
                        <div style={{ textAlign: 'right', fontFamily: 'monospace', color: c, fontWeight: 600 }}>{rem}</div>
                        <div style={{ textAlign: 'right', fontFamily: 'monospace', color: ord > 0 ? T.red : T.text3, fontWeight: ord > 0 ? 600 : 400 }}>{ord || '—'}</div>
                        <div style={{ textAlign: 'right', fontFamily: 'monospace', color: T.text3 }}>{money(it.buy_price)}</div>
                        <div style={{ color: T.text3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.location || '—'}</div>
                      </div>
                    )
                  })}
                  {filtered.length === 0 && <div style={{ padding: 28, textAlign: 'center', color: T.text3, fontSize: 12 }}>No parts match this filter.</div>}
                </div>
              </>
            ) : (
              /* ── Jobs view — each job expands to the parts applied to it ── */
              <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 10, overflow: 'hidden' }}>
                <div style={{ display: 'grid', gridTemplateColumns: JOBGRID, gap: 8, padding: '9px 14px', background: T.bg3, borderBottom: `1px solid ${T.border}` }}>
                  <div style={head}></div><div style={head}>Job #</div><div style={head}>Customer</div><div style={head}>Vehicle</div>
                  <div style={head}>Rego</div><div style={head}>Scheduled</div><div style={head}>Status</div><div style={{ ...head, textAlign: 'right' }}>Parts</div>
                </div>
                {filteredJobs.map(j => {
                  const open = expandedJobs.has(j.md_job_id)
                  const parts = itemsByJob.get(j.md_job_id) || []
                  return (
                    <div key={j.md_job_id} style={{ borderTop: `1px solid ${T.border}` }}>
                      <div onClick={() => setExpandedJobs(prev => { const n = new Set(prev); n.has(j.md_job_id) ? n.delete(j.md_job_id) : n.add(j.md_job_id); return n })}
                        style={{ display: 'grid', gridTemplateColumns: JOBGRID, gap: 8, padding: '9px 14px', alignItems: 'center', fontSize: 12.5, cursor: 'pointer', background: open ? T.bg3 : 'transparent' }}>
                        <div style={{ color: T.text3, fontWeight: 700, fontSize: 14, textAlign: 'center', userSelect: 'none' }}>{open ? '−' : '+'}</div>
                        <div style={{ fontFamily: 'monospace', color: T.text, fontWeight: 600 }}>{j.job_number || j.md_job_id}</div>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={j.customer_name || ''}>{j.customer_name || '—'}</div>
                          {j.description && <div title={j.description} style={{ fontSize: 11, color: T.text3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 1 }}>{j.description}</div>}
                        </div>
                        <div style={{ color: T.text2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={j.vehicle || ''}>{j.vehicle || '—'}</div>
                        <div style={{ fontFamily: 'monospace', color: T.text2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{j.rego || '—'}</div>
                        <div style={{ color: T.text3 }}>{fmtJobDate(j.scheduled_at)}</div>
                        <div style={{ color: T.text3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{j.status || '—'}</div>
                        <div style={{ textAlign: 'right', fontWeight: 600, color: j.parts_count > 0 ? T.text : T.text3 }}>{j.parts_count || '—'}</div>
                      </div>
                      {open && (
                        <div style={{ padding: '4px 14px 12px 46px', background: T.bg }}>
                          {parts.length === 0 ? (
                            <div style={{ fontSize: 12, color: T.text3, padding: '6px 0' }}>No tracked parts on this job (labour/freight only).</div>
                          ) : parts.map((p, i) => {
                            const owner = p.md_stock_id != null ? itemByStock.get(p.md_stock_id) : undefined
                            const c = owner ? colourOf(statusOf(owner)) : T.text3
                            return (
                              <div key={i} onClick={() => p.md_stock_id != null && setDrillStock(p.md_stock_id)} title={p.md_stock_id != null ? 'Click to see all jobs needing this part' : undefined}
                                style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '5px 0', borderBottom: i < parts.length - 1 ? `1px solid ${T.border}` : 'none', fontSize: 12.5, cursor: p.md_stock_id != null ? 'pointer' : 'default' }}>
                                <span style={{ width: 7, height: 7, borderRadius: '50%', background: c, flexShrink: 0 }} />
                                <span style={{ fontFamily: 'monospace', fontSize: 11, color: T.text2, width: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.sku || '—'}</span>
                                <span style={{ flex: 1, color: T.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name || '—'}</span>
                                <span style={{ fontFamily: 'monospace', fontWeight: 600, color: T.text }}>×{num(p.quantity)}</span>
                                {owner && <span style={{ fontFamily: 'monospace', fontSize: 11, color: T.text3, width: 90, textAlign: 'right' }}>{owner.current_stock} on hand</span>}
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  )
                })}
                {filteredJobs.length === 0 && <div style={{ padding: 28, textAlign: 'center', color: T.text3, fontSize: 12 }}>No jobs match this search.</div>}
              </div>
            )}
          </div>

          {/* Drill-down: all jobs needing the selected part */}
          {drillStock != null && (
            <div onClick={() => setDrillStock(null)} style={{ position: 'absolute', inset: 0, zIndex: 40, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
              <div style={{ position: 'absolute', inset: 0, background: T.bg, opacity: 0.7 }} />
              <div onClick={e => e.stopPropagation()} style={{ position: 'relative', background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 14, width: 'min(720px, 100%)', maxHeight: '82vh', display: 'flex', flexDirection: 'column', boxShadow: '0 18px 50px rgba(0,0,0,0.35)' }}>
                <div style={{ padding: '16px 20px', borderBottom: `1px solid ${T.border}`, display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 11, fontFamily: 'monospace', color: T.text3 }}>{drillItem?.sku || ''}</div>
                    <div style={{ fontSize: 16, fontWeight: 600, color: T.text, marginTop: 2 }}>{drillItem?.part_name || 'Part'}</div>
                    {drillItem && (
                      <div style={{ fontSize: 12, color: T.text3, marginTop: 5 }}>
                        <strong style={{ color: colourOf(statusOf(drillItem)) }}>{drillItem.to_pick} to pick</strong> · {drillItem.current_stock} on hand · {remaining(drillItem) < 0 ? `${-remaining(drillItem)} short` : `${remaining(drillItem)} left`}
                        {drillItem.on_order > 0 && <span> · {drillItem.on_order} on order</span>}
                        {toOrder(drillItem) > 0 && <span style={{ color: T.red, fontWeight: 600 }}> · order {toOrder(drillItem)}</span>}
                        {drillItem.location ? ` · ${drillItem.location}` : ''}
                      </div>
                    )}
                    <div style={{ fontSize: 12, color: T.text2, marginTop: 6 }}>Needed by {drillJobs.length} job{drillJobs.length === 1 ? '' : 's'}:</div>
                  </div>
                  <button onClick={() => setDrillStock(null)} style={{ background: 'transparent', border: 'none', color: T.text3, fontSize: 22, cursor: 'pointer', lineHeight: 1, fontFamily: 'inherit' }}>×</button>
                </div>
                <div style={{ overflow: 'auto', padding: '6px 10px 14px' }}>
                  {drillJobs.length === 0 ? (
                    <div style={{ padding: 24, textAlign: 'center', color: T.text3, fontSize: 12 }}>No job breakdown available for this part.</div>
                  ) : drillJobs.map((r, i) => (
                    <div key={i} style={{ display: 'grid', gridTemplateColumns: '80px 1fr 150px 90px 110px 56px', gap: 8, alignItems: 'center', padding: '8px 10px', borderBottom: `1px solid ${T.border}`, fontSize: 12.5 }}>
                      <div style={{ fontFamily: 'monospace', fontWeight: 600, color: T.text }}>{r.job?.job_number || r.md_job_id}</div>
                      <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.job?.customer_name || ''}>{r.job?.customer_name || '—'}</div>
                      <div style={{ color: T.text2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.job?.vehicle || ''}>{r.job?.vehicle || '—'}</div>
                      <div style={{ fontFamily: 'monospace', color: T.text2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.job?.rego || '—'}</div>
                      <div style={{ color: T.text3 }}>{fmtJobDate(r.job?.scheduled_at || null)}</div>
                      <div style={{ textAlign: 'right', fontFamily: 'monospace', fontWeight: 700, color: T.text }}>×{num(r.qty)}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Drill-down: open purchase orders for the selected part (on order) */}
          {drillPO != null && (
            <div onClick={() => setDrillPO(null)} style={{ position: 'absolute', inset: 0, zIndex: 41, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
              <div style={{ position: 'absolute', inset: 0, background: T.bg, opacity: 0.7 }} />
              <div onClick={e => e.stopPropagation()} style={{ position: 'relative', background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 14, width: 'min(640px, 100%)', maxHeight: '82vh', display: 'flex', flexDirection: 'column', boxShadow: '0 18px 50px rgba(0,0,0,0.35)' }}>
                <div style={{ padding: '16px 20px', borderBottom: `1px solid ${T.border}`, display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 11, fontFamily: 'monospace', color: T.text3 }}>{poItem?.sku || ''}</div>
                    <div style={{ fontSize: 16, fontWeight: 600, color: T.text, marginTop: 2 }}>{poItem?.part_name || 'Part'}</div>
                    <div style={{ fontSize: 12, color: T.text2, marginTop: 5 }}><strong style={{ color: T.accent }}>{poItem?.on_order || 0} on order</strong> across {poRows.length} purchase-order line{poRows.length === 1 ? '' : 's'}</div>
                  </div>
                  <button onClick={() => setDrillPO(null)} style={{ background: 'transparent', border: 'none', color: T.text3, fontSize: 22, cursor: 'pointer', lineHeight: 1, fontFamily: 'inherit' }}>×</button>
                </div>
                <div style={{ overflow: 'auto', padding: '6px 10px 14px' }}>
                  {poRows.length === 0 ? (
                    <div style={{ padding: 24, textAlign: 'center', color: T.text3, fontSize: 12 }}>
                      {poItem && poItem.on_order > 0 ? 'On order, but MechanicDesk returned no purchase-order line detail.' : 'Nothing on order for this part.'}
                    </div>
                  ) : poRows.map((r, i) => (
                    <div key={i} style={{ display: 'grid', gridTemplateColumns: '70px 1fr 120px 56px', gap: 8, alignItems: 'center', padding: '8px 10px', borderBottom: `1px solid ${T.border}`, fontSize: 12.5 }}>
                      <div style={{ fontFamily: 'monospace', fontWeight: 600, color: T.text }}>{r.number != null ? `#${r.number}` : '—'}</div>
                      <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.supplier || ''}>{r.supplier || '—'}</div>
                      <div style={{ color: T.text3 }}>{r.date ? fmtJobDate(r.date) : '—'}</div>
                      <div style={{ textAlign: 'right', fontFamily: 'monospace', fontWeight: 700, color: T.text }}>{r.qty != null ? `×${num(Number(r.qty))}` : '—'}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  )
}

export async function getServerSideProps(context: any) {
  return requirePageAuth(context, 'view:diary')
}
