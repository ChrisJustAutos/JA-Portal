// lib/workshop-map-pdf.tsx
// SERVER-ONLY PDF renderer for Reports → Workshop Map (Map & Conversion).
//
// The screen is a map: you can see a month, but you can't take the year away
// with you. This prints the numbers behind it — every month of the FY, side by
// side, so the report can be filed or compared month on month.
//
// House style follows lib/jaws-stock-eom-pdf.tsx and lib/reports/pdf.tsx:
// A4 portrait, Helvetica, muted corporate palette, table headers that repeat
// on page breaks and rows that never split.
//
// Two populations appear in this document and they are NOT the same, so every
// table says which one it is using:
//   · counts from payload.conv — every deduped job/quote in the FY
//   · revenue from payload.*.points — only records that geocoded onto the map
// Revenue for an ungeocoded job genuinely isn't in the payload, so a "total
// revenue" that silently mixed the two would be wrong.

import React from 'react'
import { Document, Page, Text, View, StyleSheet, pdf } from '@react-pdf/renderer'
import { pcState } from './workshop-map/postcode-state'

const C = {
  ink: '#1a1d23', ink2: '#3a3f4a', ink3: '#6b7280',
  line: '#d1d5db', line2: '#e5e7eb', bg2: '#f9fafb', bg3: '#f3f4f6',
  accent: '#2563eb', green: '#059669', amber: '#d97706',
}

const s = StyleSheet.create({
  page: { paddingTop: 34, paddingBottom: 44, paddingHorizontal: 34, fontFamily: 'Helvetica', fontSize: 9, color: C.ink },
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
  footer: { position: 'absolute', bottom: 22, left: 34, right: 34, fontSize: 7, color: C.ink3, textAlign: 'center' },
})

// ── payload shape (mirrors lib/workshop-map/build-payload.ts) ──────────────
export interface MapPdfPayload {
  fy: number
  months: { k: string; label: string }[]
  cats: { k: string; n: string; col: string }[]
  jobs: { points: any[]; meta: { customers: number; mapped: number; clean_total: number; inferred: number } }
  quotes: { points: any[]; meta: { total_quotes: number; mapped: number; total_value: number } }
  conv: { qcount: Record<string, number[]>; qval: Record<string, number[]>; jcount: Record<string, number[]> }
}
export interface MapPdfDeposits { total: number; count: number; byMonth: number[] }
export interface MapPdfOpts {
  cat?: string          // vehicle group key, or 'all'
  state?: string        // 'NSW' | … | 'all'
  deposits?: MapPdfDeposits | null
  syncedAt?: string | null
}

const money = (n: number | null | undefined) =>
  n == null || !isFinite(Number(n)) ? '—' : '$' + Math.round(Number(n)).toLocaleString('en-AU')
const compact = (n: number) =>
  n >= 1e6 ? '$' + (n / 1e6).toFixed(2) + 'M' : n >= 1000 ? '$' + (n / 1000).toFixed(n >= 100000 ? 0 : 1) + 'k' : '$' + Math.round(n)
const num = (n: number | null | undefined) => n == null ? '—' : Math.round(Number(n)).toLocaleString('en-AU')
const conv = (jobs: number, quotes: number) => quotes > 0 ? `${(jobs / quotes * 100).toFixed(1)}%` : '—'

interface Col { label: string; width: string; right?: boolean }

function Table({ title, hint, cols, rows, total }: {
  title?: string; hint?: string; cols: Col[]; rows: (string | number)[][]; total?: (string | number)[]
}) {
  return (
    <View>
      {title ? <Text style={s.h2}>{title}</Text> : null}
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
          {total ? (
            <View style={s.totalRow} wrap={false}>
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

/** Vehicle × month matrix: label column + 12 narrow month columns + total. */
function Matrix({ title, hint, months, rows, fmt }: {
  title: string; hint?: string; months: { label: string }[]
  rows: { label: string; values: number[] }[]
  fmt: (n: number) => string
}) {
  const mw = `${(66 / Math.max(months.length, 1)).toFixed(3)}%`
  const cols: Col[] = [
    { label: 'Vehicle', width: '20%' },
    ...months.map(m => ({ label: m.label.split(' ')[0], width: mw, right: true })),
    { label: 'Total', width: '14%', right: true },
  ]
  const body = rows.map(r => [r.label, ...r.values.map(fmt), fmt(r.values.reduce((a, b) => a + b, 0))])
  const totals = months.map((_, i) => rows.reduce((sm, r) => sm + (r.values[i] || 0), 0))
  return (
    <View>
      <Text style={s.h2}>{title}</Text>
      {hint ? <Text style={s.hint}>{hint}</Text> : null}
      <View>
        <View style={{ ...s.tableHeader, fontSize: 6.5 }} fixed>
          {cols.map((c, i) => <Text key={i} style={{ width: c.width, textAlign: c.right ? 'right' : 'left' }}>{c.label}</Text>)}
        </View>
        {body.map((r, ri) => (
          <View key={ri} style={{ ...s.tableRow, fontSize: 7 }} wrap={false}>
            {r.map((cell, ci) => (
              <Text key={ci} style={{ width: cols[ci].width, textAlign: cols[ci].right ? 'right' : 'left', color: ci === 0 ? C.ink : C.ink2 }}>{String(cell)}</Text>
            ))}
          </View>
        ))}
        <View style={{ ...s.totalRow, fontSize: 7 }} wrap={false}>
          {['All', ...totals.map(fmt), fmt(totals.reduce((a, b) => a + b, 0))].map((cell, ci) => (
            <Text key={ci} style={{ width: cols[ci].width, textAlign: cols[ci].right ? 'right' : 'left' }}>{String(cell)}</Text>
          ))}
        </View>
      </View>
    </View>
  )
}

function WorkshopMapDoc({ P, opts }: { P: MapPdfPayload; opts: MapPdfOpts }) {
  const cat = opts.cat && opts.cat !== 'all' ? opts.cat : null
  const st = opts.state && opts.state !== 'all' ? opts.state : null
  const cats = cat ? P.cats.filter(c => c.k === cat) : P.cats
  const catName = cat ? (P.cats.find(c => c.k === cat)?.n || cat) : 'All vehicles'

  const keep = (p: any) => (!cat || p.g === cat) && (!st || pcState(p.pc || '') === st)
  const jobPts = (P.jobs.points || []).filter(keep)
  const quotePts = (P.quotes.points || []).filter(keep)

  const M = P.months.length || 12
  const zeros = () => Array(M).fill(0) as number[]

  // Revenue is only knowable for geocoded points — see the file header.
  const jobRevByMonth = zeros(), jobCountByMonth = zeros()
  for (const p of jobPts) { if (p.m >= 0 && p.m < M) { jobRevByMonth[p.m] += Number(p.a) || 0; jobCountByMonth[p.m]++ } }
  const quoteValByMonth = zeros(), quoteCountByMonth = zeros(), wonByMonth = zeros()
  for (const p of quotePts) {
    if (p.m >= 0 && p.m < M) {
      quoteValByMonth[p.m] += Number(p.a) || 0; quoteCountByMonth[p.m]++
      if (p.w) wonByMonth[p.m]++
    }
  }

  // Counts across the FULL deduped set (includes records that never geocoded).
  const convQ = zeros(), convJ = zeros()
  for (const c of cats) {
    const q = P.conv?.qcount?.[c.k] || [], j = P.conv?.jcount?.[c.k] || []
    for (let i = 0; i < M; i++) { convQ[i] += q[i] || 0; convJ[i] += j[i] || 0 }
  }

  const sum = (a: number[]) => a.reduce((x, y) => x + y, 0)
  const dep = opts.deposits || null
  const filtered = !!(cat || st)

  // Top localities by job revenue.
  const byLoc = new Map<string, { rev: number; jobs: number }>()
  for (const p of jobPts) {
    const k = `${p.l || '—'}${p.pc ? ` ${p.pc}` : ''}`
    const e = byLoc.get(k) || { rev: 0, jobs: 0 }
    e.rev += Number(p.a) || 0; e.jobs++
    byLoc.set(k, e)
  }
  const topLoc = Array.from(byLoc.entries()).sort((a, b) => b[1].rev - a[1].rev).slice(0, 25)

  // By state (only meaningful when not already filtered to one).
  const byState = new Map<string, { rev: number; jobs: number; quotes: number }>()
  for (const p of jobPts) {
    const k = pcState(p.pc || '')
    const e = byState.get(k) || { rev: 0, jobs: 0, quotes: 0 }
    e.rev += Number(p.a) || 0; e.jobs++; byState.set(k, e)
  }
  for (const p of quotePts) {
    const k = pcState(p.pc || '')
    const e = byState.get(k) || { rev: 0, jobs: 0, quotes: 0 }
    e.quotes++; byState.set(k, e)
  }
  const states = Array.from(byState.entries()).sort((a, b) => b[1].rev - a[1].rev)

  const synced = opts.syncedAt
    ? new Date(opts.syncedAt).toLocaleString('en-AU', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    : 'unknown'

  return (
    <Document title={`Workshop Map FY${P.fy}`} author="JA Portal">
      <Page size="A4" style={s.page}>
        <View style={s.header}>
          <Text style={s.title}>Workshop Map &amp; Conversion — FY{P.fy}</Text>
          <Text style={s.subtitle}>
            {P.months[0]?.label} – {P.months[P.months.length - 1]?.label} · month by month
          </Text>
          <Text style={s.scope}>
            {catName}{st ? ` · ${st} only` : ' · all states'} · MechanicDesk data synced {synced}
          </Text>
        </View>

        <View style={s.statGrid}>
          <View style={s.stat}>
            <Text style={s.statLabel}>Job revenue</Text>
            <Text style={s.statValue}>{money(sum(jobRevByMonth))}</Text>
            <Text style={s.statSub}>{num(jobPts.length)} customer-months on the map</Text>
          </View>
          <View style={s.stat}>
            <Text style={s.statLabel}>Jobs</Text>
            <Text style={s.statValue}>{num(sum(convJ))}</Text>
            <Text style={s.statSub}>{num(jobPts.length)} geocoded{filtered ? '' : ` of ${num(P.jobs.meta?.customers)}`}</Text>
          </View>
          <View style={s.stat}>
            <Text style={s.statLabel}>Quotes</Text>
            <Text style={s.statValue}>{num(sum(convQ))}</Text>
            <Text style={s.statSub}>{money(sum(quoteValByMonth))} geocoded value</Text>
          </View>
          <View style={s.stat}>
            <Text style={s.statLabel}>Quote → job</Text>
            <Text style={s.statValue}>{conv(sum(convJ), sum(convQ))}</Text>
            <Text style={s.statSub}>jobs ÷ quotes, whole FY</Text>
          </View>
          {dep && !filtered ? (
            <View style={s.stat}>
              <Text style={s.statLabel}>Deposits awaiting jobs</Text>
              <Text style={s.statValue}>{money(dep.total)}</Text>
              <Text style={s.statSub}>{num(dep.count)} not yet in the totals above</Text>
            </View>
          ) : null}
        </View>

        <Table
          title="Month by month"
          hint={
            'Jobs and quotes are counted over every deduped record in the FY. Revenue columns cover only records that geocoded onto the map — an ungeocoded job carries no location, and its amount is not in the payload. Conversion is jobs ÷ quotes in the same month, so a quote won the following month lands in the next row.'
          }
          cols={[
            { label: 'Month', width: '16%' },
            { label: 'Jobs', width: '12%', right: true },
            { label: 'Revenue', width: '18%', right: true },
            { label: 'Quotes', width: '12%', right: true },
            { label: 'Quote value', width: '18%', right: true },
            { label: 'Won', width: '10%', right: true },
            { label: 'Conv.', width: '14%', right: true },
          ]}
          rows={P.months.map((m, i) => [
            m.label,
            num(convJ[i]),
            money(jobRevByMonth[i]),
            num(convQ[i]),
            money(quoteValByMonth[i]),
            num(wonByMonth[i]),
            conv(convJ[i], convQ[i]),
          ])}
          total={[
            'FY total', num(sum(convJ)), money(sum(jobRevByMonth)),
            num(sum(convQ)), money(sum(quoteValByMonth)), num(sum(wonByMonth)),
            conv(sum(convJ), sum(convQ)),
          ]}
        />

        {dep && !filtered ? (
          <Table
            title="Booking deposits awaiting jobs"
            hint="Deposits taken but with no completed job yet, so they are NOT in the revenue above. A deposit for a finished job is already folded into that customer's total."
            cols={[{ label: 'Month', width: '50%' }, { label: 'Deposits held', width: '50%', right: true }]}
            rows={P.months.map((m, i) => [m.label, money(dep.byMonth?.[i] || 0)]).filter(r => r[1] !== '$0')}
            total={['Total', money(dep.total)]}
          />
        ) : null}

        <Text style={s.footer} fixed render={({ pageNumber, totalPages }) =>
          `Just Autos · Workshop Map FY${P.fy} · page ${pageNumber} of ${totalPages}`} />
      </Page>

      <Page size="A4" style={s.page}>
        <Matrix
          title="Quotes by vehicle, by month"
          hint="Deduped quote count — one per customer per month, largest quote wins."
          months={P.months}
          rows={cats.map(c => ({ label: c.n, values: (P.conv?.qcount?.[c.k] || zeros()).slice(0, M) }))}
          fmt={n => n ? String(n) : '·'}
        />

        <Matrix
          title="Jobs by vehicle, by month"
          months={P.months}
          rows={cats.map(c => ({ label: c.n, values: (P.conv?.jcount?.[c.k] || zeros()).slice(0, M) }))}
          fmt={n => n ? String(n) : '·'}
        />

        <Matrix
          title="Quote value by vehicle, by month"
          hint="Deduped quote value. Rounded to the nearest thousand where it helps the columns fit."
          months={P.months}
          rows={cats.map(c => ({ label: c.n, values: (P.conv?.qval?.[c.k] || zeros()).slice(0, M) }))}
          fmt={n => n ? compact(n) : '·'}
        />

        <Table
          title="Conversion by vehicle — whole FY"
          hint="Quotes and jobs are independent deduped counts, so this is a rate for the year, not a tracked funnel: it does not follow individual quotes through to a job."
          cols={[
            { label: 'Vehicle', width: '34%' },
            { label: 'Quotes', width: '13%', right: true },
            { label: 'Quote value', width: '20%', right: true },
            { label: 'Jobs', width: '13%', right: true },
            { label: 'Conversion', width: '20%', right: true },
          ]}
          rows={cats.map(c => {
            const q = sum(P.conv?.qcount?.[c.k] || []), j = sum(P.conv?.jcount?.[c.k] || []), v = sum(P.conv?.qval?.[c.k] || [])
            return [c.n, num(q), money(v), num(j), conv(j, q)]
          })}
          total={['All vehicles', num(sum(convQ)), money(cats.reduce((t, c) => t + sum(P.conv?.qval?.[c.k] || []), 0)), num(sum(convJ)), conv(sum(convJ), sum(convQ))]}
        />

        <Text style={s.footer} fixed render={({ pageNumber, totalPages }) =>
          `Just Autos · Workshop Map FY${P.fy} · page ${pageNumber} of ${totalPages}`} />
      </Page>

      <Page size="A4" style={s.page}>
        {!st ? (
          <Table
            title="By state"
            hint="Derived from the postcode on each geocoded record."
            cols={[
              { label: 'State', width: '16%' },
              { label: 'Jobs', width: '14%', right: true },
              { label: 'Job revenue', width: '24%', right: true },
              { label: 'Quotes', width: '14%', right: true },
              { label: 'Share of revenue', width: '32%', right: true },
            ]}
            rows={states.map(([k, v]) => {
              const tot = sum(jobRevByMonth)
              return [k, num(v.jobs), money(v.rev), num(v.quotes), tot > 0 ? `${(v.rev / tot * 100).toFixed(1)}%` : '—']
            })}
            total={['All', num(jobPts.length), money(sum(jobRevByMonth)), num(quotePts.length), '100%']}
          />
        ) : null}

        <Table
          title="Top locations by job revenue"
          hint="Geocoded jobs only, grouped by the locality on the invoice."
          cols={[
            { label: 'Locality', width: '46%' },
            { label: 'Jobs', width: '14%', right: true },
            { label: 'Revenue', width: '22%', right: true },
            { label: 'Avg / job', width: '18%', right: true },
          ]}
          rows={topLoc.map(([k, v]) => [k.slice(0, 40), num(v.jobs), money(v.rev), money(v.rev / Math.max(v.jobs, 1))])}
        />

        <View style={s.notesBox}>
          <Text style={s.note}>
            Source: the daily MechanicDesk pull cached per financial year (md_workshop_map_cache), synced {synced}.
            The portal screen and this PDF read the same payload.
          </Text>
          <Text style={s.note}>
            A job "dot" is one customer in one month — every invoice for that customer that month is summed into it,
            plus any booking deposit already earned. Quotes are deduped the same way, largest per customer per month.
          </Text>
          <Text style={s.note}>
            Geocoding coverage: {num(P.jobs.meta?.mapped)} of {num(P.jobs.meta?.customers)} job records and{' '}
            {num(P.quotes.meta?.mapped)} of {num(P.quotes.meta?.total_quotes)} quotes carry a location.
            {P.jobs.meta?.inferred ? ` ${num(P.jobs.meta.inferred)} job records had their vehicle series inferred rather than read from a chassis code.` : ''}
          </Text>
          <Text style={s.note}>All amounts ex-GST, as recorded in MechanicDesk.</Text>
        </View>

        <Text style={s.footer} fixed render={({ pageNumber, totalPages }) =>
          `Just Autos · Workshop Map FY${P.fy} · page ${pageNumber} of ${totalPages}`} />
      </Page>
    </Document>
  )
}

export async function renderWorkshopMapPdf(P: MapPdfPayload, opts: MapPdfOpts = {}): Promise<Buffer> {
  const blob = await pdf(<WorkshopMapDoc P={P} opts={opts} />).toBlob()
  return Buffer.from(await blob.arrayBuffer())
}

/** `workshop-map-FY2026.pdf`, with the filter in the name when one is applied. */
export function workshopMapPdfFilename(P: MapPdfPayload, opts: MapPdfOpts = {}): string {
  const bits = [`workshop-map-FY${P.fy}`]
  if (opts.cat && opts.cat !== 'all') bits.push(String(opts.cat).toLowerCase())
  if (opts.state && opts.state !== 'all') bits.push(String(opts.state).toLowerCase())
  return `${bits.join('-')}.pdf`
}
