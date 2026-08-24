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
import { stockPosition } from './jaws-stock-eom'
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
const growth = (n: number | null | undefined) => n == null ? '—' : `${Number(n) >= 0 ? '+' : ''}${(Number(n) * 100).toFixed(0)}%`
const shortMonth = (m: string) => {
  const [y, mm] = String(m).split('-').map(Number)
  if (!y || !mm) return String(m)
  return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][mm - 1]} ${String(y).slice(2)}`
}

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
            Just Autos Wholesale · month-end report · stock on hand as at {rep.generatedAt.slice(0, 10)} · all amounts ex-GST
            {rep.history ? ` · sales history ${rep.history.from} to ${rep.history.to}` : ''}
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

          {rep.history ? (
            <>
              <Stat label="Average sales / month" value={money(rep.history.avgRevenuePerMonth)} sub={`${qty(rep.history.avgUnitsPerMonth)} units/mo over ${rep.history.months} months`} />
              <Stat
                label="Growth over the window"
                value={growth(rep.history.growthPct)}
                sub={rep.history.firstHalfLabel ? `${rep.history.secondHalfLabel} vs ${rep.history.firstHalfLabel}` : 'needs 4+ months'}
                color={rep.history.growthPct == null ? undefined : rep.history.growthPct >= 0 ? C.green : C.red}
              />
            </>
          ) : null}
        </View>

        <Text style={s.hint}>
          Never sold: {money(h.neverSoldValue)} across {h.neverSoldCount} SKUs — excluded from the ageing, dead-stock and
          slow-mover figures above, as on this item list it is almost always a kit component never sold separately.
        </Text>

        {rep.history ? (
          <Table
            title="Sales by month — the history window"
            hint={`Every average, months-of-cover and growth figure on this report is measured over these ${rep.history.months} months (${rep.history.from} to ${rep.history.to}).`}
            cols={[{ label: 'Month', width: '25%' }, { label: 'Units', width: '18%', right: true }, { label: 'Revenue ex', width: '22%', right: true }, { label: 'Share of window', width: '18%', right: true }, { label: 'vs prev month', width: '17%', right: true }]}
            rows={rep.history.series.map((m, i, arr) => {
              const before = i > 0 ? arr[i - 1].revenueEx : null
              const chg = before && before !== 0 ? (m.revenueEx - before) / before : null
              return [
                m.month, qty(m.units), money(m.revenueEx),
                rep.history.revenueExTotal > 0 ? pct(m.revenueEx / rep.history.revenueExTotal) : '—',
                chg == null ? '—' : `${chg >= 0 ? '+' : ''}${(chg * 100).toFixed(1)}%`,
              ]
            })}
          />
        ) : null}

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
            { label: 'SKU', width: '17%' }, { label: 'Name', width: '21%' },
            { label: 'Capital at risk', width: '12%', right: true }, { label: 'Value held', width: '11%', right: true },
            { label: 'On hand', width: '8%', right: true }, { label: 'Avg/mo', width: '7%', right: true },
            { label: 'Cover (mo)', width: '10%', right: true }, { label: 'Growth', width: '7%', right: true },
            { label: 'Last sold', width: '7%', right: true },
          ]}
          rows={rep.slowMovers.map(i => [
            i.sku.slice(0, 18), name(i, 22), money(i.capitalAtRisk), money(i.stockValue),
            qty(i.onHand), qty(i.avgUnitsPerMonth),
            i.monthsCoverAtAvg == null ? '—' : i.monthsCoverAtAvg.toFixed(1),
            growth(i.growthPct), i.lastSold || '—',
          ])}
        />

        {rep.stockPositionList?.length ? (
          <Table
            title={`Stock position — ${stockPosition(rep.stockPositionList[0]).months.length} months of sales vs what is on the shelf`}
            hint={`Units invoiced each month against stock on hand as at ${rep.generatedAt.slice(0, 10)}. Over 6 months of cover reads as overstocked, under 1 month as short. Anything to act on is listed first.`}
            cols={[
              { label: 'SKU', width: '22%' },
              ...stockPosition(rep.stockPositionList[0]).months.map(m => ({ label: shortMonth(m), width: '7%', right: true })),
              { label: 'On hand', width: '9%', right: true }, { label: 'Avg/mo', width: '9%', right: true },
              { label: 'Cover (mo)', width: '9%', right: true }, { label: 'Position', width: '11%' },
            ]}
            rows={rep.stockPositionList.slice(0, 16).map(i => {
              const pos = stockPosition(i)
              return [
                i.sku.slice(0, 22),
                ...pos.units.map(u => (u ? qty(u) : '–')),
                qty(i.onHand), qty(pos.avg),
                pos.cover == null ? '—' : pos.cover.toFixed(1),
                pos.position,
              ]
            })}
          />
        ) : null}

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
            { label: 'SKU', width: '18%' }, { label: 'Name', width: '24%' },
            { label: 'On hand', width: '9%', right: true }, { label: 'Units', width: '9%', right: true },
            { label: 'Prev', width: '8%', right: true }, { label: 'Avg/mo', width: '9%', right: true },
            { label: 'Growth', width: '8%', right: true }, { label: 'Revenue ex', width: '15%', right: true },
          ]}
          rows={rep.topByUnits.slice(0, 15).map(i => [i.sku.slice(0, 20), name(i, 26), qty(i.onHand), qty(i.monthUnits), qty(i.prevMonthUnits), qty(i.avgUnitsPerMonth), growth(i.growthPct), money(i.monthRevenueEx)])}
        />

        <Table
          title="Biggest margin earners this month"
          hint="Margin dollars, not revenue — usually a different list, and the one that pays the wages."
          cols={[
            { label: 'SKU', width: '20%' }, { label: 'Name', width: '28%' },
            { label: 'On hand', width: '11%', right: true },
            { label: 'Margin $', width: '15%', right: true }, { label: 'Margin %', width: '13%', right: true },
            { label: 'Units', width: '13%', right: true },
          ]}
          rows={rep.topByMargin.slice(0, 15).map(i => [i.sku.slice(0, 22), name(i, 28), qty(i.onHand), money(i.monthMargin), pct(i.marginPct), qty(i.monthUnits)])}
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
            { label: 'SKU', width: '20%' }, { label: 'Name', width: '28%' },
            { label: 'On hand', width: '10%', right: true }, { label: 'Units sold', width: '11%', right: true },
            { label: 'Available', width: '10%', right: true }, { label: 'Committed', width: '11%', right: true },
            { label: 'On order', width: '10%', right: true },
          ]}
          rows={rep.unfilledDemand.map(i => [i.sku.slice(0, 22), name(i, 28), qty(i.onHand), qty(i.monthUnits), qty(i.available), qty(i.committed), qty(i.onOrder)])}
        />

        <Table
          title="Sold below cost this month"
          cols={[
            { label: 'SKU', width: '20%' }, { label: 'Name', width: '28%' },
            { label: 'On hand', width: '12%', right: true },
            { label: 'Sell ex', width: '14%', right: true }, { label: 'Avg cost', width: '14%', right: true },
            { label: 'Units', width: '12%', right: true },
          ]}
          rows={rep.belowCost.map(i => [i.sku.slice(0, 22), name(i, 28), qty(i.onHand), money(i.sellEx), money(i.avgCost), qty(i.monthUnits)])}
        />

        <Table
          title="Cost creep — buy price up, sell price unchanged"
          hint="Last price paid more than 10% above the average cost. A price-review list."
          cols={[
            { label: 'SKU', width: '20%' }, { label: 'Name', width: '28%' },
            { label: 'On hand', width: '12%', right: true },
            { label: 'Avg cost', width: '14%', right: true }, { label: 'Last paid', width: '14%', right: true },
            { label: 'Margin now', width: '12%', right: true },
          ]}
          rows={rep.costCreep.map(i => [i.sku.slice(0, 22), name(i, 28), qty(i.onHand), money(i.avgCost), money(i.lastPurchasePrice), pct(i.marginPct)])}
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
