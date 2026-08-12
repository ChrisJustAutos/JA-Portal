// pages/b2b/supplier.tsx
// The supplier portal — a single read-only Stock Wall showing live on-hand
// quantities for the products this supplier makes for us, so they can plan
// their production runs. No ordering, no pricing, no catalogue.

import { useCallback, useEffect, useMemo, useState } from 'react'
import Head from 'next/head'
import { useRouter } from 'next/router'
import { getSupabase } from '../../lib/supabaseClient'
import { requireSupplierPageAuth } from '../../lib/b2bSupplierAuth'
import { T, alpha } from '../../lib/ui/theme'
// Standalone shell (no B2BLayout) so AlloyStyles is mounted here.
import { A, RADIUS, AlloyStyles, Btn, EmptyState, PageTitle, Seg, inputStyle } from '../../components/b2b/ui'

const COLUMN_OPTIONS = [2, 3, 4, 6, 8, 12]

interface Item { id: string; sku: string; name: string; qty_on_hand: number; is_inventoried: boolean; stock_red_below: number | null; stock_amber_below: number | null }
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

  function redOf(it: Item) { return it.stock_red_below ?? thresholds.red_below }       // per-item override, else default
  function amberOf(it: Item) { return it.stock_amber_below ?? thresholds.amber_below }
  function colour(it: Item): string {
    if (!it.is_inventoried) return T.text3
    const v = Number(it.qty_on_hand || 0)
    const amber = amberOf(it)
    if (v < redOf(it)) return A.bad
    if (amber != null && v < amber) return A.warn
    return A.good
  }
  const lowCount = useMemo(() => items.filter(i => i.is_inventoried && Number(i.qty_on_hand || 0) < (i.stock_red_below ?? thresholds.red_below)).length, [items, thresholds])

  return (
    <>
      <Head><title>Stock — {supplier.name} · Just Autos</title><meta name="viewport" content="width=device-width,initial-scale=1" /><meta name="robots" content="noindex,nofollow" /></Head>
      <div style={{ minHeight: '100vh', background: T.bg, color: T.text, fontFamily: 'system-ui,-apple-system,sans-serif' }}>
        <AlloyStyles/>
        {/* Header bar */}
        <header style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 22px', borderBottom: `1px solid ${T.border}`, background: T.bg2, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <span style={{ fontSize: 12, color: T.text3, fontWeight: 600 }}>Just Autos · Supplier stock</span>
            <span style={{ fontSize: 16, fontWeight: 650 }}>{supplier.name}</span>
          </div>
          <span style={{ flex: 1 }} />
          <Btn variant="ghost" size="sm" onClick={signOut}>Sign out</Btn>
        </header>

        <main style={{ maxWidth: 1280, margin: '0 auto', padding: '22px 22px 60px' }}>
          <PageTitle
            sub={`${items.length} product${items.length === 1 ? '' : 's'} you supply${lowCount > 0 ? ` · ${lowCount} low` : ''}${updatedAt ? ` · updated ${rel(updatedAt)}` : ''}`}
            action={
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search…"
                  style={{ ...inputStyle(), width: 210, maxWidth: '100%' }} />
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 12.5, color: T.text3 }}>Columns</span>
                  <div style={{ width: 236 }}>
                    <Seg
                      options={COLUMN_OPTIONS.map(n => ({ id: String(n), label: String(n) }))}
                      value={String(columns)}
                      onChange={id => pickCols(Number(id))}/>
                  </div>
                </div>
                <Btn variant="ghost" size="sm" onClick={load} disabled={loading}>{loading ? 'Loading…' : 'Reload'}</Btn>
              </div>
            }>
            On-hand stock
          </PageTitle>

          {loading && items.length === 0 ? (
            <div style={{ padding: 40, textAlign: 'center', color: T.text3, fontSize: 13 }}>Loading…</div>
          ) : shown.length === 0 ? (
            items.length === 0
              ? <EmptyState title="No products linked to your account yet" sub="Contact Just Autos to get set up." />
              : <EmptyState title="No products match your search" />
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gap: 12 }}>
              {shown.map(it => {
                const c = colour(it)
                const qty = it.is_inventoried ? Number(it.qty_on_hand || 0) : null
                return (
                  <div key={it.id} style={{ background: alpha(c, '14'), border: `1px solid ${alpha(c, '55')}`, borderRadius: RADIUS.md, padding: '16px 14px', display: 'flex', flexDirection: 'column', minHeight: 96 }}>
                    <div style={{ fontSize: 12, color: T.text3, fontFamily: 'ui-monospace, monospace', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{it.sku}</div>
                    <div title={it.name} style={{ fontSize: 12.5, color: T.text2, lineHeight: 1.3, margin: '2px 0 8px', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{it.name}</div>
                    <div style={{ marginTop: 'auto', display: 'flex', alignItems: 'baseline', gap: 6 }}>
                      <span style={{ fontSize: columns >= 8 ? 26 : 34, fontWeight: 700, color: c, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>{qty == null ? '∞' : qty}</span>
                      {qty != null && <span style={{ fontSize: 12, color: T.text3 }}>on hand</span>}
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
