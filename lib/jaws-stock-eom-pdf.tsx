// lib/jaws-stock-eom-pdf.tsx
// SERVER-ONLY PDF renderer for the JAWS month-end stock report.
// Takes the EomReport the portal screen and the email already share, and
// prints the whole thing — headline figures, ageing, every exception list and
// the report's own notes — as an A4 document that can be filed or handed to
// an accountant.
//
// House style follows lib/reports/pdf.tsx and lib/calls-weekly-report-pdf.tsx:
// A4 portrait, Helvetica, muted corporate palette, tables that repeat their
// header when they break across a page.

import React from 'react'
import { Document, Page, Text, View, StyleSheet, pdf } from '@react-pdf/renderer'
import type { EomReport, EomItem } from './jaws-stock-eom'

const C = {
  ink: '#1a1d23', ink2: '#3a3f4a', ink3: '#6b7280',
  line: '#d1d5db', line2: '#e5e7eb', bg2: '#f9fafb', bg3: '#f3f4f6',
  accent: '#2563eb', green: '#059669', red: '#dc2626', amber: '#d97706',
}

const s = StyleSheet.create({
  page: { paddingTop: 34, paddingBottom: 44, paddingHorizontal: 34, fontFamily: 'Helvetica', fontSize: 9, color: C.ink },
  header: { marginBottom: 14, paddingBottom: 10, borderBottom: `1pt solid ${C.line}` },
  title: { fontSize: 19, fontWeight: 700, marginBottom: 3 },
  subtitle: { fontSize: 9.5, color: C.ink3 },

  statGrid: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 6 },
  stat: { width: '25%', marginBottom: 11, paddingRight: 8 },
  statLabel: { fontSize: 7, color: C.ink3, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 2 },
  statValue: { fontSize: 13.5, fontWeight: 700 },
  statSub: { fontSize: 7.5, color: C.ink3, marginTop: 1.5 },

  h2: { fontSize: 11.5, fontWeight: 700, marginTop: 13, marginBottom: 3 },
  hint: { fontSize: 7.5, color: C.ink3, marginBottom: 5, lineHeight: 1.4 },

  tableHeader: {
    flexDirection: 'row', backgroundColor: C.bg3, paddingVertical: 3.5, paddingHorizontal: 5,
    fontSize: 7.5, fontWeight: 700, color: C.ink2, borderBottom: `0.5pt solid ${C.line}`,
  },
  tableRow: {
    flexDirection: 'row', paddingVertical: 3, paddingHorizontal: 5,
    fontSize: 8, borderBottom: `0.5pt solid ${C.line2}`,
  },
  empty: { fontSize: 8.5, color: C.ink3, fontStyle: 'italic', marginBottom: 4 },

  notesBox: { marginTop: 16, paddingTop: 9, borderTop: `0.5pt solid ${C.line}` },
  note: { fontSize: 7.5, color: C.ink3, lineHeight: 1.45, marginBottom: 3 },
  footer: { position: 'absolute', bottom: 22, left: 34, right: 34, fontSize: 7, color: C.ink3, textAlign: 'center' },
})

const money = (n: number | null | undefined) =>
  n == null || !isFinite(Number(n)) ? '—' : '$' + Math.round(Number(n)).toLocaleString('en-AU')
const pct = (n: number | null | undefined) => n == null ? '—' : `${(Number(n) * 100).toFixed(1)}%`
const qty = (n: number | null | undefined) => n == null ? '—' : String(Math.round(Number(n) * 100) / 100)

interface Col { label: string; width: string; right?: boolean }

// One table. Rows are pre-formatted strings, so every caller decides its own
// number formatting. The header repeats on page breaks (`fixed`) and rows are
// kept whole (`wrap={false}`) so a row never splits across pages.
function Table({ title, hint, cols, rows }: { title: string; hint?: string; cols: Col[]; rows: (string | number)[][] }) {
  return (
    <View>
      <Text style={s.h2}>{title}</Text>
      {hint ? <Text style={s.hint}>{hint}</Text> : null}
      {rows.length === 0 ? <Text style={s.empty}>Nothing to report.</Text> : (
        <View>
          <View style={s.tableHeader} fixed>
            {cols.map((c, i) => (
              <Text key={i} style={{ width: c.width, textAlign: c.right ? 'right' : 'left' }}>{c.label}</Text>
            ))}
          </View>
          {rows.map((r, ri) => (
            <View key={ri} style={s.tableRow} wrap={false}>
              {r.map((cell, ci) => (
                <Text key={ci} style={{ width: cols[ci].width, textAlign: cols[ci].right ? 'right' : 'left', color: ci === 0 ? C.ink : C.ink2 }}>
                  {String(cell)}
                </Text>
              ))}
            </View>
          ))}
        </View>
      )}
    </View>
  )
}

function Stat({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <View style={s.stat}>
      <Text style={s.statLabel}>{label}</Text>
      <Text style={[s.statValue, color ? { color } : {}]}>{value}</Text>
      {sub ? <Text style={s.statSub}>{sub}</Text> : null}
    </View>
  )
}

const name = (i: EomItem, n = 30) => i.name.slice(0, n)

function StockEomDoc({ rep }: { rep: EomReport }) {
  const h = rep.headline
  const prev = rep.trend.filter(t => t.month < rep.month).slice(-1)[0]
  const delta = (now: number, before: number | null | undefined) => {
    if (before == null || before === 0) return undefined
    const p = ((now - before) / Math.abs(before)) * 100
    return `${p >= 0 ? '+' : ''}${p.toFixed(1)}% vs ${prev?.month || 'last month'}`
  }

  return (
    <Document>
      <Page size="A4" style={s.page}>
        <View style={s.header}>
          <Text style={s.title}>JAWS Stock — {rep.monthLabel}</Text>
          <Text style={s.subtitle}>
            Just Autos Wholesale · month-end report · stock read {rep.generatedAt.slice(0, 10)} · all amounts ex-GST
          </Text>
        </View>

        <View style={s.statGrid}>
          <Stat label="Stock on hand" value={money(h.stockValue)} sub={`${qty(h.qtyOnHand)} units · ${h.skus} SKUs`} />
          <Stat label="Sales this month" value={money(h.monthRevenueEx)} sub={delta(h.monthRevenueEx, prev?.monthRevenueEx) || `${qty(h.monthUnits)} units`} />
          <Stat label="Gross margin" value={money(h.monthMargin)} sub={`${pct(h.monthMarginPct)} of sales`} />
          <Stat label="Stock turn (12m)" value={h.turnsAnnualised == null ? '—' : `${h.turnsAnnualised.toFixed(2)}x`} sub={h.daysInventory ? `${h.daysInventory} days of inventory` : undefined} />

          <Stat label="Dead stock (90d)" value={money(h.dead90Value)} sub={`${h.dead90Count} SKUs · ${money(h.dead180Value)} at 180d`} color={h.dead90Value > 0 ? C.amber : undefined} />
          <Stat label="Slow movers — capital at risk" value={money(h.slowCapital)} sub={`${h.slowCount} SKUs past 90 days of demand`} color={h.slowCapital > 0 ? C.amber : undefined} />
          <Stat label="Overstock (>1yr cover)" value={money(h.overstockValue)} sub={`${h.overstockCount} SKUs`} color={h.overstockValue > 0 ? C.amber : undefined} />
          <Stat label="Reorder suggested" value={money(h.reorderCost)} sub={`${h.reorderCount} SKUs · ${h.outOfStockCount} out, ${h.lowStockCount} low`} />
        </View>

        <Text style={s.hint}>
          Never sold: {money(h.neverSoldValue)} across {h.neverSoldCount} SKUs — excluded from the ageing, dead-stock and
          slow-mover figures above, as on this item list it is almost always a kit component never sold separately.
        </Text>

        <Table
          title="Where the money is sitting"
          hint={`Held value by how recently that SKU last sold, over the ${money(h.analysedValue)} that has sold at least once. Shares are of that analysed value.`}
          cols={[{ label: 'Last sold', width: '40%' }, { label: 'SKUs', width: '15%', right: true }, { label: 'Value held', width: '25%', right: true }, { label: 'Share', width: '20%', right: true }]}
          rows={rep.ageing.map(a => [a.bucket, a.skus, money(a.value), h.analysedValue > 0 ? pct(a.value / h.analysedValue) : '—'])}
        />

        <Table
          title="Slow movers — where the capital is stuck"
          hint={"Listed when nothing sold in the 90 days to month end, or it still sells but holds over 180 days of cover with $2,000+ tied up past a 90-day target. Ranked by capital at risk: value held beyond 90 days of that SKU's own demand."}
          cols={[
            { label: 'SKU', width: '18%' }, { label: 'Name', width: '26%' },
            { label: 'Capital at risk', width: '13%', right: true }, { label: 'Value held', width: '12%', right: true },
            { label: 'Cover', width: '9%', right: true }, { label: 'Last sold', width: '12%', right: true },
            { label: 'Sold since', width: '10%', right: true },
          ]}
          rows={rep.slowMovers.map(i => [
            i.sku.slice(0, 20), name(i, 26), money(i.capitalAtRisk), money(i.stockValue),
            i.daysOfCover == null ? 'dead' : String(Math.round(i.daysOfCover)),
            i.lastSold || '—', i.unitsSinceMonthEnd ? qty(i.unitsSinceMonthEnd) : '—',
          ])}
        />

        <Table
          title={`Reorder suggestions — Stock Order sheet only (${h.reorderSheetSize} SKUs)`}
          hint={`Flagged when below the MYOB alert level, or under 60 days cover on something that moves. Quantity targets 90 days and respects MOQ.${h.reorderExcludedCount ? ` ${h.reorderExcludedCount} off-sheet item(s) sat below their alert level and were excluded — add a SKU to the sheet if it should be ordered.` : ''}`}
          cols={[
            { label: 'SKU', width: '18%' }, { label: 'Name', width: '24%' },
            { label: 'On hand', width: '9%', right: true }, { label: 'On order', width: '9%', right: true },
            { label: 'Cover', width: '8%', right: true }, { label: 'Order qty', width: '9%', right: true },
            { label: 'Est. cost', width: '11%', right: true }, { label: 'Why', width: '12%' },
          ]}
          rows={rep.reorder.map(i => [
            i.sku.slice(0, 20), name(i, 24), qty(i.onHand), qty(i.onOrder),
            i.daysOfCover == null ? '—' : String(Math.round(i.daysOfCover)),
            qty(i.suggestQty), money(i.suggestCost), i.reason,
          ])}
        />

        <Table
          title="Top movers this month — by units"
          cols={[
            { label: 'SKU', width: '20%' }, { label: 'Name', width: '30%' },
            { label: 'Units', width: '10%', right: true }, { label: 'Prev', width: '10%', right: true },
            { label: 'Revenue ex', width: '16%', right: true }, { label: 'Margin %', width: '14%', right: true },
          ]}
          rows={rep.topByUnits.slice(0, 15).map(i => [i.sku.slice(0, 22), name(i), qty(i.monthUnits), qty(i.prevMonthUnits), money(i.monthRevenueEx), pct(i.marginPct)])}
        />

        <Table
          title="Biggest margin earners this month"
          hint="Margin dollars, not revenue — usually a different list, and the one that pays the wages."
          cols={[
            { label: 'SKU', width: '20%' }, { label: 'Name', width: '34%' },
            { label: 'Margin $', width: '16%', right: true }, { label: 'Margin %', width: '15%', right: true },
            { label: 'Units', width: '15%', right: true },
          ]}
          rows={rep.topByMargin.slice(0, 15).map(i => [i.sku.slice(0, 22), name(i, 34), money(i.monthMargin), pct(i.marginPct), qty(i.monthUnits)])}
        />

        <Table
          title="Overstock — more than a year of cover"
          cols={[
            { label: 'SKU', width: '20%' }, { label: 'Name', width: '30%' },
            { label: 'Value held', width: '16%', right: true }, { label: 'On hand', width: '12%', right: true },
            { label: 'Cover (days)', width: '22%', right: true },
          ]}
          rows={rep.overstock.map(i => [i.sku.slice(0, 22), name(i), money(i.stockValue), qty(i.onHand), i.daysOfCover == null ? '—' : String(Math.round(i.daysOfCover))])}
        />

        <Table
          title="Sold while out of stock"
          hint="Sold this month but nothing available, or committed beyond what's on hand — demand you couldn't fill on the spot."
          cols={[
            { label: 'SKU', width: '20%' }, { label: 'Name', width: '32%' },
            { label: 'Units sold', width: '12%', right: true }, { label: 'Available', width: '12%', right: true },
            { label: 'Committed', width: '12%', right: true }, { label: 'On order', width: '12%', right: true },
          ]}
          rows={rep.unfilledDemand.map(i => [i.sku.slice(0, 22), name(i, 32), qty(i.monthUnits), qty(i.available), qty(i.committed), qty(i.onOrder)])}
        />

        <Table
          title="Sold below cost this month"
          cols={[
            { label: 'SKU', width: '20%' }, { label: 'Name', width: '32%' },
            { label: 'Sell ex', width: '16%', right: true }, { label: 'Avg cost', width: '16%', right: true },
            { label: 'Units', width: '16%', right: true },
          ]}
          rows={rep.belowCost.map(i => [i.sku.slice(0, 22), name(i, 32), money(i.sellEx), money(i.avgCost), qty(i.monthUnits)])}
        />

        <Table
          title="Cost creep — buy price up, sell price unchanged"
          hint="Last price paid more than 10% above the average cost. A price-review list."
          cols={[
            { label: 'SKU', width: '20%' }, { label: 'Name', width: '32%' },
            { label: 'Avg cost', width: '16%', right: true }, { label: 'Last paid', width: '16%', right: true },
            { label: 'Margin now', width: '16%', right: true },
          ]}
          rows={rep.costCreep.map(i => [i.sku.slice(0, 22), name(i, 32), money(i.avgCost), money(i.lastPurchasePrice), pct(i.marginPct)])}
        />

        <Table
          title="Value and spend by supplier"
          cols={[
            { label: 'Supplier', width: '40%' }, { label: 'SKUs', width: '12%', right: true },
            { label: 'Stock value', width: '18%', right: true }, { label: 'Sales this month', width: '16%', right: true },
            { label: 'To reorder', width: '14%', right: true },
          ]}
          rows={rep.suppliers.map(x => [x.supplier.slice(0, 44), x.skus, money(x.stockValue), money(x.monthRevenueEx), money(x.reorderCost)])}
        />

        <Table
          title="Data to fix in MYOB"
          cols={[{ label: 'SKU', width: '20%' }, { label: 'Name', width: '32%' }, { label: 'Issue', width: '24%' }, { label: 'Detail', width: '24%' }]}
          rows={rep.integrity.map(x => [x.sku.slice(0, 22), x.name.slice(0, 32), x.issue, x.detail])}
        />

        {rep.stocktake ? (
          <Text style={[s.hint, { marginTop: 12 }]}>
            Stocktake this month: {rep.stocktake.count} completed (latest {rep.stocktake.latest}) — {rep.stocktake.matched} matched,
            {' '}{rep.stocktake.unmatched} unmatched. Report-only; nothing was written back to MYOB.
          </Text>
        ) : null}

        <View style={s.notesBox}>
          <Text style={[s.statLabel, { marginBottom: 4 }]}>How to read this</Text>
          {rep.notes.map((n, i) => <Text key={i} style={s.note}>• {n}</Text>)}
        </View>

        <Text
          style={s.footer}
          render={({ pageNumber, totalPages }) => `JAWS Stock — ${rep.monthLabel} · generated by the Just Autos portal · Page ${pageNumber} of ${totalPages}`}
          fixed
        />
      </Page>
    </Document>
  )
}

export async function renderStockEomPdf(rep: EomReport): Promise<Buffer> {
  const blob = await pdf(<StockEomDoc rep={rep} />).toBlob()
  return Buffer.from(await blob.arrayBuffer())
}

/** `jaws-stock-2026-07.pdf` — sorts chronologically in a folder. */
export function stockEomPdfFilename(rep: EomReport): string {
  return `jaws-stock-${rep.month}.pdf`
}
