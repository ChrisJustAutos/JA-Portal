// pages/admin/b2b/stock-reorder.tsx
// Stock reorder / prediction sheet (replaces the JAWS Stock Order Excel).
// Editable date range, growth %, forecast months; per-row Morgan's judgment,
// MOQ + notes; Sync pulls stock + sales from MYOB (JAWS via CData); Export xlsx.

import { useCallback, useEffect, useState } from 'react'
import Head from 'next/head'
import PortalTopBar from '../../../lib/PortalTopBar'
import B2BAdminTabs from '../../../components/b2b/B2BAdminTabs'
import { requirePageAuth } from '../../../lib/authServer'
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
  async function patchItem(id: string, patch: any) {
    setItems(prev => prev.map(i => i.id === id ? { ...i, ...patch } : i))
    await fetch(`/api/b2b/admin/reorder/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) })
  }
  async function removeItem(id: string) {
    setItems(prev => prev.filter(i => i.id !== id))
    await fetch(`/api/b2b/admin/reorder/${id}`, { method: 'DELETE' })
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
            <label style={{ fontSize: 11, color: T.text3 }}>Sales from <input type="date" value={settings.from_date || ''} onChange={e => saveSettings({ from_date: e.target.value || null })} style={{ ...inp, marginLeft: 4 }} /></label>
            <label style={{ fontSize: 11, color: T.text3 }}>to <input type="date" value={settings.to_date || ''} onChange={e => saveSettings({ to_date: e.target.value || null })} style={{ ...inp, marginLeft: 4 }} /></label>
            <span style={{ fontSize: 11, color: T.text3 }}>= {months} mo</span>
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

          {/* Sheet */}
          <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 10, overflowX: 'auto' }}>
            <div style={{ minWidth: 1280 }}>
              <div style={{ display: 'grid', gridTemplateColumns: GRID, gap: 6, padding: '8px 12px', background: T.bg3, borderBottom: `1px solid ${T.border}`, fontSize: 8.5, color: T.text3, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.03em', alignItems: 'end' }}>
                {Th('Stock No.')}{Th('Name')}{Th('On hand', true)}{Th('Cmtd', true, 'Committed')}{Th('Avail', true, 'Available = on hand − committed')}{Th('On ord', true, 'On order')}{Th(`Sales ${months}mo`, true, 'Total units sold over the date range')}{Th('Avg/mo', true)}{Th('Round', true, 'Monthly round up')}{Th('+Grow', true, 'With growth %')}{Th('Proj', true, `Projected demand over ${settings.forecast_months} months`)}{Th('Short', true, 'Shortfall = projected − (available + on order)')}{Th('Suggested', true)}{Th('MOQ', true)}{Th("Morgan's", true, "Manual override")}{Th('Final', true)}{Th('Notes')}
              </div>
              {loading ? (
                <div style={{ padding: 30, textAlign: 'center', color: T.text3, fontSize: 12 }}>Loading…</div>
              ) : shown.length === 0 ? (
                <div style={{ padding: 30, textAlign: 'center', color: T.text3, fontSize: 12 }}>No items{q ? ' match' : ' yet — “+ Add item”, then “↻ Sync MYOB”'}.</div>
              ) : shown.map(it => {
                const c = computeReorder(it, settings, months)
                return (
                  <div key={it.id} style={{ display: 'grid', gridTemplateColumns: GRID, gap: 6, padding: '6px 12px', borderTop: `1px solid ${T.border}`, alignItems: 'center', fontSize: 12 }}>
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
                    <div style={{ textAlign: 'right', fontFamily: 'monospace', color: c.shortfall > 0 ? T.amber : T.text3 }}>{num(c.shortfall)}</div>
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
            On hand / Committed / On order + sales come from MYOB (JAWS) on Sync. Suggested = monthly avg × (1+growth) × cover months, less stock on hand + on order, rounded to MOQ (or 5/15). Final = Morgan’s judgment if set, otherwise Suggested.
          </div>
        </main>
      </div>
    </>
  )
}

export async function getServerSideProps(context: any) {
  return requirePageAuth(context, 'edit:b2b_catalogue')
}
