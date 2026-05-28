// pages/api/stocktake/[id]/recheck.ts
// Re-run the coverage check against the LIVE MechanicDesk stocktake: the worker
// reads what's actually been counted in the MD stocktake and compares it to the
// current Stock Value report. Requires the upload to have been pushed (it needs
// a mechanicdesk_stocktake_id). Does NOT change the row status — coverage_at on
// the upload updates when it finishes.

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
  const { data: upload, error } = await supabase
    .from('stocktake_uploads')
    .select('id, status, mechanicdesk_stocktake_id')
    .eq('id', id).maybeSingle()
  if (error || !upload) return res.status(404).json({ error: 'Upload not found' })
  if (!upload.mechanicdesk_stocktake_id) {
    return res.status(400).json({ error: 'This upload has no MechanicDesk stocktake yet — push it to MD first.' })
  }
  if (upload.status === 'matching' || upload.status === 'pushing') {
    return res.status(409).json({ error: `Busy (${upload.status}) — wait for the current job to finish.` })
  }

  const ghToken = process.env.GH_DISPATCH_TOKEN
  const ghOwner = process.env.GH_REPO_OWNER || 'ChrisJustAutos'
  const ghRepo = process.env.GH_REPO_NAME || 'JA-Portal'
  if (!ghToken) return res.status(500).json({ error: 'Server not configured: GH_DISPATCH_TOKEN missing' })

  const dispatchRes = await fetch(`https://api.github.com/repos/${ghOwner}/${ghRepo}/dispatches`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${ghToken}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ event_type: 'stocktake-recheck', client_payload: { upload_id: id, mode: 'recheck' } }),
  })
  if (!dispatchRes.ok) {
    const errText = await dispatchRes.text().catch(() => '')
    return res.status(502).json({ error: `Failed to trigger re-check: ${dispatchRes.status} ${errText.slice(0, 300)}` })
  }
  return res.status(202).json({ ok: true, message: 'Sync started — counts + coverage refresh from MD in ~1 minute.' })
})
