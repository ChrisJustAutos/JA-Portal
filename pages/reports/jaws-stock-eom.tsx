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
  units90: number; lastSold: string | null; daysSinceLastSold: number | null
  daysOfCover: number | null
  suggestQty?: number; suggestCost?: number; reason?: string
}
interface Report {
  month: string; monthLabel: string; generatedAt: string
  headline: any
  ageing: Array<{ bucket: string; skus: number; value: number }>
  topByUnits: Item[]; topByRevenue: Item[]; topByMargin: Item[]
  slowMovers: Item[]; neverSold: Item[]; reorder: Item[]
  belowCost: Item[]; costCreep: Item[]; unfilledDemand: Item[]; overstock: Item[]
  suppliers: Array<{ supplier: string; skus: number; stockValue: number; monthRevenueEx: number; reorderCost: number }>
  integrity: Array<{ sku: string; name: string; issue: string; detail: string }>
  stocktake: { count: number; latest: string | null; matched: number; unmatched: number } | null
  trend: Array<{ month: string; stockValue: number; monthRevenueEx: number; monthMarginPct: number | null; deadValue: number; turns: number | null }>
  notes: string[]
}

const money = (n: number | null | undefined) => n == null ? '—' : '$' + Math.round(n).toLocaleString('en-AU')
const pct = (n: number | null | undefined) => n == null ? '—' : `${(n * 100).toFixed(1)}%`
const qty = (n: number | null | undefined) => n == null ? '—' : String(Math.round(n * 100) / 100)

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

  const load = useCallback(async (m?: string, refresh = false) => {
    setLoading(true)
    try {
      const q = new URLSearchParams()
      if (m) q.set('month', m)
      if (refresh) q.set('refresh', '1')
      const r = await fetch(`/api/reports/jaws-stock-eom?${q}`, { credentials: 'same-origin' })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`)
      setReport(d.report); setMonths(d.months || []); setMonth(d.report.month)
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
            <button onClick={emailNow} disabled={!!busy || !report}
              style={{ padding: '7px 14px', borderRadius: 6, border: 'none', background: T.green, color: '#fff', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
              {busy === 'email' ? 'Sending…' : 'Email this report'}
            </button>
          </div>

          {loading && !report && <div style={{ padding: 40, textAlign: 'center', color: T.text3, fontSize: 13 }}>Reading MYOB — a full rebuild pulls 13 months of invoice lines, so this can take a minute…</div>}

          {report && h && (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: 12, marginBottom: 18 }}>
                <Kpi label="Stock on hand" value={money(h.stockValue)} sub={`${qty(h.qtyOnHand)} units · ${h.skus} SKUs`} delta={d(h.stockValue, prev?.stockValue)} />
                <Kpi label="Sales this month (ex GST)" value={money(h.monthRevenueEx)} sub={`${qty(h.monthUnits)} units · ${h.activeSkusThisMonth} SKUs sold`} delta={d(h.monthRevenueEx, prev?.monthRevenueEx)} />
                <Kpi label="Gross margin" value={money(h.monthMargin)} sub={`${pct(h.monthMarginPct)} of sales`} delta={d(h.monthMarginPct, prev?.monthMarginPct)} />
                <Kpi label="Stock turn (12m)" value={h.turnsAnnualised == null ? '—' : `${h.turnsAnnualised.toFixed(2)}×`} sub={h.daysInventory ? `${h.daysInventory} days of inventory` : undefined} />
                <Kpi label="Dead stock (90d)" value={money(h.dead90Value)} sub={`${h.dead90Count} SKUs · ${money(h.dead180Value)} at 180d`} delta={d(h.dead90Value, prev?.deadValue)} tone={h.dead90Value > 0 ? T.amber : undefined} />
                <Kpi label="Never sold" value={money(h.neverSoldValue)} sub={`${h.neverSoldCount} SKUs holding stock`} tone={h.neverSoldValue > 0 ? T.red : undefined} />
                <Kpi label="Overstock (>1yr cover)" value={money(h.overstockValue)} sub={`${h.overstockCount} SKUs`} tone={h.overstockValue > 0 ? T.amber : undefined} />
                <Kpi label="Reorder suggested" value={money(h.reorderCost)} sub={`${h.reorderCount} SKUs · ${h.outOfStockCount} out, ${h.lowStockCount} low`} />
              </div>

              <Table title="Where the money is sitting" hint="Held stock value by how recently that SKU last sold. “Never sold” is the list worth arguing about."
                cols={[{ label: 'Last sold' }, { label: 'SKUs', right: true }, { label: 'Value held', right: true }, { label: 'Share', right: true }]}
                rows={report.ageing.map(a => [a.bucket, a.skus, money(a.value), h.stockValue > 0 ? pct(a.value / h.stockValue) : '—'])} />

              <Table title="Top movers this month — by units" hint="What actually shifted. Prev = same SKU last month, so you can see momentum."
                cols={[{ label: 'SKU' }, { label: 'Name' }, { label: 'Units', right: true }, { label: 'Prev', right: true }, { label: 'Revenue ex', right: true }, { label: 'Margin %', right: true }, { label: 'Cover (days)', right: true }]}
                rows={report.topByUnits.map(i => [i.sku, i.name.slice(0, 46), qty(i.monthUnits), qty(i.prevMonthUnits), money(i.monthRevenueEx), pct(i.marginPct), i.daysOfCover == null ? '—' : Math.round(i.daysOfCover)])} />

              <Table title="Biggest margin earners this month" hint="Margin dollars, not revenue — usually a different list, and the one that pays the wages."
                cols={[{ label: 'SKU' }, { label: 'Name' }, { label: 'Margin $', right: true }, { label: 'Margin %', right: true }, { label: 'Units', right: true }]}
                rows={report.topByMargin.map(i => [i.sku, i.name.slice(0, 46), money(i.monthMargin), pct(i.marginPct), qty(i.monthUnits)])} />

              <Table title="Slow movers — capital sitting still" hint="Holding stock with no sale in 90 days, worst first by value tied up."
                cols={[{ label: 'SKU' }, { label: 'Name' }, { label: 'Value held', right: true }, { label: 'On hand', right: true }, { label: 'Last sold' }, { label: 'Days' }]}
                rows={report.slowMovers.map(i => [i.sku, i.name.slice(0, 44), money(i.stockValue), qty(i.onHand), i.lastSold || 'never', i.daysSinceLastSold ?? '—'])} />

              <Table title="Never sold" hint="Stock on the shelf that has never been invoiced in the 12 months read. Write-down, clearance or delete candidates."
                cols={[{ label: 'SKU' }, { label: 'Name' }, { label: 'Value held', right: true }, { label: 'On hand', right: true }, { label: 'Supplier' }]}
                rows={report.neverSold.map(i => [i.sku, i.name.slice(0, 44), money(i.stockValue), qty(i.onHand), i.supplier || '—'])} />

              <Table title="Reorder suggestions" hint="Below the MYOB alert level, or under 60 days cover on something that moves. Quantity targets 90 days of cover and respects MOQ; cost uses last paid price where MYOB has one."
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
