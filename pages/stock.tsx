// pages/stock.tsx
// Stock & Inventory page for the JA Portal.
// Pulls /api/inventory and renders six views:
//   Overview · Reorder · Velocity · Dead stock · Margin · On order
//
// Uses the portal's dark theme tokens. No external chart libs — everything is SVG/CSS.

import { useEffect, useMemo, useState } from 'react'
import Head from 'next/head'

// ── theme (mirrors pages/distributors.tsx) ───────────────────────────────
const T = {
  bg:     '#0d0f12',
  bg2:    '#131519',
  bg3:    '#1a1d23',
  bg4:    '#21252d',
  border: 'rgba(255,255,255,0.07)',
  border2:'rgba(255,255,255,0.12)',
  text:   '#e8eaf0',
  text2:  '#8b90a0',
  text3:  '#545968',
  blue:   '#4f8ef7',
  teal:   '#2dd4bf',
  green:  '#34c77b',
  amber:  '#f5a623',
  red:    '#f04e4e',
  purple: '#a78bfa',
  accent: '#4f8ef7',
}

// ── types (match the API payload) ────────────────────────────────────────
interface InventoryItem {
  number: string; name: string
  qtyOnHand: number; qtyAvailable: number; qtyCommitted: number; qtyOnOrder: number
  avgCost: number; stockValue: number
  sellPriceIncGst: number; sellPriceExGst: number
  marginPct: number | null; marginDollar: number | null
  reorderLevel: number; reorderQty: number
  supplier: string | null; supplierId: string | null
  lastPurchasePrice: number | null
  unitsSold30d: number; unitsSold90d: number; unitsSold365d: number
  revenue90d: number
  lastSoldDate: string | null; daysSinceLastSold: number | null
  runRatePerDay: number; daysOfCover: number | null
  stockoutDate: string | null
  stockoutStatus: 'out' | 'critical' | 'low' | 'ok' | 'dead' | 'noSales'
  isLowStock: boolean; isOutOfStock: boolean; isDead90d: boolean; isDead180d: boolean
}

interface Totals {
  totalItems: number; totalSkus: number
  stockValue: number; qtyOnHand: number; qtyOnOrder: number; qtyCommitted: number
  lowStockCount: number; outOfStockCount: number
  deadStock90dCount: number; deadStock90dValue: number
  deadStock180dCount: number; deadStock180dValue: number
  reorderSuggestCount: number; reorderSuggestValue: number
}

interface MonthlyPoint { month: string; label: string; units: number; revenue: number }

interface Payload {
  totals: Totals
  items: InventoryItem[]
  monthly: MonthlyPoint[]
  meta: { company: string; generatedAt: string; forecastWindowDays: number; invoiceCount: number; lineCount: number }
}

// ── formatters ───────────────────────────────────────────────────────────
const fmtMoney    = (n: number | null | undefined): string =>
  n == null ? '—' : '$' + Number(n).toLocaleString('en-AU', { maximumFractionDigits: 0 })
const fmtMoneyK   = (n: number): string => {
  if (Math.abs(n) >= 1_000_000) return '$' + (n / 1_000_000).toFixed(2) + 'M'
  if (Math.abs(n) >= 1_000)     return '$' + (n / 1_000).toFixed(0) + 'k'
  return '$' + n.toFixed(0)
}
const fmtInt      = (n: number | null | undefined): string =>
  n == null ? '—' : Number(n).toLocaleString('en-AU', { maximumFractionDigits: 0 })
const fmtPct      = (n: number | null | undefined): string =>
  n == null ? '—' : (n * 100).toFixed(1) + '%'
const fmtDays     = (n: number | null | undefined): string =>
  n == null ? '—' : Math.round(n) + 'd'
const fmtDate     = (d: string | null): string => {
  if (!d) return '—'
  const dt = new Date(d)
  return dt.toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: '2-digit' })
}

// ── small UI building blocks ─────────────────────────────────────────────
function KPI({ label, value, sub, subColor, accent }:
  { label: string; value: string; sub?: string; subColor?: string; accent?: string }) {
  return (
    <div style={{
      background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 10,
      padding: '14px 16px',
      borderTop: accent ? `3px solid ${accent}` : undefined,
    }}>
      <div style={{ fontSize: 10, color: T.text3, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 8 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 500, fontFamily: 'monospace', letterSpacing: '-0.03em', marginBottom: 3, color: T.text }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: subColor || T.text3 }}>{sub}</div>}
    </div>
  )
}

function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 10, padding: 16, ...style }}>
      {children}
    </div>
  )
}

function PTitle({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: T.text3, textTransform: 'uppercase', letterSpacing: '0.08em' }}>{children}</div>
      {right && <div style={{ fontSize: 11, color: T.text3 }}>{right}</div>}
    </div>
  )
}

function Tag({ children, color }: { children: React.ReactNode; color: string }) {
  return (
    <span style={{
      fontSize: 10, fontFamily: 'monospace', padding: '2px 8px', borderRadius: 4,
      background: `${color}20`, color, border: `1px solid ${color}40`, whiteSpace: 'nowrap',
    }}>{children}</span>
  )
}

// ── status colours ───────────────────────────────────────────────────────
const STATUS_COLOR: Record<InventoryItem['stockoutStatus'], string> = {
  out:      T.red,
  critical: T.red,
  low:      T.amber,
  ok:       T.green,
  dead:     T.purple,
  noSales:  T.text3,
}
const STATUS_LABEL: Record<InventoryItem['stockoutStatus'], string> = {
  out:      'OUT',
  critical: '≤14d',
  low:      '≤30d',
  ok:       'OK',
  dead:     'DEAD',
  noSales:  'NO SALES',
}

// ── table primitive ──────────────────────────────────────────────────────
function TH({ children, align, width }: { children: React.ReactNode; align?: 'left' | 'right' | 'center'; width?: string | number }) {
  return (
    <th style={{
      padding: '10px 12px', textAlign: align || 'left',
      fontSize: 10, fontWeight: 600, color: T.text3, textTransform: 'uppercase', letterSpacing: '0.08em',
      borderBottom: `1px solid ${T.border}`, whiteSpace: 'nowrap', width,
    }}>{children}</th>
  )
}
function TD({ children, align, mono, color }: { children: React.ReactNode; align?: 'left' | 'right' | 'center'; mono?: boolean; color?: string }) {
  return (
    <td style={{
      padding: '10px 12px', textAlign: align || 'left',
      fontSize: 12, fontFamily: mono ? 'monospace' : undefined,
      color: color || T.text, borderBottom: `1px solid ${T.border}`,
    }}>{children}</td>
  )
}

// ── main page ────────────────────────────────────────────────────────────
type TabId = 'overview' | 'reorder' | 'velocity' | 'dead' | 'margin' | 'onorder'

export default function StockPage() {
  const [data, setData] = useState<Payload | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [tab, setTab] = useState<TabId>('overview')
  const [search, setSearch] = useState('')
  const [supplierFilter, setSupplierFilter] = useState<string>('__all__')

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true); setErr(null)
      try {
        const r = await fetch('/api/inventory')
        if (!r.ok) {
          const body = await r.text()
          throw new Error(`HTTP ${r.status}: ${body.slice(0, 200)}`)
        }
        const j: Payload = await r.json()
        if (!cancelled) setData(j)
      } catch (e: any) {
        if (!cancelled) setErr(String(e?.message || e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [])

  const items = data?.items || []

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return items.filter(i => {
      if (supplierFilter !== '__all__') {
        const s = i.supplier || '__none__'
        if (supplierFilter === '__none__' ? i.supplier !== null : s !== supplierFilter) return false
      }
      if (!q) return true
      return i.number.toLowerCase().includes(q) || i.name.toLowerCase().includes(q)
    })
  }, [items, search, supplierFilter])

  const suppliers = useMemo(() => {
    const s = new Set<string>()
    for (const i of items) if (i.supplier) s.add(i.supplier)
    return Array.from(s).sort()
  }, [items])

  return (
    <>
      <Head><title>Stock &amp; Inventory — JA Portal</title></Head>
      <div style={{ padding: '20px 24px 40px', color: T.text, background: T.bg, minHeight: '100vh', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' }}>

        {/* header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <div>
            <div style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-0.02em' }}>Stock &amp; Inventory</div>
            <div style={{ fontSize: 12, color: T.text3, marginTop: 2 }}>
              Live from MYOB JAWS ·
              {data?.meta && <> refreshed {new Date(data.meta.generatedAt).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' })} · {data.meta.invoiceCount} invoices scanned</>}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              placeholder="Search SKU or name…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              style={{
                background: T.bg2, border: `1px solid ${T.border}`, color: T.text,
                borderRadius: 6, padding: '7px 12px', fontSize: 12, minWidth: 200,
                outline: 'none', fontFamily: 'inherit',
              }}
            />
            <select
              value={supplierFilter}
              onChange={e => setSupplierFilter(e.target.value)}
              style={{
                background: T.bg2, border: `1px solid ${T.border}`, color: T.text,
                borderRadius: 6, padding: '7px 10px', fontSize: 12, outline: 'none',
              }}
            >
              <option value="__all__">All suppliers</option>
              <option value="__none__">— No supplier set —</option>
              {suppliers.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        </div>

        {/* loading / error */}
        {loading && <Card><div style={{ padding: 20, textAlign: 'center', color: T.text2 }}>Loading inventory from MYOB…</div></Card>}
        {err && <Card style={{ borderColor: `${T.red}60` }}>
          <div style={{ color: T.red, fontWeight: 600, marginBottom: 6 }}>Inventory failed to load</div>
          <div style={{ color: T.text2, fontSize: 12, fontFamily: 'monospace' }}>{err}</div>
        </Card>}

        {data && !loading && (
          <>
            {/* KPI strip — always visible */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 12, marginBottom: 20 }}>
              <KPI label="Stock value" value={fmtMoneyK(data.totals.stockValue)} sub={`${data.totals.totalItems} SKUs · ${fmtInt(data.totals.qtyOnHand)} units`} accent={T.blue} />
              <KPI label="Low stock" value={fmtInt(data.totals.lowStockCount)} sub="below reorder level" subColor={data.totals.lowStockCount > 0 ? T.amber : T.text3} accent={T.amber} />
              <KPI label="Out of stock" value={fmtInt(data.totals.outOfStockCount)} sub="zero on hand" subColor={data.totals.outOfStockCount > 0 ? T.red : T.text3} accent={T.red} />
              <KPI label="Dead stock (90d)" value={fmtMoneyK(data.totals.deadStock90dValue)} sub={`${data.totals.deadStock90dCount} items · no sales`} subColor={T.purple} accent={T.purple} />
              <KPI label="On order" value={fmtInt(data.totals.qtyOnOrder)} sub="units inbound" accent={T.teal} />
              <KPI label="Reorder cost" value={fmtMoneyK(data.totals.reorderSuggestValue)} sub={`${data.totals.reorderSuggestCount} items @ avg cost`} accent={T.green} />
            </div>

            {/* tabs */}
            <div style={{ display: 'flex', gap: 4, marginBottom: 16, borderBottom: `1px solid ${T.border}` }}>
              {([
                ['overview', 'Overview'],
                ['reorder',  `Reorder (${data.totals.lowStockCount + data.totals.outOfStockCount})`],
                ['velocity', 'Velocity & top sellers'],
                ['dead',     `Dead stock (${data.totals.deadStock90dCount})`],
                ['margin',   'Margin'],
                ['onorder',  'On order'],
              ] as [TabId, string][]).map(([id, label]) => (
                <button
                  key={id}
                  onClick={() => setTab(id)}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    padding: '10px 14px',
                    fontSize: 12, fontWeight: 600,
                    color: tab === id ? T.text : T.text2,
                    borderBottom: tab === id ? `2px solid ${T.accent}` : '2px solid transparent',
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                    marginBottom: -1,
                  }}
                >{label}</button>
              ))}
            </div>

            {/* tab content */}
            {tab === 'overview' && <OverviewTab data={data} items={filtered} />}
            {tab === 'reorder'  && <ReorderTab items={filtered} />}
            {tab === 'velocity' && <VelocityTab items={filtered} />}
            {tab === 'dead'     && <DeadStockTab items={filtered} />}
            {tab === 'margin'   && <MarginTab items={filtered} />}
            {tab === 'onorder'  && <OnOrderTab items={filtered} />}
          </>
        )}
      </div>
    </>
  )
}

// ── OVERVIEW ────────────────────────────────────────────────────────────
function OverviewTab({ data, items }: { data: Payload; items: InventoryItem[] }) {
  // top 10 by stock value
  const topValue = [...items].sort((a, b) => b.stockValue - a.stockValue).slice(0, 10)
  const maxValue = topValue[0]?.stockValue || 1

  // monthly trend
  const maxUnits = Math.max(1, ...data.monthly.map(m => m.units))

  // stockout status counts (whole portfolio, not filtered)
  const statusCounts = items.reduce<Record<string, number>>((acc, i) => {
    acc[i.stockoutStatus] = (acc[i.stockoutStatus] || 0) + 1
    return acc
  }, {})

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 16 }}>
      <Card>
        <PTitle right="Stock value, live MYOB">Top 10 held items</PTitle>
        {topValue.length === 0 && <div style={{ color: T.text3, fontSize: 12 }}>No items match the current filter.</div>}
        {topValue.map(i => (
          <div key={i.number} style={{ marginBottom: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
              <div style={{ fontSize: 12 }}>
                <span style={{ fontFamily: 'monospace', color: T.text2 }}>{i.number}</span>
                <span style={{ marginLeft: 8, color: T.text }}>{i.name}</span>
              </div>
              <div style={{ fontSize: 12, fontFamily: 'monospace', color: T.text }}>{fmtMoney(i.stockValue)}</div>
            </div>
            <div style={{ height: 4, background: T.bg3, borderRadius: 2, overflow: 'hidden' }}>
              <div style={{ width: (i.stockValue / maxValue * 100) + '%', height: '100%', background: T.blue }} />
            </div>
            <div style={{ display: 'flex', gap: 10, marginTop: 4, fontSize: 10, color: T.text3, fontFamily: 'monospace' }}>
              <span>OH {fmtInt(i.qtyOnHand)}</span>
              <span>90d sold {fmtInt(i.unitsSold90d)}</span>
              <span>Cover {fmtDays(i.daysOfCover)}</span>
              <Tag color={STATUS_COLOR[i.stockoutStatus]}>{STATUS_LABEL[i.stockoutStatus]}</Tag>
            </div>
          </div>
        ))}
      </Card>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <Card>
          <PTitle>Stockout risk breakdown</PTitle>
          {([
            ['out',      'Out of stock'],
            ['critical', 'Critical — ≤14 days cover'],
            ['low',      'Low — ≤30 days cover'],
            ['ok',       'Healthy — >30 days'],
            ['dead',     'Dead — held value, no sales'],
            ['noSales',  'No sales / no stock'],
          ] as [InventoryItem['stockoutStatus'], string][]).map(([key, label]) => {
            const count = statusCounts[key] || 0
            const pct = items.length > 0 ? count / items.length : 0
            return (
              <div key={key} style={{ marginBottom: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 4 }}>
                  <span style={{ color: T.text }}>{label}</span>
                  <span style={{ color: T.text2, fontFamily: 'monospace' }}>{count}</span>
                </div>
                <div style={{ height: 3, background: T.bg3, borderRadius: 2 }}>
                  <div style={{ width: (pct * 100) + '%', height: '100%', background: STATUS_COLOR[key], borderRadius: 2 }} />
                </div>
              </div>
            )
          })}
        </Card>

        <Card>
          <PTitle right="Portfolio, ex-GST">12-month units shipped</PTitle>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 100, padding: '8px 0' }}>
            {data.monthly.map(m => (
              <div key={m.month} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                <div style={{
                  width: '100%',
                  height: (m.units / maxUnits * 84) + 'px',
                  background: T.blue, opacity: 0.85, borderRadius: '2px 2px 0 0',
                  minHeight: m.units > 0 ? 2 : 0,
                }} title={`${m.label}: ${fmtInt(m.units)} units · ${fmtMoneyK(m.revenue)}`} />
                <div style={{ fontSize: 9, color: T.text3, fontFamily: 'monospace' }}>{m.label.split(' ')[0]}</div>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  )
}

// ── REORDER ─────────────────────────────────────────────────────────────
function ReorderTab({ items }: { items: InventoryItem[] }) {
  const needsOrder = [...items]
    .filter(i => i.isOutOfStock || i.isLowStock)
    .sort((a, b) => {
      // Out of stock first, then by days of cover ascending
      if (a.isOutOfStock !== b.isOutOfStock) return a.isOutOfStock ? -1 : 1
      const ac = a.daysOfCover ?? 9999
      const bc = b.daysOfCover ?? 9999
      return ac - bc
    })

  const totalOrderCost = needsOrder.reduce((s, i) => {
    const qty = i.reorderQty > 0 ? i.reorderQty : Math.max(i.reorderLevel - i.qtyOnHand, 0)
    return s + qty * i.avgCost
  }, 0)

  return (
    <Card>
      <PTitle right={`${needsOrder.length} items · ${fmtMoney(totalOrderCost)} at avg cost`}>Reorder suggestions</PTitle>
      {needsOrder.length === 0 && <div style={{ color: T.text3, fontSize: 12, padding: 10 }}>Nothing needs reordering right now.</div>}
      {needsOrder.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <TH>Item</TH>
                <TH align="right">On hand</TH>
                <TH align="right">Reorder lvl</TH>
                <TH align="right">Cover</TH>
                <TH align="right">90d sold</TH>
                <TH align="right">Suggest qty</TH>
                <TH align="right">Est. cost</TH>
                <TH>Supplier</TH>
                <TH align="center">Status</TH>
              </tr>
            </thead>
            <tbody>
              {needsOrder.map(i => {
                const suggestQty = i.reorderQty > 0 ? i.reorderQty : Math.max(i.reorderLevel - i.qtyOnHand, 1)
                return (
                  <tr key={i.number}>
                    <TD>
                      <div style={{ fontFamily: 'monospace', fontSize: 11, color: T.text2 }}>{i.number}</div>
                      <div style={{ fontSize: 12 }}>{i.name}</div>
                    </TD>
                    <TD align="right" mono color={i.isOutOfStock ? T.red : T.text}>{fmtInt(i.qtyOnHand)}</TD>
                    <TD align="right" mono color={T.text2}>{fmtInt(i.reorderLevel)}</TD>
                    <TD align="right" mono color={
                      i.daysOfCover === null ? T.text3 :
                      i.daysOfCover <= 14 ? T.red :
                      i.daysOfCover <= 30 ? T.amber : T.text
                    }>{fmtDays(i.daysOfCover)}</TD>
                    <TD align="right" mono color={T.text2}>{fmtInt(i.unitsSold90d)}</TD>
                    <TD align="right" mono color={T.green}>{fmtInt(suggestQty)}</TD>
                    <TD align="right" mono>{fmtMoney(suggestQty * i.avgCost)}</TD>
                    <TD color={i.supplier ? T.text : T.text3}>{i.supplier || '— not set —'}</TD>
                    <TD align="center"><Tag color={STATUS_COLOR[i.stockoutStatus]}>{STATUS_LABEL[i.stockoutStatus]}</Tag></TD>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}

// ── VELOCITY / TOP SELLERS ──────────────────────────────────────────────
function VelocityTab({ items }: { items: InventoryItem[] }) {
  type SortKey = 'units90' | 'rev90' | 'runrate' | 'units30'
  const [sort, setSort] = useState<SortKey>('rev90')

  const sorted = useMemo(() => {
    const arr = [...items]
    arr.sort((a, b) => {
      switch (sort) {
        case 'units90':  return b.unitsSold90d - a.unitsSold90d
        case 'rev90':    return b.revenue90d - a.revenue90d
        case 'runrate':  return b.runRatePerDay - a.runRatePerDay
        case 'units30':  return b.unitsSold30d - a.unitsSold30d
      }
    })
    return arr
  }, [items, sort])

  // top 15 for the bar chart
  const top = sorted.slice(0, 15)
  const maxBar = Math.max(
    1,
    ...top.map(i => sort === 'rev90' ? i.revenue90d
                   : sort === 'units30' ? i.unitsSold30d
                   : sort === 'runrate' ? i.runRatePerDay
                   : i.unitsSold90d)
  )

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
      <Card>
        <PTitle right={
          <select
            value={sort}
            onChange={e => setSort(e.target.value as SortKey)}
            style={{
              background: T.bg3, border: `1px solid ${T.border}`, color: T.text,
              borderRadius: 4, padding: '3px 6px', fontSize: 10, fontFamily: 'monospace',
            }}
          >
            <option value="rev90">Revenue 90d</option>
            <option value="units90">Units 90d</option>
            <option value="units30">Units 30d</option>
            <option value="runrate">Run rate / day</option>
          </select>
        }>Top 15 by selected metric</PTitle>

        {top.map(i => {
          const val = sort === 'rev90' ? i.revenue90d
                    : sort === 'units30' ? i.unitsSold30d
                    : sort === 'runrate' ? i.runRatePerDay
                    : i.unitsSold90d
          const display = sort === 'rev90' ? fmtMoney(val)
                       : sort === 'runrate' ? val.toFixed(2) + '/d'
                       : fmtInt(val)
          return (
            <div key={i.number} style={{ marginBottom: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 3 }}>
                <span style={{ color: T.text }}><span style={{ fontFamily: 'monospace', color: T.text2 }}>{i.number}</span> · {i.name.slice(0, 30)}</span>
                <span style={{ color: T.text, fontFamily: 'monospace' }}>{display}</span>
              </div>
              <div style={{ height: 3, background: T.bg3, borderRadius: 2 }}>
                <div style={{ width: (val / maxBar * 100) + '%', height: '100%', background: T.teal, borderRadius: 2 }} />
              </div>
            </div>
          )
        })}
      </Card>

      <Card>
        <PTitle right="Ranked list">Full velocity table</PTitle>
        <div style={{ overflowX: 'auto', maxHeight: 560, overflowY: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead style={{ position: 'sticky', top: 0, background: T.bg2 }}>
              <tr>
                <TH>Item</TH>
                <TH align="right">30d</TH>
                <TH align="right">90d</TH>
                <TH align="right">365d</TH>
                <TH align="right">Run/day</TH>
                <TH align="right">Cover</TH>
              </tr>
            </thead>
            <tbody>
              {sorted.map(i => (
                <tr key={i.number}>
                  <TD>
                    <div style={{ fontFamily: 'monospace', fontSize: 10, color: T.text2 }}>{i.number}</div>
                    <div style={{ fontSize: 11 }}>{i.name.slice(0, 34)}</div>
                  </TD>
                  <TD align="right" mono>{fmtInt(i.unitsSold30d)}</TD>
                  <TD align="right" mono>{fmtInt(i.unitsSold90d)}</TD>
                  <TD align="right" mono color={T.text2}>{fmtInt(i.unitsSold365d)}</TD>
                  <TD align="right" mono color={T.teal}>{i.runRatePerDay.toFixed(2)}</TD>
                  <TD align="right" mono color={
                    i.daysOfCover === null ? T.text3 :
                    i.daysOfCover <= 30 ? T.amber :
                    i.daysOfCover <= 14 ? T.red : T.text
                  }>{fmtDays(i.daysOfCover)}</TD>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}

// ── DEAD STOCK ──────────────────────────────────────────────────────────
function DeadStockTab({ items }: { items: InventoryItem[] }) {
  const dead = items
    .filter(i => i.stockValue > 0 && (i.daysSinceLastSold === null || i.daysSinceLastSold >= 90))
    .sort((a, b) => b.stockValue - a.stockValue)

  const tiers = {
    '90-180d': dead.filter(i => i.daysSinceLastSold !== null && i.daysSinceLastSold >= 90  && i.daysSinceLastSold < 180),
    '180-365d': dead.filter(i => i.daysSinceLastSold !== null && i.daysSinceLastSold >= 180 && i.daysSinceLastSold < 365),
    '365d+':   dead.filter(i => i.daysSinceLastSold !== null && i.daysSinceLastSold >= 365),
    'never':   dead.filter(i => i.daysSinceLastSold === null),
  }

  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 16 }}>
        <KPI label="90–180 days" value={fmtMoneyK(tiers['90-180d'].reduce((s, i) => s + i.stockValue, 0))}
             sub={`${tiers['90-180d'].length} items`} accent={T.amber} />
        <KPI label="180–365 days" value={fmtMoneyK(tiers['180-365d'].reduce((s, i) => s + i.stockValue, 0))}
             sub={`${tiers['180-365d'].length} items`} accent="#ff8c42" />
        <KPI label="Over 365 days" value={fmtMoneyK(tiers['365d+'].reduce((s, i) => s + i.stockValue, 0))}
             sub={`${tiers['365d+'].length} items`} accent={T.red} />
        <KPI label="Never sold (12m)" value={fmtMoneyK(tiers['never'].reduce((s, i) => s + i.stockValue, 0))}
             sub={`${tiers['never'].length} items`} accent={T.purple} />
      </div>

      <Card>
        <PTitle right={`${dead.length} items holding ${fmtMoney(dead.reduce((s, i) => s + i.stockValue, 0))}`}>Dead stock — ranked by value</PTitle>
        {dead.length === 0 && <div style={{ color: T.text3, fontSize: 12, padding: 10 }}>No dead stock. Everything with held value has moved in the last 90 days.</div>}
        {dead.length > 0 && (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <TH>Item</TH>
                  <TH align="right">On hand</TH>
                  <TH align="right">Avg cost</TH>
                  <TH align="right">Held value</TH>
                  <TH align="right">Last sold</TH>
                  <TH align="right">Days idle</TH>
                  <TH>Supplier</TH>
                </tr>
              </thead>
              <tbody>
                {dead.map(i => {
                  const idleColor = i.daysSinceLastSold === null ? T.purple
                    : i.daysSinceLastSold >= 365 ? T.red
                    : i.daysSinceLastSold >= 180 ? '#ff8c42'
                    : T.amber
                  return (
                    <tr key={i.number}>
                      <TD>
                        <div style={{ fontFamily: 'monospace', fontSize: 10, color: T.text2 }}>{i.number}</div>
                        <div style={{ fontSize: 12 }}>{i.name}</div>
                      </TD>
                      <TD align="right" mono>{fmtInt(i.qtyOnHand)}</TD>
                      <TD align="right" mono color={T.text2}>{fmtMoney(i.avgCost)}</TD>
                      <TD align="right" mono color={T.text}>{fmtMoney(i.stockValue)}</TD>
                      <TD align="right" mono color={T.text2}>{fmtDate(i.lastSoldDate)}</TD>
                      <TD align="right" mono color={idleColor}>{i.daysSinceLastSold === null ? '∞' : `${i.daysSinceLastSold}d`}</TD>
                      <TD color={i.supplier ? T.text : T.text3}>{i.supplier || '—'}</TD>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  )
}

// ── MARGIN ──────────────────────────────────────────────────────────────
function MarginTab({ items }: { items: InventoryItem[] }) {
  const withMargin = items.filter(i => i.marginPct !== null).sort((a, b) => (a.marginPct ?? 0) - (b.marginPct ?? 0))
  const avgMargin = withMargin.length > 0
    ? withMargin.reduce((s, i) => s + (i.marginPct ?? 0), 0) / withMargin.length
    : 0

  // distribution buckets
  const buckets = [
    { label: '<0% (loss)',    min: -Infinity, max: 0,    color: T.red },
    { label: '0–20%',         min: 0,         max: 0.2,  color: '#ff8c42' },
    { label: '20–40%',        min: 0.2,       max: 0.4,  color: T.amber },
    { label: '40–60%',        min: 0.4,       max: 0.6,  color: T.teal },
    { label: '60%+',          min: 0.6,       max: Infinity, color: T.green },
  ]
  const bucketCounts = buckets.map(b => ({
    ...b,
    count: withMargin.filter(i => (i.marginPct ?? 0) >= b.min && (i.marginPct ?? 0) < b.max).length,
  }))
  const maxBucket = Math.max(1, ...bucketCounts.map(b => b.count))

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 16 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <Card>
          <PTitle>Portfolio margin</PTitle>
          <div style={{ fontSize: 28, fontFamily: 'monospace', color: T.text, marginBottom: 6 }}>{fmtPct(avgMargin)}</div>
          <div style={{ fontSize: 11, color: T.text3 }}>average across {withMargin.length} priced SKUs</div>
        </Card>
        <Card>
          <PTitle>Margin distribution</PTitle>
          {bucketCounts.map(b => (
            <div key={b.label} style={{ marginBottom: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 3 }}>
                <span style={{ color: T.text }}>{b.label}</span>
                <span style={{ color: T.text2, fontFamily: 'monospace' }}>{b.count}</span>
              </div>
              <div style={{ height: 4, background: T.bg3, borderRadius: 2 }}>
                <div style={{ width: (b.count / maxBucket * 100) + '%', height: '100%', background: b.color, borderRadius: 2 }} />
              </div>
            </div>
          ))}
        </Card>
      </div>

      <Card>
        <PTitle right="Lowest margin first — candidates for price review">Margin by item</PTitle>
        <div style={{ overflowX: 'auto', maxHeight: 560, overflowY: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead style={{ position: 'sticky', top: 0, background: T.bg2 }}>
              <tr>
                <TH>Item</TH>
                <TH align="right">Avg cost</TH>
                <TH align="right">Sell ex-GST</TH>
                <TH align="right">$ margin</TH>
                <TH align="right">% margin</TH>
                <TH align="right">90d units</TH>
              </tr>
            </thead>
            <tbody>
              {withMargin.map(i => (
                <tr key={i.number}>
                  <TD>
                    <div style={{ fontFamily: 'monospace', fontSize: 10, color: T.text2 }}>{i.number}</div>
                    <div style={{ fontSize: 11 }}>{i.name.slice(0, 38)}</div>
                  </TD>
                  <TD align="right" mono color={T.text2}>{fmtMoney(i.avgCost)}</TD>
                  <TD align="right" mono color={T.text2}>{fmtMoney(i.sellPriceExGst)}</TD>
                  <TD align="right" mono color={(i.marginDollar ?? 0) < 0 ? T.red : T.text}>{fmtMoney(i.marginDollar)}</TD>
                  <TD align="right" mono color={
                    (i.marginPct ?? 0) < 0   ? T.red :
                    (i.marginPct ?? 0) < 0.2 ? '#ff8c42' :
                    (i.marginPct ?? 0) < 0.4 ? T.amber :
                    (i.marginPct ?? 0) < 0.6 ? T.teal : T.green
                  }>{fmtPct(i.marginPct)}</TD>
                  <TD align="right" mono color={T.text2}>{fmtInt(i.unitsSold90d)}</TD>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}

// ── ON ORDER ────────────────────────────────────────────────────────────
function OnOrderTab({ items }: { items: InventoryItem[] }) {
  const onOrder = items.filter(i => i.qtyOnOrder > 0).sort((a, b) => b.qtyOnOrder * b.avgCost - a.qtyOnOrder * a.avgCost)
  const totalOrderedCost = onOrder.reduce((s, i) => s + i.qtyOnOrder * i.avgCost, 0)
  const totalOrderedUnits = onOrder.reduce((s, i) => s + i.qtyOnOrder, 0)

  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 16 }}>
        <KPI label="Purchase orders open" value={fmtInt(onOrder.length)} sub="distinct SKUs on order" accent={T.teal} />
        <KPI label="Units inbound" value={fmtInt(totalOrderedUnits)} sub="across all open POs" accent={T.blue} />
        <KPI label="Inbound value" value={fmtMoneyK(totalOrderedCost)} sub="at avg cost — excludes freight" accent={T.green} />
      </div>

      <Card>
        <PTitle right={`${onOrder.length} items on order`}>Purchase order pipeline</PTitle>
        {onOrder.length === 0 && <div style={{ color: T.text3, fontSize: 12, padding: 10 }}>No open purchase orders for items in the current filter.</div>}
        {onOrder.length > 0 && (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <TH>Item</TH>
                  <TH align="right">On hand</TH>
                  <TH align="right">On order</TH>
                  <TH align="right">After arrival</TH>
                  <TH align="right">90d sold</TH>
                  <TH align="right">Cover after PO</TH>
                  <TH align="right">Order value</TH>
                  <TH>Supplier</TH>
                </tr>
              </thead>
              <tbody>
                {onOrder.map(i => {
                  const after = i.qtyOnHand + i.qtyOnOrder
                  const coverAfter = i.runRatePerDay > 0 ? after / i.runRatePerDay : null
                  return (
                    <tr key={i.number}>
                      <TD>
                        <div style={{ fontFamily: 'monospace', fontSize: 10, color: T.text2 }}>{i.number}</div>
                        <div style={{ fontSize: 12 }}>{i.name}</div>
                      </TD>
                      <TD align="right" mono color={i.isOutOfStock ? T.red : T.text}>{fmtInt(i.qtyOnHand)}</TD>
                      <TD align="right" mono color={T.teal}>{fmtInt(i.qtyOnOrder)}</TD>
                      <TD align="right" mono>{fmtInt(after)}</TD>
                      <TD align="right" mono color={T.text2}>{fmtInt(i.unitsSold90d)}</TD>
                      <TD align="right" mono color={T.text2}>{fmtDays(coverAfter)}</TD>
                      <TD align="right" mono>{fmtMoney(i.qtyOnOrder * i.avgCost)}</TD>
                      <TD color={i.supplier ? T.text : T.text3}>{i.supplier || '—'}</TD>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  )
}
