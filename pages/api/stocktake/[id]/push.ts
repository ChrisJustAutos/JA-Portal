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

  // Errors-only retry: re-push just the rows that failed last time, onto the
  // same MD sheet. Triggered from the push-errors panel after a partial push.
  const errorsOnly = req.query.errors_only === '1' || req.body?.errors_only === true

  const supabase = sb()

  const { data: upload, error: uploadErr } = await supabase
    .from('stocktake_uploads')
    .select('id, status, matched_count, match_results, push_errors')
    .eq('id', id)
    .maybeSingle()
  if (uploadErr || !upload) return res.status(404).json({ error: 'Upload not found' })

  if (errorsOnly) {
    const errCount = Array.isArray(upload.push_errors) ? upload.push_errors.length : 0
    if (errCount === 0) {
      return res.status(400).json({ error: 'No push errors to retry on this upload.' })
    }
  } else {
    if (upload.status !== 'matched') {
      return res.status(400).json({
        error: `Cannot push: upload is in status "${upload.status}". Run match first.`,
      })
    }
    if (!upload.matched_count || upload.matched_count === 0) {
      return res.status(400).json({ error: 'No matched items to push.' })
    }
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
      client_payload: { upload_id: id, mode: 'push', errors_only: errorsOnly ? '1' : '0' },
    }),
  })

  if (!dispatchRes.ok) {
    const errText = await dispatchRes.text().catch(() => '')
    return res.status(502).json({
      error: `Failed to trigger GitHub Action: ${dispatchRes.status} ${errText.slice(0, 300)}`,
    })
  }

  // A full push resets the counters; an errors-only retry keeps the prior
  // pushed_count and push_errors (the worker adds to / replaces them) so the
  // tally stays correct if the retry itself fails to dispatch-complete.
  await supabase
    .from('stocktake_uploads')
    .update({
      status: 'pushing',
      push_started_at: new Date().toISOString(),
      ...(errorsOnly ? {} : { pushed_count: 0, push_errors: null }),
    })
    .eq('id', id)

  return res.status(202).json({
    ok: true,
    upload_id: id,
    status: 'pushing',
    message: errorsOnly ? 'Errors-only retry dispatched.' : 'Push job dispatched.',
  })
})
