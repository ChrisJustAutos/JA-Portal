// pages/api/admin/sales-update-preview.ts
// GET  — compose the 5:15pm sales update and return it WITHOUT posting, so the
//        wording and figures can be checked any time of day. The response
//        carries the full block list, so the coaching sections folded in from
//        lib/calls-daily-recap can be read here too, plus `coaching` saying
//        whether they made it in and why not if they didn't.
// POST — actually post it to Slack now (same path the cron takes).
//
// ?mode=daily|weekly forces either shape; default is what today would send.
// Permission: admin:settings — it can post to a company-wide channel.

import type { NextApiRequest, NextApiResponse } from 'next'
import { withAuth } from '../../../lib/authServer'
import { buildSalesUpdate, postSalesUpdate, salesUpdateChannel } from '../../../lib/sales-update-slack'

// 300 to match the cron: composing the preview now includes the coaching
// section's Anthropic theme summary.
export const config = { maxDuration: 300 }

export default withAuth('admin:settings', async (req: NextApiRequest, res: NextApiResponse) => {
  const bris = new Date(Date.now() + 10 * 3600_000)
  const mode = (req.query.mode === 'weekly' || req.query.mode === 'daily')
    ? req.query.mode as 'weekly' | 'daily'
    : (bris.getUTCDay() === 5 ? 'weekly' : 'daily')

  try {
    if (req.method === 'POST') {
      const r = await postSalesUpdate(mode, new Date())
      return res.status(r.posted ? 200 : 502).json(r)
    }
    const u = await buildSalesUpdate(mode, new Date())
    return res.status(200).json({
      ok: true, channel: await salesUpdateChannel(),
      mode: u.mode, since: u.since, until: u.until,
      summary: u.summary, coaching: u.coaching,
      preview_text: u.text, blocks: u.blocks,
    })
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) })
  }
})
