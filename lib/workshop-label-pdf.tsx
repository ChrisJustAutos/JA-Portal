// lib/workshop-label-pdf.tsx
// SERVER-ONLY printable parts-label sheet (A4) using @react-pdf/renderer. Lays
// labels out on a grid sized to common Avery sheets so they print on ANY
// standard laser/inkjet printer (no DYMO agent). Each label shows the part name,
// price, location and a Code 128 barcode (rendered as vector bars) with the
// human-readable value under it.

import React from 'react'
import { Document, Page, Text, View, StyleSheet, Svg, Rect, pdf } from '@react-pdf/renderer'
import { encodeCode128 } from './barcode-code128'

const MM = 2.83465   // pt per mm

export interface LabelItem {
  name: string
  sku: string
  barcodeValue: string       // barcode field if present, else SKU
  price?: number | null
  location?: string | null
  bin?: string | null
}

// Sheet layout in mm — matches common Avery stock. cols×rows per A4 page.
export interface LabelLayout {
  key: string
  label: string
  cols: number
  rows: number
  marginTop: number
  marginLeft: number
  labelW: number
  labelH: number
  gutterX: number
  gutterY: number
}

export const LABEL_LAYOUTS: LabelLayout[] = [
  { key: 'L7163', label: 'Avery L7163 — 14/sheet (99.1 × 38.1 mm)', cols: 2, rows: 7, marginTop: 15.1, marginLeft: 4.65, labelW: 99.1, labelH: 38.1, gutterX: 2.5, gutterY: 0 },
  { key: 'L7160', label: 'Avery L7160 — 21/sheet (63.5 × 38.1 mm)', cols: 3, rows: 7, marginTop: 15.1, marginLeft: 7.2, labelW: 63.5, labelH: 38.1, gutterX: 2.5, gutterY: 0 },
  { key: 'L7159', label: 'Avery L7159 — 24/sheet (63.5 × 33.9 mm)', cols: 3, rows: 8, marginTop: 13.1, marginLeft: 7.2, labelW: 63.5, labelH: 33.9, gutterX: 2.5, gutterY: 0 },
  { key: 'L7651', label: 'Avery L7651 — 65/sheet (38.1 × 21.2 mm)', cols: 5, rows: 13, marginTop: 10.7, marginLeft: 4.75, labelW: 38.1, labelH: 21.2, gutterX: 2.5, gutterY: 0 },
]

export function getLayout(key: string | null | undefined): LabelLayout {
  return LABEL_LAYOUTS.find(l => l.key === key) || LABEL_LAYOUTS[0]
}

const money = (n: number | null | undefined) =>
  n == null ? '' : `$${(Number(n) || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const s = StyleSheet.create({
  page: { fontFamily: 'Helvetica', backgroundColor: '#ffffff' },
  cell: { overflow: 'hidden', justifyContent: 'space-between' },
  name: { fontSize: 7.5, fontWeight: 700, color: '#000' },
  meta: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' },
  loc: { fontSize: 6.5, color: '#333' },
  price: { fontSize: 9, fontWeight: 700, color: '#000' },
  sku: { fontSize: 6.5, color: '#000', textAlign: 'center', fontFamily: 'Courier' },
})

function Barcode({ value, width, height }: { value: string; width: number; height: number }) {
  const enc = encodeCode128(value)
  const unit = width / enc.modules
  let x = 0
  const rects: React.ReactNode[] = []
  for (let i = 0; i < enc.bars.length; i++) {
    const b = enc.bars[i]
    const w = b.width * unit
    if (b.on) rects.push(<Rect key={i} x={x} y={0} width={w} height={height} fill="#000000" />)
    x += w
  }
  return (
    <Svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      {rects}
    </Svg>
  )
}

function LabelCell({ item, layout }: { item: LabelItem; layout: LabelLayout }) {
  // Blank spacer cell (used by `skip` to start on a part-used sheet).
  if (!item.name && !item.sku && !item.barcodeValue) {
    return <View style={{ width: layout.labelW * MM, height: layout.labelH * MM }} />
  }
  const pad = Math.min(6, layout.labelH * 0.12)
  const innerW = layout.labelW * MM - pad * 2
  const barHeight = Math.max(14, layout.labelH * MM * 0.42)
  const loc = [item.location, item.bin].filter(Boolean).join(' / ')
  return (
    <View style={[s.cell, { width: layout.labelW * MM, height: layout.labelH * MM, padding: pad }]}>
      <Text style={s.name} wrap={false}>{(item.name || '').slice(0, 60)}</Text>
      {(loc || item.price != null) ? (
        <View style={s.meta}>
          <Text style={s.loc}>{loc}</Text>
          {item.price != null ? <Text style={s.price}>{money(item.price)}</Text> : <Text> </Text>}
        </View>
      ) : null}
      <Barcode value={item.barcodeValue || item.sku} width={innerW} height={barHeight} />
      <Text style={s.sku}>{item.sku || item.barcodeValue}</Text>
    </View>
  )
}

function LabelSheet({ items, layout }: { items: LabelItem[]; layout: LabelLayout }) {
  const perPage = layout.cols * layout.rows
  const pages: LabelItem[][] = []
  for (let i = 0; i < items.length; i += perPage) pages.push(items.slice(i, i + perPage))
  if (pages.length === 0) pages.push([])

  return (
    <Document>
      {pages.map((pageItems, pi) => (
        <Page key={pi} size="A4" style={s.page}>
          <View style={{ position: 'absolute', top: layout.marginTop * MM, left: layout.marginLeft * MM, flexDirection: 'row', flexWrap: 'wrap', width: (layout.cols * layout.labelW + (layout.cols - 1) * layout.gutterX) * MM }}>
            {pageItems.map((item, idx) => (
              <View key={idx} style={{ marginRight: ((idx + 1) % layout.cols === 0) ? 0 : layout.gutterX * MM, marginBottom: layout.gutterY * MM }}>
                <LabelCell item={item} layout={layout} />
              </View>
            ))}
          </View>
        </Page>
      ))}
    </Document>
  )
}

// `skip` leaves that many cells blank at the start, so a part-used Avery sheet
// can be reloaded and the print starts on the first free label.
export async function renderLabelSheetPdf(items: LabelItem[], layout: LabelLayout, skip = 0): Promise<Buffer> {
  const blanks: LabelItem[] = Array.from({ length: Math.max(0, skip) }, () => ({ name: '', sku: '', barcodeValue: '' }))
  const all = [...blanks, ...items]
  const instance = pdf(<LabelSheet items={all} layout={layout} />)
  const blob = await instance.toBlob()
  const arrayBuffer = await blob.arrayBuffer()
  return Buffer.from(arrayBuffer)
}
