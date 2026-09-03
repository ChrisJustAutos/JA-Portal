// pages/api/cron/ac-deal-sweep.ts
// Nightly reconciliation of the AC quote pipeline against Mechanics Desk.
//
// SCHEDULE: 18:40 UTC daily (04:40 Brisbane). The MD workshop-map GitHub
// Action pulls the full invoices/quotes export at 17:30 UTC, so this runs
// ~70 min behind it and reasons about a freshly refreshed md_invoices. Move
// one and you must move the other — running before the pull silently costs
// a day of invoices, which reads as "no wins today" rather than as a fault.
//
// THREE PASSES, in order:
//   1. WON (MYOB)  — the invoice reached MYOB. Matched to the AC contact by
//                     EMAIL off the customer card, which is an identity
//                     match rather than an inference. Strongest signal, so
//                     it runs first and its wins are excluded from pass 2.
//   2. WON (MD)    — fallback for customers whose MYOB card has no email:
//                     quote number → md_quotes → md_invoices on customer+rego.
//   3. LOST        — deals untouched for 90 days → stage 40.
// Won before Lost, so a deal invoiced on day 100 is booked as the win it is
// instead of being closed Lost the same night for going quiet.
//
// BOTH PASSES ARE DRY UNTIL EXPLICITLY ARMED:
//   AC_SWEEP_MYOB_WON_LIVE=true arms the MYOB Won pass
//   AC_SWEEP_WON_LIVE=true      arms the MD-fallback Won pass
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
//   AC_SWEEP_MAX_INVOICE_RATIO     default 3
//   AC_SWEEP_ENABLED=false         kill switch, no redeploy needed
//
// Manual dry run (safe at any time — it ignores the LIVE flags):
//   curl -H "Authorization: Bearer $CRON_SECRET" \
//     "https://justautos.app/api/cron/ac-deal-sweep?dry=1&verbose=1"

import type { NextApiRequest, NextApiResponse } from 'next'
import { getCurrentUser } from '../../../lib/authServer'
import { roleHasPermission } from '../../../lib/permissions'
import { postMessage } from '../../../lib/slack-bot/slack'
import { runMyobWonPass, myobWonIsLive, MYOB_WON_LOOKBACK_DAYS } from '../../../lib/ac-won-from-myob'
import {
  listOpenGroupDeals,
  runWonPass,
  runLostPass,
  wonPassIsLive,
  lostPassIsLive,
  LOST_AFTER_DAYS,
  INVOICE_WINDOW_DAYS,
  MIN_INVOICE_RATIO,
  MAX_INVOICE_RATIO,
} from '../../../lib/ac-deal-sweep'

export const config = { maxDuration: 300 }

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Two ways in:
  //   1. Vercel Cron / scripts, with the CRON_SECRET bearer token. Can run live.
  //   2. A signed-in portal admin, in a browser. ALWAYS forced dry, whatever
  //      the arm flags say — so the report can be read by the person who has
  //      to approve it without handing them the cron secret, and without a
  //      page refresh ever being able to close 400 deals.
  const expected = process.env.CRON_SECRET
  if (!expected) return res.status(500).json({ error: 'CRON_SECRET not configured' })

  let sessionOnly = false
  if ((req.headers.authorization || '') !== `Bearer ${expected}`) {
    const user = await getCurrentUser(req)
    const ok = user && roleHasPermission(user.role, 'view:reports') && roleHasPermission(user.role, 'admin:settings')
    if (!ok) return res.status(401).json({ error: 'Unauthorized' })
    sessionOnly = true
  }

  if ((process.env.AC_SWEEP_ENABLED ?? 'true') === 'false') {
    return res.status(200).json({ skipped: 'AC_SWEEP_ENABLED=false' })
  }

  // ?dry=1 forces a dry run regardless of the LIVE flags. There is
  // deliberately no inverse — you cannot go live from a query string.
  const forceDry = req.query.dry === '1' || sessionOnly
  const verbose = req.query.verbose === '1'
  const myobWonLive = !forceDry && myobWonIsLive()
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

    // Pass 1 — MYOB. Independent of the AC deal scan (it starts from
    // invoices), so an incomplete scan doesn't force it dry.
    let myobWon
    try {
      myobWon = await runMyobWonPass(myobWonLive)
    } catch (e: any) {
      myobWon = { live: myobWonLive, error: e?.message || String(e), matched: [], moved: 0 } as any
      console.error('[ac-deal-sweep] MYOB won pass failed:', e)
    }
    const myobWonDealIds: string[] = (myobWon.matched || []).map((m: any) => m.dealId)

    // Pass 2 — MD fallback. Skip anything MYOB already claimed.
    const dealsForMd = deals.filter(d => myobWonDealIds.indexOf(d.id) === -1)
    const won = await runWonPass(dealsForMd, wonLiveEff)
    // Exclude what Won just closed — in a dry run nothing actually moved,
    // but the exclusion still applies so the dry report matches what a live
    // run would really do.
    const won2 = won.matched.map(m => m.dealId).concat(myobWonDealIds)
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
        maxInvoiceRatio: MAX_INVOICE_RATIO,
        wonLive: wonLiveEff,
        lostLive: lostLiveEff,
        forcedDryByIncompleteScan: (wonLive || lostLive) && !scanTrustworthy,
      },
      myobWon: {
        ...myobWon,
        matched: verbose ? myobWon.matched : (myobWon.matched || []).slice(0, 25),
        matchedCount: (myobWon.matched || []).length,
        lookbackDays: MYOB_WON_LOOKBACK_DAYS,
        live: myobWonLive,
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

    // Slack only for the SCHEDULED run. A person opening the URL to read
    // the numbers must not post to #sales-updates — and because the link
    // handler can open two tabs, a manual look was posting the report twice.
    if (!sessionOnly) await notify(result, wonLiveEff, lostLiveEff, myobWonLive)
    return res.status(200).json(result)
  } catch (e: any) {
    console.error('[ac-deal-sweep] failed:', e)
    if (!sessionOnly) {
      await postMessage({
        channel: sweepChannel(),
        text: `:rotating_light: AC deal sweep FAILED — ${e?.message || String(e)}`,
      }).catch(() => {})
    }
    return res.status(500).json({ error: e?.message || String(e), startedAt })
  }
}

// Same channel the 5:15pm sales update posts to, unless overridden.
// There is no SLACK_WEBHOOK_* for this — the sales stack uses the bot
// token and a channel ID, not incoming webhooks.
function sweepChannel(): string {
  return process.env.AC_SWEEP_SLACK_CHANNEL || 'C0BTL0TND6X'
}

async function notify(r: any, wonLive: boolean, lostLive: boolean, myobWonLive: boolean) {

  const mode = (live: boolean) => (live ? 'LIVE' : 'dry run — nothing changed')
  const lines = [
    `*AC deal sweep* — ${r.openDealsScanned} open deals in the quote pipeline`,
    '',
    `*Quote Won — MYOB* (${mode(myobWonLive)}) — ${r.myobWon.matchedCount} matched by customer email`,
    `   ${r.myobWon.invoicesScanned || 0} invoices in the last ${r.myobWon.lookbackDays}d, ${r.myobWon.invoicesWithCardEmail || 0} with an email on the card`,
    r.myobWon.contactsNotFound ? `   ${r.myobWon.contactsNotFound} card emails had no AC contact` : null,
    r.myobWon.error ? `   :warning: MYOB pass failed: ${r.myobWon.error}` : null,
    '',
    `*Quote Won — MD fallback* (${mode(wonLive)}) — ${r.won.matchedCount} matched a finalised MD invoice`,
    `   ${r.won.dealsWithQuoteNumber} deals carried a quote number, ${r.won.quotesResolved} resolved in MD`,
    r.won.rejectedByRatioCount
      ? `   ${r.won.rejectedByRatioCount} rejected: invoice outside ${MIN_INVOICE_RATIO}x-${MAX_INVOICE_RATIO}x the quote`
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
