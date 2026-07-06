// pages/workshop/reports.tsx
// Workshop reports — MD-parity reporting over the portal workshop tables:
// Daily sales · Received payments · WIP · Income summary · Stock · Technicians.
// One generic { kpis, columns, rows } renderer fed by /api/workshop/reports;
// layout mirrors the autodesk_pro reports screen (tab strip + KPI tiles + table).

import { useCallback, useEffect, useState } from 'react'
import Head from 'next/head'
import dynamic from 'next/dynamic'
import PortalTopBar from '../../lib/PortalTopBar'
import WorkshopTabs from '../../components/WorkshopTabs'
import { requirePageAuth } from '../../lib/authServer'
import type { PortalUserSSR } from '../../lib/authServer'
import { ymdBrisbane, addDaysYmd, weekStartYmd } from '../../lib/workshop'
import { T, Chip, KPI } from '../../components/ui'
import { money } from '../../lib/ui/format'

// The Map & Conversion dashboard is a self-contained Leaflet view (client-only).
const WorkshopMapDashboard = dynamic(() => import('../../components/workshop/WorkshopMapDashboard'), { ssr: false })

// Client-side mirror of WORKSHOP_REPORT_TYPES (lib/workshop-reports.ts is server-only).
// `custom` = renders its own full-bleed view instead of the generic kpis/columns/rows table.
const REPORTS: { id: string; label: string; dateless?: boolean; custom?: boolean }[] = [
  { id: 'daily_sales',       label: 'Daily sales' },
  { id: 'received_payments', label: 'Received payments' },
  { id: 'bookings_won',      label: 'Bookings won' },
  { id: 'wip',               label: 'Work in progress', dateless: true },
  { id: 'income_summary',    label: 'Income summary' },
  { id: 'stock',             label: 'Stock', dateless: true },
  { id: 'tech_productivity', label: 'Technicians' },
  { id: 'map',               label: 'Map & conversion', dateless: true, custom: true },
]

type Preset = 'today' | 'week' | 'month' | 'last_month' | 'custom'

function presetRange(p: Preset): { from: string; to: string } {
  const today = ymdBrisbane(new Date())
  if (p === 'today') return { from: today, to: today }
  if (p === 'week') return { from: weekStartYmd(today), to: today }
  if (p === 'month') return { from: `${today.slice(0, 8)}01`, to: today }
  // last_month: day before this month's 1st → that month's 1st
  const firstThis = `${today.slice(0, 8)}01`
  const lastPrev = addDaysYmd(firstThis, -1)
  return { from: `${lastPrev.slice(0, 8)}01`, to: lastPrev }
}

interface ReportData {
  kpis: { label: string; value: string; accent?: string }[]
  columns: { key: string; label: string; align?: string; money?: boolean }[]
  rows: Record<string, any>[]
  chart?: { label: string; value: number }[]
}

export default function WorkshopReportsPage({ user }: { user: PortalUserSSR }) {
  const [type, setType] = useState('daily_sales')
  const [preset, setPreset] = useState<Preset>('week')
  const [range, setRange] = useState(() => presetRange('week'))
  const [data, setData] = useState<ReportData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null)

  const report = REPORTS.find(r => r.id === type)
  const dateless = report?.dateless
  const custom = report?.custom

  const load = useCallback(async () => {
    if (REPORTS.find(r => r.id === type)?.custom) { setLoading(false); setError(''); return }
    setLoading(true); setError('')
    try {
      const r = await fetch(`/api/workshop/reports?type=${type}&from=${range.from}&to=${range.to}`)
      const d = await r.json()
      if (r.ok) setData(d)
      else { setData(null); setError(d.error || 'Failed to run report') }
      setLastRefresh(new Date())
    } catch { setError('Failed to run report') } finally { setLoading(false) }
  }, [type, range])

  useEffect(() => { load() }, [load])

  function pickPreset(p: Preset) {
    setPreset(p)
    if (p !== 'custom') setRange(presetRange(p))
  }

  return (
    <>
      <Head><title>Workshop reports — Just Autos</title><meta name="robots" content="noindex,nofollow"/></Head>
      <div style={{ display:'flex', flexDirection:'column', height:'100vh', overflow:'hidden', fontFamily:"'DM Sans',system-ui,sans-serif", color:T.text }}>
        <PortalTopBar activeId="diary" lastRefresh={lastRefresh} onRefresh={load} refreshing={loading}
          currentUserRole={user.role} currentUserVisibleTabs={user.visibleTabs} currentUserName={user.displayName} currentUserEmail={user.email} />
        <WorkshopTabs active="reports" role={user.role} />

        <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden', background:T.bg }}>
          <div style={{ background:T.bg2, borderBottom:`1px solid ${T.border}`, padding:'10px 20px', display:'flex', alignItems:'center', gap:10, flexWrap:'wrap', flexShrink:0 }}>
            <span style={{ fontSize:14, fontWeight:600 }}>Reports</span>
            <div style={{ display:'flex', gap:4, marginLeft:8 }}>
              {REPORTS.map(r => <Chip key={r.id} label={r.label} active={type===r.id} onClick={() => setType(r.id)} />)}
            </div>

            <div style={{ flex:1 }} />

            {!dateless && (
              <>
                <div style={{ display:'flex', gap:4 }}>
                  <Chip label="Today" active={preset==='today'} onClick={() => pickPreset('today')} />
                  <Chip label="This week" active={preset==='week'} onClick={() => pickPreset('week')} />
                  <Chip label="This month" active={preset==='month'} onClick={() => pickPreset('month')} />
                  <Chip label="Last month" active={preset==='last_month'} onClick={() => pickPreset('last_month')} />
                </div>
                <input type="date" value={range.from} max={range.to}
                  onChange={e => { setPreset('custom'); setRange(r => ({ ...r, from: e.target.value || r.from })) }} style={dateInp} />
                <span style={{ color:T.text3, fontSize:11 }}>→</span>
                <input type="date" value={range.to} min={range.from}
                  onChange={e => { setPreset('custom'); setRange(r => ({ ...r, to: e.target.value || r.to })) }} style={dateInp} />
              </>
            )}

            {!custom && (
              <a href={`/api/workshop/reports?type=${type}&from=${range.from}&to=${range.to}&format=csv`}
                style={{ padding:'5px 12px', borderRadius:4, fontSize:11, fontWeight:600, background:`${T.blue}1f`, color:T.blue, border:`1px solid ${T.blue}55`, textDecoration:'none' }}>
                ⬇ CSV
              </a>
            )}
          </div>

          {custom ? (
            <div style={{ flex:1, minHeight:0 }}>
              {type === 'map' && <WorkshopMapDashboard />}
            </div>
          ) : (
          <div style={{ flex:1, overflow:'auto', padding:20 }}>
            <div style={{ margin:'0 auto' }}>
              {error && <div style={{ padding:'10px 14px', marginBottom:14, background:`${T.red}14`, border:`1px solid ${T.red}44`, borderRadius:8, color:T.red, fontSize:12 }}>{error}</div>}

              {/* KPI tiles */}
              {data && data.kpis.length > 0 && (
                <div style={{ display:'grid', gridTemplateColumns:`repeat(auto-fit, minmax(180px, 1fr))`, gap:12, marginBottom:16 }}>
                  {data.kpis.map((k, i) => (
                    <KPI key={i} label={k.label} value={k.value} accent={k.accent} />
                  ))}
                </div>
              )}

              {/* Bar chart (reports that supply per-day values, e.g. Bookings won) */}
              {data && data.chart && data.chart.length > 0 && data.chart.some(c => c.value > 0) && (
                <div style={{ background:T.bg2, border:`1px solid ${T.border}`, borderRadius:10, padding:'16px 16px 8px', marginBottom:16 }}>
                  <div style={{ display:'flex', alignItems:'flex-end', gap:3, height:150 }}>
                    {data.chart.map((c, i) => {
                      const max = Math.max(...data.chart!.map(x => x.value), 1)
                      const h = c.value > 0 ? Math.max(4, (c.value / max) * 130) : 2
                      return (
                        <div key={i} title={c.label} style={{ flex:1, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'flex-end', minWidth:0, height:'100%' }}>
                          {data.chart!.length <= 45 && c.value > 0 && (
                            <span style={{ fontSize:9, color:T.text3, fontFamily:'monospace', marginBottom:2 }}>{c.value}</span>
                          )}
                          <div style={{ width:'100%', maxWidth:34, height:h, background: c.value > 0 ? T.accent : T.border, borderRadius:'3px 3px 0 0', opacity: c.value > 0 ? 0.9 : 0.5 }} />
                        </div>
                      )
                    })}
                  </div>
                  {data.chart.length <= 45 && (
                    <div style={{ display:'flex', gap:3, marginTop:4 }}>
                      {data.chart.map((c, i) => (
                        <div key={i} style={{ flex:1, fontSize:8, color:T.text3, textAlign:'center', overflow:'hidden', whiteSpace:'nowrap', textOverflow:'ellipsis', minWidth:0 }}>
                          {c.label.split(' — ')[0].replace(/^\w+ /, '')}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Table */}
              <div style={{ background:T.bg2, border:`1px solid ${T.border}`, borderRadius:10, overflow:'hidden' }}>
                {loading && !data ? (
                  <div style={{ padding:40, textAlign:'center', color:T.text3, fontSize:12 }}>Running report…</div>
                ) : !data || data.rows.length === 0 ? (
                  <div style={{ padding:40, textAlign:'center', color:T.text3, fontSize:12 }}>No data for this period.</div>
                ) : (
                  <div style={{ overflowX:'auto' }}>
                    <table style={{ width:'100%', borderCollapse:'collapse' }}>
                      <thead>
                        <tr style={{ background:T.bg3 }}>
                          {data.columns.map(c => (
                            <th key={c.key} style={{ padding:'9px 14px', fontSize:9, color:T.text3, fontWeight:600, textTransform:'uppercase', letterSpacing:'0.05em', textAlign: c.align === 'right' ? 'right' : 'left', borderBottom:`1px solid ${T.border}`, whiteSpace:'nowrap' }}>{c.label}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {data.rows.map((r, i) => (
                          <tr key={i} style={{ borderTop: i ? `1px solid ${T.border}` : 'none' }}>
                            {data.columns.map(c => {
                              const v = r[c.key]
                              const neg = c.money && Number(v) < 0
                              return (
                                <td key={c.key} style={{
                                  padding:'9px 14px', fontSize:12, whiteSpace:'nowrap',
                                  textAlign: c.align === 'right' ? 'right' : 'left',
                                  fontFamily: c.money || typeof v === 'number' ? 'monospace' : 'inherit',
                                  fontVariantNumeric:'tabular-nums',
                                  color: neg ? T.red : T.text,
                                }}>
                                  {c.money ? money(v) : (v ?? '—')}
                                </td>
                              )
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          </div>
          )}
        </div>
      </div>
    </>
  )
}

const dateInp: React.CSSProperties = {
  padding:'4px 8px', background:T.bg3, border:`1px solid ${T.border2}`, borderRadius:4,
  color:T.text, fontSize:11, fontFamily:'inherit', colorScheme:'dark',
}

export async function getServerSideProps(context: any) {
  return requirePageAuth(context, 'view:reports')
}
