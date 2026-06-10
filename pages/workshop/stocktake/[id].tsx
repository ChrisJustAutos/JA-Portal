// pages/workshop/stocktake/[id].tsx
// Stocktake count screen — barcode-scanner friendly: the search box stays
// focused; scanners type the code + Enter which jumps to the matching item,
// type the count, Enter saves and refocuses the search. Tabs: Count (all /
// uncounted) · Variance · Apply.

import { useCallback, useEffect, useRef, useState } from 'react'
import Head from 'next/head'
import Link from 'next/link'
import { useRouter } from 'next/router'
import PortalTopBar from '../../../lib/PortalTopBar'
import InventoryTabs from '../../../components/InventoryTabs'
import { requirePageAuth } from '../../../lib/authServer'
import { roleHasPermission } from '../../../lib/permissions'

interface PortalUserSSR { id: string; email: string; displayName: string | null; role: 'admin'|'manager'|'sales'|'accountant'|'viewer'|'workshop'; visibleTabs?: string[] | null }

const T = {
  bg: '#0d0f12', bg2: '#131519', bg3: '#1a1d23', bg4: '#21252d',
  border: 'rgba(255,255,255,0.07)', border2: 'rgba(255,255,255,0.12)',
  text: '#e8eaf0', text2: '#8b90a0', text3: '#545968',
  blue: '#4f8ef7', teal: '#2dd4bf', green: '#34c77b', amber: '#f5a623', red: '#f04e4e',
}
const money = (n: any) => `$${(Number(n) || 0).toFixed(2)}`

type Filter = 'all' | 'uncounted' | 'variance'

export default function WorkshopStocktakeCountPage({ user }: { user: PortalUserSSR }) {
  const router = useRouter()
  const id = String(router.query.id || '')
  const canEdit = roleHasPermission(user.role, 'edit:stocktakes')
  const [data, setData] = useState<any | null>(null)
  const [q, setQ] = useState('')
  const [debouncedQ, setDebouncedQ] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [applyOpen, setApplyOpen] = useState(false)
  const [policy, setPolicy] = useState<'keep' | 'zero'>('keep')
  const [applyBusy, setApplyBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const timer = useRef<any>(null)

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setDebouncedQ(q), 150)
    return () => { if (timer.current) clearTimeout(timer.current) }
  }, [q])

  const load = useCallback(async () => {
    if (!id) return
    try {
      const params = new URLSearchParams()
      if (debouncedQ) params.set('q', debouncedQ)
      if (filter !== 'all') params.set('filter', filter)
      const r = await fetch(`/api/workshop/stocktakes/${id}?${params}`)
      if (r.ok) setData(await r.json())
    } catch { /* keep prior */ }
  }, [id, debouncedQ, filter])

  useEffect(() => { load() }, [load])

  async function saveCount(itemId: string, value: string) {
    const qty = value.trim() === '' ? null : Number(value)
    await fetch(`/api/workshop/stocktakes/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ item_id: itemId, counted_qty: qty }),
    })
    await load()
  }

  async function apply() {
    setApplyBusy(true); setMsg('')
    const r = await fetch(`/api/workshop/stocktakes/${id}?apply=1`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uncounted_policy: policy }),
    })
    const d = await r.json()
    setApplyBusy(false)
    if (!r.ok) { setMsg(d.error || 'Apply failed'); return }
    setApplyOpen(false)
    setMsg(d.myobWarning || `Applied — ${d.applied} adjustments, variance ${d.varianceQty} units / ${money(d.varianceValue)}${d.postedToMyob ? ' (posted to MYOB)' : ''}`)
    await load()
  }

  const st = data?.stocktake
  const sum = data?.summary
  const items: any[] = data?.items || []
  const isOpen = st && (st.status === 'counting' || st.status === 'review')
  const progress = st ? Math.round(((sum?.counted || 0) / Math.max(1, st.item_count)) * 100) : 0

  return (
    <>
      <Head><title>{st ? `ST-${st.st_seq} ${st.name}` : 'Stocktake'} · JA Portal</title></Head>
      <div style={{ display:'flex', flexDirection:'column', height:'100vh', background:T.bg, color:T.text, fontFamily:'"DM Sans", system-ui, sans-serif' }}>
        <PortalTopBar activeId="inventory" currentUserRole={user.role} currentUserVisibleTabs={user.visibleTabs} currentUserName={user.displayName} currentUserEmail={user.email} />
        <InventoryTabs active="stocktake2" role={user.role} />
        <div style={{ flex:1, overflowY:'auto' }}>
          <div style={{ maxWidth:1200, margin:'0 auto', padding:'20px 28px' }}>
            <Link href="/workshop/stocktake" style={{ fontSize:11, color:T.text3, textDecoration:'none', fontFamily:'monospace' }}>← Stocktakes</Link>
            {!st && <div style={{ marginTop:14, fontSize:13, color:T.text3 }}>Loading…</div>}

            {st && (
              <>
                <div style={{ display:'flex', alignItems:'center', gap:14, marginTop:10, marginBottom:14, flexWrap:'wrap' }}>
                  <h1 style={{ fontSize:20, fontWeight:600, margin:0 }}>ST-{st.st_seq} · {st.name}</h1>
                  <span style={{ fontSize:11, color:T.text3 }}>{st.status.toUpperCase()}{st.scope_filter?.location ? ` · ${st.scope_filter.location}` : ''}</span>
                  <div style={{ flex:1 }} />
                  {isOpen && canEdit && <button onClick={() => setApplyOpen(o => !o)} style={pbtn(T.green)}>✓ Review & apply</button>}
                </div>

                {/* Progress */}
                <div style={{ marginBottom:14 }}>
                  <div style={{ display:'flex', justifyContent:'space-between', fontSize:11, color:T.text3, marginBottom:4 }}>
                    <span>{sum?.counted || 0} of {st.item_count} counted · {sum?.uncounted || 0} remaining</span>
                    <span>{sum?.adjustments || 0} variances · {money(sum?.varianceValue || 0)}</span>
                  </div>
                  <div style={{ height:6, background:T.bg3, borderRadius:3, overflow:'hidden' }}>
                    <div style={{ width:`${progress}%`, height:'100%', background: progress === 100 ? T.green : T.blue, transition:'width 0.3s ease' }} />
                  </div>
                </div>

                {msg && <div style={{ marginBottom:12, padding:'8px 12px', background:`${T.amber}14`, border:`1px solid ${T.amber}44`, borderRadius:6, fontSize:12, color:T.amber }}>{msg}</div>}

                {applyOpen && isOpen && (
                  <div style={{ marginBottom:14, padding:14, background:T.bg2, border:`1px solid ${T.green}55`, borderRadius:8 }}>
                    <div style={{ fontSize:12, fontWeight:600, marginBottom:8 }}>Apply stocktake — {sum?.adjustments || 0} quantity adjustments, variance value {money(sum?.varianceValue || 0)}</div>
                    <div style={{ display:'flex', gap:14, alignItems:'center', flexWrap:'wrap', fontSize:12 }}>
                      <label style={{ display:'flex', gap:6, alignItems:'center', cursor:'pointer' }}>
                        <input type="radio" checked={policy==='keep'} onChange={() => setPolicy('keep')} /> Leave uncounted items as-is ({sum?.uncounted || 0})
                      </label>
                      <label style={{ display:'flex', gap:6, alignItems:'center', cursor:'pointer' }}>
                        <input type="radio" checked={policy==='zero'} onChange={() => setPolicy('zero')} /> Zero uncounted items
                      </label>
                      <div style={{ flex:1 }} />
                      <button onClick={() => setApplyOpen(false)} style={pbtn(T.text3)}>Cancel</button>
                      <button onClick={apply} disabled={applyBusy} style={pbtn(T.green)}>{applyBusy ? 'Applying…' : 'Apply adjustments'}</button>
                    </div>
                    <div style={{ fontSize:10, color:T.text3, marginTop:8, lineHeight:1.5 }}>
                      With MYOB posting ON this writes one Inventory Adjustment to MYOB (against the configured adjustment account) and re-syncs quantities. With posting OFF it adjusts portal quantities only — a later MYOB sync will overwrite them.
                    </div>
                  </div>
                )}

                {/* Search + filters */}
                <div style={{ display:'flex', gap:8, marginBottom:12, alignItems:'center', flexWrap:'wrap' }}>
                  <input ref={searchRef} autoFocus value={q} onChange={e => setQ(e.target.value)}
                    placeholder="Scan barcode or search SKU / part name…"
                    style={{ flex:1, minWidth:240, padding:'9px 13px', background:T.bg2, border:`1px solid ${T.border2}`, borderRadius:7, color:T.text, fontSize:13, fontFamily:'inherit', outline:'none' }} />
                  <Chip label="All" active={filter==='all'} onClick={() => setFilter('all')} />
                  <Chip label="Uncounted" active={filter==='uncounted'} onClick={() => setFilter('uncounted')} c={T.amber} />
                  <Chip label="Variance" active={filter==='variance'} onClick={() => setFilter('variance')} c={T.red} />
                  {data && data.itemTotal > items.length && <span style={{ fontSize:10, color:T.text3 }}>showing {items.length} of {data.itemTotal}</span>}
                </div>

                {/* Items */}
                <div style={{ background:T.bg2, border:`1px solid ${T.border}`, borderRadius:8, overflow:'hidden' }}>
                  <div style={{ display:'grid', gridTemplateColumns:'130px 1fr 110px 90px 110px 90px', gap:12, padding:'9px 14px', fontSize:10, fontWeight:600, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em', borderBottom:`1px solid ${T.border}`, background:T.bg3 }}>
                    <div>SKU</div><div>Part</div><div>Location / bin</div><div style={{ textAlign:'right' }}>System</div><div style={{ textAlign:'right' }}>Counted</div><div style={{ textAlign:'right' }}>Δ</div>
                  </div>
                  {items.length === 0 ? (
                    <div style={{ padding:30, textAlign:'center', fontSize:13, color:T.text3 }}>{debouncedQ ? 'No items match.' : 'No items.'}</div>
                  ) : items.map(it => (
                    <CountRow key={it.id} item={it} canEdit={!!(canEdit && isOpen)} onSave={saveCount}
                      onSaved={() => { setQ(''); searchRef.current?.focus() }} />
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </>
  )
}

function CountRow({ item, canEdit, onSave, onSaved }: { item: any; canEdit: boolean; onSave: (id: string, v: string) => Promise<void>; onSaved: () => void }) {
  const [val, setVal] = useState(item.counted_qty != null ? String(item.counted_qty) : '')
  useEffect(() => { setVal(item.counted_qty != null ? String(item.counted_qty) : '') }, [item.counted_qty])
  const sysQty = Number(item.system_qty) || 0
  const counted = item.counted_qty != null
  const delta = counted ? (Number(item.counted_qty) || 0) - sysQty : null
  async function commit() {
    if ((val.trim() === '' && item.counted_qty == null) || val === String(item.counted_qty ?? '')) return
    await onSave(item.id, val)
    onSaved()
  }
  return (
    <div style={{ display:'grid', gridTemplateColumns:'130px 1fr 110px 90px 110px 90px', gap:12, padding:'8px 14px', borderTop:`1px solid ${T.border}`, alignItems:'center', fontSize:12, background: counted ? 'transparent' : 'rgba(245,166,35,0.03)' }}>
      <div style={{ fontFamily:'monospace', fontSize:11, color:T.text2, overflow:'hidden', textOverflow:'ellipsis' }}>{item.sku || '—'}</div>
      <div style={{ overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{item.part_name || '—'}</div>
      <div style={{ fontSize:10, color:T.text3, overflow:'hidden', textOverflow:'ellipsis' }}>{[item.location, item.bin].filter(Boolean).join(' / ') || '—'}</div>
      <div style={{ textAlign:'right', fontFamily:'monospace', color:T.text2 }}>{sysQty}</div>
      <div style={{ textAlign:'right' }}>
        {canEdit ? (
          <input value={val} inputMode="decimal" placeholder="—"
            onChange={e => setVal(e.target.value)}
            onBlur={commit}
            onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
            style={{ width:70, padding:'5px 8px', textAlign:'right', background:T.bg3, border:`1px solid ${counted ? T.border2 : T.amber + '66'}`, borderRadius:5, color:T.text, fontSize:12, fontFamily:'monospace', outline:'none' }} />
        ) : (
          <span style={{ fontFamily:'monospace', color: counted ? T.text : T.text3 }}>{counted ? item.counted_qty : '—'}</span>
        )}
      </div>
      <div style={{ textAlign:'right', fontFamily:'monospace', fontWeight:600, color: delta == null ? T.text3 : delta === 0 ? T.green : delta < 0 ? T.red : T.amber }}>
        {delta == null ? '' : delta === 0 ? '✓' : (delta > 0 ? `+${delta}` : delta)}
      </div>
    </div>
  )
}

function Chip({ label, active, onClick, c }: { label: string; active: boolean; onClick: () => void; c?: string }) {
  const accent = c || T.blue
  return (
    <button onClick={onClick} style={{
      padding:'7px 13px', borderRadius:6, fontSize:12, fontFamily:'inherit', fontWeight:600,
      background: active ? `${accent}1f` : T.bg2, color: active ? accent : T.text2,
      border: `1px solid ${active ? accent + '55' : T.border2}`, cursor:'pointer',
    }}>{label}</button>
  )
}

const pbtn = (c: string): React.CSSProperties => ({
  padding:'8px 16px', borderRadius:6, fontSize:12, fontFamily:'inherit', fontWeight:600,
  background:`${c}1e`, color:c, border:`1px solid ${c}55`, cursor:'pointer',
})

export async function getServerSideProps(context: any) {
  return requirePageAuth(context, 'view:stocktakes')
}
