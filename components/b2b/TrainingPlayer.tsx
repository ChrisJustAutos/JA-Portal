// components/b2b/TrainingPlayer.tsx
// The shared training player: slide viewer (per-section stepper, keyboard
// arrows, resume from where you left off) → quiz (one question per screen) →
// results with full per-question review. Marking is server-side — this
// component never sees a correct answer until the attempt has been submitted.
//
// Used by BOTH the distributor course page (/b2b/training/<slug>) and the
// admin "preview as distributor" page (/admin/b2b/training/<slug>). The two
// differ only in props: `apiPath` (the admin player endpoint marks but never
// records an attempt), the back link, an optional banner, and a localStorage
// prefix so an admin preview doesn't clobber a real distributor session's
// resume position in the same browser.

import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Head from 'next/head'
import { T, alpha } from '../../lib/ui/theme'
import { useIsMobile } from '../../lib/useIsMobile'

interface Section { title: string; intro?: string; slides: number[] }
interface ModuleData {
  slug: string
  title: string
  description: string | null
  pass_pct: number
  sections: Section[]
  /** Full URL prefix for slide images (generated modules — Supabase storage).
   *  Absent/null on repo-baked modules → fall back to /training/<slug>. */
  slide_base?: string | null
}
interface ExamQ { q: string; options: string[] }
interface CourseData { module: ModuleData; examQuestions: ExamQ[]; question_order: number[] }

interface ReviewQ {
  q: string
  options: string[]
  chosen: number | null
  correctIndex: number
  correct: boolean
  explain: string | null
  slide: number | null
}
interface ExamResultData { score_pct: number; passed: boolean; pass_pct: number; review: ReviewQ[]; preview?: boolean }

type Mode = 'slides' | 'exam' | 'result'

interface Props {
  slug: string
  /** Base URL used for both the GET (course + exam) and POST (submit answers). */
  apiPath: string
  /** The "← All courses" link in the header (href + label). */
  backHref: string
  backLabel: string
  /** Optional strip rendered above the player (e.g. the admin-preview notice). */
  banner?: ReactNode
  /** Prefix for the localStorage resume key — lets admin previews keep their
   *  own slide position without touching a distributor session's. */
  storagePrefix?: string
  /** Read-only preview session (login-less Portal Preview) — quiz can be
   *  browsed but the submit is blocked upstream with a 403. */
  preview?: boolean
  /** Appended to the module title in the document <title>. */
  titleSuffix?: string
}

const slideKey = (prefix: string | undefined, slug: string) =>
  `${prefix ? `${prefix}:` : ''}ja-b2b-training-slide:${slug}`
const pad2 = (n: number) => String(n).padStart(2, '0')
// Slide image URL: generated modules carry a slide_base (storage URL prefix);
// repo-baked modules resolve to the hard-coded /public path, byte-identically.
const slideSrc = (slideBase: string | null | undefined, slug: string, n: number) =>
  `${slideBase || `/training/${slug}`}/${pad2(n)}.jpg`

export default function TrainingPlayer({ slug, apiPath, backHref, backLabel, banner, storagePrefix, preview, titleSuffix }: Props) {
  const isMobile = useIsMobile()

  const [data, setData] = useState<CourseData | null>(null)
  const [error, setError] = useState('')
  const [mode, setMode] = useState<Mode>('slides')
  const [slideIdx, setSlideIdx] = useState(0)

  // Exam state — answers[i] pairs with data.examQuestions[i] / question_order[i]
  const [examPos, setExamPos] = useState(0)
  const [answers, setAnswers] = useState<(number | null)[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [examError, setExamError] = useState('')
  const [result, setResult] = useState<ExamResultData | null>(null)
  const startedAtRef = useRef<string | null>(null)

  const load = useCallback(async () => {
    const r = await fetch(apiPath, { credentials: 'same-origin' })
    const d = await r.json()
    if (!r.ok || d.error) throw new Error(d.error || `HTTP ${r.status}`)
    setData(d)
    setAnswers(new Array((d.examQuestions || []).length).fill(null))
    return d as CourseData
  }, [apiPath])

  useEffect(() => {
    if (!slug) return
    load()
      .then(d => {
        // Resume where they left off.
        try {
          const saved = parseInt(localStorage.getItem(slideKey(storagePrefix, slug)) || '', 10)
          const total = (d.module.sections || []).reduce((n, s) => n + s.slides.length, 0)
          if (Number.isInteger(saved) && saved > 0 && saved < total) setSlideIdx(saved)
        } catch {}
      })
      .catch(e => setError(e.message || 'Failed to load'))
  }, [slug, storagePrefix, load])

  // Flat slide list: [{ n: slideNumber, si: sectionIndex }]
  const flatSlides = useMemo(() => {
    const out: { n: number; si: number }[] = []
    ;(data?.module.sections || []).forEach((s, si) => {
      for (const n of s.slides || []) out.push({ n, si })
    })
    return out
  }, [data])

  const totalSlides = flatSlides.length
  const current = flatSlides[Math.min(slideIdx, Math.max(0, totalSlides - 1))]
  const currentSection = current ? data!.module.sections[current.si] : null

  const goTo = useCallback((idx: number) => {
    if (!totalSlides) return
    const clamped = Math.max(0, Math.min(totalSlides - 1, idx))
    setSlideIdx(clamped)
    try { localStorage.setItem(slideKey(storagePrefix, slug), String(clamped)) } catch {}
  }, [slug, storagePrefix, totalSlides])

  // Keyboard arrows while viewing slides.
  useEffect(() => {
    if (mode !== 'slides') return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') goTo(slideIdx + 1)
      else if (e.key === 'ArrowLeft') goTo(slideIdx - 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mode, slideIdx, goTo])

  // Preload the next slide so paging feels instant.
  useEffect(() => {
    const next = flatSlides[slideIdx + 1]
    if (next && typeof window !== 'undefined') {
      const img = new window.Image()
      img.src = slideSrc(data?.module.slide_base, slug, next.n)
    }
  }, [slideIdx, flatSlides, slug, data])

  function startExam() {
    startedAtRef.current = new Date().toISOString()
    setExamPos(0)
    setExamError('')
    setMode('exam')
    window.scrollTo({ top: 0 })
  }

  async function submitExam() {
    if (!data) return
    setSubmitting(true)
    setExamError('')
    try {
      // Key answers by ORIGINAL question index (server marks against those).
      const byOriginal: Record<number, number> = {}
      answers.forEach((a, i) => { if (a !== null) byOriginal[data.question_order[i]] = a })
      const r = await fetch(apiPath, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers: byOriginal, question_order: data.question_order, started_at: startedAtRef.current }),
      })
      const d = await r.json()
      if (r.status === 403) {
        setExamError('This is a read-only preview — the quiz can be browsed but not submitted. Sign in as a distributor user to record a result.')
        return
      }
      if (!r.ok || d.error) throw new Error(d.error || `HTTP ${r.status}`)
      setResult(d)
      setMode('result')
      window.scrollTo({ top: 0 })
    } catch (e: any) {
      setExamError(e.message || 'Submit failed')
    } finally {
      setSubmitting(false)
    }
  }

  async function retake() {
    setSubmitting(false)
    setResult(null)
    setExamError('')
    try {
      await load()   // fresh shuffle from the server
      startExam()
    } catch (e: any) {
      setExamError(e.message || 'Failed to reload the quiz')
    }
  }

  function jumpToSlide(n: number) {
    const idx = flatSlides.findIndex(s => s.n === n)
    if (idx >= 0) { goTo(idx); setMode('slides'); window.scrollTo({ top: 0 }) }
  }

  const answeredCount = answers.filter(a => a !== null).length

  return (
    <>
      <Head><title>{`${data?.module.title || 'Training'}${titleSuffix ?? ' · Just Autos B2B'}`}</title><meta name="robots" content="noindex,nofollow" /></Head>
      <div style={{ maxWidth: 1100, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 14 }}>

        {banner}

        {/* ── Header ─────────────────────────────────────────── */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <a href={backHref} style={{ fontSize: 12, color: T.text3, textDecoration: 'none', whiteSpace: 'nowrap' }}>{backLabel}</a>
          <h1 style={{ margin: 0, fontSize: isMobile ? 17 : 20, fontWeight: 700, flex: 1, minWidth: 200 }}>
            {data?.module.title || 'Loading…'}
          </h1>
          {data && mode === 'slides' && (
            <button onClick={startExam}
              style={{ fontSize: 12, fontWeight: 700, padding: '9px 16px', borderRadius: 8, border: `1px solid ${T.blue}`, background: 'transparent', color: T.blue, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' }}>
              Take the quiz →
            </button>
          )}
        </div>

        {error && (
          <div style={{ background: alpha(T.red, '18'), border: `1px solid ${T.red}40`, borderRadius: 8, padding: 12, fontSize: 13, color: T.red }}>
            {error}
          </div>
        )}
        {!data && !error && <div style={{ color: T.text3, padding: 40, textAlign: 'center' }}>Loading…</div>}

        {/* ── Slides ─────────────────────────────────────────── */}
        {data && mode === 'slides' && current && (
          <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>

            {/* Section stepper (desktop sidebar) */}
            {!isMobile && (
              <nav style={{ width: 230, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
                {data.module.sections.map((s, si) => {
                  const first = flatSlides.findIndex(f => f.si === si)
                  const on = current.si === si
                  const done = slideIdx >= first + s.slides.length
                  return (
                    <button key={si} onClick={() => goTo(first)}
                      style={{
                        textAlign: 'left', padding: '9px 11px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit',
                        border: `1px solid ${on ? T.border2 : 'transparent'}`,
                        background: on ? T.bg3 : 'transparent',
                        color: on ? T.text : T.text2, fontSize: 12.5, fontWeight: on ? 600 : 500,
                        display: 'flex', alignItems: 'baseline', gap: 8,
                      }}>
                      <span style={{ color: done ? T.green : (on ? T.blue : T.text3), fontSize: 11, fontWeight: 700, flexShrink: 0 }}>
                        {done ? '✓' : si + 1}
                      </span>
                      <span style={{ flex: 1 }}>{s.title}</span>
                      <span style={{ fontSize: 10, color: T.text3, flexShrink: 0 }}>{s.slides.length}</span>
                    </button>
                  )
                })}
              </nav>
            )}

            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>

              {/* Mobile section picker */}
              {isMobile && (
                <select
                  value={current.si}
                  onChange={e => {
                    const si = Number(e.target.value)
                    const first = flatSlides.findIndex(f => f.si === si)
                    if (first >= 0) goTo(first)
                  }}
                  style={{ background: T.bg3, color: T.text, border: `1px solid ${T.border2}`, borderRadius: 8, padding: '9px 10px', fontSize: 13, fontFamily: 'inherit', width: '100%' }}>
                  {data.module.sections.map((s, si) => (
                    <option key={si} value={si}>{si + 1}. {s.title}</option>
                  ))}
                </select>
              )}

              {/* Section title + intro */}
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: T.text }}>{currentSection?.title}</div>
                {currentSection?.intro && (
                  <div style={{ fontSize: 12, color: T.text3, marginTop: 3, lineHeight: 1.5 }}>{currentSection.intro}</div>
                )}
              </div>

              {/* Progress bar */}
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: T.text3, marginBottom: 4 }}>
                  <span>Slide {slideIdx + 1} of {totalSlides}</span>
                  <span>{Math.round(((slideIdx + 1) / Math.max(1, totalSlides)) * 100)}%</span>
                </div>
                <div style={{ height: 4, background: T.bg3, borderRadius: 2, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${((slideIdx + 1) / Math.max(1, totalSlides)) * 100}%`, background: T.blue, borderRadius: 2, transition: 'width 0.2s ease' }} />
                </div>
              </div>

              {/* Slide image */}
              <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 12, overflow: 'hidden' }}>
                <img
                  src={slideSrc(data.module.slide_base, slug, current.n)}
                  alt={`Slide ${current.n} — ${currentSection?.title || ''}`}
                  style={{ display: 'block', width: '100%', height: 'auto' }}
                />
              </div>

              {/* Prev / next */}
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button onClick={() => goTo(slideIdx - 1)} disabled={slideIdx === 0}
                  style={{ flex: 1, fontSize: 13, fontWeight: 600, padding: '12px 0', borderRadius: 8, border: `1px solid ${T.border2}`, background: T.bg2, color: slideIdx === 0 ? T.text3 : T.text, cursor: slideIdx === 0 ? 'default' : 'pointer', fontFamily: 'inherit', opacity: slideIdx === 0 ? 0.5 : 1 }}>
                  ← Previous
                </button>
                {slideIdx < totalSlides - 1 ? (
                  <button onClick={() => goTo(slideIdx + 1)}
                    style={{ flex: 1, fontSize: 13, fontWeight: 700, padding: '12px 0', borderRadius: 8, border: `1px solid ${T.blue}`, background: T.blue, color: '#fff', cursor: 'pointer', fontFamily: 'inherit' }}>
                    Next →
                  </button>
                ) : (
                  <button onClick={startExam}
                    style={{ flex: 1, fontSize: 13, fontWeight: 700, padding: '12px 0', borderRadius: 8, border: `1px solid ${T.green}`, background: T.green, color: '#fff', cursor: 'pointer', fontFamily: 'inherit' }}>
                    Take the quiz →
                  </button>
                )}
              </div>
              {!isMobile && (
                <div style={{ fontSize: 11, color: T.text3, textAlign: 'center' }}>Tip: use the ← → arrow keys to move between slides.</div>
              )}
            </div>
          </div>
        )}

        {/* ── Exam ───────────────────────────────────────────── */}
        {data && mode === 'exam' && (
          <ExamScreen
            questions={data.examQuestions}
            passPct={data.module.pass_pct}
            pos={examPos}
            setPos={setExamPos}
            answers={answers}
            setAnswer={(i, v) => setAnswers(a => a.map((x, j) => j === i ? v : x))}
            answeredCount={answeredCount}
            submitting={submitting}
            error={examError}
            preview={!!preview}
            onBackToSlides={() => setMode('slides')}
            onSubmit={submitExam}
            isMobile={isMobile}
          />
        )}

        {/* ── Results ────────────────────────────────────────── */}
        {mode === 'result' && result && (
          <ResultScreen result={result} coursesHref={backHref} coursesLabel={backLabel.replace(/^←\s*/, '')} onRetake={retake} onJumpToSlide={jumpToSlide} />
        )}
      </div>
    </>
  )
}

// ─── Exam: one question per screen ────────────────────────────────────────
function ExamScreen({
  questions, passPct, pos, setPos, answers, setAnswer, answeredCount,
  submitting, error, preview, onBackToSlides, onSubmit, isMobile,
}: {
  questions: ExamQ[]
  passPct: number
  pos: number
  setPos: (n: number) => void
  answers: (number | null)[]
  setAnswer: (i: number, v: number) => void
  answeredCount: number
  submitting: boolean
  error: string
  preview: boolean
  onBackToSlides: () => void
  onSubmit: () => void
  isMobile: boolean
}) {
  const q = questions[pos]
  const total = questions.length
  const last = pos === total - 1
  const allAnswered = answeredCount === total
  if (!q) return null

  return (
    <div style={{ maxWidth: 700, margin: '0 auto', width: '100%', display: 'flex', flexDirection: 'column', gap: 12 }}>

      {preview && (
        <div style={{ background: alpha(T.amber, '18'), border: `1px solid ${T.amber}50`, borderRadius: 8, padding: 10, fontSize: 12, color: T.amber, fontWeight: 600 }}>
          Preview mode — you can try the quiz, but results can&rsquo;t be submitted.
        </div>
      )}

      {/* Progress */}
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: T.text3, marginBottom: 4 }}>
          <span>Question {pos + 1} of {total}</span>
          <span>{answeredCount}/{total} answered · pass mark {passPct}%</span>
        </div>
        <div style={{ height: 4, background: T.bg3, borderRadius: 2, overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${(answeredCount / Math.max(1, total)) * 100}%`, background: T.teal, borderRadius: 2, transition: 'width 0.2s ease' }} />
        </div>
      </div>

      {/* Question dots (jump navigation) */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
        {questions.map((_, i) => (
          <button key={i} onClick={() => setPos(i)} title={`Question ${i + 1}`}
            style={{
              width: 24, height: 24, borderRadius: 6, padding: 0, fontSize: 10, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer',
              border: `1px solid ${i === pos ? T.blue : T.border2}`,
              background: answers[i] !== null ? alpha(T.teal, '30') : T.bg2,
              color: i === pos ? T.blue : (answers[i] !== null ? T.text : T.text3),
            }}>
            {i + 1}
          </button>
        ))}
      </div>

      {/* Question card */}
      <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 12, padding: isMobile ? 16 : 22, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ fontSize: isMobile ? 15 : 16, fontWeight: 600, color: T.text, lineHeight: 1.5 }}>{q.q}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {q.options.map((opt, oi) => {
            const on = answers[pos] === oi
            return (
              <button key={oi} onClick={() => setAnswer(pos, oi)}
                style={{
                  textAlign: 'left', padding: '13px 14px', borderRadius: 9, cursor: 'pointer', fontFamily: 'inherit',
                  fontSize: 13.5, lineHeight: 1.45,
                  border: `1px solid ${on ? T.blue : T.border2}`,
                  background: on ? alpha(T.blue, '22') : T.bg3,
                  color: T.text, fontWeight: on ? 600 : 400,
                  display: 'flex', gap: 10, alignItems: 'flex-start',
                }}>
                <span style={{
                  flexShrink: 0, width: 20, height: 20, borderRadius: '50%', marginTop: 1,
                  border: `2px solid ${on ? T.blue : T.border2}`,
                  background: on ? T.blue : 'transparent',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: '#fff', fontSize: 11, fontWeight: 800,
                }}>{on ? '✓' : ''}</span>
                <span>{opt}</span>
              </button>
            )
          })}
        </div>
      </div>

      {error && (
        <div style={{ background: alpha(T.red, '18'), border: `1px solid ${T.red}40`, borderRadius: 8, padding: 12, fontSize: 13, color: T.red }}>
          {error}
        </div>
      )}

      {/* Nav / submit */}
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={() => setPos(Math.max(0, pos - 1))} disabled={pos === 0}
          style={{ flex: 1, fontSize: 13, fontWeight: 600, padding: '12px 0', borderRadius: 8, border: `1px solid ${T.border2}`, background: T.bg2, color: pos === 0 ? T.text3 : T.text, cursor: pos === 0 ? 'default' : 'pointer', fontFamily: 'inherit', opacity: pos === 0 ? 0.5 : 1 }}>
          ← Back
        </button>
        {!last ? (
          <button onClick={() => setPos(pos + 1)}
            style={{ flex: 1, fontSize: 13, fontWeight: 700, padding: '12px 0', borderRadius: 8, border: `1px solid ${T.blue}`, background: T.blue, color: '#fff', cursor: 'pointer', fontFamily: 'inherit' }}>
            Next →
          </button>
        ) : (
          <button onClick={onSubmit} disabled={!allAnswered || submitting}
            title={allAnswered ? undefined : 'Answer every question before submitting'}
            style={{ flex: 1, fontSize: 13, fontWeight: 700, padding: '12px 0', borderRadius: 8, border: `1px solid ${T.green}`, background: T.green, color: '#fff', cursor: allAnswered && !submitting ? 'pointer' : 'default', fontFamily: 'inherit', opacity: allAnswered && !submitting ? 1 : 0.5 }}>
            {submitting ? 'Marking…' : 'Submit answers'}
          </button>
        )}
      </div>
      {last && !allAnswered && (
        <div style={{ fontSize: 12, color: T.amber, textAlign: 'center' }}>
          {total - answeredCount} question{total - answeredCount === 1 ? '' : 's'} still unanswered — tap the numbered squares above to find them.
        </div>
      )}

      <button onClick={onBackToSlides}
        style={{ alignSelf: 'center', fontSize: 12, padding: '8px 14px', borderRadius: 7, border: 'none', background: 'transparent', color: T.text3, cursor: 'pointer', fontFamily: 'inherit', textDecoration: 'underline' }}>
        Back to the slides (your answers are kept)
      </button>
    </div>
  )
}

// ─── Results + review ─────────────────────────────────────────────────────
function ResultScreen({ result, coursesHref, coursesLabel, onRetake, onJumpToSlide }: {
  result: ExamResultData
  coursesHref: string
  coursesLabel: string
  onRetake: () => void
  onJumpToSlide: (n: number) => void
}) {
  const scoreColor = result.passed ? T.green : T.red
  const rightCount = result.review.filter(r => r.correct).length
  return (
    <div style={{ maxWidth: 760, margin: '0 auto', width: '100%', display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* Score header */}
      <div style={{ background: T.bg2, border: `1px solid ${alpha(scoreColor, '50')}`, borderRadius: 14, padding: '28px 20px', textAlign: 'center' }}>
        <div style={{ fontSize: 52, fontWeight: 800, color: scoreColor, lineHeight: 1 }}>
          {Math.round(result.score_pct)}%
        </div>
        <div style={{ fontSize: 15, fontWeight: 700, color: scoreColor, marginTop: 8, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
          {result.passed ? 'Passed' : 'Not passed'}
        </div>
        <div style={{ fontSize: 13, color: T.text2, marginTop: 6 }}>
          {rightCount} of {result.review.length} correct · pass mark {result.pass_pct}%
        </div>
        {result.passed ? (
          <div style={{ fontSize: 13, color: T.text2, marginTop: 10 }}>
            {result.preview
              ? 'Nice work — this was a preview attempt, so nothing was recorded and no one was notified.'
              : 'Nice work — your result has been recorded and the Just Autos team has been notified.'}
          </div>
        ) : (
          <div style={{ fontSize: 13, color: T.text2, marginTop: 10 }}>
            Review the explanations below, revisit the slides, and retake the quiz when you&rsquo;re ready.
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 16, flexWrap: 'wrap' }}>
          <button onClick={onRetake}
            style={{ fontSize: 13, fontWeight: 700, padding: '11px 22px', borderRadius: 8, border: `1px solid ${T.blue}`, background: result.passed ? 'transparent' : T.blue, color: result.passed ? T.blue : '#fff', cursor: 'pointer', fontFamily: 'inherit' }}>
            Retake the quiz
          </button>
          <a href={coursesHref}
            style={{ fontSize: 13, fontWeight: 600, padding: '11px 22px', borderRadius: 8, border: `1px solid ${T.border2}`, background: 'transparent', color: T.text, textDecoration: 'none' }}>
            {coursesLabel}
          </a>
        </div>
      </div>

      {/* Review */}
      <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: T.text2 }}>
        Review
      </div>
      {result.review.map((r, i) => (
        <div key={i} style={{ background: T.bg2, border: `1px solid ${r.correct ? T.border : alpha(T.red, '40')}`, borderRadius: 12, padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
            <span style={{ fontSize: 11, fontWeight: 800, color: r.correct ? T.green : T.red, flexShrink: 0 }}>
              {r.correct ? '✓' : '✗'} Q{i + 1}
            </span>
            <div style={{ fontSize: 14, fontWeight: 600, color: T.text, lineHeight: 1.5 }}>{r.q}</div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {r.options.map((opt, oi) => {
              const isCorrect = oi === r.correctIndex
              const isChosen = oi === r.chosen
              return (
                <div key={oi} style={{
                  padding: '9px 12px', borderRadius: 8, fontSize: 13, lineHeight: 1.45,
                  border: `1px solid ${isCorrect ? alpha(T.green, '60') : (isChosen ? alpha(T.red, '60') : T.border)}`,
                  background: isCorrect ? alpha(T.green, '14') : (isChosen ? alpha(T.red, '12') : T.bg3),
                  color: T.text,
                  display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'baseline',
                }}>
                  <span>{opt}</span>
                  {isCorrect && <span style={{ fontSize: 10, fontWeight: 700, color: T.green, whiteSpace: 'nowrap' }}>correct answer</span>}
                  {isChosen && !isCorrect && <span style={{ fontSize: 10, fontWeight: 700, color: T.red, whiteSpace: 'nowrap' }}>your answer</span>}
                </div>
              )
            })}
          </div>
          {r.explain && (
            <div style={{ fontSize: 12.5, color: T.text2, lineHeight: 1.55, borderTop: `1px solid ${T.border}`, paddingTop: 10 }}>
              {r.explain}
              {r.slide != null && (
                <button onClick={() => onJumpToSlide(r.slide!)}
                  style={{ marginLeft: 8, fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 6, border: `1px solid ${T.border2}`, background: 'transparent', color: T.blue, cursor: 'pointer', fontFamily: 'inherit' }}>
                  Slide {r.slide} →
                </button>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
