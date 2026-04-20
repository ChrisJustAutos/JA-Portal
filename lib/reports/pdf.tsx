// lib/reports/pdf.tsx
// SERVER-ONLY PDF renderer using @react-pdf/renderer.
// Takes a GeneratedReport, returns a PDF Buffer.
//
// Design: clean A4 portrait layout, muted corporate palette.
// All amounts ex-GST. Narrative from Claude sits at the top, followed by data sections.

import React from 'react'
import { Document, Page, Text, View, StyleSheet, pdf, Svg, Rect, Line, Polyline, G } from '@react-pdf/renderer'
import type { GeneratedReport, GeneratedSection } from './spec'

// ── Palette ────────────────────────────────────────────────────────────
const COLORS = {
  ink:     '#1a1d23',
  ink2:    '#3a3f4a',
  ink3:    '#6b7280',
  line:    '#d1d5db',
  line2:   '#e5e7eb',
  bg:      '#ffffff',
  bg2:     '#f9fafb',
  bg3:     '#f3f4f6',
  accent:  '#2563eb',
  green:   '#059669',
  red:     '#dc2626',
  amber:   '#d97706',
  teal:    '#0d9488',
}

const styles = StyleSheet.create({
  page: {
    padding: 36,
    fontFamily: 'Helvetica',
    fontSize: 9.5,
    color: COLORS.ink,
    backgroundColor: COLORS.bg,
  },
  coverHeader: {
    marginBottom: 18,
    paddingBottom: 14,
    borderBottom: `1pt solid ${COLORS.line}`,
  },
  coverTitle: { fontSize: 22, fontWeight: 700, color: COLORS.ink, marginBottom: 4 },
  coverSubtitle: { fontSize: 10, color: COLORS.ink3 },
  sectionHeading: { fontSize: 13, fontWeight: 700, color: COLORS.ink, marginBottom: 6, marginTop: 12 },
  sectionSubheading: { fontSize: 8.5, color: COLORS.ink3, marginBottom: 8 },
  paragraph: { fontSize: 9.5, lineHeight: 1.55, color: COLORS.ink, marginBottom: 6 },
  bulletRow: { flexDirection: 'row', marginBottom: 3 },
  bulletDot: { width: 10, color: COLORS.accent, fontWeight: 700 },
  bulletText: { flex: 1, fontSize: 9.5, lineHeight: 1.45, color: COLORS.ink },
  tableHeader: {
    flexDirection: 'row',
    backgroundColor: COLORS.bg3,
    paddingVertical: 4,
    paddingHorizontal: 6,
    borderBottom: `0.5pt solid ${COLORS.line}`,
    fontSize: 8.5,
    fontWeight: 700,
    color: COLORS.ink2,
  },
  tableRow: {
    flexDirection: 'row',
    paddingVertical: 3.5,
    paddingHorizontal: 6,
    borderBottom: `0.5pt solid ${COLORS.line2}`,
    fontSize: 8.5,
    color: COLORS.ink,
  },
  tableRowAlt: {
    backgroundColor: COLORS.bg2,
  },
  tableTotal: {
    flexDirection: 'row',
    paddingVertical: 4,
    paddingHorizontal: 6,
    borderTop: `1pt solid ${COLORS.ink}`,
    fontSize: 9,
    fontWeight: 700,
    color: COLORS.ink,
    marginTop: 2,
  },
  col: { flex: 1 },
  colNum: { flex: 1, textAlign: 'right' },
  kpiGrid: { flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -4, marginTop: 4 },
  kpiCell: {
    width: '25%',
    paddingHorizontal: 4,
    marginBottom: 8,
  },
  kpiBox: {
    borderTop: `2pt solid ${COLORS.accent}`,
    backgroundColor: COLORS.bg2,
    padding: 6,
    height: 54,
  },
  kpiLabel: { fontSize: 7.5, color: COLORS.ink3, marginBottom: 2, textTransform: 'uppercase' },
  kpiValue: { fontSize: 13, fontWeight: 700, color: COLORS.ink },
  kpiSub: { fontSize: 7, color: COLORS.ink3, marginTop: 1 },
  footer: {
    position: 'absolute',
    bottom: 20,
    left: 36,
    right: 36,
    fontSize: 7.5,
    color: COLORS.ink3,
    textAlign: 'center',
    borderTop: `0.5pt solid ${COLORS.line2}`,
    paddingTop: 4,
  },
  aiBox: {
    backgroundColor: COLORS.bg2,
    padding: 10,
    borderLeft: `2pt solid ${COLORS.accent}`,
    marginBottom: 10,
  },
  aiLabel: { fontSize: 7.5, color: COLORS.accent, fontWeight: 700, marginBottom: 4, textTransform: 'uppercase' },
  badgePrepaid: {
    paddingHorizontal: 3,
    paddingVertical: 1,
    backgroundColor: COLORS.green,
    color: COLORS.bg,
    fontSize: 6.5,
    fontWeight: 700,
    borderRadius: 2,
  },
})

// ── Formatters ─────────────────────────────────────────────────────────
const fmt = (n: number | null | undefined): string => {
  if (n == null || !isFinite(n)) return '—'
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (Math.abs(n) >= 10_000)    return `$${Math.round(n / 1000)}k`
  return `$${Math.round(n).toLocaleString('en-AU')}`
}
const fmtFull = (n: number | null | undefined): string => {
  if (n == null || !isFinite(n)) return '—'
  return `$${Math.round(n).toLocaleString('en-AU')}`
}
const fmtDate = (d: string): string => {
  try { return new Date(d).toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' }) }
  catch { return d }
}
const fmtPeriod = (start: string, end: string): string => {
  return `${fmtDate(start)} – ${fmtDate(end)}`
}

// ── Section renderers ──────────────────────────────────────────────────

function BulletList({ bullets }: { bullets: string[] }) {
  if (!bullets || bullets.length === 0) return null
  return (
    <View style={{ marginTop: 4, marginBottom: 8 }}>
      {bullets.map((b, i) => (
        <View key={i} style={styles.bulletRow}>
          <Text style={styles.bulletDot}>•</Text>
          <Text style={styles.bulletText}>{b}</Text>
        </View>
      ))}
    </View>
  )
}

function KpiSummary({ data }: { data: any }) {
  const entities = data?.entities || []
  return (
    <View wrap={false}>
      {entities.map((e: any, i: number) => (
        <View key={i} style={{ marginBottom: 10 }}>
          <Text style={{ fontSize: 10, fontWeight: 700, marginBottom: 4, color: COLORS.ink2 }}>{e.entity}</Text>
          <View style={styles.kpiGrid}>
            <KpiBox label="Revenue" value={fmt(e.revenueExGst)} sub="Period, ex-GST"/>
            <KpiBox label="Net (P&L)" value={fmt(e.netExGst)} sub="After overheads" valueColor={e.netExGst >= 0 ? COLORS.green : COLORS.red}/>
            <KpiBox label="Receivables" value={fmt(e.receivablesExGst)} sub={`${e.openInvoiceCount} invoices`}/>
            <KpiBox label="Payables" value={fmt(e.payablesExGst)} sub={`${e.openBillCount} bills`}/>
            {e.stockValueExGst != null && <KpiBox label="Stock Value" value={fmt(e.stockValueExGst)} sub="On hand"/>}
            <KpiBox label="Income" value={fmt(e.incomeFromPnlExGst)} sub="P&L 4-xxxx"/>
            <KpiBox label="COS" value={fmt(e.cosFromPnlExGst)} sub="P&L 5-xxxx"/>
            {e.overheadsFromPnlExGst > 0 && <KpiBox label="Overheads" value={fmt(e.overheadsFromPnlExGst)} sub="P&L 6-xxxx"/>}
          </View>
        </View>
      ))}
    </View>
  )
}

function KpiBox({ label, value, sub, valueColor }: { label: string; value: string; sub?: string; valueColor?: string }) {
  return (
    <View style={styles.kpiCell}>
      <View style={styles.kpiBox}>
        <Text style={styles.kpiLabel}>{label}</Text>
        <Text style={[styles.kpiValue, valueColor ? { color: valueColor } : {}]}>{value}</Text>
        {sub && <Text style={styles.kpiSub}>{sub}</Text>}
      </View>
    </View>
  )
}

function PnlSummary({ data }: { data: any }) {
  const entities = data?.entities || []
  return (
    <View>
      {entities.map((e: any, idx: number) => (
        <View key={idx} style={{ marginBottom: 10 }} wrap={false}>
          <Text style={{ fontSize: 10, fontWeight: 700, marginBottom: 4, color: COLORS.ink2 }}>{e.entity}</Text>
          <View style={styles.tableHeader}>
            <Text style={[styles.col, { flex: 2.5 }]}>Account</Text>
            <Text style={{ width: 50 }}>Code</Text>
            <Text style={styles.colNum}>Amount (ex-GST)</Text>
          </View>
          {e.income.slice(0, 8).map((r: any, i: number) => (
            <View key={i} style={[styles.tableRow, i % 2 === 1 ? styles.tableRowAlt : {}]}>
              <Text style={[styles.col, { flex: 2.5 }]}>{r.account}</Text>
              <Text style={{ width: 50, color: COLORS.ink3 }}>{r.code}</Text>
              <Text style={styles.colNum}>{fmtFull(r.amount)}</Text>
            </View>
          ))}
          <View style={styles.tableTotal}>
            <Text style={[styles.col, { flex: 2.5 }]}>Total Income</Text>
            <Text style={{ width: 50 }}></Text>
            <Text style={styles.colNum}>{fmtFull(e.totalIncome)}</Text>
          </View>
          {e.cos.length > 0 && (
            <>
              <View style={styles.tableTotal}>
                <Text style={[styles.col, { flex: 2.5 }]}>– Cost of Sales</Text>
                <Text style={{ width: 50 }}></Text>
                <Text style={styles.colNum}>{fmtFull(e.totalCos)}</Text>
              </View>
              <View style={styles.tableTotal}>
                <Text style={[styles.col, { flex: 2.5, fontWeight: 700 }]}>Gross Profit</Text>
                <Text style={{ width: 50 }}></Text>
                <Text style={[styles.colNum, { color: e.grossProfit >= 0 ? COLORS.green : COLORS.red }]}>{fmtFull(e.grossProfit)}</Text>
              </View>
            </>
          )}
          {e.overheads.length > 0 && (
            <View style={styles.tableTotal}>
              <Text style={[styles.col, { flex: 2.5 }]}>– Overheads</Text>
              <Text style={{ width: 50 }}></Text>
              <Text style={styles.colNum}>{fmtFull(e.totalOverheads)}</Text>
            </View>
          )}
          <View style={styles.tableTotal}>
            <Text style={[styles.col, { flex: 2.5, fontWeight: 700 }]}>Net Profit</Text>
            <Text style={{ width: 50 }}></Text>
            <Text style={[styles.colNum, { color: e.netProfit >= 0 ? COLORS.green : COLORS.red }]}>{fmtFull(e.netProfit)}</Text>
          </View>
        </View>
      ))}
    </View>
  )
}

function TopCustomers({ data }: { data: any }) {
  const entities = data?.entities || []
  return (
    <View>
      {entities.map((e: any, idx: number) => (
        <View key={idx} style={{ marginBottom: 10 }} wrap={false}>
          <Text style={{ fontSize: 10, fontWeight: 700, marginBottom: 4, color: COLORS.ink2 }}>{e.entity} — Top 10 customers</Text>
          <View style={styles.tableHeader}>
            <Text style={[styles.col, { flex: 0.4 }]}>#</Text>
            <Text style={[styles.col, { flex: 3 }]}>Customer</Text>
            <Text style={[styles.colNum, { flex: 0.6 }]}>Invoices</Text>
            <Text style={styles.colNum}>Revenue (ex-GST)</Text>
          </View>
          {e.customers.map((c: any, i: number) => (
            <View key={i} style={[styles.tableRow, i % 2 === 1 ? styles.tableRowAlt : {}]}>
              <Text style={[styles.col, { flex: 0.4, color: COLORS.ink3 }]}>{i + 1}</Text>
              <Text style={[styles.col, { flex: 3 }]}>{c.name}</Text>
              <Text style={[styles.colNum, { flex: 0.6 }]}>{c.invoiceCount}</Text>
              <Text style={styles.colNum}>{fmtFull(c.revenueExGst)}</Text>
            </View>
          ))}
        </View>
      ))}
    </View>
  )
}

function Aging({ data, title }: { data: any; title: string }) {
  const entities = data?.entities || []
  return (
    <View>
      {entities.map((e: any, idx: number) => (
        <View key={idx} style={{ marginBottom: 10 }} wrap={false}>
          <Text style={{ fontSize: 10, fontWeight: 700, marginBottom: 4, color: COLORS.ink2 }}>
            {e.entity} — {title} (total {fmtFull(e.total)})
          </Text>
          {/* Bucket bar */}
          <View style={{ flexDirection: 'row', marginBottom: 6, borderRadius: 3, overflow: 'hidden' }}>
            {e.total > 0 && (
              <>
                <BucketCell label="0-30d"   amount={e.buckets.current} total={e.total} color={COLORS.teal}/>
                <BucketCell label="31-60d"  amount={e.buckets.days30}  total={e.total} color={COLORS.accent}/>
                <BucketCell label="61-90d"  amount={e.buckets.days60}  total={e.total} color={COLORS.amber}/>
                <BucketCell label="91+d"    amount={e.buckets.days90}  total={e.total} color={COLORS.red}/>
              </>
            )}
          </View>
          {e.oldest.length > 0 && (
            <>
              <Text style={{ fontSize: 8, color: COLORS.ink3, marginBottom: 2 }}>Top 10 oldest</Text>
              <View style={styles.tableHeader}>
                <Text style={[styles.col, { flex: 2.5 }]}>Customer/Supplier</Text>
                <Text style={{ width: 50 }}>Invoice</Text>
                <Text style={{ width: 60 }}>Date</Text>
                <Text style={{ width: 30, textAlign: 'right' }}>Days</Text>
                <Text style={styles.colNum}>Balance</Text>
              </View>
              {e.oldest.map((o: any, i: number) => (
                <View key={i} style={[styles.tableRow, i % 2 === 1 ? styles.tableRowAlt : {}]}>
                  <Text style={[styles.col, { flex: 2.5 }]}>{o.customerOrSupplier}</Text>
                  <Text style={{ width: 50, color: COLORS.ink3 }}>{o.invoiceNumber}</Text>
                  <Text style={{ width: 60, color: COLORS.ink3 }}>{o.date ? fmtDate(o.date) : ''}</Text>
                  <Text style={{ width: 30, textAlign: 'right', color: o.daysOld > 90 ? COLORS.red : COLORS.ink }}>{o.daysOld}</Text>
                  <Text style={styles.colNum}>{fmtFull(o.balanceExGst)}</Text>
                </View>
              ))}
            </>
          )}
        </View>
      ))}
    </View>
  )
}

function BucketCell({ label, amount, total, color }: { label: string; amount: number; total: number; color: string }) {
  const pct = total > 0 ? Math.max((amount / total) * 100, 0) : 0
  if (pct === 0) return null
  return (
    <View style={{ width: `${pct}%`, backgroundColor: color, padding: 4, minWidth: 40 }}>
      <Text style={{ fontSize: 7, color: COLORS.bg, fontWeight: 700 }}>{label}</Text>
      <Text style={{ fontSize: 8, color: COLORS.bg, fontWeight: 700 }}>{fmt(amount)}</Text>
    </View>
  )
}

function StockSummary({ data }: { data: any }) {
  return (
    <View style={styles.kpiGrid} wrap={false}>
      <KpiBox label="Total stock value" value={fmt(data.totalValueExGst)} sub="Ex-GST, on hand"/>
      <KpiBox label="Total items" value={String(data.itemCount || 0)} sub="Inventoried"/>
      <KpiBox label="Below reorder" value={String(data.itemsBelowReorder || 0)} sub="Need attention" valueColor={data.itemsBelowReorder > 0 ? COLORS.red : COLORS.green}/>
    </View>
  )
}

function StockReorder({ data }: { data: any }) {
  const items = data?.items || []
  return (
    <View>
      <View style={styles.tableHeader}>
        <Text style={[styles.col, { flex: 3 }]}>Item</Text>
        <Text style={{ width: 80, color: COLORS.ink3 }}>SKU</Text>
        <Text style={{ width: 40, textAlign: 'right' }}>On hand</Text>
        <Text style={{ width: 40, textAlign: 'right' }}>Reorder</Text>
        <Text style={{ width: 40, textAlign: 'right' }}>Short</Text>
      </View>
      {items.slice(0, 20).map((r: any, i: number) => (
        <View key={i} style={[styles.tableRow, i % 2 === 1 ? styles.tableRowAlt : {}]}>
          <Text style={[styles.col, { flex: 3 }]}>{r.name}</Text>
          <Text style={{ width: 80, color: COLORS.ink3 }}>{r.sku}</Text>
          <Text style={{ width: 40, textAlign: 'right' }}>{r.onHand}</Text>
          <Text style={{ width: 40, textAlign: 'right' }}>{r.reorderLevel}</Text>
          <Text style={{ width: 40, textAlign: 'right', color: COLORS.red, fontWeight: 700 }}>{r.shortBy}</Text>
        </View>
      ))}
      {items.length > 20 && (
        <Text style={{ fontSize: 7.5, color: COLORS.ink3, marginTop: 4, fontStyle: 'italic' }}>
          Showing top 20 of {items.length} items below reorder level.
        </Text>
      )}
    </View>
  )
}

function StockDead({ data }: { data: any }) {
  const items = data?.items || []
  return (
    <View>
      <Text style={{ fontSize: 8.5, color: COLORS.ink3, marginBottom: 4 }}>
        Items with value held but no sales in 90+ days. Total held: {fmtFull(data.totalHeldValueExGst)}
      </Text>
      <View style={styles.tableHeader}>
        <Text style={[styles.col, { flex: 3 }]}>Item</Text>
        <Text style={{ width: 80, color: COLORS.ink3 }}>SKU</Text>
        <Text style={{ width: 40, textAlign: 'right' }}>On hand</Text>
        <Text style={styles.colNum}>Value held</Text>
      </View>
      {items.slice(0, 20).map((r: any, i: number) => (
        <View key={i} style={[styles.tableRow, i % 2 === 1 ? styles.tableRowAlt : {}]}>
          <Text style={[styles.col, { flex: 3 }]}>{r.name}</Text>
          <Text style={{ width: 80, color: COLORS.ink3 }}>{r.sku}</Text>
          <Text style={{ width: 40, textAlign: 'right' }}>{r.onHand}</Text>
          <Text style={styles.colNum}>{fmtFull(r.heldValueExGst)}</Text>
        </View>
      ))}
      {items.length > 20 && (
        <Text style={{ fontSize: 7.5, color: COLORS.ink3, marginTop: 4, fontStyle: 'italic' }}>
          Showing top 20 of {items.length} dead-stock items.
        </Text>
      )}
    </View>
  )
}

function DistributorRanking({ data }: { data: any }) {
  const dist = data?.distributors || []
  const totals = data?.totals || {}
  return (
    <View>
      <View style={styles.tableHeader}>
        <Text style={[styles.col, { flex: 0.4 }]}>#</Text>
        <Text style={[styles.col, { flex: 2.5 }]}>Distributor</Text>
        <Text style={styles.colNum}>Tuning</Text>
        <Text style={styles.colNum}>Parts</Text>
        <Text style={styles.colNum}>Oil</Text>
        <Text style={styles.colNum}>Total</Text>
        <Text style={{ width: 40, textAlign: 'right' }}>Invs</Text>
      </View>
      {dist.slice(0, 25).map((d: any, i: number) => (
        <View key={i} style={[styles.tableRow, i % 2 === 1 ? styles.tableRowAlt : {}]}>
          <Text style={[styles.col, { flex: 0.4, color: COLORS.ink3 }]}>{i + 1}</Text>
          <Text style={[styles.col, { flex: 2.5 }]}>{d.name}</Text>
          <Text style={styles.colNum}>{fmt(d.tuning)}</Text>
          <Text style={styles.colNum}>{fmt(d.parts)}</Text>
          <Text style={styles.colNum}>{fmt(d.oil)}</Text>
          <Text style={[styles.colNum, { fontWeight: 700 }]}>{fmt(d.total)}</Text>
          <Text style={{ width: 40, textAlign: 'right', color: COLORS.ink3 }}>{d.invoiceCount}</Text>
        </View>
      ))}
      <View style={styles.tableTotal}>
        <Text style={[styles.col, { flex: 0.4 }]}></Text>
        <Text style={[styles.col, { flex: 2.5, fontWeight: 700 }]}>Totals</Text>
        <Text style={styles.colNum}>{fmt(totals.tuning)}</Text>
        <Text style={styles.colNum}>{fmt(totals.parts)}</Text>
        <Text style={styles.colNum}>{fmt(totals.oil)}</Text>
        <Text style={[styles.colNum, { fontWeight: 700 }]}>{fmt(totals.total)}</Text>
        <Text style={{ width: 40 }}></Text>
      </View>
    </View>
  )
}

function Pipeline({ data }: { data: any }) {
  return (
    <View>
      <View style={styles.kpiGrid} wrap={false}>
        <KpiBox label="Open orders" value={String(data.openOrdersCount || 0)} sub={fmt(data.openOrdersValueExGst)}/>
        <KpiBox label="Owing on orders" value={fmt(data.openOrdersOwingExGst)} sub="Total balance"/>
        <KpiBox label="Converted 30d" value={String(data.convertedCount30d || 0)} sub={fmt(data.convertedValue30dExGst)}/>
        <KpiBox label="Open quotes" value={String(data.quotesCount || 0)} sub={fmt(data.quotesValueExGst)}/>
      </View>
      {data.topOpenOrders?.length > 0 && (
        <View wrap={false}>
          <Text style={{ fontSize: 9, fontWeight: 700, marginTop: 6, marginBottom: 3, color: COLORS.ink2 }}>Top open orders</Text>
          <View style={styles.tableHeader}>
            <Text style={{ width: 50 }}>Order</Text>
            <Text style={[styles.col, { flex: 2.5 }]}>Customer</Text>
            <Text style={{ width: 60 }}>Date</Text>
            <Text style={styles.colNum}>Value (ex-GST)</Text>
            <Text style={{ width: 50, textAlign: 'right' }}>Status</Text>
          </View>
          {data.topOpenOrders.map((o: any, i: number) => (
            <View key={i} style={[styles.tableRow, i % 2 === 1 ? styles.tableRowAlt : {}]}>
              <Text style={{ width: 50, color: COLORS.ink3 }}>{o.number}</Text>
              <Text style={[styles.col, { flex: 2.5 }]}>{o.customer}</Text>
              <Text style={{ width: 60, color: COLORS.ink3 }}>{fmtDate(o.date)}</Text>
              <Text style={styles.colNum}>{fmtFull(o.valueExGst)}</Text>
              <Text style={{ width: 50, textAlign: 'right', fontSize: 7, color: o.isPrepaid ? COLORS.green : COLORS.amber, fontWeight: 700 }}>
                {o.isPrepaid ? 'PREPAID' : 'OWING'}
              </Text>
            </View>
          ))}
        </View>
      )}
    </View>
  )
}

function TrendCharts({ data }: { data: any }) {
  const months: string[] = data?.months || []
  const entities: any[] = data?.entities || []
  if (months.length === 0 || entities.length === 0) return null

  const chartW = 520
  const chartH = 120
  const pad = { top: 8, right: 8, bottom: 22, left: 44 }
  const plotW = chartW - pad.left - pad.right
  const plotH = chartH - pad.top - pad.bottom

  // Find global max across all entities' income + expenses for Y-axis scaling
  let maxVal = 0
  for (const e of entities) {
    for (const v of [...e.income, ...e.expenses]) {
      if (v > maxVal) maxVal = v
    }
  }
  if (maxVal === 0) maxVal = 1

  const xStep = plotW / Math.max(months.length - 1, 1)
  const yFor = (v: number) => pad.top + plotH - (v / maxVal) * plotH

  return (
    <View>
      {entities.map((e: any, idx: number) => {
        const incomePts = e.income.map((v: number, i: number) => `${pad.left + xStep * i},${yFor(v)}`).join(' ')
        const expensePts = e.expenses.map((v: number, i: number) => `${pad.left + xStep * i},${yFor(v)}`).join(' ')
        return (
          <View key={idx} style={{ marginBottom: 8 }} wrap={false}>
            <Text style={{ fontSize: 10, fontWeight: 700, marginBottom: 4, color: COLORS.ink2 }}>{e.entity} — 6-month trend (ex-GST)</Text>
            <Svg width={chartW} height={chartH}>
              {/* Axes */}
              <Line x1={pad.left} y1={pad.top} x2={pad.left} y2={pad.top + plotH} stroke={COLORS.line} strokeWidth={0.5}/>
              <Line x1={pad.left} y1={pad.top + plotH} x2={pad.left + plotW} y2={pad.top + plotH} stroke={COLORS.line} strokeWidth={0.5}/>
              {/* Gridlines + Y labels */}
              {[0, 0.5, 1].map((f, i) => (
                <G key={i}>
                  <Line x1={pad.left} y1={pad.top + plotH * (1 - f)} x2={pad.left + plotW} y2={pad.top + plotH * (1 - f)} stroke={COLORS.line2} strokeWidth={0.3}/>
                  <Text x={pad.left - 4} y={pad.top + plotH * (1 - f) + 2} style={{ fontSize: 6, fill: COLORS.ink3 }} {...({ textAnchor: 'end' } as any)}>{fmt(maxVal * f)}</Text>
                </G>
              ))}
              {/* X labels */}
              {months.map((m: string, i: number) => (
                <Text key={i} x={pad.left + xStep * i} y={pad.top + plotH + 12} style={{ fontSize: 6, fill: COLORS.ink3 }} {...({ textAnchor: 'middle' } as any)}>{m}</Text>
              ))}
              {/* Income line */}
              <Polyline points={incomePts} fill="none" stroke={COLORS.green} strokeWidth={1.2}/>
              {/* Expense line */}
              <Polyline points={expensePts} fill="none" stroke={COLORS.red} strokeWidth={1.2} strokeDasharray="3,2"/>
            </Svg>
            <View style={{ flexDirection: 'row', gap: 12, marginTop: 2, marginLeft: pad.left }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
                <View style={{ width: 8, height: 2, backgroundColor: COLORS.green }}/>
                <Text style={{ fontSize: 7, color: COLORS.ink3 }}>Income</Text>
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
                <View style={{ width: 8, height: 2, backgroundColor: COLORS.red }}/>
                <Text style={{ fontSize: 7, color: COLORS.ink3 }}>Expenses</Text>
              </View>
            </View>
          </View>
        )
      })}
    </View>
  )
}

// ── Section router ─────────────────────────────────────────────────────
function RenderSection({ section }: { section: GeneratedSection }) {
  if (!section || !section.data || section.data.error) {
    return (
      <View style={{ marginBottom: 10 }}>
        <Text style={styles.sectionHeading}>{section.label}</Text>
        <Text style={{ fontSize: 8.5, color: COLORS.red }}>Data unavailable: {section.data?.error || 'unknown error'}</Text>
      </View>
    )
  }
  return (
    <View style={{ marginBottom: 12 }}>
      <Text style={styles.sectionHeading}>{section.label}</Text>
      {(() => {
        switch (section.id) {
          case 'kpi-summary':         return <KpiSummary data={section.data}/>
          case 'pnl-summary':         return <PnlSummary data={section.data}/>
          case 'top-customers':       return <TopCustomers data={section.data}/>
          case 'receivables-aging':   return <Aging data={section.data} title="Receivables"/>
          case 'payables-aging':      return <Aging data={section.data} title="Payables"/>
          case 'stock-summary':       return <StockSummary data={section.data}/>
          case 'stock-reorder':       return <StockReorder data={section.data}/>
          case 'stock-dead':          return <StockDead data={section.data}/>
          case 'distributor-ranking': return <DistributorRanking data={section.data}/>
          case 'pipeline':            return <Pipeline data={section.data}/>
          case 'trend-charts':        return <TrendCharts data={section.data}/>
          default:                    return null
        }
      })()}
      {section.narrativeBeats && section.narrativeBeats.length > 0 && (
        <BulletList bullets={section.narrativeBeats}/>
      )}
    </View>
  )
}

// ── Top-level document ─────────────────────────────────────────────────

function ReportDoc({ report }: { report: GeneratedReport }) {
  return (
    <Document>
      <Page size="A4" style={styles.page}>
        {/* Cover header */}
        <View style={styles.coverHeader}>
          <Text style={styles.coverTitle}>{report.title}</Text>
          <Text style={styles.coverSubtitle}>
            Just Autos · {report.entities.join(' + ')} · {fmtPeriod(report.periodStart, report.periodEnd)}
          </Text>
          <Text style={[styles.coverSubtitle, { marginTop: 2, fontSize: 8, color: COLORS.ink3 }]}>
            Generated {fmtDate(report.generatedAt)} · All amounts ex-GST
          </Text>
        </View>

        {/* Overall AI narrative first — reader gets the story upfront */}
        {report.narrative && (
          <View style={styles.aiBox} wrap={false}>
            <Text style={styles.aiLabel}>AI Commentary</Text>
            {report.narrative.split(/\n\n+/).map((para, i) => (
              <Text key={i} style={[styles.paragraph, { marginBottom: 5 }]}>{para.trim()}</Text>
            ))}
          </View>
        )}

        {/* Data sections */}
        {report.sections.map((s) => <RenderSection key={s.id} section={s}/>)}

        {/* Footer */}
        <Text style={styles.footer} render={({ pageNumber, totalPages }) => `${report.title} — ${report.entities.join('+')} — Page ${pageNumber} of ${totalPages}`} fixed/>
      </Page>
    </Document>
  )
}

export async function renderReportPdf(report: GeneratedReport): Promise<Buffer> {
  const doc = <ReportDoc report={report}/>
  const instance = pdf(doc)
  const blob = await instance.toBlob()
  const arrayBuffer = await blob.arrayBuffer()
  return Buffer.from(arrayBuffer)
}
