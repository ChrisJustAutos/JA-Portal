// pages/b2b/training/index.tsx
// Distributor training — module list. Each enabled course is a card with the
// user's own status (Passed x% / Attempted / Not started) and a Start /
// Continue / Review button into the player at /b2b/training/<slug>.

import { useEffect, useState } from 'react'
import Head from 'next/head'
import type { GetServerSideProps } from 'next'
import B2BLayout from '../../../components/b2b/B2BLayout'
import { requireB2BPageAuth } from '../../../lib/b2bAuthServer'
import { T } from '../../../lib/ui/theme'
import { A, Banner, Card, EmptyState, PageTitle, StatusPill, btnStyle } from '../../../components/b2b/ui'

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
        <div style={{ maxWidth: 900, margin: '0 auto' }}>

          <PageTitle sub="Work through each course at your own pace, then sit the quiz — your progress is saved automatically.">
            Training
          </PageTitle>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

            {error && <Banner tone="error">{error}</Banner>}
            {modules === null && !error && <div style={{ color: T.text3, padding: 30, textAlign: 'center', fontSize: 13 }}>Loading…</div>}

            {modules !== null && modules.length === 0 && (
              <EmptyState title="No training courses published yet" sub="Check back soon." />
            )}

            {(modules || []).map(m => <ModuleCardRow key={m.slug} m={m} />)}
          </div>
        </div>
      </B2BLayout>
    </>
  )
}

function ModuleCardRow({ m }: { m: ModuleCard }) {
  const passed = !!m.best?.passed
  const attempted = m.attempts > 0

  const pill = passed
    ? <StatusPill color={A.good}>Passed {Math.round(m.best!.score_pct)}%</StatusPill>
    : attempted
      ? <StatusPill color={A.warn}>Attempted · best {Math.round(m.best?.score_pct ?? 0)}%</StatusPill>
      : <StatusPill color={T.text3}>Not started</StatusPill>

  const cta = passed ? 'Review' : attempted ? 'Continue' : 'Start'

  return (
    <Card style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: T.text, flex: 1, minWidth: 200 }}>{m.title}</div>
        {pill}
      </div>
      {m.description && (
        <div style={{ fontSize: 13, color: T.text2, lineHeight: 1.55 }}>{m.description}</div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', fontSize: 12.5, color: T.text3 }}>
        <span>{m.sections_count} sections</span>
        <span>·</span>
        <span>{m.slides_count} slides</span>
        <span>·</span>
        <span>{m.questions_count}-question quiz</span>
        <span>·</span>
        <span>pass mark {m.pass_pct}%</span>
        {passed && m.best?.completed_at && (<><span>·</span><span style={{ color: A.good }}>passed {formatDate(m.best.completed_at)}</span></>)}
      </div>
      <div>
        <a href={`/b2b/training/${m.slug}`}
          style={{ ...btnStyle(passed ? 'secondary' : 'primary', 'md'), textDecoration: 'none' }}>
          {cta}
        </a>
      </div>
    </Card>
  )
}

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  return await requireB2BPageAuth(ctx) as any
}
