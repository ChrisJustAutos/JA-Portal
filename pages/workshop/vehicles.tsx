// pages/workshop/vehicles.tsx
// Global vehicle search — rego / VIN / make-model / owner name, paginated,
// with Due soon / Overdue filters driven by the service-due fields (086).
// Click a row to open the vehicle detail page.

import { useEffect, useState, useCallback, useRef } from 'react'
import Head from 'next/head'
import Link from 'next/link'
import { useRouter } from 'next/router'
import PortalTopBar from '../../lib/PortalTopBar'
import WorkshopTabs from '../../components/WorkshopTabs'
import { requirePageAuth } from '../../lib/authServer'
import type { PortalUserSSR } from '../../lib/authServer'
import { ymdBrisbane } from '../../lib/workshop'
import { T, pagerBtn, SkeletonRows } from '../../components/ui'
import { useIsMobile } from '../../lib/useIsMobile'

interface VehicleRow {
  id: string; rego: string | null; make: string | null; model: string | null; year: number | null
  vin: string | null; odometer: number | null
  next_service_due_date: string | null; next_service_due_km: number | null; rego_due_date: string | null
  customer: { id: string; name: string; mobile: string | null; phone: string | null } | null
}

const PAGE = 50
type DueFilter = 'all' | 'soon' | 'overdue'

const fmtDue = (ymd: string | null) => ymd ? new Date(`${ymd}T00:00:00+10:00`).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: '2-digit' }) : '—'

export default function VehiclesPage({ user }: { user: PortalUserSSR }) {
  const router = useRouter()
  const [q, setQ] = useState('')
  const [debouncedQ, setDebouncedQ] = useState('')
  const [due, setDue] = useState<DueFilter>(() => (router.query.due === 'soon' || router.query.due === 'overdue') ? router.query.due : 'all')
  const [vehicles, setVehicles] = useState<VehicleRow[]>([])
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [loading, setLoading] = useState(false)
  const timer = useRef<any>(null)
  const today = ymdBrisbane(new Date())
  const isMobile = useIsMobile()

  useEffect(() => {
    const d = router.query.due
    if (d === 'soon' || d === 'overdue') setDue(d)
  }, [router.query.due])

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => { setDebouncedQ(q); setOffset(0) }, 200)
    return () => { if (timer.current) clearTimeout(timer.current) }
  }, [q])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ list: '1', limit: String(PAGE), offset: String(offset) })
      if (debouncedQ) params.set('q', debouncedQ)
      if (due !== 'all') params.set('due', due)
      const r = await fetch(`/api/workshop/vehicles?${params}`)
      const d = await r.json()
      if (r.ok) { setVehicles(d.vehicles || []); setTotal(d.total || 0) }
    } catch { /* keep prior */ } finally { setLoading(false) }
  }, [debouncedQ, due, offset])

  useEffect(() => { load() }, [load])

  const dueColor = (ymd: string | null) => !ymd ? T.text3 : ymd < today ? T.red : T.amber

  const pageStart = offset + 1
  const pageEnd = Math.min(offset + PAGE, total)

  return (
    <>
      <Head><title>Vehicles · JA Portal</title></Head>
      <div style={{ display:'flex', flexDirection:'column', height:'100vh', background:T.bg, color:T.text, fontFamily:'"DM Sans", system-ui, sans-serif' }}>
        <PortalTopBar activeId="diary" currentUserRole={user.role} currentUserVisibleTabs={user.visibleTabs} currentUserName={user.displayName} currentUserEmail={user.email} />
        <WorkshopTabs active="vehicles" role={user.role} />
        <div style={{ flex:1, overflowY:'auto' }}>
          <div style={{ margin:'0 auto', padding:'24px 28px' }}>
            <div style={{ display:'flex', alignItems:'baseline', justifyContent:'space-between', marginBottom:18, gap:16, flexWrap:'wrap' }}>
              <h1 style={{ fontSize:22, fontWeight:600, margin:0 }}>Vehicles</h1>
              <div style={{ fontSize:11, color:T.text3 }}>{total.toLocaleString()} {due !== 'all' ? `due ${due === 'soon' ? 'soon' : '— overdue'}` : 'total'}{debouncedQ ? ` matching "${debouncedQ}"` : ''}</div>
            </div>

            <div style={{ display:'flex', gap:10, marginBottom:14, alignItems:'center', flexWrap:'wrap' }}>
              <div style={{ position:'relative', flex:1, minWidth:260 }}>
                <input
                  autoFocus value={q} onChange={e => setQ(e.target.value)}
                  placeholder="Search rego, VIN, make/model, or owner name…"
                  style={{ width:'100%', padding:'10px 14px', background:T.bg2, border:`1px solid ${T.border2}`, borderRadius:8, color:T.text, fontSize:14, fontFamily:'inherit', outline:'none' }}
                />
                {loading && <span style={{ position:'absolute', right:14, top:'50%', transform:'translateY(-50%)', fontSize:11, color:T.text3 }}>Loading…</span>}
              </div>
              <div style={{ display:'flex', gap:4, flexShrink:0 }}>
                <Chip label="All" active={due==='all'} onClick={() => { setDue('all'); setOffset(0) }} />
                <Chip label="Due soon" active={due==='soon'} onClick={() => { setDue('soon'); setOffset(0) }} c={T.amber} />
                <Chip label="Overdue" active={due==='overdue'} onClick={() => { setDue('overdue'); setOffset(0) }} c={T.red} />
              </div>
            </div>

            {isMobile ? (
              /* ─── MOBILE: card stack ─── */
              <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
                {vehicles.length === 0 ? (
                  loading ? (
                    <div style={{ background:T.bg2, border:`1px solid ${T.border}`, borderRadius:8, overflow:'hidden' }}><SkeletonRows rows={8} /></div>
                  ) : (
                    <div style={{ padding:30, textAlign:'center', fontSize:13, color:T.text3, background:T.bg2, border:`1px solid ${T.border}`, borderRadius:8 }}>{debouncedQ ? `No vehicles match "${debouncedQ}"` : due !== 'all' ? 'Nothing due. 🎉' : 'No vehicles'}</div>
                  )
                ) : vehicles.map(v => (
                  <Link key={v.id} href={`/workshop/vehicle/${v.id}`} style={{ display:'block', background:T.bg2, border:`1px solid ${T.border}`, borderRadius:10, padding:'12px 14px', color:T.text, textDecoration:'none' }}>
                    <div style={{ display:'flex', alignItems:'baseline', gap:8, marginBottom:2 }}>
                      <span style={{ fontFamily:'monospace', fontWeight:600, fontSize:14 }}>{v.rego ? v.rego.toUpperCase() : '—'}</span>
                      <span style={{ fontSize:12, color:T.text2, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{[v.year, v.make, v.model].filter(Boolean).join(' ') || '—'}</span>
                    </div>
                    <div style={{ fontSize:12, color:T.text2 }}>{v.customer?.name || <span style={{ color:T.text3 }}>no owner</span>}</div>
                    {v.vin && <div style={{ fontSize:10, color:T.text3, fontFamily:'monospace', marginTop:2, overflow:'hidden', textOverflow:'ellipsis' }}>{v.vin}</div>}
                    <div style={{ display:'flex', gap:14, marginTop:6, fontSize:11, fontFamily:'monospace' }}>
                      <span style={{ color:T.text2 }}>{v.odometer ? `${Number(v.odometer).toLocaleString()} km` : '— km'}</span>
                      <span style={{ color: dueColor(v.next_service_due_date) }}>Svc {fmtDue(v.next_service_due_date)}</span>
                      <span style={{ color: dueColor(v.rego_due_date) }}>Rego {fmtDue(v.rego_due_date)}</span>
                    </div>
                  </Link>
                ))}
              </div>
            ) : (
              /* ─── DESKTOP: grid table ─── */
              <div style={{ background:T.bg2, border:`1px solid ${T.border}`, borderRadius:8, overflow:'hidden' }}>
                <div style={{ display:'grid', gridTemplateColumns:'90px 1.4fr 1.2fr 150px 90px 110px 100px', gap:12, padding:'10px 14px', fontSize:10, fontWeight:600, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em', borderBottom:`1px solid ${T.border}`, background:T.bg3 }}>
                  <div>Rego</div><div>Vehicle</div><div>Owner</div><div>VIN</div><div style={{ textAlign:'right' }}>KMs</div><div style={{ textAlign:'right' }}>Service due</div><div style={{ textAlign:'right' }}>Rego due</div>
                </div>
                {vehicles.length === 0 ? (
                  loading ? <SkeletonRows rows={8} /> : (
                    <div style={{ padding:30, textAlign:'center', fontSize:13, color:T.text3 }}>{debouncedQ ? `No vehicles match "${debouncedQ}"` : due !== 'all' ? 'Nothing due. 🎉' : 'No vehicles'}</div>
                  )
                ) : vehicles.map(v => (
                  <Link key={v.id} href={`/workshop/vehicle/${v.id}`} style={{ display:'grid', gridTemplateColumns:'90px 1.4fr 1.2fr 150px 90px 110px 100px', gap:12, padding:'10px 14px', borderTop:`1px solid ${T.border}`, alignItems:'center', fontSize:12, color:T.text, textDecoration:'none' }}>
                    <div style={{ fontFamily:'monospace', fontWeight:600 }}>{v.rego ? v.rego.toUpperCase() : '—'}</div>
                    <div style={{ overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{[v.year, v.make, v.model].filter(Boolean).join(' ') || '—'}</div>
                    <div style={{ color:T.text2, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{v.customer?.name || <span style={{ color:T.text3 }}>no owner</span>}</div>
                    <div style={{ color:T.text3, fontFamily:'monospace', fontSize:10, overflow:'hidden', textOverflow:'ellipsis' }}>{v.vin || '—'}</div>
                    <div style={{ color:T.text2, fontFamily:'monospace', fontSize:11, textAlign:'right' }}>{v.odometer ? Number(v.odometer).toLocaleString() : '—'}</div>
                    <div style={{ fontFamily:'monospace', fontSize:11, textAlign:'right', color: dueColor(v.next_service_due_date) }}>{fmtDue(v.next_service_due_date)}</div>
                    <div style={{ fontFamily:'monospace', fontSize:11, textAlign:'right', color: dueColor(v.rego_due_date) }}>{fmtDue(v.rego_due_date)}</div>
                  </Link>
                ))}
              </div>
            )}

            {total > PAGE && (
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginTop:14, fontSize:12, color:T.text3 }}>
                <div>Showing {pageStart.toLocaleString()}–{pageEnd.toLocaleString()} of {total.toLocaleString()}</div>
                <div style={{ display:'flex', gap:6 }}>
                  <button disabled={offset === 0 || loading} onClick={() => setOffset(Math.max(0, offset - PAGE))} style={pagerBtn(offset === 0)}>← Prev</button>
                  <button disabled={offset + PAGE >= total || loading} onClick={() => setOffset(offset + PAGE)} style={pagerBtn(offset + PAGE >= total)}>Next →</button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  )
}

function Chip({ label, active, onClick, c }: { label: string; active: boolean; onClick: () => void; c?: string }) {
  const accent = c || T.blue
  return (
    <button onClick={onClick} style={{
      padding:'8px 14px', borderRadius:6, fontSize:12, fontFamily:'inherit', fontWeight:600,
      background: active ? `${accent}1f` : T.bg2, color: active ? accent : T.text2,
      border: `1px solid ${active ? accent + '55' : T.border2}`, cursor:'pointer',
    }}>{label}</button>
  )
}

export async function getServerSideProps(context: any) {
  return requirePageAuth(context, 'view:diary')
}
