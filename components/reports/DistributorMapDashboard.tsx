// components/reports/DistributorMapDashboard.tsx
// Distributor Report map (Reports → Distributor Map). Quotes done in each
// distributor's area (nearest-within-radius, from the workshop-map geocoded
// quote points) vs jobs the distributor booked (Monday Distributor - Booking
// board, confirmed group). Distributor filter pills, radius selector, month
// strip, and a month-by-month comparison table.
//
// Client-only (Leaflet) — import with next/dynamic { ssr: false }.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { useToast } from '../ui/Feedback'

interface MonthCell { quotes: number; quotesValue: number; bookings: number; bookingsValue: number }
interface Dist {
  key: string; name: string; lat: number | null; lng: number | null; suburb: string | null
  monthly: MonthCell[]; totals: MonthCell
  // Just Autos' own workshop — a pin and radius so you can see the demand
  // around it. Carries quotes only, never bookings, so its booking figures
  // must read "—" rather than 0.
  quotesOnly?: boolean
}
interface QuotePoint { la: number; ln: number; m: number; a: number; d: string | null }
interface ApiResp {
  fy: number | null; fys: number[]; radiusKm: number
  months: { k: string; label: string }[]
  distributors: Dist[]
  quotePoints: QuotePoint[]
  quotesSyncedAt: string | null
  bookingsAsOf: string | null
}

const BG = '#10151d', PANEL = '#161d27', BORDER = '#26303e', TEXT = '#e8edf4', MUTED = '#8b98a9'
const GREEN = '#47FFCF', AMBER = '#FFB454', RED = '#e0707a'
// Just Autos' own workshop pin — deliberately white-ish so it never reads as
// one of the palette-coloured distributors.
const HOME_COL = '#f2f5f7'
const PALETTE = ['#47FFCF', '#FFB454', '#6ea8fe', '#e0707a', '#c792ea', '#9cd326', '#ff5ac4', '#4eccc6', '#ffcb00', '#579bfc', '#fdab3d', '#00c875', '#9d50dd', '#66ccff', '#cab641', '#df2f4a']

const fmt = (n: number) => '$' + Math.round(n).toLocaleString('en-AU')
const fmtK = (n: number) => n >= 1e6 ? '$' + (n / 1e6).toFixed(2) + 'M' : n >= 1000 ? '$' + Math.round(n / 1000) + 'k' : '$' + Math.round(n)
const esc = (s: any) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const RADII = [50, 100, 150, 250]

export default function DistributorMapDashboard() {
  const [data, setData] = useState<ApiResp | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [radius, setRadius] = useState(100)
  const [month, setMonth] = useState(-1)          // -1 = whole FY
  const [sel, setSel] = useState<string>('all')   // distributor key or 'all'
  const [pdfBusy, setPdfBusy] = useState(false)
  const toast = useToast()

  const mapRef = useRef<L.Map | null>(null)
  const layerRef = useRef<L.LayerGroup | null>(null)
  const mapDivRef = useRef<HTMLDivElement | null>(null)

  const load = useCallback(async (fy?: number, r?: number) => {
    setLoading(true); setError('')
    try {
      const params = new URLSearchParams()
      if (fy) params.set('fy', String(fy))
      params.set('radius', String(r ?? radius))
      const resp = await fetch(`/api/reports/distributor-map?${params}`)
      const d = await resp.json()
      if (!resp.ok) throw new Error(d.error || 'Failed to load')
      setData(d)
    } catch (e: any) { setError(e?.message || 'Failed to load') }
    finally { setLoading(false) }
  }, [radius])
  useEffect(() => { load() }, [])   // eslint-disable-line react-hooks/exhaustive-deps

  // Stable colour per distributor (located ones first, in API order).
  // Our own workshop keeps one fixed colour off the palette so it reads as
  // "us" wherever it appears, and never borrows a distributor's colour.
  const colours = useMemo(() => {
    const m = new Map<string, string>()
    let i = 0
    for (const d of data?.distributors || []) {
      m.set(d.key, d.quotesOnly ? HOME_COL : PALETTE[i++ % PALETTE.length])
    }
    return m
  }, [data])

  const located = useMemo(() => (data?.distributors || []).filter(d => d.lat != null), [data])

  // ── Map bootstrap ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!data || !mapDivRef.current || mapRef.current) return
    const map = L.map(mapDivRef.current, { zoomControl: true, attributionControl: false, minZoom: 3, worldCopyJump: true }).setView([-25.8, 134], 4)
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { maxZoom: 19, subdomains: 'abcd' }).addTo(map)
    layerRef.current = L.layerGroup().addTo(map)
    mapRef.current = map
  }, [data])

  // ── Redraw on any filter change ─────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current, layer = layerRef.current
    if (!map || !layer || !data) return
    layer.clearLayers()

    const selDist = sel === 'all' ? null : data.distributors.find(d => d.key === sel) || null

    // Quote dots (small): coloured by their assigned distributor, grey when
    // outside every area. Filtered by month + selection.
    for (const q of data.quotePoints) {
      if (month >= 0 && q.m !== month) continue
      if (selDist && q.d !== selDist.key) continue
      const col = q.d ? (colours.get(q.d) || GREEN) : '#5a6676'
      L.circleMarker([q.la, q.ln], {
        radius: 3.5, weight: 0, fillColor: col, fillOpacity: q.d ? 0.75 : 0.35,
      }).addTo(layer)
    }

    // Distributor markers + radius circles.
    for (const d of located) {
      if (selDist && d.key !== selDist.key) continue
      const col = colours.get(d.key) || AMBER
      L.circle([d.lat!, d.lng!], {
        radius: data.radiusKm * 1000, color: col, weight: 1, opacity: 0.5, fillColor: col, fillOpacity: 0.06, interactive: false,
      }).addTo(layer)
      const cell = month >= 0 ? d.monthly[month] : d.totals
      // Our own workshop gets a square-ish heavier pin so it reads as "us",
      // not another distributor, and says so rather than showing "Booked: 0".
      L.circleMarker([d.lat!, d.lng!], {
        radius: d.quotesOnly ? 11 : 9, weight: d.quotesOnly ? 4 : 2.5,
        color: '#fff', fillColor: col, fillOpacity: 1,
      })
        .bindTooltip(
          `<b>${esc(d.name)}</b><br>Quotes in area: ${cell.quotes} · ${fmtK(cell.quotesValue)}<br>` +
          (d.quotesOnly ? '<i>our workshop — quotes only, no bookings tracked here</i>'
                        : `Booked: ${cell.bookings} · ${fmtK(cell.bookingsValue)}`),
          { sticky: true })
        .on('click', () => setSel(k => k === d.key ? 'all' : d.key))
        .addTo(layer)
    }

    // Zoom to the selected distributor's area; otherwise AU-wide.
    if (selDist && selDist.lat != null) {
      map.fitBounds(L.latLng(selDist.lat, selDist.lng!).toBounds(data.radiusKm * 2600))
    }
  }, [data, month, sel, colours, located])

  const months = data?.months || []
  const selDist = sel === 'all' ? null : data?.distributors.find(d => d.key === sel) || null

  // Table rows: selected distributor month-by-month, or (All) the per-month
  // sum across every distributor's area.
  const tableRows = useMemo(() => {
    if (!data) return []
    return months.map((m, i) => {
      let cell: MonthCell
      if (selDist) cell = selDist.monthly[i]
      // "All" means all DISTRIBUTORS. Our own workshop carries quotes and no
      // bookings, so folding it in would drag the combined conversion rate
      // down without any distributor having done worse. Select it to see it.
      else cell = data.distributors.filter(d => !d.quotesOnly).reduce((acc, d) => ({
        quotes: acc.quotes + d.monthly[i].quotes,
        quotesValue: acc.quotesValue + d.monthly[i].quotesValue,
        bookings: acc.bookings + d.monthly[i].bookings,
        bookingsValue: acc.bookingsValue + d.monthly[i].bookingsValue,
      }), { quotes: 0, quotesValue: 0, bookings: 0, bookingsValue: 0 })
      return { label: m.label, ...cell }
    })
  }, [data, months, selDist])

  const grand = useMemo(() => tableRows.reduce((a, r) => ({
    quotes: a.quotes + r.quotes, quotesValue: a.quotesValue + r.quotesValue,
    bookings: a.bookings + r.bookings, bookingsValue: a.bookingsValue + r.bookingsValue,
  }), { quotes: 0, quotesValue: 0, bookings: 0, bookingsValue: 0 }), [tableRows])

  const convColor = (p: number) => p >= 30 ? GREEN : p >= 15 ? AMBER : RED
  const conv = (b: number, q: number) => q > 0 ? Math.round((b / q) * 100) : null

  // Export PDF — every month of the FY for every distributor, at the radius
  // currently selected. Fetched rather than linked so the session cookie rides
  // along and a failure surfaces as a toast, not a browser error page. The
  // route recomputes (Monday is live), so this takes a few seconds.
  const downloadPdf = useCallback(async () => {
    if (!data?.fy) return
    setPdfBusy(true)
    try {
      const params = new URLSearchParams({ fy: String(data.fy), radius: String(data.radiusKm) })
      const r = await fetch(`/api/reports/distributor-map-pdf?${params}`, { credentials: 'same-origin' })
      if (!r.ok) {
        let msg = `HTTP ${r.status}`
        try { msg = (await r.json()).error || msg } catch { /* not JSON */ }
        throw new Error(msg)
      }
      const blob = await r.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `distributor-map-FY${data.fy}-${data.radiusKm}km.pdf`
      document.body.appendChild(a)
      a.click()
      a.remove()
      // Revoke on a later tick — Safari cancels the download if the object URL
      // disappears while the click is still being handled.
      setTimeout(() => URL.revokeObjectURL(url), 2000)
      toast('PDF downloaded', 'success')
    } catch (e: any) { toast(e?.message || 'PDF export failed', 'error') }
    finally { setPdfBusy(false) }
  }, [data?.fy, data?.radiusKm, toast])

  const pill = (on: boolean, col?: string): React.CSSProperties => ({
    fontSize: 12, fontWeight: on ? 700 : 500, padding: '5px 12px', borderRadius: 14, whiteSpace: 'nowrap',
    border: `1px solid ${on ? (col || GREEN) : BORDER}`, cursor: 'pointer', fontFamily: 'inherit',
    background: on ? `${col || GREEN}22` : 'transparent', color: on ? (col || GREEN) : MUTED,
  })

  if (error) return <div style={{ padding: 30, color: RED, background: BG, height: '100%' }}>{error}</div>
  if (loading && !data) return <div style={{ padding: 30, color: MUTED, background: BG, height: '100%' }}>Loading distributor map…</div>
  if (!data || data.fy == null) return <div style={{ padding: 30, color: MUTED, background: BG, height: '100%' }}>No workshop-map data yet — the daily MechanicDesk pull hasn’t run.</div>

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: BG, color: TEXT, fontFamily: "'DM Sans', system-ui, sans-serif" }}>
      {/* Controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', padding: '10px 14px', borderBottom: `1px solid ${BORDER}`, background: PANEL }}>
        {data.fys.map(fy => (
          <button key={fy} onClick={() => { setMonth(-1); load(fy) }} style={pill(fy === data.fy)}>FY{fy}</button>
        ))}
        <span style={{ width: 10 }} />
        <span style={{ color: MUTED, fontSize: 11 }}>Area radius</span>
        {RADII.map(r => (
          <button key={r} onClick={() => { setRadius(r); load(data.fy!, r) }} style={pill(r === data.radiusKm, AMBER)}>{r} km</button>
        ))}
        <span style={{ flex: 1 }} />
        <button onClick={downloadPdf} disabled={pdfBusy}
          title="Download every month of the financial year, per distributor, as a PDF"
          style={{
            fontSize: 12, fontWeight: 600, padding: '5px 12px', borderRadius: 14, whiteSpace: 'nowrap',
            border: `1px solid ${BORDER}`, cursor: pdfBusy ? 'default' : 'pointer', fontFamily: 'inherit',
            background: 'transparent', color: MUTED, opacity: pdfBusy ? 0.5 : 1,
          }}>
          {pdfBusy ? 'Preparing…' : 'Export PDF'}
        </button>
        <span style={{ color: MUTED, fontSize: 11 }}>
          quotes as of {data.quotesSyncedAt ? new Date(data.quotesSyncedAt).toLocaleString('en-AU', { timeZone: 'Australia/Brisbane', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'} · bookings live
        </span>
      </div>

      {/* Distributor pills */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', padding: '8px 14px', borderBottom: `1px solid ${BORDER}`, background: PANEL }}>
        <button onClick={() => setSel('all')} style={pill(sel === 'all')}>All distributors</button>
        {data.distributors.map(d => (
          <button key={d.key} onClick={() => setSel(k => k === d.key ? 'all' : d.key)}
            title={d.quotesOnly ? 'Our own workshop — quotes in its area only, no bookings tracked here'
                                : (d.lat == null ? 'No location on file — bookings only' : (d.suburb || ''))}
            style={pill(sel === d.key, colours.get(d.key))}>
            {d.name}{d.lat == null ? ' ⚠' : ''}{' '}
            {/* The count in brackets is bookings for a distributor; our own
                workshop has none, so it shows quotes instead — labelled, so
                the two are never read as the same number. */}
            <span style={{ opacity: 0.75 }}>
              {d.quotesOnly
                ? `(${month >= 0 ? d.monthly[month].quotes : d.totals.quotes} quotes)`
                : `(${month >= 0 ? d.monthly[month].bookings : d.totals.bookings})`}
            </span>
          </button>
        ))}
      </div>

      {/* Month strip */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap', padding: '8px 14px', borderBottom: `1px solid ${BORDER}`, background: PANEL }}>
        <button onClick={() => setMonth(-1)} style={pill(month === -1)}>All FY{data.fy}</button>
        {months.map((m, i) => (
          <button key={m.k} onClick={() => setMonth(x => x === i ? -1 : i)} style={pill(month === i)}>{m.label}</button>
        ))}
      </div>

      {/* Map + table */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <div ref={mapDivRef} style={{ flex: 1, minWidth: 0 }} />
        <div style={{ width: 460, flexShrink: 0, overflowY: 'auto', borderLeft: `1px solid ${BORDER}`, background: PANEL, padding: 14 }}>
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 2 }}>
            {selDist ? selDist.name : 'All distributor areas'} — quotes vs booked
          </div>
          <div style={{ fontSize: 11, color: MUTED, marginBottom: 10 }}>
            {selDist?.quotesOnly
              ? <>Quotes = JA quotes to customers within {data.radiusKm} km of our own workshop. <b>No bookings are tracked here</b> — the Monday board is distributor work, and our jobs live in MechanicDesk.</>
              : <>Quotes = JA quotes to customers within {data.radiusKm} km of the distributor · Booked = confirmed bookings on the Monday board{sel === 'all' ? ' · our own workshop is excluded from this total' : ''}</>}
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
            <thead>
              <tr>
                {['Month', 'Quotes in area', 'Booked', 'Booked / quotes'].map(h => (
                  <th key={h} style={{ textAlign: 'left', color: MUTED, fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '0.05em', padding: '6px 8px', borderBottom: `1px solid ${BORDER}` }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tableRows.map((r, i) => {
                // Our own workshop has no bookings by design, so a 0% here
                // would read as "booked nothing" rather than "not measured".
                const p = selDist?.quotesOnly ? null : conv(r.bookings, r.quotes)
                const dim = !r.quotes && !r.bookings
                return (
                  <tr key={i} style={{ opacity: dim ? 0.4 : 1, background: month === i ? '#1d2734' : 'transparent', cursor: 'pointer' }}
                    onClick={() => setMonth(x => x === i ? -1 : i)}>
                    <td style={{ padding: '7px 8px', borderBottom: `1px solid ${BORDER}`, fontWeight: 600 }}>{r.label}</td>
                    <td style={{ padding: '7px 8px', borderBottom: `1px solid ${BORDER}` }}><b>{r.quotes}</b> <span style={{ color: MUTED }}>{r.quotes ? fmtK(r.quotesValue) : ''}</span></td>
                    <td style={{ padding: '7px 8px', borderBottom: `1px solid ${BORDER}` }}>
                      {selDist?.quotesOnly
                        ? <span style={{ color: MUTED }}>—</span>
                        : <><b>{r.bookings}</b> <span style={{ color: MUTED }}>{r.bookings ? fmtK(r.bookingsValue) : ''}</span></>}
                    </td>
                    <td style={{ padding: '7px 8px', borderBottom: `1px solid ${BORDER}` }}>
                      {p == null ? <span style={{ color: MUTED }}>—</span> : <span style={{ color: convColor(p), fontWeight: 700 }}>{p}%</span>}
                    </td>
                  </tr>
                )
              })}
              <tr style={{ background: '#1a2230' }}>
                <td style={{ padding: '8px', fontWeight: 800 }}>FY{data.fy}</td>
                <td style={{ padding: '8px', fontWeight: 800 }}>{grand.quotes} <span style={{ color: MUTED, fontWeight: 500 }}>{fmtK(grand.quotesValue)}</span></td>
                <td style={{ padding: '8px', fontWeight: 800 }}>
                  {selDist?.quotesOnly
                    ? <span style={{ color: MUTED, fontWeight: 500 }}>—</span>
                    : <>{grand.bookings} <span style={{ color: MUTED, fontWeight: 500 }}>{fmtK(grand.bookingsValue)}</span></>}
                </td>
                <td style={{ padding: '8px', fontWeight: 800 }}>
                  {selDist?.quotesOnly || conv(grand.bookings, grand.quotes) == null
                    ? <span style={{ color: MUTED, fontWeight: 500 }}>—</span>
                    : <span style={{ color: convColor(conv(grand.bookings, grand.quotes)!) }}>{conv(grand.bookings, grand.quotes)}%</span>}
                </td>
              </tr>
            </tbody>
          </table>

          {/* Per-distributor summary when viewing All */}
          {!selDist && (
            <>
              <div style={{ fontSize: 13, fontWeight: 700, margin: '18px 0 6px' }}>By distributor {month >= 0 ? `— ${months[month]?.label}` : `— FY${data.fy}`}</div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                <tbody>
                  {data.distributors
                    .map(d => ({ d, cell: month >= 0 ? d.monthly[month] : d.totals }))
                    .sort((a, b) => b.cell.bookingsValue - a.cell.bookingsValue)
                    .map(({ d, cell }) => {
                      const p = conv(cell.bookings, cell.quotes)
                      return (
                        <tr key={d.key} style={{ cursor: 'pointer' }} onClick={() => setSel(d.key)}>
                          <td style={{ padding: '6px 8px', borderBottom: `1px solid ${BORDER}` }}>
                            <span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: 5, background: colours.get(d.key), marginRight: 7 }} />
                            {d.name}{d.lat == null ? ' ⚠' : ''}
                          </td>
                          <td style={{ padding: '6px 8px', borderBottom: `1px solid ${BORDER}`, color: MUTED }}>{d.lat == null ? '—' : `${cell.quotes} quotes`}</td>
                          <td style={{ padding: '6px 8px', borderBottom: `1px solid ${BORDER}` }}><b>{cell.bookings}</b> <span style={{ color: MUTED }}>{cell.bookings ? fmtK(cell.bookingsValue) : ''}</span></td>
                          <td style={{ padding: '6px 8px', borderBottom: `1px solid ${BORDER}` }}>
                            {d.lat == null || p == null ? <span style={{ color: MUTED }}>—</span> : <span style={{ color: convColor(p), fontWeight: 700 }}>{p}%</span>}
                          </td>
                        </tr>
                      )
                    })}
                </tbody>
              </table>
              <div style={{ fontSize: 10.5, color: MUTED, marginTop: 8 }}>⚠ = no location on file (or ambiguous name match) — bookings shown, area quotes unavailable. Set the distributor’s ship postcode in B2B admin to place them.</div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
