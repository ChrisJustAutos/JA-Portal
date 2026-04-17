// pages/distributors.tsx — Distributor Report matching Power BI exactly
// 5 tabs: Distributor Sales | Detailed Line Items | Summary Matrix | Monthly National | Ranked
import { useEffect, useMemo, useState, useCallback } from 'react'
import Head from 'next/head'

// ── types ─────────────────────────────────────────────────────────────────
type LineItem = {
  date: string; invoiceNumber: string; description: string
  amountExGst: number; bucket: 'Tuning' | 'Parts' | 'Oil'; accountCode: string
}
type Distributor = {
  customerBase: string
  location: 'National' | 'International'
  tuning: number; parts: number; oil: number; total: number
  invoiceCount: number; avgJobValue: number
  hasZeroStream: boolean
  lineItems: LineItem[]
}
type ApiResp = {
  dateRange: { start: string; end: string }
  totals: {
    tuning: number; parts: number; oil: number; total: number
    invoiceCount: number; distributorCount: number
  }
  distributors: Distributor[]
  monthlyNational: Array<{ ym: string; amount: number }>
}

// ── formatting ────────────────────────────────────────────────────────────
const fmt = (n: number) => '$' + Math.round(Math.abs(n)).toLocaleString('en-AU')
const fmtSigned = (n: number) => {
  const r = Math.round(n)
  return (r < 0 ? '-$' : '$') + Math.abs(r).toLocaleString('en-AU')
}
const monthLabel = (ym: string) => {
  const [y, m] = ym.split('-')
  return new Date(Number(y), Number(m) - 1, 1)
    .toLocaleDateString('en-AU', { month: 'short', year: '2-digit' })
}

// ── FY helpers ────────────────────────────────────────────────────────────
// AU FY runs Jul 1 → Jun 30. FY2026 = 2025-07-01 to 2026-06-30.
function fyRange(fy: number): { start: string; end: string } {
  return { start: `${fy - 1}-07-01`, end: `${fy}-06-30` }
}
function monthRange(fy: number, monthIdx: number): { start: string; end: string } {
  // monthIdx 0=July … 11=June
  const m = ((monthIdx + 6) % 12) + 1 // 0→7 (Jul), 6→1 (Jan), 11→6 (Jun)
  const year = monthIdx < 6 ? fy - 1 : fy
  const lastDay = new Date(year, m, 0).getDate()
  const mm = String(m).padStart(2, '0')
  return { start: `${year}-${mm}-01`, end: `${year}-${mm}-${lastDay}` }
}
const FY_MONTHS = [
  'July', 'August', 'September', 'October', 'November', 'December',
  'January', 'February', 'March', 'April', 'May', 'June',
]

// Derive list of FYs to offer (current FY + 4 prior)
function fyOptions(): number[] {
  const now = new Date()
  const currentFY = now.getMonth() >= 6 ? now.getFullYear() + 1 : now.getFullYear()
  return [currentFY, currentFY - 1, currentFY - 2, currentFY - 3, currentFY - 4]
}

// ── main component ────────────────────────────────────────────────────────
export default function DistributorsPage() {
  const [data, setData] = useState<ApiResp | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fy, setFy] = useState<number>(fyOptions()[0])
  const [month, setMonth] = useState<number>(-1) // -1 = full FY
  const [selectedDist, setSelectedDist] = useState<string>('') // for page 1 detail
  const [locationFilter, setLocationFilter] = useState<'All' | 'National' | 'International'>('All')
  const [activeTab, setActiveTab] = useState(0)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const range = month === -1 ? fyRange(fy) : monthRange(fy, month)
      const qs = new URLSearchParams({ start: range.start, end: range.end })
      const r = await fetch(`/api/distributors?${qs}`)
      if (!r.ok) {
        const body = await r.json().catch(() => ({}))
        throw new Error(body.detail || body.error || `HTTP ${r.status}`)
      }
      const json: ApiResp = await r.json()
      setData(json)
      if (json.distributors.length && !selectedDist) {
        setSelectedDist(json.distributors[0].customerBase)
      }
    } catch (e: any) {
      setError(e.message || 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [fy, month, selectedDist])

  useEffect(() => { load() }, [fy, month]) // reload when filters change

  // ── derived views ────────────────────────────────────────────────────────
  const filteredDists = useMemo(() => {
    if (!data) return []
    if (locationFilter === 'All') return data.distributors
    return data.distributors.filter(d => d.location === locationFilter)
  }, [data, locationFilter])

  const selectedDistData = useMemo(
    () => data?.distributors.find(d => d.customerBase === selectedDist) || null,
    [data, selectedDist]
  )

  // Summary matrix: rows=distributor (grouped by Location), cols=month
  const matrixData = useMemo(() => {
    if (!data) return { months: [], rows: [] }
    const months = new Set<string>()
    data.distributors.forEach(d => d.lineItems.forEach(li => {
      const ym = (li.date || '').substring(0, 7)
      if (ym) months.add(ym)
    }))
    const monthList = Array.from(months).sort()
    const rows = data.distributors.map(d => {
      const byMonth: Record<string, { tuning: number; parts: number; oil: number; total: number }> = {}
      monthList.forEach(m => { byMonth[m] = { tuning: 0, parts: 0, oil: 0, total: 0 } })
      d.lineItems.forEach(li => {
        const ym = (li.date || '').substring(0, 7)
        if (!byMonth[ym]) return
        const k = li.bucket.toLowerCase() as 'tuning' | 'parts' | 'oil'
        byMonth[ym][k] += li.amountExGst
        byMonth[ym].total += li.amountExGst
      })
      return { distributor: d.customerBase, location: d.location, byMonth, rowTotal: d.total }
    })
    return { months: monthList, rows }
  }, [data])

  // ── render ───────────────────────────────────────────────────────────────
  return (
    <>
      <Head><title>Distributor Report — Just Autos</title></Head>
      <div style={styles.page}>
        <Header
          fy={fy} setFy={setFy}
          month={month} setMonth={setMonth}
          onRefresh={load} loading={loading}
          totals={data?.totals}
        />

        {error && <ErrorBanner message={error} onRetry={load} />}

        <TabBar active={activeTab} onChange={setActiveTab} />

        <div style={styles.content}>
          {loading && !data && <LoadingState />}
          {data && activeTab === 0 && (
            <Page1DistributorSales
              data={data}
              selected={selectedDist}
              onSelect={setSelectedDist}
              selectedData={selectedDistData}
            />
          )}
          {data && activeTab === 1 && (
            <Page2LineItems
              distributors={data.distributors}
              selected={selectedDist}
              onSelect={setSelectedDist}
            />
          )}
          {data && activeTab === 2 && (
            <Page3SummaryMatrix matrix={matrixData} />
          )}
          {data && activeTab === 3 && (
            <Page4MonthlyNational monthly={data.monthlyNational} />
          )}
          {data && activeTab === 4 && (
            <Page5Ranked
              distributors={filteredDists}
              locationFilter={locationFilter}
              setLocationFilter={setLocationFilter}
            />
          )}
        </div>
      </div>
    </>
  )
}

// ── header ────────────────────────────────────────────────────────────────
function Header({ fy, setFy, month, setMonth, onRefresh, loading, totals }: {
  fy: number; setFy: (n: number) => void
  month: number; setMonth: (n: number) => void
  onRefresh: () => void; loading: boolean
  totals?: ApiResp['totals']
}) {
  return (
    <div style={styles.header}>
      <div>
        <h1 style={styles.h1}>Distributor Report</h1>
        <div style={styles.sub}>JAWS · Live from MYOB via CData</div>
      </div>
      <div style={styles.headerControls}>
        <label style={styles.label}>FY
          <select value={fy} onChange={e => setFy(Number(e.target.value))} style={styles.select}>
            {fyOptions().map(y => <option key={y} value={y}>FY{y}</option>)}
          </select>
        </label>
        <label style={styles.label}>Month
          <select value={month} onChange={e => setMonth(Number(e.target.value))} style={styles.select}>
            <option value={-1}>Full FY</option>
            {FY_MONTHS.map((m, i) => <option key={m} value={i}>{m}</option>)}
          </select>
        </label>
        <button onClick={onRefresh} disabled={loading} style={styles.refreshBtn}>
          {loading ? 'Loading…' : '↻ Refresh'}
        </button>
        {totals && (
          <div style={styles.headerStats}>
            <Stat label="Total ex-GST" value={fmt(totals.total)} />
            <Stat label="Distributors" value={String(totals.distributorCount)} />
          </div>
        )}
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ textAlign: 'right' }}>
      <div style={{ fontSize: 11, color: '#888', textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 600, color: '#fff' }}>{value}</div>
    </div>
  )
}

function TabBar({ active, onChange }: { active: number; onChange: (n: number) => void }) {
  const tabs = [
    'Distributor Sales',
    'Detailed Line Items',
    'Summary Matrix',
    'Monthly National',
    'Ranked',
  ]
  return (
    <div style={styles.tabBar}>
      {tabs.map((t, i) => (
        <button
          key={t}
          onClick={() => onChange(i)}
          style={{ ...styles.tab, ...(active === i ? styles.tabActive : {}) }}
        >{t}</button>
      ))}
    </div>
  )
}

function ErrorBanner({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div style={styles.errorBanner}>
      <strong>Error:</strong> {message}
      <button onClick={onRetry} style={{ ...styles.refreshBtn, marginLeft: 12 }}>Retry</button>
    </div>
  )
}

function LoadingState() {
  return <div style={{ padding: 40, textAlign: 'center', color: '#888' }}>Loading from MYOB…</div>
}

// ── Page 1: Distributor Sales (distributor picker + KPI cards) ────────────
function Page1DistributorSales({ data, selected, onSelect, selectedData }: {
  data: ApiResp
  selected: string
  onSelect: (s: string) => void
  selectedData: Distributor | null
}) {
  return (
    <div>
      <div style={styles.distPicker}>
        {data.distributors.map(d => (
          <button
            key={d.customerBase}
            onClick={() => onSelect(d.customerBase)}
            style={{
              ...styles.distChip,
              ...(selected === d.customerBase ? styles.distChipActive : {}),
              ...(d.hasZeroStream ? styles.distChipWarn : {}),
            }}
            title={d.hasZeroStream ? 'One or more revenue streams is $0' : ''}
          >
            {d.customerBase}
            <span style={styles.distChipAmt}>{fmt(d.total)}</span>
          </button>
        ))}
      </div>

      {selectedData ? (
        <>
          <div style={styles.kpiGrid}>
            <KpiCard label="Tuning Revenue ex-GST" value={selectedData.tuning} zero={selectedData.tuning === 0} />
            <KpiCard label="Parts Revenue ex-GST" value={selectedData.parts} zero={selectedData.parts === 0} />
            <KpiCard label="Oil Revenue ex-GST" value={selectedData.oil} zero={selectedData.oil === 0} />
            <KpiCard label="Total Revenue ex-GST" value={selectedData.total} highlight />
          </div>
          <div style={styles.subKpiGrid}>
            <SmallKpi label="Invoice Count" value={String(selectedData.invoiceCount)} />
            <SmallKpi label="Avg Job Value" value={fmt(selectedData.avgJobValue)} />
            <SmallKpi label="Location" value={selectedData.location} />
          </div>
        </>
      ) : (
        <div style={{ padding: 40, color: '#888' }}>Select a distributor above.</div>
      )}
    </div>
  )
}

function KpiCard({ label, value, zero, highlight }: {
  label: string; value: number; zero?: boolean; highlight?: boolean
}) {
  return (
    <div style={{
      ...styles.kpi,
      ...(zero ? styles.kpiZero : {}),
      ...(highlight ? styles.kpiHighlight : {}),
    }}>
      <div style={styles.kpiLabel}>{label}</div>
      <div style={styles.kpiValue}>{fmtSigned(value)}</div>
    </div>
  )
}
function SmallKpi({ label, value }: { label: string; value: string }) {
  return (
    <div style={styles.smallKpi}>
      <div style={styles.kpiLabel}>{label}</div>
      <div style={{ ...styles.kpiValue, fontSize: 18 }}>{value}</div>
    </div>
  )
}

// ── Page 2: Detailed Line Items ───────────────────────────────────────────
function Page2LineItems({ distributors, selected, onSelect }: {
  distributors: Distributor[]
  selected: string
  onSelect: (s: string) => void
}) {
  const dist = distributors.find(d => d.customerBase === selected)
  return (
    <div>
      <label style={{ ...styles.label, marginBottom: 16 }}>Distributor
        <select value={selected} onChange={e => onSelect(e.target.value)} style={styles.select}>
          {distributors.map(d => <option key={d.customerBase} value={d.customerBase}>{d.customerBase}</option>)}
        </select>
      </label>
      {dist ? (
        <div style={styles.tableWrap}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Date</th>
                <th style={styles.th}>Invoice</th>
                <th style={styles.th}>Description</th>
                <th style={styles.th}>Bucket</th>
                <th style={styles.th}>Account</th>
                <th style={{ ...styles.th, textAlign: 'right' }}>Amount ex-GST</th>
              </tr>
            </thead>
            <tbody>
              {dist.lineItems.map((li, i) => (
                <tr key={i} style={styles.tr}>
                  <td style={styles.td}>{(li.date || '').substring(0, 10)}</td>
                  <td style={styles.td}>{li.invoiceNumber}</td>
                  <td style={styles.td}>{li.description}</td>
                  <td style={styles.td}><BucketTag bucket={li.bucket} /></td>
                  <td style={styles.td}>{li.accountCode}</td>
                  <td style={{ ...styles.td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                    {fmtSigned(li.amountExGst)}
                  </td>
                </tr>
              ))}
              <tr style={styles.totalRow}>
                <td style={styles.td} colSpan={5}><strong>Total</strong></td>
                <td style={{ ...styles.td, textAlign: 'right', fontWeight: 700 }}>{fmtSigned(dist.total)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      ) : <div style={{ padding: 40, color: '#888' }}>No distributor selected.</div>}
    </div>
  )
}

function BucketTag({ bucket }: { bucket: string }) {
  const color = bucket === 'Tuning' ? '#7c3aed' : bucket === 'Parts' ? '#0ea5e9' : '#f59e0b'
  return (
    <span style={{
      background: `${color}33`, color, padding: '2px 8px', borderRadius: 4,
      fontSize: 11, fontWeight: 600,
    }}>{bucket}</span>
  )
}

// ── Page 3: Summary Matrix (distributor × month × bucket) ─────────────────
function Page3SummaryMatrix({ matrix }: {
  matrix: { months: string[]; rows: Array<{ distributor: string; location: string; byMonth: Record<string, any>; rowTotal: number }> }
}) {
  const grouped = useMemo(() => {
    const intl = matrix.rows.filter(r => r.location === 'International')
    const natl = matrix.rows.filter(r => r.location === 'National')
    return { natl, intl }
  }, [matrix])

  return (
    <div style={styles.tableWrap}>
      <table style={styles.table}>
        <thead>
          <tr>
            <th style={styles.th}>Distributor</th>
            {matrix.months.map(m => <th key={m} style={{ ...styles.th, textAlign: 'right' }}>{monthLabel(m)}</th>)}
            <th style={{ ...styles.th, textAlign: 'right' }}>Total</th>
          </tr>
        </thead>
        <tbody>
          {grouped.natl.length > 0 && <tr style={styles.groupRow}><td colSpan={matrix.months.length + 2}>National</td></tr>}
          {grouped.natl.map(r => (
            <tr key={r.distributor} style={styles.tr}>
              <td style={styles.td}>{r.distributor}</td>
              {matrix.months.map(m => (
                <td key={m} style={{ ...styles.td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                  {r.byMonth[m]?.total ? fmt(r.byMonth[m].total) : '—'}
                </td>
              ))}
              <td style={{ ...styles.td, textAlign: 'right', fontWeight: 600 }}>{fmt(r.rowTotal)}</td>
            </tr>
          ))}
          {grouped.intl.length > 0 && <tr style={styles.groupRow}><td colSpan={matrix.months.length + 2}>International</td></tr>}
          {grouped.intl.map(r => (
            <tr key={r.distributor} style={styles.tr}>
              <td style={styles.td}>{r.distributor}</td>
              {matrix.months.map(m => (
                <td key={m} style={{ ...styles.td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                  {r.byMonth[m]?.total ? fmt(r.byMonth[m].total) : '—'}
                </td>
              ))}
              <td style={{ ...styles.td, textAlign: 'right', fontWeight: 600 }}>{fmt(r.rowTotal)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── Page 4: Monthly National (bar chart, pure SVG) ────────────────────────
function Page4MonthlyNational({ monthly }: { monthly: Array<{ ym: string; amount: number }> }) {
  if (!monthly.length) return <div style={{ padding: 40, color: '#888' }}>No data in range.</div>
  const max = Math.max(...monthly.map(m => m.amount)) || 1
  const W = 900, H = 380, P = 48
  const bw = (W - P * 2) / monthly.length
  return (
    <div style={styles.chartCard}>
      <div style={styles.chartLabel}>National distributor revenue ex-GST by month</div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 400 }}>
        {[0, 0.25, 0.5, 0.75, 1].map(t => (
          <g key={t}>
            <line x1={P} x2={W - P} y1={H - P - (H - P * 2) * t} y2={H - P - (H - P * 2) * t}
              stroke="#2a2a2a" strokeWidth={1} />
            <text x={P - 6} y={H - P - (H - P * 2) * t + 4} fill="#666" fontSize={10} textAnchor="end">
              {fmt(max * t)}
            </text>
          </g>
        ))}
        {monthly.map((m, i) => {
          const h = (H - P * 2) * (m.amount / max)
          return (
            <g key={m.ym}>
              <rect x={P + i * bw + 4} y={H - P - h} width={bw - 8} height={h}
                fill="#7c3aed" rx={2} />
              <text x={P + i * bw + bw / 2} y={H - P + 16} fill="#888" fontSize={10} textAnchor="middle">
                {monthLabel(m.ym)}
              </text>
              <text x={P + i * bw + bw / 2} y={H - P - h - 4} fill="#ccc" fontSize={10} textAnchor="middle">
                {fmt(m.amount)}
              </text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}

// ── Page 5: Ranked (horizontal bar) ───────────────────────────────────────
function Page5Ranked({ distributors, locationFilter, setLocationFilter }: {
  distributors: Distributor[]
  locationFilter: 'All' | 'National' | 'International'
  setLocationFilter: (s: 'All' | 'National' | 'International') => void
}) {
  const sorted = [...distributors].sort((a, b) => b.total - a.total)
  const max = sorted[0]?.total || 1
  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {(['All', 'National', 'International'] as const).map(f => (
          <button key={f}
            onClick={() => setLocationFilter(f)}
            style={{ ...styles.tab, ...(locationFilter === f ? styles.tabActive : {}) }}>{f}</button>
        ))}
      </div>
      <div style={styles.chartCard}>
        <div style={styles.chartLabel}>Distributor revenue ex-GST, ranked</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {sorted.map(d => (
            <div key={d.customerBase} style={{ display: 'grid', gridTemplateColumns: '220px 1fr 120px', alignItems: 'center', gap: 12 }}>
              <div style={{ fontSize: 13, color: '#ddd', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {d.customerBase}
                {d.hasZeroStream && <span style={{ color: '#ef4444', marginLeft: 4 }}>●</span>}
              </div>
              <div style={{ background: '#1a1a1a', height: 22, borderRadius: 3, position: 'relative' }}>
                <div style={{
                  width: `${(d.total / max) * 100}%`, height: '100%',
                  background: d.location === 'International' ? '#0ea5e9' : '#7c3aed',
                  borderRadius: 3,
                }} />
              </div>
              <div style={{ textAlign: 'right', fontSize: 13, color: '#ddd', fontVariantNumeric: 'tabular-nums' }}>
                {fmt(d.total)}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── styles ────────────────────────────────────────────────────────────────
const styles: Record<string, React.CSSProperties> = {
  page: { minHeight: '100vh', background: '#0a0a0a', color: '#e5e5e5', fontFamily: 'system-ui, -apple-system, sans-serif', padding: 24 },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20, flexWrap: 'wrap', gap: 16 },
  h1: { fontSize: 22, fontWeight: 600, margin: 0, color: '#fff' },
  sub: { fontSize: 12, color: '#888', marginTop: 4 },
  headerControls: { display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' },
  headerStats: { display: 'flex', gap: 24, marginLeft: 8, paddingLeft: 16, borderLeft: '1px solid #2a2a2a' },
  label: { display: 'flex', flexDirection: 'column', fontSize: 11, color: '#888', gap: 4 },
  select: { background: '#1a1a1a', color: '#fff', border: '1px solid #2a2a2a', borderRadius: 4, padding: '6px 10px', fontSize: 13 },
  refreshBtn: { background: '#7c3aed', color: '#fff', border: 'none', borderRadius: 4, padding: '8px 14px', cursor: 'pointer', fontSize: 13, fontWeight: 500 },
  tabBar: { display: 'flex', gap: 4, borderBottom: '1px solid #2a2a2a', marginBottom: 20 },
  tab: { background: 'transparent', color: '#888', border: 'none', padding: '10px 16px', cursor: 'pointer', fontSize: 13, borderBottom: '2px solid transparent' },
  tabActive: { color: '#fff', borderBottom: '2px solid #7c3aed' },
  content: { marginTop: 20 },
  errorBanner: { background: '#7f1d1d', color: '#fecaca', padding: 12, borderRadius: 4, marginBottom: 16 },
  distPicker: { display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 20 },
  distChip: { background: '#1a1a1a', color: '#ccc', border: '1px solid #2a2a2a', borderRadius: 4, padding: '6px 10px', cursor: 'pointer', fontSize: 12, display: 'flex', alignItems: 'center', gap: 8 },
  distChipActive: { background: '#7c3aed', color: '#fff', borderColor: '#7c3aed' },
  distChipWarn: { borderColor: '#ef4444' },
  distChipAmt: { fontSize: 11, opacity: 0.7, fontVariantNumeric: 'tabular-nums' },
  kpiGrid: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 12 },
  subKpiGrid: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 },
  kpi: { background: '#141414', border: '1px solid #2a2a2a', borderRadius: 6, padding: 16 },
  kpiZero: { borderColor: '#ef4444', background: '#1a0a0a' },
  kpiHighlight: { background: '#1a1030', borderColor: '#7c3aed' },
  smallKpi: { background: '#141414', border: '1px solid #2a2a2a', borderRadius: 6, padding: 12 },
  kpiLabel: { fontSize: 11, color: '#888', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 },
  kpiValue: { fontSize: 22, fontWeight: 600, color: '#fff', fontVariantNumeric: 'tabular-nums' },
  tableWrap: { overflow: 'auto', background: '#141414', border: '1px solid #2a2a2a', borderRadius: 6 },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
  th: { textAlign: 'left', padding: '10px 12px', borderBottom: '1px solid #2a2a2a', color: '#888', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 500 },
  td: { padding: '8px 12px', borderBottom: '1px solid #1f1f1f', color: '#ddd' },
  tr: {},
  totalRow: { background: '#1a1030' },
  groupRow: { background: '#1a1a1a', color: '#888', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, padding: '8px 12px' },
  chartCard: { background: '#141414', border: '1px solid #2a2a2a', borderRadius: 6, padding: 20 },
  chartLabel: { fontSize: 12, color: '#888', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 12 },
}
