// pages/calls.tsx
// Phone call analytics page. Lists all inbound/outbound calls from FreePBX CDR
// (pushed to Supabase by ja-cdr-sync agent). Per-agent stats, filtering, drill-down.
// Phase 1 of 3 — Phase 2 adds transcription, Phase 3 adds AI coaching analysis.

import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import Head from 'next/head'
import { useRouter } from 'next/router'
import PortalTopBar from '../lib/PortalTopBar'
import { useIsMobile } from '../lib/useIsMobile'
import { requirePageAuth } from '../lib/authServer'
import { roleHasPermission } from '../lib/permissions'
import { useChatContext } from '../components/GlobalChatbot'
import { groupCalls, type LiveChannel, type LiveCallCard, type SpyMode } from '../lib/live-calls'
import CallInsights, { CallTabBar, type CallView } from '../components/calls/CallInsights'

interface PortalUserSSR { id: string; email: string; displayName: string | null; role: 'admin'|'manager'|'sales'|'accountant'|'viewer' }

interface CallRow {
  id: string
  linkedid: string
  call_date: string
  direction: 'inbound' | 'outbound'
  external_number: string | null
  caller_name: string | null
  agent_ext: string | null
  agent_name: string | null
  effective_advisor_name: string | null
  duration_seconds: number
  billsec_seconds: number
  disposition: string
  call_type: string | null
  has_recording: boolean
  transcript_status: string | null
  sales_score: number | null
}

interface AgentStats {
  key: string                 // advisor filter token: "slack:<id>" | "ext:<n>"
  extension: string           // == key (kept for compat)
  ext_label: string | null    // extension number, or null for identified hot-deskers
  display_name: string
  role: string | null
  today_total: number
  today_answered_inbound: number
  today_outbound: number
  today_talk_seconds: number
  week_talk_seconds: number
}

interface StatsPayload {
  periodLabel: string
  today: {
    total: number; inbound: number; outbound: number; answered: number
    missed_inbound: number; talk_seconds: number; avg_call_seconds: number; answer_rate: number
  }
  week: { total: number; talk_seconds: number }
  agents: AgentStats[]
  sync: { last_synced_at: string | null; last_error: string | null; records_synced_total: number }
}

const T = {
  bg: '#0d0f12', bg2: '#131519', bg3: '#1a1d23', bg4: '#21252d',
  border: 'rgba(255,255,255,0.07)', border2: 'rgba(255,255,255,0.12)',
  text: '#e8eaf0', text2: '#8b90a0', text3: '#545968',
  blue: '#4f8ef7', teal: '#2dd4bf', green: '#34c77b',
  amber: '#f5a623', red: '#f04e4e', purple: '#a78bfa',
  accent: '#4f8ef7',
}

// ── Date helpers ───────────────────────────────────────────────────────────

function toYmd(d: Date): string {
  // Returns YYYY-MM-DD in Brisbane local time (UTC+10, no DST)
  const brisbane = new Date(d.getTime() + 10 * 3600 * 1000)
  return brisbane.toISOString().slice(0, 10)
}

function ymdToday(): string { return toYmd(new Date()) }

function ymdDaysAgo(n: number): string {
  const d = new Date(); d.setDate(d.getDate() - n)
  return toYmd(d)
}

function ymdStartOfMonth(): string {
  const d = new Date(); d.setDate(1)
  return toYmd(d)
}

function ymdStartOfFY(year: number): string {
  // Australian FY starts 1 July. FY2026 = 1 July 2025 → 30 June 2026.
  return `${year - 1}-07-01`
}

function ymdEndOfFY(year: number): string {
  return `${year}-06-30`
}

function currentFY(): number {
  const now = new Date()
  const m = now.getMonth() + 1  // 1-12
  return m >= 7 ? now.getFullYear() + 1 : now.getFullYear()
}

// ── Formatting helpers ─────────────────────────────────────────────────────

function formatDuration(seconds: number | null): string {
  if (!seconds || seconds <= 0) return '—'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

function formatDurationLong(seconds: number | null): string {
  if (!seconds || seconds <= 0) return '0m'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

function formatPhone(num: string | null): string {
  if (!num) return ''
  if (num === 'anonymous') return 'Anonymous'
  const clean = num.replace(/\D/g, '')
  if (clean.length >= 10 && clean.startsWith('04')) {
    return `${clean.slice(0, 4)} ${clean.slice(4, 7)} ${clean.slice(7)}`
  }
  if (clean.length === 10 && clean.startsWith('0')) {
    return `(${clean.slice(0, 2)}) ${clean.slice(2, 6)} ${clean.slice(6)}`
  }
  if (clean.length === 8) return `${clean.slice(0, 4)} ${clean.slice(4)}`
  return num
}

function formatRelative(iso: string): string {
  const d = new Date(iso)
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1)
  const dDate = new Date(d); dDate.setHours(0, 0, 0, 0)
  const timeStr = d.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', hour12: false })
  if (dDate.getTime() === today.getTime()) return `Today ${timeStr}`
  if (dDate.getTime() === yesterday.getTime()) return `Yesterday ${timeStr}`
  return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' }) + ' ' + timeStr
}

function formatSyncTime(iso: string | null): string {
  if (!iso) return 'never'
  const d = new Date(iso)
  const ago = Math.floor((Date.now() - d.getTime()) / 1000)
  if (ago < 60) return `${ago}s ago`
  if (ago < 3600) return `${Math.floor(ago / 60)}m ago`
  if (ago < 86400) return `${Math.floor(ago / 3600)}h ago`
  return d.toLocaleString('en-AU')
}

// ── Small presentational components ────────────────────────────────────────

function StatCard({ label, value, sublabel, accent }: { label: string; value: string | number; sublabel?: string; accent?: string }) {
  return (
    <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 8, padding: 16 }}>
      <div style={{ fontSize: 10, color: T.text3, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 8 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 300, fontFamily: "'DM Mono', monospace", color: accent || T.text, lineHeight: 1 }}>{value}</div>
      {sublabel && <div style={{ fontSize: 11, color: T.text3, marginTop: 6 }}>{sublabel}</div>}
    </div>
  )
}

function DirectionBadge({ direction, disposition }: { direction: string; disposition: string }) {
  const missed = disposition !== 'ANSWERED'
  const icon = missed ? '✕' : (direction === 'inbound' ? '↓' : '↑')
  const bg = missed ? 'rgba(240,78,78,0.12)' : (direction === 'inbound' ? 'rgba(52,199,123,0.12)' : 'rgba(79,142,247,0.12)')
  const color = missed ? T.red : (direction === 'inbound' ? T.green : T.blue)
  const border = missed ? 'rgba(240,78,78,0.25)' : (direction === 'inbound' ? 'rgba(52,199,123,0.25)' : 'rgba(79,142,247,0.25)')
  return (
    <div style={{ width: 26, height: 26, borderRadius: 5, background: bg, border: `1px solid ${border}`, color, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, flexShrink: 0 }}>
      {icon}
    </div>
  )
}

// ── Recording player ──────────────────────────────────────────────────────
// Fetches a short-lived signed URL from /api/calls/:id/recording-url, then
// renders a standard HTML5 <audio> control. Handles the "not yet uploaded"
// state (202 response) with a soft retry.

function RecordingPlayer({ callId, hasRecording }: { callId: string; hasRecording: boolean }) {
  const [state, setState] = useState<'idle'|'loading'|'ready'|'pending'|'missing'|'error'>('idle')
  const [audioUrl, setAudioUrl] = useState<string | null>(null)
  const [errorMsg, setErrorMsg] = useState<string>('')

  async function loadUrl() {
    setState('loading'); setErrorMsg('')
    try {
      const res = await fetch(`/api/calls/${callId}/recording-url`)
      const data = await res.json()
      if (res.status === 202) {
        setState('pending'); return
      }
      if (res.status === 404) {
        if (data.reason === 'missing_on_disk') setState('missing')
        else setState('error')
        setErrorMsg(data.error || '')
        return
      }
      if (!res.ok) {
        setState('error'); setErrorMsg(data.message || data.error || `HTTP ${res.status}`); return
      }
      setAudioUrl(data.url); setState('ready')
    } catch (e: any) {
      setState('error'); setErrorMsg(e?.message || 'Failed to load')
    }
  }

  useEffect(() => {
    if (hasRecording) loadUrl()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callId])

  if (!hasRecording) return null

  return (
    <div style={{ border: `1px solid ${T.border2}`, borderRadius: 6, padding: 16, background: T.bg3 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
        <div style={{ fontSize: 10, color: T.text3, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.1em' }}>Recording</div>
        {state === 'ready' && (
          <div style={{ fontSize: 9, color: T.green, textTransform: 'uppercase', letterSpacing: '0.1em' }}>● Playing from cloud</div>
        )}
      </div>

      {state === 'loading' && (
        <div style={{ fontSize: 12, color: T.text3, fontStyle: 'italic' }}>Loading…</div>
      )}

      {state === 'pending' && (
        <div style={{ fontSize: 12, color: T.amber }}>
          Recording not yet uploaded to cloud. The sync agent uploads recordings every 5 minutes.
          <button onClick={loadUrl} style={{ marginLeft: 8, padding: '3px 10px', background: 'transparent', color: T.blue, border: `1px solid ${T.border2}`, borderRadius: 4, fontSize: 11, cursor: 'pointer', fontFamily: 'inherit' }}>
            Retry
          </button>
        </div>
      )}

      {state === 'missing' && (
        <div style={{ fontSize: 12, color: T.red }}>
          Recording file not found on FreePBX disk. It may have been deleted by retention policy.
        </div>
      )}

      {state === 'error' && (
        <div style={{ fontSize: 12, color: T.red }}>
          Could not load recording: {errorMsg}
          <button onClick={loadUrl} style={{ marginLeft: 8, padding: '3px 10px', background: 'transparent', color: T.blue, border: `1px solid ${T.border2}`, borderRadius: 4, fontSize: 11, cursor: 'pointer', fontFamily: 'inherit' }}>
            Retry
          </button>
        </div>
      )}

      {state === 'ready' && audioUrl && (
        <audio controls preload="none" src={audioUrl} style={{ width: '100%', height: 40 }}>
          Your browser does not support the audio element.
        </audio>
      )}
    </div>
  )
}

// ── Transcript panel ──────────────────────────────────────────────────────
// Shows "Transcribe" button → polls job status → displays transcript with
// speaker segments once done. Speakers are Deepgram's integer IDs — we
// map them to Agent/Customer based on call direction.

type TranscriptSegment = { speaker: number; start: number; end: number; text: string; confidence: number }
type TranscriptData = {
  full_text: string
  segments: TranscriptSegment[]
  audio_duration_seconds: number | null
  transcribed_at: string
  language: string
}
type JobStatus = { status: 'pending'|'processing'|'done'|'failed'|'skipped'; error_message?: string; created_at?: string } | null

function TranscriptPanel({ callId, hasRecording, direction }: { callId: string; hasRecording: boolean; direction: 'inbound'|'outbound' }) {
  const [transcript, setTranscript] = useState<TranscriptData | null>(null)
  const [job, setJob] = useState<JobStatus>(null)
  const [loading, setLoading] = useState(true)
  const [enqueueing, setEnqueueing] = useState(false)
  const [errorMsg, setErrorMsg] = useState('')

  async function loadStatus() {
    try {
      const [transcriptRes, jobRes] = await Promise.all([
        fetch(`/api/calls/${callId}/transcript`),
        fetch(`/api/calls/${callId}/transcribe`),
      ])
      if (transcriptRes.ok) {
        const data = await transcriptRes.json()
        setTranscript(data.transcript)
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
    if (transcript) return  // nothing to poll for
    if (!job || (job.status !== 'pending' && job.status !== 'processing')) return
    const timer = setInterval(() => loadStatus(), 10_000)
    return () => clearInterval(timer)
  }, [job, transcript])  // eslint-disable-line react-hooks/exhaustive-deps

  async function handleTranscribe() {
    setEnqueueing(true); setErrorMsg('')
    try {
      const res = await fetch(`/api/calls/${callId}/transcribe`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) {
        setErrorMsg(data.message || data.error || `HTTP ${res.status}`)
      } else {
        setJob(data.job || { status: 'pending' })
      }
    } catch (e: any) {
      setErrorMsg(e?.message || 'Failed to queue')
    } finally {
      setEnqueueing(false)
    }
  }

  if (!hasRecording) return null

const speakerLabel = (n: number) => {
    // Deepgram labels speakers 0, 1, 2. Our agents answer inbound with a greeting
    // ("You're through to Just Auto") and initiate outbound calls, so speaker 0 is
    // almost always the agent regardless of direction. For 3-way calls speaker 2
    // is treated as a second customer/third party.
    if (n === 0) return 'Agent'
    if (n === 1) return 'Customer'
    return `Speaker ${n + 1}`
  }
  const speakerColor = (n: number) => {
    const label = speakerLabel(n)
    return label === 'Agent' ? T.blue : T.teal
  }

  return (
    <div style={{ border: `1px solid ${T.border2}`, borderRadius: 6, padding: 16, background: T.bg3 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10, alignItems: 'center' }}>
        <div style={{ fontSize: 10, color: T.text3, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.1em' }}>Transcript</div>
        {transcript && (
          <div style={{ fontSize: 9, color: T.green, textTransform: 'uppercase', letterSpacing: '0.1em' }}>
            ● Transcribed {new Date(transcript.transcribed_at).toLocaleDateString('en-AU')}
          </div>
        )}
      </div>

      {loading && (
        <div style={{ fontSize: 12, color: T.text3, fontStyle: 'italic' }}>Checking transcript status…</div>
      )}

      {!loading && !transcript && !job && (
        <div>
          <div style={{ fontSize: 12, color: T.text2, marginBottom: 10 }}>
            This call hasn't been transcribed yet. Transcription uses Deepgram (~$0.004 per minute of audio).
          </div>
          <button onClick={handleTranscribe} disabled={enqueueing}
            style={{ padding: '7px 14px', background: T.blue, color: '#fff', border: 'none', borderRadius: 5, fontSize: 12, cursor: enqueueing ? 'wait' : 'pointer', fontFamily: 'inherit', fontWeight: 500 }}>
            {enqueueing ? 'Queueing…' : '▶ Transcribe this call'}
          </button>
          {errorMsg && <div style={{ marginTop: 8, fontSize: 11, color: T.red }}>{errorMsg}</div>}
        </div>
      )}

      {!loading && !transcript && job && (job.status === 'pending' || job.status === 'processing') && (
        <div style={{ fontSize: 12, color: T.amber }}>
          <span style={{ display: 'inline-block', animation: 'spin 1.5s linear infinite', marginRight: 8 }}>⟳</span>
          Job {job.status}. Worker runs every ~2 minutes. This panel will auto-refresh.
        </div>
      )}

      {!loading && !transcript && job && job.status === 'failed' && (
        <div>
          <div style={{ fontSize: 12, color: T.red, marginBottom: 8 }}>Transcription failed: {job.error_message}</div>
          <button onClick={handleTranscribe} disabled={enqueueing}
            style={{ padding: '5px 12px', background: 'transparent', color: T.blue, border: `1px solid ${T.border2}`, borderRadius: 4, fontSize: 11, cursor: 'pointer', fontFamily: 'inherit' }}>
            Retry
          </button>
        </div>
      )}

      {!loading && !transcript && job && job.status === 'skipped' && (
        <div style={{ fontSize: 12, color: T.text3, fontStyle: 'italic' }}>
          Skipped — {job.error_message || 'Recording had no transcribable audio.'}
        </div>
      )}

      {transcript && (
        <div>
          <div style={{ maxHeight: 400, overflow: 'auto', fontSize: 12, lineHeight: 1.6, background: T.bg2, padding: 12, borderRadius: 4, border: `1px solid ${T.border}` }}>
            {transcript.segments.length > 0 ? (
              transcript.segments.map((seg, idx) => (
                <div key={idx} style={{ marginBottom: 10, display: 'flex', gap: 10 }}>
                  <div style={{ flexShrink: 0, width: 80, fontSize: 10, color: speakerColor(seg.speaker), fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: 2 }}>
                    {speakerLabel(seg.speaker)}
                    <div style={{ fontSize: 9, color: T.text3, fontFamily: 'monospace', marginTop: 2 }}>
                      {Math.floor(seg.start / 60)}:{String(Math.floor(seg.start % 60)).padStart(2, '0')}
                    </div>
                  </div>
                  <div style={{ flex: 1, color: T.text }}>{seg.text}</div>
                </div>
              ))
            ) : (
              <div style={{ color: T.text2 }}>{transcript.full_text}</div>
            )}
          </div>
          <div style={{ marginTop: 8, fontSize: 10, color: T.text3, fontFamily: 'monospace', display: 'flex', justifyContent: 'space-between' }}>
            <span>{transcript.segments.length} segments · {transcript.full_text.length} chars · {transcript.audio_duration_seconds?.toFixed(0) || '?'}s audio</span>
            <span>Speaker labels are approximate</span>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Batch transcribe button (in call list footer) ──────────────────────────
// Kicks off transcription of up to 50 calls matching the current filter set.

function BatchTranscribeButton({ callCount, filters }: {
  callCount: number;
  filters: { startDate?: string; endDate?: string; agent?: string; direction?: string; disposition?: string }
}) {
  const [state, setState] = useState<'idle'|'confirming'|'queuing'|'done'|'error'>('idle')
  const [message, setMessage] = useState('')

  async function handleSubmit() {
    setState('queuing'); setMessage('')
    try {
      const res = await fetch('/api/calls/transcribe-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...filters, maxJobs: 50 }),
      })
      const data = await res.json()
      if (!res.ok) {
        setState('error'); setMessage(data.message || data.error || `HTTP ${res.status}`)
        return
      }
      setState('done')
      setMessage(data.enqueued > 0
        ? `Queued ${data.enqueued} calls.${data.skipped ? ` (${data.skipped} already done.)` : ''}`
        : data.message || 'Nothing queued.')
    } catch (e: any) {
      setState('error'); setMessage(e?.message || 'Failed')
    }
  }

  if (callCount === 0) return <span>No calls to transcribe</span>

  if (state === 'done' || state === 'error') {
    return <span style={{ color: state === 'done' ? T.green : T.red }}>{message}</span>
  }

  if (state === 'confirming') {
    return (
      <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <span>Transcribe up to 50 of these {callCount} calls?</span>
        <button onClick={handleSubmit} disabled={state !== 'confirming'}
          style={{ padding: '3px 10px', background: T.blue, color: '#fff', border: 'none', borderRadius: 4, fontSize: 10, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600 }}>
          Confirm
        </button>
        <button onClick={() => setState('idle')}
          style={{ padding: '3px 10px', background: 'transparent', color: T.text2, border: `1px solid ${T.border2}`, borderRadius: 4, fontSize: 10, cursor: 'pointer', fontFamily: 'inherit' }}>
          Cancel
        </button>
      </span>
    )
  }

  if (state === 'queuing') {
    return <span style={{ color: T.amber }}>Queuing…</span>
  }

  return (
    <button onClick={() => setState('confirming')}
      style={{ padding: '3px 10px', background: 'transparent', color: T.blue, border: `1px solid ${T.border2}`, borderRadius: 4, fontSize: 10, cursor: 'pointer', fontFamily: 'inherit' }}>
      ▶ Transcribe batch
    </button>
  )
}


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

// ── Main page component ────────────────────────────────────────────────────

// ── Live call monitoring board (management only) ────────────────────────
// Polls /api/calls/live for in-progress calls and lets a manager Listen /
// Whisper / Barge — which rings their own registered handset via the
// FreePBX-side ChanSpy service. Hidden entirely for users without the
// monitor:calls permission.

type ActorKind = 'handset' | 'device'
type SoftphoneStatus = 'idle' | 'connecting' | 'registered' | 'incall' | 'failed' | 'unavailable'

function LiveCallsBoard({ canMonitor }: { canMonitor: boolean }) {
  const isMobile = useIsMobile()
  const [status, setStatus] = useState<'loading' | 'ready' | 'notconfigured' | 'error'>('loading')
  const [channels, setChannels] = useState<LiveChannel[]>([])
  const [stale, setStale] = useState(false)
  const [note, setNote] = useState('')
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; msg: string } | null>(null)
  const [extMap, setExtMap] = useState<Record<string, string>>({})  // extension → staff name
  const [, tick] = useState(0)   // 1s heartbeat so live durations keep counting

  // ── Browser softphone (WebRTC) ──────────────────────────────────────
  const softphoneRef = useRef<any>(null)
  const audioElRef = useRef<HTMLAudioElement | null>(null)
  const [spStatus, setSpStatus] = useState<SoftphoneStatus>('idle')
  const [spReason, setSpReason] = useState<string>('')
  const [activeDeviceMode, setActiveDeviceMode] = useState<SpyMode | null>(null)

  // Create (once) the hidden <audio> element the remote call audio attaches to.
  // playsInline + autoplay are required for iOS/WebKit (incl. Chrome on iOS,
  // which is WebKit under the hood).
  function ensureAudioEl(): HTMLAudioElement {
    if (!audioElRef.current) {
      const el = document.createElement('audio')
      el.autoplay = true
      ;(el as any).playsInline = true
      el.setAttribute('playsinline', '')
      el.setAttribute('autoplay', '')
      el.style.display = 'none'
      document.body.appendChild(el)
      audioElRef.current = el
    }
    return audioElRef.current
  }

  // Lazily set up the audio element and connect the softphone if the user has
  // WebRTC creds configured. Stays as 'idle' until something tries to use it.
  const connectSoftphone = useCallback(async (): Promise<boolean> => {
    if (softphoneRef.current) return spStatus === 'registered' || spStatus === 'incall'
    ensureAudioEl()
    setSpStatus('connecting'); setSpReason('')
    try {
      const r = await fetch('/api/me/webrtc')
      const d = await r.json()
      if (!d.configured) {
        setSpStatus('unavailable')
        setSpReason(d.reason === 'no_extension'
          ? 'No browser extension is set on your profile. Ask an admin to add one in Settings → Users.'
          : 'WebRTC server isn’t configured on the portal. Set NEXT_PUBLIC_FREEPBX_WSS_URL + NEXT_PUBLIC_FREEPBX_SIP_DOMAIN to enable.')
        return false
      }
      const { Softphone } = await import('../lib/softphone')
      const sp = new Softphone({
        wssUrl: d.wss_url, sipDomain: d.sip_domain,
        extension: d.extension, password: d.password,
        audioEl: audioElRef.current!,
      })
      sp.on('status', (s: any, det: any) => {
        if (s === 'registered') setSpStatus(curr => (curr === 'incall' ? 'incall' : 'registered'))
        else if (s === 'connecting') setSpStatus('connecting')
        else if (s === 'failed')     { setSpStatus('failed');     setSpReason(det?.reason || 'register failed') }
        else if (s === 'unregistered') setSpStatus(curr => (curr === 'incall' ? curr : 'idle'))
      })
      sp.on('call', (e: any) => {
        if (e === 'answered') setSpStatus('incall')
        if (e === 'ended')    { setSpStatus('registered'); setActiveDeviceMode(null) }
      })
      softphoneRef.current = sp
      await sp.connect()
      return true
    } catch (e: any) {
      setSpStatus('failed'); setSpReason(e?.message || 'Could not connect softphone')
      return false
    }
  }, [spStatus])

  // Cleanup on unmount.
  useEffect(() => () => {
    try { softphoneRef.current?.disconnect() } catch {}
    if (audioElRef.current) { try { audioElRef.current.remove() } catch {} }
  }, [])

  function hangupDevice() {
    try { softphoneRef.current?.hangup() } catch {}
    setActiveDeviceMode(null)
    setSpStatus(curr => (curr === 'incall' ? 'registered' : curr))
  }

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/calls/live')
      if (r.status === 403) { setStatus('error'); setNote('Not permitted'); return }
      const d = await r.json()
      if (d.extensions) setExtMap(d.extensions)
      if (d.configured === false) { setStatus('notconfigured'); return }
      setChannels(Array.isArray(d.calls) ? d.calls : [])
      setStale(!!d.stale)
      setNote(d.error || '')
      setStatus('ready')
    } catch (e: any) { setStatus('error'); setNote(e?.message || 'Failed to load live calls') }
  }, [])

  useEffect(() => {
    if (!canMonitor) return
    load()
    const i = setInterval(load, 5000)
    return () => clearInterval(i)
  }, [canMonitor, load])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 6000)
    return () => clearTimeout(t)
  }, [toast])

  // 1s heartbeat so live durations keep counting between 5s snapshot polls.
  useEffect(() => {
    if (!canMonitor) return
    const i = setInterval(() => tick(t => t + 1), 1000)
    return () => clearInterval(i)
  }, [canMonitor])

  const cards = useMemo(() => groupCalls(channels), [channels])

  if (!canMonitor) return null

  async function spy(c: LiveCallCard, mode: SpyMode, actorKind: ActorKind) {
    const key = `${c.key}:${mode}:${actorKind}`
    setBusyKey(key); setToast(null)

    // For device monitoring, ensure the softphone is registered first AND tell
    // it to expect the inbound INVITE so it auto-answers instead of rejecting.
    if (actorKind === 'device') {
      // iOS/WebKit: unlock audio + grab mic permission *inside this tap gesture*.
      // The remote stream attaches later (after async SDP negotiation), well
      // outside the gesture, so iOS would otherwise block playback + getUserMedia.
      const el = ensureAudioEl()
      try { el.muted = false; const p = el.play(); if (p && typeof p.catch === 'function') p.catch(() => {}) } catch {}
      try {
        const ms = await navigator.mediaDevices.getUserMedia({ audio: true })
        ms.getTracks().forEach(t => t.stop())  // just needed the gesture-time permission
      } catch { /* mic denied/unavailable — Listen can still attempt to play remote audio */ }

      const ok = await connectSoftphone()
      if (!ok) {
        setBusyKey(null)
        setToast({ kind: 'err', msg: spReason || 'Softphone isn’t available.' })
        return
      }
      // Listen = mic muted; Whisper/Barge = mic open.
      softphoneRef.current?.setMicMuted(mode === 'listen')
      softphoneRef.current?.expectIncoming()
      setActiveDeviceMode(mode)
    }

    let enq: any = null
    try {
      const r = await fetch('/api/calls/live/spy', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target_channel: c.spyTargetChannel, target_call_linkedid: c.spyTargetUniqueid,
          target_agent_ext: c.agentExt, mode, actor_kind: actorKind,
        }),
      })
      enq = await r.json()
      if (!r.ok || !enq?.request_id) {
        setToast({ kind: 'err', msg: enq?.message || enq?.error || 'Could not start monitoring' })
        if (actorKind === 'device') setActiveDeviceMode(null)
        return
      }
    } catch (e: any) {
      setToast({ kind: 'err', msg: e?.message || 'Request failed' })
      if (actorKind === 'device') setActiveDeviceMode(null)
      return
    } finally { setBusyKey(null) }

    // Enqueued — the on-PBX agent claims it within a couple of seconds. Poll
    // the request's outcome so we can surface ringing / not-registered / failed.
    const ext = enq.extension
    const target = actorKind === 'device' ? `browser (ext ${ext})` : `phone (ext ${ext})`
    setToast({ kind: 'ok', msg: `Requested ${mode} — your ${target} should connect shortly…` })
    const id = enq.request_id
    const deadline = Date.now() + 12000
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 1500))
      let sd: any
      try {
        const sr = await fetch(`/api/calls/live/spy?id=${encodeURIComponent(id)}`)
        if (!sr.ok) continue
        sd = await sr.json()
      } catch { continue }
      if (sd.status === 'connected') {
        setToast({ kind: 'ok', msg: actorKind === 'device'
          ? `Streaming to this browser — ${mode}.`
          : `Your phone (ext ${ext}) is ringing — answer to ${mode}.` })
        return
      }
      if (sd.status === 'failed') {
        const msg = sd.error === 'not_registered'
          ? (actorKind === 'device'
              ? `Your browser softphone (ext ${ext}) isn’t registered with the PBX yet.`
              : `Your phone (ext ${ext}) isn’t registered — log into your handset/softphone first.`)
          : (sd.error || 'Could not start monitoring.')
        setToast({ kind: 'err', msg })
        if (actorKind === 'device') setActiveDeviceMode(null)
        return
      }
      if (sd.status === 'expired') {
        setToast({ kind: 'err', msg: 'No response from the phone system — the monitor agent may be offline.' })
        if (actorKind === 'device') setActiveDeviceMode(null)
        return
      }
      if (sd.status === 'claimed') {
        setToast({ kind: 'ok', msg: actorKind === 'device' ? `Connecting browser audio for ${mode}…` : `Ringing your phone (ext ${ext}) — answer to ${mode}.` })
      }
    }
    setToast({ kind: 'ok', msg: actorKind === 'device'
      ? `Request queued. If audio doesn’t start, refresh and try again.`
      : `Request queued for ext ${ext}. If your phone doesn’t ring, check you’re logged in.` })
  }

  const MODE_META: { mode: SpyMode; label: string; color: string; hint: string }[] = [
    { mode: 'listen',  label: 'Listen',  color: T.blue,  hint: 'Silent — neither party hears you' },
    { mode: 'whisper', label: 'Whisper', color: T.amber, hint: 'Only the agent hears you' },
    { mode: 'barge',   label: 'Barge',   color: T.red,   hint: 'Join the call — both parties hear you' },
  ]

  return (
    <div style={{ marginBottom: 20, background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 8, overflow: 'hidden' }}>
      <div style={{ padding: '10px 16px', borderBottom: `1px solid ${T.border}`, display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: status === 'ready' && cards.length > 0 ? T.red : T.text3, boxShadow: status === 'ready' && cards.length > 0 ? `0 0 6px ${T.red}` : 'none' }} />
        <span style={{ fontSize: 11, color: T.text2, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.1em' }}>Live calls</span>
        {status === 'ready' && !stale && <span style={{ fontSize: 11, color: T.text3 }}>{cards.length} in progress</span>}
        {status === 'ready' && stale && <span style={{ fontSize: 11, color: T.amber }}>monitor agent offline?</span>}

        {/* Softphone status pill */}
        {spStatus !== 'idle' && (
          <span title={spReason || ''} style={{
            fontSize: 10, padding: '2px 8px', borderRadius: 10, fontFamily: 'monospace', letterSpacing: '0.05em',
            background: spStatus === 'incall' ? `${T.green}22` : spStatus === 'registered' ? `${T.blue}22` : spStatus === 'connecting' ? `${T.amber}22` : `${T.red}22`,
            color:      spStatus === 'incall' ? T.green        : spStatus === 'registered' ? T.blue        : spStatus === 'connecting' ? T.amber        : T.red,
            border: `1px solid ${spStatus === 'incall' ? T.green : spStatus === 'registered' ? T.blue : spStatus === 'connecting' ? T.amber : T.red}55`,
          }}>
            ● softphone {spStatus}
          </span>
        )}
        {spStatus === 'incall' && (
          <button onClick={hangupDevice} style={{ fontSize: 10, padding: '3px 10px', borderRadius: 4, background: 'transparent', color: T.red, border: `1px solid ${T.red}55`, fontFamily: 'inherit', fontWeight: 700, cursor: 'pointer' }}>
            Hang up{activeDeviceMode ? ` (${activeDeviceMode})` : ''}
          </button>
        )}

        {toast && (
          <span style={{ marginLeft: 'auto', fontSize: 11, color: toast.kind === 'ok' ? T.green : T.red }}>{toast.msg}</span>
        )}
      </div>

      {status === 'notconfigured' ? (
        <div style={{ padding: '12px 16px', fontSize: 11, color: T.text3 }}>
          Live monitoring isn’t connected yet — the FreePBX-side service (ChanSpy) needs to be set up. Until then this panel stays empty.
        </div>
      ) : status === 'error' ? (
        <div style={{ padding: '12px 16px', fontSize: 11, color: T.amber }}>Couldn’t reach the live service{note ? ` — ${note}` : ''}. Retrying…</div>
      ) : status === 'loading' ? (
        <div style={{ padding: '12px 16px', fontSize: 11, color: T.text3 }}>Checking for live calls…</div>
      ) : cards.length === 0 ? (
        <div style={{ padding: '12px 16px', fontSize: 11, color: T.text3 }}>No calls in progress right now.</div>
      ) : (
        <div>
          {cards.map(c => {
            const secs = Math.max(0, Math.floor((Date.now() - new Date(c.startedAt).getTime()) / 1000))
            const stateLabel = c.bridgedAt ? 'connected' : (c.state === 'up' ? 'live' : c.state)
            const agentName = c.agentExt ? extMap[c.agentExt] : null
            const agentLabel = agentName
              ? `${agentName} · Ext ${c.agentExt}`
              : (c.agentExt ? `Ext ${c.agentExt}` : 'Agent')
            return (
              <div key={c.key} style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', alignItems: isMobile ? 'stretch' : 'center', gap: isMobile ? 10 : 12, padding: '10px 16px', borderTop: `1px solid ${T.border}` }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0, flex: 1 }}>
                <DirectionBadge direction={c.direction === 'out' ? 'outbound' : 'inbound'} disposition="ANSWERED" />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 12, color: T.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {c.externalName || formatPhone(c.externalNumber) || 'Unknown caller'}
                    <span style={{ color: T.text3 }}> · </span>
                    <span style={{ color: T.text2 }}>{agentLabel}</span>
                  </div>
                  <div style={{ fontSize: 10, color: T.text3, fontFamily: 'monospace', display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span>{formatDuration(secs)}</span>
                    <span style={{ color: c.monitorable ? T.green : T.amber, textTransform: 'uppercase', letterSpacing: '0.05em' }}>● {stateLabel}</span>
                  </div>
                </div>
                </div>
                <div style={{ display: 'flex', gap: isMobile ? 8 : 12, flexWrap: 'wrap', justifyContent: isMobile ? 'flex-start' : 'flex-end' }}>
                  {MODE_META.map(m => {
                    const handsetBusy = busyKey === `${c.key}:${m.mode}:handset`
                    const deviceBusy  = busyKey === `${c.key}:${m.mode}:device`
                    const baseDisabled = !!busyKey || !c.monitorable
                    return (
                      <div key={m.mode} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
                        <div style={{ fontSize: 9, color: T.text3, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em' }}>{m.label}</div>
                        <div style={{ display: 'flex', gap: 4 }}>
                          <button onClick={() => spy(c, m.mode, 'handset')} disabled={baseDisabled}
                            title={c.monitorable ? `${m.hint} — rings your deskphone` : 'Available once the call connects'}
                            style={modeBtn(m.color, baseDisabled, c.monitorable)}>
                            {handsetBusy ? '…' : '☎ Handset'}
                          </button>
                          <button onClick={() => spy(c, m.mode, 'device')} disabled={baseDisabled}
                            title={c.monitorable ? `${m.hint} — streams to this browser` : 'Available once the call connects'}
                            style={modeBtn(m.color, baseDisabled, c.monitorable)}>
                            {deviceBusy ? '…' : '💻 Device'}
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// Shared style for Listen/Whisper/Barge mode buttons (used by both Handset & Device variants).
function modeBtn(color: string, disabled: boolean, monitorable: boolean): React.CSSProperties {
  return {
    padding: '4px 9px', borderRadius: 4, fontSize: 10, fontFamily: 'inherit', fontWeight: 600,
    background: 'transparent', color: disabled ? '#545968' : color,
    border: `1px solid ${disabled ? 'rgba(255,255,255,0.12)' : `${color}55`}`,
    cursor: disabled ? 'default' : 'pointer', opacity: monitorable ? 1 : 0.5,
    whiteSpace: 'nowrap',
  }
}

type Preset = 'today' | 'yesterday' | 'week' | 'month' | 'custom'

export default function CallsPage({ user }: { user: PortalUserSSR }) {
  const router = useRouter()
  const isMobile = useIsMobile()
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null)
  const [calls, setCalls] = useState<CallRow[]>([])
  const [stats, setStats] = useState<StatsPayload | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [selectedCall, setSelectedCall] = useState<CallRow | null>(null)
  const [view, setView] = useState<CallView>('overview')

  // Date range state — explicit YYYY-MM-DD strings (Brisbane time)
  const [startDate, setStartDate] = useState<string>(ymdToday())
  const [endDate, setEndDate] = useState<string>(ymdToday())
  const [activePreset, setActivePreset] = useState<Preset>('today')

  // Other filters. filterAgent holds an advisor key ("slack:<id>"/"ext:<n>") or 'all'.
  const [filterAgent, setFilterAgent] = useState<string>('all')
  const [filterDir, setFilterDir] = useState<string>('all')
  const [filterDisp, setFilterDisp] = useState<string>('all')
  const [search, setSearch] = useState<string>('')
  const [searchDebounced, setSearchDebounced] = useState<string>('')

  useEffect(() => {
    const t = setTimeout(() => setSearchDebounced(search), 300)
    return () => clearTimeout(t)
  }, [search])

  // Preset → date range
  function applyPreset(preset: Preset) {
    setActivePreset(preset)
    if (preset === 'today') {
      setStartDate(ymdToday()); setEndDate(ymdToday())
    } else if (preset === 'yesterday') {
      const y = ymdDaysAgo(1); setStartDate(y); setEndDate(y)
    } else if (preset === 'week') {
      setStartDate(ymdDaysAgo(6)); setEndDate(ymdToday())
    } else if (preset === 'month') {
      setStartDate(ymdStartOfMonth()); setEndDate(ymdToday())
    }
    // 'custom' — don't change dates, user is editing them manually
  }

  // When user types in a date field, switch preset label to "custom"
  function handleStartChange(v: string) {
    setStartDate(v); setActivePreset('custom')
  }
  function handleEndChange(v: string) {
    setEndDate(v); setActivePreset('custom')
  }

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true); else setLoading(true)
    try {
      const params = new URLSearchParams()
      params.set('startDate', startDate)
      params.set('endDate', endDate)
      if (filterAgent !== 'all') params.set('agent', filterAgent)
      if (filterDir !== 'all') params.set('direction', filterDir)
      if (filterDisp !== 'all') params.set('disposition', filterDisp)
      if (searchDebounced) params.set('search', searchDebounced)

      const statsParams = new URLSearchParams()
      statsParams.set('startDate', startDate)
      statsParams.set('endDate', endDate)
      if (filterAgent !== 'all') statsParams.set('agent', filterAgent)

      const [callsRes, statsRes] = await Promise.all([
        fetch(`/api/calls?${params.toString()}`),
        fetch(`/api/calls/stats?${statsParams.toString()}`),
      ])
      if (callsRes.status === 401 || statsRes.status === 401) { router.push('/login'); return }
      const callsData = await callsRes.json()
      const statsData = await statsRes.json()
      if (callsRes.ok) {
        setCalls(callsData.calls || [])
        setTruncated(!!callsData.truncated)
      }
      if (statsRes.ok) setStats(statsData)
      setLastRefresh(new Date())
    } catch (e) {
      console.error('Failed to load calls', e)
    } finally {
      setLoading(false); setRefreshing(false)
    }
  }, [router, startDate, endDate, filterAgent, filterDir, filterDisp, searchDebounced])

  useEffect(() => { load(false) }, [load])

  // Auto-refresh every 60 seconds when viewing "today"
  useEffect(() => {
    if (activePreset !== 'today') return
    const timer = setInterval(() => load(true), 60_000)
    return () => clearInterval(timer)
  }, [load, activePreset])

  const maxWeekTalk = useMemo(() => {
    if (!stats?.agents) return 1
    return Math.max(...stats.agents.map(a => a.week_talk_seconds), 1)
  }, [stats])

  const filterAgentName = filterAgent !== 'all' ? stats?.agents.find(a => a.key === filterAgent)?.display_name : null
  const fy = currentFY()
  const canMonitor = roleHasPermission(user.role, 'monitor:calls')

  // Open a call's detail drawer by id (used by the Conversion tab's
  // missed-opportunity list). Only works if the call is in the current list.
  const openCallById = useCallback((id: string) => {
    const c = calls.find(x => x.id === id)
    if (c) setSelectedCall(c)
  }, [calls])

  // ─── Feed call analytics summary to the global AI chatbot ───────────────
  // The assistant can answer questions about who's been on the phone, missed
  // call counts, talk-time leaders, and the currently-selected call without
  // re-querying FreePBX/Deepgram itself.
  const { setPageContext: setChatContext } = useChatContext()
  useEffect(() => {
    if (loading) { setChatContext(null); return }
    setChatContext({
      dateRange: { startDate, endDate, preset: activePreset },
      filters: {
        agent: filterAgent === 'all' ? null : filterAgent,
        agentName: filterAgentName || null,
        direction: filterDir === 'all' ? null : filterDir,
        disposition: filterDisp === 'all' ? null : filterDisp,
        searchTerm: searchDebounced || null,
      },
      callsListed: calls.length,
      truncated,
      todayStats: stats?.today || null,
      weekStats: stats?.week || null,
      sync: stats?.sync || null,
      // Agents ranked by talk time over the last 7 days
      topAgentsByWeekTalk: (stats?.agents || [])
        .slice()
        .sort((a, b) => b.week_talk_seconds - a.week_talk_seconds)
        .slice(0, 8)
        .map(a => ({
          name: a.display_name,
          extension: a.ext_label,
          role: a.role,
          todayCalls: a.today_total,
          todayAnsweredInbound: a.today_answered_inbound,
          todayOutbound: a.today_outbound,
          todayTalkSeconds: a.today_talk_seconds,
          weekTalkSeconds: a.week_talk_seconds,
        })),
      // Compact summary of the rows currently in view (cap at 25 to keep
      // the system prompt under control — full list lives in Supabase)
      callsInView: calls.slice(0, 25).map(c => ({
        id: c.id,
        callDate: c.call_date,
        direction: c.direction,
        externalNumber: c.external_number,
        callerName: c.caller_name,
        agentName: c.agent_name,
        agentExt: c.agent_ext,
        advisorName: c.effective_advisor_name,
        durationSeconds: c.duration_seconds,
        billsecSeconds: c.billsec_seconds,
        disposition: c.disposition,
        hasRecording: c.has_recording,
        transcriptStatus: c.transcript_status,
        salesScore: c.sales_score,
      })),
      selectedCall: selectedCall ? {
        id: selectedCall.id,
        callDate: selectedCall.call_date,
        direction: selectedCall.direction,
        externalNumber: selectedCall.external_number,
        callerName: selectedCall.caller_name,
        agentName: selectedCall.agent_name,
        agentExt: selectedCall.agent_ext,
        advisorName: selectedCall.effective_advisor_name,
        durationSeconds: selectedCall.duration_seconds,
        billsecSeconds: selectedCall.billsec_seconds,
        disposition: selectedCall.disposition,
        hasRecording: selectedCall.has_recording,
        transcriptStatus: selectedCall.transcript_status,
        salesScore: selectedCall.sales_score,
      } : null,
    })
    return () => { setChatContext(null) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, calls, stats, selectedCall, startDate, endDate, activePreset, filterAgent, filterDir, filterDisp, searchDebounced, truncated])

  return (
    <>
      <Head><title>Phone Calls — Just Autos</title><meta name="viewport" content="width=device-width,initial-scale=1"/><meta name="robots" content="noindex,nofollow"/></Head>

      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden', fontFamily: "'DM Sans',system-ui,sans-serif", color: T.text }}>
        <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet"/>

        <PortalTopBar
          activeId="calls"
          lastRefresh={lastRefresh}
          onRefresh={() => load(true)}
          refreshing={refreshing}
          currentUserRole={user.role}
          currentUserVisibleTabs={(user as any).visibleTabs}
          currentUserName={user.displayName}
          currentUserEmail={user.email}
        />

        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: T.bg }}>
          {/* Top bar with date controls (matches distributors.tsx style) */}
          <div style={{ minHeight: 52, background: T.bg2, borderBottom: `1px solid ${T.border}`, display: 'flex', alignItems: 'center', padding: isMobile ? '8px 12px' : '0 20px', gap: isMobile ? 6 : 10, flexShrink: 0, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 14, fontWeight: 600 }}>Phone Calls</span>
            <div style={{ flex: 1 }}/>
            {!loading && stats && !isMobile && (
              <>
                <div style={{ width: 7, height: 7, borderRadius: '50%', background: stats.sync.last_error ? T.red : T.green, boxShadow: `0 0 6px ${stats.sync.last_error ? T.red : T.green}` }}/>
                <span style={{ fontSize: 10, fontFamily: 'monospace', padding: '2px 8px', borderRadius: 4, background: stats.sync.last_error ? 'rgba(240,78,78,0.12)' : 'rgba(52,199,123,0.12)', color: stats.sync.last_error ? T.red : T.green, border: `1px solid ${stats.sync.last_error ? 'rgba(240,78,78,0.2)' : 'rgba(52,199,123,0.2)'}` }}>
                  {stats.sync.last_error ? 'Sync error' : `Synced ${formatSyncTime(stats.sync.last_synced_at)}`}
                </span>
                <span style={{ fontSize: 10, fontFamily: 'monospace', padding: '2px 8px', borderRadius: 4, background: 'rgba(79,142,247,0.12)', color: T.blue, border: '1px solid rgba(79,142,247,0.2)' }}>
                  {stats.sync.records_synced_total.toLocaleString('en-AU')} total
                </span>
              </>
            )}
            {!isMobile && <div style={{ width: 1, height: 18, background: T.border }}/>}
            {/* Preset buttons — bigger tap targets + flow to their own line on mobile */}
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', ...(isMobile ? { width: '100%' } : {}) }}>
              {([
                { id: 'today', label: 'Today' },
                { id: 'yesterday', label: 'Yesterday' },
                { id: 'week', label: '7d' },
                { id: 'month', label: 'MTD' },
              ] as { id: Preset; label: string }[]).map(p => (
                <button key={p.id} onClick={() => applyPreset(p.id)}
                  style={{
                    flex: isMobile ? 1 : undefined,
                    padding: isMobile ? '8px 10px' : '3px 10px', borderRadius: 5, border: '1px solid',
                    fontSize: isMobile ? 12 : 11, fontFamily: 'monospace', fontWeight: 600, cursor: 'pointer',
                    background: activePreset === p.id ? T.accent : 'transparent',
                    color: activePreset === p.id ? '#fff' : T.text2,
                    borderColor: activePreset === p.id ? T.accent : T.border,
                  }}>{p.label}</button>
              ))}
            </div>
            {/* Date range — kept together; full-width on mobile */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, ...(isMobile ? { width: '100%' } : {}) }}>
              <input type="date" value={startDate} max={endDate} onChange={e => handleStartChange(e.target.value)}
                style={{ flex: isMobile ? 1 : undefined, padding: isMobile ? '8px 8px' : '3px 6px', borderRadius: 5, border: `1px solid ${activePreset === 'custom' ? T.accent : T.border}`, fontSize: isMobile ? 13 : 11, fontFamily: 'monospace', background: 'transparent', color: T.text2, outline: 'none', colorScheme: 'dark' }}/>
              <span style={{ fontSize: 11, color: T.text3 }}>→</span>
              <input type="date" value={endDate} min={startDate} max={ymdToday()} onChange={e => handleEndChange(e.target.value)}
                style={{ flex: isMobile ? 1 : undefined, padding: isMobile ? '8px 8px' : '3px 6px', borderRadius: 5, border: `1px solid ${activePreset === 'custom' ? T.accent : T.border}`, fontSize: isMobile ? 13 : 11, fontFamily: 'monospace', background: 'transparent', color: T.text2, outline: 'none', colorScheme: 'dark' }}/>
            </div>
          </div>

          {/* Body */}
          <div style={{ flex: 1, overflow: 'auto', padding: isMobile ? 12 : 20 }}>
            {loading && !stats ? (
              <div style={{ textAlign: 'center', padding: 80, color: T.text3 }}>
                <div style={{ fontSize: 24, animation: 'spin 1s linear infinite', marginBottom: 12 }}>⟳</div>
                <div style={{ fontSize: 12 }}>Loading call data…</div>
                <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
              </div>
            ) : (
              <>
                {/* Icon tab bar — Overview + insight tabs (same AppIcon style as the Settings hub) */}
                <CallTabBar view={view} onChange={setView} />

                {view !== 'overview' ? (
                  <CallInsights view={view} startDate={startDate} endDate={endDate} agent={filterAgent} onOpenCall={openCallById} />
                ) : (
                <>
                {/* Live call monitoring — management only */}
                <LiveCallsBoard canMonitor={canMonitor} />

                {/* Stats row */}
                {stats && (
                  <div style={{ marginBottom: 20 }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 10 }}>
                      <div style={{ fontSize: 10, color: T.text3, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.1em' }}>
                        {stats.periodLabel} {activePreset !== 'custom' && <span style={{ color: T.text2, marginLeft: 6 }}>({startDate === endDate ? startDate : `${startDate} → ${endDate}`})</span>}
                      </div>
                      <div style={{ fontSize: 11, color: T.text3, fontFamily: 'monospace' }}>
                        {new Date().toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
                      </div>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'repeat(2, 1fr)' : 'repeat(6, 1fr)', gap: 10 }}>
                      <StatCard label="Total Calls" value={stats.today.total} />
                      <StatCard label="Inbound" value={stats.today.inbound} sublabel={stats.today.total ? `${Math.round(stats.today.inbound / stats.today.total * 100)}% of period` : undefined} accent={T.green} />
                      <StatCard label="Outbound" value={stats.today.outbound} sublabel={stats.today.total ? `${Math.round(stats.today.outbound / stats.today.total * 100)}% of period` : undefined} accent={T.blue} />
                      <StatCard label="Answer Rate" value={`${stats.today.answer_rate}%`} sublabel={`${stats.today.missed_inbound} missed inbound`} />
                      <StatCard label="Total Talk Time" value={formatDurationLong(stats.today.talk_seconds)} sublabel="across all agents" />
                      <StatCard label="Avg Call Length" value={formatDuration(stats.today.avg_call_seconds)} sublabel="when answered" />
                    </div>
                  </div>
                )}

                {/* Two-column layout (stacks on mobile) */}
                <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '320px 1fr', gap: 16 }}>
                  {/* Left: per-agent + splits */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    {stats && (
                      <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 8, overflow: 'hidden' }}>
                        <div style={{ padding: '12px 16px', borderBottom: `1px solid ${T.border}`, display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                          <div style={{ fontSize: 10, color: T.text3, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.1em' }}>Per Agent</div>
                          <div style={{ fontSize: 9, color: T.text3, textTransform: 'uppercase', letterSpacing: '0.1em' }}>Bar = period</div>
                        </div>
                        <div>
                          {stats.agents.length === 0 ? (
                            <div style={{ padding: 24, textAlign: 'center', fontSize: 12, color: T.text3 }}>No agent activity yet</div>
                          ) : stats.agents.map(a => {
                            const isActive = filterAgent === a.key
                            const pct = Math.round((a.week_talk_seconds / maxWeekTalk) * 100)
                            return (
                              <button
                                key={a.key}
                                onClick={() => setFilterAgent(isActive ? 'all' : a.key)}
                                style={{
                                  display: 'block', width: '100%', padding: '12px 16px',
                                  border: 'none', borderBottom: `1px solid ${T.border}`,
                                  background: isActive ? 'rgba(79,142,247,0.08)' : 'transparent',
                                  color: T.text, textAlign: 'left', cursor: 'pointer',
                                  fontFamily: 'inherit',
                                }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
                                  <div style={{ fontSize: 13, fontWeight: 500 }}>{a.display_name}</div>
                                  <div style={{ fontSize: 10, color: T.text3, fontFamily: 'monospace' }}>{a.ext_label ? `Ext ${a.ext_label}` : 'identified'}</div>
                                </div>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 11, color: T.text2, fontFamily: 'monospace', marginBottom: 6 }}>
                                  <span>Period: {a.today_total}</span>
                                  <span style={{ marginLeft: 'auto', color: T.text, fontWeight: 500 }}>{formatDurationLong(a.week_talk_seconds)}</span>
                                </div>
                                <div style={{ height: 3, background: T.bg4, borderRadius: 2, overflow: 'hidden' }}>
                                  <div style={{ height: '100%', background: T.blue, width: `${pct}%`, transition: 'width 0.3s' }}/>
                                </div>
                              </button>
                            )
                          })}
                        </div>
                        {(() => {
                          const agentSum = stats.agents.reduce((s, a) => s + a.today_total, 0)
                          const total = stats.today.total
                          if (agentSum >= total) return null
                          const unassigned = total - agentSum
                          return (
                            <div style={{ padding: '8px 16px', fontSize: 10, color: T.text3, borderTop: `1px solid ${T.border}`, textAlign: 'center' }}>
                              Shown: {agentSum} of {total} — {unassigned} unassigned or missed
                            </div>
                          )
                        })()}
                      </div>
                    )}

                    {stats && (
                      <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 8, padding: 16 }}>
                        <div style={{ fontSize: 10, color: T.text3, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 12 }}>Period Split</div>
                        {[
                          { label: 'Inbound', value: stats.today.inbound, color: T.green },
                          { label: 'Outbound', value: stats.today.outbound, color: T.blue },
                          { label: 'Missed Inbound', value: stats.today.missed_inbound, color: T.red },
                        ].map(row => (
                          <div key={row.label} style={{ marginBottom: 10 }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                              <span style={{ fontSize: 11, color: T.text2 }}>{row.label}</span>
                              <span style={{ fontSize: 11, fontFamily: 'monospace', color: T.text }}>{row.value}</span>
                            </div>
                            <div style={{ height: 4, background: T.bg4, borderRadius: 2, overflow: 'hidden' }}>
                              <div style={{ height: '100%', background: row.color, width: `${stats.today.total > 0 ? (row.value / stats.today.total) * 100 : 0}%`, transition: 'width 0.3s' }}/>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Right: call list */}
                  <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 8, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
                    {/* Filter bar */}
                    <div style={{ padding: 12, borderBottom: `1px solid ${T.border}`, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                      <input
                        type="text"
                        placeholder="Search number, name, or agent…"
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                        style={{
                          flex: 1, minWidth: 200, padding: '7px 10px',
                          background: T.bg3, border: `1px solid ${T.border}`, borderRadius: 5,
                          color: T.text, fontSize: 12, fontFamily: 'inherit', outline: 'none',
                        }}
                      />
                      <select value={filterDir} onChange={e => setFilterDir(e.target.value)}
                        style={{ padding: '6px 8px', background: T.bg3, border: `1px solid ${T.border}`, borderRadius: 5, color: T.text, fontSize: 11, fontFamily: 'inherit', cursor: 'pointer' }}>
                        <option value="all">All directions</option>
                        <option value="inbound">Inbound</option>
                        <option value="outbound">Outbound</option>
                      </select>
                      <select value={filterDisp} onChange={e => setFilterDisp(e.target.value)}
                        style={{ padding: '6px 8px', background: T.bg3, border: `1px solid ${T.border}`, borderRadius: 5, color: T.text, fontSize: 11, fontFamily: 'inherit', cursor: 'pointer' }}>
                        <option value="all">All statuses</option>
                        <option value="answered">Answered</option>
                        <option value="missed">Missed</option>
                      </select>
                      {filterAgent !== 'all' && filterAgentName && (
                        <button onClick={() => setFilterAgent('all')}
                          style={{ padding: '5px 10px', background: T.blue, border: 'none', borderRadius: 5, color: '#fff', fontSize: 11, cursor: 'pointer', fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 6 }}>
                          {filterAgentName} <span style={{ fontSize: 14, lineHeight: 1 }}>×</span>
                        </button>
                      )}
                    </div>

                    {/* Headers (desktop only — mobile uses stacked cards) */}
                    {!isMobile && (
                    <div style={{
                      display: 'grid',
                      gridTemplateColumns: '34px 1fr 140px 30px 70px 70px 100px',
                      gap: 8, padding: '8px 14px',
                      borderBottom: `1px solid ${T.border}`, background: T.bg3,
                      fontSize: 9, color: T.text3, fontWeight: 600,
                      textTransform: 'uppercase', letterSpacing: '0.1em',
                    }}>
                      <div/>
                      <div>Number / Caller</div>
                      <div>Agent</div>
                      <div style={{ textAlign: 'center' }}>Rec</div>
                      <div style={{ textAlign: 'right' }}>Duration</div>
                      <div style={{ textAlign: 'right' }}>Status</div>
                      <div style={{ textAlign: 'right' }}>When</div>
                    </div>
                    )}

                    {/* Rows */}
                    <div style={{ flex: 1, overflow: 'auto', maxHeight: 'calc(100vh - 340px)' }}>
                      {calls.length === 0 ? (
                        <div style={{ padding: 60, textAlign: 'center', fontSize: 12, color: T.text3 }}>
                          No calls match the current filters
                        </div>
                      ) : calls.map(c => isMobile ? (
                        <div
                          key={c.id}
                          onClick={() => setSelectedCall(c)}
                          style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '11px 14px', borderBottom: `1px solid ${T.border}`, cursor: 'pointer' }}>
                          <DirectionBadge direction={c.direction} disposition={c.disposition} />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 13, color: T.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                              {c.caller_name || formatPhone(c.external_number)}
                            </div>
                            <div style={{ fontSize: 10.5, color: T.text3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                              {(c.effective_advisor_name || c.agent_name) || 'Unanswered'} · {formatRelative(c.call_date)}{c.has_recording ? ' · ●' : ''}
                            </div>
                          </div>
                          <div style={{ textAlign: 'right', flexShrink: 0 }}>
                            <div style={{ fontSize: 12, fontFamily: 'monospace', color: T.text2 }}>{formatDuration(c.billsec_seconds || c.duration_seconds)}</div>
                            <div style={{ fontSize: 10, color: c.disposition === 'ANSWERED' ? T.text3 : T.red, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{c.disposition === 'ANSWERED' ? 'Answered' : 'Missed'}</div>
                          </div>
                        </div>
                      ) : (
                        <div
                          key={c.id}
                          onClick={() => setSelectedCall(c)}
                          style={{
                            display: 'grid',
                            gridTemplateColumns: '34px 1fr 140px 30px 70px 70px 100px',
                            gap: 8, padding: '10px 14px',
                            borderBottom: `1px solid ${T.border}`,
                            cursor: 'pointer',
                            alignItems: 'center',
                            transition: 'background 0.1s',
                          }}
                          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.02)' }}
                          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}>
                          <DirectionBadge direction={c.direction} disposition={c.disposition} />
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontSize: 12, color: T.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                              {c.caller_name || formatPhone(c.external_number)}
                            </div>
                            {c.caller_name && (
                              <div style={{ fontSize: 10, color: T.text3, fontFamily: 'monospace' }}>{formatPhone(c.external_number)}</div>
                            )}
                          </div>
                          <div>
                            {(c.effective_advisor_name || c.agent_name) ? (
                              <>
                                <div style={{ fontSize: 11, color: T.text }}>{c.effective_advisor_name || c.agent_name}</div>
                                <div style={{ fontSize: 10, color: T.text3, fontFamily: 'monospace' }}>{c.agent_ext ? `Ext ${c.agent_ext}` : '—'}</div>
                              </>
                            ) : (
                              <div style={{ fontSize: 11, color: T.text3, fontStyle: 'italic' }}>Unanswered</div>
                            )}
                          </div>
                          <div style={{ textAlign: 'center', fontSize: 11, color: c.has_recording ? T.text2 : T.text3 }}>
                            {c.has_recording ? '●' : '—'}
                          </div>
                          <div style={{ textAlign: 'right', fontSize: 11, fontFamily: 'monospace', color: T.text2 }}>
                            {formatDuration(c.billsec_seconds || c.duration_seconds)}
                          </div>
                          <div style={{ textAlign: 'right', fontSize: 10, color: c.disposition === 'ANSWERED' ? T.text2 : T.red, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                            {c.disposition === 'ANSWERED' ? 'Answered' : 'Missed'}
                          </div>
                          <div style={{ textAlign: 'right', fontSize: 10, color: T.text3, fontFamily: 'monospace' }}>
                            {formatRelative(c.call_date)}
                          </div>
                        </div>
                      ))}
                    </div>

                    <div style={{ padding: '8px 14px', borderTop: `1px solid ${T.border}`, background: T.bg3, display: 'flex', justifyContent: 'space-between', fontSize: 10, color: T.text3, alignItems: 'center' }}>
                      <span style={{ fontFamily: 'monospace' }}>{calls.length} calls shown{truncated ? ' (row limit hit — narrow filters for more)' : ''}</span>
                      <BatchTranscribeButton
                        callCount={calls.length}
                        filters={{ startDate, endDate, agent: filterAgent !== 'all' ? filterAgent : undefined, direction: filterDir !== 'all' ? filterDir : undefined, disposition: filterDisp !== 'all' ? filterDisp : undefined }}
                      />
                    </div>
                  </div>
                </div>

                {/* Phase roadmap note */}
                <div style={{ marginTop: 24, display: 'flex', justifyContent: 'center', gap: 12, fontSize: 9, color: T.text3, textTransform: 'uppercase', letterSpacing: '0.1em' }}>
                  <span style={{ color: T.text2, fontWeight: 600 }}>✓ Phase 1 · Call Logging</span>
                  <span>·</span>
                  <span style={{ color: T.text2, fontWeight: 600 }}>✓ Phase 2 · Transcription</span>
                  <span>·</span>
                  <span style={{ color: T.text2, fontWeight: 600 }}>✓ Phase 3 · AI Coaching &amp; Insights</span>
                </div>
                </>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {/* Detail drawer */}
      {selectedCall && (
        <div
          onClick={() => setSelectedCall(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000, backdropFilter: 'blur(4px)', display: 'flex', justifyContent: 'flex-end' }}>
          <div
            onClick={e => e.stopPropagation()}
            style={{ width: '100%', maxWidth: 640, height: '100vh', background: T.bg2, borderLeft: `1px solid ${T.border2}`, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
            <div style={{ padding: '16px 24px', borderBottom: `1px solid ${T.border}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0, background: T.bg2 }}>
              <div>
                <div style={{ fontSize: 10, color: T.text3, textTransform: 'uppercase', letterSpacing: '0.1em' }}>Call Detail</div>
                <div style={{ fontSize: 11, color: T.text2, fontFamily: 'monospace' }}>{selectedCall.linkedid}</div>
              </div>
              <button onClick={() => setSelectedCall(null)}
                style={{ width: 32, height: 32, borderRadius: 6, background: T.bg3, border: `1px solid ${T.border}`, color: T.text2, cursor: 'pointer', fontSize: 16, fontFamily: 'inherit' }}>×</button>
            </div>

            <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 20 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                <DirectionBadge direction={selectedCall.direction} disposition={selectedCall.disposition} />
                <div>
                  <div style={{ fontSize: 20, fontWeight: 300, color: T.text }}>
                    {selectedCall.caller_name || formatPhone(selectedCall.external_number)}
                  </div>
                  {selectedCall.caller_name && (
                    <div style={{ fontSize: 12, color: T.text3, fontFamily: 'monospace' }}>{formatPhone(selectedCall.external_number)}</div>
                  )}
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1, background: T.border, border: `1px solid ${T.border}`, borderRadius: 6, overflow: 'hidden' }}>
                {[
                  ['Direction', selectedCall.direction.charAt(0).toUpperCase() + selectedCall.direction.slice(1)],
                  ['Status', selectedCall.disposition === 'ANSWERED' ? 'Answered' : 'Missed'],
                  ['Agent', selectedCall.effective_advisor_name
                    ? `${selectedCall.effective_advisor_name}${selectedCall.agent_ext ? ` (on Ext ${selectedCall.agent_ext})` : ''}`
                    : (selectedCall.agent_name ? `${selectedCall.agent_name} (Ext ${selectedCall.agent_ext})` : 'Nobody answered')],
                  ['Talk Time', formatDuration(selectedCall.billsec_seconds || selectedCall.duration_seconds)],
                  ['When', new Date(selectedCall.call_date).toLocaleString('en-AU')],
                  ['Recording', selectedCall.has_recording ? 'Available (see player below)' : 'None'],
                ].map(([label, value]) => (
                  <div key={label as string} style={{ background: T.bg2, padding: '12px 14px' }}>
                    <div style={{ fontSize: 9, color: T.text3, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 4 }}>{label}</div>
                    <div style={{ fontSize: 12, color: T.text }}>{value}</div>
                  </div>
                ))}
              </div>

              {/* Recording player — Phase 1 delivery */}
              <RecordingPlayer callId={selectedCall.id} hasRecording={selectedCall.has_recording} />

              {/* Transcript panel — Phase 2 delivery */}
              <TranscriptPanel callId={selectedCall.id} hasRecording={selectedCall.has_recording} direction={selectedCall.direction} />

              {/* Phase 3 — AI coaching analysis panel (real) */}
              <AnalysisPanel
                callId={selectedCall.id}
                hasTranscript={true}
                billsecSeconds={selectedCall.billsec_seconds || selectedCall.duration_seconds || 0}
              />
            </div>
          </div>
        </div>
      )}
    </>
  )
}

export async function getServerSideProps(context: any) {
  return requirePageAuth(context, 'view:calls')
}
