// lib/letter-pdf.tsx
// SERVER-ONLY PDF renderer for workshop customer letters + matching DL
// envelopes — using @react-pdf/renderer (same engine as lib/workshop-pdf.tsx).
//
// renderLetterPdf()   → A4 thank-you/letterhead letter (Just Autos branding).
// renderEnvelopePdf() → DL envelope (110×220mm) with recipient + return address.
//
// The letterhead here is the "Just Autos" brand block — deliberately separate
// from the VPS company-file name used on tax invoices.

import React from 'react'
import { Document, Page, Text, View, Image, StyleSheet, pdf } from '@react-pdf/renderer'

// ── Shapes ──────────────────────────────────────────────────────────────
export interface LetterheadInfo {
  name: string
  abn?: string | null
  address?: string | null   // "2/11 Windsor Road, Burnside, QLD 4560"
  phone?: string | null
  email?: string | null
  website?: string | null
  logoDataUrl?: string | null  // data: URI for the wordmark (optional)
}
export interface LetterData {
  letterhead: LetterheadInfo
  date: string                    // ISO
  recipientName: string
  recipientAddressLines: string[] // ["47 King Street", "Moura Queensland 4718"]
  body: string                    // paragraphs separated by blank lines
  signOffName?: string | null
  signOffTitle?: string | null
}
export interface EnvelopeData {
  recipientName: string
  recipientAddressLines: string[]
  returnAddressLines?: string[]   // sender block, top-left
}

// ── Palette ─────────────────────────────────────────────────────────────
const C = { ink: '#1a1d23', ink2: '#3a3f4a', ink3: '#6b7280', line: '#cfd4da' }

const MM = 2.83465 // pt per mm

const fmtDate = (iso: string) => {
  try { return new Date(iso).toLocaleDateString('en-AU', { day: '2-digit', month: 'long', year: 'numeric' }) }
  catch { return iso }
}

// Split "2/11 Windsor Road, Burnside, QLD 4560" → ["2/11 Windsor Road", "Burnside, QLD 4560"]
function addressToLines(addr?: string | null): string[] {
  if (!addr) return []
  const parts = String(addr).split(',').map(p => p.trim()).filter(Boolean)
  if (parts.length <= 1) return parts
  return [parts[0], parts.slice(1).join(', ')]
}

// ── Letter (A4) ───────────────────────────────────────────────────────────
const ls = StyleSheet.create({
  page: { paddingTop: 38, paddingBottom: 48, paddingHorizontal: 44, fontFamily: 'Helvetica', fontSize: 10.5, color: C.ink, lineHeight: 1.5 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', paddingBottom: 10, borderBottom: `0.75pt solid ${C.line}` },
  hCol: { flexDirection: 'column' },
  bizName: { fontSize: 13, fontWeight: 700, color: C.ink, marginBottom: 3 },
  hLine: { fontSize: 7.5, color: C.ink3, marginBottom: 1.5 },
  logo: { width: 150, objectFit: 'contain' },
  recipient: { marginTop: 44 },
  recipientLine: { fontSize: 10.5, color: C.ink, marginBottom: 7 },
  salutation: { marginTop: 34, fontSize: 10.5 },
  para: { marginTop: 16, fontSize: 10.5, lineHeight: 1.55 },
  signoffIntro: { marginTop: 30, fontSize: 10.5 },
  signoffName: { marginTop: 26, fontSize: 10.5, fontWeight: 700 },
  signoffLine: { fontSize: 10.5, color: C.ink },
})

function LetterPdf({ data }: { data: LetterData }) {
  const lh = data.letterhead
  const addrLines = addressToLines(lh.address)
  const contact = [lh.phone ? `Telephone: ${lh.phone}` : null, lh.email ? `Email: ${lh.email}` : null].filter(Boolean) as string[]
  const paras = String(data.body || '').split(/\n\s*\n/).map(p => p.trim()).filter(Boolean)
  return (
    <Document>
      <Page size="A4" style={ls.page}>
        {/* Letterhead */}
        <View style={ls.header}>
          <View style={[ls.hCol, { flex: 1 }]}>
            <Text style={ls.bizName}>{lh.name}</Text>
            {lh.abn ? <Text style={ls.hLine}>ABN: {lh.abn}</Text> : null}
            {lh.website ? <Text style={ls.hLine}>Website: {lh.website}</Text> : null}
          </View>
          <View style={[ls.hCol, { width: 150, marginTop: 2 }]}>
            {addrLines.map((l, i) => <Text key={i} style={ls.hLine}>{l}</Text>)}
          </View>
          <View style={[ls.hCol, { width: 165, marginTop: 2 }]}>
            {contact.map((l, i) => <Text key={i} style={ls.hLine}>{l}</Text>)}
          </View>
          {lh.logoDataUrl ? <Image style={ls.logo} src={lh.logoDataUrl} /> : null}
        </View>

        {/* Recipient block */}
        <View style={ls.recipient}>
          <Text style={ls.recipientLine}>{data.recipientName}</Text>
          {data.recipientAddressLines.map((l, i) => <Text key={i} style={ls.recipientLine}>{l}</Text>)}
        </View>

        {/* Salutation */}
        <Text style={ls.salutation}>To {data.recipientName}</Text>

        {/* Body */}
        {paras.map((p, i) => <Text key={i} style={ls.para}>{p}</Text>)}

        {/* Sign-off */}
        {(data.signOffName || data.signOffTitle) ? (
          <>
            {data.signOffName ? <Text style={ls.signoffName}>{data.signOffName}</Text> : null}
            {data.signOffTitle ? <Text style={ls.signoffLine}>{data.signOffTitle}</Text> : null}
            <Text style={ls.signoffLine}>{lh.name}</Text>
          </>
        ) : null}
      </Page>
    </Document>
  )
}

export async function renderLetterPdf(data: LetterData): Promise<Buffer> {
  const blob = await pdf(<LetterPdf data={data} />).toBlob()
  return Buffer.from(await blob.arrayBuffer())
}

// ── Envelope (DL — 110×220mm landscape) ─────────────────────────────────
const es = StyleSheet.create({
  // DL landscape: 220mm wide × 110mm tall.
  page: { fontFamily: 'Helvetica', color: C.ink },
  return: { position: 'absolute', top: 12 * MM, left: 14 * MM, fontSize: 9 },
  returnLine: { fontSize: 9, color: C.ink2, marginBottom: 1.5 },
  // Address block sits in the lower-right per Australia Post addressing zone.
  recipient: { position: 'absolute', top: 52 * MM, left: 95 * MM, right: 14 * MM },
  name: { fontSize: 13, fontWeight: 700, marginBottom: 4 },
  line: { fontSize: 12, marginBottom: 3 },
})

function EnvelopePdf({ data }: { data: EnvelopeData }) {
  return (
    <Document>
      <Page size={[220 * MM, 110 * MM]} style={es.page}>
        {data.returnAddressLines && data.returnAddressLines.length ? (
          <View style={es.return}>
            {data.returnAddressLines.map((l, i) => <Text key={i} style={es.returnLine}>{l}</Text>)}
          </View>
        ) : null}
        <View style={es.recipient}>
          <Text style={es.name}>{data.recipientName}</Text>
          {data.recipientAddressLines.map((l, i) => <Text key={i} style={es.line}>{l}</Text>)}
        </View>
      </Page>
    </Document>
  )
}

export async function renderEnvelopePdf(data: EnvelopeData): Promise<Buffer> {
  const blob = await pdf(<EnvelopePdf data={data} />).toBlob()
  return Buffer.from(await blob.arrayBuffer())
}
