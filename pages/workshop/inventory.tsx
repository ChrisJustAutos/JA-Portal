// pages/workshop/inventory.tsx
// Inventory screen — read-only view of workshop_inventory (synced from MYOB VPS).
// Search + low-stock filter. MYOB is the master, so edits happen in MYOB; admins
// can re-sync from here. Gated view:diary.

import { useEffect, useState, useCallback } from 'react'
import Head from 'next/head'
import PortalTopBar from '../../lib/PortalTopBar'
import InventoryTabs from '../../components/InventoryTabs'
import { requirePageAuth } from '../../lib/authServer'
import { roleHasPermission } from '../../lib/permissions'

interface PortalUserSSR { id: string; email: string; displayName: string | null; role: 'admin'|'manager'|'sales'|'accountant'|'viewer'; visibleTabs?: string[] | null }

const T = {
  bg: '#0d0f12', bg2: '#131519', bg3: '#1a1d23', bg4: '#21252d',
  border: 'rgba(255,255,255,0.07)', border2: 'rgba(255,255,255,0.12)',
  text: '#e8eaf0', text2: '#8b90a0', text3: '#545968',
  blue: '#4f8ef7', teal: '#2dd4bf', green: '#34c77b', amber: '#f5a623', red: '#f04e4e', purple: '#a78bfa', accent: '#4f8ef7',
}
const money = (n: number | null) => (n == null ? '—' : `$${(Number(n) || 0).toFixed(2)}`)

export default function InventoryPage({ user }: { user: PortalUserSSR }) {
  const isAdmin = roleHasPermission(user.role, 'admin:settings')
  const [items, setItems] = useState<any[]>([])
  const [q, setQ] = useState('')
  const [low, setLow] = useState(false)
  const [loading, setLoading] = useState(true)
  const [sync, setSync] = useState<{ busy: boolean; msg: string }>({ busy: false, msg: '' })
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null)

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
        <PortalTopBar activeId="workshop-inventory" lastRefresh={lastRefresh} onRefresh={load} refreshing={loading}
          currentUserRole={user.role} currentUserVisibleTabs={user.visibleTabs} currentUserName={user.displayName} currentUserEmail={user.email} />
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
              <div style={{ display: 'grid', gridTemplateColumns: '110px 1fr 70px 70px 70px 90px 90px 110px', gap: 8, padding: '9px 14px', background: T.bg3, borderBottom: `1px solid ${T.border}`, fontSize: 9, color: T.text3, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                <div>SKU</div><div>Part</div><div style={{ textAlign: 'right' }}>On hand</div><div style={{ textAlign: 'right' }}>Avail</div><div style={{ textAlign: 'right' }}>Alert</div><div style={{ textAlign: 'right' }}>Buy</div><div style={{ textAlign: 'right' }}>Sell</div><div>Location</div>
              </div>
              {loading && items.length === 0 ? (
                <div style={{ padding: 40, textAlign: 'center', color: T.text3, fontSize: 12 }}>Loading…</div>
              ) : items.length === 0 ? (
                <div style={{ padding: 40, textAlign: 'center', color: T.text3, fontSize: 12 }}>No parts{q ? ' match' : ' yet'}.{isAdmin ? ' Run “↻ Sync MYOB”.' : ''}</div>
              ) : items.map(it => {
                const lowStock = Number(it.alert_qty) > 0 && Number(it.available) <= Number(it.alert_qty)
                return (
                  <div key={it.id} style={{ display: 'grid', gridTemplateColumns: '110px 1fr 70px 70px 70px 90px 90px 110px', gap: 8, padding: '8px 14px', borderTop: `1px solid ${T.border}`, alignItems: 'center' }}>
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
    </>
  )
}

export async function getServerSideProps(context: any) {
  return requirePageAuth(context, 'view:diary')
}
