// pages/b2b/training/index.tsx
// Distributor training — module list. Each enabled course is a card with the
// user's own status (Passed x% / Attempted / Not started) and a Start /
// Continue / Review button into the player at /b2b/training/<slug>.

import { useEffect, useState } from 'react'
import Head from 'next/head'
import type { GetServerSideProps } from 'next'
import B2BLayout from '../../../components/b2b/B2BLayout'
import { requireB2BPageAuth } from '../../../lib/b2bAuthServer'
import { T, alpha } from '../../../lib/ui/theme'

interface Props {
  b2bUser: {
    id: string
    email: string
    fullName: string | null
    role: 'owner' | 'member'
    preview?: boolean
    distributor: { id: string; displayName: string }
  }
}

interface AttemptSummary {
  score_pct: number
  passed: boolean
  completed_at: string | null
}

interface ModuleCard {
  slug: string
  title: string
  description: string | null
  pass_pct: number
  sections_count: number
  slides_count: number
  questions_count: number
  attempts: number
  best: AttemptSummary | null
  latest: AttemptSummary | null
}

function formatDate(iso: string | null): string {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' })
}

export default function B2BTrainingIndex({ b2bUser }: Props) {
  const [modules, setModules] = useState<ModuleCard[] | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    fetch('/api/b2b/training', { credentials: 'same-origin' })
      .then(r => r.json())
      .then(d => { if (d.error) throw new Error(d.error); setModules(d.modules || []) })
      .catch(e => setError(e.message || 'Failed to load'))
  }, [])

  return (
    <>
      <Head><title>Training · Just Autos B2B</title><meta name="robots" content="noindex,nofollow" /></Head>
      <B2BLayout user={b2bUser} active="training">
        <div style={{ maxWidth: 900, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 18 }}>

          <div>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>Training</h1>
            <div style={{ fontSize: 13, color: T.text3, marginTop: 4 }}>
              Work through each course at your own pace, then sit the quiz — your progress is saved automatically.
            </div>
          </div>

          {error && (
            <div style={{ background: 'rgba(240,78,78,0.1)', border: `1px solid ${T.red}40`, borderRadius: 8, padding: 12, fontSize: 13, color: T.red }}>
              {error}
            </div>
          )}
          {modules === null && !error && <div style={{ color: T.text3, padding: 30, textAlign: 'center' }}>Loading…</div>}

          {modules !== null && modules.length === 0 && (
            <div style={{ padding: 36, textAlign: 'center', background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 10, color: T.text3, fontStyle: 'italic' }}>
              No training courses published yet — check back soon.
            </div>
          )}

          {(modules || []).map(m => <ModuleCardRow key={m.slug} m={m} />)}
        </div>
      </B2BLayout>
    </>
  )
}

function ModuleCardRow({ m }: { m: ModuleCard }) {
  const passed = !!m.best?.passed
  const attempted = m.attempts > 0

  const pill = passed
    ? <Pill color={T.green} label={`Passed ${Math.round(m.best!.score_pct)}%`} />
    : attempted
      ? <Pill color={T.amber} label={`Attempted · best ${Math.round(m.best?.score_pct ?? 0)}%`} />
      : <Pill color={T.text3} label="Not started" />

  const cta = passed ? 'Review' : attempted ? 'Continue' : 'Start'

  return (
    <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 12, padding: 18, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: T.text, flex: 1, minWidth: 200 }}>{m.title}</div>
        {pill}
      </div>
      {m.description && (
        <div style={{ fontSize: 13, color: T.text2, lineHeight: 1.55 }}>{m.description}</div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', fontSize: 12, color: T.text3 }}>
        <span>{m.sections_count} sections</span>
        <span>·</span>
        <span>{m.slides_count} slides</span>
        <span>·</span>
        <span>{m.questions_count}-question quiz</span>
        <span>·</span>
        <span>pass mark {m.pass_pct}%</span>
        {passed && m.best?.completed_at && (<><span>·</span><span style={{ color: T.green }}>passed {formatDate(m.best.completed_at)}</span></>)}
      </div>
      <div>
        <a href={`/b2b/training/${m.slug}`}
          style={{
            display: 'inline-block', textDecoration: 'none',
            fontSize: 13, fontWeight: 700, padding: '10px 22px', borderRadius: 8,
            border: `1px solid ${passed ? T.border2 : T.blue}`,
            background: passed ? 'transparent' : T.blue,
            color: passed ? T.text : '#fff',
          }}>
          {cta}
        </a>
      </div>
    </div>
  )
}

function Pill({ color, label }: { color: string; label: string }) {
  return (
    <span style={{ fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 9, background: alpha(color, '18'), color, whiteSpace: 'nowrap' }}>
      {label}
    </span>
  )
}

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  return await requireB2BPageAuth(ctx) as any
}
