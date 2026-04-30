// pages/api/stocktake/[id]/match.ts
//
// Trigger a GitHub Action run that resolves SKUs against MD.

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
    .select('id, status, total_rows')
    .eq('id', id)
    .maybeSingle()
  if (uploadErr || !upload) return res.status(404).json({ error: 'Upload not found' })

  if (!['parsed', 'matched', 'failed'].includes(upload.status)) {
    return res.status(400).json({
      error: `Cannot match: upload is in status "${upload.status}". Wait for current operation to finish.`,
    })
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
      event_type: 'stocktake-match',
      client_payload: { upload_id: id, mode: 'match' },
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
    .update({ status: 'matching', match_results: null, matched_count: null, unmatched_count: null })
    .eq('id', id)

  return res.status(202).json({
    ok: true,
    upload_id: id,
    status: 'matching',
    message: 'Match job dispatched. Poll GET /api/stocktake/' + id + ' for status updates.',
  })
})
