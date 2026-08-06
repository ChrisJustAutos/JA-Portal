// lib/b2b-pick-list.tsx
// SERVER-ONLY PDF renderer for the B2B order PICK LIST — the sheet that
// auto-prints at the workshop when an order is paid, telling the packer WHAT
// to pick and HOW it packs into boxes. Uses @react-pdf/renderer (same engine
// as lib/letter-pdf.tsx / lib/workshop-pdf.tsx).
//
// The box plan comes from the SAME cartonizer the freight quote/booking uses
// (lib/b2b-freight.ts packOrderUnits → lib/b2b-cartonizer.ts packItems), so
// the printed plan matches the consignment that will be booked.
//
// Data loading + queueing lives in lib/b2b-pick-list-print.ts.

import React from 'react'
import { Document, Page, Text, View, StyleSheet, pdf } from '@react-pdf/renderer'

// ── Shapes ──────────────────────────────────────────────────────────────
export interface PickListLine {
  sku: string
  name: string
  qty: number
  // Bundle component lines nested under their parent (they ship inside the
  // parent's box — picked, but never packed separately).
  components?: PickListLine[]
}
export interface PickListBox {
  title: string          // "BOX 1 — Medium Carton" / "PALLET GROUP (×2)"
  dims: string           // "400 × 300 × 250 mm"
  weightKg: number       // packed weight of this unit (group total for pallets)
  lines: PickListLine[]
}
export interface PickListDropShipGroup {
  supplier: string
  lines: PickListLine[]
}
export interface PickListData {
  orderNumber: string
  distributorName: string
  orderDate: string             // ISO
  customerPo?: string | null
  isTest?: boolean
  shipToLines: string[]
  packModeNote?: string | null  // e.g. "Pack mode: cartons (set on order)"
  boxes: PickListBox[]
  manualLines: PickListLine[]   // items missing dims — pack manually
  dropShip: PickListDropShipGroup[]
  totalBoxes: number
  totalWeightKg: number
}

// ── Styles ──────────────────────────────────────────────────────────────
const C = { ink: '#111318', ink2: '#3a3f4a', ink3: '#6b7280', line: '#c8cdd4', warnBg: '#f3f4f6', dropBg: '#fbeaea', dropInk: '#8a1f1f' }

const s = StyleSheet.create({
  page: { paddingTop: 30, paddingBottom: 40, paddingHorizontal: 36, fontFamily: 'Helvetica', fontSize: 10, color: C.ink },

  // Header
  headRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  kicker: { fontSize: 11, fontWeight: 700, letterSpacing: 2, color: C.ink3 },
  orderNo: { fontSize: 26, fontWeight: 700, marginTop: 2 },
  testFlag: { fontSize: 12, fontWeight: 700, color: C.dropInk, marginTop: 4 },
  metaBlock: { alignItems: 'flex-end' },
  metaLine: { fontSize: 10, color: C.ink2, marginBottom: 2 },
  distName: { fontSize: 13, fontWeight: 700, marginBottom: 3 },

  shipTo: { marginTop: 12, paddingTop: 8, borderTop: `1pt solid ${C.line}`, flexDirection: 'row' },
  shipToLabel: { width: 60, fontSize: 8.5, fontWeight: 700, color: C.ink3, letterSpacing: 1, marginTop: 1 },
  shipToLine: { fontSize: 10.5, marginBottom: 1.5 },
  packMode: { fontSize: 8.5, color: C.ink3, marginTop: 4 },

  // Box sections
  section: { marginTop: 14 },
  boxHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', backgroundColor: '#eceef1', paddingVertical: 5, paddingHorizontal: 8, borderRadius: 3 },
  boxTitle: { fontSize: 12, fontWeight: 700 },
  boxMeta: { fontSize: 9, color: C.ink2 },

  line: { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 4, paddingHorizontal: 8, borderBottom: `0.5pt solid ${C.line}` },
  checkbox: { width: 11, height: 11, border: `1pt solid ${C.ink}`, marginRight: 8, marginTop: 0.5 },
  qty: { width: 34, fontSize: 11, fontWeight: 700 },
  sku: { width: 110, fontSize: 10, fontWeight: 700 },
  name: { flex: 1, fontSize: 10 },
  compLine: { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 2.5, paddingLeft: 46, paddingRight: 8 },
  compQty: { width: 34, fontSize: 9.5, color: C.ink2 },
  compSku: { width: 110, fontSize: 9, color: C.ink2 },
  compName: { flex: 1, fontSize: 9, color: C.ink2 },

  // Special sections
  warnHead: { backgroundColor: C.warnBg, paddingVertical: 5, paddingHorizontal: 8, borderRadius: 3, borderLeft: `3pt solid ${C.ink3}` },
  warnTitle: { fontSize: 11, fontWeight: 700 },
  warnSub: { fontSize: 8.5, color: C.ink3, marginTop: 1 },
  dropHead: { backgroundColor: C.dropBg, paddingVertical: 5, paddingHorizontal: 8, borderRadius: 3, borderLeft: `3pt solid ${C.dropInk}` },
  dropTitle: { fontSize: 11, fontWeight: 700, color: C.dropInk },
  dropSub: { fontSize: 8.5, color: C.dropInk, marginTop: 1 },

  // Footer totals
  totals: { marginTop: 18, paddingTop: 8, borderTop: `1.5pt solid ${C.ink}`, flexDirection: 'row', justifyContent: 'space-between' },
  totalsText: { fontSize: 12, fontWeight: 700 },
  pageFoot: { position: 'absolute', bottom: 18, left: 36, right: 36, flexDirection: 'row', justifyContent: 'space-between' },
  footText: { fontSize: 8, color: C.ink3 },
})

const fmtDate = (iso: string) => {
  try { return new Date(iso).toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' }) }
  catch { return iso }
}
const kg = (n: number) => `${(Math.round(n * 10) / 10).toFixed(1)} kg`

function LineRow({ line, checkbox = true }: { line: PickListLine; checkbox?: boolean }) {
  return (
    <View wrap={false}>
      <View style={s.line}>
        {checkbox ? <View style={s.checkbox} /> : <View style={{ width: 19 }} />}
        <Text style={s.qty}>{line.qty}x</Text>
        <Text style={s.sku}>{line.sku || '-'}</Text>
        <Text style={s.name}>{line.name}</Text>
      </View>
      {(line.components || []).map((cl, i) => (
        <View key={i} style={s.compLine}>
          <Text style={s.compQty}>{cl.qty}x</Text>
          <Text style={s.compSku}>{cl.sku || '-'}</Text>
          <Text style={s.compName}>{cl.name} (bundle component — same box)</Text>
        </View>
      ))}
    </View>
  )
}

function PickListPdf({ data }: { data: PickListData }) {
  return (
    <Document>
      <Page size="A4" style={s.page}>
        {/* Header */}
        <View style={s.headRow}>
          <View>
            <Text style={s.kicker}>PICK LIST</Text>
            <Text style={s.orderNo}>{data.orderNumber}</Text>
            {data.isTest ? <Text style={s.testFlag}>[TEST ORDER — do not ship]</Text> : null}
          </View>
          <View style={s.metaBlock}>
            <Text style={s.distName}>{data.distributorName}</Text>
            <Text style={s.metaLine}>Ordered {fmtDate(data.orderDate)}</Text>
            {data.customerPo ? <Text style={s.metaLine}>Customer PO: {data.customerPo}</Text> : null}
          </View>
        </View>

        {/* Ship-to */}
        <View style={s.shipTo}>
          <Text style={s.shipToLabel}>SHIP TO</Text>
          <View style={{ flex: 1 }}>
            {data.shipToLines.map((l, i) => <Text key={i} style={s.shipToLine}>{l}</Text>)}
            {data.packModeNote ? <Text style={s.packMode}>{data.packModeNote}</Text> : null}
          </View>
        </View>

        {/* Box plan */}
        {data.boxes.map((box, i) => (
          <View key={i} style={s.section}>
            <View style={s.boxHead} wrap={false}>
              <Text style={s.boxTitle}>{box.title}</Text>
              <Text style={s.boxMeta}>{box.dims} - approx {kg(box.weightKg)}</Text>
            </View>
            {box.lines.map((l, j) => <LineRow key={j} line={l} />)}
          </View>
        ))}

        {/* Missing dims — pack manually */}
        {data.manualLines.length > 0 ? (
          <View style={s.section}>
            <View style={s.warnHead} wrap={false}>
              <Text style={s.warnTitle}>NO DIMENSIONS ON FILE — PACK MANUALLY</Text>
              <Text style={s.warnSub}>These items are missing freight dimensions in the catalogue, so they are not in the box plan above. Pick them and pack by judgement; fix the catalogue so freight can quote/book them.</Text>
            </View>
            {data.manualLines.map((l, j) => <LineRow key={j} line={l} />)}
          </View>
        ) : null}

        {/* Drop-ship — do not pack */}
        {data.dropShip.map((g, i) => (
          <View key={i} style={s.section}>
            <View style={s.dropHead} wrap={false}>
              <Text style={s.dropTitle}>DO NOT PACK — ships direct from supplier ({g.supplier})</Text>
              <Text style={s.dropSub}>These lines are drop-shipped. Do not pick or pack them here.</Text>
            </View>
            {g.lines.map((l, j) => <LineRow key={j} line={l} checkbox={false} />)}
          </View>
        ))}

        {/* Totals */}
        <View style={s.totals} wrap={false}>
          <Text style={s.totalsText}>
            {data.totalBoxes} {data.totalBoxes === 1 ? 'shipping unit' : 'shipping units'} to pack
          </Text>
          <Text style={s.totalsText}>Total weight approx {kg(data.totalWeightKg)}</Text>
        </View>

        {/* Page footer */}
        <View style={s.pageFoot} fixed>
          <Text style={s.footText}>Order {data.orderNumber} — {data.distributorName}</Text>
          <Text style={s.footText} render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
        </View>
      </Page>
    </Document>
  )
}

export async function renderPickListPdf(data: PickListData): Promise<Buffer> {
  const blob = await pdf(<PickListPdf data={data} />).toBlob()
  return Buffer.from(await blob.arrayBuffer())
}
