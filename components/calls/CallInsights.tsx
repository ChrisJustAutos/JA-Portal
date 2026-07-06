// components/calls/CallInsights.tsx
// Insight tabs for the Calls page: Sentiment, Coaching, Words & Objections and
// Conversion. The number-crunching comes from /api/calls/insights (instant);
// the AI narratives (coaching tips, "why people don't book", sentiment story)
// are fetched on demand via a Generate button so they only cost tokens when a
// human asks. Shares the page's date range + advisor filter.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { AppIcon } from '../../lib/AppIcons'
import { dimensionLabel } from '../../lib/calls-dimensions'
import type { CallsInsights } from '../../lib/calls-insights'

const T = {
  bg: 'var(--t-bg)', bg2: 'var(--t-bg2)', bg3: 'var(--t-bg3)', bg4: 'var(--t-bg4)',
  border: 'var(--t-border)', border2: 'var(--t-border2)',
  text: 'var(--t-text)', text2: 'var(--t-text2)', text3: 'var(--t-text3)',
  blue: '#4f8ef7', teal: '#2dd4bf', green: '#34c77b',
  amber: '#f5a623', red: '#f04e4e', purple: '#a78bfa', accent: '#4f8ef7',
}

export type CallView = 'overview' | 'sentiment' | 'coaching' | 'words' | 'conversion'

const TABS: { id: CallView; label: string; icon: string; accent: string }[] = [
  { id: 'overview',   label: 'Overview',           icon: 'overview',        accent: T.blue },
  { id: 'sentiment',  label: 'Sentiment',          icon: 'call-sentiment',  accent: T.teal },
  { id: 'coaching',   label: 'Coaching',           icon: 'call-coaching',   accent: T.purple },
  { id: 'words',      label: 'Words & objections', icon: 'call-words',      accent: T.amber },
  { id: 'conversion', label: 'Conversion',         icon: 'call-funnel',     accent: T.green },
]

// ── Tab bar (icon tiles, Settings-hub style) ────────────────────────────────

export function CallTabBar({ view, onChange }: { view: CallView; onChange: (v: CallView) => void }) {
  return (
    <div style={{ display: 'flex', gap: 8, marginBottom: 18, flexWrap: 'wrap' }}>
      {TABS.map(t => {
        const on = t.id === view
        return (
          <button key={t.id} onClick={() => onChange(t.id)}
            style={{
              display: 'flex', alignItems: 'center', gap: 9, padding: '8px 13px',
              borderRadius: 10, cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5,
              fontWeight: on ? 600 : 500,
              background: on ? `${t.accent}18` : T.bg2,
              border: `1px solid ${on ? t.accent : T.border}`,
              color: on ? t.accent : T.text2,
            }}>
            <span style={{
              width: 28, height: 28, borderRadius: 8, flexShrink: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: `${t.accent}1f`, color: t.accent,
            }}>
              <AppIcon name={t.icon} size={16} />
            </span>
            {t.label}
          </button>
        )
      })}
    </div>
  )
}

// ── Shared bits ─────────────────────────────────────────────────────────────

function Card({ title, hint, right, children }: { title?: string; hint?: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 10, padding: 16 }}>
      {(title || right) && (
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: hint ? 2 : 12 }}>
          {title && <div style={{ fontSize: 10, color: T.text3, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.1em' }}>{title}</div>}
          {right}
        </div>
      )}
      {hint && <div style={{ fontSize: 11, color: T.text3, marginBottom: 12 }}>{hint}</div>}
      {children}
    </div>
  )
}

function Bar({ pct, color }: { pct: number; color: string }) {
  return (
    <div style={{ height: 6, background: T.bg4, borderRadius: 3, overflow: 'hidden' }}>
      <div style={{ height: '100%', width: `${Math.max(0, Math.min(100, pct))}%`, background: color, transition: 'width .3s' }} />
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div style={{ padding: 40, textAlign: 'center', fontSize: 12, color: T.text3 }}>{children}</div>
}

// Minimal markdown renderer for the AI narratives (###, -, **bold**).
function Markdownish({ md }: { md: string }) {
  const lines = md.split('\n')
  return (
    <div style={{ fontSize: 12.5, lineHeight: 1.65, color: T.text2 }}>
      {lines.map((ln, i) => {
        const t = ln.trim()
        if (!t) return <div key={i} style={{ height: 6 }} />
        const html = t.replace(/\*\*(.+?)\*\*/g, '<strong style="color:var(--t-text)">$1</strong>')
        if (t.startsWith('### ')) return <div key={i} style={{ fontSize: 12, color: T.text, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', margin: '12px 0 4px' }}>{t.slice(4)}</div>
        if (t.startsWith('## ')) return <div key={i} style={{ fontSize: 13, color: T.text, fontWeight: 600, margin: '12px 0 4px' }}>{t.slice(3)}</div>
        if (/^[-*]\s/.test(t)) return <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 3 }}><span style={{ color: T.accent }}>•</span><span dangerouslySetInnerHTML={{ __html: html.replace(/^[-*]\s/, '') }} /></div>
        return <div key={i} style={{ marginBottom: 4 }} dangerouslySetInnerHTML={{ __html: html }} />
      })}
    </div>
  )
}

// On-demand AI summary fetcher.
type SummaryState = { loading: boolean; error: string; data: any | null }
function useSummary(kind: 'coaching' | 'why_no_booking' | 'sentiment', params: { startDate: string; endDate: string; agent: string }) {
  const [state, setState] = useState<SummaryState>({ loading: false, error: '', data: null })
  // Reset whenever the range/agent changes — a cached summary no longer applies.
  useEffect(() => { setState({ loading: false, error: '', data: null }) }, [params.startDate, params.endDate, params.agent, kind])
  const generate = useCallback(async () => {
    setState(s => ({ ...s, loading: true, error: '' }))
    try {
      const r = await fetch('/api/calls/insights/summary', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...params, kind }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.message || d.error || `HTTP ${r.status}`)
      setState({ loading: false, error: '', data: d })
    } catch (e: any) {
      setState({ loading: false, error: e?.message || 'Failed', data: null })
    }
  }, [kind, params])
  return { ...state, generate }
}

function GenerateBar({ label, loading, onClick, hasData }: { label: string; loading: boolean; onClick: () => void; hasData: boolean }) {
  return (
    <button onClick={onClick} disabled={loading}
      style={{ padding: '6px 13px', borderRadius: 6, border: 'none', background: loading ? T.bg4 : T.purple, color: loading ? T.text3 : '#fff', fontSize: 11.5, fontWeight: 600, cursor: loading ? 'wait' : 'pointer', fontFamily: 'inherit' }}>
      {loading ? 'Generating…' : hasData ? `↻ Regenerate ${label}` : `✨ Generate ${label}`}
    </button>
  )
}

// ── Data hook ───────────────────────────────────────────────────────────────

function useInsights(startDate: string, endDate: string, agent: string) {
  const [data, setData] = useState<CallsInsights | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    setLoading(true); setError('')
    const params = new URLSearchParams({ startDate, endDate })
    if (agent && agent !== 'all') params.set('agent', agent)
    fetch(`/api/calls/insights?${params.toString()}`)
      .then(async r => { const d = await r.json(); if (!r.ok) throw new Error(d.message || d.error || `HTTP ${r.status}`); return d })
      .then(d => { if (!cancelled) setData(d) })
      .catch(e => { if (!cancelled) setError(e?.message || 'Failed to load') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [startDate, endDate, agent])

  return { data, loading, error }
}

// ── Main switch ─────────────────────────────────────────────────────────────

export default function CallInsights({ view, startDate, endDate, agent, onOpenCall }: {
  view: Exclude<CallView, 'overview'>
  startDate: string; endDate: string; agent: string
  onOpenCall?: (callId: string) => void
}) {
  const { data, loading, error } = useInsights(startDate, endDate, agent)
  const params = { startDate, endDate, agent }

  if (loading) return <Empty>Crunching call data…</Empty>
  if (error) return <Empty><span style={{ color: T.amber }}>{error}</span></Empty>
  if (!data) return <Empty>No data.</Empty>

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <MetaStrip meta={data.meta} />
      {view === 'sentiment'  && <SentimentView data={data} params={params} />}
      {view === 'coaching'   && <CoachingView data={data} params={params} />}
      {view === 'words'      && <WordsView data={data} params={params} />}
      {view === 'conversion' && <ConversionView data={data} onOpenCall={onOpenCall} />}
    </div>
  )
}

function MetaStrip({ meta }: { meta: CallsInsights['meta'] }) {
  return (
    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 11, color: T.text3, fontFamily: 'monospace' }}>
      <span>{meta.totalCalls} calls{meta.truncated ? ' (capped)' : ''}</span>
      <span>{meta.answered} answered</span>
      <span style={{ color: meta.transcribed ? T.text3 : T.amber }}>{meta.transcribed} transcribed</span>
      <span style={{ color: meta.analysed ? T.text3 : T.amber }}>{meta.analysed} analysed</span>
      {meta.analysed === 0 && <span style={{ color: T.amber }}>· no analysed calls in range — transcribe/analyse pipeline may be paused</span>}
    </div>
  )
}

// ── Sentiment view ──────────────────────────────────────────────────────────

const sentColor = (s: number | null) => s == null ? T.text3 : s >= 65 ? T.green : s >= 40 ? T.amber : T.red

function SentimentView({ data, params }: { data: CallsInsights; params: any }) {
  const s = data.sentiment
  const sum = useSummary('sentiment', params)
  const total = s.overall.positive + s.overall.neutral + s.overall.negative
  if (total === 0) return <Empty>No analysed calls to score sentiment for this range.</Empty>
  const maxTrend = Math.max(...s.trend.map(t => t.count), 1)

  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 14 }}>
        <Card title="Overall sentiment">
          <div style={{ fontSize: 34, fontWeight: 300, fontFamily: "'DM Mono',monospace", color: sentColor(s.avgScore), lineHeight: 1 }}>
            {s.avgScore ?? '—'}<span style={{ fontSize: 13, color: T.text3 }}>/100</span>
          </div>
          <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {([['positive', T.green], ['neutral', T.amber], ['negative', T.red]] as const).map(([k, c]) => (
              <div key={k}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 3 }}>
                  <span style={{ color: T.text2, textTransform: 'capitalize' }}>{k}</span>
                  <span style={{ fontFamily: 'monospace', color: T.text }}>{s.overall[k]} ({Math.round(s.overall[k] / total * 100)}%)</span>
                </div>
                <Bar pct={s.overall[k] / total * 100} color={c} />
              </div>
            ))}
          </div>
        </Card>

        <Card title="By advisor">
          {s.byAdvisor.length === 0 ? <Empty>No advisor data.</Empty> : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {s.byAdvisor.map(a => (
                <div key={a.advisor} style={{ display: 'grid', gridTemplateColumns: '150px 1fr 54px', gap: 10, alignItems: 'center' }}>
                  <div style={{ fontSize: 12, color: T.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.advisor}<span style={{ color: T.text3, fontSize: 10 }}> · {a.analysed}</span></div>
                  <Bar pct={a.avgScore} color={sentColor(a.avgScore)} />
                  <div style={{ fontSize: 12, fontFamily: 'monospace', color: sentColor(a.avgScore), textAlign: 'right' }}>{a.avgScore}</div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {s.trend.length > 1 && (
        <Card title="Daily trend">
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 90 }}>
            {s.trend.map(t => (
              <div key={t.date} title={`${t.date}: ${t.avgScore}/100 (${t.count} calls)`} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                <div style={{ width: '100%', height: `${t.avgScore}%`, minHeight: 2, background: sentColor(t.avgScore), borderRadius: 2, opacity: 0.4 + 0.6 * (t.count / maxTrend) }} />
                <div style={{ fontSize: 8, color: T.text3, fontFamily: 'monospace', transform: 'rotate(-45deg)', whiteSpace: 'nowrap' }}>{t.date.slice(5)}</div>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card title="AI sentiment read" right={<GenerateBar label="read" loading={sum.loading} onClick={sum.generate} hasData={!!sum.data} />}
        hint="Derived from rapport + outcome + objections — directional, not exact.">
        {sum.error && <div style={{ fontSize: 12, color: T.red }}>{sum.error}</div>}
        {sum.data?.markdown ? <Markdownish md={sum.data.markdown} />
          : sum.data?.message ? <div style={{ fontSize: 12, color: T.text3 }}>{sum.data.message}</div>
          : !sum.loading && <div style={{ fontSize: 12, color: T.text3 }}>Press Generate for a written summary.</div>}
      </Card>
    </>
  )
}

// ── Coaching view ───────────────────────────────────────────────────────────

// Dimension keys vary by call type (v4 rubric) — render whatever averages
// exist for the advisor and label them via the shared helper.

function CoachingView({ data, params }: { data: CallsInsights; params: any }) {
  const sum = useSummary('coaching', params)
  const tipsByAdvisor = useMemo(() => {
    const m = new Map<string, { headline?: string; tips: string[] }>()
    for (const a of (sum.data?.advisors || [])) m.set(a.advisor, { headline: a.headline, tips: a.tips || [] })
    return m
  }, [sum.data])

  if (data.coaching.length === 0) return <Empty>No analysed calls to coach on for this range.</Empty>

  return (
    <>
      <Card right={<GenerateBar label="tips" loading={sum.loading} onClick={sum.generate} hasData={!!sum.data} />}>
        <div style={{ fontSize: 12, color: T.text2 }}>
          Recurring coaching notes are aggregated per advisor below. Press <strong style={{ color: T.text }}>Generate tips</strong> to turn them into concrete actions.
          {sum.error && <span style={{ color: T.red }}> · {sum.error}</span>}
          {sum.data?.message && <span style={{ color: T.text3 }}> · {sum.data.message}</span>}
        </div>
      </Card>

      {data.coaching.map(a => {
        const ai = tipsByAdvisor.get(a.advisor)
        return (
          <Card key={a.advisor}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12 }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: T.text }}>{a.advisor}</div>
              <div style={{ fontSize: 10, color: T.text3, fontFamily: 'monospace' }}>
                {a.analysed} analysed · avg score {a.avgSalesScore ?? '—'}{a.weakestDimension ? ` · weakest: ${dimensionLabel(a.weakestDimension)}` : ''}
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              {/* Dimensions */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                {Object.keys(a.dimensionAvgs).map(d => {
                  const v = a.dimensionAvgs[d]
                  if (v == null) return null
                  const weak = d === a.weakestDimension
                  return (
                    <div key={d} style={{ display: 'grid', gridTemplateColumns: '110px 1fr 30px', gap: 8, alignItems: 'center' }}>
                      <div style={{ fontSize: 11, color: weak ? T.amber : T.text2 }}>{dimensionLabel(d)}</div>
                      <Bar pct={v * 10} color={v * 10 >= 70 ? T.green : v * 10 >= 40 ? T.amber : T.red} />
                      <div style={{ fontSize: 10, fontFamily: 'monospace', color: T.text3, textAlign: 'right' }}>{v}</div>
                    </div>
                  )
                })}
              </div>

              {/* Recurring notes or AI tips */}
              <div>
                {ai ? (
                  <>
                    {ai.headline && <div style={{ fontSize: 11, color: T.purple, marginBottom: 6, fontStyle: 'italic' }}>{ai.headline}</div>}
                    <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12, color: T.text2, lineHeight: 1.6 }}>
                      {ai.tips.map((t, i) => <li key={i} style={{ marginBottom: 4 }}>{t}</li>)}
                    </ul>
                  </>
                ) : (
                  <>
                    <div style={{ fontSize: 9, color: T.text3, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>Recurring notes</div>
                    {a.topImprovements.length === 0 ? <div style={{ fontSize: 11, color: T.text3, fontStyle: 'italic' }}>No improvement notes recorded.</div> : (
                      <ul style={{ margin: 0, paddingLeft: 16, fontSize: 11.5, color: T.text2, lineHeight: 1.55 }}>
                        {a.topImprovements.map((t, i) => <li key={i} style={{ marginBottom: 3 }}>{t.term}{t.count > 1 && <span style={{ color: T.text3 }}> ×{t.count}</span>}</li>)}
                      </ul>
                    )}
                  </>
                )}
              </div>
            </div>
          </Card>
        )
      })}
    </>
  )
}

// ── Words & objections view ─────────────────────────────────────────────────

function WordsView({ data, params }: { data: CallsInsights; params: any }) {
  const w = data.words
  const sum = useSummary('why_no_booking', params)
  const maxKw = Math.max(...w.keywords.map(k => k.count), 1)
  const maxWord = Math.max(...w.top.map(t => t.count), 1)

  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <Card title="Topics mentioned" hint="How often key topics come up across transcribed calls.">
          {w.keywords.length === 0 ? <Empty>No transcripts in range.</Empty> : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
              {w.keywords.map(k => (
                <div key={k.label} style={{ display: 'grid', gridTemplateColumns: '130px 1fr 64px', gap: 10, alignItems: 'center' }}>
                  <div style={{ fontSize: 11.5, color: T.text2 }}>{k.label}</div>
                  <Bar pct={k.count / maxKw * 100} color={T.amber} />
                  <div style={{ fontSize: 10, fontFamily: 'monospace', color: T.text3, textAlign: 'right' }}>{k.count} · {k.callCount} calls</div>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card title="Top customer objections" hint="Pulled from AI call analysis.">
          {data.objections.top.length === 0 ? <Empty>No objections recorded.</Empty> : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 320, overflow: 'auto' }}>
              {data.objections.top.map((o, i) => (
                <div key={i} style={{ display: 'flex', gap: 8, fontSize: 12, color: T.text2, lineHeight: 1.4 }}>
                  <span style={{ fontFamily: 'monospace', color: T.amber, flexShrink: 0 }}>{o.count}×</span>
                  <span>{o.term}</span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <Card title="Most-used words" hint="Common words across transcripts (filler words removed).">
        {w.top.length === 0 ? <Empty>No transcripts in range.</Empty> : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
            {w.top.map(t => {
              const scale = 0.8 + (t.count / maxWord) * 1.1
              return (
                <span key={t.term} title={`${t.count} mentions`} style={{
                  padding: '4px 10px', borderRadius: 14, background: T.bg3, border: `1px solid ${T.border}`,
                  fontSize: Math.round(11 * scale), color: T.text2,
                }}>
                  {t.term} <span style={{ color: T.text3, fontFamily: 'monospace', fontSize: 10 }}>{t.count}</span>
                </span>
              )
            })}
          </div>
        )}
      </Card>

      <Card title="Why people don't book in" right={<GenerateBar label="analysis" loading={sum.loading} onClick={sum.generate} hasData={!!sum.data} />}
        hint="AI reads the objections + non-booking call summaries to explain lost bookings.">
        {sum.error && <div style={{ fontSize: 12, color: T.red }}>{sum.error}</div>}
        {sum.data?.markdown ? <Markdownish md={sum.data.markdown} />
          : sum.data?.message ? <div style={{ fontSize: 12, color: T.text3 }}>{sum.data.message}</div>
          : !sum.loading && <div style={{ fontSize: 12, color: T.text3 }}>Press Generate for the breakdown.</div>}
      </Card>
    </>
  )
}

// ── Conversion view ─────────────────────────────────────────────────────────

const OUTCOME_LABELS: Record<string, string> = {
  sale: 'Sale', quote_given: 'Quote given', callback_scheduled: 'Callback scheduled',
  information_only: 'Information only', no_outcome: 'No outcome', wrong_number: 'Wrong number',
}

function ConversionView({ data, onOpenCall }: { data: CallsInsights; onOpenCall?: (id: string) => void }) {
  const c = data.conversion
  const f = c.funnel
  const stages = [
    { label: 'Answered inbound', value: f.answeredInbound, color: T.blue },
    { label: 'Engaged (analysed)', value: f.engaged, color: T.teal },
    { label: 'Quoted', value: f.quoted, color: T.amber },
    { label: 'Booked', value: f.booked, color: T.green },
  ]
  const top = Math.max(f.answeredInbound, 1)

  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <Card title="Conversion funnel">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {stages.map((s, i) => (
              <div key={s.label}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, marginBottom: 4 }}>
                  <span style={{ color: T.text2 }}>{s.label}</span>
                  <span style={{ fontFamily: 'monospace', color: T.text }}>
                    {s.value}{i > 0 && stages[0].value > 0 && <span style={{ color: T.text3 }}> · {Math.round(s.value / stages[0].value * 100)}%</span>}
                  </span>
                </div>
                <Bar pct={s.value / top * 100} color={s.color} />
              </div>
            ))}
          </div>
        </Card>

        <Card title="Outcomes">
          {c.outcomeCounts.length === 0 ? <Empty>No analysed calls.</Empty> : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {c.outcomeCounts.map(o => {
                const max = Math.max(...c.outcomeCounts.map(x => x.count), 1)
                return (
                  <div key={o.term} style={{ display: 'grid', gridTemplateColumns: '130px 1fr 30px', gap: 10, alignItems: 'center' }}>
                    <div style={{ fontSize: 11.5, color: T.text2 }}>{OUTCOME_LABELS[o.term] || o.term}</div>
                    <Bar pct={o.count / max * 100} color={o.term === 'sale' || o.term === 'callback_scheduled' ? T.green : o.term === 'quote_given' ? T.amber : T.text3} />
                    <div style={{ fontSize: 10, fontFamily: 'monospace', color: T.text3, textAlign: 'right' }}>{o.count}</div>
                  </div>
                )
              })}
            </div>
          )}
        </Card>
      </div>

      <Card title="Conversion by advisor">
        {c.byAdvisor.length === 0 ? <Empty>No advisor data.</Empty> : (
          <div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 70px 70px 70px 90px', gap: 8, padding: '0 2px 8px', fontSize: 9, color: T.text3, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
              <div>Advisor</div><div style={{ textAlign: 'right' }}>Qualified</div><div style={{ textAlign: 'right' }}>Quotes</div><div style={{ textAlign: 'right' }}>Booked</div><div style={{ textAlign: 'right' }}>Conv. rate</div>
            </div>
            {c.byAdvisor.map(a => (
              <div key={a.advisor} style={{ display: 'grid', gridTemplateColumns: '1fr 70px 70px 70px 90px', gap: 8, padding: '7px 2px', borderTop: `1px solid ${T.border}`, alignItems: 'center', fontSize: 12 }}>
                <div style={{ color: T.text }}>{a.advisor}</div>
                <div style={{ textAlign: 'right', fontFamily: 'monospace', color: T.text2 }}>{a.qualified}</div>
                <div style={{ textAlign: 'right', fontFamily: 'monospace', color: T.text2 }}>{a.quotes}</div>
                <div style={{ textAlign: 'right', fontFamily: 'monospace', color: T.text2 }}>{a.bookings}</div>
                <div style={{ textAlign: 'right', fontFamily: 'monospace', color: a.conversionRate >= 50 ? T.green : a.conversionRate >= 25 ? T.amber : T.red }}>{a.conversionRate}%</div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title="Missed opportunities" hint="Engaged calls that showed buying signals (a quote or a strong score) but didn't book.">
        {c.missedOpportunities.length === 0 ? <Empty>None — nice.</Empty> : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {c.missedOpportunities.map(m => (
              <div key={m.callId} onClick={() => onOpenCall?.(m.callId)}
                style={{ display: 'grid', gridTemplateColumns: '1fr 140px 110px 50px', gap: 8, padding: '8px 6px', borderRadius: 5, alignItems: 'center', cursor: onOpenCall ? 'pointer' : 'default', fontSize: 12 }}
                onMouseEnter={e => { if (onOpenCall) (e.currentTarget as HTMLElement).style.background = 'rgba(var(--t-ink),0.03)' }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}>
                <div style={{ color: T.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.externalLabel}</div>
                <div style={{ color: T.text2 }}>{m.advisor}</div>
                <div style={{ color: T.amber, fontSize: 11 }}>{OUTCOME_LABELS[m.outcome] || m.outcome}</div>
                <div style={{ textAlign: 'right', fontFamily: 'monospace', color: T.text3 }}>{m.salesScore ?? '—'}</div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </>
  )
}
