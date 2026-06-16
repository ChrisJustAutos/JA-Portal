// pages/admin/b2b/stock-reorder.tsx
// Stock reorder / prediction sheet (replaces the JAWS Stock Order Excel).
// Editable date range, growth %, forecast months; per-row Morgan's judgment,
// MOQ + notes; Sync pulls stock + sales from MYOB (JAWS via CData); Export xlsx.

import { useCallback, useEffect, useRef, useState } from 'react'
import Head from 'next/head'
import PortalTopBar from '../../../lib/PortalTopBar'
import B2BAdminTabs from '../../../components/b2b/B2BAdminTabs'
import { requirePageAuth } from '../../../lib/authServer'
import { useConfirm } from '../../../components/ui/Feedback'
import { computeReorder, monthsInRange, ReorderItem, ReorderSettings } from '../../../lib/b2b-reorder'

const T = {
  bg: 'var(--t-bg)', bg2: 'var(--t-bg2)', bg3: 'var(--t-bg3)', bg4: 'var(--t-bg4)',
  border: 'var(--t-border)', border2: 'var(--t-border2)',
  text: 'var(--t-text)', text2: 'var(--t-text2)', text3: 'var(--t-text3)',
  blue: '#4f8ef7', teal: '#2dd4bf', green: '#34c77b', amber: '#f5a623', red: '#f04e4e',
}

const inp: React.CSSProperties = { padding: '6px 8px', background: T.bg3, border: `1px solid ${T.border}`, borderRadius: 5, color: T.text, fontSize: 12, fontFamily: 'inherit', outline: 'none', colorScheme: 'dark' }
const cellInp: React.CSSProperties = { width: '100%', padding: '4px 6px', background: T.bg3, border: `1px solid ${T.border}`, borderRadius: 4, color: T.text, fontSize: 12, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box', textAlign: 'right' }
const btn = (c: string, solid?: boolean): React.CSSProperties => ({ padding: '6px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer', background: solid ? c : 'transparent', color: solid ? '#fff' : c, border: `1px solid ${solid ? c : c + '55'}` })
const num = (n: number) => Number(n || 0).toLocaleString('en-AU', { maximumFractionDigits: 2 })

const GRID = '120px 1.4fr 56px 56px 56px 56px 70px 60px 70px 70px 64px 64px 80px 70px 90px 80px 1fr'

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
// Last N calendar months (1st of the month N-1 back → today) so the divisor = N.
function lastNMonths(n: number): { from: string; to: string } {
  const t = new Date()
  return { from: ymd(new Date(t.getFullYear(), t.getMonth() - (n - 1), 1)), to: ymd(t) }
}
function thisFinancialYear(): { from: string; to: string } {
  const t = new Date()
  const y = t.getMonth() >= 6 ? t.getFullYear() : t.getFullYear() - 1   // AU FY starts 1 July
  return { from: `${y}-07-01`, to: ymd(t) }
}

export default function StockReorderPage({ user }: { user: any }) {
  const [settings, setSettings] = useState<ReorderSettings>({ from_date: null, to_date: null, growth_pct: 0.2, forecast_months: 3 })
  const [items, setItems] = useState<ReorderItem[]>([])
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [msg, setMsg] = useState('')
  const [q, setQ] = useState('')
  const [adding, setAdding] = useState(false)
  const [addQ, setAddQ] = useState('')
  const [addResults, setAddResults] = useState<Array<{ sku: string; name: string }>>([])
  const syncTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const confirmDialog = useConfirm()
  // Multi-select + bulk edit/delete.
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulk, setBulk] = useState<{ moq: string; morgans: string; notes: string }>({ moq: '', morgans: '', notes: '' })
  const [bulkBusy, setBulkBusy] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await fetch('/api/b2b/admin/reorder')
      const d = await r.json()
      if (r.ok) {
        setSettings({ from_date: d.settings.from_date || null, to_date: d.settings.to_date || null, growth_pct: Number(d.settings.growth_pct) || 0, forecast_months: Number(d.settings.forecast_months) || 3 })
        setItems(d.items || [])
      }
    } finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])

  const months = monthsInRange(settings.from_date, settings.to_date)

  async function saveSettings(patch: Partial<ReorderSettings>) {
    const next = { ...settings, ...patch }
    setSettings(next)
    await fetch('/api/b2b/admin/reorder', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) })
  }
  // Re-pull sales (+ stock) shortly after the range changes, so the Sales column
  // always reflects the chosen window.
  function scheduleSync() { if (syncTimer.current) clearTimeout(syncTimer.current); syncTimer.current = setTimeout(() => { sync() }, 700) }
  async function applyRange(from: string | null, to: string | null) {
    setSettings(s => ({ ...s, from_date: from, to_date: to }))
    await fetch('/api/b2b/admin/reorder', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from_date: from, to_date: to }) })
    if (from && to) scheduleSync()
  }
  async function patchItem(id: string, patch: any) {
    setItems(prev => prev.map(i => i.id === id ? { ...i, ...patch } : i))
    await fetch(`/api/b2b/admin/reorder/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) })
  }
  async function removeItem(id: string) {
    setItems(prev => prev.filter(i => i.id !== id))
    setSelected(prev => { const n = new Set(prev); n.delete(id); return n })
    await fetch(`/api/b2b/admin/reorder/${id}`, { method: 'DELETE' })
  }
  function toggleSel(id: string) { setSelected(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n }) }
  async function bulkApply() {
    const ids = Array.from(selected)
    if (!ids.length) return
    const patch: any = {}
    if (bulk.moq.trim() !== '') patch.moq = bulk.moq.trim()
    if (bulk.morgans.trim() !== '') patch.morgans_judgment = bulk.morgans.trim()
    if (bulk.notes.trim() !== '') patch.notes = bulk.notes
    if (!Object.keys(patch).length) { setMsg('Enter a value (MOQ, Morgan’s or Notes) to apply.'); return }
    setBulkBusy(true)
    try {
      const r = await fetch('/api/b2b/admin/reorder/bulk', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'update', ids, patch }) })
      const d = await r.json()
      if (!r.ok) { setMsg(d.error || 'Bulk update failed'); return }
      setMsg(`Updated ${d.updated} item(s).`)
      setBulk({ moq: '', morgans: '', notes: '' })
      await load()
    } finally { setBulkBusy(false) }
  }
  async function bulkDelete() {
    const ids = Array.from(selected)
    if (!ids.length) return
    if (!(await confirmDialog({ title: `Remove ${ids.length} item${ids.length === 1 ? '' : 's'} from the stock order sheet?`, confirmLabel: 'Remove', danger: true }))) return
    setBulkBusy(true)
    try {
      const r = await fetch('/api/b2b/admin/reorder/bulk', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'delete', ids }) })
      const d = await r.json()
      if (!r.ok) { setMsg(d.error || 'Bulk delete failed'); return }
      setMsg(`Removed ${d.deleted} item(s).`)
      setSelected(new Set())
      await load()
    } finally { setBulkBusy(false) }
  }
  async function sync() {
    setSyncing(true); setMsg('Pulling stock + sales from MYOB…')
    try {
      const r = await fetch('/api/b2b/admin/reorder/sync', { method: 'POST' })
      const d = await r.json()
      if (!r.ok) { setMsg(d.error || 'Sync failed'); return }
      setMsg(`Synced ${d.updated} item(s).${(d.warnings || []).length ? ' ' + d.warnings.join(' ') : ''}`)
      await load()
    } catch (e: any) { setMsg(e?.message || 'Sync failed') } finally { setSyncing(false) }
  }
  async function searchAdd(text: string) {
    setAddQ(text)
    if (!text.trim()) { setAddResults([]); return }
    const r = await fetch(`/api/b2b/admin/reorder?search=${encodeURIComponent(text.trim())}`)
    const d = await r.json()
    if (r.ok) setAddResults((d.matches || []).filter((m: any) => !items.some(i => i.sku === m.sku)))
  }
  async function addItem(m: { sku: string; name: string }) {
    await fetch('/api/b2b/admin/reorder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sku: m.sku, name: m.name }) })
    setAddResults(prev => prev.filter(x => x.sku !== m.sku))
    await load()
  }

  const needle = q.trim().toLowerCase()
  const shown = needle ? items.filter(i => `${i.sku} ${i.name || ''}`.toLowerCase().includes(needle)) : items
  const allShownSelected = shown.length > 0 && shown.every(i => selected.has(i.id))
  function toggleAll() {
    setSelected(prev => {
      const n = new Set(prev)
      if (shown.length && shown.every(i => prev.has(i.id))) shown.forEach(i => n.delete(i.id))
      else shown.forEach(i => n.add(i.id))
      return n
    })
  }
  const GRID_SEL = `30px ${GRID}`
  const Th = (label: string, right?: boolean, title?: string) => <div title={title} style={{ textAlign: right ? 'right' : 'left' }}>{label}</div>

  return (
    <>
      <Head><title>Stock Order · JA Portal</title><meta name="robots" content="noindex,nofollow" /></Head>
      <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh', background: T.bg, color: T.text, fontFamily: "system-ui,-apple-system,sans-serif" }}>
        <PortalTopBar activeId="b2b" currentUserRole={user.role} currentUserVisibleTabs={user.visibleTabs} currentUserName={user.displayName} currentUserEmail={user.email} />
        <main className="b2b-admin-main" style={{ flex: 1, padding: '28px 32px', width: '100%', boxSizing: 'border-box' }}>
          <B2BAdminTabs active="reorder" />

          {/* Controls */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
            <div style={{ fontSize: 18, fontWeight: 600, marginRight: 8 }}>Stock Order</div>
            <label style={{ fontSize: 11, color: T.text3 }}>Sales from <input type="date" value={settings.from_date || ''} onChange={e => applyRange(e.target.value || null, settings.to_date)} style={{ ...inp, marginLeft: 4 }} /></label>
            <label style={{ fontSize: 11, color: T.text3 }}>to <input type="date" value={settings.to_date || ''} onChange={e => applyRange(settings.from_date, e.target.value || null)} style={{ ...inp, marginLeft: 4 }} /></label>
            <span style={{ fontSize: 11, color: T.text3 }}>= {months} mo</span>
            <div style={{ display: 'flex', gap: 4 }}>
              {([['3 mo', lastNMonths(3)], ['6 mo', lastNMonths(6)], ['9 mo', lastNMonths(9)], ['12 mo', lastNMonths(12)], ['This FY', thisFinancialYear()]] as const).map(([label, r]) => {
                const on = settings.from_date === r.from && settings.to_date === r.to
                return <button key={label} onClick={() => applyRange(r.from, r.to)} style={{ ...btn(on ? T.blue : T.text2), padding: '5px 9px', background: on ? `${T.blue}1a` : 'transparent' }}>{label}</button>
              })}
            </div>
            <label style={{ fontSize: 11, color: T.text3 }}>Growth % <input type="number" step="1" value={Math.round(settings.growth_pct * 100)} onChange={e => saveSettings({ growth_pct: (Number(e.target.value) || 0) / 100 })} style={{ ...inp, width: 64, marginLeft: 4, textAlign: 'right' }} /></label>
            <label style={{ fontSize: 11, color: T.text3 }}>Cover months <input type="number" step="1" min={1} value={settings.forecast_months} onChange={e => saveSettings({ forecast_months: Math.max(1, Number(e.target.value) || 1) })} style={{ ...inp, width: 56, marginLeft: 4, textAlign: 'right' }} /></label>
            <div style={{ flex: 1 }} />
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Filter rows…" style={{ ...inp, width: 180 }} />
            <button onClick={() => setAdding(a => !a)} style={btn(T.text2)}>+ Add item</button>
            <button onClick={sync} disabled={syncing} style={btn(T.teal)}>{syncing ? 'Syncing…' : '↻ Sync MYOB'}</button>
            <button onClick={() => window.open('/api/b2b/admin/reorder/export', '_blank')} style={btn(T.green)}>⤓ Export Excel</button>
          </div>

          {adding && (
            <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 8, padding: 12, marginBottom: 14, maxWidth: 520 }}>
              <input autoFocus value={addQ} onChange={e => searchAdd(e.target.value)} placeholder="Search catalogue by SKU or name…" style={{ ...inp, width: '100%', boxSizing: 'border-box' }} />
              <div style={{ marginTop: 8, maxHeight: 220, overflowY: 'auto' }}>
                {addResults.map(m => (
                  <div key={m.sku} onClick={() => addItem(m)} style={{ padding: '6px 8px', fontSize: 12, cursor: 'pointer', borderBottom: `1px solid ${T.border}`, display: 'flex', gap: 8 }}>
                    <span style={{ fontFamily: 'monospace', color: T.text2, minWidth: 120 }}>{m.sku}</span><span>{m.name}</span><span style={{ marginLeft: 'auto', color: T.blue }}>+ add</span>
                  </div>
                ))}
                {addQ && addResults.length === 0 && <div style={{ fontSize: 11, color: T.text3, padding: 6 }}>No catalogue matches (or already on the sheet).</div>}
              </div>
            </div>
          )}

          {msg && <div style={{ fontSize: 12, color: T.text2, marginBottom: 10 }}>{msg}</div>}

          {/* Bulk edit / delete bar — appears when rows are selected */}
          {selected.size > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', background: `${T.blue}14`, border: `1px solid ${T.blue}44`, borderRadius: 8, padding: '10px 12px', marginBottom: 12 }}>
              <span style={{ fontSize: 12, fontWeight: 700 }}>{selected.size} selected</span>
              <span style={{ width: 1, height: 18, background: T.border }} />
              <label style={{ fontSize: 11, color: T.text3 }}>MOQ <input value={bulk.moq} onChange={e => setBulk(b => ({ ...b, moq: e.target.value }))} inputMode="numeric" placeholder="—" style={{ ...inp, width: 60, marginLeft: 4, textAlign: 'right' }} /></label>
              <label style={{ fontSize: 11, color: T.text3 }}>Morgan’s <input value={bulk.morgans} onChange={e => setBulk(b => ({ ...b, morgans: e.target.value }))} inputMode="numeric" placeholder="—" style={{ ...inp, width: 60, marginLeft: 4, textAlign: 'right' }} /></label>
              <label style={{ fontSize: 11, color: T.text3 }}>Notes <input value={bulk.notes} onChange={e => setBulk(b => ({ ...b, notes: e.target.value }))} placeholder="—" style={{ ...inp, width: 200, marginLeft: 4 }} /></label>
              <button onClick={bulkApply} disabled={bulkBusy} style={btn(T.blue, true)}>{bulkBusy ? 'Applying…' : 'Apply to selected'}</button>
              <span style={{ fontSize: 10, color: T.text3 }}>blank = unchanged</span>
              <div style={{ flex: 1 }} />
              <button onClick={bulkDelete} disabled={bulkBusy} style={btn(T.red)}>🗑 Delete selected</button>
              <button onClick={() => setSelected(new Set())} style={btn(T.text3)}>Clear</button>
            </div>
          )}

          {/* Sheet */}
          <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 10, overflowX: 'auto' }}>
            <div style={{ minWidth: 1280 }}>
              <div style={{ display: 'grid', gridTemplateColumns: GRID_SEL, gap: 6, padding: '8px 12px', background: T.bg3, borderBottom: `1px solid ${T.border}`, fontSize: 8.5, color: T.text3, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.03em', alignItems: 'end' }}>
                <div><input type="checkbox" title="Select all" checked={allShownSelected} onChange={toggleAll} style={{ cursor: 'pointer' }} /></div>
                {Th('Stock No.')}{Th('Name')}{Th('On hand', true)}{Th('Cmtd', true, 'Committed')}{Th('Avail', true, 'Available = on hand − committed')}{Th('On ord', true, 'On order')}{Th(`Sales ${months}mo`, true, 'Total units sold over the date range')}{Th('Avg/mo', true)}{Th('Round', true, 'Monthly round up')}{Th('+Grow', true, 'With growth %')}{Th('Proj', true, `Projected demand over ${settings.forecast_months} months`)}{Th('Order', true, `Order needed to keep a ${settings.forecast_months}-month buffer = max(0, 2×projected − (available + on order))`)}{Th('Suggested', true)}{Th('MOQ', true)}{Th("Morgan's", true, "Manual override")}{Th('Final', true)}{Th('Notes')}
              </div>
              {loading ? (
                <div style={{ padding: 30, textAlign: 'center', color: T.text3, fontSize: 12 }}>Loading…</div>
              ) : shown.length === 0 ? (
                <div style={{ padding: 30, textAlign: 'center', color: T.text3, fontSize: 12 }}>No items{q ? ' match' : ' yet — “+ Add item”, then “↻ Sync MYOB”'}.</div>
              ) : shown.map(it => {
                const c = computeReorder(it, settings, months)
                const sel = selected.has(it.id)
                return (
                  <div key={it.id} style={{ display: 'grid', gridTemplateColumns: GRID_SEL, gap: 6, padding: '6px 12px', borderTop: `1px solid ${T.border}`, alignItems: 'center', fontSize: 12, background: sel ? `${T.blue}12` : 'transparent' }}>
                    <div><input type="checkbox" checked={sel} onChange={() => toggleSel(it.id)} style={{ cursor: 'pointer' }} /></div>
                    <div style={{ fontFamily: 'monospace', color: T.text2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.sku}</div>
                    <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.name || '—'}</div>
                    <div style={{ textAlign: 'right', fontFamily: 'monospace', color: T.text2 }}>{num(it.on_hand)}</div>
                    <div style={{ textAlign: 'right', fontFamily: 'monospace', color: T.text3 }}>{num(it.committed)}</div>
                    <div style={{ textAlign: 'right', fontFamily: 'monospace', color: T.text2 }}>{num(c.available)}</div>
                    <div style={{ textAlign: 'right', fontFamily: 'monospace', color: T.text3 }}>{num(it.on_order)}</div>
                    <div style={{ textAlign: 'right', fontFamily: 'monospace', color: T.text }}>{num(it.sales_qty)}</div>
                    <div style={{ textAlign: 'right', fontFamily: 'monospace', color: T.text3 }}>{num(Math.round(c.monthlyAvg * 10) / 10)}</div>
                    <div style={{ textAlign: 'right', fontFamily: 'monospace', color: T.text3 }}>{num(c.monthlyRound)}</div>
                    <div style={{ textAlign: 'right', fontFamily: 'monospace', color: T.text3 }}>{num(c.withGrowth)}</div>
                    <div style={{ textAlign: 'right', fontFamily: 'monospace', color: T.text3 }}>{num(c.projected)}</div>
                    <div style={{ textAlign: 'right', fontFamily: 'monospace', color: c.orderNeed > 0 ? T.amber : T.text3 }}>{num(c.orderNeed)}</div>
                    <div style={{ textAlign: 'right', fontFamily: 'monospace', color: T.text2, fontWeight: 600 }}>{num(c.suggested)}</div>
                    <div><input defaultValue={it.moq ?? ''} inputMode="numeric" onBlur={e => { const v = e.target.value.trim(); if (v !== String(it.moq ?? '')) patchItem(it.id, { moq: v }) }} style={cellInp} /></div>
                    <div><input defaultValue={it.morgans_judgment ?? ''} inputMode="numeric" placeholder="—" onBlur={e => { const v = e.target.value.trim(); if (v !== String(it.morgans_judgment ?? '')) patchItem(it.id, { morgans_judgment: v }) }} style={{ ...cellInp, borderColor: it.morgans_judgment != null ? T.amber : T.border }} /></div>
                    <div style={{ textAlign: 'right', fontFamily: 'monospace', color: T.green, fontWeight: 700 }}>{num(c.finalOrder)}</div>
                    <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                      <input defaultValue={it.notes ?? ''} onBlur={e => { const v = e.target.value; if (v !== (it.notes ?? '')) patchItem(it.id, { notes: v }) }} style={{ ...cellInp, textAlign: 'left' }} />
                      <button onClick={() => removeItem(it.id)} title="Remove" style={{ background: 'transparent', border: 'none', color: T.text3, cursor: 'pointer', fontSize: 14 }}>×</button>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
          <div style={{ fontSize: 11, color: T.text3, marginTop: 10 }}>
            On hand / Committed / On order + sales come from MYOB (JAWS) on Sync. Projected = monthly avg × (1+growth) × cover months. Order keeps a cover-months buffer: Order = max(0, 2×Projected − (available + on order)). Suggested rounds that to MOQ (or 5/15). Final = Morgan’s judgment if set, otherwise Suggested.
          </div>
        </main>
      </div>
    </>
  )
}

export async function getServerSideProps(context: any) {
  return requirePageAuth(context, 'edit:b2b_catalogue')
}
