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
  id: string; sku: string; part_name: string; brand: string | null; supplier: string | null
  location: string | null; buy_price: number | null; alert_qty: number | null
  to_pick: number; current_stock: number
}
type Status = 'green' | 'orange' | 'red'
type Filter = 'all' | 'green' | 'orange' | 'red' | 'toorder'
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

export default function PrePickPage({ user }: { user: PortalUserSSR }) {
  const toast = useToast()
  const today = new Date()
  // The picker range drives the NEXT pull from MechanicDesk.
  const [from, setFrom] = useState(ymd(today))
  const [to, setTo] = useState(ymd(addDays(today, 14)))
  const [lowThreshold, setLowThreshold] = useState(5)
  const [items, setItems] = useState<PrePickItem[]>([])
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
  const toOrder = (it: PrePickItem) => Math.max(0, Math.round((it.to_pick - it.current_stock) * 100) / 100)
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

  function preset(kind: 'week' | 'fortnight' | 'month') {
    const t = new Date()
    if (kind === 'week') { setFrom(ymd(t)); setTo(ymd(addDays(t, 7))) }
    else if (kind === 'fortnight') { setFrom(ymd(t)); setTo(ymd(addDays(t, 14))) }
    else { const y = t.getFullYear(), m = t.getMonth(); const last = new Date(y, m + 1, 0); setFrom(ymd(new Date(y, m, 1))); setTo(ymd(last)) }
  }

  function exportCsv() {
    const headRow = ['SKU', 'Part', 'Brand', 'Supplier', 'To pick', 'On hand', 'Remaining', 'To order', 'Buy price', 'Location', 'Status']
    const esc = (v: any) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
    const lines = [headRow.join(',')]
    for (const it of filtered) {
      lines.push([it.sku, it.part_name, it.brand || '', it.supplier || '', it.to_pick, it.current_stock, remaining(it), toOrder(it), it.buy_price ?? '', it.location || '', statusOf(it)].map(esc).join(','))
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = `pre-pick-${snapFrom || from}_to_${snapTo || to}.csv`; a.click(); URL.revokeObjectURL(url)
  }

  const filterLabel = (f: Filter) => f === 'green' ? 'OK' : f === 'orange' ? 'Low' : f === 'red' ? 'Out of stock' : f === 'toorder' ? 'To order' : 'All'

  async function exportPdf() {
    if (filtered.length === 0 || pdfBusy) return
    setPdfBusy(true)
    try {
      const payload = {
        from: snapFrom, to: snapTo, synced_at: syncedAt, jobs_count: jobsCount,
        low_threshold: lowThreshold, filter_label: filterLabel(filter), counts,
        items: filtered.map(it => ({
          sku: it.sku, part_name: it.part_name, supplier: it.supplier, location: it.location,
          buy_price: it.buy_price, to_pick: it.to_pick, current_stock: it.current_stock,
          remaining: remaining(it), to_order: toOrder(it), status: statusOf(it),
        })),
      }
      const r = await fetch('/api/workshop/prepick/pdf', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      if (!r.ok) { const d = await r.json().catch(() => ({})); toast(d.error || 'PDF export failed', 'error'); return }
      const blob = await r.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a'); a.href = url; a.download = `pre-pick-${snapFrom || from}_to_${snapTo || to}.pdf`; a.click(); URL.revokeObjectURL(url)
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
  const GRID = '110px 1fr 120px 70px 70px 80px 80px 80px 110px'
  const head: React.CSSProperties = { fontSize: 9, color: T.text3, textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 }
  const pulling = inFlight
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
            <button onClick={exportCsv} disabled={filtered.length === 0} style={{ ...inputStyle, cursor: filtered.length ? 'pointer' : 'not-allowed', opacity: filtered.length ? 1 : 0.5, fontWeight: 600 }}>⬇ Export CSV</button>
            <button onClick={exportPdf} disabled={filtered.length === 0 || pdfBusy} style={{ ...inputStyle, cursor: filtered.length && !pdfBusy ? 'pointer' : 'not-allowed', opacity: filtered.length && !pdfBusy ? 1 : 0.5, fontWeight: 600 }}>{pdfBusy ? 'Building PDF…' : '⬇ Export PDF'}</button>
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
          </div>

          {/* Filters */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 20px', flexWrap: 'wrap', flexShrink: 0 }}>
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search SKU / part / supplier…" style={{ ...inputStyle, width: 260 }} />
            <div style={{ flex: 1 }} />
            {chip('all', `All (${items.length})`)}
            {chip('green', `OK (${counts.green})`, T.green)}
            {chip('orange', `Low (${counts.orange})`, T.amber)}
            {chip('red', `Out (${counts.red})`, T.red)}
            {chip('toorder', `To order (${counts.orderCount})`, T.red)}
          </div>

          <div style={{ flex: 1, overflow: 'auto', padding: '4px 20px 24px' }}>
            {loading && items.length === 0 ? (
              <SkeletonRows rows={6} />
            ) : items.length === 0 ? (
              <div style={{ padding: 48, textAlign: 'center', color: T.text3, fontSize: 13 }}>
                {pulling
                  ? 'Pulling from MechanicDesk — parts will appear here shortly.'
                  : 'No tracked parts on MechanicDesk jobs in the last pulled range. Pick a date range and hit “Refresh from MechanicDesk”. Only parts linked to a tracked MD stock item are counted (labour/freight excluded).'}
              </div>
            ) : (
              <>
                {/* Tiles */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 12, marginBottom: 22 }}>
                  {filtered.map(it => {
                    const s = statusOf(it); const c = colourOf(s); const rem = remaining(it); const ord = toOrder(it)
                    return (
                      <div key={it.id} style={{ background: `${c}14`, border: `1.5px solid ${c}66`, borderRadius: 12, padding: '14px', display: 'flex', flexDirection: 'column', minHeight: 104 }}>
                        <div style={{ fontSize: 10.5, color: T.text3, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.sku || '—'}</div>
                        <div title={it.part_name} style={{ fontSize: 12.5, color: T.text2, lineHeight: 1.3, marginTop: 2, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{it.part_name}</div>
                        <div style={{ marginTop: 'auto', display: 'flex', alignItems: 'baseline', gap: 6, paddingTop: 8 }}>
                          <span style={{ fontSize: 30, fontWeight: 700, color: c, fontVariantNumeric: 'tabular-nums' }}>{it.to_pick}</span>
                          <span style={{ fontSize: 11, color: T.text3 }}>to pick</span>
                        </div>
                        <div style={{ fontSize: 11, color: T.text3, marginTop: 2 }}>
                          {it.current_stock} on hand · {rem < 0 ? <span style={{ color: T.red }}>{rem} short</span> : `${rem} left`}
                        </div>
                        {ord > 0 && <div style={{ fontSize: 11, fontWeight: 600, color: T.red, marginTop: 3 }}>Order {ord}</div>}
                      </div>
                    )
                  })}
                </div>

                {/* List */}
                <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 10, overflow: 'hidden' }}>
                  <div style={{ display: 'grid', gridTemplateColumns: GRID, gap: 8, padding: '9px 14px', background: T.bg3, borderBottom: `1px solid ${T.border}` }}>
                    <div style={head}>SKU</div><div style={head}>Part</div><div style={head}>Supplier</div>
                    <div style={{ ...head, textAlign: 'right' }}>To pick</div><div style={{ ...head, textAlign: 'right' }}>On hand</div>
                    <div style={{ ...head, textAlign: 'right' }}>Remaining</div><div style={{ ...head, textAlign: 'right' }}>To order</div>
                    <div style={{ ...head, textAlign: 'right' }}>Buy $</div><div style={head}>Location</div>
                  </div>
                  {filtered.map(it => {
                    const s = statusOf(it); const c = colourOf(s); const rem = remaining(it); const ord = toOrder(it)
                    return (
                      <div key={it.id} style={{ display: 'grid', gridTemplateColumns: GRID, gap: 8, padding: '9px 14px', borderTop: `1px solid ${T.border}`, alignItems: 'center', fontSize: 12.5 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontFamily: 'monospace', fontSize: 11, color: T.text2, overflow: 'hidden' }}>
                          <span style={{ width: 8, height: 8, borderRadius: '50%', background: c, flexShrink: 0 }} />
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.sku || '—'}</span>
                        </div>
                        <div title={it.part_name} style={{ color: T.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.part_name}</div>
                        <div style={{ color: T.text3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.supplier || '—'}</div>
                        <div style={{ textAlign: 'right', fontFamily: 'monospace', fontWeight: 600 }}>{it.to_pick}</div>
                        <div style={{ textAlign: 'right', fontFamily: 'monospace', color: T.text2 }}>{it.current_stock}</div>
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
            )}
          </div>
        </div>
      </div>
    </>
  )
}

export async function getServerSideProps(context: any) {
  return requirePageAuth(context, 'view:diary')
}
