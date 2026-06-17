// lib/workshop/prepick-pdf.tsx
// SERVER-ONLY PDF renderer for the workshop "Pre Pick" list, using
// @react-pdf/renderer. Takes the rows + summary the screen is showing and
// returns a stylised A4-landscape pick sheet (Buffer). Same clean corporate
// palette as the reports PDF.

import React from 'react'
import { Document, Page, Text, View, StyleSheet, pdf } from '@react-pdf/renderer'

const C = {
  ink: '#1a1d23', ink2: '#3a3f4a', ink3: '#6b7280',
  line: '#d1d5db', line2: '#e5e7eb',
  bg: '#ffffff', bg2: '#f9fafb', bg3: '#f3f4f6',
  accent: '#2563eb', green: '#059669', red: '#dc2626', amber: '#d97706',
}

export interface PrePickPdfItem {
  sku: string
  part_name: string
  supplier: string | null
  location: string | null
  buy_price: number | null
  to_pick: number
  current_stock: number
  remaining: number
  to_order: number
  status: 'green' | 'orange' | 'red'
}
export interface PrePickPdfPayload {
  from: string | null
  to: string | null
  synced_at: string | null
  generated_at: string
  jobs_count: number
  low_threshold: number
  filter_label: string
  counts: { green: number; orange: number; red: number; orderCount: number; orderValue: number }
  items: PrePickPdfItem[]
}

const money = (n: number | null | undefined) => (n == null || !isFinite(n) ? '—' : `$${(Number(n) || 0).toFixed(2)}`)
const fmtDate = (d: string | null) => {
  if (!d) return '—'
  try { return new Date(d).toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' }) } catch { return d }
}
const fmtDateTime = (d: string | null) => {
  if (!d) return '—'
  try { return new Date(d).toLocaleString('en-AU', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) } catch { return d }
}
const statusColor = (s: PrePickPdfItem['status']) => (s === 'red' ? C.red : s === 'orange' ? C.amber : C.green)
const num = (n: number) => (Math.round(n * 100) / 100).toString()

// Column widths (A4 landscape content ≈ 770pt; Part column flexes).
const COL = { dot: 12, sku: 92, supplier: 96, qty: 46, rem: 52, ord: 48, buy: 54, loc: 78 }

const s = StyleSheet.create({
  page: { paddingTop: 34, paddingBottom: 38, paddingHorizontal: 30, fontFamily: 'Helvetica', fontSize: 8.5, color: C.ink, backgroundColor: C.bg },
  header: { marginBottom: 12, paddingBottom: 10, borderBottom: `1pt solid ${C.line}` },
  titleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' },
  title: { fontSize: 18, fontWeight: 700, color: C.ink },
  brand: { fontSize: 9, fontWeight: 700, color: C.accent },
  subtitle: { fontSize: 8.5, color: C.ink3, marginTop: 3 },
  kpiRow: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  kpiBox: { flex: 1, backgroundColor: C.bg2, padding: 7, borderTopWidth: 2, borderStyle: 'solid' },
  kpiLabel: { fontSize: 7, color: C.ink3, textTransform: 'uppercase', letterSpacing: 0.3 },
  kpiValue: { fontSize: 15, fontWeight: 700, marginTop: 2 },
  kpiSub: { fontSize: 7, color: C.ink3, marginTop: 1 },
  th: { flexDirection: 'row', backgroundColor: C.bg3, paddingVertical: 4, paddingHorizontal: 5, borderBottom: `0.5pt solid ${C.line}`, fontSize: 7.5, fontWeight: 700, color: C.ink2 },
  tr: { flexDirection: 'row', paddingVertical: 3, paddingHorizontal: 5, borderBottom: `0.4pt solid ${C.line2}`, fontSize: 8 },
  trAlt: { backgroundColor: C.bg2 },
  right: { textAlign: 'right' },
  footer: { position: 'absolute', bottom: 18, left: 30, right: 30, fontSize: 7, color: C.ink3, flexDirection: 'row', justifyContent: 'space-between', borderTop: `0.5pt solid ${C.line2}`, paddingTop: 4 },
})

function Kpi({ label, value, sub, color }: { label: string; value: string; sub?: string; color: string }) {
  return (
    <View style={[s.kpiBox, { borderTopColor: color }]}>
      <Text style={s.kpiLabel}>{label}</Text>
      <Text style={[s.kpiValue, { color }]}>{value}</Text>
      {sub ? <Text style={s.kpiSub}>{sub}</Text> : null}
    </View>
  )
}

function PrePickDoc({ data }: { data: PrePickPdfPayload }) {
  const total = data.items.length
  return (
    <Document title="Pre Pick">
      <Page size="A4" orientation="landscape" style={s.page} wrap>
        {/* Header */}
        <View style={s.header}>
          <View style={s.titleRow}>
            <Text style={s.title}>Pre Pick — Parts to pick &amp; order</Text>
            <Text style={s.brand}>JUST AUTOS</Text>
          </View>
          <Text style={s.subtitle}>
            Jobs {fmtDate(data.from)} → {fmtDate(data.to)} · {data.jobs_count} job{data.jobs_count === 1 ? '' : 's'} · {total} part{total === 1 ? '' : 's'}
            {data.filter_label && data.filter_label !== 'All' ? ` · filter: ${data.filter_label}` : ''}
            {`  ·  Live from MechanicDesk, synced ${fmtDateTime(data.synced_at)}`}
          </Text>
        </View>

        {/* Summary KPIs */}
        <View style={s.kpiRow}>
          <Kpi label="To order" value={String(data.counts.orderCount)} sub={`${money(data.counts.orderValue)} at buy price`} color={C.red} />
          <Kpi label="Out of stock" value={String(data.counts.red)} sub="Demand ≥ on hand" color={C.red} />
          <Kpi label="Low" value={String(data.counts.orange)} sub={`≤ alert qty (default ${data.low_threshold})`} color={C.amber} />
          <Kpi label="OK" value={String(data.counts.green)} sub="Sufficient stock" color={C.green} />
        </View>

        {/* Table header */}
        <View style={s.th} fixed>
          <Text style={{ width: COL.dot }}> </Text>
          <Text style={{ width: COL.sku }}>SKU</Text>
          <Text style={{ flex: 1 }}>Part</Text>
          <Text style={{ width: COL.supplier }}>Supplier</Text>
          <Text style={[s.right, { width: COL.qty }]}>To pick</Text>
          <Text style={[s.right, { width: COL.qty }]}>On hand</Text>
          <Text style={[s.right, { width: COL.rem }]}>Remaining</Text>
          <Text style={[s.right, { width: COL.ord }]}>To order</Text>
          <Text style={[s.right, { width: COL.buy }]}>Buy $</Text>
          <Text style={{ width: COL.loc }}>Location</Text>
        </View>

        {/* Rows */}
        {data.items.map((it, i) => {
          const col = statusColor(it.status)
          return (
            <View key={i} style={[s.tr, i % 2 === 1 ? s.trAlt : {}]} wrap={false}>
              <View style={{ width: COL.dot, flexDirection: 'row', alignItems: 'center' }}>
                <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: col }} />
              </View>
              <Text style={{ width: COL.sku, color: C.ink2 }}>{it.sku || '—'}</Text>
              <Text style={{ flex: 1 }}>{it.part_name || '—'}</Text>
              <Text style={{ width: COL.supplier, color: C.ink3 }}>{it.supplier || '—'}</Text>
              <Text style={[s.right, { width: COL.qty, fontWeight: 700 }]}>{num(it.to_pick)}</Text>
              <Text style={[s.right, { width: COL.qty, color: C.ink2 }]}>{num(it.current_stock)}</Text>
              <Text style={[s.right, { width: COL.rem, color: col, fontWeight: 700 }]}>{num(it.remaining)}</Text>
              <Text style={[s.right, { width: COL.ord, color: it.to_order > 0 ? C.red : C.ink3, fontWeight: it.to_order > 0 ? 700 : 400 }]}>{it.to_order > 0 ? num(it.to_order) : '—'}</Text>
              <Text style={[s.right, { width: COL.buy, color: C.ink3 }]}>{money(it.buy_price)}</Text>
              <Text style={{ width: COL.loc, color: C.ink3 }}>{it.location || '—'}</Text>
            </View>
          )
        })}

        {total === 0 ? (
          <Text style={{ marginTop: 14, fontSize: 9, color: C.ink3, fontStyle: 'italic' }}>No parts match this filter.</Text>
        ) : null}

        {/* Footer */}
        <View style={s.footer} fixed>
          <Text>Just Autos — Pre Pick · generated {fmtDateTime(data.generated_at)}</Text>
          <Text render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
        </View>
      </Page>
    </Document>
  )
}

export async function renderPrePickPdf(data: PrePickPdfPayload): Promise<Buffer> {
  const instance = pdf(<PrePickDoc data={data} />)
  const blob = await instance.toBlob()
  const arrayBuffer = await blob.arrayBuffer()
  return Buffer.from(arrayBuffer)
}
