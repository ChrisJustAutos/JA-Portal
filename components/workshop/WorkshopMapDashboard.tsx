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
import { addDarkBasemap } from '../../lib/map-basemap'
import { useToast } from '../ui/Feedback'
import { pcState } from '../../lib/workshop-map/postcode-state'

type ViewKey = 'jobs' | 'quotes' | 'conv' | 'state' | 'trend'

interface AreaDist { key: string; name: string; lat: number | null; lng: number | null; suburb: string | null; quotesOnly?: boolean }
interface AreasResp { radiusKm: number; distributors: AreaDist[] }

// n = how many quotes `a` is the average of (quotes only, omitted when 1).
// la/ln are NULL on a quote we could not geocode. It still counts in every
// total - it is a real quote - it just gets no pin (Chris 2026-09-01).
interface Pt { la: number | null; ln: number | null; pc: string; l: string; m: number; g: string; c: string; a: number; j?: string; i?: string; d?: string; x?: number; w?: number; n?: number }
interface Payload {
  fy: number
  months: { k: string; label: string }[]
  cats: { k: string; n: string; col: string }[]
  jobs: { points: Pt[]; meta: { customers: number; mapped: number; clean_total: number; inferred: number } }
  quotes: { points: Pt[]; meta: { total_quotes: number; mapped: number; total_value: number } }
  conv: { qcount: Record<string, number[]>; qval: Record<string, number[]>; jcount: Record<string, number[]> }
}
// Distributor tunes counted as jobs — one per VIN per month, derived from the
// Distributor report's MYOB invoices (the PO number is the car's VIN).
type ConvSrc = 'ja' | 'both' | 'dist'

interface DistributorJobs {
  jcount: Record<string, number[]>
  jvehicles?: Record<string, number>
  total: number
  vehicles: number
  unknown: number
  rejected: number
  sourceComputedAt: string | null
  byDistributor?: DistributorTunePin[]
  unlocated?: { tunes: number; names: string[] }
}
interface DistributorTunePin {
  name: string; lat: number; lng: number; suburb: string | null
  // One job = one CAR. `jobs` is distinct VINs for the year; jobsByMonth[m] is
  // distinct VINs in that month. They do not sum — a car tuned twice in
  // different months is one job in both.
  jobs: number; jobsByMonth: number[]; tunes: number
  bySeries: Record<string, { jobs: number; months: number[] }>
}
interface ConvBlock { qcount: Record<string, number[]>; qval: Record<string, number[]>; jcount: Record<string, number[]> }
interface CompareYear {
  fy: number
  synced_at: string | null
  months: { k: string; label: string }[]
  conv: ConvBlock
  convByState: Record<string, ConvBlock>
  distributor_jobs?: DistributorJobs | null
}
interface ApiResp {
  fy: number | null
  fys: number[]
  payload: Payload | null
  synced_at: string | null
  distributor_jobs?: DistributorJobs | null
  // Comparison years arrive COMPACT — counts only, never the points arrays
  // (a full payload is 1-2MB and the comparison views only read counts).
  comparisons?: CompareYear[]
  // Booking-deposit invoices for the FY — excluded from the job totals (noise),
  // shown as a sub-line under the Revenue stat. byMonth is FY-indexed (Jul=0).
  deposits?: { total: number; count: number; byMonth: number[] } | null
  last_run: { id: string; status: string; started_at: string; completed_at: string | null; error: string | null; invoice_count: number | null; quote_count: number | null } | null
}

const fmt = (n: number) => '$' + Math.round(n).toLocaleString('en-AU')
const fmtK = (n: number) => n >= 1e6 ? '$' + (n / 1e6).toFixed(2) + 'M' : n >= 1000 ? '$' + (n / 1000).toFixed(n >= 100000 ? 0 : 1) + 'k' : '$' + Math.round(n)
// YYYY-MM-DD → DD/MM/YY for the popup rows (CSV keeps the ISO date so it sorts).
const dmy = (d: string) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d || ''); return m ? `${m[3]}/${m[2]}/${m[1].slice(2)}` : '' }
// Great-circle distance. Only used to decide which distributor a quote sits
// nearest to, so the spherical approximation is far inside what matters.
const haversineKm = (aLa: number, aLn: number, bLa: number, bLn: number) => {
  const R = 6371, r = Math.PI / 180
  const dLa = (bLa - aLa) * r, dLn = (bLn - aLn) * r
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(aLa * r) * Math.cos(bLa * r) * Math.sin(dLn / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}
const OUTSIDE_KEY = '__outside__'
const esc = (s: any) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const CK = ['70', '200', '300', 'HILUX', 'PRADO']
const convColor = (p: number) => p >= 12 ? '#47FFCF' : p >= 8 ? '#9be7c4' : p >= 5 ? '#FFB454' : '#e0707a'

// AU postcode → state lives in lib/workshop-map/postcode-state so the PDF
// export classifies identically — see that file.

export default function WorkshopMapDashboard() {
  const [data, setData] = useState<ApiResp | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  // ?view=dist opens straight on the Distributor Map. The weekly sales recap
  // email links people to that map by name, and /reports/distributor-map
  // redirects here - both must land on the view they asked for, not on Jobs.
  const [view, setView] = useState<ViewKey>(() => {
    if (typeof window === 'undefined') return 'jobs'
    const v = new URLSearchParams(window.location.search).get('view')
    return (['jobs', 'quotes', 'conv', 'state', 'trend'] as const).includes(v as any) ? (v as ViewKey) : 'jobs'
  })
  const [month, setMonth] = useState(-1)          // -1 = all FY
  const [cat, setCat] = useState('all')
  const [st, setSt] = useState('all')             // state pill — jobs/quotes maps + conversion
  // Conversion source: Just Autos only, both, or distributors only. Was a
  // boolean "fold them in"; Chris 2026-09-02 wants the same theory as the maps,
  // where you can look at either side on its own or together.
  const [convSrc, setConvSrc] = useState<ConvSrc>('ja')
  // Comparison financial years. Maps stay single-year (overlapping dots are
  // unreadable); Conversion / By State / Vehicle Trend can hold several.
  const [compare, setCompare] = useState<number[]>([])
  // ── Distributor areas overlay (Quotes Map) ────────────────────────────
  // Chris 2026-09-02: "a button to turn on the distributor locations and see
  // what quotes land within their radius". Deliberately an OVERLAY on the real
  // quotes map rather than a separate picture, so the dots being counted are
  // the same dots on screen, under whatever month/vehicle/state filter is set.
  const [areasOn, setAreasOn] = useState(false)
  const [areas, setAreas] = useState<AreasResp | null>(null)
  const [areasRadius, setAreasRadius] = useState(100)
  const [areasErr, setAreasErr] = useState('')
  // Selecting a distributor filters the map to their quotes, the same way the
  // month, vehicle and state pills work. OUTSIDE_KEY selects the quotes that
  // fall in nobody's area - the ones worth arguing about.
  const [areaSel, setAreaSel] = useState<string | null>(null)

  // ── Distributor tunes on the Jobs Map ─────────────────────────────────
  // Chris 2026-09-02: distributor tunes are "the closest indicator of jobs for
  // distributors", pinned under their name and location with a breakdown by
  // model. NOT called distOn - that is the Conversion view's fold, and a second
  // dist* boolean meaning something else on another view is a trap.
  const [tunesOn, setTunesOn] = useState(false)
  const tuneLayerRef = useRef<L.LayerGroup | null>(null)
  const areaLayerRef = useRef<L.LayerGroup | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshMsg, setRefreshMsg] = useState('')
  const [pdfBusy, setPdfBusy] = useState(false)
  const toast = useToast()

  const mapRef = useRef<L.Map | null>(null)
  const layerRef = useRef<L.LayerGroup | null>(null)
  const boundsRef = useRef<L.LatLngBounds | null>(null)
  const mapDivRef = useRef<HTMLDivElement | null>(null)

  // fySel null = let the API choose the default year. Held in state (rather
  // than only passed to load()) so that changing the comparison years refetches
  // the SAME primary year instead of silently falling back to the default.
  const [fySel, setFySel] = useState<number | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const qs = new URLSearchParams()
      if (fySel) qs.set('fy', String(fySel))
      if (compare.length) qs.set('compare', compare.join(','))
      const r = await fetch(`/api/workshop/map${qs.toString() ? `?${qs}` : ''}`)
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || 'Failed to load map data')
      setData(d)
    } catch (e: any) { setError(e?.message || 'Failed to load map data') }
    finally { setLoading(false) }
  }, [fySel, compare])
  // Refetches on both a year change and a comparison change — the comparison
  // payloads come from the server, so the request has to be re-issued.
  useEffect(() => { load() }, [load])

  // Export PDF — the whole FY month by month, honouring the vehicle and state
  // filters but NOT the month strip (the year is the point of the export).
  // Fetched rather than linked so the session cookie rides along and a failure
  // surfaces as a toast instead of a browser error page.
  const downloadPdf = useCallback(async () => {
    if (!data?.fy) return
    setPdfBusy(true)
    try {
      const params = new URLSearchParams({ fy: String(data.fy) })
      if (cat !== 'all') params.set('cat', cat)
      if (st !== 'all') params.set('state', st)
      const r = await fetch(`/api/workshop/map/pdf?${params}`, { credentials: 'same-origin' })
      if (!r.ok) {
        let msg = `HTTP ${r.status}`
        try { msg = (await r.json()).error || msg } catch { /* not JSON */ }
        throw new Error(msg)
      }
      const blob = await r.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `workshop-map-FY${data.fy}${cat !== 'all' ? `-${cat.toLowerCase()}` : ''}${st !== 'all' ? `-${st.toLowerCase()}` : ''}.pdf`
      document.body.appendChild(a)
      a.click()
      a.remove()
      // Revoke on a later tick — Safari cancels the download if the object URL
      // disappears while the click is still being handled.
      setTimeout(() => URL.revokeObjectURL(url), 2000)
      toast('PDF downloaded', 'success')
    } catch (e: any) { toast(e?.message || 'PDF export failed', 'error') }
    finally { setPdfBusy(false) }
  }, [data?.fy, cat, st, toast])

  const P = data?.payload || null
  const COL = useMemo(() => Object.fromEntries((P?.cats || []).map(c => [c.k, c.col])), [P])
  const NAME = useMemo(() => Object.fromEntries((P?.cats || []).map(c => [c.k, c.n])), [P])

  // ── Export one location's list to CSV ──────────────────────────────────
  // Wired to the ⬇ CSV button in every map popup. Exports every row behind the
  // dot (the popup itself only renders the top 40), with the MechanicDesk
  // invoice/quote number and the issue date. `d` only exists in payloads built
  // after 2026-08-25 — older cached payloads fall back to the FY month label.
  const exportLoc = useCallback((loc: string, pc: string, rows: Pt[]) => {
    if (!rows.length) return
    const isJobs = view === 'jobs'
    const mLabel = (m: number) => P?.months[m]?.label || ''
    const head = isJobs
      ? ['Date', 'Month', 'Customer', 'Vehicle', 'Job type', 'Invoice #', 'Amount inc GST', 'Suburb', 'Postcode', 'State']
      : ['Date', 'Month', 'Customer', 'Vehicle', 'Quote #', 'Won', 'Avg amount inc GST', 'Quotes averaged', 'Suburb', 'Postcode', 'State']
    const body = [...rows]
      .sort((a, b) => (a.d || '').localeCompare(b.d || '') || a.m - b.m || b.a - a.a)
      .map(v => isJobs
        ? [v.d || '', mLabel(v.m), v.c, NAME[v.g] || v.g, v.j || '', v.i || '', v.a.toFixed(2), v.l, v.pc, pcState(v.pc)]
        : [v.d || '', mLabel(v.m), v.c, NAME[v.g] || v.g, v.i || '', v.w ? 'Yes' : 'No', v.a.toFixed(2), String(v.n || 1), v.l, v.pc, pcState(v.pc)])
    const cell = (x: any) => {
      const t = String(x ?? '')
      return /[",\r\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t
    }
    const csv = [head, ...body].map(r => r.map(cell).join(',')).join('\r\n')
    const slug = (loc || pc || 'area').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    // BOM so Excel reads the UTF-8 (customer names carry accents/dashes).
    const url = URL.createObjectURL(new Blob([String.fromCharCode(0xfeff), csv], { type: 'text/csv;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `workshop-${isJobs ? 'jobs' : 'quotes'}-FY${data?.fy || ''}-${slug}${pc ? '-' + pc : ''}.csv`
    document.body.appendChild(a); a.click(); a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 4000)
    toast(`${rows.length} ${isJobs ? 'job' : 'quote'}${rows.length === 1 ? '' : 's'} exported`, 'success')
  }, [view, P, NAME, data?.fy, toast])

  // ── Map bootstrap (once the payload exists so the div is mounted) ──────
  useEffect(() => {
    if (!P || !mapDivRef.current || mapRef.current) return
    // worldCopyJump: panning across the antimeridian snaps back to the canonical
    // world copy — without it, scrolling "around the world" lands on a copy where
    // tiles render but every marker/polygon is missing.
    const map = L.map(mapDivRef.current, { zoomControl: true, attributionControl: true, minZoom: 3, worldCopyJump: true }).setView([-25.8, 134], 4)
    map.attributionControl.setPrefix(false)   // Esri's terms require the credit; drop Leaflet's own plug
    map.createPane('landPane'); map.getPane('landPane')!.style.zIndex = '250'
    map.createPane('lblPane'); map.getPane('lblPane')!.style.zIndex = '360'; map.getPane('lblPane')!.style.pointerEvents = 'none'
    addDarkBasemap(L, map, { labels: false })   // this map draws its own state/city labels below
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
  // State view uses jobs points for the month/vehicle strips (revenue-based).
  const points = view === 'conv' || !P ? [] : (view === 'quotes' ? P.quotes.points : P.jobs.points)
  const selPoints = useMemo(() => points.filter(p => (month < 0 || p.m === month) && (cat === 'all' || p.g === cat) && (st === 'all' || pcState(p.pc) === st)), [points, month, cat, st])

  // Which of the quotes CURRENTLY ON SCREEN fall inside someone's area, and
  // whose. Nearest distributor wins when radii overlap, so a quote is never
  // counted for two of them.
  const areaStats = useMemo(() => {
    if (!areasOn || !areas || view !== 'quotes') return null
    const ds = areas.distributors.filter(d => d.lat != null && d.lng != null)
    const per = new Map<string, { n: number; t: number }>()
    const keyOf = new Map<Pt, string>()
    let inN = 0, inT = 0, outN = 0, outT = 0
    for (const p of selPoints) {
      if (p.la == null || p.ln == null) continue
      let best: AreaDist | null = null, bestKm = Infinity
      for (const d of ds) {
        const km = haversineKm(p.la, p.ln, d.lat as number, d.lng as number)
        if (km <= areas.radiusKm && km < bestKm) { bestKm = km; best = d }
      }
      if (best) {
        inN++; inT += p.a
        keyOf.set(p, best.key)
        const e = per.get(best.key) || { n: 0, t: 0 }
        e.n++; e.t += p.a; per.set(best.key, e)
      } else { outN++; outT += p.a; keyOf.set(p, OUTSIDE_KEY) }
    }
    return { per, keyOf, inN, inT, outN, outT }
    // Deliberately NOT dependent on areaSel: these totals describe the whole
    // picture, so selecting one distributor must not collapse everyone else's
    // pill to nought.
  }, [areasOn, areas, view, selPoints])

  // What the map actually draws — the selection applied on top.
  const shownPoints = useMemo(() => {
    if (!areaSel || !areaStats) return selPoints
    return selPoints.filter(p => areaStats.keyOf.get(p) === areaSel)
  }, [selPoints, areaSel, areaStats])

  // A selection that no longer means anything must not keep filtering the map.
  useEffect(() => { if (!areasOn || view !== 'quotes') setAreaSel(null) }, [areasOn, view])

  useEffect(() => {
    const map = mapRef.current, layer = layerRef.current
    if (!map || !layer || !P || view === 'conv' || view === 'state') return
    const rad = view === 'jobs'
      ? (t: number) => Math.max(5, Math.min(30, Math.sqrt(t) / 18))
      : (t: number) => Math.max(5, Math.min(34, Math.sqrt(t) / 95))
    const amColor = view === 'jobs' ? 'var(--wm-mint)' : 'var(--wm-amber)'
    // Aggregate per location.
    const M: Record<string, { pc: string; l: string; la: number; ln: number; n: number; t: number; won: number; byg: Record<string, { n: number; t: number }>; inv: Pt[] }> = {}
    shownPoints.forEach(p => {
      if (p.la == null || p.ln == null) return    // no coords = no pin; still in the totals
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
      const CAP = 40
      const rows = [...o.inv].sort((a, b) => b.a - a.a).slice(0, CAP)
        .map(v => `<div class="pop-row"><div><div class="cn"><span class="vdot" style="background:${COL[v.g]}"></span>${esc(v.c)}${v.x ? ' <span class="inf" title="Series inferred">≈</span>' : ''}${v.w ? ' <span class="won">✓ WON</span>' : ''}</div>${v.j || v.i ? `<div class="jt">${esc(v.j || '')}${v.j && v.i ? ' ' : ''}${v.i ? `<span class="pop-inv">#${esc(v.i)}${v.d ? ' · ' + esc(dmy(v.d)) : ''}</span>` : ''}</div>` : ''}</div><div class="am" style="color:${amColor}">${fmtK(v.a)}${v.n ? `<span class="avgn" title="Average of ${v.n} quotes from this customer that month">avg ×${v.n}</span>` : ''}</div></div>`).join('')
      const wonS = view === 'quotes' ? `<div><b>${o.won}</b><span>Won</span></div>` : ''
      const moreS = o.inv.length > CAP ? `<div class="pop-more">Showing the ${CAP} largest of ${o.inv.length} — export for the full list</div>` : ''
      mk.bindPopup(
        `<div class="pop-h"><span>${esc(o.l)}<span class="pc">${esc(o.pc)}</span></span><button type="button" class="pop-exp" title="Download this list as CSV">⬇ CSV</button></div><div class="pop-s"><div><b>${fmtK(o.t)}</b><span>${view === 'jobs' ? 'Revenue' : 'Quoted'}</span></div><div><b>${o.n}</b><span>${view === 'jobs' ? 'Job' : 'Quote'}${o.n > 1 ? 's' : ''}</span></div>${wonS}</div><div class="pop-veh">${veh}</div><div class="pop-list">${rows}</div>${moreS}`,
        { maxWidth: 330, minWidth: 260 },
      )
      // Popup content is a raw HTML string, so the export button is wired on
      // open — Leaflet rebuilds the node each time the popup is shown.
      mk.on('popupopen', (e: any) => {
        const btn = (e.popup.getElement() as HTMLElement | null)?.querySelector('.pop-exp') as HTMLButtonElement | null
        if (btn) btn.onclick = ev => { ev.stopPropagation(); exportLoc(o.l, o.pc, o.inv) }
      })
      mk.on('mouseover', function (this: L.CircleMarker) { this.setStyle({ fillOpacity: .8 }) })
      mk.on('mouseout', function (this: L.CircleMarker) { this.setStyle({ fillOpacity: .48 }) })
      mk.addTo(layer)
    })
  }, [shownPoints, view, cat, P, COL, NAME, exportLoc])

  // Fetched only when the overlay is actually switched on, and re-fetched when
  // the radius changes. The distributor list is small; the reason to go to the
  // server at all is that it holds the geocoded distributor locations.
  useEffect(() => {
    if (!areasOn || !P) return
    let dead = false
    setAreasErr('')
    fetch(`/api/reports/distributor-map?fy=${P.fy}&radius=${areasRadius}`)
      .then(r => r.json().then(d => { if (!r.ok) throw new Error(d.error || 'Failed to load distributors'); return d }))
      .then(d => { if (!dead) setAreas({ radiusKm: d.radiusKm, distributors: d.distributors || [] }) })
      .catch(e => { if (!dead) setAreasErr(e?.message || 'Could not load distributor locations') })
    return () => { dead = true }
  }, [areasOn, areasRadius, P?.fy])   // eslint-disable-line react-hooks/exhaustive-deps


  // Draw pins and radius rings on their OWN layer — the quotes layer is
  // cleared and rebuilt on every filter change, so sharing it would wipe these.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    if (!areaLayerRef.current) areaLayerRef.current = L.layerGroup().addTo(map)
    const layer = areaLayerRef.current
    layer.clearLayers()
    if (!areasOn || !areas || view !== 'quotes' || !areaStats) return
    for (const d of areas.distributors) {
      if (d.lat == null || d.lng == null) continue
      const st = areaStats.per.get(d.key) || { n: 0, t: 0 }
      const col = d.quotesOnly ? '#f2f5f7' : '#6ea8fe'
      // Muted when someone else is selected, so the chosen area reads at a glance.
      const dim = areaSel != null && areaSel !== d.key
      L.circle([d.lat, d.lng], {
        radius: areas.radiusKm * 1000, color: col, weight: dim ? 1 : 2, opacity: dim ? .18 : .65,
        fillColor: col, fillOpacity: dim ? .02 : .07, interactive: false,
      }).addTo(layer)
      L.circleMarker([d.lat, d.lng], { radius: dim ? 4 : 6, weight: 2, color: col, fillColor: col, fillOpacity: dim ? .35 : .9 })
        .bindPopup(`<div class="pop-h"><span>${esc(d.name)}${d.suburb ? `<span class="pc">${esc(d.suburb)}</span>` : ''}</span></div>`
          + `<div class="pop-s"><div><b>${st.n}</b><span>Quote${st.n === 1 ? '' : 's'} in range</span></div>`
          + `<div><b>${fmtK(st.t)}</b><span>Quoted</span></div>`
          + `<div><b>${areas.radiusKm}km</b><span>Radius</span></div></div>`
          + (d.quotesOnly ? `<div class="pop-veh">Just Autos' own workshop</div>` : ''))
        .addTo(layer)
    }
  }, [areasOn, areas, areaStats, view, areaSel])

  // Distributor tunes, counted under the month and vehicle filters in force.
  // The state pills are deliberately NOT applied: a pin sits at the
  // distributor's own address, so filtering it by the customer's state would
  // be answering a different question from the one the pill asks.
  const tunePins = useMemo(() => {
    const pins = data?.distributor_jobs?.byDistributor
    if (!tunesOn || view !== 'jobs' || !pins) return null
    const out = pins.map(p => {
      const bySeries: Record<string, number> = {}
      let jobs = 0
      for (const [series, m] of Object.entries(p.bySeries)) {
        if (cat !== 'all' && series !== cat) continue
        // Whole year → the pre-deduped distinct-VIN count. One month → that
        // month's. Never a sum across months: that is what made Penrith read
        // 136 jobs when it had tuned 132 cars.
        const n = month < 0 ? m.jobs : (m.months[month] || 0)
        if (n > 0) { bySeries[series] = n; jobs += n }
      }
      return { ...p, jobs, bySeries }
    }).filter(p => p.jobs > 0)
    return { pins: out, total: out.reduce((a, p) => a + p.jobs, 0) }
  }, [data?.distributor_jobs, tunesOn, view, cat, month])

  // Own layer, like the areas overlay: the jobs layer is cleared and rebuilt on
  // every filter change and would wipe these.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    if (!tuneLayerRef.current) tuneLayerRef.current = L.layerGroup().addTo(map)
    const layer = tuneLayerRef.current
    layer.clearLayers()
    if (!tunePins) return
    const max = Math.max(1, ...tunePins.pins.map(p => p.jobs))
    for (const p of tunePins.pins) {
      // Square markers, deliberately unlike the round customer dots: this pin
      // is a distributor's premises with work counted against it, not demand
      // at that address, and the two must never read as the same thing.
      const size = Math.max(12, Math.min(30, 12 + Math.sqrt(p.jobs / max) * 18))
      const rows = Object.entries(p.bySeries).sort((a, b) => b[1] - a[1])
        .map(([g, n]) => `<div><span>${esc(NAME[g] || g)}</span><b>${n}</b></div>`).join('')
      L.marker([p.lat, p.lng], {
        icon: L.divIcon({
          className: '',
          html: `<div class="tunepin" style="width:${size}px;height:${size}px;line-height:${size}px">${p.jobs}</div>`,
          iconSize: [size, size], iconAnchor: [size / 2, size / 2],
        }),
      }).bindPopup(
        `<div class="pop-h"><span>${esc(p.name)}${p.suburb ? `<span class="pc">${esc(p.suburb)}</span>` : ''}</span></div>`
        // One number, not two. A job IS a car, so a separate "vehicles" stat
        // beside it was the same fact twice — and the pair disagreeing (136 vs
        // 132) was the bug. Repeat visits get a quiet line of their own.
        + `<div class="pop-s"><div><b>${p.jobs}</b><span>Job${p.jobs === 1 ? '' : 's'}</span></div></div>`
        + (month < 0 && p.tunes > p.jobs
          ? `<div class="pop-veh">${p.tunes} tunes — ${p.tunes - p.jobs} return visit${p.tunes - p.jobs === 1 ? '' : 's'}</div>` : '')
        + `<div class="pop-list">${rows}</div>`,
      ).addTo(layer)
    }
  }, [tunePins, NAME])

  // Fix tile layout when switching back from a non-map view.
  useEffect(() => {
    if (view !== 'conv' && view !== 'state' && mapRef.current) setTimeout(() => mapRef.current?.invalidateSize(), 60)
  }, [view])

  // ── Refresh (manual re-pull via GH Action) ─────────────────────────────
  const runActive = data?.last_run && ['pending', 'running'].includes(data.last_run.status)
  useEffect(() => {
    if (!runActive) return
    const t = setInterval(() => load(), 20000)
    return () => clearInterval(t)
  }, [runActive, load, data?.fy])

  async function triggerRefresh() {
    setRefreshing(true); setRefreshMsg('')
    try {
      const r = await fetch('/api/workshop/map/refresh', { method: 'POST' })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || 'Refresh failed')
      setRefreshMsg(d.message || 'Sync started')
      setTimeout(() => load(), 5000)
    } catch (e: any) { setRefreshMsg(e?.message || 'Refresh failed') }
    finally { setRefreshing(false) }
  }

  // ── Derived stats (each strip reflects the other active filters) ────────
  const baseMonth = useMemo(() => points.filter(p => (month < 0 || p.m === month) && (st === 'all' || pcState(p.pc) === st)), [points, month, st])
  const tot = selPoints.reduce((s, p) => s + p.a, 0)
  // Distributor jobs joining the headline figures, but ONLY where they mean the
  // same thing. They add to the job COUNT and the location count; they must
  // never touch revenue or the average, because a tune is counted from the VIN
  // on an invoice line and carries no per-car value — folding it in would
  // invent money and drag the average down with jobs worth nothing.
  const distJobs = view === 'jobs' && tunesOn && tunePins ? tunePins.total : 0
  // Booking deposits for the current month selection (deposits aren't points,
  // so the vehicle/state filters don't apply — month is the one that matters).
  const depSel = useMemo(() => {
    const d = data?.deposits
    if (!d) return 0
    return month < 0 ? d.total : (d.byMonth[month] || 0)
  }, [data, month])
  // Un-geocoded quotes are not a location — they'd otherwise all collapse into
  // one phantom "@null,null" pin and inflate this by exactly 1.
  const locCount = useMemo(() => new Set(selPoints.filter(p => p.la != null && p.ln != null).map(p => p.pc + '@' + p.la + ',' + p.ln)).size, [selPoints])
  const bygMonth = useMemo(() => {
    const m: Record<string, { n: number; t: number }> = {}
    baseMonth.forEach(p => { const g = (m[p.g] ||= { n: 0, t: 0 }); g.n++; g.t += p.a })
    return m
  }, [baseMonth])
  const monthTotals = useMemo(() => {
    const t = Array(12).fill(0)
    points.forEach(p => { if (st === 'all' || pcState(p.pc) === st) t[p.m] += p.a })
    return t
  }, [points, st])
  // State pills — every state present anywhere in the FY (so pills don't vanish when filtering),
  // counts under the current month + vehicle selection. Conversion view counts quotes, full FY.
  const allStates = useMemo(() => {
    const s = new Set<string>()
    if (P) { P.jobs.points.forEach(p => s.add(pcState(p.pc))); P.quotes.points.forEach(p => s.add(pcState(p.pc))) }
    return ['QLD', 'NSW', 'VIC', 'SA', 'WA', 'TAS', 'NT', 'ACT', '?'].filter(k => s.has(k))
  }, [P])
  const byState = useMemo(() => {
    const base = view === 'conv'
      ? (P?.quotes.points || [])
      : points.filter(p => (month < 0 || p.m === month) && (cat === 'all' || p.g === cat))
    const m: Record<string, { n: number; t: number }> = {}
    base.forEach(p => { const g = (m[pcState(p.pc)] ||= { n: 0, t: 0 }); g.n++; g.t += p.a })
    return m
  }, [P, view, points, month, cat])

  const syncedLbl = data?.synced_at ? new Date(data.synced_at).toLocaleString('en-AU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : null

  // ── Empty / loading / error states ──────────────────────────────────────
  if (loading && !data) return <div className="wm-dash"><div className="wm-empty">Loading map data…</div><style dangerouslySetInnerHTML={{ __html: CSS }} /></div>
  // A failed load must never look like eternal loading (Kate/marketing
  // 2026-08-06) — say what happened and offer a retry.
  if (error && !data) return (
    <div className="wm-dash">
      <div className="wm-empty">
        <div style={{ marginBottom: 10 }}>Couldn't load the map data: {error}</div>
        <button onClick={() => load()} style={{ padding: '8px 16px', borderRadius: 7, border: '1px solid var(--t-border2)', background: 'var(--t-bg3)', color: 'var(--t-text)', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13 }}>Retry</button>
      </div>
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
    </div>
  )
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

  const isMapView = view === 'jobs' || view === 'quotes'
  const canCompare = !isMapView
  const hasStrips = isMapView || view === 'state'

  return (
    <div className="wm-dash">
      <Head>
        <link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:ital,wght@0,600;0,800;1,900&family=Barlow:wght@400;500;600&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet" />
      </Head>
      <style dangerouslySetInnerHTML={{ __html: CSS }} />

      <header>
        <div className="titlerow">
          <h1>Just Autos <span className="b">·</span> FY{P.fy}{canCompare && compare.length > 0 ? ` vs ${compare.slice().sort((a, b) => b - a).map(f => `FY${f}`).join(', ')}` : ''} Workshop</h1>
          <span className="sub">
            {view === 'conv' ? 'Quotes vs booked jobs' : view === 'state' ? 'State breakdown' : view === 'trend' ? 'Vehicle trend' : (view === 'jobs' ? 'Booked jobs' : 'Quotes')}
            {hasStrips && <> · {month < 0 ? `${P.months[0]?.label} – ${P.months[11]?.label}` : P.months[month]?.label}{cat !== 'all' ? ` · ${NAME[cat]}` : ''}</>}
            {view !== 'state' && st !== 'all' && <> · {st === '?' ? 'Unknown state' : st}</>}
          </span>
          <span style={{ flex: 1 }} />
          {(data?.fys.length || 0) > 1 && (
            <span className="fysel">
              {data!.fys.map(fy => (
                <button key={fy} className={'mbtn' + (fy === P.fy ? ' active' : '')}
                  onClick={() => { setMonth(-1); setCompare(c => c.filter(x => x !== fy)); setFySel(fy) }}>FY{fy}</button>
              ))}
              {/* Comparison years. Only the non-map views can show more than one
                  year at once — two years of dots on a map is unreadable, so the
                  control hides itself there rather than lying about what it does. */}
              {data!.fys.filter(f => f !== P.fy).length > 0 && (
                // Shown but disabled on the map tabs rather than hidden: a
                // control that vanishes reads as "the buttons don't work".
                <>
                  <span className="cmpLbl">vs</span>
                  {data!.fys.filter(f => f !== P.fy).map(fy => (
                    <button key={`c${fy}`} className={'mbtn cmp' + (compare.includes(fy) ? ' active' : '') + (canCompare ? '' : ' na')}
                      disabled={!canCompare}
                      title={!canCompare
                        ? 'Year comparison works on Conversion, By State and Vehicle Trend — two years of dots on a map cannot be read'
                        : compare.includes(fy) ? `Stop comparing FY${fy}` : `Compare against FY${fy}`}
                      onClick={() => setCompare(c => c.includes(fy) ? c.filter(x => x !== fy) : [...c, fy].slice(-3))}>
                      FY{String(fy).slice(2)}
                    </button>
                  ))}
                </>
              )}
            </span>
          )}
          <button className="pdfbtn" onClick={downloadPdf} disabled={pdfBusy || !data?.fy}
            title="Download the whole financial year, month by month, as a PDF (keeps the vehicle and state filters)">
            {pdfBusy ? 'Preparing…' : 'Export PDF'}
          </button>
          <span className="sync">
            {runActive ? <span style={{ color: 'var(--wm-mint)' }}>syncing…</span> : <>synced {syncedLbl || '—'}</>}
            {!runActive && <button className="syncbtn" title="Pull fresh data from MechanicDesk (takes ~2–4 min)" onClick={triggerRefresh} disabled={refreshing}>⟳</button>}
          </span>
        </div>
        <div className="tabs">
          <button className={'tab' + (view === 'jobs' ? ' active' : '')} onClick={() => setView('jobs')}>Jobs Map</button>
          <button className={'tab' + (view === 'quotes' ? ' active' : '')} onClick={() => setView('quotes')}>Quotes Map</button>
          <button className={'tab' + (view === 'conv' ? ' active' : '')} onClick={() => setView('conv')}>Conversion</button>
          <button className={'tab' + (view === 'state' ? ' active' : '')} onClick={() => setView('state')}>By State</button>
          <button className={'tab' + (view === 'trend' ? ' active' : '')} onClick={() => setView('trend')}>Vehicle Trend</button>
        </div>
      </header>

      {refreshMsg && <div style={{ padding: '4px 18px', fontSize: 11, color: 'var(--wm-muted)', background: 'var(--wm-panel)' }}>{refreshMsg}</div>}

      {isMapView && (
        <div className="stats">
          <div className="stat">
            <div className="v" style={{ color: view === 'jobs' ? '#11ADE6' : '#FFB454' }}>{fmtK(tot)}</div>
            <div className="k">{view === 'jobs' ? `Revenue (inc GST)${distJobs ? ' — workshop' : ''}` : 'Quoted (inc GST)'}</div>
            {distJobs > 0 && (
              <div className="k" style={{ fontSize: 10, marginTop: 2, opacity: 0.75 }}
                title="Distributor tunes are counted from the VIN on the invoice line, which gives a job count but no per-car value — so adding them here would invent revenue.">
                distributor tunes carry no value here
              </div>
            )}
            {view === 'jobs' && depSel > 0 && (
              <div className="k" style={{ fontSize: 10, marginTop: 2, opacity: 0.75 }} title="Booking deposits taken but the job isn't completed yet — not in the total above. Deposits for completed jobs are already folded into their customer's dot, along with every invoice for that customer in the month.">
                + {fmtK(depSel)} deposits awaiting jobs
              </div>
            )}
          </div>
          <div className="stat">
            <div className="v">{(selPoints.length + distJobs).toLocaleString('en-AU')}</div>
            <div className="k">{view === 'jobs' ? `Clear jobs${distJobs ? ' (incl. distributor)' : ''}` : 'Quotes'}</div>
            {distJobs > 0 && (
              <div className="k" style={{ fontSize: 10, marginTop: 2, opacity: 0.75 }}
                title="Workshop jobs are one customer per month; distributor jobs are one car per year, from the VIN on the tune invoice.">
                {selPoints.length.toLocaleString('en-AU')} workshop + {distJobs.toLocaleString('en-AU')} distributor
              </div>
            )}
          </div>
          <div className="stat">
            <div className="v">{locCount + (distJobs ? tunePins!.pins.length : 0)}</div>
            <div className="k">Locations</div>
            {distJobs > 0 && (
              <div className="k" style={{ fontSize: 10, marginTop: 2, opacity: 0.75 }}>
                incl. {tunePins!.pins.length} distributor{tunePins!.pins.length === 1 ? '' : 's'}
              </div>
            )}
          </div>
          <div className="stat">
            <div className="v">{fmt(selPoints.length ? tot / selPoints.length : 0)}</div>
            <div className="k">{view === 'jobs' ? `Avg / job${distJobs ? ' (workshop)' : ''}` : 'Avg / quote'}</div>
            {distJobs > 0 && (
              <div className="k" style={{ fontSize: 10, marginTop: 2, opacity: 0.75 }}>
                distributor tunes excluded
              </div>
            )}
          </div>
        </div>
      )}

      {hasStrips && (
        <div className="strip months">
          <span className="striplabel">Month</span>
          <button className={'mbtn' + (month < 0 ? ' active' : '')} onClick={() => { setMonth(-1); if (boundsRef.current) mapRef.current?.fitBounds(boundsRef.current) }}>
            All FY<span className="mt">{fmtK(monthTotals.reduce((s, v) => s + v, 0))}</span>
          </button>
          {P.months.map((mo, i) => (
            <button key={mo.k} className={'mbtn' + (month === i ? ' active' : '')} onClick={() => setMonth(i)}>
              {mo.label.split(' ')[0]}<span className="mt">{fmtK(monthTotals[i])}</span>
            </button>
          ))}
        </div>
      )}

      {view === 'jobs' && (data?.distributor_jobs?.byDistributor?.length || 0) > 0 && (
        <div className="strip">
          <span className="striplabel">Distributors</span>
          <button className={'mbtn' + (tunesOn ? ' active' : '')} onClick={() => setTunesOn(v => !v)}
            title="Pin each distributor at their own location with the tunes they carried out, broken down by model">
            {tunesOn ? 'Hide tunes' : 'Show tunes'}
          </button>
          {tunesOn && tunePins && (
            <>
              <span style={{ fontSize: 11, color: 'var(--wm-muted2)', padding: '0 8px', whiteSpace: 'nowrap' }}>
                <b style={{ color: '#6ea8fe' }}>{tunePins.total}</b> job{tunePins.total === 1 ? '' : 's'} across {tunePins.pins.length} distributor{tunePins.pins.length === 1 ? '' : 's'} · one car = one job
              </span>
              {tunePins.pins.slice(0, 14).map(p => (
                <button key={p.name} className="mbtn"
                  title={`${p.name}${p.suburb ? ` — ${p.suburb}` : ''} · ${p.jobs} job${p.jobs === 1 ? '' : 's'} (unique vehicles)`}
                  onClick={() => mapRef.current?.setView([p.lat, p.lng], 9)}>
                  {p.name.length > 20 ? p.name.slice(0, 19) + '…' : p.name}<span className="mt">{p.jobs}</span>
                </button>
              ))}
              {/* Never silently short: a quarter of FY2026's tunes are at names
                  with no distributor record, so no location and no pin. */}
              {(data?.distributor_jobs?.unlocated?.tunes || 0) > 0 && (
                <span style={{ fontSize: 11, color: 'var(--wm-amber)', paddingLeft: 8, whiteSpace: 'nowrap' }}
                  title={`No location on file for: ${(data?.distributor_jobs?.unlocated?.names || []).join(', ')}`}>
                  +{data!.distributor_jobs!.unlocated!.tunes} not placed
                </span>
              )}
            </>
          )}
        </div>
      )}

      {view === 'quotes' && (
        <div className="strip">
          <span className="striplabel">Distributors</span>
          <button className={'mbtn' + (areasOn ? ' active' : '')} onClick={() => setAreasOn(v => !v)}
            title="Show each distributor's location and service radius over the quotes, and count the quotes falling inside">
            {areasOn ? 'Hide areas' : 'Show areas'}
          </button>
          {areasOn && [50, 100, 150, 200].map(r => (
            <button key={r} className={'mbtn' + (areasRadius === r ? ' active' : '')} onClick={() => setAreasRadius(r)}>{r} km</button>
          ))}
          {areasOn && areasErr && <span style={{ fontSize: 11, color: 'var(--wm-red, #e0707a)', paddingLeft: 8 }}>{areasErr}</span>}
          {areasOn && !areasErr && !areas && <span style={{ fontSize: 11, color: 'var(--wm-muted2)', paddingLeft: 8 }}>loading…</span>}
          {areasOn && areaStats && (
            <span style={{ fontSize: 11, color: 'var(--wm-muted2)', paddingLeft: 8, whiteSpace: 'nowrap' }}>
              <b style={{ color: 'var(--wm-mint)' }}>{areaStats.inN}</b> quotes ({fmtK(areaStats.inT)}) inside an area
              {' · '}<b>{areaStats.outN}</b> ({fmtK(areaStats.outT)}) outside
              {' · '}counts follow the filters above
            </span>
          )}
        </div>
      )}

      {/* The per-distributor line. The aggregate above answers "how much of our
          quoting sits in distributor territory"; this answers "whose". Every
          located distributor is listed even on nought, because a distributor
          with no quotes near them is the finding, not a blank. Click one to fly
          to their area. */}
      {view === 'quotes' && areasOn && areas && areaStats && (
        <div className="strip">
          <span className="striplabel">In area</span>
          {areas.distributors
            .filter(d => d.lat != null && d.lng != null)
            .map(d => ({ d, s: areaStats.per.get(d.key) || { n: 0, t: 0 } }))
            .sort((a, b) => b.s.t - a.s.t || a.d.name.localeCompare(b.d.name))
            .map(({ d, s }) => (
              <button key={d.key} className={'mbtn' + (areaSel === d.key ? ' active' : '')} style={{ opacity: s.n || areaSel === d.key ? 1 : .45 }}
                title={`${d.name}${d.suburb ? ` — ${d.suburb}` : ''} · ${s.n} quote${s.n === 1 ? '' : 's'} within ${areas.radiusKm}km${d.quotesOnly ? ' · Just Autos’ own workshop' : ''}`}
                onClick={() => {
                  const next = areaSel === d.key ? null : d.key
                  setAreaSel(next)
                  const map = mapRef.current
                  if (!map || d.lat == null || d.lng == null) return
                  if (next) map.fitBounds(L.latLng(d.lat, d.lng).toBounds(areas.radiusKm * 2200))
                  else if (boundsRef.current) map.fitBounds(boundsRef.current)
                }}>
                {d.name.length > 22 ? d.name.slice(0, 21) + '…' : d.name}
                <span className="mt">{s.n} · {fmtK(s.t)}</span>
              </button>
            ))}
          {areaStats.outN > 0 && (
            <button className={'mbtn' + (areaSel === OUTSIDE_KEY ? ' active' : '')} style={{ opacity: areaSel === OUTSIDE_KEY ? 1 : .7 }}
              title="Quotes that fall outside every distributor's radius"
              onClick={() => {
                setAreaSel(areaSel === OUTSIDE_KEY ? null : OUTSIDE_KEY)
                const b = boundsRef.current; if (b && mapRef.current) mapRef.current.fitBounds(b)
              }}>
              Outside every area<span className="mt">{areaStats.outN} · {fmtK(areaStats.outT)}</span>
            </button>
          )}
        </div>
      )}

      {hasStrips && (
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

      {/* Vehicle Trend renders its own strips — its counts come from the fact
          tables (every invoice/quote), not the deduped map points, so sharing
          these pills would show numbers that disagree with its own chart. */}
      {view !== 'state' && view !== 'trend' && (
        <div className="strip vehs">
          <span className="striplabel">State</span>
          <button className={'mbtn' + (st === 'all' ? ' active' : '')} onClick={() => setSt('all')}>
            All AU<span className="mt">{Object.values(byState).reduce((s, g) => s + g.n, 0)} · {fmtK(Object.values(byState).reduce((s, g) => s + g.t, 0))}</span>
          </button>
          {allStates.map(k => {
            const g = byState[k] || { n: 0, t: 0 }
            return (
              <button key={k} className={'mbtn' + (st === k ? ' active' : '')} onClick={() => setSt(st === k ? 'all' : k)}>
                {k === '?' ? 'Unknown' : k}<span className="mt">{g.n} · {fmtK(g.t)}</span>
              </button>
            )
          })}
          {view === 'conv' && <span style={{ fontSize: 10, color: 'var(--wm-muted2)', paddingLeft: 6, whiteSpace: 'nowrap' }}>pill counts = quotes, full FY</span>}
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
        {view === 'conv' && <ConversionView P={P} COL={COL} NAME={NAME} st={st}
          dist={data?.distributor_jobs || null} src={convSrc} setSrc={setConvSrc}
          comparisons={data?.comparisons || []} />}
        {view === 'state' && <StateView P={P} month={month} cat={cat} />}
        {view === 'trend' && (
          <VehicleTrendView
            fy={P.fy} compareFys={canCompare ? compare : []} months={P.months} cats={P.cats}
            month={month} setMonth={setMonth}
            cat={cat} setCat={setCat}
            st={st} setSt={setSt}
          />
        )}
      </div>
    </div>
  )
}

// ── Conversion tab ─────────────────────────────────────────────────────────
// Quotes vs booked jobs. Two readings of the same numbers — a table and a bar
// chart — because a table answers "what exactly" and bars answer "which is
// bigger", and people want both.
//
// DISTRIBUTOR JOBS: a distributor tune reaches MYOB as an invoice whose PO
// number is the car's VIN, so each unique VIN in a month is one more booked
// job. Off by default (the base figures are the workshop's own); when on, the
// jobs fold into booked jobs and the conversion % moves with them. The jobs
// row stays visible either way so you can see what the toggle is doing.

interface ConvCounts { qcount: Record<string, number[]>; qval: Record<string, number[]>; jcount: Record<string, number[]> }

/**
 * An "i" that opens a note. The caveats on this page matter — a combined
 * conversion % flatters the workshop, distributor quotes are a radius
 * stand-in — but standing them in amber body text made every screen look like
 * it was warning you about something (Chris 2026-09-02). Available on ask,
 * quiet until then.
 */
function InfoNoteBlock({ children, title }: { children: React.ReactNode; title?: string }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" className={'infoBtn' + (open ? ' on' : '')} aria-expanded={open}
        title={title || 'How these figures are worked out'} onClick={() => setOpen(o => !o)}>i</button>
      {open && <p className="infoPop">{children}</p>}
    </>
  )
}

function ConversionView({ P, COL, NAME, st, dist, src, setSrc, comparisons }: {
  P: Payload; COL: Record<string, string>; NAME: Record<string, string>; st: string
  dist: DistributorJobs | null; src: ConvSrc; setSrc: (v: ConvSrc) => void
  comparisons: CompareYear[]
}) {
  const [chart, setChart] = useState(false)
  // Radius for the per-distributor conversion below — the same choices as the
  // Quotes Map overlay, because it is the same question asked two ways.
  const [radiusKm, setRadiusKm] = useState(100)

  // 'all' uses the authoritative precomputed conv (covers unmapped quotes/jobs too);
  // a state selection rebuilds the same structure from geocoded points only.
  const base = useMemo<ConvCounts>(() => {
    if (st === 'all') return P.conv
    const qcount: Record<string, number[]> = {}, qval: Record<string, number[]> = {}, jcount: Record<string, number[]> = {}
    P.quotes.points.forEach(p => {
      if (pcState(p.pc) !== st) return
      ;(qcount[p.g] ||= Array(12).fill(0))[p.m]++
      ;(qval[p.g] ||= Array(12).fill(0))[p.m] += p.a
    })
    P.jobs.points.forEach(p => { if (pcState(p.pc) === st) (jcount[p.g] ||= Array(12).fill(0))[p.m]++ })
    return { qcount, qval, jcount }
  }, [P, st])

  // Distributor jobs are national — a state filter can't place them (the
  // invoice has no postcode), so they're only foldable on the all-Australia view.
  const distUsable = !!dist && dist.total > 0 && st === 'all'
  // `on` = distributor numbers are in play at all; `jaOn` = Just Autos' own are.
  const on = distUsable && (src === 'both' || src === 'dist')
  const jaOn = !distUsable || src !== 'dist'

  // FULL-YEAR distributor counts come from jvehicles (distinct cars), never
  // from summing jcount across months — that is the double-count Chris caught
  // on the map card, and the same rule has to hold here or one dashboard
  // carries two definitions of a job.
  const distYear = (c: string) => (dist?.jvehicles?.[c] ?? 0)

  /**
   * CONVERSION FOR A DISTRIBUTOR (Chris 2026-09-02): their tunes against the
   * Just Autos quotes falling within a chosen radius of them.
   *
   * It is the only denominator there is. A distributor never raises a quote in
   * our system, so without this their conversion is unanswerable - which is
   * exactly what the Distributors tab said until now. Quotes near them are the
   * closest stand-in for demand they had a chance at.
   *
   * Nearest distributor wins where radii overlap, so no quote is counted for
   * two of them, and the figures reconcile with the Quotes Map overlay because
   * it is the same rule applied to the same points.
   */
  const distConv = useMemo(() => {
    const pins = dist?.byDistributor || []
    if (!pins.length || st !== 'all') return null
    const per = new Map<string, { quotes: number; value: number }>()
    // The same in-radius quotes, broken down the way the vehicle table and the
    // month grid need them, so every figure on the Distributors tab comes from
    // one pass over one set of points and they cannot disagree.
    const byGroup: Record<string, { quotes: number; value: number; months: number[] }> = {}
    let inQuotes = 0, inValue = 0
    for (const q of P.quotes.points) {
      if (q.la == null || q.ln == null) continue
      let best: DistributorTunePin | null = null, bestKm = Infinity
      for (const d of pins) {
        const km = haversineKm(q.la, q.ln, d.lat, d.lng)
        if (km <= radiusKm && km < bestKm) { bestKm = km; best = d }
      }
      if (!best) continue
      const e = per.get(best.name) || { quotes: 0, value: 0 }
      e.quotes++; e.value += q.a; per.set(best.name, e)
      const g = (byGroup[q.g] ||= { quotes: 0, value: 0, months: Array(12).fill(0) })
      g.quotes++; g.value += q.a; g.months[q.m] = (g.months[q.m] || 0) + 1
      inQuotes++; inValue += q.a
    }
    const rows = pins.map(d => {
      const e = per.get(d.name) || { quotes: 0, value: 0 }
      return { ...d, quotes: e.quotes, value: e.value, pct: e.quotes ? (100 * d.jobs) / e.quotes : null }
    }).sort((a, b) => b.jobs - a.jobs)
    const placedJobs = rows.reduce((a, r) => a + r.jobs, 0)
    return { rows, byGroup, inQuotes, inValue, placedJobs, pct: inQuotes ? (100 * placedJobs) / inQuotes : null }
  }, [dist, P.quotes.points, radiusKm, st])

  // The month-by-month grid. Per month a car is already counted once, so the
  // cells are simply added; it is only the FY column that has to come from the
  // distinct counts instead of a row sum.
  const C = useMemo<ConvCounts>(() => {
    if (!on || !dist) return base
    const jcount: Record<string, number[]> = {}
    if (jaOn) for (const k of Object.keys(base.jcount)) jcount[k] = [...(base.jcount[k] || [])]
    for (const [k, arr] of Object.entries(dist.jcount)) {
      const row = (jcount[k] ||= Array(12).fill(0))
      arr.forEach((v, i) => { row[i] = (row[i] || 0) + v })
    }
    // Distributors only: the quotes are the in-radius ones, month by month, so
    // the grid measures the same thing the tables above it do.
    if (jaOn) return { qcount: base.qcount, qval: base.qval, jcount }
    const qcount: Record<string, number[]> = {}
    const qval: Record<string, number[]> = {}
    for (const [g, v] of Object.entries(distConv?.byGroup || {})) qcount[g] = v.months
    return { qcount, qval, jcount }
  }, [base, dist, on, jaOn, distConv])


  const sum = (a: number[]) => a.reduce((x, y) => x + y, 0)
  const distTotalInCats = CK.reduce((s2, c) => s2 + distYear(c), 0)

  const rows = CK.map(c => {
    // Distributors tab: the denominator is the Just Autos quotes inside the
    // chosen radius of a distributor, per vehicle type — the same measure as
    // the by-distributor table below, cut by model instead of by name.
    const radiusQ = distConv?.byGroup?.[c]
    const q = jaOn ? sum(base.qcount[c] || []) : (radiusQ?.quotes ?? 0)
    const v = jaOn ? sum(base.qval[c] || []) : (radiusQ?.value ?? 0)
    const jJa = jaOn ? sum(base.jcount[c] || []) : 0
    const d = distYear(c)
    const j = jJa + (on ? d : 0)
    return { c, q, j, v, d, jJa, pct: q ? (100 * j) / q : 0 }
  })
  const tq = rows.reduce((a, r) => a + r.q, 0)
  const tj = rows.reduce((a, r) => a + r.j, 0)
  const tv = rows.reduce((a, r) => a + r.v, 0)
  const tjJa = rows.reduce((a, r) => a + r.jJa, 0)

  // Comparison years, run through the SAME rules as the primary year — state
  // filter and the distributor fold included — so the percentages are
  // like-for-like rather than one year counting things the other doesn't.
  const cmp = useMemo(() => comparisons.map(cy => {
    // The server pre-rolled the per-state counts so it didn't have to ship the
    // points; a state with no activity that year is simply absent.
    const cc: ConvCounts = st === 'all'
      ? cy.conv
      : (cy.convByState?.[st] || { qcount: {}, qval: {}, jcount: {} })
    const cd = cy.distributor_jobs
    const cdUsable = st === 'all' && !!cd && cd.total > 0
    const useDist = cdUsable && (src === 'both' || src === 'dist')
    const useJa = !cdUsable || src !== 'dist'
    const byVeh = CK.map(c => {
      const q = useJa ? sum(cc.qcount[c] || []) : 0
      const jBase = useJa ? sum(cc.jcount[c] || []) : 0
      // Distinct cars, same as the primary year.
      const d = cd?.jvehicles?.[c] ?? 0
      const j = jBase + (useDist ? d : 0)
      return { c, q, j, d, pct: q ? (100 * j) / q : 0 }
    })
    const tq2 = byVeh.reduce((a, b) => a + b.q, 0)
    const tj2 = byVeh.reduce((a, b) => a + b.j, 0)
    return { fy: cy.fy, byVeh, tq: tq2, tj: tj2, pct: tq2 ? (100 * tj2) / tq2 : 0 }
  }), [comparisons, st, src])

  return (
    <div className="convView">
      <div className="cards">
        <div className="card"><div className="v">{tq.toLocaleString('en-AU')}</div><div className="k">Quotes issued</div></div>
        <div className="card">
          <div className="v" style={{ color: 'var(--wm-mint)' }}>{tj.toLocaleString('en-AU')}</div>
          <div className="k">{src === 'dist' ? 'Distributor jobs' : `Booked jobs${on ? ' (incl. distributor)' : ''}`}</div>
          {src === 'both' && (
            <div className="k" style={{ fontSize: 10, marginTop: 2, opacity: 0.75 }}>
              {tjJa.toLocaleString('en-AU')} Just Autos + {distTotalInCats.toLocaleString('en-AU')} distributor
            </div>
          )}
        </div>
        <div className="card">
          <div className="v" style={{ color: 'var(--wm-amber)' }}>
            {src === 'dist'
              ? (distConv?.pct != null ? `${distConv.pct.toFixed(1)}%` : '—')
              : `${tq ? (100 * tj / tq).toFixed(1) : '0'}%`}
          </div>
          <div className="k">{src === 'dist' ? `Conversion · quotes within ${radiusKm}km` : 'Overall conversion'}</div>
          {src === 'dist' && distConv && (
            <div className="k" style={{ fontSize: 10, marginTop: 2, opacity: 0.75 }}>
              {distConv.placedJobs.toLocaleString('en-AU')} tunes / {distConv.inQuotes.toLocaleString('en-AU')} quotes in range
            </div>
          )}
        </div>
        <div className="card"><div className="v">{fmtK(tv)}</div><div className="k">Total quoted</div></div>
      </div>

      {/* Controls: distributor toggle + table/chart switch */}
      <div className="convCtl">
        {dist && dist.total > 0 && (
          <div className={'segbtns' + (distUsable ? '' : ' off')} title={distUsable
            ? 'Whose jobs to count. Distributors have no quotes, so their own conversion cannot be worked out — see them alone for the job counts by model.'
            : 'Distributor jobs are national — clear the state filter to include them'}>
            {([['ja', 'Just Autos'], ['dist', 'Distributors'], ['both', 'Both']] as [ConvSrc, string][]).map(([k, label]) => (
              <button key={k} className={src === k ? 'on' : ''} disabled={!distUsable && k !== 'ja'}
                onClick={() => setSrc(k)}>{label}</button>
            ))}
          </div>
        )}
        {on && (
          <span className="segbtns" title="Quotes counted for a distributor are the Just Autos quotes falling within this distance of them">
            {[50, 100, 150, 200].map(r => (
              <button key={r} className={radiusKm === r ? 'on' : ''} onClick={() => setRadiusKm(r)}>{r} km</button>
            ))}
          </span>
        )}
        <div className="segbtns">
          <button className={chart ? '' : 'on'} onClick={() => setChart(false)}>Table</button>
          <button className={chart ? 'on' : ''} onClick={() => setChart(true)}>Chart</button>
        </div>
      </div>

      {on && (
        <InfoNoteBlock>
          Distributor jobs come from the Distributor report&apos;s invoices — the PO number is the car&apos;s VIN — and one car is
          one job for the year, however many times it came back.{' '}
          {src === 'dist'
            ? <>Distributors raise no quotes of their own, so the quote columns here are the <b>Just Autos quotes within {radiusKm} km of a distributor</b> — the closest stand-in for demand they had a chance at. Change the radius above and every figure on this tab follows it.</>
            : <>They never had a workshop quote, so a combined conversion % reads higher than the workshop&apos;s own performance — the &ldquo;Just Autos&rdquo; tab is the one to judge the workshop on.</>}
          {dist && dist.unknown > 0 && <> {dist.unknown} VIN{dist.unknown > 1 ? 's' : ''} couldn&apos;t be matched to a model and {dist.unknown > 1 ? 'are' : 'is'} left out of the vehicle rows.</>}
        </InfoNoteBlock>
      )}

      <h2>By vehicle — full year</h2>
      {chart ? (
        <ConvBars rows={rows} COL={COL} NAME={NAME} showDist={on} cmp={cmp} fy={P.fy} />
      ) : (
        <table>
          <thead><tr><th>Vehicle</th><th>Quotes</th><th>Quoted $</th><th>Avg quote</th><th>Booked jobs</th>{on && <th>of which dist.</th>}<th>Conv %</th>{cmp.map(cy => <th key={cy.fy}>FY{String(cy.fy).slice(2)} conv %</th>)}</tr></thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.c}>
                <td className="veh"><span className="vd" style={{ background: COL[r.c] }} />{NAME[r.c]}</td>
                <td className="num">{r.q.toLocaleString('en-AU')}</td>
                <td className="num">{fmtK(r.v)}</td>
                <td className="num">{fmtK(r.q ? r.v / r.q : 0)}</td>
                <td className="num">{r.j}</td>
                {on && <td className="num" style={{ color: 'var(--wm-muted)' }}>{r.d}</td>}
                <td className="num" style={{ color: convColor(r.pct) }}>{r.q ? r.pct.toFixed(0) : '0'}%</td>
                {cmp.map(cy => {
                  const pv = cy.byVeh.find(b => b.c === r.c)
                  const delta = pv && pv.q ? r.pct - pv.pct : null
                  return (
                    <td key={cy.fy} className="num" style={{ color: 'var(--wm-muted)' }}
                        title={pv ? `FY${cy.fy}: ${pv.j} jobs / ${pv.q} quotes${on ? ` — includes ${pv.d} distributor` : pv.d ? ` (${pv.d} distributor jobs not counted)` : ''}` : ''}>
                      {pv && pv.q ? `${pv.pct.toFixed(0)}%` : '–'}
                      {delta != null && (
                        <span style={{ display: 'block', fontSize: 9.5, color: delta >= 0 ? 'var(--wm-mint)' : '#e0707a' }}>
                          {delta >= 0 ? '+' : ''}{delta.toFixed(0)} pts
                        </span>
                      )}
                    </td>
                  )
                })}
              </tr>
            ))}
            <tr className="tot">
              <td>Total</td>
              <td className="num">{tq.toLocaleString('en-AU')}</td>
              <td className="num">{fmtK(tv)}</td>
              <td className="num">{fmtK(tq ? tv / tq : 0)}</td>
              <td className="num">{tj}</td>
              {on && <td className="num" style={{ color: 'var(--wm-muted)' }}>{distTotalInCats}</td>}
              <td className="num">{tq ? (100 * tj / tq).toFixed(0) : '0'}%</td>
              {cmp.map(cy => <td key={cy.fy} className="num" style={{ color: 'var(--wm-muted)' }}>{cy.tq ? cy.pct.toFixed(0) : '0'}%</td>)}
            </tr>
          </tbody>
        </table>
      )}

      {on && distConv && (
        <>
          <h2>By distributor — full year</h2>
          <InfoNoteBlock>
            A distributor raises no quotes of their own, so their conversion is measured against the Just Autos quotes that
            fall within {radiusKm} km of them — the closest stand-in for the demand they had a chance at. Where two areas
            overlap the nearer distributor takes the quote, so nothing is counted twice, and the same rule drives the
            Quotes Map overlay.
            {(dist?.unlocated?.tunes || 0) > 0 && <> {dist!.unlocated!.tunes} tune{dist!.unlocated!.tunes === 1 ? '' : 's'} sit with distributors we have no location for, so they have no radius and are left out of this table.</>}
          </InfoNoteBlock>
          <table>
            <thead><tr><th>Distributor</th><th>Quotes in {radiusKm}km</th><th>Quoted $</th><th>Tunes</th><th>Conv %</th></tr></thead>
            <tbody>
              {distConv.rows.map(r => (
                <tr key={r.name}>
                  <td className="veh">{r.name}{r.suburb ? <span style={{ color: 'var(--wm-muted2)' }}> · {r.suburb}</span> : null}</td>
                  <td className="num">{r.quotes.toLocaleString('en-AU')}</td>
                  <td className="num">{fmtK(r.value)}</td>
                  <td className="num">{r.jobs.toLocaleString('en-AU')}</td>
                  {/* Over 100% is real and worth seeing, not an error: they tuned
                      more cars than we quoted near them — their own customers. */}
                  <td className="num" style={{ color: r.pct == null ? 'var(--wm-muted)' : convColor(Math.min(r.pct, 100)) }}
                    title={r.pct == null ? 'No Just Autos quotes within this radius — nothing to measure against' : `${r.jobs} tunes against ${r.quotes} quotes within ${radiusKm}km`}>
                    {r.pct == null ? '—' : `${r.pct.toFixed(0)}%`}
                  </td>
                </tr>
              ))}
              <tr className="tot">
                <td>Total</td>
                <td className="num">{distConv.inQuotes.toLocaleString('en-AU')}</td>
                <td className="num">{fmtK(distConv.inValue)}</td>
                <td className="num">{distConv.placedJobs.toLocaleString('en-AU')}</td>
                <td className="num">{distConv.pct == null ? '—' : `${distConv.pct.toFixed(0)}%`}</td>
              </tr>
            </tbody>
          </table>
        </>
      )}

      <h2>Conversion % by month <span style={{ color: 'var(--wm-muted2)', fontSize: 11, letterSpacing: 0, textTransform: 'none' }}>(cell = jobs / quotes)</span></h2>
      {chart ? (
        <ConvMonthBars C={C} months={P.months} COL={COL} NAME={NAME} />
      ) : (
        <div className="gridwrap">
          <table className="grid">
            <thead><tr><th>Vehicle</th>{P.months.map(m => <th key={m.k}>{m.label.split(' ')[0]}</th>)}<th>FY</th></tr></thead>
            <tbody>
              {CK.map(c => {
                // FY column: workshop months sum fine (one customer per month),
                // but distributor jobs must come from the distinct-car count or
                // a car that returned is counted twice across the year.
                const Q = jaOn ? sum(base.qcount[c] || []) : 0
                const J = (jaOn ? sum(base.jcount[c] || []) : 0) + (on ? distYear(c) : 0)
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
      )}
      <p style={{ color: 'var(--wm-muted2)', fontSize: 11, marginTop: 12, lineHeight: 1.6 }}>
        Both sides are 1 per customer per month (largest kept). Quotes by quote date; booked jobs from invoices
        (deposits, diagnostics &amp; internal excluded). Counted independently — a quote may convert in a later month.
        {st !== 'all' && <> <b style={{ color: 'var(--wm-amber)' }}>Filtered to {st === '?' ? 'unknown state' : st}</b> — state figures use geocoded quotes/jobs only, so they can differ slightly from the all-Australia view.</>}
      </p>
    </div>
  )
}

// ── Conversion charts ──────────────────────────────────────────────────────
// Inline SVG rather than a chart library: five bars and a 5×12 grouped set
// don't justify the bundle, and hand-rolling keeps the vehicle colours
// identical to the map dots (colour follows the vehicle, never the rank).
// Bars carry a 2px surface gap and direct labels — the vehicle hues sit in a
// narrow lightness band, so shape and labels do the separating, not lightness.

function ConvBars({ rows, COL, NAME, showDist, cmp, fy }: {
  rows: { c: string; q: number; j: number; d: number; pct: number }[]
  COL: Record<string, string>; NAME: Record<string, string>; showDist: boolean
  cmp: { fy: number; byVeh: { c: string; q: number; j: number; d: number; pct: number }[] }[]
  fy: number
}) {
  // The scale spans every year on screen, or a comparison year taller than the
  // primary would run past the end of its track.
  const max = Math.max(10, ...rows.map(r => r.pct), ...cmp.flatMap(cy => cy.byVeh.map(b => b.pct)))
  return (
    <div className="cbars">
      {rows.map(r => (
        <div key={r.c} className="cbarGrp">
          <div className="cbarLbl"><span className="vd" style={{ background: COL[r.c] }} />{NAME[r.c]}</div>
          <div className="cbarStack">
            {/* Primary year — full-strength vehicle colour. */}
            <div className="cbar" title={`FY${fy}: ${r.j} jobs / ${r.q} quotes${showDist && r.d ? ` — ${r.d} from distributors` : ''}`}>
              <span className="cbarYr">{cmp.length > 0 ? `FY${String(fy).slice(2)}` : ''}</span>
              <div className="cbarTrack">
                <div className="cbarFill" style={{ width: `${Math.max(0.5, (100 * r.pct) / max)}%`, background: COL[r.c] }} />
                {showDist && r.d > 0 && r.j > 0 && (
                  // The distributor slice of this bar, hatched so it reads as a
                  // different kind of job rather than a different vehicle.
                  <div className="cbarDist" style={{
                    width: `${Math.max(0, (100 * r.pct * (r.d / r.j)) / max)}%`,
                    backgroundImage: `repeating-linear-gradient(135deg, rgba(11,14,19,.55) 0 3px, transparent 3px 6px)`,
                  }} />
                )}
              </div>
              <div className="cbarVal">{r.pct.toFixed(0)}%<span>{r.j}/{r.q}</span></div>
            </div>
            {/* Comparison years — same hue (colour follows the vehicle, never
                the year), stepped back in opacity, year named on the bar. */}
            {cmp.map((cy, i) => {
              const b = cy.byVeh.find(x => x.c === r.c)
              if (!b) return null
              return (
                <div key={cy.fy} className="cbar prior" title={`FY${cy.fy}: ${b.j} jobs / ${b.q} quotes`}>
                  <span className="cbarYr">FY{String(cy.fy).slice(2)}</span>
                  <div className="cbarTrack">
                    <div className="cbarFill" style={{
                      width: `${Math.max(b.q ? 0.5 : 0, (100 * b.pct) / max)}%`,
                      background: COL[r.c], opacity: 0.5 - i * 0.12,
                    }} />
                  </div>
                  <div className="cbarVal">{b.q ? `${b.pct.toFixed(0)}%` : '–'}<span>{b.j}/{b.q}</span></div>
                </div>
              )
            })}
          </div>
        </div>
      ))}
      {showDist && <div className="cbarKey"><span className="hatch" /> hatched = distributor jobs</div>}
    </div>
  )
}

function ConvMonthBars({ C, months, COL, NAME }: {
  C: ConvCounts; months: { k: string; label: string }[]
  COL: Record<string, string>; NAME: Record<string, string>
}) {
  const pct = (c: string, i: number) => {
    const q = (C.qcount[c] || [])[i] || 0, j = (C.jcount[c] || [])[i] || 0
    return { q, j, p: q ? (100 * j) / q : 0 }
  }
  const max = Math.max(10, ...months.flatMap((_, i) => CK.map(c => pct(c, i).p)))
  const W = 1080, H = 260, padL = 34, padB = 26, padT = 8
  const plotW = W - padL - 8, plotH = H - padB - padT
  const groupW = plotW / months.length
  const barW = Math.max(3, (groupW - 8) / CK.length - 2)   // 2px gap between adjacent bars

  return (
    <div className="cmonth">
      <div className="cmLegend">
        {CK.map(c => <span key={c}><span className="vd" style={{ background: COL[c] }} />{(NAME[c] || c).replace('LC ', '')}</span>)}
      </div>
      <div className="cmScroll">
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label="Conversion percent by vehicle and month">
          {[0, 0.25, 0.5, 0.75, 1].map(f => {
            const y = padT + plotH - f * plotH
            return (
              <g key={f}>
                <line x1={padL} x2={W - 8} y1={y} y2={y} stroke="#243040" strokeWidth={1} />
                <text x={padL - 6} y={y + 3} textAnchor="end" fontSize={9} fill="#566273">{(max * f).toFixed(0)}%</text>
              </g>
            )
          })}
          {months.map((m, i) => {
            const gx = padL + i * groupW
            return (
              <g key={m.k}>
                {CK.map((c, ci) => {
                  const { q, j, p } = pct(c, i)
                  const h = max ? (p / max) * plotH : 0
                  const x = gx + 4 + ci * (barW + 2)
                  return (
                    <rect key={c} x={x} y={padT + plotH - h} width={barW} height={Math.max(q ? 1 : 0, h)}
                      fill={COL[c]} rx={2}>
                      <title>{`${m.label} · ${NAME[c]}: ${p.toFixed(0)}% (${j}/${q})`}</title>
                    </rect>
                  )
                })}
                <text x={gx + groupW / 2} y={H - 8} textAnchor="middle" fontSize={9} fill="#7A8696">{m.label.split(' ')[0]}</text>
              </g>
            )
          })}
        </svg>
      </div>
    </div>
  )
}

// ── State breakdown tab ────────────────────────────────────────────────────

const STATE_LABEL: Record<string, string> = {
  QLD: 'Queensland', NSW: 'New South Wales', VIC: 'Victoria', SA: 'South Australia',
  WA: 'Western Australia', TAS: 'Tasmania', NT: 'Northern Territory', ACT: 'ACT', '?': 'Unknown',
}

function StateView({ P, month, cat }: { P: Payload; month: number; cat: string }) {
  const pass = (p: Pt) => (month < 0 || p.m === month) && (cat === 'all' || p.g === cat)
  const jobs = P.jobs.points.filter(pass)
  const quotes = P.quotes.points.filter(pass)

  const S: Record<string, { st: string; jn: number; jt: number; qn: number; qt: number; won: number; locs: Set<string> }> = {}
  const row = (st: string) => (S[st] ||= { st, jn: 0, jt: 0, qn: 0, qt: 0, won: 0, locs: new Set() })
  // Count the job in the state row regardless, but only add a LOCATION when it
  // actually has coordinates - otherwise every un-geocoded row lands in one
  // phantom "@null,null" location.
  jobs.forEach(p => { const r = row(pcState(p.pc)); r.jn++; r.jt += p.a; if (p.la != null && p.ln != null) r.locs.add(p.pc + '@' + p.la + ',' + p.ln) })
  quotes.forEach(p => { const r = row(pcState(p.pc)); r.qn++; r.qt += p.a; r.won += (p.w || 0) })
  const rows = Object.values(S).sort((a, b) => b.jt - a.jt || b.qt - a.qt)

  const tr = jobs.reduce((s, p) => s + p.a, 0)
  const tq = quotes.length, tv = quotes.reduce((s, p) => s + p.a, 0)
  const twon = rows.reduce((s, r) => s + r.won, 0)
  const qldShare = tr ? 100 * (S['QLD']?.jt || 0) / tr : 0

  // Monthly revenue grid — full FY, vehicle filter only (month filter drives the table above).
  const jobsFY = P.jobs.points.filter(p => cat === 'all' || p.g === cat)
  const grid: Record<string, number[]> = {}
  jobsFY.forEach(p => { const st = pcState(p.pc); (grid[st] ||= Array(12).fill(0))[p.m] += p.a })
  const sum = (a: number[]) => a.reduce((x, y) => x + y, 0)
  const gridStates = Object.keys(grid).sort((a, b) => sum(grid[b]) - sum(grid[a]))
  const fyTotal = gridStates.reduce((s, st) => s + sum(grid[st]), 0)

  return (
    <div className="convView">
      <div className="cards">
        <div className="card"><div className="v">{fmtK(tr)}</div><div className="k">Revenue (inc GST)</div></div>
        <div className="card"><div className="v" style={{ color: 'var(--wm-mint)' }}>{jobs.length.toLocaleString('en-AU')}</div><div className="k">Booked jobs</div></div>
        <div className="card"><div className="v">{rows.length}</div><div className="k">States reached</div></div>
        <div className="card"><div className="v" style={{ color: 'var(--wm-amber)' }}>{qldShare.toFixed(0)}%</div><div className="k">QLD share of revenue</div></div>
      </div>

      <h2>By state</h2>
      <table>
        <thead><tr><th>State</th><th>Jobs</th><th>Revenue</th><th>% rev</th><th>Avg / job</th><th>Locations</th><th>Quotes</th><th>Quoted $</th><th>Won</th><th>Win %</th></tr></thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.st}>
              <td className="veh" title={STATE_LABEL[r.st] || r.st}>{r.st === '?' ? 'Unknown' : r.st}</td>
              <td className="num">{r.jn.toLocaleString('en-AU')}</td>
              <td className="num">{fmtK(r.jt)}</td>
              <td className="num"><span className="sbar"><i style={{ width: `${tr ? Math.max(1.5, 100 * r.jt / tr) : 0}%` }} /></span>{tr ? (100 * r.jt / tr).toFixed(1) : '0'}%</td>
              <td className="num">{fmtK(r.jn ? r.jt / r.jn : 0)}</td>
              <td className="num">{r.locs.size}</td>
              <td className="num">{r.qn.toLocaleString('en-AU')}</td>
              <td className="num">{fmtK(r.qt)}</td>
              <td className="num">{r.won}</td>
              <td className="num" style={{ color: r.qn ? convColor(100 * r.won / r.qn) : '#3a4658' }}>{r.qn ? (100 * r.won / r.qn).toFixed(0) + '%' : '–'}</td>
            </tr>
          ))}
          <tr className="tot">
            <td>Total</td>
            <td className="num">{jobs.length.toLocaleString('en-AU')}</td>
            <td className="num">{fmtK(tr)}</td>
            <td className="num">100%</td>
            <td className="num">{fmtK(jobs.length ? tr / jobs.length : 0)}</td>
            <td className="num">{rows.reduce((s, r) => s + r.locs.size, 0)}</td>
            <td className="num">{tq.toLocaleString('en-AU')}</td>
            <td className="num">{fmtK(tv)}</td>
            <td className="num">{twon}</td>
            <td className="num">{tq ? (100 * twon / tq).toFixed(0) + '%' : '–'}</td>
          </tr>
        </tbody>
      </table>

      <h2>Revenue by state per month <span style={{ color: 'var(--wm-muted2)', fontSize: 11, letterSpacing: 0, textTransform: 'none' }}>(full year{cat !== 'all' ? ', filtered by vehicle' : ''})</span></h2>
      <div className="gridwrap">
        <table className="grid">
          <thead><tr><th>State</th>{P.months.map(m => <th key={m.k}>{m.label.split(' ')[0]}</th>)}<th>FY</th></tr></thead>
          <tbody>
            {gridStates.map(st => (
              <tr key={st}>
                <td className="veh" title={STATE_LABEL[st] || st}>{st === '?' ? 'Unknown' : st}</td>
                {Array.from({ length: 12 }, (_, i) => {
                  const v = grid[st][i]
                  return <td key={i} className="cv" style={{ color: v ? 'var(--wm-txt)' : '#3a4658' }}>{v ? fmtK(v) : '–'}</td>
                })}
                <td className="cv" style={{ color: 'var(--wm-blue)' }}>{fmtK(sum(grid[st]))}</td>
              </tr>
            ))}
            <tr className="tot">
              <td>Total</td>
              {Array.from({ length: 12 }, (_, i) => <td key={i} className="cv num">{fmtK(gridStates.reduce((s, st) => s + grid[st][i], 0))}</td>)}
              <td className="cv num">{fmtK(fyTotal)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p style={{ color: 'var(--wm-muted2)', fontSize: 11, marginTop: 12, lineHeight: 1.6 }}>
        State is derived from the customer postcode. Jobs are booked jobs (1 per customer per month, deposits /
        diagnostics / internal excluded); Won = quotes matched to a booked job. The month and vehicle filters above apply to the table.
      </p>
    </div>
  )
}

// ── Vehicle Trend tab ──────────────────────────────────────────────────────
// One line per vehicle series over the buckets the current selection implies:
// FY selected → 12 monthly points; a month selected → one point per day
// (Chris 2026-08-20). Data comes from /api/workshop/map/vehicle-trend, which
// counts every invoice and quote — NOT the map's 1-per-customer/month dots —
// because a work-volume trend wants the raw counts.

type TrendMeasure = 'jobs' | 'quotes' | 'jobValue' | 'quoteValue'

const MEASURES: { k: TrendMeasure; label: string; money: boolean }[] = [
  { k: 'jobs',       label: 'Jobs',      money: false },
  { k: 'quotes',     label: 'Quotes',    money: false },
  { k: 'jobValue',   label: 'Job $',     money: true  },
  { k: 'quoteValue', label: 'Quoted $',  money: true  },
]

interface TrendRow { bucket: string; group: string; state: string; jobs: number; quotes: number; jobValue: number; quoteValue: number }
interface TrendResp { fy: number; monthIdx: number | null; granularity: 'month' | 'day'; buckets: { k: string; label: string }[]; rows: TrendRow[] }

function VehicleTrendView({
  fy, compareFys, months, cats, month, setMonth, cat, setCat, st, setSt,
}: {
  fy: number
  compareFys: number[]
  months: { k: string; label: string }[]
  cats: { k: string; n: string; col: string }[]
  month: number
  setMonth: (m: number) => void
  cat: string
  setCat: (c: string) => void
  st: string
  setSt: (s: string) => void
}) {
  const [resp, setResp] = useState<TrendResp | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [measure, setMeasure] = useState<TrendMeasure>('jobs')
  // Which vehicle types to compare. Empty = all of them (the default), so the
  // view opens exactly as it did before anyone touched these chips.
  const [picked, setPicked] = useState<string[]>([])
  // Prior-year series, keyed by FY. Compared like-for-like against the same
  // bucket positions — Jul is Jul in both years.
  const [priors, setPriors] = useState<Record<number, TrendResp>>({})

  // Refetch whenever the FY or month selection changes — the bucket grain
  // itself depends on it, so this can't be filtered client-side.
  useEffect(() => {
    let cancelled = false
    setLoading(true); setErr('')
    const qs = `fy=${fy}${month >= 0 ? `&month=${month}` : ''}`
    fetch(`/api/workshop/map/vehicle-trend?${qs}`)
      .then(r => r.json())
      .then(j => { if (cancelled) return; if (j.error) setErr(j.error); else setResp(j) })
      .catch(e => { if (!cancelled) setErr(String(e?.message || e)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [fy, month])

  // Comparison years — one fetch each, same month grain. Fetched separately
  // rather than server-joined so a slow or missing year degrades to "this year
  // only" instead of failing the whole view.
  useEffect(() => {
    let cancelled = false
    if (!compareFys.length) { setPriors({}); return }
    Promise.all(compareFys.map(cf =>
      fetch(`/api/workshop/map/vehicle-trend?fy=${cf}${month >= 0 ? `&month=${month}` : ''}`)
        .then(r => r.json()).then(j => (j && !j.error ? [cf, j] as const : null)).catch(() => null),
    )).then(pairs => {
      if (cancelled) return
      const out: Record<number, TrendResp> = {}
      for (const p of pairs) if (p) out[p[0]] = p[1]
      setPriors(out)
    })
    return () => { cancelled = true }
  }, [compareFys, month])

  const money = MEASURES.find(m => m.k === measure)!.money

  // Per-state totals for the pills come from the unfiltered rows, so a pill
  // never disappears just because it's the one that's deselected.
  const stateTotals = useMemo(() => {
    const out: Record<string, { jobs: number; quotes: number; value: number }> = {}
    for (const r of resp?.rows || []) {
      const a = (out[r.state] ||= { jobs: 0, quotes: 0, value: 0 })
      a.jobs += r.jobs; a.quotes += r.quotes; a.value += r.jobValue
    }
    return out
  }, [resp])

  // series[group] = one number per bucket, for the selected measure + state.
  const { series, bucketTotals, groupTotals, maxVal } = useMemo(() => {
    const n = resp?.buckets.length || 0
    const at = new Map((resp?.buckets || []).map((b, i) => [b.k, i]))
    const series: Record<string, number[]> = {}
    for (const c of cats) series[c.k] = Array(n).fill(0)
    const bucketTotals = Array(n).fill(0) as number[]
    const groupTotals: Record<string, number> = {}
    for (const r of resp?.rows || []) {
      if (st !== 'all' && r.state !== st) continue
      const i = at.get(r.bucket); if (i == null) continue
      const v = r[measure] || 0
      ;(series[r.group] ||= Array(n).fill(0))[i] += v
      bucketTotals[i] += v
      groupTotals[r.group] = (groupTotals[r.group] || 0) + v
    }
    // Peak of what is actually on screen — when vehicle types are being
    // compared, a peak belonging to a type you excluded is just misleading.
    let maxVal = 0
    for (const c of cats) {
      if (picked.length && !picked.includes(c.k)) continue
      for (const v of series[c.k] || []) if (v > maxVal) maxVal = v
    }
    return { series, bucketTotals, groupTotals, maxVal: maxVal || 1 }
  }, [resp, cats, measure, st, picked])

  // Series worth drawing, biggest first — an all-zero group would just be a
  // flat line on the axis and a wasted legend row. When vehicle types have been
  // picked for comparison, only those are drawn.
  const drawn = useMemo(
    () => cats
      .filter(c => (groupTotals[c.k] || 0) > 0)
      .filter(c => picked.length === 0 || picked.includes(c.k))
      .sort((a, b) => (groupTotals[b.k] || 0) - (groupTotals[a.k] || 0)),
    [cats, groupTotals, picked],
  )

  // "Others" — everything with volume that ISN'T picked, summed into one line,
  // so a comparison reads as "70 and 300 against the rest" rather than losing
  // the rest entirely.
  const [showOthers, setShowOthers] = useState(false)
  const othersSeries = useMemo(() => {
    if (!picked.length || !showOthers) return null
    const n = resp?.buckets.length || 0
    const out = Array(n).fill(0) as number[]
    let tot = 0
    for (const c of cats) {
      if (picked.includes(c.k)) continue
      const row = series[c.k] || []
      for (let i = 0; i < n; i++) { out[i] += row[i] || 0 }
      tot += groupTotals[c.k] || 0
    }
    return tot > 0 ? { vals: out, total: tot } : null
  }, [picked, showOthers, cats, series, groupTotals, resp])

  // Prior-year comparison lines: the picked vehicles (or all) summed per bucket,
  // one line per year. Summed rather than per-vehicle-per-year because 5
  // vehicles x 3 years is 15 lines and nobody can read that.
  const priorSeries = useMemo(() => {
    const n = resp?.buckets.length || 0
    return compareFys.map(cf => {
      const pr = priors[cf]
      if (!pr) return null
      const vals = Array(n).fill(0) as number[]
      // Compare by bucket POSITION (Jul->Jul), not by date key — the years differ.
      for (const r of pr.rows) {
        if (st !== 'all' && r.state !== st) continue
        if (picked.length && !picked.includes(r.group)) continue
        const i = pr.buckets.findIndex(b => b.k === r.bucket)
        if (i < 0 || i >= n) continue
        vals[i] += (r as any)[measure] || 0
      }
      const total = vals.reduce((a, b) => a + b, 0)
      return total > 0 ? { fy: cf, vals, total } : null
    }).filter(Boolean) as { fy: number; vals: number[]; total: number }[]
  }, [compareFys, priors, resp, st, picked, measure])

  // The plot scales to everything drawn on it — prior years and the Others
  // line included, or they run off the top of the chart.
  const chartMax = useMemo(() => {
    let m = 0
    for (const c of drawn) for (const v of (series[c.k] || [])) if (v > m) m = v
    for (const ps of priorSeries) for (const v of ps.vals) if (v > m) m = v
    for (const v of (othersSeries?.vals || [])) if (v > m) m = v
    return m || 1
  }, [drawn, series, priorSeries, othersSeries])

  const fmtV = (v: number) => money ? fmtK(v) : Math.round(v).toLocaleString('en-AU')
  const grandTotal = Object.values(groupTotals).reduce((s, v) => s + v, 0)

  // ── Chart geometry (plain SVG — no chart lib in this bundle) ──────────
  const W = 1000, H = 320
  const pad = { top: 14, right: 16, bottom: 30, left: 62 }
  const plotW = W - pad.left - pad.right
  const plotH = H - pad.top - pad.bottom
  const nB = resp?.buckets.length || 0
  const xAt = (i: number) => pad.left + (nB <= 1 ? plotW / 2 : (plotW * i) / (nB - 1))
  const yAt = (v: number) => pad.top + plotH - (v / chartMax) * plotH
  // Daily views get a lot of ticks — thin them so labels stay readable.
  const tickEvery = nB > 20 ? Math.ceil(nB / 15) : 1

  return (
    <div className="convView">
      {/* Month strip — 'All FY' gives the monthly trend, a month drills to daily. */}
      <div className="strip months" style={{ margin: '0 0 8px', padding: 0, background: 'none', border: 'none' }}>
        <span className="striplabel">Bucket</span>
        <button className={'mbtn' + (month < 0 ? ' active' : '')} onClick={() => setMonth(-1)}>
          All FY<span className="mt">monthly</span>
        </button>
        {months.map((mo, i) => (
          <button key={mo.k} className={'mbtn' + (month === i ? ' active' : '')} onClick={() => setMonth(month === i ? -1 : i)}>
            {mo.label.split(' ')[0]}<span className="mt">daily</span>
          </button>
        ))}
      </div>

      <div className="strip vehs" style={{ margin: '0 0 8px', padding: 0, background: 'none', border: 'none' }}>
        <span className="striplabel">Compare</span>
        <button className={'mbtn' + (picked.length === 0 ? ' active' : '')}
          title="Show every vehicle type" onClick={() => setPicked([])}>All types</button>
        {cats.filter(c => (groupTotals[c.k] || 0) > 0).map(c => (
          <button key={`pk${c.k}`} className={'mbtn' + (picked.includes(c.k) ? ' active' : '')}
            style={picked.includes(c.k) ? { borderColor: c.col, color: c.col } : undefined}
            title={`Compare ${c.n}`}
            onClick={() => setPicked(pk => pk.includes(c.k) ? pk.filter(x => x !== c.k) : [...pk, c.k])}>
            {c.n.replace('LC ', '')}
          </button>
        ))}
        {picked.length > 0 && (
          <button className={'mbtn' + (showOthers ? ' active' : '')}
            title="Add everything not picked as a single grey line"
            onClick={() => setShowOthers(o => !o)}>vs others</button>
        )}
      </div>

      <div className="strip vehs" style={{ margin: '0 0 8px', padding: 0, background: 'none', border: 'none' }}>
        <span className="striplabel">Measure</span>
        {MEASURES.map(m => (
          <button key={m.k} className={'mbtn' + (measure === m.k ? ' active' : '')} onClick={() => setMeasure(m.k)}>{m.label}</button>
        ))}
        <span className="striplabel" style={{ marginLeft: 10 }}>State</span>
        <button className={'mbtn' + (st === 'all' ? ' active' : '')} onClick={() => setSt('all')}>All AU</button>
        {Object.keys(stateTotals).filter(k => k !== '?').sort().map(k => (
          <button key={k} className={'mbtn' + (st === k ? ' active' : '')} onClick={() => setSt(st === k ? 'all' : k)}>
            {k}<span className="mt">{stateTotals[k].jobs} · {stateTotals[k].quotes}</span>
          </button>
        ))}
      </div>

      {loading && !resp && <div style={{ color: 'var(--wm-muted)', fontSize: 13, padding: '30px 0' }}>Loading trend…</div>}
      {err && <div style={{ color: '#e0707a', fontSize: 13, padding: '10px 0' }}>Couldn&apos;t load the trend: {err}</div>}

      {resp && !err && (
        <>
          <div className="cards">
            <div className="card"><div className="v">{fmtV(grandTotal)}</div><div className="k">{MEASURES.find(m => m.k === measure)!.label} · {month < 0 ? 'full FY' : months[month]?.label}</div></div>
            <div className="card"><div className="v" style={{ color: 'var(--wm-mint)' }}>{fmtV(nB ? grandTotal / nB : 0)}</div><div className="k">Avg per {resp.granularity}</div></div>
            <div className="card"><div className="v" style={{ color: 'var(--wm-amber)' }}>{drawn[0] ? (drawn[0].n || '').replace('LC ', '') : '–'}</div><div className="k">Top series</div></div>
            <div className="card"><div className="v">{fmtV(maxVal)}</div><div className="k">Peak {resp.granularity}</div></div>
          </div>

          <h2>{MEASURES.find(m => m.k === measure)!.label} by vehicle — {resp.granularity === 'month' ? 'monthly' : 'daily'}</h2>

          <div className="gridwrap">
            <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} style={{ display: 'block' }} role="img"
                 aria-label={`${MEASURES.find(m => m.k === measure)!.label} per vehicle series, ${resp.granularity} buckets`}>
              {/* Gridlines + Y labels */}
              {[0, 0.25, 0.5, 0.75, 1].map((f, i) => (
                <g key={i}>
                  <line x1={pad.left} y1={yAt(chartMax * f)} x2={pad.left + plotW} y2={yAt(chartMax * f)} stroke="#243040" strokeWidth={1} />
                  <text x={pad.left - 8} y={yAt(chartMax * f) + 4} textAnchor="end" fill="#566273" fontSize={11} fontFamily="Space Mono, monospace">{fmtV(chartMax * f)}</text>
                </g>
              ))}
              {/* X labels */}
              {resp.buckets.map((b, i) => (i % tickEvery === 0 ? (
                <text key={b.k} x={xAt(i)} y={H - 10} textAnchor="middle" fill="#566273" fontSize={11} fontFamily="Space Mono, monospace">
                  {resp.granularity === 'month' ? b.label.split(' ')[0] : b.label}
                </text>
              ) : null))}
              {/* One polyline per series. A vehicle pill selection emphasises
                  rather than filters, so the comparison stays on screen. */}
              {drawn.map(c => {
                const pts = (series[c.k] || []).map((v, i) => `${xAt(i)},${yAt(v)}`).join(' ')
                const dimmed = cat !== 'all' && cat !== c.k
                return (
                  <g key={c.k} opacity={dimmed ? 0.15 : 1}>
                    <polyline points={pts} fill="none" stroke={c.col} strokeWidth={cat === c.k ? 3 : 2}
                              strokeLinejoin="round" strokeLinecap="round" />
                    {/* Dots only when there's room, else the daily view turns to mush. */}
                    {nB <= 20 && (series[c.k] || []).map((v, i) => (
                      <circle key={i} cx={xAt(i)} cy={yAt(v)} r={3} fill={c.col}>
                        <title>{`${c.n} · ${resp.buckets[i].label}: ${fmtV(v)}`}</title>
                      </circle>
                    ))}
                  </g>
                )
              })}
              {/* Everything not picked, as one grey line — so a two-vehicle
                  comparison still shows what it's being compared against. */}
              {othersSeries && (
                <polyline points={othersSeries.vals.map((v, i) => `${xAt(i)},${yAt(v)}`).join(' ')}
                          fill="none" stroke="#7A8696" strokeWidth={2} strokeDasharray="1 4"
                          strokeLinecap="round" />
              )}
              {/* Prior years — same hue family, dashed and progressively fainter,
                  so "which year" reads off the line style and "which vehicle"
                  keeps reading off colour. */}
              {priorSeries.map((ps, idx) => (
                <g key={ps.fy} opacity={0.75 - idx * 0.18}>
                  <polyline points={ps.vals.map((v, i) => `${xAt(i)},${yAt(v)}`).join(' ')}
                            fill="none" stroke="#E6EDF3" strokeWidth={2}
                            strokeDasharray={idx === 0 ? '6 4' : '2 3'}
                            strokeLinejoin="round" strokeLinecap="round" />
                  {nB <= 20 && ps.vals.map((v, i) => (
                    <circle key={i} cx={xAt(i)} cy={yAt(v)} r={2.5} fill="#E6EDF3">
                      <title>{`FY${ps.fy} · ${resp.buckets[i]?.label}: ${fmtV(v)}`}</title>
                    </circle>
                  ))}
                </g>
              ))}
              {/* Axes last so they sit above the fills */}
              <line x1={pad.left} y1={pad.top} x2={pad.left} y2={pad.top + plotH} stroke="#3a4658" strokeWidth={1} />
              <line x1={pad.left} y1={pad.top + plotH} x2={pad.left + plotW} y2={pad.top + plotH} stroke="#3a4658" strokeWidth={1} />
            </svg>
          </div>

          {/* Legend doubles as the emphasis control. */}
          <div className="strip vehs" style={{ margin: '8px 0 0', padding: 0, background: 'none', border: 'none' }}>
            <button className={'chip' + (cat === 'all' ? ' active' : '')} style={{ color: 'var(--wm-blue)' }} onClick={() => setCat('all')}>
              <span className="dot" style={{ background: 'var(--wm-blue)' }} /><span className="nm">All</span>
              <span className="num">{fmtV(grandTotal)}</span>
            </button>
            {drawn.map(c => (
              <button key={c.k} className={'chip' + (cat === c.k ? ' active' : '') + (cat !== 'all' && cat !== c.k ? ' dim' : '')}
                      style={{ color: c.col }} onClick={() => setCat(cat === c.k ? 'all' : c.k)}>
                <span className="dot" style={{ background: c.col }} /><span className="nm">{c.n}</span>
                <span className="num">{fmtV(groupTotals[c.k] || 0)}</span>
              </button>
            ))}
            {othersSeries && (
              <span className="chip" style={{ color: 'var(--wm-muted)', cursor: 'default' }}>
                <span className="dot" style={{ background: 'var(--wm-muted)' }} /><span className="nm">Others</span>
                <span className="num">{fmtV(othersSeries.total)}</span>
              </span>
            )}
            {priorSeries.map((ps, idx) => (
              <span key={ps.fy} className="chip" style={{ color: 'var(--wm-txt)', cursor: 'default' }}>
                <span className="dash" style={{ borderTopStyle: idx === 0 ? 'dashed' : 'dotted' }} />
                <span className="nm">FY{ps.fy}</span>
                <span className="num">{fmtV(ps.total)}</span>
              </span>
            ))}
          </div>

          <h2>Per {resp.granularity} totals</h2>
          <div className="gridwrap">
            <table className="grid">
              <thead>
                <tr>
                  <th>Vehicle</th>
                  {resp.buckets.map(b => <th key={b.k}>{resp.granularity === 'month' ? b.label.split(' ')[0] : b.label}</th>)}
                  <th>{month < 0 ? 'FY' : 'Month'}</th>
                </tr>
              </thead>
              <tbody>
                {drawn.map(c => (
                  <tr key={c.k}>
                    <td className="veh"><span className="vd" style={{ background: c.col }} />{(c.n || c.k).replace('LC ', '')}</td>
                    {(series[c.k] || []).map((v, i) => (
                      <td key={i} className="cv num" style={{ color: v ? undefined : '#3a4658' }}>{v ? fmtV(v) : '–'}</td>
                    ))}
                    <td className="cv num">{fmtV(groupTotals[c.k] || 0)}</td>
                  </tr>
                ))}
                <tr className="tot">
                  <td>Total</td>
                  {bucketTotals.map((v, i) => <td key={i} className="cv num">{v ? fmtV(v) : '–'}</td>)}
                  <td className="cv num">{fmtV(grandTotal)}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <p style={{ color: 'var(--wm-muted2)', fontSize: 11, marginTop: 12, lineHeight: 1.6 }}>
            Every invoice and quote is counted — unlike the maps, which show one dot per customer per month, so these
            numbers run higher than the Jobs/Quotes map totals. Jobs are booked jobs by invoice date (deposits,
            diagnostics &amp; internal excluded); quotes by quote date. Pick a month above to drill from the monthly
            trend into that month day by day. Clicking a vehicle highlights its line rather than hiding the others.
            {st !== 'all' && <> <b style={{ color: 'var(--wm-amber)' }}>Filtered to {st}</b> — state comes from the customer postcode, so records without one are excluded.</>}
          </p>
        </>
      )}
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
.wm-dash .pdfbtn{background:var(--wm-panel2);border:1px solid var(--wm-line);color:var(--wm-muted);border-radius:6px;padding:5px 11px;margin-right:10px;cursor:pointer;font-family:inherit;font-size:11.5px;font-weight:600;white-space:nowrap}
.wm-dash .pdfbtn:hover:not(:disabled){color:var(--wm-txt);border-color:var(--wm-muted2)}
.wm-dash .pdfbtn:disabled{opacity:.5;cursor:default}
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
.wm-dash .avgn{display:block;font-size:9.5px;font-weight:600;opacity:.6;letter-spacing:.02em}
.wm-dash .chip.dim{opacity:.38}.wm-dash .chip.active{box-shadow:0 0 0 1px currentColor inset}
.wm-dash .wrap{flex:1 1 auto;position:relative;min-height:0}
.wm-dash .mapdiv{position:absolute;inset:0;background:#080b10}
/* Distributor tune pins. Square and outlined so they never read as one of the
   round customer dots — this is a distributor's premises with work counted
   against it, not demand at that address. */
.wm-dash .tunepin{box-sizing:border-box;border-radius:4px;background:rgba(110,168,254,.85);border:1.5px solid #cfe0ff;color:#06131f;font:700 10px/1 'Space Mono',monospace;text-align:center;display:flex;align-items:center;justify-content:center}
.wm-dash .leaflet-div-icon{background:transparent!important;border:0!important}
.wm-dash .statelbl{font-family:'Barlow Condensed';font-weight:800;font-size:15px;color:rgba(150,164,182,.72);letter-spacing:3px;text-transform:uppercase;text-shadow:0 0 4px #0B0E13,0 1px 2px #000;white-space:nowrap;pointer-events:none}
.wm-dash .citylbl{display:flex;align-items:center;gap:4px;white-space:nowrap;pointer-events:none}
.wm-dash .citylbl i{width:5px;height:5px;border-radius:50%;background:#cdd7e2;box-shadow:0 0 0 2px rgba(0,0,0,.5)}
.wm-dash .citylbl span{font-family:'Barlow';font-weight:600;font-size:11px;color:#aeb9c6;text-shadow:0 1px 3px #000}
.wm-dash .citylbl.home i{background:var(--wm-mint);width:7px;height:7px;box-shadow:0 0 8px var(--wm-mint)}.wm-dash .citylbl.home span{color:var(--wm-mint)}
.wm-dash .leaflet-popup-content-wrapper{background:var(--wm-panel);color:var(--wm-txt);border:1px solid var(--wm-line);border-radius:9px}
.wm-dash .leaflet-popup-tip{background:var(--wm-panel);border:1px solid var(--wm-line)}
.wm-dash .leaflet-popup-content{margin:12px 14px;font-family:'Barlow'}
.wm-dash .pop-h{display:flex;align-items:center;justify-content:space-between;gap:10px;font-family:'Barlow Condensed';font-weight:800;font-size:18px;text-transform:uppercase}
.wm-dash .pop-exp{flex:0 0 auto;font-family:'Space Mono';font-size:10px;font-weight:700;letter-spacing:.5px;color:var(--wm-blue);background:var(--wm-panel2);border:1px solid var(--wm-line);border-radius:6px;padding:4px 8px;cursor:pointer;text-transform:none}
.wm-dash .pop-exp:hover{color:#04141c;background:var(--wm-blue);border-color:var(--wm-blue)}
.wm-dash .pop-more{font-size:10px;color:var(--wm-muted2);padding-top:6px}
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
/* Conversion controls — distributor toggle + table/chart switch */
.wm-dash .fysel .cmpLbl{font-size:10px;color:var(--wm-muted2);padding:0 4px;align-self:center}
.wm-dash .fysel .mbtn.cmp{opacity:.75;border-style:dashed}
.wm-dash .fysel .mbtn.cmp.na{opacity:.3;cursor:not-allowed}
.wm-dash .fysel .mbtn.cmp.active{opacity:1;border-style:solid}
.wm-dash .chip .dash{display:inline-block;width:16px;height:0;border-top:2px dashed var(--wm-txt);margin-right:2px}
.wm-dash .convCtl{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:14px 0 4px}
.wm-dash .distTog{display:inline-flex;align-items:center;gap:8px;font-size:12px;color:var(--wm-txt);background:var(--wm-panel);border:1px solid var(--wm-line);border-radius:8px;padding:7px 11px;cursor:pointer}
.wm-dash .distTog.off{opacity:.45;cursor:not-allowed}
.wm-dash .distTog input{accent-color:var(--wm-mint);cursor:inherit}
.wm-dash .distTog b{color:var(--wm-mint);font-weight:600}
.wm-dash .segbtns{display:inline-flex;border:1px solid var(--wm-line);border-radius:8px;overflow:hidden;margin-left:auto}
.wm-dash .segbtns button{background:var(--wm-panel);border:0;color:var(--wm-muted);font-family:inherit;font-size:12px;padding:7px 14px;cursor:pointer}
.wm-dash .segbtns button.on{background:var(--wm-panel2);color:var(--wm-txt);font-weight:600}
.wm-dash .infoBtn{width:16px;height:16px;flex:0 0 16px;border-radius:50%;border:1px solid var(--wm-border,#2b3a4d);background:transparent;color:var(--wm-muted2);font:600 10px/1 'Barlow',sans-serif;cursor:pointer;padding:0;display:inline-flex;align-items:center;justify-content:center;vertical-align:middle}
.wm-dash .infoBtn:hover{color:var(--wm-text,#e8edf4);border-color:var(--wm-muted)}
.wm-dash .infoBtn.on{background:var(--wm-panel);color:var(--wm-text,#e8edf4)}
.wm-dash .infoPop{color:var(--wm-muted2);font-size:11px;line-height:1.6;margin:8px 0 0;max-width:900px;border-left:2px solid var(--wm-border,#2b3a4d);padding-left:10px}
/* Horizontal conversion bars */
.wm-dash .cbars{display:flex;flex-direction:column;gap:8px;margin-top:6px}
.wm-dash .cbar{display:grid;grid-template-columns:150px 1fr 92px;align-items:center;gap:12px}
.wm-dash .cbarLbl{display:flex;align-items:center;gap:7px;font-size:12px;color:var(--wm-txt);white-space:nowrap}
.wm-dash .cbarTrack{position:relative;height:20px;background:var(--wm-panel);border-radius:4px;overflow:hidden}
.wm-dash .cbarFill{position:absolute;left:0;top:0;bottom:0;border-radius:0 4px 4px 0}
.wm-dash .cbarDist{position:absolute;left:0;top:0;bottom:0;border-radius:0 4px 4px 0}
.wm-dash .cbarVal{font-size:13px;font-weight:600;color:var(--wm-txt);text-align:right}
.wm-dash .cbarVal span{display:block;font-size:10px;font-weight:400;color:var(--wm-muted2)}
.wm-dash .cbarGrp{display:grid;grid-template-columns:150px 1fr;align-items:start;gap:12px}
.wm-dash .cbarGrp .cbarLbl{padding-top:2px}
.wm-dash .cbarStack{display:flex;flex-direction:column;gap:3px}
.wm-dash .cbarStack .cbar{grid-template-columns:auto 1fr 92px}
.wm-dash .cbarYr{font-size:9.5px;color:var(--wm-muted2);font-family:'Space Mono',monospace;min-width:0;white-space:nowrap}
.wm-dash .cbar.prior .cbarVal{color:var(--wm-muted);font-weight:500}
.wm-dash .cbarKey{display:flex;align-items:center;gap:7px;font-size:10.5px;color:var(--wm-muted2);margin-top:2px}
.wm-dash .cbarKey .hatch{width:22px;height:10px;border-radius:2px;background:var(--wm-muted);background-image:repeating-linear-gradient(135deg,rgba(11,14,19,.55) 0 3px,transparent 3px 6px)}
/* Grouped monthly bars */
.wm-dash .cmonth{margin-top:6px}
.wm-dash .cmLegend{display:flex;gap:14px;flex-wrap:wrap;font-size:11px;color:var(--wm-muted);margin-bottom:6px}
.wm-dash .cmLegend span{display:inline-flex;align-items:center;gap:6px}
.wm-dash .cmScroll{overflow-x:auto}
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
.wm-dash .sbar{display:inline-block;vertical-align:middle;width:64px;height:7px;background:var(--wm-panel2);border:1px solid var(--wm-line);border-radius:4px;margin-right:8px;overflow:hidden}
.wm-dash .sbar i{display:block;height:100%;background:var(--wm-blue);border-radius:4px}
@media(max-width:600px){.wm-dash h1{font-size:18px}.wm-dash .card .v{font-size:19px}.wm-dash .convView th,.wm-dash .convView td{padding:6px 6px;font-size:11.5px}.wm-dash .stats{gap:14px}.wm-dash .stat .v{font-size:16px}}
`
