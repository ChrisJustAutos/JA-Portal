// lib/calls-weekly-report-pdf.tsx
// SERVER-ONLY PDF renderers for the weekly sales-coaching report — one GROUP
// report + one INDIVIDUAL report per advisor, attached to the Monday email.
// Layout follows the house style of lib/reports/pdf.tsx (A4, Helvetica,
// muted corporate palette).

import React from 'react'
import { Document, Page, Text, View, StyleSheet, pdf } from '@react-pdf/renderer'
import { callTypeLabel, dimensionLabel } from './calls-dimensions'

const C = {
  ink: '#1a1d23', ink2: '#3a3f4a', ink3: '#6b7280',
  line: '#d1d5db', line2: '#e5e7eb', bg2: '#f9fafb', bg3: '#f3f4f6',
  accent: '#2563eb', green: '#059669', red: '#dc2626', amber: '#d97706',
}
const scoreColor = (v: number | null | undefined) => v == null ? C.ink3 : v >= 70 ? C.green : v >= 50 ? C.amber : C.red

const s = StyleSheet.create({
  page: { padding: 40, fontFamily: 'Helvetica', fontSize: 9.5, color: C.ink },
  header: { marginBottom: 16, paddingBottom: 12, borderBottom: `1pt solid ${C.line}` },
  title: { fontSize: 20, fontWeight: 700, marginBottom: 3 },
  subtitle: { fontSize: 10, color: C.ink3 },
  statRow: { flexDirection: 'row', marginBottom: 14 },
  statBox: { marginRight: 22 },
  statLabel: { fontSize: 7.5, color: C.ink3, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 2 },
  statValue: { fontSize: 16, fontWeight: 700 },
  h2: { fontSize: 12, fontWeight: 700, marginTop: 14, marginBottom: 6 },
  para: { fontSize: 9.5, lineHeight: 1.6, color: C.ink2, marginBottom: 4 },
  bulletRow: { flexDirection: 'row', marginBottom: 3.5 },
  bulletDot: { width: 12, fontWeight: 700 },
  bulletText: { flex: 1, fontSize: 9.5, lineHeight: 1.5, color: C.ink2 },
  dimRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 3 },
  dimLabel: { width: 130, fontSize: 8.5, color: C.ink2 },
  dimBarTrack: { flex: 1, height: 5, backgroundColor: C.bg3, borderRadius: 2.5, marginRight: 8 },
  dimBarFill: { height: 5, borderRadius: 2.5 },
  dimValue: { width: 26, fontSize: 8.5, color: C.ink3, textAlign: 'right' },
  feedbackBox: { marginTop: 12, padding: 10, backgroundColor: C.bg2, borderRadius: 4, fontSize: 9.5, color: C.ink2, lineHeight: 1.5 },
  focusBox: { marginTop: 12, padding: 10, backgroundColor: '#eff6ff', borderRadius: 4, fontSize: 9.5, color: '#1e40af', lineHeight: 1.5 },
  tableHeader: { flexDirection: 'row', backgroundColor: C.bg3, paddingVertical: 4, paddingHorizontal: 6, fontSize: 8, fontWeight: 700, color: C.ink2, borderBottom: `0.5pt solid ${C.line}` },
  tableRow: { flexDirection: 'row', paddingVertical: 3.5, paddingHorizontal: 6, fontSize: 8.5, borderBottom: `0.5pt solid ${C.line2}` },
  footer: { position: 'absolute', bottom: 24, left: 40, right: 40, fontSize: 7.5, color: C.ink3, textAlign: 'center' },
})

const Bullets = ({ items, dot, color }: { items?: string[]; dot: string; color: string }) => (
  <>{(items || []).map((t, i) => (
    <View key={i} style={s.bulletRow}>
      <Text style={[s.bulletDot, { color }]}>{dot}</Text>
      <Text style={s.bulletText}>{t}</Text>
    </View>
  ))}</>
)

// ── Individual advisor report ─────────────────────────────────────────────

export async function renderAdvisorReportPdf(week: any, n: any, weekLabel: string): Promise<Buffer> {
  const doc = (
    <Document>
      <Page size="A4" style={s.page}>
        <View style={s.header}>
          <Text style={s.title}>{week.name} — Weekly Coaching Report</Text>
          <Text style={s.subtitle}>Just Autos sales coaching · {weekLabel}</Text>
        </View>

        <View style={s.statRow}>
          <View style={s.statBox}>
            <Text style={s.statLabel}>Average score</Text>
            <Text style={[s.statValue, { color: scoreColor(week.avgScore) }]}>{week.avgScore ?? '—'}/100</Text>
          </View>
          <View style={s.statBox}>
            <Text style={s.statLabel}>Calls coached</Text>
            <Text style={s.statValue}>{week.scored}</Text>
          </View>
          {Object.entries(week.byType as Record<string, { n: number; avg: number }>).map(([t, v]) => (
            <View key={t} style={s.statBox}>
              <Text style={s.statLabel}>{callTypeLabel(t) || t}</Text>
              <Text style={s.statValue}>{v.n} <Text style={{ fontSize: 9, color: C.ink3 }}>avg {v.avg}</Text></Text>
            </View>
          ))}
        </View>

        <Text style={s.h2}>Dimensions</Text>
        {Object.entries(week.dimensionAvgs as Record<string, number>).map(([d, v]) => (
          <View key={d} style={s.dimRow}>
            <Text style={[s.dimLabel, d === week.weakestDimension ? { color: C.amber, fontWeight: 700 } : {}]}>{dimensionLabel(d)}{d === week.weakestDimension ? ' ◂ focus' : ''}</Text>
            <View style={s.dimBarTrack}>
              <View style={[s.dimBarFill, { width: `${Math.min(100, v * 10)}%`, backgroundColor: scoreColor(v * 10) }]} />
            </View>
            <Text style={s.dimValue}>{v}</Text>
          </View>
        ))}

        <Text style={s.h2}>Coaching notes</Text>
        <Text style={s.para}>{n.coaching_notes || '—'}</Text>

        {!!n.quick_wins?.length && (<>
          <Text style={[s.h2, { color: C.green }]}>Quick wins</Text>
          <Bullets items={n.quick_wins} dot="✓" color={C.green} />
        </>)}

        {!!n.losses?.length && (<>
          <Text style={[s.h2, { color: C.amber }]}>Missed opportunities</Text>
          <Bullets items={n.losses} dot="!" color={C.amber} />
        </>)}

        {!!n.action_items?.length && (<>
          <Text style={[s.h2, { color: C.accent }]}>This week's actions</Text>
          {n.action_items.map((t: string, i: number) => (
            <View key={i} style={s.bulletRow}>
              <Text style={[s.bulletDot, { color: C.accent }]}>{i + 1}.</Text>
              <Text style={s.bulletText}>{t}</Text>
            </View>
          ))}
        </>)}

        {!!n.feedback && <Text style={s.feedbackBox}>“{n.feedback}”</Text>}

        <Text style={s.footer} fixed>Generated automatically from last week's analysed calls · JA Portal</Text>
      </Page>
    </Document>
  )
  const blob = await pdf(doc).toBlob()
  return Buffer.from(await blob.arrayBuffer())
}

// ── Group report ──────────────────────────────────────────────────────────

export async function renderGroupReportPdf(advisors: any[], narrative: any, weekLabel: string, totalCalls: number): Promise<Buffer> {
  const teamAvg = advisors.length
    ? Math.round(advisors.reduce((acc, a) => acc + (a.avgScore || 0) * a.scored, 0) / advisors.reduce((acc, a) => acc + a.scored, 0))
    : null
  const typeTotals: Record<string, { n: number; sum: number }> = {}
  for (const a of advisors) for (const [t, v] of Object.entries(a.byType as Record<string, { n: number; avg: number }>)) {
    typeTotals[t] = typeTotals[t] || { n: 0, sum: 0 }
    typeTotals[t].n += v.n; typeTotals[t].sum += v.avg * v.n
  }

  const doc = (
    <Document>
      <Page size="A4" style={s.page}>
        <View style={s.header}>
          <Text style={s.title}>Weekly Sales Coaching Report — Group</Text>
          <Text style={s.subtitle}>Just Autos sales coaching · {weekLabel}</Text>
        </View>

        <View style={s.statRow}>
          <View style={s.statBox}>
            <Text style={s.statLabel}>Team average</Text>
            <Text style={[s.statValue, { color: scoreColor(teamAvg) }]}>{teamAvg ?? '—'}/100</Text>
          </View>
          <View style={s.statBox}>
            <Text style={s.statLabel}>Calls coached</Text>
            <Text style={s.statValue}>{totalCalls}</Text>
          </View>
          {Object.entries(typeTotals).map(([t, v]) => (
            <View key={t} style={s.statBox}>
              <Text style={s.statLabel}>{callTypeLabel(t) || t}</Text>
              <Text style={s.statValue}>{v.n} <Text style={{ fontSize: 9, color: C.ink3 }}>avg {Math.round(v.sum / v.n)}</Text></Text>
            </View>
          ))}
        </View>

        <Text style={s.h2}>Team summary</Text>
        <Text style={s.para}>{narrative.team_summary || '—'}</Text>

        {!!narrative.team_highlights?.length && (<>
          <Text style={[s.h2, { color: C.green }]}>Highlights</Text>
          <Bullets items={narrative.team_highlights} dot="★" color={C.green} />
        </>)}

        {!!narrative.team_focus && <Text style={s.focusBox}>This week's focus: {narrative.team_focus}</Text>}

        <Text style={s.h2}>Advisor scoreboard</Text>
        <View style={s.tableHeader}>
          <Text style={{ flex: 2 }}>Advisor</Text>
          <Text style={{ flex: 1, textAlign: 'right' }}>Calls</Text>
          <Text style={{ flex: 1, textAlign: 'right' }}>Avg score</Text>
          <Text style={{ flex: 2, textAlign: 'right' }}>Focus dimension</Text>
        </View>
        {advisors.map((a, i) => (
          <View key={i} style={[s.tableRow, ...(i % 2 ? [{ backgroundColor: C.bg2 }] : [])]}>
            <Text style={{ flex: 2 }}>{a.name}</Text>
            <Text style={{ flex: 1, textAlign: 'right' }}>{a.scored}</Text>
            <Text style={{ flex: 1, textAlign: 'right', color: scoreColor(a.avgScore) }}>{a.avgScore ?? '—'}</Text>
            <Text style={{ flex: 2, textAlign: 'right', color: C.ink3 }}>{a.weakestDimension ? dimensionLabel(a.weakestDimension) : '—'}</Text>
          </View>
        ))}

        <Text style={s.footer} fixed>Generated automatically from last week's analysed calls · JA Portal</Text>
      </Page>
    </Document>
  )
  const blob = await pdf(doc).toBlob()
  return Buffer.from(await blob.arrayBuffer())
}
