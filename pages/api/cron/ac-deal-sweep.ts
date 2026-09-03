// pages/api/cron/ac-deal-sweep.ts
// Nightly reconciliation of the AC quote pipeline against Mechanics Desk.
//
// SCHEDULE: 18:40 UTC daily (04:40 Brisbane). The MD workshop-map GitHub
// Action pulls the full invoices/quotes export at 17:30 UTC, so this runs
// ~70 min behind it and reasons about a freshly refreshed md_invoices. Move
// one and you must move the other — running before the pull silently costs
// a day of invoices, which reads as "no wins today" rather than as a fault.
//
// TWO PASSES, in order:
//   1. WON  — deals whose quote produced a finalised MD invoice → stage 39
//   2. LOST — deals untouched for 90 days → stage 40
// Won first, so a deal invoiced on day 100 is booked as the win it is
// instead of being closed Lost the same night for going quiet.
//
// BOTH PASSES ARE DRY UNTIL EXPLICITLY ARMED:
//   AC_SWEEP_WON_LIVE=true      arms the Won pass
//   AC_SWEEP_LOST_LIVE=true     arms the Lost pass
// A dry run does every lookup and every decision and writes nothing, so the
// report is exactly what a live run would do. The first live Lost run closes
// the entire historical backlog at once and ActiveCampaign has no undo for
// that — it is not allowed to happen by accident.
//
// Tunables (all optional):
//   AC_SWEEP_LOST_AFTER_DAYS       default 90
//   AC_SWEEP_INVOICE_WINDOW_DAYS   default 180
//   AC_SWEEP_MIN_INVOICE_RATIO     default 0.5
//   AC_SWEEP_ENABLED=false         kill switch, no redeploy needed
//
// Manual dry run (safe at any time — it ignores the LIVE flags):
//   curl -H "Authorization: Bearer $CRON_SECRET" \
//     "https://justautos.app/api/cron/ac-deal-sweep?dry=1&verbose=1"

import type { NextApiRequest, NextApiResponse } from 'next'
import { postMessage } from '../../../lib/slack-bot/slack'
import {
  listOpenGroupDeals,
  runWonPass,
  runLostPass,
  wonPassIsLive,
  lostPassIsLive,
  LOST_AFTER_DAYS,
  INVOICE_WINDOW_DAYS,
  MIN_INVOICE_RATIO,
} from '../../../lib/ac-deal-sweep'

export const config = { maxDuration: 300 }

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const expected = process.env.CRON_SECRET
  if (!expected) return res.status(500).json({ error: 'CRON_SECRET not configured' })
  if ((req.headers.authorization || '') !== `Bearer ${expected}`) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  if ((process.env.AC_SWEEP_ENABLED ?? 'true') === 'false') {
    return res.status(200).json({ skipped: 'AC_SWEEP_ENABLED=false' })
  }

  // ?dry=1 forces a dry run regardless of the LIVE flags. There is
  // deliberately no inverse — you cannot go live from a query string.
  const forceDry = req.query.dry === '1'
  const verbose = req.query.verbose === '1'
  const wonLive = !forceDry && wonPassIsLive()
  const lostLive = !forceDry && lostPassIsLive()

  const startedAt = new Date().toISOString()

  try {
    const { deals, complete } = await listOpenGroupDeals()

    // An incomplete scan means the AC filters may have been ignored and we
    // paged the whole account instead. Reporting on a partial set is fine;
    // CLOSING deals off one is not, so an incomplete scan forces dry mode
    // however the flags are set. The one action with no undo does not get
    // to run on data we know is short.
    const scanTrustworthy = complete
    const wonLiveEff = wonLive && scanTrustworthy
    const lostLiveEff = lostLive && scanTrustworthy

    const won = await runWonPass(deals, wonLiveEff)
    // Exclude what Won just closed — in a dry run nothing actually moved,
    // but the exclusion still applies so the dry report matches what a live
    // run would really do.
    const won2 = won.matched.map(m => m.dealId)
    const lost = await runLostPass(deals, lostLiveEff, won2)

    const result = {
      startedAt,
      finishedAt: new Date().toISOString(),
      openDealsScanned: deals.length,
      pagingComplete: complete,
      warning: complete ? null : 'Paging guard hit — not every open deal was scanned, so both passes were forced to dry regardless of their flags.',
      settings: {
        lostAfterDays: LOST_AFTER_DAYS,
        invoiceWindowDays: INVOICE_WINDOW_DAYS,
        minInvoiceRatio: MIN_INVOICE_RATIO,
        wonLive: wonLiveEff,
        lostLive: lostLiveEff,
        forcedDryByIncompleteScan: (wonLive || lostLive) && !scanTrustworthy,
      },
      won: {
        ...won,
        matched: verbose ? won.matched : won.matched.slice(0, 25),
        matchedCount: won.matched.length,
        rejectedByRatio: verbose ? won.rejectedByRatio : won.rejectedByRatio.slice(0, 25),
        rejectedByRatioCount: won.rejectedByRatio.length,
      },
      lost: {
        ...lost,
        candidates: verbose ? lost.candidates : lost.candidates.slice(0, 25),
        candidateCount: lost.candidates.length,
      },
    }

    await notify(result, wonLiveEff, lostLiveEff)
    return res.status(200).json(result)
  } catch (e: any) {
    console.error('[ac-deal-sweep] failed:', e)
    await postMessage({
      channel: sweepChannel(),
      text: `:rotating_light: AC deal sweep FAILED — ${e?.message || String(e)}`,
    }).catch(() => {})
    return res.status(500).json({ error: e?.message || String(e), startedAt })
  }
}

// Same channel the 5:15pm sales update posts to, unless overridden.
// There is no SLACK_WEBHOOK_* for this — the sales stack uses the bot
// token and a channel ID, not incoming webhooks.
function sweepChannel(): string {
  return process.env.AC_SWEEP_SLACK_CHANNEL || 'C0BTL0TND6X'
}

async function notify(r: any, wonLive: boolean, lostLive: boolean) {

  const mode = (live: boolean) => (live ? 'LIVE' : 'dry run — nothing changed')
  const lines = [
    `*AC deal sweep* — ${r.openDealsScanned} open deals in the quote pipeline`,
    '',
    `*Quote Won* (${mode(wonLive)}) — ${r.won.matchedCount} matched a finalised MD invoice`,
    `   ${r.won.dealsWithQuoteNumber} deals carried a quote number, ${r.won.quotesResolved} resolved in MD`,
    r.won.rejectedByRatioCount
      ? `   ${r.won.rejectedByRatioCount} rejected: invoice under ${Math.round(MIN_INVOICE_RATIO * 100)}% of the quote`
      : null,
    '',
    `*Quote Lost* (${mode(lostLive)}) — ${r.lost.candidateCount} untouched for ${r.lost.cutoffDays}+ days`,
    `   total value $${Number(r.lost.totalValue).toLocaleString()}`,
    r.lost.oldestTouch ? `   oldest last-touched ${String(r.lost.oldestTouch).substring(0, 10)}` : null,
    r.warning ? `\n:warning: ${r.warning}` : null,
    (r.won.errors.length || r.lost.errors.length)
      ? `\n:warning: ${r.won.errors.length + r.lost.errors.length} write errors — see the run output`
      : null,
    (!wonLive || !lostLive)
      ? '\n_Arm with AC_SWEEP_WON_LIVE / AC_SWEEP_LOST_LIVE once the numbers look right._'
      : null,
  ].filter(Boolean)

  await postMessage({ channel: sweepChannel(), text: lines.join('\n') }).catch(() => {})
}
