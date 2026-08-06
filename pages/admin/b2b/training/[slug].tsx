// pages/admin/b2b/training/[slug].tsx — READ-ONLY admin preview of a course:
// every section with its slides, then the full quiz with the correct answer
// highlighted and the explanation shown (the distributor player never reveals
// answers pre-submit — this page is how staff vet a course before assigning).

import { useEffect, useState } from 'react'
import Head from 'next/head'
import { useRouter } from 'next/router'
import PortalTopBar from '../../../../lib/PortalTopBar'
import B2BAdminTabs from '../../../../components/b2b/B2BAdminTabs'
import { requirePageAuth } from '../../../../lib/authServer'
import { T, alpha } from '../../../../lib/ui/theme'

interface PreviewSection { title: string; intro?: string; slides: number[] }
interface PreviewQuestion { q: string; options: string[]; correct: number; explain?: string; slide?: number }
interface PreviewModule {
  slug: string; title: string; description: string | null
  pass_pct: number; enabled: boolean
  sections: PreviewSection[]; questions: PreviewQuestion[]
}

const pad2 = (n: number) => String(n).padStart(2, '0')

export default function TrainingPreview({ user }: { user: any }) {
  const router = useRouter()
  const slug = typeof router.query.slug === 'string' ? router.query.slug : ''
  const [mod, setMod] = useState<PreviewModule | null>(null)
  const [error, setError] = useState('')
  const [lightbox, setLightbox] = useState<number | null>(null)   // slide number

  useEffect(() => {
    if (!slug) return
    fetch(`/api/b2b/admin/training/${encodeURIComponent(slug)}`, { credentials: 'same-origin' })
      .then(r => r.json())
      .then(d => { if (d.error) throw new Error(d.error); setMod(d.module) })
      .catch(e => setError(e.message || 'Load failed'))
  }, [slug])

  return (
    <>
      <Head><title>{mod ? `Preview: ${mod.title}` : 'Course preview'} — Just Autos</title><meta name="robots" content="noindex,nofollow" /></Head>
      <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh', fontFamily: "'DM Sans',system-ui,sans-serif", background: T.bg, color: T.text }}>
        <PortalTopBar activeId="b2b" currentUserRole={user.role} currentUserVisibleTabs={user.visibleTabs} currentUserName={user.displayName} currentUserEmail={user.email} />
        <main className="b2b-admin-main" style={{ flex: 1, padding: '28px 32px', width: '100%', boxSizing: 'border-box' }}>
        <B2BAdminTabs active="training" />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 1100 }}>

          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
            <a href="/admin/b2b/training" style={{ fontSize: 12, color: T.text3, textDecoration: 'none', whiteSpace: 'nowrap' }}>← Training assignments</a>
            {mod && (
              <>
                <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>{mod.title}</h1>
                <span style={{ fontSize: 12, color: T.text3 }}>
                  <span style={{ fontFamily: 'monospace' }}>{mod.slug}</span> · pass mark {mod.pass_pct}% · {mod.questions.length} questions
                  {!mod.enabled && <span style={{ color: T.amber }}> · module disabled</span>}
                </span>
              </>
            )}
          </div>
          {mod?.description && <div style={{ fontSize: 13, color: T.text2, marginTop: -8 }}>{mod.description}</div>}

          {error && <div style={{ background: alpha(T.red, '1a'), border: `1px solid ${alpha(T.red, '40')}`, borderRadius: 8, padding: 12, color: T.red, fontSize: 13 }}>{error}</div>}
          {!mod && !error && <div style={{ color: T.text3, textAlign: 'center', padding: 30 }}>Loading…</div>}

          {/* ── Course slides, section by section ─────────────────────── */}
          {mod && mod.sections.map((s, si) => (
            <section key={si} style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 12, padding: '14px 18px' }}>
              <div style={{ fontSize: 14, fontWeight: 700 }}>{si + 1}. {s.title}</div>
              {s.intro && <div style={{ fontSize: 12.5, color: T.text2, marginTop: 4 }}>{s.intro}</div>}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 10, marginTop: 12 }}>
                {(s.slides || []).map(n => (
                  <button key={n} onClick={() => setLightbox(n)}
                    style={{ background: 'none', border: `1px solid ${T.border}`, borderRadius: 8, padding: 0, cursor: 'zoom-in', overflow: 'hidden' }}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={`/training/${mod.slug}/${pad2(n)}.jpg`} alt={`Slide ${n}`} loading="lazy"
                      style={{ display: 'block', width: '100%', height: 'auto' }} />
                    <div style={{ fontSize: 10.5, color: T.text3, padding: '3px 0 5px' }}>Slide {n}</div>
                  </button>
                ))}
              </div>
            </section>
          ))}

          {/* ── Quiz with answers ─────────────────────────────────────── */}
          {mod && mod.questions.length > 0 && (
            <section style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 12, padding: '14px 18px' }}>
              <div style={{ fontSize: 14, fontWeight: 700 }}>Quiz — {mod.questions.length} questions, correct answers highlighted</div>
              <div style={{ fontSize: 12, color: T.text3, marginTop: 3 }}>Distributors see the questions in random order and never see answers before submitting.</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 14 }}>
                {mod.questions.map((q, qi) => (
                  <div key={qi} style={{ background: T.bg3, border: `1px solid ${T.border}`, borderRadius: 9, padding: '11px 14px' }}>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>
                      {qi + 1}. {q.q}
                      {q.slide != null && (
                        <button onClick={() => setLightbox(q.slide!)}
                          style={{ marginLeft: 8, fontSize: 10.5, color: T.blue, background: 'none', border: `1px solid ${alpha(T.blue, '45')}`, borderRadius: 6, padding: '1px 7px', cursor: 'pointer' }}>
                          slide {q.slide}
                        </button>
                      )}
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginTop: 8 }}>
                      {q.options.map((opt, oi) => {
                        const isCorrect = oi === q.correct
                        return (
                          <div key={oi} style={{
                            display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 12.5, borderRadius: 7, padding: '5px 9px',
                            background: isCorrect ? alpha(T.green, '16') : 'transparent',
                            border: `1px solid ${isCorrect ? alpha(T.green, '50') : 'transparent'}`,
                            color: isCorrect ? T.green : T.text2, fontWeight: isCorrect ? 600 : 400,
                          }}>
                            <span style={{ fontFamily: 'monospace', fontSize: 11 }}>{String.fromCharCode(65 + oi)}.</span>
                            <span style={{ flex: 1 }}>{opt}</span>
                            {isCorrect && <span style={{ fontSize: 11, whiteSpace: 'nowrap' }}>✓ correct</span>}
                          </div>
                        )
                      })}
                    </div>
                    {q.explain && <div style={{ fontSize: 12, color: T.text3, fontStyle: 'italic', marginTop: 7 }}>{q.explain}</div>}
                  </div>
                ))}
              </div>
            </section>
          )}

        </div>
        </main>

        {/* Slide lightbox */}
        {mod && lightbox != null && (
          <div onClick={() => setLightbox(null)}
            style={{ position: 'fixed', inset: 0, background: alpha('#000000', 'cc'), display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200, cursor: 'zoom-out', padding: 24 }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`/training/${mod.slug}/${pad2(lightbox)}.jpg`} alt={`Slide ${lightbox}`}
              style={{ maxWidth: '92vw', maxHeight: '90vh', borderRadius: 10, boxShadow: '0 12px 48px rgba(0,0,0,0.5)' }} />
          </div>
        )}
      </div>
    </>
  )
}

export async function getServerSideProps(context: any) {
  return requirePageAuth(context, 'edit:b2b_distributors')
}
