// pages/reports/jaws-stock-eom.tsx
// Reports → Stock EOM. The month-end view of JAWS stock: what it's worth, what
// it earned, what isn't moving, and what to buy. Snapshots are stored per month
// (migration 199), so this is also the only place month-on-month stock movement
// can be seen — MYOB itself only ever reports today's quantity.

import { useCallback, useEffect, useState } from 'react'
import Head from 'next/head'
import { useRouter } from 'next/router'
import PortalTopBar from '../../lib/PortalTopBar'
import ReportsTabs from '../../components/ReportsTabs'
import { requireReportPageAuth } from '../../lib/authServer'
import type { PortalUserSSR } from '../../lib/authServer'
import { T } from '../../lib/ui/theme'
import { useToast, useConfirm } from '../../components/ui/Feedback'

interface Item {
  sku: string; name: string; supplier: string | null
  onHand: number; available: number; committed: number; onOrder: number
  avgCost: number; stockValue: number; sellEx: number
  marginPct: number | null; marginDollar: number | null; lastPurchasePrice: number | null
  monthUnits: number; monthRevenueEx: number; monthMargin: number; prevMonthUnits: number
  units90: number; lastSold: string | null; daysSinceLastSold: number | null; unitsSinceMonthEnd: number
  daysOfCover: number | null; capitalAtRisk: number
  historyUnits: number; historyRevenueEx: number
  avgUnitsPerMonth: number; avgRevenuePerMonth: number
  monthsCoverAtAvg: number | null; growthPct: number | null
  suggestQty?: number; suggestCost?: number; reason?: string
  slowReason?: string
}
interface Report {
  month: string; monthLabel: string; generatedAt: string
  headline: any
  history?: {
    from: string; to: string; months: number
    unitsTotal: number; revenueExTotal: number
    avgUnitsPerMonth: number; avgRevenuePerMonth: number
    growthPct: number | null
    firstHalfLabel: string | null; firstHalfRevenueEx: number | null
    secondHalfLabel: string | null; secondHalfRevenueEx: number | null
    series: Array<{ month: string; units: number; revenueEx: number }>
  }
  ageing: Array<{ bucket: string; skus: number; value: number }>
  topByUnits: Item[]; topByRevenue: Item[]; topByMargin: Item[]
  slowMovers: Item[]; reorder: Item[]
  belowCost: Item[]; costCreep: Item[]; unfilledDemand: Item[]; overstock: Item[]
  suppliers: Array<{ supplier: string; skus: number; stockValue: number; monthRevenueEx: number; reorderCost: number }>
  integrity: Array<{ sku: string; name: string; issue: string; detail: string }>
  stocktake: { count: number; latest: string | null; matched: number; unmatched: number } | null
  trend: Array<{ month: string; stockValue: number; monthRevenueEx: number; monthMarginPct: number | null; deadValue: number; turns: number | null }>
  notes: string[]
}

// 'YYYY-MM' shifted by n months — used by the history-window presets.
const addMonthsStr = (m: string, n: number) => {
  if (!/^\d{4}-\d{2}$/.test(m)) return m
  const [y, mm] = m.split('-').map(Number)
  const d = new Date(Date.UTC(y, mm - 1 + n, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

const money = (n: number | null | undefined) => n == null ? '—' : '$' + Math.round(n).toLocaleString('en-AU')
const pct = (n: number | null | undefined) => n == null ? '—' : `${(n * 100).toFixed(1)}%`
const qty = (n: number | null | undefined) => n == null ? '—' : String(Math.round(n * 100) / 100)
const growth = (n: number | null | undefined) => n == null ? '—' : `${n >= 0 ? '+' : ''}${(n * 100).toFixed(0)}%`

const card: React.CSSProperties = { background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 10, padding: 14 }
const th: React.CSSProperties = { textAlign: 'left', padding: '6px 10px', fontSize: 10, color: T.text3, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: `1px solid ${T.border}`, whiteSpace: 'nowrap' }
const td: React.CSSProperties = { padding: '6px 10px', fontSize: 12.5, borderBottom: `1px solid ${T.border}` }
const tdR: React.CSSProperties = { ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }

function Kpi({ label, value, sub, delta, tone }: { label: string; value: string; sub?: string; delta?: number | null; tone?: string }) {
  return (
    <div style={card}>
      <div style={{ fontSize: 10, color: T.text3, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
      <div style={{ fontSize: 21, fontWeight: 700, marginTop: 5, color: tone || T.text, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      {(sub || delta != null) && (
        <div style={{ fontSize: 11, color: T.text3, marginTop: 3 }}>
          {delta != null && (
            <span style={{ color: delta >= 0 ? T.green : T.red, marginRight: 6 }}>
              {delta >= 0 ? '▲' : '▼'} {Math.abs(delta * 100).toFixed(1)}%
            </span>
          )}
          {sub}
        </div>
      )}
    </div>
  )
}

function Table({ title, hint, rows, cols }: {
  title: string; hint?: string
  rows: Array<Array<string | number | null>>
  cols: Array<{ label: string; right?: boolean }>
}) {
  return (
    <div style={{ ...card, padding: 0, marginBottom: 16 }}>
      <div style={{ padding: '12px 14px', borderBottom: `1px solid ${T.border}` }}>
        <div style={{ fontSize: 13.5, fontWeight: 600 }}>{title}</div>
        {hint && <div style={{ fontSize: 11, color: T.text3, marginTop: 3, lineHeight: 1.45 }}>{hint}</div>}
      </div>
      {!rows.length
        ? <div style={{ padding: '16px 14px', fontSize: 12.5, color: T.text3 }}>Nothing to report.</div>
        : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>{cols.map((c, i) => <th key={i} style={{ ...th, textAlign: c.right ? 'right' : 'left' }}>{c.label}</th>)}</tr></thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>{r.map((v, j) => <td key={j} style={cols[j]?.right ? tdR : td}>{v ?? '—'}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </div>
  )
}

export default function JawsStockEomPage({ user }: { user: PortalUserSSR }) {
  const router = useRouter()
  const toast = useToast()
  const confirmDialog = useConfirm()
  const [report, setReport] = useState<Report | null>(null)
  const [months, setMonths] = useState<Array<{ month: string; generated_at: string }>>([])
  const [month, setMonth] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  // Sales-history window. Empty = whatever the server defaults to (the 12
  // months ending with the reported month); once a report is loaded these
  // hold the window it was actually built with.
  const [from, setFrom] = useState<string>('')
  const [to, setTo] = useState<string>('')

  const load = useCallback(async (m?: string, refresh = false, win?: { from?: string; to?: string }) => {
    setLoading(true)
    try {
      const q = new URLSearchParams()
      if (m) q.set('month', m)
      if (refresh) q.set('refresh', '1')
      if (win?.from) q.set('from', win.from)
      if (win?.to) q.set('to', win.to)
      const r = await fetch(`/api/reports/jaws-stock-eom?${q}`, { credentials: 'same-origin' })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`)
      setReport(d.report); setMonths(d.months || []); setMonth(d.report.month)
      // Reflect back the window the report was built with, so the pickers
      // always describe the numbers on screen.
      if (d.report?.history) { setFrom(d.report.history.from); setTo(d.report.history.to) }
      if (refresh) toast('Rebuilt from MYOB', 'success')
    } catch (e: any) {
      toast(e?.message || 'Failed to load', 'error')
    } finally { setLoading(false) }
  }, [toast])

  useEffect(() => { load(typeof router.query.month === 'string' ? router.query.month : undefined) }, [])

  async function emailNow() {
    if (!report) return
    if (!(await confirmDialog({ title: `Email the ${report.monthLabel} report now?`, message: 'It goes to the JAWS month-end list (Chris and Morgan by default).' }))) return
    setBusy('email')
    try {
      const r = await fetch('/api/reports/jaws-stock-eom', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify({ month: report.month, email: true }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`)
      toast(`Sent to ${(d.emailed || []).join(', ')}`, 'success')
    } catch (e: any) { toast(e?.message || 'Send failed', 'error') }
    setBusy('')
  }

  // PDF export. Fetched rather than linked so the session cookie rides along
  // and a failure surfaces as a toast instead of a browser error page — the
  // endpoint serves the stored snapshot, so this is normally instant.
  async function downloadPdf() {
    if (!report) return
    setBusy('pdf')
    try {
      const q = new URLSearchParams({ month: report.month })
      if (report.history) { q.set('from', report.history.from); q.set('to', report.history.to) }
      const r = await fetch(`/api/reports/jaws-stock-eom/pdf?${q}`, { credentials: 'same-origin' })
      if (!r.ok) {
        let msg = `HTTP ${r.status}`
        try { msg = (await r.json()).error || msg } catch { /* not JSON */ }
        throw new Error(msg)
      }
      const blob = await r.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `jaws-stock-${report.month}.pdf`
      document.body.appendChild(a)
      a.click()
      a.remove()
      // Revoke on the next tick — Safari cancels the download if the object
      // URL disappears while the click is still being handled.
      setTimeout(() => URL.revokeObjectURL(url), 2000)
      toast('PDF downloaded', 'success')
    } catch (e: any) { toast(e?.message || 'PDF export failed', 'error') }
    setBusy('')
  }

  const h = report?.headline
  const prev = report?.trend.filter(t => t.month < report.month).slice(-1)[0]
  const d = (now?: number, before?: number | null) =>
    now == null || before == null || before === 0 ? null : (now - before) / Math.abs(before)

  return (
    <>
      <Head><title>Stock EOM — Just Autos</title><meta name="robots" content="noindex,nofollow" /></Head>
      <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh', fontFamily: "'DM Sans', system-ui, sans-serif", background: T.bg, color: T.text }}>
        <PortalTopBar activeId="reports" currentUserRole={user.role} currentUserVisibleTabs={user.visibleTabs} currentUserName={user.displayName} currentUserEmail={user.email} />
        <ReportsTabs active="jaws-stock-eom" role={user.role} reportTabs={user.visibleReportTabs} />

        <div style={{ flex: 1, padding: '18px 20px 60px', width: '100%', boxSizing: 'border-box', maxWidth: 1500 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
            <div>
              <div style={{ fontSize: 17, fontWeight: 700 }}>JAWS Stock — month end</div>
              <div style={{ fontSize: 12, color: T.text3, marginTop: 2 }}>
                {report ? `${report.monthLabel} · stock read ${report.generatedAt.slice(0, 10)}` : 'Loading…'}
              </div>
            </div>
            <div style={{ flex: 1 }} />
            <select value={month} onChange={e => { setMonth(e.target.value); load(e.target.value) }}
              style={{ padding: '7px 10px', background: T.bg3, border: `1px solid ${T.border2}`, borderRadius: 6, color: T.text, fontSize: 12.5, fontFamily: 'inherit' }}>
              {(months.length ? months : (report ? [{ month: report.month, generated_at: report.generatedAt }] : [])).map(m => (
                <option key={m.month} value={m.month}>{m.month}</option>
              ))}
            </select>
            <button onClick={() => load(month, true)} disabled={loading}
              style={{ padding: '7px 14px', borderRadius: 6, border: `1px solid ${T.border2}`, background: T.bg3, color: T.text2, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
              {loading ? 'Working…' : 'Rebuild from MYOB'}
            </button>
            <button onClick={() => load(month, true, { from, to })} disabled={loading || !report}
              style={{ padding: '7px 12px', borderRadius: 6, border: `1px solid ${T.border2}`, background: T.bg3, color: T.text2, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}
              title="Rebuild using the sales-history window selected below">
              Apply window
            </button>
            <button onClick={downloadPdf} disabled={!!busy || !report}
              style={{ padding: '7px 14px', borderRadius: 6, border: `1px solid ${T.border2}`, background: T.bg3, color: T.text2, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
              {busy === 'pdf' ? 'Preparing…' : 'Export PDF'}
            </button>
            <button onClick={emailNow} disabled={!!busy || !report}
              style={{ padding: '7px 14px', borderRadius: 6, border: 'none', background: T.green, color: '#fff', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
              {busy === 'email' ? 'Sending…' : 'Email this report'}
            </button>
          </div>

          {/* Sales-history window — drives every average, months-of-cover and the
              growth read. Presets are the common asks; the month boxes are there
              when a specific range is wanted. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 14, padding: '9px 12px', background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 8 }}>
            <span style={{ fontSize: 11.5, color: T.text3, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Sales history</span>
            {[3, 6, 12, 24].map(n => {
              const f = addMonthsStr(month || report?.month || '', -(n - 1))
              const active = !!report?.history && report.history.from === f && report.history.to === (month || report.month)
              return (
                <button key={n} onClick={() => { setFrom(f); setTo(month); load(month, true, { from: f, to: month }) }} disabled={loading || !month}
                  style={{ padding: '5px 10px', borderRadius: 6, border: `1px solid ${active ? T.accent : T.border2}`, background: active ? T.accent : T.bg3, color: active ? '#fff' : T.text2, fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
                  {n} months
                </button>
              )
            })}
            <span style={{ fontSize: 12, color: T.text3 }}>or</span>
            <input type="month" value={from} max={to || month} onChange={e => setFrom(e.target.value)}
              style={{ padding: '5px 8px', background: T.bg3, border: `1px solid ${T.border2}`, borderRadius: 6, color: T.text, fontSize: 12, fontFamily: 'inherit' }} />
            <span style={{ fontSize: 12, color: T.text3 }}>→</span>
            <input type="month" value={to} max={month} onChange={e => setTo(e.target.value)}
              style={{ padding: '5px 8px', background: T.bg3, border: `1px solid ${T.border2}`, borderRadius: 6, color: T.text, fontSize: 12, fontFamily: 'inherit' }} />
            <span style={{ fontSize: 11.5, color: T.text3 }}>
              {report?.history
                ? `Averages, months of cover and growth are measured over ${report.history.months} month${report.history.months === 1 ? '' : 's'} (${report.history.from} → ${report.history.to}). Press Apply window after changing it.`
                : 'Defaults to the 12 months ending with the reported month.'}
            </span>
          </div>

          {loading && !report && <div style={{ padding: 40, textAlign: 'center', color: T.text3, fontSize: 13 }}>Reading MYOB — a full rebuild pulls 13 months of invoice lines, so this can take a minute…</div>}

          {report && h && (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: 12, marginBottom: 18 }}>
                <Kpi label="Stock on hand" value={money(h.stockValue)} sub={`${qty(h.qtyOnHand)} units · ${h.skus} SKUs`} delta={d(h.stockValue, prev?.stockValue)} />
                <Kpi label="Sales this month (ex GST)" value={money(h.monthRevenueEx)} sub={`${qty(h.monthUnits)} units · ${h.activeSkusThisMonth} SKUs sold`} delta={d(h.monthRevenueEx, prev?.monthRevenueEx)} />
                <Kpi label="Gross margin" value={money(h.monthMargin)} sub={`${pct(h.monthMarginPct)} of sales`} delta={d(h.monthMarginPct, prev?.monthMarginPct)} />
                <Kpi label="Stock turn (12m)" value={h.turnsAnnualised == null ? '—' : `${h.turnsAnnualised.toFixed(2)}×`} sub={h.daysInventory ? `${h.daysInventory} days of inventory` : undefined} />
                <Kpi label="Average sales / month" value={money(report.history?.avgRevenuePerMonth)}
                  sub={report.history ? `${qty(report.history.avgUnitsPerMonth)} units per month over ${report.history.months} months` : 'Rebuild to measure'} />
                <Kpi label="Growth over the window" value={report.history?.growthPct == null ? '—' : `${report.history.growthPct >= 0 ? '+' : ''}${(report.history.growthPct * 100).toFixed(1)}%`}
                  sub={report.history?.firstHalfLabel ? `${report.history.secondHalfLabel} vs ${report.history.firstHalfLabel}` : 'Needs at least 4 months'}
                  tone={report.history?.growthPct == null ? undefined : report.history.growthPct >= 0 ? T.green : T.red} />
                <Kpi label="Dead stock (90d)" value={money(h.dead90Value)} sub={`${h.dead90Count} SKUs · ${money(h.dead180Value)} at 180d`} delta={d(h.dead90Value, prev?.deadValue)} tone={h.dead90Value > 0 ? T.amber : undefined} />
                <Kpi label="Slow movers — capital at risk" value={money(h.slowCapital)} sub={`${h.slowCount} SKUs holding more than 90 days of their own demand`} tone={h.slowCapital > 0 ? T.amber : undefined} />
                <Kpi label="Never sold (excluded)" value={money(h.neverSoldValue)} sub={`${h.neverSoldCount} SKUs — treated as kit parts, left out of the figures above`} />
                <Kpi label="Overstock (>1yr cover)" value={money(h.overstockValue)} sub={`${h.overstockCount} SKUs`} tone={h.overstockValue > 0 ? T.amber : undefined} />
                <Kpi label="Reorder suggested" value={money(h.reorderCost)} sub={`${h.reorderCount} SKUs · ${h.outOfStockCount} out, ${h.lowStockCount} low`} />
              </div>

              {report.history && (
                <Table title="Sales by month — the history window"
                  hint={`Every average, months-of-cover and growth figure on this report is measured over these ${report.history.months} months (${report.history.from} → ${report.history.to}). Change the window at the top and press Apply window. Share of window shows how much of the period's revenue landed in each month — a run of rising shares is growth.`}
                  cols={[{ label: 'Month' }, { label: 'Units', right: true }, { label: 'Revenue ex', right: true }, { label: 'Share of window', right: true }, { label: 'vs previous month', right: true }]}
                  rows={report.history.series.map((m, i, arr) => {
                    const before = i > 0 ? arr[i - 1].revenueEx : null
                    const chg = before && before !== 0 ? (m.revenueEx - before) / before : null
                    return [
                      m.month, qty(m.units), money(m.revenueEx),
                      report.history!.revenueExTotal > 0 ? pct(m.revenueEx / report.history!.revenueExTotal) : '—',
                      chg == null ? '—' : `${chg >= 0 ? '+' : ''}${(chg * 100).toFixed(1)}%`,
                    ]
                  })} />
              )}

              <Table title="Where the money is sitting" hint={`Held stock value by how recently that SKU last sold, over the ${money(h.analysedValue)} that has sold at least once. Stock that has never sold — ${money(h.neverSoldValue)} across ${h.neverSoldCount} SKUs — is excluded: on this item list that is almost always a kit component never sold separately. Shares are of the analysed value, so they total 100%.`}
                cols={[{ label: 'Last sold' }, { label: 'SKUs', right: true }, { label: 'Value held', right: true }, { label: 'Share', right: true }]}
                rows={report.ageing.map(a => [a.bucket, a.skus, money(a.value), h.analysedValue > 0 ? pct(a.value / h.analysedValue) : '—'])} />

              <Table title="Top movers this month — by units"
                hint={`What actually shifted. Prev = same SKU last month. Avg/mo and Growth are over the history window; months of cover is on-hand at that average rate. On hand is as at ${report.generatedAt.slice(0, 10)}, when the stock was read.`}
                cols={[{ label: 'SKU' }, { label: 'Name' }, { label: 'On hand', right: true }, { label: 'Units', right: true }, { label: 'Prev', right: true }, { label: 'Avg/mo', right: true }, { label: 'Growth', right: true }, { label: 'Revenue ex', right: true }, { label: 'Margin %', right: true }, { label: 'Months cover', right: true }]}
                rows={report.topByUnits.map(i => [i.sku, i.name.slice(0, 40), qty(i.onHand), qty(i.monthUnits), qty(i.prevMonthUnits), qty(i.avgUnitsPerMonth), growth(i.growthPct), money(i.monthRevenueEx), pct(i.marginPct), i.monthsCoverAtAvg == null ? '—' : i.monthsCoverAtAvg.toFixed(1)])} />

              <Table title="Biggest margin earners this month" hint="Margin dollars, not revenue — usually a different list, and the one that pays the wages."
                cols={[{ label: 'SKU' }, { label: 'Name' }, { label: 'On hand', right: true }, { label: 'Margin $', right: true }, { label: 'Margin %', right: true }, { label: 'Units', right: true }, { label: 'Avg/mo', right: true }]}
                rows={report.topByMargin.map(i => [i.sku, i.name.slice(0, 44), qty(i.onHand), money(i.monthMargin), pct(i.marginPct), qty(i.monthUnits), qty(i.avgUnitsPerMonth)])} />

              <Table title="Slow movers — where the capital is stuck" hint={`Two ways onto this list: nothing sold in the 90 days to the end of ${report.monthLabel}, or it still sells but holds over 180 days of cover with at least $2,000 tied up beyond a 90-day target. Ranked by capital at risk — the value held beyond 90 days of that SKU's own demand — so the money is at the top, not the longest-idle SKU. Stock that has never sold is excluded (kit parts). “Sold since” is what moved after the month closed: a number there means the SKU is waking up.`}
                cols={[{ label: 'SKU' }, { label: 'Name' }, { label: 'Capital at risk', right: true }, { label: 'Value held', right: true }, { label: 'On hand', right: true }, { label: 'Avg/mo', right: true }, { label: 'Months cover', right: true }, { label: 'Growth', right: true }, { label: 'Why' }, { label: 'Last sold' }, { label: 'Sold since', right: true }]}
                rows={report.slowMovers.map(i => [i.sku, i.name.slice(0, 36), money(i.capitalAtRisk), money(i.stockValue), qty(i.onHand), qty(i.avgUnitsPerMonth), i.monthsCoverAtAvg == null ? '—' : i.monthsCoverAtAvg.toFixed(1), growth(i.growthPct), i.slowReason || '', i.lastSold || '—', i.unitsSinceMonthEnd ? qty(i.unitsSinceMonthEnd) : '—'])} />

              <Table title="Reorder suggestions" hint={`Only the ${h.reorderSheetSize} SKUs on the Stock Order sheet — MYOB's item list also holds kit components that are never sold separately.${h.reorderExcludedCount ? ` ${h.reorderExcludedCount} off-sheet item(s) sat below their alert level and were excluded; add a SKU to the Stock Order sheet if it should be ordered.` : ''} Flagged when below the alert level, or under 60 days cover on something that moves. Quantity targets 90 days and respects MOQ; cost uses last paid price where MYOB has one.`}
                cols={[{ label: 'SKU' }, { label: 'Name' }, { label: 'On hand', right: true }, { label: 'On order', right: true }, { label: 'Cover', right: true }, { label: 'Order qty', right: true }, { label: 'Est. cost', right: true }, { label: 'Why' }, { label: 'Supplier' }]}
                rows={report.reorder.map(i => [i.sku, i.name.slice(0, 34), qty(i.onHand), qty(i.onOrder), i.daysOfCover == null ? '—' : Math.round(i.daysOfCover), qty(i.suggestQty), money(i.suggestCost), i.reason || '', i.supplier || '—'])} />

              <Table title="Sold while out of stock" hint="Sold this month but nothing available, or committed beyond what's on hand — demand you couldn't fill on the spot."
                cols={[{ label: 'SKU' }, { label: 'Name' }, { label: 'Units sold', right: true }, { label: 'Available', right: true }, { label: 'Committed', right: true }, { label: 'On order', right: true }]}
                rows={report.unfilledDemand.map(i => [i.sku, i.name.slice(0, 44), qty(i.monthUnits), qty(i.available), qty(i.committed), qty(i.onOrder)])} />

              <Table title="Margin leakage — sold below cost" hint="Selling price ex GST is under average cost, and it sold this month."
                cols={[{ label: 'SKU' }, { label: 'Name' }, { label: 'Sell ex', right: true }, { label: 'Avg cost', right: true }, { label: 'Per unit', right: true }, { label: 'Units', right: true }]}
                rows={report.belowCost.map(i => [i.sku, i.name.slice(0, 44), money(i.sellEx), money(i.avgCost), money((i.sellEx || 0) - (i.avgCost || 0)), qty(i.monthUnits)])} />

              <Table title="Cost creep — price review list" hint="Last purchase price is more than 10% above average cost, so the buy price has moved and the sell price probably hasn't."
                cols={[{ label: 'SKU' }, { label: 'Name' }, { label: 'Avg cost', right: true }, { label: 'Last paid', right: true }, { label: 'Sell ex', right: true }, { label: 'Margin now', right: true }]}
                rows={report.costCreep.map(i => [i.sku, i.name.slice(0, 42), money(i.avgCost), money(i.lastPurchasePrice), money(i.sellEx), pct(i.marginPct)])} />

              <Table title="Overstock — more than a year of cover" hint="At the current 90-day run rate this stock outlasts the year. Money you could have back."
                cols={[{ label: 'SKU' }, { label: 'Name' }, { label: 'Value held', right: true }, { label: 'On hand', right: true }, { label: 'Cover (days)', right: true }]}
                rows={report.overstock.map(i => [i.sku, i.name.slice(0, 44), money(i.stockValue), qty(i.onHand), i.daysOfCover == null ? '—' : Math.round(i.daysOfCover)])} />

              <Table title="Suppliers" hint="Where the stock value and the reorder spend concentrate."
                cols={[{ label: 'Supplier' }, { label: 'SKUs', right: true }, { label: 'Stock value', right: true }, { label: 'Sales this month', right: true }, { label: 'Reorder cost', right: true }]}
                rows={report.suppliers.map(s => [s.supplier, s.skus, money(s.stockValue), money(s.monthRevenueEx), money(s.reorderCost)])} />

              <Table title="Data to tidy up" hint="Not stock problems — record problems. Each one quietly distorts every figure above."
                cols={[{ label: 'SKU' }, { label: 'Name' }, { label: 'Issue' }, { label: 'Detail' }]}
                rows={report.integrity.map(i => [i.sku, i.name.slice(0, 40), i.issue, i.detail])} />

              {report.stocktake && (
                <div style={{ ...card, marginBottom: 16 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 4 }}>Stocktake this month</div>
                  <div style={{ fontSize: 12.5, color: T.text2 }}>
                    {report.stocktake.count} count{report.stocktake.count === 1 ? '' : 's'} completed
                    {report.stocktake.latest ? ` (latest ${report.stocktake.latest})` : ''} — {report.stocktake.matched} lines matched, {report.stocktake.unmatched} unmatched.
                    Counts are report-only; they never write back to MYOB.
                  </div>
                </div>
              )}

              {report.trend.length > 1 && (
                <Table title="Month on month" hint="Built from stored snapshots — this is why the report is generated each month rather than read live."
                  cols={[{ label: 'Month' }, { label: 'Stock value', right: true }, { label: 'Sales ex', right: true }, { label: 'Margin %', right: true }, { label: 'Dead stock', right: true }, { label: 'Turns', right: true }]}
                  rows={report.trend.slice(-13).reverse().map(t => [t.month, money(t.stockValue), money(t.monthRevenueEx), pct(t.monthMarginPct), money(t.deadValue), t.turns == null ? '—' : t.turns.toFixed(2)])} />
              )}

              <div style={{ ...card, fontSize: 11.5, color: T.text3, lineHeight: 1.6 }}>
                <div style={{ fontWeight: 600, color: T.text2, marginBottom: 5 }}>How to read this</div>
                {report.notes.map((n, i) => <div key={i} style={{ marginBottom: 3 }}>• {n}</div>)}
              </div>
            </>
          )}
        </div>
      </div>
    </>
  )
}

export async function getServerSideProps(context: any) {
  // 'view:stock' rather than the default 'view:reports' — the report carries
  // costs, margins and supplier pricing.
  return requireReportPageAuth(context, 'jaws-stock-eom', 'view:stock')
}
