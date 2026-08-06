// pages/api/b2b/admin/distributors/[id]/training.ts
// Staff view of a distributor's training progress.
//   GET → { rows: [{ user_id, user_name, user_email, user_active,
//                    module_slug, module_title, pass_pct,
//                    attempts, passed, best_score_pct, passed_at, last_attempt_at }] }
// One row per (portal user × module ASSIGNED to this distributor) — training
// is assignment-gated (migration 192), so only modules with an assignment row
// for this distributor (whole-distributor or any of its users) appear here.
// Users with no attempts still get a row (attempts: 0) so the admin page can
// show "never". The seeded "Portal Preview" demo user is excluded.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { withAuth, PortalUser } from '../../../../../../lib/authServer'

function sb() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

export default withAuth('edit:b2b_distributors', async (req: NextApiRequest, res: NextApiResponse, _user: PortalUser) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'GET only' })
  }

  const distributorId = String(req.query.id || '').trim()
  if (!distributorId) return res.status(400).json({ error: 'Missing distributor id' })

  const c = sb()
  const [{ data: allMods, error: mErr }, { data: users, error: uErr }, { data: attempts, error: aErr }, { data: assigns, error: asErr }] = await Promise.all([
    c.from('b2b_training_modules').select('id, slug, title, pass_pct').eq('enabled', true).order('created_at', { ascending: true }),
    c.from('b2b_distributor_users').select('id, email, full_name, is_active').eq('distributor_id', distributorId).order('created_at', { ascending: true }),
    c.from('b2b_training_attempts').select('module_slug, user_id, score_pct, passed, completed_at').eq('distributor_id', distributorId).order('completed_at', { ascending: false }),
    c.from('b2b_training_assignments').select('module_id').eq('distributor_id', distributorId),
  ])
  if (mErr) return res.status(500).json({ error: mErr.message })
  if (uErr) return res.status(500).json({ error: uErr.message })
  if (aErr) return res.status(500).json({ error: aErr.message })
  if (asErr) return res.status(500).json({ error: asErr.message })

  // Any assignment row for this distributor (whole-distributor OR one of its
  // users — user rows carry the distributor_id too) makes the module relevant.
  const assignedIds = new Set((assigns || []).map(a => a.module_id))
  const mods = (allMods || []).filter(m => assignedIds.has(m.id))

  // (user, module) → summary
  const key = (userId: string, slug: string) => `${userId}:${slug}`
  const agg = new Map<string, { attempts: number; passed: boolean; best: number | null; passedAt: string | null; lastAt: string | null }>()
  for (const a of attempts || []) {
    const k = key(a.user_id, a.module_slug)
    const cur = agg.get(k) || { attempts: 0, passed: false, best: null, passedAt: null, lastAt: null }
    cur.attempts++
    if (!cur.lastAt) cur.lastAt = a.completed_at          // rows are newest-first
    if (cur.best === null || Number(a.score_pct) > cur.best) cur.best = Number(a.score_pct)
    if (a.passed) { cur.passed = true; cur.passedAt = a.completed_at }  // earliest pass wins (list is desc)
    agg.set(k, cur)
  }

  const realUsers = (users || []).filter(u => !String(u.email || '').startsWith('preview+'))
  const rows = []
  for (const u of realUsers) {
    for (const m of mods || []) {
      const s = agg.get(key(u.id, m.slug))
      rows.push({
        user_id: u.id,
        user_name: u.full_name,
        user_email: u.email,
        user_active: u.is_active !== false,
        module_slug: m.slug,
        module_title: m.title,
        pass_pct: m.pass_pct,
        attempts: s?.attempts || 0,
        passed: s?.passed || false,
        best_score_pct: s?.best ?? null,
        passed_at: s?.passedAt || null,
        last_attempt_at: s?.lastAt || null,
      })
    }
  }

  return res.status(200).json({ rows })
})
