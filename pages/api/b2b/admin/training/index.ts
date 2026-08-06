// pages/api/b2b/admin/training/index.ts
// Staff training-assignment management (backs /admin/b2b/training).
//   GET → {
//     modules:      [{ id, slug, title, description, pass_pct, enabled,
//                      sections_count, slides_count, questions_count }],
//     distributors: [{ id, display_name, is_active }],
//     users:        [{ id, distributor_id, email, full_name, is_active }],
//     assignments:  [{ id, module_id, distributor_id, distributor_user_id }],
//     results:      [{ module_slug, user_id, attempts, passed,
//                      best_score_pct, passed_at, last_attempt_at }],
//   }
//   PATCH { module_id, enabled } → flips a module on/off globally
// The seeded "Portal Preview" demo users (preview+<distId>@…) are excluded
// from `users`, matching the team lists elsewhere. Assignment create/delete
// lives in ./assignments.ts.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { withAuth, PortalUser } from '../../../../../lib/authServer'
import { moduleSlideCount, TrainingSection } from '../../../../../lib/b2b-training'

function sb() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

export default withAuth('edit:b2b_distributors', async (req: NextApiRequest, res: NextApiResponse, _user: PortalUser) => {
  const c = sb()

  if (req.method === 'GET') {
    const [
      { data: mods, error: mErr },
      { data: dists, error: dErr },
      { data: users, error: uErr },
      { data: assigns, error: asErr },
      { data: attempts, error: aErr },
    ] = await Promise.all([
      c.from('b2b_training_modules').select('id, slug, title, description, pass_pct, enabled, content').order('created_at', { ascending: true }),
      c.from('b2b_distributors').select('id, display_name, is_active').order('display_name', { ascending: true }),
      c.from('b2b_distributor_users').select('id, distributor_id, email, full_name, is_active').order('created_at', { ascending: true }),
      c.from('b2b_training_assignments').select('id, module_id, distributor_id, distributor_user_id'),
      c.from('b2b_training_attempts').select('module_slug, user_id, score_pct, passed, completed_at').order('completed_at', { ascending: false }),
    ])
    const firstErr = mErr || dErr || uErr || asErr || aErr
    if (firstErr) return res.status(500).json({ error: firstErr.message })

    const modules = (mods || []).map((m: any) => {
      const sections = (m.content?.sections || []) as TrainingSection[]
      const questions = (m.content?.questions || []) as any[]
      return {
        id: m.id,
        slug: m.slug,
        title: m.title,
        description: m.description,
        pass_pct: m.pass_pct,
        enabled: m.enabled !== false,
        sections_count: sections.length,
        slides_count: moduleSlideCount(sections),
        questions_count: questions.length,
      }
    })

    // Per (user, module) attempt summary — same aggregation as the
    // distributor-detail training endpoint (rows arrive newest-first).
    const key = (userId: string, slug: string) => `${userId}:${slug}`
    const agg = new Map<string, { attempts: number; passed: boolean; best: number | null; passedAt: string | null; lastAt: string | null }>()
    for (const a of attempts || []) {
      const k = key(a.user_id, a.module_slug)
      const cur = agg.get(k) || { attempts: 0, passed: false, best: null, passedAt: null, lastAt: null }
      cur.attempts++
      if (!cur.lastAt) cur.lastAt = a.completed_at
      if (cur.best === null || Number(a.score_pct) > cur.best) cur.best = Number(a.score_pct)
      if (a.passed) { cur.passed = true; cur.passedAt = a.completed_at }  // earliest pass wins (list is desc)
      agg.set(k, cur)
    }
    const results = Array.from(agg.entries()).map(([k, s]) => {
      const i = k.indexOf(':')
      return {
        user_id: k.slice(0, i),
        module_slug: k.slice(i + 1),
        attempts: s.attempts,
        passed: s.passed,
        best_score_pct: s.best,
        passed_at: s.passedAt,
        last_attempt_at: s.lastAt,
      }
    })

    return res.status(200).json({
      modules,
      distributors: dists || [],
      users: (users || []).filter(u => !String(u.email || '').startsWith('preview+')),
      assignments: assigns || [],
      results,
    })
  }

  if (req.method === 'PATCH') {
    const b = req.body || {}
    const moduleId = String(b.module_id || '').trim()
    if (!moduleId || typeof b.enabled !== 'boolean') return res.status(400).json({ error: 'module_id and enabled required' })
    const { error } = await c.from('b2b_training_modules')
      .update({ enabled: b.enabled, updated_at: new Date().toISOString() })
      .eq('id', moduleId)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  res.setHeader('Allow', 'GET, PATCH')
  return res.status(405).json({ error: 'GET or PATCH only' })
})
