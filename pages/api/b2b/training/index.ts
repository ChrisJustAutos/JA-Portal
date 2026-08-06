// pages/api/b2b/training/index.ts
// Distributor training — module list.
//   GET → { modules: [{ slug, title, description, pass_pct, sections_count,
//           slides_count, attempts, best, latest }] }
// `best` / `latest` are THIS user's attempt summaries (score/passed/date) so
// the list page can show a Passed / Attempted / Not started pill. Correct
// answers never appear here — see [slug].ts for the exam flow.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { withB2BAuth, B2BUser } from '../../../../lib/b2bAuthServer'
import { moduleSlideCount, TrainingSection } from '../../../../lib/b2b-training'

function sb() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

interface AttemptSummary {
  score_pct: number
  passed: boolean
  completed_at: string | null
}

export default withB2BAuth(async (req: NextApiRequest, res: NextApiResponse, user: B2BUser) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'GET only' })
  }
  const c = sb()

  const { data: mods, error } = await c
    .from('b2b_training_modules')
    .select('slug, title, description, pass_pct, content, created_at')
    .eq('enabled', true)
    .order('created_at', { ascending: true })
  if (error) return res.status(500).json({ error: error.message })

  // The preview user's id isn't a real b2b_distributor_users row unless it was
  // seeded; either way the .eq() below just returns no attempts. ('preview'
  // fallback id would 22P02 on the uuid column, so guard it.)
  const userIdIsUuid = /^[0-9a-f-]{36}$/i.test(user.id)
  let attempts: Array<{ module_slug: string } & AttemptSummary> = []
  if (userIdIsUuid) {
    const { data: rows, error: aErr } = await c
      .from('b2b_training_attempts')
      .select('module_slug, score_pct, passed, completed_at')
      .eq('user_id', user.id)
      .order('completed_at', { ascending: false })
    if (aErr) return res.status(500).json({ error: aErr.message })
    attempts = (rows || []) as any
  }

  const bySlug = new Map<string, { count: number; best: AttemptSummary | null; latest: AttemptSummary | null }>()
  for (const a of attempts) {
    const cur = bySlug.get(a.module_slug) || { count: 0, best: null, latest: null }
    cur.count++
    if (!cur.latest) cur.latest = a               // rows are newest-first
    if (!cur.best || Number(a.score_pct) > Number(cur.best.score_pct)) cur.best = a
    bySlug.set(a.module_slug, cur)
  }

  const modules = (mods || []).map((m: any) => {
    const sections = (m.content?.sections || []) as TrainingSection[]
    const questions = (m.content?.questions || []) as any[]
    const mine = bySlug.get(m.slug) || { count: 0, best: null, latest: null }
    return {
      slug: m.slug,
      title: m.title,
      description: m.description,
      pass_pct: m.pass_pct,
      sections_count: sections.length,
      slides_count: moduleSlideCount(sections),
      questions_count: questions.length,
      attempts: mine.count,
      best: mine.best ? { score_pct: Number(mine.best.score_pct), passed: mine.best.passed, completed_at: mine.best.completed_at } : null,
      latest: mine.latest ? { score_pct: Number(mine.latest.score_pct), passed: mine.latest.passed, completed_at: mine.latest.completed_at } : null,
    }
  })

  return res.status(200).json({ modules })
})
