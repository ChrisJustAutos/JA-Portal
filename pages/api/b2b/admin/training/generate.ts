// POST /api/b2b/admin/training/generate — { uploadPath, title, slug, passPct }
// Runs the document→course pipeline (lib/b2b-training-generate.ts): renders
// every PDF page to a slide JPEG in b2b-training-slides, drafts sections + a
// suggested quiz with one LLM call, and saves the module as a DISABLED draft.
// Long-running: maxDuration 300 (also pinned in vercel.json). All pipeline
// errors carry admin-friendly messages and come back as 400s.

import type { NextApiRequest, NextApiResponse } from 'next'
import { withAuth } from '../../../../../lib/authServer'
import { generateTrainingModule } from '../../../../../lib/b2b-training-generate'

export const config = { maxDuration: 300 }

export default withAuth('edit:b2b_distributors', async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'POST only' })
  }
  const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {})
  try {
    const result = await generateTrainingModule({
      uploadPath: String(b.uploadPath || ''),
      title: String(b.title || ''),
      slug: String(b.slug || ''),
      passPct: Number(b.passPct ?? 90),
    })
    return res.status(200).json({ ok: true, ...result })
  } catch (e: any) {
    console.error('[training-generate] failed:', e?.message || e)
    return res.status(400).json({ error: e?.message || 'Course generation failed' })
  }
})
