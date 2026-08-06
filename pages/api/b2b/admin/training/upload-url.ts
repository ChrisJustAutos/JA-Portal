// POST /api/b2b/admin/training/upload-url — { filename } → signed direct
// upload into the private b2b-training-uploads bucket (same pattern as the
// B2B Resources library: the browser PUTs the PDF straight to storage, so
// big documents never pass through a Vercel function body). The returned
// `path` is what /generate consumes.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../../lib/authServer'
import { TRAINING_UPLOADS_BUCKET } from '../../../../../lib/b2b-training-generate'

const cleanName = (s: string) => String(s || 'document.pdf').replace(/[^\w.\-]+/g, '_').slice(0, 120)

export default withAuth('edit:b2b_distributors', async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'POST only' })
  }
  const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {})
  const filename = cleanName(b.filename)
  if (!/\.pdf$/i.test(filename)) {
    return res.status(400).json({ error: 'Only PDF files are supported — export Word/PowerPoint documents as PDF first.' })
  }

  const c = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  const path = `${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}/${filename}`
  const { data, error } = await c.storage.from(TRAINING_UPLOADS_BUCKET).createSignedUploadUrl(path)
  if (error) return res.status(500).json({ error: error.message })
  return res.status(200).json({ path, token: data.token, signedUrl: (data as any).signedUrl })
})
