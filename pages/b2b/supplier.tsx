// pages/b2b/supplier.tsx
// The supplier portal — a single read-only Stock Wall showing live on-hand
// quantities for the products this supplier makes for us, so they can plan
// their production runs. No ordering, no pricing, no catalogue.

import { useCallback, useEffect, useMemo, useState } from 'react'
import Head from 'next/head'
import { useRouter } from 'next/router'
import { getSupabase } from '../../lib/supabaseClient'
import { requireSupplierPageAuth } from '../../lib/b2bSupplierAuth'

const T = {
  bg: 'var(--t-bg)', bg2: 'var(--t-bg2)', bg3: 'var(--t-bg3)',
  border: 'var(--t-border)', border2: 'var(--t-border2)',
  text: 'var(--t-text)', text2: 'var(--t-text2)', text3: 'var(--t-text3)',
  blue: '#4f8ef7', green: '#34c77b', amber: '#f5a623', red: '#f04e4e',
}
const COLUMN_OPTIONS = [2, 3, 4, 6, 8, 12]

interface Item { id: string; sku: string; name: string; qty_on_hand: number; is_inventoried: boolean }
interface Props { supplier: { userId: string; email: string; fullName: string | null; id: string; name: string } }

export default function SupplierStockWall({ supplier }: Props) {
  const router = useRouter()
  const [items, setItems] = useState<Item[]>([])
  const [thresholds, setThresholds] = useState<{ red_below: number; amber_below: number | null }>({ red_below: 5, amber_below: null })
  const [updatedAt, setUpdatedAt] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [columns, setColumns] = useState(4)
  const [q, setQ] = useState('')

  useEffect(() => { try { const v = Number(localStorage.getItem('supplier_wall_cols')); if (COLUMN_OPTIONS.includes(v)) setColumns(v) } catch { /* */ } }, [])
  function pickCols(n: number) { setColumns(n); try { localStorage.setItem('supplier_wall_cols', String(n)) } catch { /* */ } }

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await fetch('/api/b2b/supplier/stock', { credentials: 'same-origin' })
      const d = await r.json()
      if (r.ok) { setItems(d.items || []); setThresholds(d.thresholds || { red_below: 5, amber_below: null }); setUpdatedAt(d.updated_at || null) }
    } finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])

  async function signOut() {
    try { await fetch('/api/b2b/auth/session', { method: 'DELETE' }) } catch { /* */ }
    try { await getSupabase().auth.signOut() } catch { /* */ }
    router.push('/b2b/login')
  }

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase()
    return s ? items.filter(i => i.sku?.toLowerCase().includes(s) || i.name?.toLowerCase().includes(s)) : items
  }, [items, q])

  function colour(it: Item): string {
    if (!it.is_inventoried) return T.text3
    const v = Number(it.qty_on_hand || 0)
    if (v < thresholds.red_below) return T.red
    if (thresholds.amber_below != null && v < thresholds.amber_below) return T.amber
    return T.green
  }
  const lowCount = useMemo(() => items.filter(i => i.is_inventoried && Number(i.qty_on_hand || 0) < thresholds.red_below).length, [items, thresholds])

  return (
    <>
      <Head><title>Stock — {supplier.name} · Just Autos</title><meta name="viewport" content="width=device-width,initial-scale=1" /><meta name="robots" content="noindex,nofollow" /></Head>
      <div style={{ minHeight: '100vh', background: T.bg, color: T.text, fontFamily: 'system-ui,-apple-system,sans-serif' }}>
        {/* Header bar */}
        <header style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 22px', borderBottom: `1px solid ${T.border}`, background: T.bg2, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <span style={{ fontSize: 11, color: T.text3, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Just Autos · Supplier stock</span>
            <span style={{ fontSize: 16, fontWeight: 600 }}>{supplier.name}</span>
          </div>
          <span style={{ flex: 1 }} />
          <button onClick={signOut} style={{ padding: '6px 12px', borderRadius: 7, fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer', background: 'transparent', color: T.text2, border: `1px solid ${T.border2}` }}>Sign out</button>
        </header>

        <main style={{ maxWidth: 1280, margin: '0 auto', padding: '22px 22px 60px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 18 }}>
            <div>
              <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>On-hand stock</h1>
              <div style={{ fontSize: 12.5, color: T.text3, marginTop: 4 }}>
                {items.length} product{items.length === 1 ? '' : 's'} you supply{lowCount > 0 ? ` · ${lowCount} low` : ''}{updatedAt ? ` · updated ${rel(updatedAt)}` : ''}
              </div>
            </div>
            <span style={{ flex: 1 }} />
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search…" style={{ width: 200, padding: '7px 10px', background: T.bg3, border: `1px solid ${T.border2}`, borderRadius: 7, color: T.text, fontSize: 13, fontFamily: 'inherit', outline: 'none' }} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 12, color: T.text3 }}>Columns</span>
              <div style={{ display: 'flex', border: `1px solid ${T.border2}`, borderRadius: 7, overflow: 'hidden' }}>
                {COLUMN_OPTIONS.map(n => (
                  <button key={n} onClick={() => pickCols(n)} style={{ padding: '6px 11px', fontSize: 12, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer', border: 'none', background: columns === n ? T.blue : 'transparent', color: columns === n ? '#fff' : T.text2 }}>{n}</button>
                ))}
              </div>
            </div>
            <button onClick={load} disabled={loading} style={{ padding: '7px 13px', borderRadius: 7, fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer', background: 'transparent', color: T.text2, border: `1px solid ${T.border2}`, opacity: loading ? 0.6 : 1 }}>{loading ? 'Loading…' : '↻ Refresh'}</button>
          </div>

          {loading && items.length === 0 ? (
            <div style={{ padding: 40, textAlign: 'center', color: T.text3, fontSize: 13 }}>Loading…</div>
          ) : shown.length === 0 ? (
            <div style={{ padding: 48, textAlign: 'center', color: T.text3, fontSize: 14, background: T.bg2, border: `1px dashed ${T.border2}`, borderRadius: 12 }}>
              {items.length === 0 ? 'No products are linked to your account yet — contact Just Autos.' : 'No products match your search.'}
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gap: 12 }}>
              {shown.map(it => {
                const c = colour(it)
                const qty = it.is_inventoried ? Number(it.qty_on_hand || 0) : null
                return (
                  <div key={it.id} style={{ background: `${c}14`, border: `1.5px solid ${c}66`, borderRadius: 12, padding: '16px 14px', display: 'flex', flexDirection: 'column', minHeight: 96 }}>
                    <div style={{ fontSize: 11, color: T.text3, fontFamily: 'monospace', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{it.sku}</div>
                    <div title={it.name} style={{ fontSize: 12.5, color: T.text2, lineHeight: 1.3, margin: '2px 0 8px', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{it.name}</div>
                    <div style={{ marginTop: 'auto', display: 'flex', alignItems: 'baseline', gap: 6 }}>
                      <span style={{ fontSize: columns >= 8 ? 26 : 34, fontWeight: 700, color: c, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>{qty == null ? '∞' : qty}</span>
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

function rel(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 60_000) return 'just now'
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`
  return `${Math.floor(ms / 86_400_000)}d ago`
}

export async function getServerSideProps(context: any) {
  return requireSupplierPageAuth(context)
}
