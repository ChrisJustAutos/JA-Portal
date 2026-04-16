// pages/distributors.tsx — Just Autos Distributor Report
// Replicates the 5 Power BI tabs with live MYOB data

import { useEffect, useState, useRef, useCallback } from 'react'
import Head from 'next/head'
import { useRouter } from 'next/router'

// ── Types ─────────────────────────────────────────────────────────────
interface LineItem {
  CustomerName: string; Date: string; AccountName: string
  AccountDisplayID: string; Description: string; Total: number; ItemName: string | null
}
interface DistData {
  fetchedAt: string
  lineItems: LineItem[]
  trendLabels: string[]
  monthlyTotals: Record<string, number>  // label -> total
}

// ── Category mapping (mirrors Power BI) ────────────────────────────
function getCategory(accountDisplayID: string, accountName: string): 'Tuning' | 'Oil' | 'Parts' {
  if (accountDisplayID?.startsWith('4-19') || accountDisplayID === '4-1905' ||
      accountName?.toLowerCase().includes('tuning') || accountName?.toLowerCase().includes('remap') ||
      accountName?.toLowerCase().includes('multimap') || accountName?.toLowerCase().includes('easy lock') ||
      accountName?.toLowerCase().includes('multi map')) return 'Tuning'
  if (accountDisplayID === '4-1060' || accountName?.toLowerCase().includes('oil')) return 'Oil'
  return 'Parts'
}

// ── Normalise customer name (strip "(Tuning)" suffix for grouping) ──
function normaliseName(name: string): string {
  return name?.replace(' (Tuning)', '').replace(' (Tuning 1)', '').replace(' (Tuning2)', '').trim() || ''
}

// ── Helpers ──────────────────────────────────────────────────────────
const fmtD  = (n: number) => n == null ? '$0' : '$' + Math.round(n).toLocaleString('en-AU')
const fmtFull = (n: number) => n == null ? '$0' : '$' + Number(n).toLocaleString('en-AU', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
const fmtDate = (d: string) => new Date(d).toLocaleDateString('en-AU', { day: '2-digit', month: 'short' })

const T = {
  bg: '#0d0f12', bg2: '#131519', bg3: '#1a1d23', bg4: '#21252d',
  border: 'rgba(255,255,255,0.07)', border2: 'rgba(255,255,255,0.12)',
  text: '#e8eaf0', text2: '#8b90a0', text3: '#545968',
  blue: '#4f8ef7', teal: '#2dd4bf', green: '#34c77b',
  amber: '#f5a623', red: '#f04e4e', purple: '#a78bfa',
}

type Tab = 'distributor-sales' | 'detailed-sales' | 'summary' | 'national-pm' | 'national-total'

export default function DistributorReport() {
  const router = useRouter()
  const [tab, setTab] = useState<Tab>('distributor-sales')
  const [data, setData] = useState<DistData | null>(null)
  const [loading, setLoading] = useState(true)
  const [selectedDist, setSelectedDist] = useState<string>('ALL')
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true)
    try {
      const r = await fetch('/api/distributors')
      if (r.status === 401) { router.push('/login'); return }
      if (!r.ok) throw new Error('Failed to load')
      const d = await r.json()
      setData(d)
    } catch (e: any) { console.error(e) }
    setLoading(false)
    if (isRefresh) setRefreshing(false)
  }, [router])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    const t = setInterval(() => load(true), 5 * 60 * 1000)
    return () => clearInterval(t)
  }, [load])

  // ── Derived data ─────────────────────────────────────────────────
  const lines = data?.lineItems || []

  // All unique normalised distributor names
  const allDistributors = Array.from(new Set(lines.map(l => normaliseName(l.CustomerName)))).sort()

  // Filter lines for selected distributor
  const filteredLines = selectedDist === 'ALL'
    ? lines
    : lines.filter(l => normaliseName(l.CustomerName) === selectedDist)

  // Aggregate by distributor → { tuning, oil, parts, total }
  interface DistSummary { name: string; tuning: number; oil: number; parts: number; total: number; invoiceCount: number }
  const distSummaries: DistSummary[] = allDistributors.map(name => {
    const dLines = lines.filter(l => normaliseName(l.CustomerName) === name)
    const tuning = dLines.filter(l => getCategory(l.AccountDisplayID, l.AccountName) === 'Tuning').reduce((s, l) => s + l.Total, 0)
    const oil    = dLines.filter(l => getCategory(l.AccountDisplayID, l.AccountName) === 'Oil').reduce((s, l) => s + l.Total, 0)
    const parts  = dLines.filter(l => getCategory(l.AccountDisplayID, l.AccountName) === 'Parts').reduce((s, l) => s + l.Total, 0)
    return { name, tuning, oil, parts, total: tuning + oil + parts, invoiceCount: new Set(dLines.map(l => l.Date)).size }
  }).filter(d => d.total > 0).sort((a, b) => b.total - a.total)

  // Selected distributor stats
  const selectedStats = selectedDist === 'ALL'
    ? { tuning: distSummaries.reduce((s, d) => s + d.tuning, 0), oil: distSummaries.reduce((s, d) => s + d.oil, 0), parts: distSummaries.reduce((s, d) => s + d.parts, 0), total: distSummaries.reduce((s, d) => s + d.total, 0) }
    : distSummaries.find(d => d.name === selectedDist) || { tuning: 0, oil: 0, parts: 0, total: 0 }

  // Line items for detailed view
  const detailedLines = filteredLines.filter(l => l.Total > 0)
  const detailedByDesc: Record<string, { qty: number; total: number }> = {}
  detailedLines.forEach(l => {
    const key = l.Description || l.AccountName
    if (!detailedByDesc[key]) detailedByDesc[key] = { qty: 0, total: 0 }
    detailedByDesc[key].qty += 1
    detailedByDesc[key].total += l.Total
  })
  const detailedRows = Object.entries(detailedByDesc).sort((a, b) => b[1].total - a[1].total)

  // Monthly trend data from pre-fetched API
  const monthlyTotals = data?.monthlyTotals || {}
  const trendLabels = data?.trendLabels || []

  // Chart refs
  const barChartRef = useRef<HTMLCanvasElement>(null)
  const barChartInstance = useRef<any>(null)
  const lineChartRef = useRef<HTMLCanvasElement>(null)
  const lineChartInstance = useRef<any>(null)
  const hBarChartRef = useRef<HTMLCanvasElement>(null)
  const hBarChartInstance = useRef<any>(null)

  // Bar chart: Tuning revenue by model/description
  useEffect(() => {
    if (!barChartRef.current || !(window as any).Chart) return
    if (barChartInstance.current) barChartInstance.current.destroy()
    const tunLines = filteredLines.filter(l => getCategory(l.AccountDisplayID, l.AccountName) === 'Tuning')
    const byDesc: Record<string, number> = {}
    tunLines.forEach(l => { const k = l.Description?.substring(0, 30) || 'Other'; byDesc[k] = (byDesc[k] || 0) + l.Total })
    const sorted = Object.entries(byDesc).sort((a, b) => b[1] - a[1]).slice(0, 8)
    barChartInstance.current = new (window as any).Chart(barChartRef.current, {
      type: 'bar',
      data: { labels: sorted.map(s => s[0].substring(0, 25) + '…'), datasets: [{ data: sorted.map(s => Math.round(s[1])), backgroundColor: '#4f8ef7', borderRadius: 4, borderSkipped: false }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx: any) => `$${ctx.raw.toLocaleString()}` } } }, scales: { x: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: T.text3, font: { size: 10 }, maxRotation: 45 } }, y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: T.text3, font: { size: 11 }, callback: (v: any) => '$' + v } } } }
    })
    return () => { if (barChartInstance.current) barChartInstance.current.destroy() }
  }, [filteredLines, tab])

  // Line chart: National distributor revenue P/M
  useEffect(() => {
    if (tab !== 'national-pm' || !lineChartRef.current || !(window as any).Chart) return
    if (lineChartInstance.current) lineChartInstance.current.destroy()
    const vals = trendLabels.map(l => Math.round(monthlyTotals[l] || 0))
    lineChartInstance.current = new (window as any).Chart(lineChartRef.current, {
      type: 'bar',
      data: { labels: trendLabels, datasets: [{ label: 'National Distributor Revenue ex GST', data: vals, backgroundColor: '#4f8ef7', borderRadius: 4, borderSkipped: false }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx: any) => `$${ctx.raw.toLocaleString()}` } } }, scales: { x: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: T.text3 } }, y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: T.text3, callback: (v: any) => '$' + Math.round(v / 1000) + 'k' } } } }
    })
    return () => { if (lineChartInstance.current) lineChartInstance.current.destroy() }
  }, [tab, trendLabels, monthlyTotals])

  // Horizontal bar chart: National total by distributor
  useEffect(() => {
    if (tab !== 'national-total' || !hBarChartRef.current || !(window as any).Chart) return
    if (hBarChartInstance.current) hBarChartInstance.current.destroy()
    const sorted = [...distSummaries].sort((a, b) => b.total - a.total)
    hBarChartInstance.current = new (window as any).Chart(hBarChartRef.current, {
      type: 'bar',
      data: { labels: sorted.map(d => d.name), datasets: [{ label: 'Revenue ex GST', data: sorted.map(d => Math.round(d.total)), backgroundColor: '#4f8ef7', borderRadius: 3, borderSkipped: false }] },
      options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx: any) => `$${ctx.raw.toLocaleString()}` } }, datalabels: { display: false } }, scales: { x: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: T.text3, callback: (v: any) => '$' + Math.round(v / 1000) + 'k' } }, y: { grid: { display: false }, ticks: { color: T.text2, font: { size: 11 } } } } }
    })
    return () => { if (hBarChartInstance.current) hBarChartInstance.current.destroy() }
  }, [tab, distSummaries])

  const tabs: [Tab, string][] = [
    ['distributor-sales', 'Distributor Sales'],
    ['detailed-sales',    'Detailed Distributor Sales'],
    ['summary',           'Summary All Distributor Sales'],
    ['national-pm',       'Total National Distributor Sales P/M'],
    ['national-total',    'Total National Distributor Sales'],
  ]

  const s = (style: React.CSSProperties) => style
  const cs = (base: React.CSSProperties, cond: boolean, extra: React.CSSProperties) => cond ? { ...base, ...extra } : base

  function DistributorSelector() {
    return (
      <div style={{ borderBottom: `1px solid ${T.border}`, padding: '12px 20px', background: T.bg2, display: 'flex', alignItems: 'center', gap: 8, overflowX: 'auto', flexShrink: 0 }}>
        <span style={{ fontSize: 11, color: T.text3, flexShrink: 0, marginRight: 4 }}>Distributor</span>
        {['ALL', ...allDistributors].map(d => (
          <button key={d} onClick={() => setSelectedDist(d)}
            style={{ fontSize: 12, padding: '6px 12px', borderRadius: 6, border: `1px solid ${selectedDist === d ? T.blue : T.border}`, background: selectedDist === d ? 'rgba(79,142,247,0.2)' : T.bg3, color: selectedDist === d ? T.blue : T.text2, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap', flexShrink: 0 }}>
            {d === 'ALL' ? 'Select all' : d}
          </button>
        ))}
      </div>
    )
  }

  function KPIBox({ label, value, color }: { label: string; value: number; color?: string }) {
    return (
      <div style={{ textAlign: 'right', padding: '16px 20px', borderBottom: `1px solid ${T.border}` }}>
        <div style={{ fontSize: 36, fontWeight: 400, fontFamily: 'monospace', color: value === 0 ? T.red : (color || T.text), letterSpacing: '-0.03em' }}>{fmtD(value)}</div>
        <div style={{ fontSize: 13, color: T.text3, marginTop: 4 }}>{label}</div>
      </div>
    )
  }

  function renderContent() {
    if (loading) return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 400, flexDirection: 'column', gap: 12 }}>
        <div style={{ fontSize: 28, animation: 'spin 1s linear infinite', color: T.text3 }}>⟳</div>
        <div style={{ color: T.text3 }}>Loading distributor data…</div>
        <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      </div>
    )

    // ── TAB 1: Distributor Sales ───────────────────────────
    if (tab === 'distributor-sales') return (
      <div style={{ display: 'flex', height: '100%' }}>
        {/* Chart area */}
        <div style={{ flex: 1, padding: 24, display: 'flex', flexDirection: 'column', gap: 16, overflowY: 'auto' }}>
          <div style={{ fontSize: 18, fontWeight: 500, color: T.text }}>{selectedDist === 'ALL' ? 'All Distributors' : selectedDist}</div>
          <div style={{ fontSize: 12, color: T.text3, display: 'flex', gap: 16 }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}><span style={{ width: 10, height: 10, borderRadius: 2, background: T.blue, display: 'inline-block' }}/> Tuning Revenue ex GST</span>
          </div>
          <div style={{ position: 'relative', height: 340, background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 10, padding: 16 }}>
            <canvas ref={barChartRef} id="bar-chart" role="img" aria-label="Tuning revenue by ECU calibration type"/>
          </div>
        </div>
        {/* KPI sidebar */}
        <div style={{ width: 220, borderLeft: `1px solid ${T.border}`, flexShrink: 0 }}>
          <KPIBox label="Tuning Revenue ex GST" value={selectedStats.tuning} color={T.green}/>
          <KPIBox label="Oil Revenue ex GST"    value={selectedStats.oil}   />
          <KPIBox label="Parts Revenue ex GST"  value={selectedStats.parts} />
          <KPIBox label="Total Revenue ex GST"  value={selectedStats.total} color={T.blue}/>
        </div>
      </div>
    )

    // ── TAB 2: Detailed Distributor Sales ─────────────────
    if (tab === 'detailed-sales') return (
      <div style={{ padding: 24, overflowY: 'auto' }}>
        <div style={{ fontSize: 18, fontWeight: 500, color: T.text, marginBottom: 16 }}>{selectedDist === 'ALL' ? 'All' : selectedDist}</div>
        <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 10, overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${T.border}` }}>
                <th style={{ fontSize: 12, color: T.text2, padding: '12px 16px', textAlign: 'left', fontWeight: 500 }}>Description</th>
                <th style={{ fontSize: 12, color: T.text2, padding: '12px 16px', textAlign: 'right', fontWeight: 500 }}>Total Sold</th>
                <th style={{ fontSize: 12, color: T.text2, padding: '12px 16px', textAlign: 'right', fontWeight: 500 }}>Total $ ExGST</th>
              </tr>
            </thead>
            <tbody>
              {detailedRows.map(([desc, vals], i) => (
                <tr key={i} style={{ borderTop: `1px solid ${T.border}` }}>
                  <td style={{ fontSize: 12, color: T.text2, padding: '9px 16px' }}>{desc?.substring(0, 70)}</td>
                  <td style={{ fontSize: 12, fontFamily: 'monospace', color: T.text3, padding: '9px 16px', textAlign: 'right' }}>{vals.qty > 1 ? vals.qty : ''}</td>
                  <td style={{ fontSize: 12, fontFamily: 'monospace', color: T.text, padding: '9px 16px', textAlign: 'right' }}>{fmtFull(vals.total)}</td>
                </tr>
              ))}
              <tr style={{ borderTop: `2px solid ${T.border2}`, background: T.bg3 }}>
                <td style={{ fontSize: 13, fontWeight: 500, color: T.text, padding: '10px 16px' }}>Total</td>
                <td style={{ fontSize: 13, fontFamily: 'monospace', fontWeight: 500, color: T.text3, padding: '10px 16px', textAlign: 'right' }}>
                  {detailedRows.reduce((s, [, v]) => s + v.qty, 0)}
                </td>
                <td style={{ fontSize: 13, fontFamily: 'monospace', fontWeight: 500, color: T.blue, padding: '10px 16px', textAlign: 'right' }}>
                  {fmtFull(detailedRows.reduce((s, [, v]) => s + v.total, 0))}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    )

    // ── TAB 3: Summary All Distributor Sales ──────────────
    if (tab === 'summary') return (
      <div style={{ padding: 24, overflowY: 'auto' }}>
        <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 10, overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${T.border2}` }}>
                <th style={{ fontSize: 11, color: T.text3, padding: '10px 12px', textAlign: 'left', fontWeight: 500, position: 'sticky', left: 0, background: T.bg2, zIndex: 1 }}>Distributor</th>
                {['Oil', 'Parts', 'Tuning', 'Total'].map(h => (
                  <th key={h} style={{ fontSize: 11, color: T.text3, padding: '10px 12px', textAlign: 'right', fontWeight: 500, whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {distSummaries.map((d, i) => (
                <tr key={i} style={{ borderTop: `1px solid ${T.border}`, cursor: 'pointer', background: selectedDist === d.name ? 'rgba(79,142,247,0.08)' : 'transparent' }}
                  onClick={() => setSelectedDist(d.name === selectedDist ? 'ALL' : d.name)}>
                  <td style={{ fontSize: 12, color: T.text2, padding: '8px 12px', position: 'sticky', left: 0, background: selectedDist === d.name ? 'rgba(79,142,247,0.08)' : T.bg2 }}>{d.name}</td>
                  <td style={{ fontSize: 12, fontFamily: 'monospace', color: d.oil > 0 ? T.text : T.text3, padding: '8px 12px', textAlign: 'right' }}>{d.oil > 0 ? fmtFull(d.oil) : '$0'}</td>
                  <td style={{ fontSize: 12, fontFamily: 'monospace', color: d.parts > 0 ? T.text : T.text3, padding: '8px 12px', textAlign: 'right' }}>{d.parts > 0 ? fmtFull(d.parts) : '$0'}</td>
                  <td style={{ fontSize: 12, fontFamily: 'monospace', color: d.tuning > 0 ? T.green : T.text3, padding: '8px 12px', textAlign: 'right' }}>{d.tuning > 0 ? fmtFull(d.tuning) : '$0'}</td>
                  <td style={{ fontSize: 12, fontFamily: 'monospace', fontWeight: 500, color: T.blue, padding: '8px 12px', textAlign: 'right' }}>{fmtFull(d.total)}</td>
                </tr>
              ))}
              <tr style={{ borderTop: `2px solid ${T.border2}`, background: T.bg3 }}>
                <td style={{ fontSize: 13, fontWeight: 500, color: T.text, padding: '10px 12px', position: 'sticky', left: 0, background: T.bg3 }}>Total</td>
                <td style={{ fontSize: 13, fontFamily: 'monospace', fontWeight: 500, color: T.text, padding: '10px 12px', textAlign: 'right' }}>{fmtFull(distSummaries.reduce((s, d) => s + d.oil, 0))}</td>
                <td style={{ fontSize: 13, fontFamily: 'monospace', fontWeight: 500, color: T.text, padding: '10px 12px', textAlign: 'right' }}>{fmtFull(distSummaries.reduce((s, d) => s + d.parts, 0))}</td>
                <td style={{ fontSize: 13, fontFamily: 'monospace', fontWeight: 500, color: T.green, padding: '10px 12px', textAlign: 'right' }}>{fmtFull(distSummaries.reduce((s, d) => s + d.tuning, 0))}</td>
                <td style={{ fontSize: 13, fontFamily: 'monospace', fontWeight: 500, color: T.blue, padding: '10px 12px', textAlign: 'right' }}>{fmtFull(distSummaries.reduce((s, d) => s + d.total, 0))}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    )

    // ── TAB 4: National Total P/M ─────────────────────────
    if (tab === 'national-pm') return (
      <div style={{ padding: 24, overflowY: 'auto' }}>
        <div style={{ fontSize: 16, fontWeight: 500, color: T.text, marginBottom: 20 }}>National Distributor Revenue ex GST by Month</div>
        <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 10, padding: 20 }}>
          <div style={{ position: 'relative', height: 380 }}>
            <canvas ref={lineChartRef} id="line-chart" role="img" aria-label="National distributor revenue by month bar chart">
              {trendLabels.map(l => `${l}: ${fmtFull(monthlyTotals[l] || 0)}`).join(', ')}
            </canvas>
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginTop: 16 }}>
          {trendLabels.map(l => (
            <div key={l} style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 8, padding: '10px 14px' }}>
              <div style={{ fontSize: 11, color: T.text3, marginBottom: 4 }}>{l}</div>
              <div style={{ fontSize: 18, fontFamily: 'monospace', fontWeight: 500, color: T.blue }}>{fmtFull(monthlyTotals[l] || 0)}</div>
            </div>
          ))}
        </div>
      </div>
    )

    // ── TAB 5: National Total by Distributor ──────────────
    if (tab === 'national-total') return (
      <div style={{ padding: 24, overflowY: 'auto' }}>
        <div style={{ fontSize: 16, fontWeight: 500, color: T.text, marginBottom: 20 }}>National Distributor Revenue ex GST by Customer Base</div>
        <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 10, padding: 20 }}>
          <div style={{ position: 'relative', height: Math.max(300, distSummaries.length * 36 + 60) }}>
            <canvas ref={hBarChartRef} id="hbar-chart" role="img" aria-label="National distributor revenue horizontal bar chart">
              {distSummaries.map(d => `${d.name}: ${fmtFull(d.total)}`).join(', ')}
            </canvas>
          </div>
        </div>
      </div>
    )
    return null
  }

  const showDistSelector = tab === 'distributor-sales' || tab === 'detailed-sales' || tab === 'national-pm' || tab === 'national-total'

  return (
    <>
      <Head>
        <title>Just Autos — Distributor Report</title>
        <meta name="robots" content="noindex,nofollow"/>
      </Head>
      <script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js"/>

      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: T.bg, fontFamily: "'DM Sans',system-ui,sans-serif", color: T.text }}>
        {/* Header */}
        <div style={{ background: T.bg2, borderBottom: `1px solid ${T.border}`, padding: '0 24px', display: 'flex', alignItems: 'center', gap: 16, height: 56, flexShrink: 0 }}>
          <a href="/" style={{ fontSize: 13, color: T.text3, textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 6 }}>← Portal</a>
          <div style={{ width: 1, height: 18, background: T.border }}/>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ width: 26, height: 26, borderRadius: 6, background: T.blue, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 600, color: '#fff' }}>JA</div>
            <span style={{ fontSize: 14, fontWeight: 600 }}>Just Autos</span>
            <span style={{ fontSize: 14, color: T.text3 }}>Distributor Report</span>
          </div>
          <div style={{ flex: 1 }}/>
          <div style={{ width: 7, height: 7, borderRadius: '50%', background: T.green, boxShadow: `0 0 6px ${T.green}` }}/>
          <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 5, fontFamily: 'monospace', background: 'rgba(52,199,123,0.12)', color: T.green, border: '1px solid rgba(52,199,123,0.2)' }}>MYOB live</span>
          <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 5, fontFamily: 'monospace', background: 'rgba(79,142,247,0.12)', color: T.blue, border: '1px solid rgba(79,142,247,0.2)' }}>
            FY2026 · {!loading && `${distSummaries.length} distributors`}
          </span>
          <select defaultValue="2026" style={{ fontSize: 12, background: T.bg3, border: `1px solid ${T.border}`, borderRadius: 6, padding: '4px 8px', color: T.text, fontFamily: 'inherit' }}>
            <option>2026</option>
          </select>
          <button onClick={() => load(true)} disabled={refreshing} style={{ fontSize: 12, color: T.blue, background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>
            {refreshing ? '↻ Refreshing…' : '↻ Refresh'}
          </button>
        </div>

        {/* Tabs (Power BI-style) */}
        <div style={{ background: T.bg2, borderBottom: `1px solid ${T.border}`, display: 'flex', alignItems: 'flex-end', padding: '0 24px', gap: 2, flexShrink: 0 }}>
          {tabs.map(([id, label]) => (
            <button key={id} onClick={() => setTab(id)}
              style={{ fontSize: 12, padding: '10px 16px', border: 'none', borderBottom: tab === id ? `2px solid ${T.blue}` : '2px solid transparent', background: 'transparent', color: tab === id ? T.blue : T.text2, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' }}>
              {label}
            </button>
          ))}
        </div>

        {/* Distributor selector (shown on relevant tabs) */}
        {showDistSelector && !loading && <DistributorSelector/>}

        {/* Content */}
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          {renderContent()}
        </div>
      </div>
    </>
  )
}
