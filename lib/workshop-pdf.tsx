// lib/workshop-pdf.tsx
// SERVER-ONLY PDF renderer for workshop documents — quotes, tax invoices and
// job cards — using @react-pdf/renderer (same engine as lib/reports/pdf.tsx).
// Takes a normalised WorkshopDoc, returns a PDF Buffer. Clean A4 portrait
// letterhead layout; all line amounts ex-GST, totals show GST separately.

import React from 'react'
import { Document, Page, Text, View, StyleSheet, pdf } from '@react-pdf/renderer'

// ── Document shape (built by the API route from the DB) ────────────────
export interface WorkshopDocLine {
  description: string
  partNumber?: string | null
  qty: number
  unitPrice: number   // ex-GST
  total: number       // ex-GST (qty × unitPrice)
  isHeading?: boolean // 'description' line — full-width text row, no amounts
}
export interface WorkshopDoc {
  kind: 'quote' | 'invoice' | 'jobcard' | 'po'
  title: string                 // "Quote" | "Tax Invoice" | "Job Card" | "Purchase Order"
  reference: string             // human-ish ref, e.g. Q-3F9A21
  date: string                  // ISO
  status?: string | null
  business: { name: string; abn?: string | null; address?: string | null; phone?: string | null; email?: string | null }
  customer: { name: string; company?: string | null; phone?: string | null; email?: string | null; address?: string | null }
  partyLabel?: string           // "Bill to" (default) | "Supplier" for POs
  vehicle?: { label: string; rego?: string | null; vin?: string | null; odometer?: number | null } | null
  lines: WorkshopDocLine[]
  subtotal: number
  gst: number
  total: number
  notes?: string | null
  terms?: string | null         // editable terms / payment-details block
  footer?: string | null
  salesperson?: string | null   // who prepared the doc (quotes)
}

// ── Palette / styles ───────────────────────────────────────────────────
const C = {
  ink: '#1a1d23', ink2: '#3a3f4a', ink3: '#6b7280',
  line: '#d1d5db', line2: '#e5e7eb', bg2: '#f9fafb', bg3: '#f3f4f6',
  accent: '#2563eb',
}
const s = StyleSheet.create({
  page: { padding: 40, paddingBottom: 56, fontFamily: 'Helvetica', fontSize: 9.5, color: C.ink },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16, paddingBottom: 14, borderBottom: `1pt solid ${C.line}` },
  bizName: { fontSize: 16, fontWeight: 700, color: C.ink, marginBottom: 3 },
  bizLine: { fontSize: 8.5, color: C.ink3, marginBottom: 1 },
  docTitle: { fontSize: 20, fontWeight: 700, color: C.accent, textAlign: 'right' },
  metaLabel: { fontSize: 7.5, color: C.ink3, textTransform: 'uppercase', textAlign: 'right', marginTop: 4 },
  metaValue: { fontSize: 9.5, color: C.ink, textAlign: 'right', fontWeight: 700 },
  partyRow: { flexDirection: 'row', gap: 16, marginBottom: 16 },
  partyBox: { flex: 1, backgroundColor: C.bg2, padding: 10, borderTop: `2pt solid ${C.accent}` },
  partyLabel: { fontSize: 7.5, color: C.ink3, textTransform: 'uppercase', marginBottom: 3, letterSpacing: 0.5 },
  partyName: { fontSize: 11, fontWeight: 700, color: C.ink, marginBottom: 2 },
  partyLine: { fontSize: 9, color: C.ink2, marginBottom: 1 },
  thead: { flexDirection: 'row', backgroundColor: C.bg3, paddingVertical: 5, paddingHorizontal: 7, borderBottom: `0.5pt solid ${C.line}`, fontSize: 8, fontWeight: 700, color: C.ink2 },
  trow: { flexDirection: 'row', paddingVertical: 4.5, paddingHorizontal: 7, borderBottom: `0.5pt solid ${C.line2}`, fontSize: 9 },
  trowAlt: { backgroundColor: C.bg2 },
  headingRow: { backgroundColor: C.bg3, marginTop: 4 },
  headingText: { flex: 1, fontWeight: 700, color: C.ink },
  headingAmount: { width: 90, textAlign: 'right', fontWeight: 700, color: C.ink },
  cDesc: { flex: 1 },
  cPart: { width: 90, color: C.ink3 },
  cQty: { width: 40, textAlign: 'right' },
  cUnit: { width: 70, textAlign: 'right' },
  cTotal: { width: 72, textAlign: 'right' },
  totalsBox: { marginTop: 10, marginLeft: 'auto', width: 220 },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 2.5, fontSize: 9.5 },
  grandRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 5, marginTop: 3, borderTop: `1pt solid ${C.ink}`, fontSize: 12, fontWeight: 700 },
  notesLabel: { fontSize: 8, color: C.ink3, textTransform: 'uppercase', marginBottom: 3, marginTop: 18, letterSpacing: 0.5 },
  notesBox: { fontSize: 9, color: C.ink2, lineHeight: 1.5, padding: 8, backgroundColor: C.bg2 },
  footer: { position: 'absolute', bottom: 22, left: 40, right: 40, fontSize: 7.5, color: C.ink3, textAlign: 'center', borderTop: `0.5pt solid ${C.line2}`, paddingTop: 5 },
})

const money = (n: number | null | undefined) => `$${(Number(n) || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const fmtDate = (iso: string) => { try { return new Date(iso).toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' }) } catch { return iso } }

function WorkshopDocPdf({ doc }: { doc: WorkshopDoc }) {
  const b = doc.business
  const v = doc.vehicle
  const vehicleLine = v ? [v.rego ? `Rego ${v.rego}` : null, v.odometer != null ? `${v.odometer.toLocaleString('en-AU')} km` : null].filter(Boolean).join(' · ') : ''
  // Per-section subtotal: each heading sums its items until the next heading.
  const sectionTotals: Record<number, number> = {}
  doc.lines.forEach((l, i) => {
    if (!l.isHeading) return
    let sum = 0
    for (let j = i + 1; j < doc.lines.length; j++) { if (doc.lines[j].isHeading) break; sum += Number(doc.lines[j].total) || 0 }
    sectionTotals[i] = Math.round(sum * 100) / 100
  })
  return (
    <Document>
      <Page size="A4" style={s.page}>
        {/* Letterhead */}
        <View style={s.header}>
          <View style={{ flex: 1 }}>
            <Text style={s.bizName}>{b.name}</Text>
            {b.abn ? <Text style={s.bizLine}>ABN {b.abn}</Text> : null}
            {b.address ? <Text style={s.bizLine}>{b.address}</Text> : null}
            {(b.phone || b.email) ? <Text style={s.bizLine}>{[b.phone, b.email].filter(Boolean).join('  ·  ')}</Text> : null}
          </View>
          <View style={{ width: 180 }}>
            <Text style={s.docTitle}>{doc.title}</Text>
            <Text style={s.metaLabel}>Reference</Text>
            <Text style={s.metaValue}>{doc.reference}</Text>
            <Text style={s.metaLabel}>Date</Text>
            <Text style={s.metaValue}>{fmtDate(doc.date)}</Text>
            {doc.status ? <><Text style={s.metaLabel}>Status</Text><Text style={s.metaValue}>{doc.status}</Text></> : null}
            {doc.salesperson ? <><Text style={s.metaLabel}>Salesperson</Text><Text style={s.metaValue}>{doc.salesperson}</Text></> : null}
          </View>
        </View>

        {/* Party + vehicle (vehicle box hidden for POs) */}
        <View style={s.partyRow}>
          <View style={s.partyBox}>
            <Text style={s.partyLabel}>{doc.partyLabel || 'Bill to'}</Text>
            <Text style={s.partyName}>{doc.customer.name || '—'}</Text>
            {doc.customer.company ? <Text style={s.partyLine}>{doc.customer.company}</Text> : null}
            {doc.customer.address ? <Text style={s.partyLine}>{doc.customer.address}</Text> : null}
            {doc.customer.phone ? <Text style={s.partyLine}>{doc.customer.phone}</Text> : null}
            {doc.customer.email ? <Text style={s.partyLine}>{doc.customer.email}</Text> : null}
          </View>
          {doc.kind !== 'po' && (
          <View style={s.partyBox}>
            <Text style={s.partyLabel}>Vehicle</Text>
            {v ? (
              <>
                <Text style={s.partyName}>{v.label}</Text>
                {vehicleLine ? <Text style={s.partyLine}>{vehicleLine}</Text> : null}
                {v.vin ? <Text style={s.partyLine}>VIN {v.vin}</Text> : null}
              </>
            ) : <Text style={s.partyLine}>—</Text>}
          </View>
          )}
        </View>

        {/* Line items */}
        <View style={s.thead}>
          <Text style={s.cDesc}>Description</Text>
          <Text style={s.cPart}>Part #</Text>
          <Text style={s.cQty}>Qty</Text>
          <Text style={s.cUnit}>Unit (ex)</Text>
          <Text style={s.cTotal}>Total (ex)</Text>
        </View>
        {doc.lines.length === 0 ? (
          <View style={s.trow}><Text style={{ color: C.ink3 }}>No line items.</Text></View>
        ) : doc.lines.map((l, i) => (
          l.isHeading ? (
            <View key={i} style={[s.trow, s.headingRow]} wrap={false}>
              <Text style={s.headingText}>{l.description || ''}</Text>
              {sectionTotals[i] > 0 ? <Text style={s.headingAmount}>{money(sectionTotals[i])}</Text> : null}
            </View>
          ) : (
            <View key={i} style={[s.trow, i % 2 === 1 ? s.trowAlt : {}]} wrap={false}>
              <Text style={s.cDesc}>{l.description || '—'}</Text>
              <Text style={s.cPart}>{l.partNumber || ''}</Text>
              <Text style={s.cQty}>{Number(l.qty) || 0}</Text>
              <Text style={s.cUnit}>{money(l.unitPrice)}</Text>
              <Text style={s.cTotal}>{money(l.total)}</Text>
            </View>
          )
        ))}

        {/* Totals */}
        <View style={s.totalsBox} wrap={false}>
          <View style={s.totalRow}><Text style={{ color: C.ink3 }}>Subtotal (ex GST)</Text><Text>{money(doc.subtotal)}</Text></View>
          <View style={s.totalRow}><Text style={{ color: C.ink3 }}>GST</Text><Text>{money(doc.gst)}</Text></View>
          <View style={s.grandRow}><Text>Total (inc GST)</Text><Text>{money(doc.total)}</Text></View>
        </View>

        {/* Notes */}
        {doc.notes ? (
          <View wrap={false}>
            <Text style={s.notesLabel}>Notes</Text>
            <Text style={s.notesBox}>{doc.notes}</Text>
          </View>
        ) : null}

        {/* Editable terms / payment-details block */}
        {doc.terms ? (
          <View wrap={false}>
            <Text style={s.notesLabel}>{doc.kind === 'po' ? 'Terms' : doc.kind === 'quote' ? 'Quote terms' : 'Payment terms'}</Text>
            <Text style={s.notesBox}>{doc.terms}</Text>
          </View>
        ) : null}

        <Text style={s.footer} fixed>
          {doc.footer || `${b.name}${b.abn ? ` · ABN ${b.abn}` : ''} · Generated ${fmtDate(doc.date)}`}
        </Text>
      </Page>
    </Document>
  )
}

export async function renderWorkshopDocPdf(doc: WorkshopDoc): Promise<Buffer> {
  const instance = pdf(<WorkshopDocPdf doc={doc} />)
  const blob = await instance.toBlob()
  const arrayBuffer = await blob.arrayBuffer()
  return Buffer.from(arrayBuffer)
}
