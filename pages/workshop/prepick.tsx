// pages/workshop/prepick.tsx
// Pre Pick — for all jobs in a date range, sum the parts they need, compare to
// current stock, and show green/orange/red tiles (like the B2B stock wall) plus
// a filterable, exportable list of what to pick / order. Gated view:diary.

import { useEffect, useState, useCallback, useMemo } from 'react'
import Head from 'next/head'
import PortalTopBar from '../../lib/PortalTopBar'
import InventoryTabs from '../../components/InventoryTabs'
import WorkshopTabs from '../../components/WorkshopTabs'
import { requirePageAuth } from '../../lib/authServer'
import type { PortalUserSSR } from '../../lib/authServer'
import { T, SkeletonRows } from '../../components/ui'

interface PrePickItem {
  id: string; sku: string; part_name: string; brand: string | null; supplier: string | null
  location: string | null; buy_price: number | null; alert_qty: number | null
  to_pick: number; current_stock: number
}
type Status = 'green' | 'orange' | 'red'
type Filter = 'all' | 'green' | 'orange' | 'red' | 'toorder'

function ymd(d: Date): string { const p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` }
function addDays(d: Date, n: number): Date { const x = new Date(d); x.setDate(x.getDate() + n); return x }
const money = (n: number | null) => (n == null ? '—' : `$${(Number(n) || 0).toFixed(2)}`)

export default function PrePickPage({ user }: { user: PortalUserSSR }) {
  const today = new Date()
  const [from, setFrom] = useState(ymd(today))
  const [to, setTo] = useState(ymd(addDays(today, 7)))
  const [lowThreshold, setLowThreshold] = useState(5)
  const [items, setItems] = useState<PrePickItem[]>([])
  const [jobsCount, setJobsCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null)
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<Filter>('all')

  const load = useCallback(async () => {
    if (!from || !to) return
    setLoading(true)
    try {
      const r = await fetch(`/api/workshop/prepick?from=${from}&to=${to}`)
      const d = await r.json()
      if (r.ok) { setItems(Array.isArray(d.items) ? d.items : []); setJobsCount(Number(d.jobs_count) || 0) }
      setLastRefresh(new Date())
    } catch { /* keep prior */ } finally { setLoading(false) }
  }, [from, to])
  useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t) }, [load])

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
    const head = ['SKU', 'Part', 'Brand', 'Supplier', 'To pick', 'On hand', 'Remaining', 'To order', 'Buy price', 'Location', 'Status']
    const esc = (v: any) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
    const lines = [head.join(',')]
    for (const it of filtered) {
      lines.push([it.sku, it.part_name, it.brand || '', it.supplier || '', it.to_pick, it.current_stock, remaining(it), toOrder(it), it.buy_price ?? '', it.location || '', statusOf(it)].map(esc).join(','))
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = `pre-pick-${from}_to_${to}.csv`; a.click(); URL.revokeObjectURL(url)
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

  return (
    <>
      <Head><title>Pre Pick — Just Autos</title><meta name="viewport" content="width=device-width,initial-scale=1"/><meta name="robots" content="noindex,nofollow"/></Head>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden', fontFamily: "'DM Sans',system-ui,sans-serif", color: T.text }}>
        <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet"/>
        <PortalTopBar activeId="diary" lastRefresh={lastRefresh} onRefresh={load} refreshing={loading}
          currentUserRole={user.role} currentUserVisibleTabs={user.visibleTabs} currentUserName={user.displayName} currentUserEmail={user.email} />
        <WorkshopTabs active="inventory" role={user.role} />
        <InventoryTabs active="prepick" role={user.role} />

        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: T.bg }}>
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
                No stocked parts on jobs in this range. Try a wider date range — only parts linked to an inventory item are counted.
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
