// pages/api/stocktake/[id]/push.ts
//
// Trigger a GitHub Action run that performs the push.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../lib/authServer'

function sb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  )
}

export default withAuth('edit:stocktakes', async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const id = req.query.id as string
  if (!id) return res.status(400).json({ error: 'Missing upload id' })

  const supabase = sb()

  const { data: upload, error: uploadErr } = await supabase
    .from('stocktake_uploads')
    .select('id, status, matched_count, match_results')
    .eq('id', id)
    .maybeSingle()
  if (uploadErr || !upload) return res.status(404).json({ error: 'Upload not found' })

  if (upload.status !== 'matched') {
    return res.status(400).json({
      error: `Cannot push: upload is in status "${upload.status}". Run match first.`,
    })
  }
  if (!upload.matched_count || upload.matched_count === 0) {
    return res.status(400).json({ error: 'No matched items to push.' })
  }

  const ghToken = process.env.GH_DISPATCH_TOKEN
  const ghOwner = process.env.GH_REPO_OWNER || 'ChrisJustAutos'
  const ghRepo = process.env.GH_REPO_NAME || 'JA-Portal'
  if (!ghToken) {
    return res.status(500).json({ error: 'Server not configured: GH_DISPATCH_TOKEN missing' })
  }

  const dispatchRes = await fetch(`https://api.github.com/repos/${ghOwner}/${ghRepo}/dispatches`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${ghToken}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      event_type: 'stocktake-push',
      client_payload: { upload_id: id, mode: 'push' },
    }),
  })

  if (!dispatchRes.ok) {
    const errText = await dispatchRes.text().catch(() => '')
    return res.status(502).json({
      error: `Failed to trigger GitHub Action: ${dispatchRes.status} ${errText.slice(0, 300)}`,
    })
  }

  await supabase
    .from('stocktake_uploads')
    .update({
      status: 'pushing',
      push_started_at: new Date().toISOString(),
      pushed_count: 0,
      push_errors: null,
    })
    .eq('id', id)

  return res.status(202).json({
    ok: true,
    upload_id: id,
    status: 'pushing',
    message: 'Push job dispatched.',
  })
})
