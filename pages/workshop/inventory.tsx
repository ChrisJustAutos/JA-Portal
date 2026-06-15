// pages/workshop/inventory.tsx
// Inventory screen — read-only view of workshop_inventory (synced from MYOB VPS).
// Search + low-stock filter. MYOB is the master, so edits happen in MYOB; admins
// can re-sync from here. Gated view:diary.

import { useEffect, useState, useCallback } from 'react'
import Head from 'next/head'
import PortalTopBar from '../../lib/PortalTopBar'
import InventoryTabs from '../../components/InventoryTabs'
import WorkshopTabs from '../../components/WorkshopTabs'
import { requirePageAuth } from '../../lib/authServer'
import type { PortalUserSSR } from '../../lib/authServer'
import { roleHasPermission } from '../../lib/permissions'
import { T, SkeletonRows } from '../../components/ui'

const money = (n: number | null) => (n == null ? '—' : `$${(Number(n) || 0).toFixed(2)}`)

// Client-safe mirror of LABEL_LAYOUTS keys (the full layout lives in the
// server-only lib/workshop-label-pdf so react-pdf never reaches the client).
const LABEL_PRESETS = [
  { key: 'L7163', label: 'Avery L7163 — 14/sheet (99 × 38 mm)' },
  { key: 'L7160', label: 'Avery L7160 — 21/sheet (63 × 38 mm)' },
  { key: 'L7159', label: 'Avery L7159 — 24/sheet (63 × 34 mm)' },
  { key: 'L7651', label: 'Avery L7651 — 65/sheet (38 × 21 mm)' },
]

const GRID_COLS = '28px 110px 1fr 70px 70px 70px 90px 90px 110px'

export default function InventoryPage({ user }: { user: PortalUserSSR }) {
  const isAdmin = roleHasPermission(user.role, 'admin:settings')
  const [items, setItems] = useState<any[]>([])
  const [q, setQ] = useState('')
  const [low, setLow] = useState(false)
  const [loading, setLoading] = useState(true)
  const [sync, setSync] = useState<{ busy: boolean; msg: string }>({ busy: false, msg: '' })
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [printOpen, setPrintOpen] = useState(false)
  const [printOpts, setPrintOpts] = useState({ layout: 'L7163', copies: 1, skip: 0 })

  function toggleSelect(id: string) {
    setSelected(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  }
  function toggleAll() {
    setSelected(prev => prev.size === items.length && items.length > 0 ? new Set() : new Set(items.map(i => i.id)))
  }
  function printLabels() {
    const ids = Array.from(selected).filter(id => items.some(i => i.id === id))
    if (!ids.length) return
    const p = new URLSearchParams({ ids: ids.join(','), copies: String(printOpts.copies), layout: printOpts.layout, skip: String(printOpts.skip) })
    window.open(`/api/workshop/labels?${p.toString()}`, '_blank')
    setPrintOpen(false)
  }

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ limit: '300' })
      if (q.trim()) params.set('q', q.trim())
      if (low) params.set('low', '1')
      const r = await fetch(`/api/workshop/inventory?${params.toString()}`)
      const d = await r.json()
      if (r.ok) setItems(Array.isArray(d.items) ? d.items : [])
      setLastRefresh(new Date())
    } catch { /* keep prior */ } finally { setLoading(false) }
  }, [q, low])

  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t) }, [load])

  async function doSync() {
    setSync({ busy: true, msg: 'Syncing inventory from MYOB…' })
    try {
      const r = await fetch('/api/workshop/sync?what=inventory', { method: 'POST' })
      const d = await r.json()
      if (!r.ok || !d.ok) { setSync({ busy: false, msg: d.error || 'Sync failed' }); return }
      const x = (d.results || [])[0]
      setSync({ busy: false, msg: x ? `Synced ${x.upserted}/${x.scanned}` : 'Synced' })
      load()
    } catch (e: any) { setSync({ busy: false, msg: e?.message || 'Sync failed' }) }
  }

  return (
    <>
      <Head><title>Inventory — Just Autos</title><meta name="viewport" content="width=device-width,initial-scale=1"/><meta name="robots" content="noindex,nofollow"/></Head>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden', fontFamily: "'DM Sans',system-ui,sans-serif", color: T.text }}>
        <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet"/>
        <PortalTopBar activeId="diary" lastRefresh={lastRefresh} onRefresh={load} refreshing={loading}
          currentUserRole={user.role} currentUserVisibleTabs={user.visibleTabs} currentUserName={user.displayName} currentUserEmail={user.email} />
        <WorkshopTabs active="inventory" role={user.role} />
        <InventoryTabs active="inventory" role={user.role} />

        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: T.bg }}>
          <div style={{ height: 52, background: T.bg2, borderBottom: `1px solid ${T.border}`, display: 'flex', alignItems: 'center', padding: '0 20px', gap: 10, flexShrink: 0 }}>
            <span style={{ fontSize: 14, fontWeight: 600 }}>Inventory</span>
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search SKU / name / brand…"
              style={{ width: 280, padding: '6px 10px', background: T.bg3, border: `1px solid ${T.border}`, borderRadius: 5, color: T.text, fontSize: 12, fontFamily: 'inherit', outline: 'none' }} />
            <button onClick={() => setLow(v => !v)} style={{ padding: '5px 12px', borderRadius: 5, fontSize: 12, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer', background: low ? 'rgba(240,78,78,0.12)' : 'transparent', color: low ? T.red : T.text2, border: `1px solid ${low ? T.red + '55' : T.border2}` }}>
              Low stock
            </button>
            <div style={{ flex: 1 }} />
            {selected.size > 0 && (
              <button onClick={() => setPrintOpen(true)} style={{ padding: '5px 12px', borderRadius: 5, fontSize: 12, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer', background: T.accent, color: '#fff', border: 'none' }}>
                🏷 Print labels ({selected.size})
              </button>
            )}
            {isAdmin && (
              <>
                {sync.msg && <span style={{ fontSize: 11, color: T.text3 }}>{sync.msg}</span>}
                <button onClick={doSync} disabled={sync.busy} style={{ padding: '5px 12px', borderRadius: 5, fontSize: 12, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer', background: 'transparent', color: T.text2, border: `1px solid ${T.border2}` }}>
                  {sync.busy ? '↻ Syncing…' : '↻ Sync MYOB'}
                </button>
              </>
            )}
          </div>

          <div style={{ flex: 1, overflow: 'auto', padding: 20 }}>
            <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 10, overflow: 'hidden' }}>
              <div style={{ display: 'grid', gridTemplateColumns: GRID_COLS, gap: 8, padding: '9px 14px', background: T.bg3, borderBottom: `1px solid ${T.border}`, fontSize: 9, color: T.text3, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', alignItems: 'center' }}>
                <div><input type="checkbox" checked={items.length > 0 && selected.size === items.length} onChange={toggleAll} title="Select all" style={{ cursor: 'pointer' }} /></div>
                <div>SKU</div><div>Part</div><div style={{ textAlign: 'right' }}>On hand</div><div style={{ textAlign: 'right' }}>Avail</div><div style={{ textAlign: 'right' }}>Alert</div><div style={{ textAlign: 'right' }}>Buy</div><div style={{ textAlign: 'right' }}>Sell</div><div>Location</div>
              </div>
              {loading && items.length === 0 ? (
                <SkeletonRows rows={8} />
              ) : items.length === 0 ? (
                <div style={{ padding: 40, textAlign: 'center', color: T.text3, fontSize: 12 }}>No parts{q ? ' match' : ' yet'}.{isAdmin ? ' Run “↻ Sync MYOB”.' : ''}</div>
              ) : items.map(it => {
                const lowStock = Number(it.alert_qty) > 0 && Number(it.available) <= Number(it.alert_qty)
                return (
                  <div key={it.id} style={{ display: 'grid', gridTemplateColumns: GRID_COLS, gap: 8, padding: '8px 14px', borderTop: `1px solid ${T.border}`, alignItems: 'center', background: selected.has(it.id) ? 'rgba(79,142,247,0.08)' : 'transparent' }}>
                    <div><input type="checkbox" checked={selected.has(it.id)} onChange={() => toggleSelect(it.id)} style={{ cursor: 'pointer' }} /></div>
                    <div style={{ fontSize: 11, fontFamily: 'monospace', color: T.text2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.sku || '—'}</div>
                    <div style={{ fontSize: 12, color: T.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.part_name}{it.brand ? <span style={{ color: T.text3 }}> · {it.brand}</span> : null}</div>
                    <div style={{ fontSize: 12, fontFamily: 'monospace', textAlign: 'right', color: T.text2 }}>{Number(it.quantity)}</div>
                    <div style={{ fontSize: 12, fontFamily: 'monospace', textAlign: 'right', color: lowStock ? T.red : T.text2, fontWeight: lowStock ? 700 : 400 }}>{Number(it.available)}</div>
                    <div style={{ fontSize: 11, fontFamily: 'monospace', textAlign: 'right', color: T.text3 }}>{Number(it.alert_qty) || '—'}</div>
                    <div style={{ fontSize: 11, fontFamily: 'monospace', textAlign: 'right', color: T.text3 }}>{money(it.buy_price)}</div>
                    <div style={{ fontSize: 12, fontFamily: 'monospace', textAlign: 'right', color: T.text }}>{money(it.sell_price)}</div>
                    <div style={{ fontSize: 11, color: T.text3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{[it.location, it.bin].filter(Boolean).join(' / ') || '—'}</div>
                  </div>
                )
              })}
            </div>
            <div style={{ fontSize: 11, color: T.text3, marginTop: 10 }}>
              Read-only — MYOB (VPS) is the master. Showing up to 300; search to narrow. Stock decrements happen via MYOB when jobs invoice.
            </div>
          </div>
        </div>
      </div>

      {printOpen && (
        <div onClick={() => setPrintOpen(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
          <div onClick={e => e.stopPropagation()} style={{ width: 420, background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 12, padding: 20, color: T.text }}>
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>Print parts labels</div>
            <div style={{ fontSize: 12, color: T.text3, marginBottom: 16 }}>{selected.size} part{selected.size === 1 ? '' : 's'} selected · prints as a PDF on any printer.</div>

            <label style={{ display: 'block', fontSize: 11, color: T.text3, fontWeight: 600, marginBottom: 5 }}>Label sheet</label>
            <select value={printOpts.layout} onChange={e => setPrintOpts(o => ({ ...o, layout: e.target.value }))}
              style={{ width: '100%', padding: '7px 10px', background: T.bg3, border: `1px solid ${T.border}`, borderRadius: 6, color: T.text, fontSize: 12, fontFamily: 'inherit', marginBottom: 14 }}>
              {LABEL_PRESETS.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
            </select>

            <div style={{ display: 'flex', gap: 12, marginBottom: 18 }}>
              <div style={{ flex: 1 }}>
                <label style={{ display: 'block', fontSize: 11, color: T.text3, fontWeight: 600, marginBottom: 5 }}>Copies per part</label>
                <input type="number" min={1} max={100} value={printOpts.copies} onChange={e => setPrintOpts(o => ({ ...o, copies: Math.max(1, Math.min(100, Number(e.target.value) || 1)) }))}
                  style={{ width: '100%', padding: '7px 10px', background: T.bg3, border: `1px solid ${T.border}`, borderRadius: 6, color: T.text, fontSize: 12, fontFamily: 'inherit' }} />
              </div>
              <div style={{ flex: 1 }}>
                <label style={{ display: 'block', fontSize: 11, color: T.text3, fontWeight: 600, marginBottom: 5 }}>Skip labels</label>
                <input type="number" min={0} max={200} value={printOpts.skip} onChange={e => setPrintOpts(o => ({ ...o, skip: Math.max(0, Math.min(200, Number(e.target.value) || 0)) }))}
                  title="Leave this many labels blank — to reuse a part-used sheet"
                  style={{ width: '100%', padding: '7px 10px', background: T.bg3, border: `1px solid ${T.border}`, borderRadius: 6, color: T.text, fontSize: 12, fontFamily: 'inherit' }} />
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button onClick={() => setPrintOpen(false)} style={{ padding: '7px 14px', borderRadius: 6, fontSize: 12, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer', background: 'transparent', color: T.text2, border: `1px solid ${T.border2}` }}>Cancel</button>
              <button onClick={printLabels} style={{ padding: '7px 14px', borderRadius: 6, fontSize: 12, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer', background: T.accent, color: '#fff', border: 'none' }}>Open print sheet</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

export async function getServerSideProps(context: any) {
  return requirePageAuth(context, 'view:diary')
}
