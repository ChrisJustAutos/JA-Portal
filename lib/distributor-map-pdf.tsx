// lib/distributor-map-pdf.tsx
// SERVER-ONLY PDF renderer for Reports → Distributor Map.
//
// The screen answers "is this distributor booking the work we're quoting in
// their area?" one month at a time. This prints the same comparison for every
// month of the FY at once, per distributor, so the year can be filed or taken
// into a distributor conversation.
//
// House style follows lib/jaws-stock-eom-pdf.tsx: A4, Helvetica, muted
// corporate palette, table headers that repeat on page breaks.
//
// The two sides of every row come from DIFFERENT systems and are matched by
// geography, not by record:
//   · quotes  — workshop-map geocoded quotes falling within radiusKm of the
//               distributor, i.e. demand near them, whoever ends up doing it
//   · bookings — Monday "Distributor - Booking" board, confirmed group
// So a low capture rate means quotes in their area that they did not book —
// it does NOT mean a specific quote was lost by them.

import React from 'react'
import { Document, Page, Text, View, StyleSheet, pdf } from '@react-pdf/renderer'

const C = {
  ink: '#1a1d23', ink2: '#3a3f4a', ink3: '#6b7280',
  line: '#d1d5db', line2: '#e5e7eb', bg2: '#f9fafb', bg3: '#f3f4f6',
  accent: '#2563eb', green: '#059669', amber: '#d97706', red: '#dc2626',
}

const s = StyleSheet.create({
  page: { paddingTop: 34, paddingBottom: 44, paddingHorizontal: 30, fontFamily: 'Helvetica', fontSize: 9, color: C.ink },
  header: { marginBottom: 14, paddingBottom: 10, borderBottom: `1pt solid ${C.line}` },
  title: { fontSize: 19, fontWeight: 700, marginBottom: 3 },
  subtitle: { fontSize: 9.5, color: C.ink3 },
  scope: { fontSize: 8, color: C.ink3, marginTop: 4 },

  statGrid: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 6 },
  stat: { width: '25%', marginBottom: 11, paddingRight: 8 },
  statLabel: { fontSize: 7, color: C.ink3, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 2 },
  statValue: { fontSize: 13.5, fontWeight: 700 },
  statSub: { fontSize: 7.5, color: C.ink3, marginTop: 1.5 },

  h2: { fontSize: 11.5, fontWeight: 700, marginTop: 13, marginBottom: 3 },
  h3: { fontSize: 9.5, fontWeight: 700, marginTop: 10, marginBottom: 2 },
  hint: { fontSize: 7.5, color: C.ink3, marginBottom: 5, lineHeight: 1.4 },

  tableHeader: {
    flexDirection: 'row', backgroundColor: C.bg3, paddingVertical: 3.5, paddingHorizontal: 5,
    fontSize: 7.5, fontWeight: 700, color: C.ink2, borderBottom: `0.5pt solid ${C.line}`,
  },
  tableRow: {
    flexDirection: 'row', paddingVertical: 3, paddingHorizontal: 5,
    fontSize: 8, borderBottom: `0.5pt solid ${C.line2}`,
  },
  totalRow: {
    flexDirection: 'row', paddingVertical: 4, paddingHorizontal: 5,
    fontSize: 8.5, fontWeight: 700, borderTop: `1pt solid ${C.ink}`,
  },
  empty: { fontSize: 8.5, color: C.ink3, fontStyle: 'italic', marginBottom: 4 },
  notesBox: { marginTop: 16, paddingTop: 9, borderTop: `0.5pt solid ${C.line}` },
  note: { fontSize: 7.5, color: C.ink3, lineHeight: 1.45, marginBottom: 3 },
  footer: { position: 'absolute', bottom: 22, left: 30, right: 30, fontSize: 7, color: C.ink3, textAlign: 'center' },
})

export interface PdfMonthCell { quotes: number; quotesValue: number; bookings: number; bookingsValue: number }
export interface PdfEntity {
  key: string; name: string
  lat: number | null; lng: number | null; suburb: string | null
  monthly: PdfMonthCell[]; totals: PdfMonthCell
}
export interface DistributorMapPdfData {
  fy: number
  radiusKm: number
  months: { k: string; label: string }[]
  entities: PdfEntity[]
  quotesSyncedAt?: string | null
}

const money = (n: number | null | undefined) =>
  n == null || !isFinite(Number(n)) ? '—' : '$' + Math.round(Number(n)).toLocaleString('en-AU')
const compact = (n: number) =>
  !n ? '·' : n >= 1e6 ? '$' + (n / 1e6).toFixed(1) + 'M' : n >= 1000 ? '$' + Math.round(n / 1000) + 'k' : '$' + Math.round(n)
const num = (n: number | null | undefined) => n == null ? '—' : Math.round(Number(n)).toLocaleString('en-AU')
const capture = (bookings: number, quotes: number) => quotes > 0 ? `${(bookings / quotes * 100).toFixed(0)}%` : '—'

interface Col { label: string; width: string; right?: boolean }

function Table({ title, hint, cols, rows, total, size }: {
  title?: string; hint?: string; cols: Col[]; rows: (string | number)[][]; total?: (string | number)[]; size?: number
}) {
  const fs = size || 8
  return (
    <View>
      {title ? <Text style={s.h2}>{title}</Text> : null}
      {hint ? <Text style={s.hint}>{hint}</Text> : null}
      {rows.length === 0 ? <Text style={s.empty}>Nothing to report.</Text> : (
        <View>
          <View style={{ ...s.tableHeader, fontSize: Math.min(fs - 0.5, 7.5) }} fixed>
            {cols.map((c, i) => <Text key={i} style={{ width: c.width, textAlign: c.right ? 'right' : 'left' }}>{c.label}</Text>)}
          </View>
          {rows.map((r, ri) => (
            <View key={ri} style={{ ...s.tableRow, fontSize: fs }} wrap={false}>
              {r.map((cell, ci) => (
                <Text key={ci} style={{ width: cols[ci].width, textAlign: cols[ci].right ? 'right' : 'left', color: ci === 0 ? C.ink : C.ink2 }}>
                  {String(cell)}
                </Text>
              ))}
            </View>
          ))}
          {total ? (
            <View style={{ ...s.totalRow, fontSize: fs + 0.5 }} wrap={false}>
              {total.map((cell, ci) => (
                <Text key={ci} style={{ width: cols[ci].width, textAlign: cols[ci].right ? 'right' : 'left' }}>{String(cell)}</Text>
              ))}
            </View>
          ) : null}
        </View>
      )}
    </View>
  )
}

function DistributorMapDoc({ D }: { D: DistributorMapPdfData }) {
  const M = D.months.length || 12
  const zeros = () => Array(M).fill(0) as number[]

  // FY totals across every distributor.
  const all = D.entities.reduce((acc, e) => ({
    quotes: acc.quotes + e.totals.quotes,
    quotesValue: acc.quotesValue + e.totals.quotesValue,
    bookings: acc.bookings + e.totals.bookings,
    bookingsValue: acc.bookingsValue + e.totals.bookingsValue,
  }), { quotes: 0, quotesValue: 0, bookings: 0, bookingsValue: 0 })

  // Combined month-by-month.
  const mq = zeros(), mqv = zeros(), mb = zeros(), mbv = zeros()
  for (const e of D.entities) {
    for (let i = 0; i < M; i++) {
      const c = e.monthly[i]
      if (!c) continue
      mq[i] += c.quotes; mqv[i] += c.quotesValue
      mb[i] += c.bookings; mbv[i] += c.bookingsValue
    }
  }

  const ranked = D.entities.slice().sort((a, b) => b.totals.quotes - a.totals.quotes || b.totals.bookingsValue - a.totals.bookingsValue)
  const located = D.entities.filter(e => e.lat != null).length
  const synced = D.quotesSyncedAt
    ? new Date(D.quotesSyncedAt).toLocaleString('en-AU', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    : 'unknown'
  const mw = `${(58 / Math.max(M, 1)).toFixed(3)}%`

  return (
    <Document title={`Distributor Map FY${D.fy}`} author="JA Portal">
      <Page size="A4" style={s.page}>
        <View style={s.header}>
          <Text style={s.title}>Distributor Map — FY{D.fy}</Text>
          <Text style={s.subtitle}>
            {D.months[0]?.label} – {D.months[M - 1]?.label} · quotes in area vs jobs booked, month by month
          </Text>
          <Text style={s.scope}>
            {D.radiusKm} km area radius · {num(D.entities.length)} distributors with activity ({num(located)} located on the map) · quotes synced {synced}
          </Text>
        </View>

        <View style={s.statGrid}>
          <View style={s.stat}>
            <Text style={s.statLabel}>Quotes in areas</Text>
            <Text style={s.statValue}>{num(all.quotes)}</Text>
            <Text style={s.statSub}>{money(all.quotesValue)} of quoted work</Text>
          </View>
          <View style={s.stat}>
            <Text style={s.statLabel}>Jobs booked</Text>
            <Text style={s.statValue}>{num(all.bookings)}</Text>
            <Text style={s.statSub}>{money(all.bookingsValue)} booked</Text>
          </View>
          <View style={s.stat}>
            <Text style={s.statLabel}>Capture rate</Text>
            <Text style={s.statValue}>{capture(all.bookings, all.quotes)}</Text>
            <Text style={s.statSub}>bookings ÷ quotes in area</Text>
          </View>
          <View style={s.stat}>
            <Text style={s.statLabel}>Distributors</Text>
            <Text style={s.statValue}>{num(D.entities.length)}</Text>
            <Text style={s.statSub}>zero-activity ones already dropped</Text>
          </View>
        </View>

        <Table
          title="Month by month — all distributors"
          hint="Quotes are workshop quotes geocoded inside a distributor's radius, so they measure demand near them rather than work they were given. Bookings come from the Monday Distributor - Booking board, confirmed group."
          cols={[
            { label: 'Month', width: '18%' },
            { label: 'Quotes', width: '12%', right: true },
            { label: 'Quote value', width: '19%', right: true },
            { label: 'Bookings', width: '13%', right: true },
            { label: 'Booking value', width: '19%', right: true },
            { label: 'Capture', width: '19%', right: true },
          ]}
          rows={D.months.map((m, i) => [m.label, num(mq[i]), money(mqv[i]), num(mb[i]), money(mbv[i]), capture(mb[i], mq[i])])}
          total={['FY total', num(all.quotes), money(all.quotesValue), num(all.bookings), money(all.bookingsValue), capture(all.bookings, all.quotes)]}
        />

        <Table
          title="By distributor — whole FY"
          hint="Ranked by quotes in their area. A distributor with quotes but no bookings is the one worth a conversation."
          cols={[
            { label: 'Distributor', width: '30%' },
            { label: 'Quotes', width: '11%', right: true },
            { label: 'Quote value', width: '17%', right: true },
            { label: 'Bookings', width: '12%', right: true },
            { label: 'Booking value', width: '17%', right: true },
            { label: 'Capture', width: '13%', right: true },
          ]}
          rows={ranked.map(e => [
            (e.name + (e.lat == null ? ' (not located)' : '')).slice(0, 38),
            num(e.totals.quotes), money(e.totals.quotesValue),
            num(e.totals.bookings), money(e.totals.bookingsValue),
            capture(e.totals.bookings, e.totals.quotes),
          ])}
          total={['All', num(all.quotes), money(all.quotesValue), num(all.bookings), money(all.bookingsValue), capture(all.bookings, all.quotes)]}
        />

        <Text style={s.footer} fixed render={({ pageNumber, totalPages }) =>
          `Just Autos · Distributor Map FY${D.fy} · page ${pageNumber} of ${totalPages}`} />
      </Page>

      <Page size="A4" style={s.page}>
        <Text style={s.h2}>Quotes in area, by distributor, by month</Text>
        <Text style={s.hint}>Count of geocoded workshop quotes within {D.radiusKm} km of each distributor.</Text>
        <View>
          <View style={{ ...s.tableHeader, fontSize: 6.5 }} fixed>
            <Text style={{ width: '28%' }}>Distributor</Text>
            {D.months.map((m, i) => <Text key={i} style={{ width: mw, textAlign: 'right' }}>{m.label.split(' ')[0]}</Text>)}
            <Text style={{ width: '14%', textAlign: 'right' }}>Total</Text>
          </View>
          {ranked.map((e, ri) => (
            <View key={ri} style={{ ...s.tableRow, fontSize: 7 }} wrap={false}>
              <Text style={{ width: '28%' }}>{e.name.slice(0, 26)}</Text>
              {D.months.map((_, i) => (
                <Text key={i} style={{ width: mw, textAlign: 'right', color: C.ink2 }}>{e.monthly[i]?.quotes || '·'}</Text>
              ))}
              <Text style={{ width: '14%', textAlign: 'right', color: C.ink }}>{num(e.totals.quotes)}</Text>
            </View>
          ))}
          <View style={{ ...s.totalRow, fontSize: 7 }} wrap={false}>
            <Text style={{ width: '28%' }}>All</Text>
            {mq.map((v, i) => <Text key={i} style={{ width: mw, textAlign: 'right' }}>{v || '·'}</Text>)}
            <Text style={{ width: '14%', textAlign: 'right' }}>{num(all.quotes)}</Text>
          </View>
        </View>

        <Text style={s.h2}>Jobs booked, by distributor, by month</Text>
        <Text style={s.hint}>Confirmed rows on the Monday Distributor - Booking board.</Text>
        <View>
          <View style={{ ...s.tableHeader, fontSize: 6.5 }} fixed>
            <Text style={{ width: '28%' }}>Distributor</Text>
            {D.months.map((m, i) => <Text key={i} style={{ width: mw, textAlign: 'right' }}>{m.label.split(' ')[0]}</Text>)}
            <Text style={{ width: '14%', textAlign: 'right' }}>Total</Text>
          </View>
          {ranked.map((e, ri) => (
            <View key={ri} style={{ ...s.tableRow, fontSize: 7 }} wrap={false}>
              <Text style={{ width: '28%' }}>{e.name.slice(0, 26)}</Text>
              {D.months.map((_, i) => (
                <Text key={i} style={{ width: mw, textAlign: 'right', color: C.ink2 }}>{e.monthly[i]?.bookings || '·'}</Text>
              ))}
              <Text style={{ width: '14%', textAlign: 'right', color: C.ink }}>{num(e.totals.bookings)}</Text>
            </View>
          ))}
          <View style={{ ...s.totalRow, fontSize: 7 }} wrap={false}>
            <Text style={{ width: '28%' }}>All</Text>
            {mb.map((v, i) => <Text key={i} style={{ width: mw, textAlign: 'right' }}>{v || '·'}</Text>)}
            <Text style={{ width: '14%', textAlign: 'right' }}>{num(all.bookings)}</Text>
          </View>
        </View>

        <Text style={s.h2}>Booking value, by distributor, by month</Text>
        <View>
          <View style={{ ...s.tableHeader, fontSize: 6.5 }} fixed>
            <Text style={{ width: '28%' }}>Distributor</Text>
            {D.months.map((m, i) => <Text key={i} style={{ width: mw, textAlign: 'right' }}>{m.label.split(' ')[0]}</Text>)}
            <Text style={{ width: '14%', textAlign: 'right' }}>Total</Text>
          </View>
          {ranked.map((e, ri) => (
            <View key={ri} style={{ ...s.tableRow, fontSize: 7 }} wrap={false}>
              <Text style={{ width: '28%' }}>{e.name.slice(0, 26)}</Text>
              {D.months.map((_, i) => (
                <Text key={i} style={{ width: mw, textAlign: 'right', color: C.ink2 }}>{compact(e.monthly[i]?.bookingsValue || 0)}</Text>
              ))}
              <Text style={{ width: '14%', textAlign: 'right', color: C.ink }}>{compact(e.totals.bookingsValue)}</Text>
            </View>
          ))}
          <View style={{ ...s.totalRow, fontSize: 7 }} wrap={false}>
            <Text style={{ width: '28%' }}>All</Text>
            {mbv.map((v, i) => <Text key={i} style={{ width: mw, textAlign: 'right' }}>{compact(v)}</Text>)}
            <Text style={{ width: '14%', textAlign: 'right' }}>{compact(all.bookingsValue)}</Text>
          </View>
        </View>

        <Text style={s.footer} fixed render={({ pageNumber, totalPages }) =>
          `Just Autos · Distributor Map FY${D.fy} · page ${pageNumber} of ${totalPages}`} />
      </Page>

      <Page size="A4" style={s.page}>
        <Text style={s.h2}>Each distributor, month by month</Text>
        <Text style={s.hint}>The two sides side by side, for the distributor conversation.</Text>
        {ranked.map((e, ei) => (
          <View key={ei} wrap={false} style={{ marginBottom: 8 }}>
            <Text style={s.h3}>
              {e.name}{e.suburb ? ` · ${e.suburb}` : ''}{e.lat == null ? ' · not located' : ''}
              {'  —  '}{num(e.totals.quotes)} quotes / {num(e.totals.bookings)} booked ({capture(e.totals.bookings, e.totals.quotes)})
            </Text>
            <Table
              size={7}
              cols={[
                { label: 'Month', width: '20%' },
                { label: 'Quotes', width: '13%', right: true },
                { label: 'Quote value', width: '22%', right: true },
                { label: 'Bookings', width: '13%', right: true },
                { label: 'Booking value', width: '19%', right: true },
                { label: 'Capture', width: '13%', right: true },
              ]}
              rows={D.months
                .map((m, i) => ({ m, c: e.monthly[i] }))
                .filter(x => x.c && (x.c.quotes || x.c.bookings))
                .map(({ m, c }) => [m.label, num(c.quotes), money(c.quotesValue), num(c.bookings), money(c.bookingsValue), capture(c.bookings, c.quotes)])}
              total={['FY', num(e.totals.quotes), money(e.totals.quotesValue), num(e.totals.bookings), money(e.totals.bookingsValue), capture(e.totals.bookings, e.totals.quotes)]}
            />
          </View>
        ))}

        <View style={s.notesBox}>
          <Text style={s.note}>
            Quotes come from the daily MechanicDesk pull (geocoded), assigned to the nearest distributor within {D.radiusKm} km.
            A quote with no distributor inside that radius is not in this report at all.
          </Text>
          <Text style={s.note}>
            Bookings come from the Monday "Distributor - Booking" board, confirmed group only.
            A distributor whose Monday label does not match a b2b_distributors record by name stays unmatched and will show bookings of zero —
            "Hunter Mechanical" deliberately stays unmatched because it matches both branches.
          </Text>
          <Text style={s.note}>
            Quote points carry a month but no day, so every figure here is a month snapshot. All amounts ex-GST.
          </Text>
        </View>

        <Text style={s.footer} fixed render={({ pageNumber, totalPages }) =>
          `Just Autos · Distributor Map FY${D.fy} · page ${pageNumber} of ${totalPages}`} />
      </Page>
    </Document>
  )
}

export async function renderDistributorMapPdf(D: DistributorMapPdfData): Promise<Buffer> {
  const blob = await pdf(<DistributorMapDoc D={D} />).toBlob()
  return Buffer.from(await blob.arrayBuffer())
}

/** `distributor-map-FY2026-100km.pdf` — radius is part of the result, so name it. */
export function distributorMapPdfFilename(D: DistributorMapPdfData): string {
  return `distributor-map-FY${D.fy}-${D.radiusKm}km.pdf`
}
