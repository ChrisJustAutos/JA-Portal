// pages/api/admin/migrate-archived-deals.ts
//
// Move quoted deals out of the "Old Quotes" archive (pipeline 5) into the
// New Quote Pipeline (pipeline 6), so the nightly sweep can action them.
//
// They ended up there because the Make/Zapier form automations were still
// creating deals in the archive after the new pipeline was built; Pipeline A
// then appended quote numbers to them in place. Those automations are now off,
// so this is a one-off catch-up, not an ongoing sync.
//
// DRY BY DEFAULT — open it signed in as an admin to see the full set and what
// the sweep would then do to them. Add &live=1 to actually move.
//
// Usage:
//   /api/admin/migrate-archived-deals                     dry, full report
//   /api/admin/migrate-archived-deals?live=1&limit=50     move the first 50
//   /api/admin/migrate-archived-deals?cutoff=2026-04-01   change the boundary
//
// READ wouldBeLostImmediately BEFORE GOING LIVE. Moving a deal into the
// pipeline also volunteers it for the Lost pass, and closing deals is the one
// action with no bulk undo. Each moved deal gets a note recording where it
// came from, so an individual move can be reversed by hand.

import { withAuth } from '../../../lib/authServer'
import { runArchiveMigration, DEFAULT_CUTOFF } from '../../../lib/ac-deal-migrate'

export const config = { maxDuration: 300 }

export default withAuth(['view:reports', 'admin:settings'], async (req, res) => {
  const live = req.query.live === '1'
  const limit = Math.min(Math.max(Number(req.query.limit) || 250, 1), 1500)
  const cutoff = typeof req.query.cutoff === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.cutoff)
    ? req.query.cutoff
    : DEFAULT_CUTOFF

  try {
    const report = await runArchiveMigration({ live, limit, cutoff })
    return res.status(200).json({
      mode: live ? 'LIVE — deals were moved' : 'dry run — nothing was moved',
      ...report,
      whatThisDoes:
        'Moves open, QUOTED deals from pipeline 5 "Old Quotes" to pipeline 6 "New Quote Pipeline" at stage '
        + '38 "Quote Sent". Value, owner, title and status are untouched — Won/Lost is decided by the nightly '
        + 'sweep on its own evidence, not here.',
      whatItSkips:
        'Unquoted enquiries in the archive are deliberately left alone. There are ~14,000 of them at $0 going '
        + 'back to 2024, and they are genuine archive material — quoted deals only appear from April 2026, when '
        + 'Pipeline A went live.',
      readThisFirst: report.wouldBeLostImmediately > 0
        ? `${report.wouldBeLostImmediately} of these (${report.wouldBeLostValue.toLocaleString()}) have been idle `
          + `90+ days, so the FIRST armed sweep after this migration would close them as Quote Lost. That is the `
          + `intended outcome, but it is not reversible in bulk — be sure before arming AC_SWEEP_LOST_LIVE.`
        : 'None of these would be closed as Lost on the next sweep.',
      nextStep: live
        ? 'Re-run /api/admin/backfill-ac-deal-details to stamp Source/Vehicle/Rego on the moved deals.'
        : 'Add &live=1 to move them.',
    })
  } catch (e: any) {
    console.error('[migrate-archived-deals] failed:', e)
    return res.status(500).json({ error: e?.message || String(e) })
  }
})
