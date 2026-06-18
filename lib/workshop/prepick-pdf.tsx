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
  allocated: number
  on_order: number
  remaining: number
  to_order: number
  status: 'green' | 'orange' | 'red'
}
export interface PrePickPdfJobPart { sku: string; name: string; quantity: number; on_hand: number | null; allocated?: number | null; available?: number | null; status?: 'green' | 'orange' | 'red' | null }
export interface PrePickPdfJob {
  job_number: string | null
  customer_name: string | null
  description: string | null
  vehicle: string | null
  rego: string | null
  status: string | null
  scheduled_at: string | null
  parts_count: number
  parts_qty: number
  parts: PrePickPdfJobPart[]
}
export interface PrePickPdfPayload {
  view?: 'parts' | 'jobs'
  from: string | null
  to: string | null
  synced_at: string | null
  generated_at: string
  jobs_count: number
  low_threshold: number
  filter_label: string
  counts: { green: number; orange: number; red: number; orderCount: number; orderValue: number }
  items: PrePickPdfItem[]
  jobs?: PrePickPdfJob[]
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
const COL = { dot: 12, sku: 78, supplier: 76, qty: 40, alloc: 46, avail: 46, ono: 46, rem: 46, ord: 42, buy: 46, loc: 62 }

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
          <Text style={{ fontSize: 8, color: C.amber, fontWeight: 700, marginTop: 3 }}>Note: in-stock items only — special-order / non-stocked parts are NOT included.</Text>
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
          <Text style={[s.right, { width: COL.alloc }]}>Allocated</Text>
          <Text style={[s.right, { width: COL.avail }]}>Available</Text>
          <Text style={[s.right, { width: COL.ono }]}>On order</Text>
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
              <Text style={[s.right, { width: COL.alloc, color: it.allocated > 0 ? C.ink2 : C.ink3 }]}>{it.allocated > 0 ? num(it.allocated) : '—'}</Text>
              <Text style={[s.right, { width: COL.avail, color: C.ink2 }]}>{num(it.current_stock - it.allocated)}</Text>
              <Text style={[s.right, { width: COL.ono, color: it.on_order > 0 ? C.accent : C.ink3 }]}>{it.on_order > 0 ? num(it.on_order) : '—'}</Text>
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

function JobsDoc({ data }: { data: PrePickPdfPayload }) {
  const jobs = data.jobs || []
  const totalParts = jobs.reduce((sum, j) => sum + (j.parts_count || 0), 0)
  return (
    <Document title="Pre Pick — Jobs">
      <Page size="A4" style={s.page} wrap>
        <View style={s.header}>
          <View style={s.titleRow}>
            <Text style={s.title}>Pre Pick — Jobs &amp; their parts</Text>
            <Text style={s.brand}>JUST AUTOS</Text>
          </View>
          <Text style={s.subtitle}>
            {fmtDate(data.from)} → {fmtDate(data.to)} · {jobs.length} job{jobs.length === 1 ? '' : 's'} · {totalParts} part line{totalParts === 1 ? '' : 's'}
            {`  ·  Live from MechanicDesk, synced ${fmtDateTime(data.synced_at)}`}
          </Text>
          <Text style={{ fontSize: 8, color: C.amber, fontWeight: 700, marginTop: 3 }}>Note: in-stock items only — special-order / non-stocked parts are NOT included.</Text>
        </View>

        {jobs.map((j, i) => (
          <View key={i} style={{ marginBottom: 11 }} wrap={false}>
            <View style={{ flexDirection: 'row', alignItems: 'baseline', backgroundColor: C.bg3, paddingVertical: 4, paddingHorizontal: 6, borderLeft: `2pt solid ${C.accent}` }}>
              <Text style={{ fontSize: 10, fontWeight: 700, color: C.ink, width: 70 }}>#{j.job_number || '—'}</Text>
              <Text style={{ fontSize: 9, color: C.ink, flex: 1 }}>{j.customer_name || '—'}</Text>
              <Text style={{ fontSize: 8, color: C.ink3, flex: 1.4 }}>{[j.vehicle, j.rego].filter(Boolean).join(' · ') || '—'}</Text>
              <Text style={{ fontSize: 8, color: C.ink3, width: 96 }}>{j.scheduled_at ? fmtDateTime(j.scheduled_at) : '—'}</Text>
              <Text style={{ fontSize: 8, color: C.ink3, width: 56 }}>{j.status || ''}</Text>
              <Text style={{ fontSize: 8, fontWeight: 700, color: C.ink2, width: 44, textAlign: 'right' }}>{j.parts_count} part{j.parts_count === 1 ? '' : 's'}</Text>
            </View>
            {j.description ? (
              <Text style={{ fontSize: 8, color: C.ink2, paddingTop: 2, paddingHorizontal: 8 }}>{j.description}</Text>
            ) : null}
            {j.parts.length === 0 ? (
              <Text style={{ fontSize: 8, color: C.ink3, fontStyle: 'italic', paddingVertical: 3, paddingHorizontal: 8 }}>No tracked parts (labour/freight only).</Text>
            ) : (
              <>
                <View style={{ flexDirection: 'row', paddingVertical: 2.5, paddingHorizontal: 8, borderBottom: `0.5pt solid ${C.line2}`, fontSize: 7, fontWeight: 700, color: C.ink3 }}>
                  <Text style={{ width: 12 }}> </Text>
                  <Text style={{ width: 96 }}>SKU</Text>
                  <Text style={{ flex: 1 }}>Part</Text>
                  <Text style={{ width: 42, textAlign: 'right' }}>Qty</Text>
                  <Text style={{ width: 52, textAlign: 'right' }}>On hand</Text>
                  <Text style={{ width: 56, textAlign: 'right' }}>Allocated</Text>
                  <Text style={{ width: 56, textAlign: 'right' }}>Available</Text>
                </View>
                {j.parts.map((p, k) => (
                  <View key={k} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 2.5, paddingHorizontal: 8, borderBottom: `0.4pt solid ${C.line2}`, fontSize: 8 }}>
                    <View style={{ width: 12, flexDirection: 'row', alignItems: 'center' }}>
                      {p.status ? <View style={{ width: 5, height: 5, borderRadius: 2.5, backgroundColor: statusColor(p.status) }} /> : null}
                    </View>
                    <Text style={{ width: 96, color: C.ink2 }}>{p.sku || '—'}</Text>
                    <Text style={{ flex: 1 }}>{p.name || '—'}</Text>
                    <Text style={{ width: 42, textAlign: 'right', fontWeight: 700 }}>{num(p.quantity)}</Text>
                    <Text style={{ width: 52, textAlign: 'right', color: C.ink3 }}>{p.on_hand == null ? '—' : num(p.on_hand)}</Text>
                    <Text style={{ width: 56, textAlign: 'right', color: C.ink3 }}>{p.allocated == null ? '—' : num(p.allocated)}</Text>
                    <Text style={{ width: 56, textAlign: 'right', color: C.ink2 }}>{p.available == null ? '—' : num(p.available)}</Text>
                  </View>
                ))}
              </>
            )}
          </View>
        ))}

        {jobs.length === 0 ? <Text style={{ marginTop: 14, fontSize: 9, color: C.ink3, fontStyle: 'italic' }}>No jobs match this search.</Text> : null}

        <View style={s.footer} fixed>
          <Text>Just Autos — Pre Pick (jobs) · generated {fmtDateTime(data.generated_at)}</Text>
          <Text render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
        </View>
      </Page>
    </Document>
  )
}

export async function renderPrePickPdf(data: PrePickPdfPayload): Promise<Buffer> {
  const doc = data.view === 'jobs' ? <JobsDoc data={data} /> : <PrePickDoc data={data} />
  const instance = pdf(doc)
  const blob = await instance.toBlob()
  const arrayBuffer = await blob.arrayBuffer()
  return Buffer.from(arrayBuffer)
}
