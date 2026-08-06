// /api/b2b/admin/training/{slug} — the ADMIN module surface.
//   GET   → full module for the answer sheet: sections + slides + the
//           questions WITH correct answers and explanations. Admin-only (same
//           permission as the rest of the training admin); the distributor
//           endpoint never ships answers pre-submit — this one is how staff
//           review the quiz before assigning it. Disabled modules preview too.
//   PATCH { questions?, title?, description?, pass_pct? } — edit the quiz
//           (full-replacement questions array, same shape rules as the
//           generator) and/or the module header fields. Sections and
//           slide_base are NEVER touched here — the slides are the document.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../../lib/authServer'
import { TrainingQuestion, TrainingSection } from '../../../../../lib/b2b-training'

function sb() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

// Validate a full-replacement questions array. `maxSlide` bounds each
// question's optional slide reference (0 = module has no slides, skip check).
function cleanQuestions(raw: any, maxSlide: number): { questions: TrainingQuestion[] } | { error: string } {
  if (!Array.isArray(raw)) return { error: 'questions must be an array' }
  const questions: TrainingQuestion[] = []
  for (let i = 0; i < raw.length; i++) {
    const q = raw[i]
    const label = `Question ${i + 1}`
    if (!q || typeof q !== 'object') return { error: `${label}: invalid entry` }
    const text = String(q.q || '').trim()
    if (!text) return { error: `${label}: question text is required` }
    if (!Array.isArray(q.options) || q.options.length !== 4) return { error: `${label}: exactly 4 options required` }
    const options = q.options.map((o: any) => String(o ?? '').trim())
    if (options.some((o: string) => !o)) return { error: `${label}: every option needs text` }
    const correct = Number(q.correct)
    if (!Number.isInteger(correct) || correct < 0 || correct > 3) return { error: `${label}: correct answer must be one of the 4 options` }
    const out: TrainingQuestion = { q: text, options, correct }
    const explain = String(q.explain || '').trim()
    if (explain) out.explain = explain
    if (q.slide != null && q.slide !== '') {
      const slide = Number(q.slide)
      if (!Number.isInteger(slide) || slide < 1 || (maxSlide > 0 && slide > maxSlide)) {
        return { error: `${label}: slide must be between 1 and ${maxSlide || '…'}` }
      }
      out.slide = slide
    }
    questions.push(out)
  }
  if (questions.length === 0) return { error: 'At least one question is required' }
  return { questions }
}

export default withAuth('edit:b2b_distributors', async (req: NextApiRequest, res: NextApiResponse) => {
  const slug = String(req.query.slug || '').trim()
  if (!slug) return res.status(400).json({ error: 'Missing slug' })

  const c = sb()
  const { data, error } = await c.from('b2b_training_modules')
    .select('id, slug, title, description, pass_pct, enabled, content')
    .eq('slug', slug)
    .maybeSingle()
  if (error) return res.status(500).json({ error: error.message })
  if (!data) return res.status(404).json({ error: 'Module not found' })

  const content = (data.content || {}) as any

  if (req.method === 'GET') {
    return res.status(200).json({
      module: {
        slug: data.slug,
        title: data.title,
        description: data.description || null,
        pass_pct: Number(data.pass_pct) || 90,
        enabled: data.enabled !== false,
        sections: Array.isArray(content.sections) ? content.sections : [],
        questions: Array.isArray(content.questions) ? content.questions : [],
        slide_base: typeof content.slide_base === 'string' && content.slide_base ? content.slide_base : null,
      },
    })
  }

  if (req.method === 'PATCH') {
    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {})
    const rowPatch: any = {}
    let contentPatch: any = null

    if (b.questions !== undefined) {
      const sections = (Array.isArray(content.sections) ? content.sections : []) as TrainingSection[]
      const maxSlide = sections.reduce((m, s) => Math.max(m, ...(Array.isArray(s.slides) ? s.slides : [0])), 0)
      const cleaned = cleanQuestions(b.questions, maxSlide)
      if ('error' in cleaned) return res.status(400).json({ error: cleaned.error })
      // Full content back with ONLY questions replaced — sections, slide_base
      // and source (generator provenance) survive untouched.
      contentPatch = { ...content, questions: cleaned.questions }
    }
    if (b.title !== undefined) {
      const title = String(b.title || '').trim()
      if (!title) return res.status(400).json({ error: 'title cannot be empty' })
      rowPatch.title = title
    }
    if (b.description !== undefined) rowPatch.description = String(b.description || '').trim() || null
    if (b.pass_pct !== undefined) {
      const pct = Number(b.pass_pct)
      if (!Number.isInteger(pct) || pct < 1 || pct > 100) return res.status(400).json({ error: 'pass_pct must be 1–100' })
      rowPatch.pass_pct = pct
    }
    if (contentPatch === null && Object.keys(rowPatch).length === 0) {
      return res.status(400).json({ error: 'Nothing to update' })
    }

    if (contentPatch !== null) rowPatch.content = contentPatch
    rowPatch.updated_at = new Date().toISOString()
    const { error: upErr } = await c.from('b2b_training_modules').update(rowPatch).eq('id', data.id)
    if (upErr) return res.status(500).json({ error: upErr.message })
    return res.status(200).json({ ok: true, question_count: contentPatch ? contentPatch.questions.length : undefined })
  }

  res.setHeader('Allow', 'GET, PATCH')
  return res.status(405).json({ error: 'GET or PATCH only' })
})
