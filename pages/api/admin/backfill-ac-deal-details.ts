// pages/api/admin/backfill-ac-deal-details.ts
//
// Backfill Mechanics Desk detail (Source, MD Quote Number, Vehicle, Rego)
// onto ActiveCampaign deals raised before the provenance marker existed.
//
// DRY BY DEFAULT. Open it signed in as an admin to see what it would do;
// add &live=1 to actually write. It is idempotent — deals already carrying a
// Source value are skipped — so re-running is safe and is how you work
// through the backlog a batch at a time.
//
// Usage:
//   /api/admin/backfill-ac-deal-details                 dry, first 250
//   /api/admin/backfill-ac-deal-details?limit=50        dry, first 50
//   /api/admin/backfill-ac-deal-details?live=1&limit=50 WRITE 50
//
// Start small and read the samples before going wide: this writes to every
// deal it touches, and there is no bulk undo in ActiveCampaign.

import { withAuth } from '../../../lib/authServer'
import { runDealEnrichment } from '../../../lib/ac-deal-enrich'

export const config = { maxDuration: 300 }

export default withAuth(['view:reports', 'admin:settings'], async (req, res) => {
  const live = req.query.live === '1'
  const limit = Math.min(Math.max(Number(req.query.limit) || 250, 1), 1000)
  const maxPages = Math.min(Math.max(Number(req.query.maxPages) || 60, 1), 200)

  try {
    const report = await runDealEnrichment({ live, limit, maxPages })
    return res.status(200).json({
      mode: live ? 'LIVE — deals were written' : 'dry run — nothing was written',
      ...report,
      health: report.skippedNoFieldsResolved > 0
        ? `WARNING: ${report.skippedNoFieldsResolved} deals were skipped because the AC deal custom fields could not be resolved or created. That is a configuration/API fault, not an empty backlog — nothing will be stamped until it is fixed.`
        : 'Deal custom fields resolved normally.',
      note: report.capped
        ? `Stopped at the ${limit}-deal cap. Re-run to continue — already-stamped deals are skipped.`
        : 'No cap hit on this run.',
      valueNote:
        'valuesFilled is expected to be 0: every open deal carrying a quote number already has a value. '
        + 'A non-zero count here means a deal lost its value somewhere, which is worth a look.',
    })
  } catch (e: any) {
    console.error('[backfill-ac-deal-details] failed:', e)
    return res.status(500).json({ error: e?.message || String(e) })
  }
})
