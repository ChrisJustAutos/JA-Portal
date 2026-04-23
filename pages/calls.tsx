// ── Analysis panel (in call detail drawer) ────────────────────────────────
// Phase 3 deliverable: pulls the Claude-generated coaching analysis for a call.
// Auto-enqueued by transcribe.js after every transcription completes for calls
// with duration >= 60 sec. Shows dimension scores, strengths, improvements,
// and a summary. Allows manual re-run (e.g. after rubric updates).

interface AnalysisData {
  id: string
  rubric_version: string
  outcome: string
  outcome_confidence: number | null
  sales_score: number
  dimension_scores: { discovery: number; product_knowledge: number; objection_handling: number; closing: number; rapport: number }
  observations: {
    strengths: string[]
    improvements: string[]
    objections_raised?: string[]
    quotes_given?: string[]
    next_actions?: string[]
  }
  summary: string
  model: string
  cost_micro_usd: number
  analysed_at: string
}

interface AnalysisJobStatus {
  id: string
  status: 'pending' | 'processing' | 'done' | 'failed' | 'skipped'
  created_at: string
  error_message: string | null
}

function AnalysisPanel({ callId, hasTranscript, billsecSeconds }: { callId: string; hasTranscript: boolean; billsecSeconds: number }) {
  const [analysis, setAnalysis] = useState<AnalysisData | null>(null)
  const [job, setJob] = useState<AnalysisJobStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [enqueueing, setEnqueueing] = useState(false)
  const [errorMsg, setErrorMsg] = useState('')

  async function loadStatus() {
    try {
      const [analysisRes, jobRes] = await Promise.all([
        fetch(`/api/calls/${callId}/analysis`),
        fetch(`/api/calls/${callId}/analyse`),
      ])
      if (analysisRes.ok) {
        const data = await analysisRes.json()
        setAnalysis(data.analysis)
      }
      if (jobRes.ok) {
        const data = await jobRes.json()
        setJob(data.job || null)
      }
    } catch (e: any) {
      setErrorMsg(e?.message || 'Failed to load')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadStatus() }, [callId])  // eslint-disable-line react-hooks/exhaustive-deps

  // Poll job status every 10 seconds while pending/processing
  useEffect(() => {
    if (analysis) return  // stop polling once we have analysis
    if (!job || (job.status !== 'pending' && job.status !== 'processing')) return
    const timer = setInterval(() => loadStatus(), 10_000)
    return () => clearInterval(timer)
  }, [job, analysis])  // eslint-disable-line react-hooks/exhaustive-deps

  async function handleAnalyse() {
    setEnqueueing(true); setErrorMsg('')
    try {
      const res = await fetch(`/api/calls/${callId}/analyse`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) {
        setErrorMsg(data.message || data.error || `HTTP ${res.status}`)
      } else {
        setJob(data.job || { status: 'pending' } as any)
      }
    } catch (e: any) {
      setErrorMsg(e?.message || 'Failed to queue')
    } finally {
      setEnqueueing(false)
    }
  }

  // Hide the whole panel if the call can't be analysed
  if (!hasTranscript) return null
  if (billsecSeconds < 60) return null

  const scoreColor = (score: number) => {
    if (score >= 70) return T.green
    if (score >= 40) return T.amber
    return T.red
  }

  const dimensionLabel = (key: string) => {
    switch (key) {
      case 'discovery': return 'Discovery'
      case 'product_knowledge': return 'Product Knowledge'
      case 'objection_handling': return 'Objection Handling'
      case 'closing': return 'Closing'
      case 'rapport': return 'Rapport'
      default: return key
    }
  }

  const outcomeLabel = (key: string) => {
    switch (key) {
      case 'sale': return 'Sale'
      case 'quote_given': return 'Quote given'
      case 'callback_scheduled': return 'Callback scheduled'
      case 'information_only': return 'Information only'
      case 'no_outcome': return 'No outcome'
      case 'wrong_number': return 'Wrong number'
      default: return key.replace(/_/g, ' ')
    }
  }

  return (
    <div style={{ border: `1px solid ${T.border2}`, borderRadius: 6, padding: 16, background: T.bg3 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10, alignItems: 'center' }}>
        <div style={{ fontSize: 10, color: T.text3, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.1em' }}>AI Coaching Analysis</div>
        {analysis && (
          <div style={{ fontSize: 9, color: T.text3, textTransform: 'uppercase', letterSpacing: '0.1em', fontFamily: 'monospace' }}>
            {analysis.model.includes('opus') ? 'Opus' : 'Haiku'} · {new Date(analysis.analysed_at).toLocaleDateString('en-AU')}
          </div>
        )}
      </div>

      {loading && (
        <div style={{ fontSize: 12, color: T.text3, fontStyle: 'italic' }}>Checking analysis status…</div>
      )}

      {!loading && !analysis && !job && (
        <div>
          <div style={{ fontSize: 12, color: T.text2, marginBottom: 10 }}>
            This call hasn't been analysed yet. Claude will score sales performance and suggest coaching notes.
          </div>
          <button onClick={handleAnalyse} disabled={enqueueing}
            style={{ padding: '7px 14px', background: T.purple, color: '#fff', border: 'none', borderRadius: 5, fontSize: 12, cursor: enqueueing ? 'wait' : 'pointer', fontFamily: 'inherit', fontWeight: 500 }}>
            {enqueueing ? 'Queueing…' : '▶ Analyse this call'}
          </button>
          {errorMsg && <div style={{ marginTop: 8, fontSize: 11, color: T.red }}>{errorMsg}</div>}
        </div>
      )}

      {!loading && !analysis && job && (job.status === 'pending' || job.status === 'processing') && (
        <div style={{ fontSize: 12, color: T.amber }}>
          <span style={{ display: 'inline-block', animation: 'spin 1.5s linear infinite', marginRight: 8 }}>⟳</span>
          Analysis {job.status}. Worker runs every ~3 minutes. This panel will auto-refresh.
        </div>
      )}

      {!loading && !analysis && job && job.status === 'failed' && (
        <div>
          <div style={{ fontSize: 12, color: T.red, marginBottom: 8 }}>Analysis failed: {job.error_message}</div>
          <button onClick={handleAnalyse} disabled={enqueueing}
            style={{ padding: '5px 12px', background: 'transparent', color: T.purple, border: `1px solid ${T.border2}`, borderRadius: 4, fontSize: 11, cursor: 'pointer', fontFamily: 'inherit' }}>
            Retry
          </button>
        </div>
      )}

      {!loading && !analysis && job && job.status === 'skipped' && (
        <div style={{ fontSize: 12, color: T.text3, fontStyle: 'italic' }}>
          Skipped — {job.error_message || 'Call did not qualify for analysis.'}
        </div>
      )}

      {analysis && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Summary */}
          <div style={{ fontSize: 12, color: T.text, lineHeight: 1.6, background: T.bg2, padding: 12, borderRadius: 4, border: `1px solid ${T.border}` }}>
            {analysis.summary}
          </div>

          {/* Headline stats: outcome + overall score */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 4, padding: 12 }}>
              <div style={{ fontSize: 9, color: T.text3, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 6 }}>Outcome</div>
              <div style={{ fontSize: 14, color: T.text, fontWeight: 400 }}>{outcomeLabel(analysis.outcome)}</div>
              {analysis.outcome_confidence !== null && (
                <div style={{ fontSize: 10, color: T.text3, fontFamily: 'monospace', marginTop: 3 }}>
                  {Math.round(analysis.outcome_confidence * 100)}% confidence
                </div>
              )}
            </div>
            <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 4, padding: 12 }}>
              <div style={{ fontSize: 9, color: T.text3, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 6 }}>Sales Score</div>
              <div style={{ fontSize: 24, fontWeight: 300, color: scoreColor(analysis.sales_score), lineHeight: 1, fontFamily: "'DM Mono', monospace" }}>
                {analysis.sales_score}<span style={{ fontSize: 12, color: T.text3 }}>/100</span>
              </div>
            </div>
          </div>

          {/* Dimension scores */}
          <div>
            <div style={{ fontSize: 9, color: T.text3, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 8 }}>Dimensions</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {(['discovery','product_knowledge','objection_handling','closing','rapport'] as const).map(key => {
                const score = analysis.dimension_scores[key]
                const pct = Math.max(0, Math.min(10, score)) * 10
                return (
                  <div key={key} style={{ display: 'grid', gridTemplateColumns: '140px 1fr 30px', gap: 10, alignItems: 'center' }}>
                    <div style={{ fontSize: 11, color: T.text2 }}>{dimensionLabel(key)}</div>
                    <div style={{ height: 6, background: T.bg2, borderRadius: 3, overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${pct}%`, background: scoreColor(score * 10), transition: 'width 0.3s ease' }} />
                    </div>
                    <div style={{ fontSize: 10, color: T.text3, fontFamily: 'monospace', textAlign: 'right' }}>{score}/10</div>
                  </div>
                )
              })}
            </div>
          </div>

          {/* Observations — strengths & improvements */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 4, padding: 12 }}>
              <div style={{ fontSize: 9, color: T.green, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 8 }}>✓ Strengths</div>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 11, color: T.text2, lineHeight: 1.55 }}>
                {analysis.observations.strengths?.length ? analysis.observations.strengths.map((s, i) => (
                  <li key={i} style={{ marginBottom: 4 }}>{s}</li>
                )) : <li style={{ color: T.text3, fontStyle: 'italic', listStyle: 'none', marginLeft: -18 }}>None identified</li>}
              </ul>
            </div>
            <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 4, padding: 12 }}>
              <div style={{ fontSize: 9, color: T.amber, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 8 }}>△ Improvements</div>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 11, color: T.text2, lineHeight: 1.55 }}>
                {analysis.observations.improvements?.length ? analysis.observations.improvements.map((s, i) => (
                  <li key={i} style={{ marginBottom: 4 }}>{s}</li>
                )) : <li style={{ color: T.text3, fontStyle: 'italic', listStyle: 'none', marginLeft: -18 }}>None identified</li>}
              </ul>
            </div>
          </div>

          {/* Optional sections — only rendered if populated */}
          {(analysis.observations.objections_raised?.length ?? 0) > 0 && (
            <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 4, padding: 12 }}>
              <div style={{ fontSize: 9, color: T.text3, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 6 }}>Objections Raised</div>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 11, color: T.text2, lineHeight: 1.55 }}>
                {analysis.observations.objections_raised!.map((s, i) => <li key={i}>{s}</li>)}
              </ul>
            </div>
          )}

          {(analysis.observations.quotes_given?.length ?? 0) > 0 && (
            <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 4, padding: 12 }}>
              <div style={{ fontSize: 9, color: T.text3, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 6 }}>Quotes Given</div>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 11, color: T.text2, lineHeight: 1.55 }}>
                {analysis.observations.quotes_given!.map((s, i) => <li key={i}>{s}</li>)}
              </ul>
            </div>
          )}

          {(analysis.observations.next_actions?.length ?? 0) > 0 && (
            <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 4, padding: 12 }}>
              <div style={{ fontSize: 9, color: T.text3, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 6 }}>Next Actions</div>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 11, color: T.text2, lineHeight: 1.55 }}>
                {analysis.observations.next_actions!.map((s, i) => <li key={i}>{s}</li>)}
              </ul>
            </div>
          )}

          {/* Footer metadata */}
          <div style={{ fontSize: 10, color: T.text3, fontFamily: 'monospace', display: 'flex', justifyContent: 'space-between', borderTop: `1px solid ${T.border}`, paddingTop: 8 }}>
            <span>Rubric {analysis.rubric_version} · ${(analysis.cost_micro_usd / 1_000_000).toFixed(4)}</span>
            <button onClick={handleAnalyse} disabled={enqueueing}
              style={{ background: 'transparent', color: T.text3, border: 'none', fontSize: 10, cursor: 'pointer', fontFamily: 'inherit', textDecoration: 'underline' }}>
              {enqueueing ? 'Queueing…' : 'Re-analyse'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
