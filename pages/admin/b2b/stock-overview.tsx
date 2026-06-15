// pages/admin/b2b/stock-overview.tsx
// B2B "Stock Wall" — a configurable grid of tiles, each showing the live
// on-hand quantity of a pinned catalogue product. Staff pick which products
// appear, choose the grid density (2…12 columns) and set colour thresholds
// (below red_below → red, below amber_below → amber). One shared board.

import { useCallback, useEffect, useMemo, useState } from 'react'
import Head from 'next/head'
import PortalTopBar from '../../../lib/PortalTopBar'
import B2BAdminTabs from '../../../components/b2b/B2BAdminTabs'
import { requirePageAuth } from '../../../lib/authServer'
import type { UserRole } from '../../../lib/permissions'
import { roleHasPermission } from '../../../lib/permissions'

const T = {
  bg: 'var(--t-bg)', bg2: 'var(--t-bg2)', bg3: 'var(--t-bg3)', bg4: 'var(--t-bg4)',
  border: 'var(--t-border)', border2: 'var(--t-border2)',
  text: 'var(--t-text)', text2: 'var(--t-text2)', text3: 'var(--t-text3)',
  blue: '#4f8ef7', green: '#34c77b', amber: '#f5a623', red: '#f04e4e',
}
const COLUMN_OPTIONS = [2, 3, 4, 6, 8, 12]

interface Item { id: string; sku: string; name: string; qty_on_hand: number; is_inventoried: boolean; stock_cached_at: string | null; primary_image_url: string | null }
interface Config { columns: number; red_below: number; amber_below: number | null; item_ids: string[] }
interface Props { user: { id: string; email: string; displayName: string | null; role: UserRole; visibleTabs: string[] | null } }

const btn = (c: string, solid?: boolean): React.CSSProperties => ({ padding: '7px 13px', borderRadius: 7, fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer', background: solid ? c : 'transparent', color: solid ? '#fff' : c, border: `1px solid ${solid ? c : c + '55'}` })
const numInp: React.CSSProperties = { width: 64, padding: '6px 8px', background: T.bg3, border: `1px solid ${T.border2}`, borderRadius: 6, color: T.text, fontSize: 13, fontFamily: 'inherit', outline: 'none' }

export default function B2BStockOverview({ user }: Props) {
  const canEdit = roleHasPermission(user.role, 'edit:b2b_catalogue')
  const [all, setAll] = useState<Item[]>([])
  const [config, setConfig] = useState<Config>({ columns: 4, red_below: 5, amber_below: null, item_ids: [] })
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [configuring, setConfiguring] = useState(false)
  const [picker, setPicker] = useState('')
  const [savedAt, setSavedAt] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await fetch('/api/b2b/admin/stock-overview', { credentials: 'same-origin' })
      const d = await r.json()
      if (r.ok) { setAll(d.all || []); setConfig({ columns: d.config.columns || 4, red_below: d.config.red_below ?? 5, amber_below: d.config.amber_below ?? null, item_ids: d.config.item_ids || [] }) }
    } finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])

  const byId = useMemo(() => new Map(all.map(i => [i.id, i])), [all])
  const tiles = useMemo(() => config.item_ids.map(id => byId.get(id)).filter(Boolean) as Item[], [config.item_ids, byId])
  const oldestCache = useMemo(() => tiles.reduce<string | null>((acc, t) => (!acc || (t.stock_cached_at && t.stock_cached_at < acc) ? (t.stock_cached_at || acc) : acc), null), [tiles])

  // Persist config (optimistic — local state already updated by the caller).
  const save = useCallback(async (next: Config) => {
    if (!canEdit) return
    const r = await fetch('/api/b2b/admin/stock-overview', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
      body: JSON.stringify(next),
    })
    if (r.ok) setSavedAt(new Date().toISOString())
  }, [canEdit])
  const mutate = useCallback((next: Config) => { setConfig(next); save(next) }, [save])

  async function refresh() {
    setRefreshing(true)
    try {
      await fetch('/api/b2b/admin/catalogue/refresh-stock', { method: 'POST', credentials: 'same-origin' })
      await load()
    } finally { setRefreshing(false) }
  }

  function tileColour(t: Item): string {
    if (!t.is_inventoried) return T.text3
    const q = Number(t.qty_on_hand || 0)
    if (q < config.red_below) return T.red
    if (config.amber_below != null && q < config.amber_below) return T.amber
    return T.green
  }

  const addItem = (id: string) => mutate({ ...config, item_ids: [...config.item_ids, id] })
  const removeItem = (id: string) => mutate({ ...config, item_ids: config.item_ids.filter(x => x !== id) })
  const moveItem = (idx: number, dir: -1 | 1) => {
    const arr = [...config.item_ids]; const j = idx + dir
    if (j < 0 || j >= arr.length) return
    ;[arr[idx], arr[j]] = [arr[j], arr[idx]]
    mutate({ ...config, item_ids: arr })
  }

  const candidates = useMemo(() => {
    const pinned = new Set(config.item_ids)
    const q = picker.trim().toLowerCase()
    return all.filter(i => !pinned.has(i.id) && (!q || i.sku?.toLowerCase().includes(q) || i.name?.toLowerCase().includes(q))).slice(0, 60)
  }, [all, config.item_ids, picker])

  return (
    <>
      <Head><title>Stock Wall · B2B · JA Portal</title></Head>
      <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh', background: T.bg, color: T.text, fontFamily: 'system-ui,-apple-system,sans-serif' }}>
        <PortalTopBar activeId="b2b" currentUserRole={user.role} currentUserVisibleTabs={user.visibleTabs} currentUserName={user.displayName} currentUserEmail={user.email} />
        <main className="b2b-admin-main" style={{ flex: 1, padding: '28px 32px', width: '100%', boxSizing: 'border-box' }}>
          <B2BAdminTabs active="stock_overview" />

          <header style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', marginBottom: 20 }}>
            <div>
              <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0 }}>Stock Wall</h1>
              <div style={{ fontSize: 12.5, color: T.text3, marginTop: 4 }}>
                Live on-hand quantities for pinned products{oldestCache ? ` · updated ${rel(oldestCache)}` : ''}
              </div>
            </div>
            <span style={{ flex: 1 }} />
            {/* Density */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 12, color: T.text3 }}>Columns</span>
              <div style={{ display: 'flex', border: `1px solid ${T.border2}`, borderRadius: 7, overflow: 'hidden' }}>
                {COLUMN_OPTIONS.map(n => (
                  <button key={n} onClick={() => mutate({ ...config, columns: n })} disabled={!canEdit}
                    style={{ padding: '6px 11px', fontSize: 12, fontWeight: 600, fontFamily: 'inherit', cursor: canEdit ? 'pointer' : 'default', border: 'none', background: config.columns === n ? T.blue : 'transparent', color: config.columns === n ? '#fff' : T.text2 }}>{n}</button>
                ))}
              </div>
            </div>
            <button onClick={refresh} disabled={refreshing} style={{ ...btn(T.text2), opacity: refreshing ? 0.6 : 1 }}>{refreshing ? 'Refreshing…' : '↻ Refresh'}</button>
            {canEdit && <button onClick={() => setConfiguring(v => !v)} style={btn(T.blue, configuring)}>⚙ {configuring ? 'Done' : 'Configure'}</button>}
          </header>

          {/* Configure panel */}
          {configuring && canEdit && (
            <section style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 12, padding: 18, marginBottom: 20 }}>
              <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 18 }}>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                  <span style={{ fontSize: 11, color: T.text3, fontWeight: 600 }}>🔴 Red when below</span>
                  <input type="number" min={0} value={config.red_below} onChange={e => mutate({ ...config, red_below: Math.max(0, Number(e.target.value) || 0) })} style={numInp} />
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                  <span style={{ fontSize: 11, color: T.text3, fontWeight: 600 }}>🟠 Amber when below</span>
                  <input type="number" min={0} placeholder="off" value={config.amber_below ?? ''} onChange={e => mutate({ ...config, amber_below: e.target.value === '' ? null : Math.max(0, Number(e.target.value) || 0) })} style={numInp} />
                </label>
                <div style={{ fontSize: 11.5, color: T.text3, lineHeight: 1.5, maxWidth: 320 }}>
                  Tiles turn red below the red threshold, amber below the amber threshold (set amber higher than red for a warning band), otherwise green. Set amber to “off” to use red only.
                </div>
              </div>

              <div className="b2b-col2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18 }}>
                {/* Pinned, ordered */}
                <div>
                  <div style={{ fontSize: 11, color: T.text3, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>On the wall ({tiles.length})</div>
                  {tiles.length === 0 && <div style={{ fontSize: 12.5, color: T.text3, fontStyle: 'italic' }}>Nothing pinned yet — add products from the right.</div>}
                  {tiles.map((t, i) => (
                    <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', background: T.bg3, border: `1px solid ${T.border}`, borderRadius: 7, marginBottom: 6 }}>
                      <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}><strong style={{ fontFamily: 'monospace' }}>{t.sku}</strong> · {t.name}</span>
                      <button onClick={() => moveItem(i, -1)} disabled={i === 0} style={arrowBtn(i === 0)}>↑</button>
                      <button onClick={() => moveItem(i, 1)} disabled={i === tiles.length - 1} style={arrowBtn(i === tiles.length - 1)}>↓</button>
                      <button onClick={() => removeItem(t.id)} style={{ ...arrowBtn(false), color: T.red }}>✕</button>
                    </div>
                  ))}
                </div>
                {/* Add */}
                <div>
                  <div style={{ fontSize: 11, color: T.text3, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>Add a product</div>
                  <input value={picker} onChange={e => setPicker(e.target.value)} placeholder="Search SKU or name…" style={{ width: '100%', padding: '8px 10px', background: T.bg3, border: `1px solid ${T.border2}`, borderRadius: 7, color: T.text, fontSize: 13, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box', marginBottom: 8 }} />
                  <div style={{ maxHeight: 280, overflowY: 'auto' }}>
                    {candidates.map(i => (
                      <div key={i.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderBottom: `1px solid ${T.border}` }}>
                        <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}><strong style={{ fontFamily: 'monospace' }}>{i.sku}</strong> · {i.name}</span>
                        <span style={{ fontSize: 11, color: T.text3, fontFamily: 'monospace' }}>{i.is_inventoried ? i.qty_on_hand : '∞'}</span>
                        <button onClick={() => addItem(i.id)} style={btn(T.blue)}>+ Add</button>
                      </div>
                    ))}
                    {candidates.length === 0 && <div style={{ fontSize: 12, color: T.text3, padding: '8px 0', fontStyle: 'italic' }}>No matches.</div>}
                  </div>
                </div>
              </div>
              {savedAt && <div style={{ fontSize: 11, color: T.green, marginTop: 10 }}>✓ Saved</div>}
            </section>
          )}

          {/* The wall */}
          {loading ? (
            <div style={{ padding: 40, textAlign: 'center', color: T.text3, fontSize: 13 }}>Loading…</div>
          ) : tiles.length === 0 ? (
            <div style={{ padding: 48, textAlign: 'center', color: T.text3, fontSize: 14, background: T.bg2, border: `1px dashed ${T.border2}`, borderRadius: 12 }}>
              No products on the wall yet.{canEdit ? ' Click ⚙ Configure to add some.' : ''}
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: `repeat(${config.columns}, minmax(0, 1fr))`, gap: 12 }}>
              {tiles.map(t => {
                const c = tileColour(t)
                const qty = t.is_inventoried ? Number(t.qty_on_hand || 0) : null
                return (
                  <div key={t.id} style={{ background: `${c}14`, border: `1.5px solid ${c}66`, borderRadius: 12, padding: '16px 14px', display: 'flex', flexDirection: 'column', minHeight: 96 }}>
                    <div style={{ fontSize: 11, color: T.text3, fontFamily: 'monospace', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.sku}</div>
                    <div title={t.name} style={{ fontSize: 12.5, color: T.text2, lineHeight: 1.3, margin: '2px 0 8px', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{t.name}</div>
                    <div style={{ marginTop: 'auto', display: 'flex', alignItems: 'baseline', gap: 6 }}>
                      <span style={{ fontSize: config.columns >= 8 ? 26 : 34, fontWeight: 700, color: c, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>{qty == null ? '∞' : qty}</span>
                      {qty != null && <span style={{ fontSize: 11, color: T.text3 }}>on hand</span>}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </main>
      </div>
    </>
  )
}

function arrowBtn(disabled: boolean): React.CSSProperties {
  return { width: 26, height: 26, borderRadius: 6, border: `1px solid ${T.border2}`, background: 'transparent', color: disabled ? T.text3 : T.text2, cursor: disabled ? 'default' : 'pointer', fontSize: 13, opacity: disabled ? 0.5 : 1, flexShrink: 0 }
}
function rel(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 60_000) return 'just now'
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`
  return `${Math.floor(ms / 86_400_000)}d ago`
}

export async function getServerSideProps(context: any) {
  return requirePageAuth(context, 'view:b2b')
}
