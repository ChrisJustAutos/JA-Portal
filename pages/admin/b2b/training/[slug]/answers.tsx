// pages/admin/b2b/training/[slug]/answers.tsx — the answer sheet + quiz
// EDITOR: every section with its slides, then the full quiz with the correct
// answer highlighted and the explanation shown (the distributor player never
// reveals answers pre-submit — this page is how staff vet a course before
// assigning). Questions are EDITABLE here — per-question edit/delete, add,
// and a sticky Save bar that PATCHes the full replacement array. Works on
// generated drafts (arriving via ?review=1 from the upload flow) and on the
// repo-baked modules alike. Sections/slides are never edited here — for
// generated courses the slides ARE the document.
// The interactive "preview as distributor" player lives one level up at
// /admin/b2b/training/<slug>.
// Restyled onto the shared Alloy kit (components/b2b/ui) 2026-08-12.

import { useEffect, useState } from 'react'
import Head from 'next/head'
import { useRouter } from 'next/router'
import PortalTopBar from '../../../../../lib/PortalTopBar'
import B2BAdminTabs from '../../../../../components/b2b/B2BAdminTabs'
import { requirePageAuth } from '../../../../../lib/authServer'
import { T, alpha } from '../../../../../lib/ui/theme'
import { useToast } from '../../../../../components/ui/Feedback'
import { A, Btn, cardStyle, Banner, inputStyle, RADIUS, SHADOW } from '../../../../../components/b2b/ui'

interface PreviewSection { title: string; intro?: string; slides: number[] }
interface PreviewQuestion { q: string; options: string[]; correct: number; explain?: string; slide?: number }
interface PreviewModule {
  slug: string; title: string; description: string | null
  pass_pct: number; enabled: boolean
  sections: PreviewSection[]; questions: PreviewQuestion[]
  slide_base?: string | null
}

const pad2 = (n: number) => String(n).padStart(2, '0')
// Generated modules carry slide_base (storage URL prefix); repo-baked ones
// fall back to the hard-coded /public path, byte-identically.
const slideSrc = (mod: { slide_base?: string | null; slug: string }, n: number) =>
  `${mod.slide_base || `/training/${mod.slug}`}/${pad2(n)}.jpg`

const blankQuestion = (): PreviewQuestion => ({ q: '', options: ['', '', '', ''], correct: 0 })

export default function TrainingPreview({ user }: { user: any }) {
  const router = useRouter()
  const toast = useToast()
  const slug = typeof router.query.slug === 'string' ? router.query.slug : ''
  const review = router.query.review === '1'
  const [mod, setMod] = useState<PreviewModule | null>(null)
  const [error, setError] = useState('')
  const [lightbox, setLightbox] = useState<number | null>(null)   // slide number

  // Editable working copy of the quiz. `dirty` gates the sticky Save bar.
  const [questions, setQuestions] = useState<PreviewQuestion[]>([])
  const [editing, setEditing] = useState<Set<number>>(new Set())
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!slug) return
    fetch(`/api/b2b/admin/training/${encodeURIComponent(slug)}`, { credentials: 'same-origin' })
      .then(r => r.json())
      .then(d => {
        if (d.error) throw new Error(d.error)
        setMod(d.module)
        setQuestions((d.module.questions || []).map((q: PreviewQuestion) => ({ ...q, options: [...q.options] })))
        setDirty(false)
        setEditing(new Set())
      })
      .catch(e => setError(e.message || 'Load failed'))
  }, [slug])

  function updateQ(i: number, patch: Partial<PreviewQuestion>) {
    setQuestions(qs => qs.map((q, j) => j === i ? { ...q, ...patch } : q))
    setDirty(true)
  }
  function updateOption(i: number, oi: number, v: string) {
    setQuestions(qs => qs.map((q, j) => j === i ? { ...q, options: q.options.map((o, k) => k === oi ? v : o) } : q))
    setDirty(true)
  }
  function deleteQ(i: number) {
    setQuestions(qs => qs.filter((_, j) => j !== i))
    setEditing(s => {
      const n = new Set<number>()
      s.forEach(k => { if (k < i) n.add(k); else if (k > i) n.add(k - 1) })
      return n
    })
    setDirty(true)
  }
  function addQ() {
    setQuestions(qs => [...qs, blankQuestion()])
    setEditing(s => new Set(s).add(questions.length))
    setDirty(true)
  }
  function toggleEdit(i: number) {
    setEditing(s => { const n = new Set(s); if (n.has(i)) n.delete(i); else n.add(i); return n })
  }

  function discard() {
    if (!mod) return
    setQuestions((mod.questions || []).map(q => ({ ...q, options: [...q.options] })))
    setEditing(new Set())
    setDirty(false)
  }

  async function save() {
    if (!mod) return
    setSaving(true)
    try {
      const payload = questions.map(q => ({
        q: q.q, options: q.options, correct: q.correct,
        ...(String(q.explain || '').trim() ? { explain: String(q.explain).trim() } : {}),
        ...(q.slide != null && String(q.slide) !== '' ? { slide: Number(q.slide) } : {}),
      }))
      const r = await fetch(`/api/b2b/admin/training/${encodeURIComponent(slug)}`, {
        method: 'PATCH', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ questions: payload }),
      }).then(x => x.json())
      if (r.error) throw new Error(r.error)
      setMod(m => m ? { ...m, questions: payload as PreviewQuestion[] } : m)
      setEditing(new Set())
      setDirty(false)
      toast(`Quiz saved — ${payload.length} questions`, 'success')
    } catch (e: any) {
      toast(e.message || 'Save failed', 'error')
    } finally {
      setSaving(false)
    }
  }

  const maxSlide = mod ? mod.sections.reduce((m, s) => Math.max(m, ...(s.slides.length ? s.slides : [0])), 0) : 0
  const showDraftBanner = mod ? (review || !mod.enabled) : false

  return (
    <>
      <Head><title>{mod ? `Preview: ${mod.title}` : 'Course preview'} — Just Autos</title><meta name="robots" content="noindex,nofollow" /></Head>
      <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh', fontFamily: "'DM Sans',system-ui,sans-serif", background: T.bg, color: T.text }}>
        <PortalTopBar activeId="b2b" currentUserRole={user.role} currentUserVisibleTabs={user.visibleTabs} currentUserName={user.displayName} currentUserEmail={user.email} />
        <main className="b2b-admin-main" style={{ flex: 1, padding: '28px 32px', width: '100%', boxSizing: 'border-box' }}>
        <B2BAdminTabs active="training" />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 1100 }}>

          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
            <a href="/admin/b2b/training" style={{ fontSize: 12.5, color: T.text3, textDecoration: 'none', whiteSpace: 'nowrap' }}>← Training assignments</a>
            {mod && (
              <>
                <h1 style={{ margin: 0, fontSize: 26, fontWeight: 700, letterSpacing: '-0.02em', lineHeight: 1.15 }}>{mod.title}</h1>
                <span style={{ fontSize: 12.5, color: T.text3 }}>
                  <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{mod.slug}</span> · pass mark {mod.pass_pct}% · {questions.length} questions
                  {!mod.enabled && <span style={{ color: A.warn }}> · module disabled</span>}
                </span>
              </>
            )}
          </div>
          {mod?.description && <div style={{ fontSize: 13, color: T.text2, marginTop: -8 }}>{mod.description}</div>}

          {showDraftBanner && (
            <div style={{ marginTop: -6 }}>
              <Banner tone="warn">
                <span style={{ color: A.warn, fontWeight: 600 }}>
                  Draft course — review the suggested questions, then enable it on the Training page and assign it.
                </span>
              </Banner>
            </div>
          )}

          {error && <Banner tone="error">{error}</Banner>}
          {!mod && !error && <div style={{ color: T.text3, textAlign: 'center', padding: 30 }}>Loading…</div>}

          {/* ── Course slides, section by section ─────────────────────── */}
          {mod && mod.sections.map((s, si) => (
            <section key={si} style={{ ...cardStyle(false), padding: '14px 18px' }}>
              <div style={{ fontSize: 14, fontWeight: 700 }}>{si + 1}. {s.title}</div>
              {s.intro && <div style={{ fontSize: 12.5, color: T.text2, marginTop: 4 }}>{s.intro}</div>}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 10, marginTop: 12 }}>
                {(s.slides || []).map(n => (
                  <button key={n} onClick={() => setLightbox(n)}
                    className="al-raise al-focus"
                    style={{ background: 'none', border: `1px solid ${T.border}`, borderRadius: RADIUS.sm, padding: 0, cursor: 'zoom-in', overflow: 'hidden' }}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={slideSrc(mod, n)} alt={`Slide ${n}`} loading="lazy"
                      style={{ display: 'block', width: '100%', height: 'auto' }} />
                    <div style={{ fontSize: 12, color: T.text3, padding: '3px 0 5px' }}>Slide {n}</div>
                  </button>
                ))}
              </div>
            </section>
          ))}

          {/* ── Quiz with answers — editable ──────────────────────────── */}
          {mod && (
            <section style={{ ...cardStyle(false), padding: '14px 18px' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 240 }}>
                  <div style={{ fontSize: 14, fontWeight: 700 }}>Quiz — {questions.length} questions, correct answers highlighted</div>
                  <div style={{ fontSize: 12.5, color: T.text3, marginTop: 3 }}>Distributors see the questions in random order and never see answers before submitting. Edit freely — nothing changes for distributors until you save.</div>
                </div>
                <Btn variant="secondary" size="sm" onClick={addQ}>
                  Add question
                </Btn>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 14 }}>
                {questions.map((q, qi) => editing.has(qi) ? (
                  <QuestionEditor key={qi} q={q} qi={qi} maxSlide={maxSlide}
                    onChange={patch => updateQ(qi, patch)}
                    onOption={(oi, v) => updateOption(qi, oi, v)}
                    onDone={() => toggleEdit(qi)}
                    onDelete={() => deleteQ(qi)} />
                ) : (
                  <div key={qi} style={{ background: T.bg3, borderRadius: RADIUS.sm, padding: '11px 14px' }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                      <div style={{ flex: 1, fontSize: 13, fontWeight: 600 }}>
                        {qi + 1}. {q.q || <span style={{ color: T.text3, fontStyle: 'italic' }}>(empty question)</span>}
                        {q.slide != null && (
                          <button onClick={() => setLightbox(q.slide!)}
                            className="al-press al-focus"
                            style={{ marginLeft: 8, fontSize: 12, fontWeight: 600, color: A.accent, background: 'none', border: `1px solid ${alpha(A.accent, '45')}`, borderRadius: RADIUS.pill, padding: '1px 9px', cursor: 'pointer', fontFamily: 'inherit' }}>
                            slide {q.slide}
                          </button>
                        )}
                      </div>
                      <button onClick={() => toggleEdit(qi)}
                        className="al-press al-focus"
                        style={{ fontSize: 12.5, fontWeight: 700, color: A.accent, background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' }}>
                        Edit
                      </button>
                      <button onClick={() => deleteQ(qi)}
                        className="al-press al-focus"
                        style={{ fontSize: 12.5, fontWeight: 700, color: A.bad, background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' }}>
                        Delete
                      </button>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginTop: 8 }}>
                      {q.options.map((opt, oi) => {
                        const isCorrect = oi === q.correct
                        return (
                          <div key={oi} style={{
                            display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 12.5, borderRadius: RADIUS.sm - 3, padding: '5px 9px',
                            background: isCorrect ? alpha(A.good, '16') : 'transparent',
                            border: `1px solid ${isCorrect ? alpha(A.good, '50') : 'transparent'}`,
                            color: isCorrect ? A.good : T.text2, fontWeight: isCorrect ? 600 : 400,
                          }}>
                            <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{String.fromCharCode(65 + oi)}.</span>
                            <span style={{ flex: 1 }}>{opt}</span>
                            {isCorrect && <span style={{ fontSize: 12, whiteSpace: 'nowrap' }}>✓ correct</span>}
                          </div>
                        )
                      })}
                    </div>
                    {q.explain && <div style={{ fontSize: 12.5, color: T.text3, fontStyle: 'italic', marginTop: 7 }}>{q.explain}</div>}
                  </div>
                ))}
                {questions.length === 0 && (
                  <div style={{ fontSize: 12.5, color: T.text3, fontStyle: 'italic', padding: '6px 0' }}>No questions yet — add one above.</div>
                )}
              </div>
            </section>
          )}

          {/* ── Sticky save bar ───────────────────────────────────────── */}
          {mod && dirty && (
            <div style={{
              position: 'sticky', bottom: 12, zIndex: 50,
              display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
              background: T.bg2, border: `1px solid ${alpha(A.accent, '55')}`, borderRadius: RADIUS.md,
              padding: '10px 14px', boxShadow: SHADOW.md,
            }}>
              <span style={{ flex: 1, minWidth: 200, fontSize: 12.5, color: T.text2 }}>
                Unsaved quiz changes — {questions.length} question{questions.length === 1 ? '' : 's'}.
              </span>
              <Btn variant="ghost" size="sm" onClick={discard} disabled={saving}>
                Discard
              </Btn>
              <Btn size="sm" onClick={save} disabled={saving}>
                {saving ? 'Saving…' : 'Save changes'}
              </Btn>
            </div>
          )}

        </div>
        </main>

        {/* Slide lightbox */}
        {mod && lightbox != null && (
          <div onClick={() => setLightbox(null)}
            style={{ position: 'fixed', inset: 0, background: alpha('#000000', 'cc'), display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200, cursor: 'zoom-out', padding: 24 }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={slideSrc(mod, lightbox)} alt={`Slide ${lightbox}`}
              style={{ maxWidth: '92vw', maxHeight: '90vh', borderRadius: RADIUS.sm, boxShadow: SHADOW.md }} />
          </div>
        )}
      </div>
    </>
  )
}

// ─── Per-question edit form ───────────────────────────────────────────────
function QuestionEditor({ q, qi, maxSlide, onChange, onOption, onDone, onDelete }: {
  q: PreviewQuestion
  qi: number
  maxSlide: number
  onChange: (patch: Partial<PreviewQuestion>) => void
  onOption: (oi: number, v: string) => void
  onDone: () => void
  onDelete: () => void
}) {
  // Dense editor inputs — kit look, editor-scale type (floor is 12px).
  const editorInput: React.CSSProperties = {
    ...inputStyle(), background: T.bg2, padding: '8px 10px', fontSize: 13, minHeight: 36,
  }
  const labelStyle: React.CSSProperties = { fontSize: 12, fontWeight: 650, color: T.text2, marginBottom: 4, display: 'block' }

  return (
    <div style={{ background: T.bg3, border: `1px solid ${alpha(A.accent, '45')}`, borderRadius: RADIUS.sm, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ flex: 1, fontSize: 12.5, fontWeight: 700, color: A.accent }}>Editing question {qi + 1}</span>
        <button onClick={onDelete}
          className="al-press al-focus"
          style={{ fontSize: 12, fontWeight: 700, color: A.bad, background: 'none', border: `1px solid ${alpha(A.bad, '45')}`, borderRadius: RADIUS.pill, padding: '3px 12px', cursor: 'pointer', fontFamily: 'inherit' }}>
          Delete
        </button>
        <button onClick={onDone}
          className="al-press al-focus"
          style={{ fontSize: 12, fontWeight: 700, color: T.text, background: T.bg2, border: `1px solid ${T.border2}`, borderRadius: RADIUS.pill, padding: '3px 12px', cursor: 'pointer', fontFamily: 'inherit' }}>
          Done
        </button>
      </div>

      <div>
        <label style={labelStyle}>Question</label>
        <textarea value={q.q} rows={2} onChange={e => onChange({ q: e.target.value })}
          style={{ ...editorInput, resize: 'vertical' }} />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <label style={labelStyle}>Options — tick the correct answer</label>
        {q.options.map((opt, oi) => (
          <div key={oi} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input type="radio" name={`correct-${qi}`} checked={q.correct === oi}
              onChange={() => onChange({ correct: oi })} style={{ flexShrink: 0, cursor: 'pointer' }} />
            <span style={{ fontFamily: 'monospace', fontSize: 12, color: T.text3, flexShrink: 0 }}>{String.fromCharCode(65 + oi)}.</span>
            <input value={opt} onChange={e => onOption(oi, e.target.value)} style={editorInput} />
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 240 }}>
          <label style={labelStyle}>Explanation (shown after submit)</label>
          <textarea value={q.explain || ''} rows={2} onChange={e => onChange({ explain: e.target.value })}
            style={{ ...editorInput, resize: 'vertical' }} />
        </div>
        <div style={{ width: 130 }}>
          <label style={labelStyle}>Slide{maxSlide > 0 ? ` (1–${maxSlide})` : ''}</label>
          <input type="number" min={1} max={maxSlide || undefined} value={q.slide ?? ''}
            onChange={e => onChange({ slide: e.target.value === '' ? undefined : Number(e.target.value) })}
            placeholder="—" style={editorInput} />
        </div>
      </div>
    </div>
  )
}

export async function getServerSideProps(context: any) {
  return requirePageAuth(context, 'edit:b2b_distributors')
}
