// pages/api/b2b/training/[slug].ts
// One training module — course content + exam.
//
//   GET  → { module: { slug, title, description, pass_pct, sections },
//            examQuestions: [{ q, options }],   // client-safe, freshly shuffled
//            question_order: int[] }            // original indexes, echo on POST
//   POST { answers: { <originalQuestionIndex>: <chosenOptionIndex> },
//          question_order: int[], started_at? }
//        → marks server-side, records the attempt, returns the full results
//          (score, pass/fail, per-question correct answer + explanation).
//
// The answer key only ever leaves the server in the POST response — GET never
// includes `correct`/`explain`. Preview sessions can GET (browse the course)
// but their POST is blocked upstream by withB2BAuth's non-GET guard.
// A pass pings staff (admin/manager bell) once per user+module via dedupeKey.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { withB2BAuth, B2BUser } from '../../../../lib/b2bAuthServer'
import { loadModule, buildExam, markExam } from '../../../../lib/b2b-training'
import { notify } from '../../../../lib/notifications'

function sb() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

export default withB2BAuth(async (req: NextApiRequest, res: NextApiResponse, user: B2BUser) => {
  const slug = String(req.query.slug || '').trim()
  if (!slug) return res.status(400).json({ error: 'Missing module slug' })

  const module_ = await loadModule(slug)
  if (!module_) return res.status(404).json({ error: 'Training module not found' })

  if (req.method === 'GET') {
    const exam = buildExam(module_)   // new shuffle per request (fresh on every retake)
    return res.status(200).json({
      module: {
        slug: module_.slug,
        title: module_.title,
        description: module_.description,
        pass_pct: module_.passPct,
        sections: module_.sections,
      },
      examQuestions: exam.questions,
      question_order: exam.order,
    })
  }

  if (req.method === 'POST') {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {})
    const answersIn = (body.answers && typeof body.answers === 'object') ? body.answers : null
    const orderIn: number[] | null = Array.isArray(body.question_order) ? body.question_order.map((x: any) => Number(x)) : null
    if (!answersIn) return res.status(400).json({ error: 'answers required' })

    const n = module_.questions.length
    // question_order must be a permutation of 0..n-1 (the shuffle we echoed).
    if (!orderIn || orderIn.length !== n || new Set(orderIn).size !== n || orderIn.some(i => !Number.isInteger(i) || i < 0 || i >= n)) {
      return res.status(400).json({ error: 'question_order invalid — reload the quiz and try again' })
    }

    // Normalise answers: keys = original question index, values = option index.
    const answers: Record<number, number> = {}
    for (const [k, v] of Object.entries(answersIn)) {
      const qi = Number(k)
      const oi = Number(v)
      if (Number.isInteger(qi) && qi >= 0 && qi < n && Number.isInteger(oi)) answers[qi] = oi
    }

    const result = markExam(module_, answers)

    const c = sb()
    const startedAt = body.started_at && !isNaN(Date.parse(body.started_at)) ? new Date(body.started_at).toISOString() : null
    const { error: insErr } = await c.from('b2b_training_attempts').insert({
      module_slug: module_.slug,
      distributor_id: user.distributor.id,
      user_id: user.id,
      score_pct: result.scorePct,
      passed: result.passed,
      answers,
      question_order: orderIn,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
    })
    if (insErr) return res.status(500).json({ error: `Could not save attempt: ${insErr.message}` })

    if (result.passed) {
      // Staff bell — once per user+module (retakes after a pass stay quiet).
      await notify({
        module: 'b2b',
        title: `Training passed — ${user.distributor.displayName}`,
        body: `${user.fullName || user.email} passed ${module_.title} with ${Math.round(result.scorePct)}%`,
        href: `/admin/b2b/distributors/${user.distributor.id}`,
        dedupeKey: `training-pass:${module_.slug}:${user.id}`,
        roles: ['admin', 'manager'],
      })
    }

    // Full review payload, in the order the user saw the questions.
    const review = orderIn.map((qi: number) => {
      const q = module_.questions[qi]
      const marked = result.perQuestion[qi]
      return {
        q: q.q,
        options: q.options,
        chosen: marked.chosen,
        correctIndex: marked.correctIndex,
        correct: marked.correct,
        explain: marked.explain,
        slide: marked.slide,
      }
    })

    return res.status(200).json({
      score_pct: result.scorePct,
      passed: result.passed,
      pass_pct: module_.passPct,
      review,
    })
  }

  res.setHeader('Allow', 'GET, POST')
  return res.status(405).json({ error: 'GET or POST only' })
})
