// pages/api/ap/admin/backfill-manual-button.ts
//
// One-shot maintenance: add the "🔍 Entered manually?" button to AP flag cards
// that were posted to Slack BEFORE the button shipped (2026-08-25). Updates
// each card in place (chat.update), so the card keeps its timestamp, its
// position in the channel and any thread hanging off it.
//
//   GET /api/ap/admin/backfill-manual-button?days=2&dry=1
//
//   days  how far back to look (default 2, max 30)
//   dry   1 = report what would change without touching Slack
//
// Only open flags are touched — outcome flagged/error, no MYOB bill linked,
// header still orange — and a card that already carries the button is skipped,
// so running it twice is harmless.

import type { NextApiRequest, NextApiResponse } from 'next'
import { withAuth } from '../../../../lib/authServer'
import { backfillCheckManualButtons } from '../../../../lib/ap-auto-entry'

export const config = { maxDuration: 300 }

export default withAuth('edit:supplier_invoices', async (req: NextApiRequest, res: NextApiResponse) => {
  const days = Number(req.query.days ?? req.body?.days ?? 2)
  const dryRun = String(req.query.dry ?? req.body?.dry ?? '') === '1'
  try {
    const result = await backfillCheckManualButtons({ days, dryRun })
    return res.status(200).json({ ok: true, ...result })
  } catch (e: any) {
    console.error('[ap-backfill-manual-button]', e?.message || e)
    return res.status(500).json({ ok: false, error: (e?.message || e).toString().slice(0, 300) })
  }
})
