// components/workshop/WorkshopMapDashboard.tsx
// Workshop Map & Conversion dashboard (Reports → Map & conversion).
// Faithful React port of the static JA_FY2026_Workshop_Dashboard.html build —
// same three tabs (Jobs Map / Quotes Map / Conversion), month strip, vehicle
// chips, CartoDB dark tiles + embedded AU state polygons, popups and
// conversion table. Reads the prebuilt per-FY payload from /api/workshop/map
// (cached by the daily MechanicDesk pull); all filtering is client-side.
//
// Client-only (Leaflet) — import with next/dynamic { ssr: false }.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Head from 'next/head'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

type ViewKey = 'jobs' | 'quotes' | 'conv'

interface Pt { la: number; ln: number; pc: string; l: string; m: number; g: string; c: string; a: number; j?: string; i?: string; x?: number; w?: number }
interface Payload {
  fy: number
  months: { k: string; label: string }[]
  cats: { k: string; n: string; col: string }[]
  jobs: { points: Pt[]; meta: { customers: number; mapped: number; clean_total: number; inferred: number } }
  quotes: { points: Pt[]; meta: { total_quotes: number; mapped: number; total_value: number } }
  conv: { qcount: Record<string, number[]>; qval: Record<string, number[]>; jcount: Record<string, number[]> }
}
interface ApiResp {
  fy: number | null
  fys: number[]
  payload: Payload | null
  synced_at: string | null
  last_run: { id: string; status: string; started_at: string; completed_at: string | null; error: string | null; invoice_count: number | null; quote_count: number | null } | null
}

const fmt = (n: number) => '$' + Math.round(n).toLocaleString('en-AU')
const fmtK = (n: number) => n >= 1e6 ? '$' + (n / 1e6).toFixed(2) + 'M' : n >= 1000 ? '$' + (n / 1000).toFixed(n >= 100000 ? 0 : 1) + 'k' : '$' + Math.round(n)
const esc = (s: any) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const CK = ['70', '200', '300', 'HILUX', 'PRADO']
const convColor = (p: number) => p >= 12 ? '#47FFCF' : p >= 8 ? '#9be7c4' : p >= 5 ? '#FFB454' : '#e0707a'

export default function WorkshopMapDashboard() {
  const [data, setData] = useState<ApiResp | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [view, setView] = useState<ViewKey>('jobs')
  const [month, setMonth] = useState(-1)          // -1 = all FY
  const [cat, setCat] = useState('all')
  const [refreshing, setRefreshing] = useState(false)
  const [refreshMsg, setRefreshMsg] = useState('')

  const mapRef = useRef<L.Map | null>(null)
  const layerRef = useRef<L.LayerGroup | null>(null)
  const boundsRef = useRef<L.LatLngBounds | null>(null)
  const mapDivRef = useRef<HTMLDivElement | null>(null)

  const load = useCallback(async (fy?: number) => {
    setLoading(true); setError('')
    try {
      const r = await fetch(`/api/workshop/map${fy ? `?fy=${fy}` : ''}`)
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || 'Failed to load map data')
      setData(d)
    } catch (e: any) { setError(e?.message || 'Failed to load map data') }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])

  const P = data?.payload || null
  const COL = useMemo(() => Object.fromEntries((P?.cats || []).map(c => [c.k, c.col])), [P])
  const NAME = useMemo(() => Object.fromEntries((P?.cats || []).map(c => [c.k, c.n])), [P])

  // ── Map bootstrap (once the payload exists so the div is mounted) ──────
  useEffect(() => {
    if (!P || !mapDivRef.current || mapRef.current) return
    const map = L.map(mapDivRef.current, { zoomControl: true, attributionControl: false, minZoom: 3 }).setView([-25.8, 134], 4)
    map.createPane('landPane'); map.getPane('landPane')!.style.zIndex = '250'
    map.createPane('lblPane'); map.getPane('lblPane')!.style.zIndex = '360'; map.getPane('lblPane')!.style.pointerEvents = 'none'
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { maxZoom: 19, subdomains: 'abcd' }).addTo(map)
    // Embedded AU state polygons — the country renders even if tiles are blocked.
    fetch('/map/au-states.min.geojson').then(r => r.json()).then(geo => {
      if (!mapRef.current) return
      const states = L.geoJSON(geo, { pane: 'landPane', style: { color: '#4a6076', weight: 1.4, opacity: .95, fillColor: '#172230', fillOpacity: .78 } }).addTo(map)
      const bounds = states.getBounds().pad(.04)
      boundsRef.current = bounds
      map.fitBounds(bounds)
    }).catch(() => undefined)
    const stateLbls: [string, number, number][] = [['WA', -26, 121.5], ['NT', -19.5, 133.4], ['SA', -30.2, 135.6], ['QLD', -22.8, 144.2], ['NSW', -32.3, 146.8], ['VIC', -36.9, 143.9], ['TAS', -42, 146.6]]
    // className:'' — the default leaflet-div-icon adds an unwanted white box.
    stateLbls.forEach(([t, la, lo]) => L.marker([la, lo], { pane: 'lblPane', interactive: false, icon: L.divIcon({ className: '', html: `<div class="statelbl">${t}</div>`, iconSize: [60, 18], iconAnchor: [30, 9] }) }).addTo(map))
    const cities: [string, number, number][] = [['Brisbane', -27.47, 153.02], ['Sydney', -33.87, 151.21], ['Melbourne', -37.81, 144.96], ['Canberra', -35.28, 149.13], ['Adelaide', -34.93, 138.6], ['Perth', -31.95, 115.86], ['Hobart', -42.88, 147.33], ['Darwin', -12.46, 130.84]]
    cities.forEach(([t, la, lo]) => L.marker([la, lo], { pane: 'lblPane', interactive: false, icon: L.divIcon({ className: '', html: `<div class="citylbl"><i></i><span>${t}</span></div>`, iconSize: [90, 14], iconAnchor: [3, 7] }) }).addTo(map))
    L.marker([-26.65, 153.07], { pane: 'lblPane', interactive: false, icon: L.divIcon({ className: '', html: `<div class="citylbl home"><i></i><span>Sunshine Coast</span></div>`, iconSize: [110, 16], iconAnchor: [4, 8] }) }).addTo(map)
    layerRef.current = L.layerGroup().addTo(map)
    mapRef.current = map
    return () => { map.remove(); mapRef.current = null; layerRef.current = null }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!P])

  // ── Marker rendering ────────────────────────────────────────────────────
  const points = view === 'conv' || !P ? [] : (view === 'jobs' ? P.jobs.points : P.quotes.points)
  const selPoints = useMemo(() => points.filter(p => (month < 0 || p.m === month) && (cat === 'all' || p.g === cat)), [points, month, cat])

  useEffect(() => {
    const map = mapRef.current, layer = layerRef.current
    if (!map || !layer || !P || view === 'conv') return
    const rad = view === 'jobs'
      ? (t: number) => Math.max(5, Math.min(30, Math.sqrt(t) / 18))
      : (t: number) => Math.max(5, Math.min(34, Math.sqrt(t) / 95))
    const amColor = view === 'jobs' ? 'var(--wm-mint)' : 'var(--wm-amber)'
    // Aggregate per location.
    const M: Record<string, { pc: string; l: string; la: number; ln: number; n: number; t: number; won: number; byg: Record<string, { n: number; t: number }>; inv: Pt[] }> = {}
    selPoints.forEach(p => {
      const k = p.pc + '@' + p.la + ',' + p.ln
      const o = (M[k] ||= { pc: p.pc, l: p.l, la: p.la, ln: p.ln, n: 0, t: 0, won: 0, byg: {}, inv: [] })
      o.n++; o.t += p.a; o.won += (p.w || 0)
      const g = (o.byg[p.g] ||= { n: 0, t: 0 }); g.n++; g.t += p.a
      o.inv.push(p)
    })
    const dom = (b: Record<string, { t: number }>) => { let x = ''; let v = -1; for (const k in b) if (b[k].t > v) { v = b[k].t; x = k } return x }
    layer.clearLayers()
    Object.values(M).sort((a, b) => b.t - a.t).forEach(o => {
      const col = cat === 'all' ? COL[dom(o.byg)] : COL[cat]
      const mk = L.circleMarker([o.la, o.ln], { radius: rad(o.t), color: col, weight: 1.5, fillColor: col, fillOpacity: .48 })
      const veh = Object.entries(o.byg).sort((a, b) => b[1].t - a[1].t)
        .map(([k, v]) => `<div class="pvtag"><i style="background:${COL[k]}"></i>${NAME[k]} <b>${v.n}</b> ${fmtK(v.t)}</div>`).join('')
      const rows = [...o.inv].sort((a, b) => b.a - a.a).slice(0, 40)
        .map(v => `<div class="pop-row"><div><div class="cn"><span class="vdot" style="background:${COL[v.g]}"></span>${esc(v.c)}${v.x ? ' <span class="inf" title="Series inferred">≈</span>' : ''}${v.w ? ' <span class="won">✓ WON</span>' : ''}</div>${v.j ? `<div class="jt">${esc(v.j)} <span class="pop-inv">#${esc(v.i || '')}</span></div>` : ''}</div><div class="am" style="color:${amColor}">${fmtK(v.a)}</div></div>`).join('')
      const wonS = view === 'quotes' ? `<div><b>${o.won}</b><span>Won</span></div>` : ''
      mk.bindPopup(
        `<div class="pop-h">${esc(o.l)}<span class="pc">${esc(o.pc)}</span></div><div class="pop-s"><div><b>${fmtK(o.t)}</b><span>${view === 'jobs' ? 'Revenue' : 'Quoted'}</span></div><div><b>${o.n}</b><span>${view === 'jobs' ? 'Job' : 'Quote'}${o.n > 1 ? 's' : ''}</span></div>${wonS}</div><div class="pop-veh">${veh}</div><div class="pop-list">${rows}</div>`,
        { maxWidth: 330, minWidth: 260 },
      )
      mk.on('mouseover', function (this: L.CircleMarker) { this.setStyle({ fillOpacity: .8 }) })
      mk.on('mouseout', function (this: L.CircleMarker) { this.setStyle({ fillOpacity: .48 }) })
      mk.addTo(layer)
    })
  }, [selPoints, view, cat, P, COL, NAME])

  // Fix tile layout when switching back from the conversion view.
  useEffect(() => {
    if (view !== 'conv' && mapRef.current) setTimeout(() => mapRef.current?.invalidateSize(), 60)
  }, [view])

  // ── Refresh (manual re-pull via GH Action) ─────────────────────────────
  const runActive = data?.last_run && ['pending', 'running'].includes(data.last_run.status)
  useEffect(() => {
    if (!runActive) return
    const t = setInterval(() => load(data?.fy || undefined), 20000)
    return () => clearInterval(t)
  }, [runActive, load, data?.fy])

  async function triggerRefresh() {
    setRefreshing(true); setRefreshMsg('')
    try {
      const r = await fetch('/api/workshop/map/refresh', { method: 'POST' })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || 'Refresh failed')
      setRefreshMsg(d.message || 'Sync started')
      setTimeout(() => load(data?.fy || undefined), 5000)
    } catch (e: any) { setRefreshMsg(e?.message || 'Refresh failed') }
    finally { setRefreshing(false) }
  }

  // ── Derived stats ───────────────────────────────────────────────────────
  const baseMonth = useMemo(() => points.filter(p => month < 0 || p.m === month), [points, month])
  const tot = selPoints.reduce((s, p) => s + p.a, 0)
  const locCount = useMemo(() => new Set(selPoints.map(p => p.pc + '@' + p.la + ',' + p.ln)).size, [selPoints])
  const bygMonth = useMemo(() => {
    const m: Record<string, { n: number; t: number }> = {}
    baseMonth.forEach(p => { const g = (m[p.g] ||= { n: 0, t: 0 }); g.n++; g.t += p.a })
    return m
  }, [baseMonth])
  const monthTotals = useMemo(() => {
    const t = Array(12).fill(0)
    points.forEach(p => { t[p.m] += p.a })
    return t
  }, [points])

  const syncedLbl = data?.synced_at ? new Date(data.synced_at).toLocaleString('en-AU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : null

  // ── Empty / loading / error states ──────────────────────────────────────
  if (loading && !data) return <div className="wm-dash"><div className="wm-empty">Loading map data…</div><style dangerouslySetInnerHTML={{ __html: CSS }} /></div>
  if (error) return <div className="wm-dash"><div className="wm-empty">{error}</div><style dangerouslySetInnerHTML={{ __html: CSS }} /></div>
  if (!P) {
    return (
      <div className="wm-dash">
        <div className="wm-empty">
          <div style={{ marginBottom: 10 }}>No map data yet — the daily MechanicDesk pull hasn&apos;t run.</div>
          {data?.last_run?.status === 'error' && <div style={{ color: '#e0707a', fontSize: 12, marginBottom: 10 }}>Last sync failed: {data.last_run.error}</div>}
          {runActive
            ? <div style={{ color: 'var(--wm-mint)', fontSize: 13 }}>Sync in progress — this updates automatically…</div>
            : <button className="tab active" onClick={triggerRefresh} disabled={refreshing}>{refreshing ? 'Starting…' : 'Pull from MechanicDesk now'}</button>}
          {refreshMsg && <div style={{ color: 'var(--wm-muted)', fontSize: 12, marginTop: 8 }}>{refreshMsg}</div>}
        </div>
        <style dangerouslySetInnerHTML={{ __html: CSS }} />
      </div>
    )
  }

  const isMapView = view !== 'conv'

  return (
    <div className="wm-dash">
      <Head>
        <link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:ital,wght@0,600;0,800;1,900&family=Barlow:wght@400;500;600&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet" />
      </Head>
      <style dangerouslySetInnerHTML={{ __html: CSS }} />

      <header>
        <div className="titlerow">
          <h1>Just Autos <span className="b">·</span> FY{P.fy} Workshop</h1>
          <span className="sub">
            {view === 'conv' ? 'Quotes vs booked jobs' : (view === 'jobs' ? 'Booked jobs' : 'Quotes')}
            {isMapView && <> · {month < 0 ? `${P.months[0]?.label} – ${P.months[11]?.label}` : P.months[month]?.label}{cat !== 'all' ? ` · ${NAME[cat]}` : ''}</>}
          </span>
          <span style={{ flex: 1 }} />
          {(data?.fys.length || 0) > 1 && (
            <span className="fysel">
              {data!.fys.map(fy => (
                <button key={fy} className={'mbtn' + (fy === P.fy ? ' active' : '')} onClick={() => { setMonth(-1); load(fy) }}>FY{fy}</button>
              ))}
            </span>
          )}
          <span className="sync">
            {runActive ? <span style={{ color: 'var(--wm-mint)' }}>syncing…</span> : <>synced {syncedLbl || '—'}</>}
            {!runActive && <button className="syncbtn" title="Pull fresh data from MechanicDesk (takes ~2–4 min)" onClick={triggerRefresh} disabled={refreshing}>⟳</button>}
          </span>
        </div>
        <div className="tabs">
          <button className={'tab' + (view === 'jobs' ? ' active' : '')} onClick={() => setView('jobs')}>Jobs Map</button>
          <button className={'tab' + (view === 'quotes' ? ' active' : '')} onClick={() => setView('quotes')}>Quotes Map</button>
          <button className={'tab' + (view === 'conv' ? ' active' : '')} onClick={() => setView('conv')}>Conversion</button>
        </div>
      </header>

      {refreshMsg && <div style={{ padding: '4px 18px', fontSize: 11, color: 'var(--wm-muted)', background: 'var(--wm-panel)' }}>{refreshMsg}</div>}

      {isMapView && (
        <div className="stats">
          <div className="stat"><div className="v" style={{ color: view === 'jobs' ? '#11ADE6' : '#FFB454' }}>{fmtK(tot)}</div><div className="k">{view === 'jobs' ? 'Revenue (inc GST)' : 'Quoted (inc GST)'}</div></div>
          <div className="stat"><div className="v">{selPoints.length.toLocaleString('en-AU')}</div><div className="k">{view === 'jobs' ? 'Clear jobs' : 'Quotes'}</div></div>
          <div className="stat"><div className="v">{locCount}</div><div className="k">Locations</div></div>
          <div className="stat"><div className="v">{fmt(selPoints.length ? tot / selPoints.length : 0)}</div><div className="k">{view === 'jobs' ? 'Avg / job' : 'Avg / quote'}</div></div>
        </div>
      )}

      {isMapView && (
        <div className="strip months">
          <span className="striplabel">Month</span>
          <button className={'mbtn' + (month < 0 ? ' active' : '')} onClick={() => { setMonth(-1); if (boundsRef.current) mapRef.current?.fitBounds(boundsRef.current) }}>
            All FY<span className="mt">{fmtK(points.reduce((s, p) => s + p.a, 0))}</span>
          </button>
          {P.months.map((mo, i) => (
            <button key={mo.k} className={'mbtn' + (month === i ? ' active' : '')} onClick={() => setMonth(i)}>
              {mo.label.split(' ')[0]}<span className="mt">{fmtK(monthTotals[i])}</span>
            </button>
          ))}
        </div>
      )}

      {isMapView && (
        <div className="strip vehs">
          <span className="striplabel">Vehicle</span>
          <button className={'chip' + (cat === 'all' ? ' active' : '')} style={{ color: 'var(--wm-blue)' }} onClick={() => setCat('all')}>
            <span className="dot" style={{ background: 'var(--wm-blue)' }} /><span className="nm">All</span>
            <span className="num">{baseMonth.length} · {fmtK(baseMonth.reduce((s, p) => s + p.a, 0))}</span>
          </button>
          {P.cats.map(c => {
            const g = bygMonth[c.k] || { n: 0, t: 0 }
            return (
              <button key={c.k} className={'chip' + (cat === c.k ? ' active' : '') + (cat !== 'all' && cat !== c.k ? ' dim' : '')}
                style={{ color: c.col }} onClick={() => setCat(cat === c.k ? 'all' : c.k)}>
                <span className="dot" style={{ background: c.col }} /><span className="nm">{c.n}</span>
                <span className="num">{g.n} · {fmtK(g.t)}</span>
              </button>
            )
          })}
        </div>
      )}

      <div className="wrap">
        <div ref={mapDivRef} className="mapdiv" style={{ display: isMapView ? 'block' : 'none' }} />
        {isMapView && (
          <div className="note" style={{ borderLeft: `3px solid ${view === 'jobs' ? 'var(--wm-mint)' : 'var(--wm-amber)'}` }}>
            {view === 'jobs' ? (
              <><b style={{ color: 'var(--wm-mint)' }}>{P.jobs.meta.customers}</b> clear jobs · 1 per customer / month<br />
                <span style={{ color: 'var(--wm-muted2)' }}>Deposits, diagnostics &amp; internal excluded · {P.jobs.meta.inferred} series inferred (≈)</span></>
            ) : (
              <><b style={{ color: 'var(--wm-amber)' }}>{P.quotes.meta.mapped}/{P.quotes.meta.total_quotes}</b> quotes mapped · 1 per customer / month<br />
                <span style={{ color: 'var(--wm-muted2)' }}>{fmtK(P.quotes.meta.total_value)} quoted</span></>
            )}
          </div>
        )}
        {view === 'conv' && <ConversionView P={P} COL={COL} NAME={NAME} />}
      </div>
    </div>
  )
}

// ── Conversion tab ─────────────────────────────────────────────────────────

function ConversionView({ P, COL, NAME }: { P: Payload; COL: Record<string, string>; NAME: Record<string, string> }) {
  const C = P.conv
  const sum = (a: number[]) => a.reduce((x, y) => x + y, 0)
  let tq = 0, tj = 0, tv = 0
  CK.forEach(c => { tq += sum(C.qcount[c] || []); tj += sum(C.jcount[c] || []); tv += sum(C.qval[c] || []) })
  return (
    <div className="convView">
      <div className="cards">
        <div className="card"><div className="v">{tq.toLocaleString('en-AU')}</div><div className="k">Quotes issued</div></div>
        <div className="card"><div className="v" style={{ color: 'var(--wm-mint)' }}>{tj.toLocaleString('en-AU')}</div><div className="k">Booked jobs</div></div>
        <div className="card"><div className="v" style={{ color: 'var(--wm-amber)' }}>{tq ? (100 * tj / tq).toFixed(1) : '0'}%</div><div className="k">Overall conversion</div></div>
        <div className="card"><div className="v">{fmtK(tv)}</div><div className="k">Total quoted</div></div>
      </div>

      <h2>By vehicle — full year</h2>
      <table>
        <thead><tr><th>Vehicle</th><th>Quotes</th><th>Quoted $</th><th>Avg quote</th><th>Booked jobs</th><th>Conv %</th></tr></thead>
        <tbody>
          {CK.map(c => {
            const q = sum(C.qcount[c] || []), j = sum(C.jcount[c] || []), v = sum(C.qval[c] || [])
            return (
              <tr key={c}>
                <td className="veh"><span className="vd" style={{ background: COL[c] }} />{NAME[c]}</td>
                <td className="num">{q.toLocaleString('en-AU')}</td>
                <td className="num">{fmtK(v)}</td>
                <td className="num">{fmtK(q ? v / q : 0)}</td>
                <td className="num">{j}</td>
                <td className="num" style={{ color: convColor(q ? 100 * j / q : 0) }}>{q ? (100 * j / q).toFixed(0) : '0'}%</td>
              </tr>
            )
          })}
          <tr className="tot">
            <td>Total</td>
            <td className="num">{tq.toLocaleString('en-AU')}</td>
            <td className="num">{fmtK(tv)}</td>
            <td className="num">{fmtK(tq ? tv / tq : 0)}</td>
            <td className="num">{tj}</td>
            <td className="num">{tq ? (100 * tj / tq).toFixed(0) : '0'}%</td>
          </tr>
        </tbody>
      </table>

      <h2>Conversion % by month <span style={{ color: 'var(--wm-muted2)', fontSize: 11, letterSpacing: 0, textTransform: 'none' }}>(cell = jobs / quotes)</span></h2>
      <div className="gridwrap">
        <table className="grid">
          <thead><tr><th>Vehicle</th>{P.months.map(m => <th key={m.k}>{m.label.split(' ')[0]}</th>)}<th>FY</th></tr></thead>
          <tbody>
            {CK.map(c => {
              const Q = sum(C.qcount[c] || []), J = sum(C.jcount[c] || [])
              return (
                <tr key={c}>
                  <td className="veh"><span className="vd" style={{ background: COL[c] }} />{(NAME[c] || c).replace('LC ', '')}</td>
                  {Array.from({ length: 12 }, (_, i) => {
                    const q = (C.qcount[c] || [])[i] || 0, j = (C.jcount[c] || [])[i] || 0, p = q ? 100 * j / q : 0
                    return (
                      <td key={i} className="cv" style={{ color: q ? convColor(p) : '#3a4658' }} title={`${j} jobs / ${q} quotes`}>
                        {q ? p.toFixed(0) + '%' : '–'}
                        <div style={{ fontSize: 8.5, color: 'var(--wm-muted2)', fontWeight: 400 }}>{j}/{q}</div>
                      </td>
                    )
                  })}
                  <td className="cv" style={{ color: convColor(Q ? 100 * J / Q : 0) }}>{Q ? (100 * J / Q).toFixed(0) : '0'}%</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <p style={{ color: 'var(--wm-muted2)', fontSize: 11, marginTop: 12, lineHeight: 1.6 }}>
        Both sides are 1 per customer per month (largest kept). Quotes by quote date; booked jobs from invoices
        (deposits, diagnostics &amp; internal excluded). Counted independently — a quote may convert in a later month.
      </p>
    </div>
  )
}

// ── Styles (verbatim from the static build, scoped under .wm-dash) ─────────

const CSS = `
.wm-dash{--wm-bg:#0B0E13;--wm-panel:#121821;--wm-panel2:#19212D;--wm-line:#243040;--wm-blue:#11ADE6;--wm-mint:#47FFCF;--wm-amber:#FFB454;--wm-txt:#E6EDF3;--wm-muted:#7A8696;--wm-muted2:#566273;
  display:flex;flex-direction:column;height:100%;min-height:0;background:var(--wm-bg);color:var(--wm-txt);font-family:'Barlow',system-ui,sans-serif}
.wm-dash *{box-sizing:border-box;margin:0;padding:0}
.wm-dash .wm-empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;color:var(--wm-muted);font-size:14px;padding:40px}
.wm-dash header{padding:10px 18px 0;background:linear-gradient(180deg,#0d121a,#0B0E13);border-bottom:1px solid var(--wm-line);flex:0 0 auto}
.wm-dash .titlerow{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap}
.wm-dash h1{font-family:'Barlow Condensed';font-weight:900;font-style:italic;font-size:21px;letter-spacing:.5px;text-transform:uppercase;line-height:1;color:var(--wm-txt)}
.wm-dash h1 .b{color:var(--wm-blue)}
.wm-dash .sub{font-size:11px;color:var(--wm-muted);letter-spacing:2px;text-transform:uppercase;font-weight:600}
.wm-dash .sync{font-size:10.5px;color:var(--wm-muted2);display:flex;align-items:center;gap:6px}
.wm-dash .syncbtn{background:var(--wm-panel2);border:1px solid var(--wm-line);color:var(--wm-muted);border-radius:5px;padding:2px 8px;cursor:pointer;font-size:12px}
.wm-dash .syncbtn:hover{color:var(--wm-txt)}
.wm-dash .fysel{display:flex;gap:4px}
.wm-dash .tabs{display:flex;gap:4px;margin-top:9px}
.wm-dash .tab{border:1px solid var(--wm-line);border-bottom:none;background:var(--wm-panel2);color:var(--wm-muted);border-radius:8px 8px 0 0;padding:8px 16px;cursor:pointer;font-family:'Barlow Condensed';font-weight:800;font-size:13.5px;letter-spacing:1px;text-transform:uppercase}
.wm-dash .tab.active{background:var(--wm-blue);color:#04141c;border-color:var(--wm-blue)}
.wm-dash .stats{display:flex;gap:20px;padding:9px 18px;background:var(--wm-panel);border-bottom:1px solid var(--wm-line);flex-wrap:wrap;flex:0 0 auto}
.wm-dash .stat .v{font-family:'Space Mono';font-weight:700;font-size:19px;line-height:1;color:var(--wm-txt)}
.wm-dash .stat .k{font-size:9.5px;color:var(--wm-muted);letter-spacing:1.5px;text-transform:uppercase;margin-top:4px}
.wm-dash .strip{display:flex;gap:6px;padding:9px 14px;overflow-x:auto;flex:0 0 auto;scrollbar-width:thin;align-items:center}
.wm-dash .strip::-webkit-scrollbar{height:5px}.wm-dash .strip::-webkit-scrollbar-thumb{background:var(--wm-line);border-radius:3px}
.wm-dash .months{background:var(--wm-panel);border-bottom:1px solid var(--wm-line)}
.wm-dash .vehs{background:#0e141d;border-bottom:1px solid var(--wm-line)}
.wm-dash .striplabel{flex:0 0 auto;font-family:'Barlow Condensed';font-weight:800;font-size:11px;color:var(--wm-muted2);letter-spacing:2px;text-transform:uppercase;padding-right:4px}
.wm-dash .mbtn{flex:0 0 auto;border:1px solid var(--wm-line);background:var(--wm-panel2);color:var(--wm-muted);border-radius:7px;padding:7px 11px;cursor:pointer;font-family:'Barlow Condensed';font-weight:800;font-size:13px;letter-spacing:.5px;text-transform:uppercase;min-width:56px;text-align:center}
.wm-dash .mbtn .mt{display:block;font-family:'Space Mono';font-weight:400;font-size:9px;color:var(--wm-muted2);margin-top:2px;letter-spacing:0}
.wm-dash .mbtn.active{background:var(--wm-blue);color:#04141c;border-color:var(--wm-blue)}.wm-dash .mbtn.active .mt{color:#063040}
.wm-dash .chip{flex:0 0 auto;display:flex;align-items:center;gap:7px;border:1px solid var(--wm-line);background:var(--wm-panel2);color:var(--wm-txt);border-radius:7px;padding:6px 11px;cursor:pointer}
.wm-dash .chip .dot{width:10px;height:10px;border-radius:50%}
.wm-dash .chip .nm{font-family:'Barlow Condensed';font-weight:800;font-size:13px;text-transform:uppercase;white-space:nowrap;color:var(--wm-txt)}
.wm-dash .chip .num{font-family:'Space Mono';font-size:10px;color:var(--wm-muted);white-space:nowrap}
.wm-dash .chip.dim{opacity:.38}.wm-dash .chip.active{box-shadow:0 0 0 1px currentColor inset}
.wm-dash .wrap{flex:1 1 auto;position:relative;min-height:0}
.wm-dash .mapdiv{position:absolute;inset:0;background:#080b10}
.wm-dash .leaflet-div-icon{background:transparent!important;border:0!important}
.wm-dash .statelbl{font-family:'Barlow Condensed';font-weight:800;font-size:15px;color:rgba(150,164,182,.72);letter-spacing:3px;text-transform:uppercase;text-shadow:0 0 4px #0B0E13,0 1px 2px #000;white-space:nowrap;pointer-events:none}
.wm-dash .citylbl{display:flex;align-items:center;gap:4px;white-space:nowrap;pointer-events:none}
.wm-dash .citylbl i{width:5px;height:5px;border-radius:50%;background:#cdd7e2;box-shadow:0 0 0 2px rgba(0,0,0,.5)}
.wm-dash .citylbl span{font-family:'Barlow';font-weight:600;font-size:11px;color:#aeb9c6;text-shadow:0 1px 3px #000}
.wm-dash .citylbl.home i{background:var(--wm-mint);width:7px;height:7px;box-shadow:0 0 8px var(--wm-mint)}.wm-dash .citylbl.home span{color:var(--wm-mint)}
.wm-dash .leaflet-popup-content-wrapper{background:var(--wm-panel);color:var(--wm-txt);border:1px solid var(--wm-line);border-radius:9px}
.wm-dash .leaflet-popup-tip{background:var(--wm-panel);border:1px solid var(--wm-line)}
.wm-dash .leaflet-popup-content{margin:12px 14px;font-family:'Barlow'}
.wm-dash .pop-h{font-family:'Barlow Condensed';font-weight:800;font-size:18px;text-transform:uppercase}
.wm-dash .pop-h .pc{font-family:'Space Mono';font-size:12px;color:var(--wm-blue);font-weight:700;margin-left:6px}
.wm-dash .pop-s{display:flex;gap:16px;margin:6px 0 8px;padding-bottom:8px;border-bottom:1px solid var(--wm-line)}
.wm-dash .pop-s b{font-family:'Space Mono';color:var(--wm-blue);font-size:15px}
.wm-dash .pop-s span{font-size:10px;color:var(--wm-muted);text-transform:uppercase;display:block}
.wm-dash .pop-veh{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:8px}
.wm-dash .pvtag{display:flex;align-items:center;gap:5px;font-size:10.5px;color:var(--wm-muted);background:var(--wm-panel2);border-radius:5px;padding:2px 6px}
.wm-dash .pvtag i{width:7px;height:7px;border-radius:50%}.wm-dash .pvtag b{font-family:'Space Mono';color:var(--wm-txt)}
.wm-dash .pop-list{max-height:150px;overflow-y:auto;scrollbar-width:thin}
.wm-dash .pop-list::-webkit-scrollbar{width:5px}.wm-dash .pop-list::-webkit-scrollbar-thumb{background:var(--wm-line)}
.wm-dash .pop-row{display:flex;justify-content:space-between;gap:10px;padding:4px 0;border-bottom:1px solid rgba(36,48,64,.5);font-size:12.5px}
.wm-dash .pop-row .cn{color:var(--wm-txt);font-weight:500}.wm-dash .pop-row .jt{color:var(--wm-muted);font-size:10.5px}
.wm-dash .pop-row .am{font-family:'Space Mono';font-weight:700;white-space:nowrap}
.wm-dash .pop-row .vdot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:5px}
.wm-dash .inf{color:var(--wm-muted2);font-size:11px;cursor:help}.wm-dash .won{color:var(--wm-mint);font-size:10px;font-weight:700}
.wm-dash .pop-inv{font-family:'Space Mono';font-size:9px;color:var(--wm-muted2)}
.wm-dash .note{position:absolute;top:12px;right:12px;z-index:500;background:rgba(18,24,33,.92);border:1px solid var(--wm-line);border-radius:7px;padding:8px 11px;max-width:230px;font-size:10.5px;color:var(--wm-muted);line-height:1.5}
.wm-dash .note b{font-family:'Space Mono';font-size:11px}
.wm-dash .convView{position:absolute;inset:0;overflow-y:auto;padding:18px}
.wm-dash .cards{display:flex;gap:14px;flex-wrap:wrap;margin-bottom:6px}
.wm-dash .card{flex:1 1 150px;background:var(--wm-panel);border:1px solid var(--wm-line);border-radius:10px;padding:14px 16px}
.wm-dash .card .v{font-family:'Space Mono';font-weight:700;font-size:23px;color:var(--wm-blue)}
.wm-dash .card .k{font-size:10px;color:var(--wm-muted);letter-spacing:1.5px;text-transform:uppercase;margin-top:5px}
.wm-dash h2{font-family:'Barlow Condensed';font-weight:800;font-size:15px;letter-spacing:2px;text-transform:uppercase;color:var(--wm-txt);margin:20px 0 10px}
.wm-dash .convView table{border-collapse:collapse;width:100%;font-size:13px}
.wm-dash .convView th,.wm-dash .convView td{padding:8px 10px;text-align:right;border-bottom:1px solid var(--wm-line)}
.wm-dash .convView th{font-family:'Barlow Condensed';font-weight:800;font-size:12px;letter-spacing:1px;text-transform:uppercase;color:var(--wm-muted)}
.wm-dash .convView th:first-child,.wm-dash .convView td:first-child{text-align:left}
.wm-dash .convView td{color:var(--wm-txt)}
.wm-dash .convView td.veh{font-family:'Barlow Condensed';font-weight:800;text-transform:uppercase;letter-spacing:.5px}
.wm-dash .convView td .vd{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:7px}
.wm-dash .convView td.num{font-family:'Space Mono'}
.wm-dash .convView tr.tot td{border-top:2px solid var(--wm-line);font-weight:700}
.wm-dash .convView tr.tot td.num{color:var(--wm-blue)}
.wm-dash .grid td.cv{font-family:'Space Mono';font-weight:700}.wm-dash .gridwrap{overflow-x:auto}
@media(max-width:600px){.wm-dash h1{font-size:18px}.wm-dash .card .v{font-size:19px}.wm-dash .convView th,.wm-dash .convView td{padding:6px 6px;font-size:11.5px}.wm-dash .stats{gap:14px}.wm-dash .stat .v{font-size:16px}}
`
