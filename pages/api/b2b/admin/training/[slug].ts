// GET /api/b2b/admin/training/{slug} — full module for the ADMIN preview:
// sections + slides + the questions WITH correct answers and explanations.
// Admin-only (same permission as the rest of the training admin); the
// distributor-facing endpoint never ships answers pre-submit — this one is
// how staff review the quiz before assigning it. Disabled modules preview too.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../../lib/authServer'

export default withAuth('edit:b2b_distributors', async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'GET only' })
  }
  const slug = String(req.query.slug || '').trim()
  if (!slug) return res.status(400).json({ error: 'Missing slug' })

  const c = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  const { data, error } = await c.from('b2b_training_modules')
    .select('id, slug, title, description, pass_pct, enabled, content')
    .eq('slug', slug)
    .maybeSingle()
  if (error) return res.status(500).json({ error: error.message })
  if (!data) return res.status(404).json({ error: 'Module not found' })

  const content = (data.content || {}) as any
  return res.status(200).json({
    module: {
      slug: data.slug,
      title: data.title,
      description: data.description || null,
      pass_pct: Number(data.pass_pct) || 90,
      enabled: data.enabled !== false,
      sections: Array.isArray(content.sections) ? content.sections : [],
      questions: Array.isArray(content.questions) ? content.questions : [],
    },
  })
})
