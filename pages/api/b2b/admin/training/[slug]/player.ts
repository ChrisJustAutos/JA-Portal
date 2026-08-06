// pages/api/b2b/admin/training/[slug]/player.ts
// Admin "preview as distributor" endpoint — byte-compatible with the
// distributor endpoint (/api/b2b/training/<slug>) so the shared
// TrainingPlayer component works unchanged. Differences from the real thing:
//   • staff auth (edit:b2b_distributors) instead of a B2B session, and NO
//     assignment gating — staff can preview any module
//   • disabled modules load too (vet a course before enabling/assigning)
//   • POST marks with markExam and returns the full results, but NEVER
//     inserts a b2b_training_attempts row and NEVER pings the staff pass
//     bell — the response carries `preview: true` (harmless extra field).
// The static answer sheet is served by ../[slug].ts.

import type { NextApiRequest, NextApiResponse } from 'next'
import { withAuth } from '../../../../../../lib/authServer'
import { loadModule, buildExam, markExam } from '../../../../../../lib/b2b-training'

export default withAuth('edit:b2b_distributors', async (req: NextApiRequest, res: NextApiResponse) => {
  const slug = String(req.query.slug || '').trim()
  if (!slug) return res.status(400).json({ error: 'Missing module slug' })

  const module_ = await loadModule(slug, { includeDisabled: true })
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

    // PREVIEW: no b2b_training_attempts insert, no staff bell — mark and reply.

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
      preview: true,
      score_pct: result.scorePct,
      passed: result.passed,
      pass_pct: module_.passPct,
      review,
    })
  }

  res.setHeader('Allow', 'GET, POST')
  return res.status(405).json({ error: 'GET or POST only' })
})
