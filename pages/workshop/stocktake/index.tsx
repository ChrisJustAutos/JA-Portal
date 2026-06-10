// pages/workshop/stocktake/index.tsx
// Portal-native stocktake sessions over workshop_inventory (parallel to the
// MechanicDesk stocktake until cutover). Start a session (optionally scoped),
// open one to count, applied sessions show their variance.

import { useCallback, useEffect, useState } from 'react'
import Head from 'next/head'
import Link from 'next/link'
import PortalTopBar from '../../../lib/PortalTopBar'
import InventoryTabs from '../../../components/InventoryTabs'
import { requirePageAuth } from '../../../lib/authServer'
import type { PortalUserSSR } from '../../../lib/authServer'
import { roleHasPermission } from '../../../lib/permissions'
import { T, pbtn, StatusPill, SkeletonRows } from '../../../components/ui'
import { money2 as money } from '../../../lib/ui/format'

const STATUS_META: Record<string, { label: string; color: string }> = {
  counting: { label: 'Counting', color: T.amber },
  review:   { label: 'Review',   color: T.blue },
  applied:  { label: 'Applied',  color: T.green },
  cancelled:{ label: 'Cancelled',color: T.text3 },
}

export default function WorkshopStocktakeListPage({ user }: { user: PortalUserSSR }) {
  const canEdit = roleHasPermission(user.role, 'edit:stocktakes')
  const [sessions, setSessions] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [scopeLocation, setScopeLocation] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await fetch('/api/workshop/stocktakes')
      if (r.ok) setSessions((await r.json()).stocktakes || [])
      setLastRefresh(new Date())
    } catch { /* keep prior */ } finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  async function startSession() {
    setBusy(true); setMsg('')
    const r = await fetch('/api/workshop/stocktakes', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim(), scope: scopeLocation.trim() ? { location: scopeLocation.trim() } : null }),
    })
    const d = await r.json()
    setBusy(false)
    if (!r.ok) { setMsg(d.error || 'Failed to start'); return }
    setCreating(false); setName(''); setScopeLocation('')
    await load()
  }

  return (
    <>
      <Head><title>Stocktake (Portal) · JA Portal</title></Head>
      <div style={{ display:'flex', flexDirection:'column', height:'100vh', background:T.bg, color:T.text, fontFamily:'"DM Sans", system-ui, sans-serif' }}>
        <PortalTopBar activeId="inventory" lastRefresh={lastRefresh} onRefresh={load} refreshing={loading}
          currentUserRole={user.role} currentUserVisibleTabs={user.visibleTabs} currentUserName={user.displayName} currentUserEmail={user.email} />
        <InventoryTabs active="stocktake2" role={user.role} />
        <div style={{ flex:1, overflowY:'auto' }}>
          <div style={{ maxWidth:1200, margin:'0 auto', padding:'24px 28px' }}>
            <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:16, gap:12, flexWrap:'wrap' }}>
              <div>
                <h1 style={{ fontSize:22, fontWeight:600, margin:0 }}>Stocktake — portal</h1>
                <div style={{ fontSize:11, color:T.text3, marginTop:4 }}>Counts the portal/MYOB stock (workshop inventory). The MechanicDesk stocktake stays on its own tab until MD is retired.</div>
              </div>
              {canEdit && <button onClick={() => setCreating(c => !c)} style={pbtn(T.blue)}>+ New stocktake</button>}
            </div>

            {creating && (
              <div style={{ marginBottom:16, padding:14, background:T.bg2, border:`1px solid ${T.border2}`, borderRadius:8, display:'flex', gap:10, alignItems:'flex-end', flexWrap:'wrap' }}>
                <div style={{ flex:1, minWidth:220 }}>
                  <div style={lbl}>Name</div>
                  <input value={name} onChange={e => setName(e.target.value)} placeholder={`Stocktake ${new Date().toLocaleDateString('en-AU')}`} style={{ ...inp, width:'100%' }} />
                </div>
                <div>
                  <div style={lbl}>Location filter (optional)</div>
                  <input value={scopeLocation} onChange={e => setScopeLocation(e.target.value)} placeholder="e.g. Mezzanine" style={inp} />
                </div>
                <button onClick={startSession} disabled={busy} style={pbtn(T.green)}>{busy ? 'Snapshotting…' : 'Start counting'}</button>
                {msg && <span style={{ fontSize:11, color:T.red }}>{msg}</span>}
              </div>
            )}

            <div style={{ background:T.bg2, border:`1px solid ${T.border}`, borderRadius:8, overflow:'hidden' }}>
              <div style={{ display:'grid', gridTemplateColumns:'80px 1fr 100px 130px 110px 130px 100px', gap:12, padding:'10px 14px', fontSize:10, fontWeight:600, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em', borderBottom:`1px solid ${T.border}`, background:T.bg3 }}>
                <div>#</div><div>Name</div><div>Status</div><div style={{ textAlign:'right' }}>Counted</div><div style={{ textAlign:'right' }}>Variance</div><div style={{ textAlign:'right' }}>Value</div><div style={{ textAlign:'right' }}>Started</div>
              </div>
              {sessions.length === 0 ? (
                loading ? <SkeletonRows rows={8} /> : (
                  <div style={{ padding:30, textAlign:'center', fontSize:13, color:T.text3 }}>No portal stocktakes yet. Start one to snapshot current stock and begin counting.</div>
                )
              ) : sessions.map(s => {
                const meta = STATUS_META[s.status] || { label: s.status, color: T.text3 }
                return (
                  <Link key={s.id} href={`/workshop/stocktake/${s.id}`} style={{ display:'grid', gridTemplateColumns:'80px 1fr 100px 130px 110px 130px 100px', gap:12, padding:'11px 14px', borderTop:`1px solid ${T.border}`, alignItems:'center', fontSize:12, color:T.text, textDecoration:'none' }}>
                    <div style={{ fontFamily:'monospace', color:T.text2 }}>ST-{s.st_seq}</div>
                    <div style={{ overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{s.name}{s.scope_filter?.location ? <span style={{ color:T.text3 }}> · {s.scope_filter.location}</span> : ''}</div>
                    <div><StatusPill label={meta.label} color={meta.color} uppercase={false} /></div>
                    <div style={{ textAlign:'right', fontFamily:'monospace', color:T.text2 }}>{s.counted_count}/{s.item_count}</div>
                    <div style={{ textAlign:'right', fontFamily:'monospace', color: s.variance_qty ? (Number(s.variance_qty) < 0 ? T.red : T.amber) : T.text3 }}>{s.variance_qty != null ? Number(s.variance_qty).toLocaleString() : '—'}</div>
                    <div style={{ textAlign:'right', fontFamily:'monospace', color: s.variance_value ? (Number(s.variance_value) < 0 ? T.red : T.amber) : T.text3 }}>{s.variance_value != null ? money(s.variance_value) : '—'}</div>
                    <div style={{ textAlign:'right', fontFamily:'monospace', fontSize:11, color:T.text3 }}>{new Date(s.created_at).toLocaleDateString('en-AU')}</div>
                  </Link>
                )
              })}
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

const inp: React.CSSProperties = {
  padding:'8px 11px', background:T.bg3, border:`1px solid ${T.border2}`, borderRadius:6,
  color:T.text, fontSize:13, fontFamily:'inherit', outline:'none',
}
const lbl: React.CSSProperties = { fontSize:10, color:T.text3, marginBottom:4, fontWeight:600, textTransform:'uppercase', letterSpacing:'0.05em' }

export async function getServerSideProps(context: any) {
  return requirePageAuth(context, 'view:stocktakes')
}
