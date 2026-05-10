// pages/api/cron/bank-payments-slack.ts
//
// Daily 7am Sydney digest — posts new MYOB bank transactions (Spend Money +
// Receive Money) for the last 24h to the corresponding Slack channel:
//   VPS  → SLACK_WEBHOOK_VPS_PAYMENTS  (#vps-payments)
//   JAWS → SLACK_WEBHOOK_JAWS_PAYMENTS (#jaws-payments)
//
// Schedule (see vercel.json): runs at 20:00 AND 21:00 UTC. The handler
// gates on Sydney local hour == 7, which makes the digest land at 7am
// year-round regardless of DST (AEST = UTC+10 → 21:00 UTC; AEDT = UTC+11
// → 20:00 UTC). On manual invocation pass ?force=1 to bypass the gate.
//
// Weekend behaviour:
//   - Sat & Sun: no send (transactions roll into Monday's digest).
//   - Mon: window expands to 72h to cover Fri-Sat-Sun-Mon since the last
//     Friday digest.
//   - Tue–Fri: window is 24h.
//
// Manual invocation:
//   curl -H "Authorization: Bearer $CRON_SECRET" https://<host>/api/cron/bank-payments-slack
//   curl -H "Authorization: Bearer $CRON_SECRET" https://<host>/api/cron/bank-payments-slack?force=1
//   curl -H "Authorization: Bearer $CRON_SECRET" https://<host>/api/cron/bank-payments-slack?dry=1
//        (dry=1 returns the formatted blocks without posting to Slack)

import type { NextApiRequest, NextApiResponse } from 'next'
import {
  fetchBankTxnsSince,
  BankTxn,
  CompanyFileLabel,
  CompanyTxnsResult,
} from '../../../lib/myob-bank'
import { postWebhook, SlackBlock } from '../../../lib/slack'

// ── Sydney-local helpers ────────────────────────────────────────────────

function sydneyParts(d: Date): { hour: number; dayOfWeek: number; dateStr: string } {
  // dayOfWeek: 0=Sun, 1=Mon, ..., 6=Sat
  const fmt = new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Sydney',
    weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: 'numeric', hour12: false,
  })
  const parts = fmt.formatToParts(d)
  const get = (t: string) => parts.find(p => p.type === t)?.value || ''
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
  return {
    hour: parseInt(get('hour'), 10),
    dayOfWeek: weekdayMap[get('weekday')] ?? -1,
    dateStr: `${get('day')}/${get('month')}/${get('year')}`,
  }
}

function formatSydneyDayLong(d: Date): string {
  return new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Sydney',
    weekday: 'long', day: 'numeric', month: 'long',
  }).format(d)
}

function formatSydneyShortDate(iso: string): string {
  // iso is yyyy-mm-dd from MYOB. Treat as a calendar date and format
  // in en-AU as "Tue 12/05".
  const [y, m, day] = iso.split('-').map(n => parseInt(n, 10))
  if (!y || !m || !day) return iso
  // Use UTC noon to avoid DST/edge-of-day shifts when reformatting.
  const d = new Date(Date.UTC(y, m - 1, day, 12, 0, 0))
  return new Intl.DateTimeFormat('en-AU', {
    weekday: 'short', day: '2-digit', month: '2-digit',
  }).format(d)
}

function fmtAud(n: number): string {
  return new Intl.NumberFormat('en-AU', {
    style: 'currency', currency: 'AUD', minimumFractionDigits: 2,
  }).format(n)
}

// ── Window calculation ─────────────────────────────────────────────────

function windowStart(now: Date): { since: Date; hours: number; label: string } {
  const { dayOfWeek } = sydneyParts(now)
  const hours = dayOfWeek === 1 ? 72 : 24
  const since = new Date(now.getTime() - hours * 3600 * 1000)
  const label = hours === 72 ? 'since Friday morning' : 'last 24 hours'
  return { since, hours, label }
}

// ── Filter ──────────────────────────────────────────────────────────────
// The digest is for *incoming* payments only (deposits). Outgoing
// Spend Money is dropped entirely. Deposits at or above $50k are also
// hidden — those go through a separate manual review channel — but we
// keep a count so it's visible in the message that some were excluded.

const HIGH_VALUE_THRESHOLD = 50_000

interface FilteredResult {
  txns: BankTxn[]
  hiddenHighValue: number   // count of receive-money >= $50k that were dropped
}

function applyFilter(txns: BankTxn[]): FilteredResult {
  let hiddenHighValue = 0
  const out: BankTxn[] = []
  for (const t of txns) {
    if (t.kind !== 'receive') continue
    if (t.amount >= HIGH_VALUE_THRESHOLD) { hiddenHighValue++; continue }
    out.push(t)
  }
  return { txns: out, hiddenHighValue }
}

// ── Message formatting ─────────────────────────────────────────────────

const MAX_LINES = 25     // Slack soft-truncates very long blocks; keep tidy.

function buildMessage(
  label: CompanyFileLabel,
  result: CompanyTxnsResult,
  filtered: FilteredResult,
  now: Date,
  windowLabel: string,
): { text: string; blocks: SlackBlock[] } {
  const dayStr = formatSydneyDayLong(now)
  const header = `${label} Payments — ${dayStr}`
  const hiddenFooter = filtered.hiddenHighValue > 0
    ? `\n_${filtered.hiddenHighValue} deposit${filtered.hiddenHighValue === 1 ? '' : 's'} ≥ ${fmtAud(HIGH_VALUE_THRESHOLD)} hidden — review in MYOB._`
    : ''

  if (!result.connected) {
    return {
      text: `${header}: MYOB not connected (${result.error || 'unknown'})`,
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: header } },
        { type: 'section', text: { type: 'mrkdwn', text: `:warning: MYOB ${label} is *not connected* — ${result.error || 'reconnect in Settings → MYOB Connection'}.` } },
      ],
    }
  }

  if (result.error) {
    return {
      text: `${header}: MYOB lookup failed — ${result.error}`,
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: header } },
        { type: 'section', text: { type: 'mrkdwn', text: `:warning: Couldn't load ${label} bank transactions — ${result.error}` } },
      ],
    }
  }

  const txns = filtered.txns
  if (txns.length === 0) {
    const text = filtered.hiddenHighValue > 0
      ? `No new deposits under ${fmtAud(HIGH_VALUE_THRESHOLD)} in MYOB ${label} for the ${windowLabel}.${hiddenFooter}`
      : `No new deposits in MYOB ${label} for the ${windowLabel}. :tea:`
    return {
      text: `${header}: no new deposits (${windowLabel}).`,
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: header } },
        { type: 'section', text: { type: 'mrkdwn', text: text } },
      ],
    }
  }

  const totalIn = txns.reduce((s, t) => s + t.amount, 0)
  const summary = `*${txns.length}* new deposit${txns.length === 1 ? '' : 's'}  ·  :arrow_down: ${fmtAud(totalIn)} received   _(${windowLabel})_`

  const shown = txns.slice(0, MAX_LINES)
  const overflow = txns.length - shown.length

  // Build a single mrkdwn section with one line per deposit. Keep concise:
  //   Tue 12/05 · +$1,200.00 · Customer Pty Ltd · NAB 1-1100
  const lines = shown.map(tx => {
    const who = tx.payeeOrPayer || 'Deposit'
    const memo = tx.memo ? ` _(${truncate(tx.memo, 60)})_` : ''
    const acct = tx.bankAccountName ? ` · ${tx.bankAccountName}` : ''
    return `• ${formatSydneyShortDate(tx.date)} · *+${fmtAud(tx.amount)}* · ${escapeMrkdwn(who)}${memo}${acct}`
  })
  if (overflow > 0) lines.push(`_…and ${overflow} more — open MYOB ${label} to view._`)

  const bodyText = lines.join('\n') + hiddenFooter

  const blocks: SlackBlock[] = [
    { type: 'header', text: { type: 'plain_text', text: header } },
    { type: 'section', text: { type: 'mrkdwn', text: summary } },
    { type: 'divider' },
    { type: 'section', text: { type: 'mrkdwn', text: bodyText } },
  ]

  const text = `${header}: ${txns.length} new deposit${txns.length === 1 ? '' : 's'} (${windowLabel})`
  return { text, blocks }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max - 1).trim() + '…'
}

function escapeMrkdwn(s: string): string {
  return s.replace(/[<>&]/g, ch => ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : '&amp;')
}

// ── Handler ────────────────────────────────────────────────────────────

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Auth — same pattern as the other crons.
  const cronSecret = process.env.CRON_SECRET
  const authHeader = req.headers.authorization || ''
  const userAgent = String(req.headers['user-agent'] || '').toLowerCase()
  const authorized = cronSecret
    ? authHeader === `Bearer ${cronSecret}`
    : userAgent.includes('vercel-cron')
  if (!authorized) return res.status(401).json({ error: 'Unauthorised' })

  try {
    return await runHandler(req, res)
  } catch (e: any) {
    console.error('bank-payments-slack: unhandled error', e)
    return res.status(500).json({
      ok: false,
      error: (e?.message || String(e)).slice(0, 500),
      stack: process.env.NODE_ENV === 'production' ? undefined : (e?.stack || null),
    })
  }
}

async function runHandler(req: NextApiRequest, res: NextApiResponse) {
  const force = req.query.force === '1'
  const dryRun = req.query.dry === '1'

  const now = new Date()
  const { hour, dayOfWeek } = sydneyParts(now)

  // Time gate: only fire at 7am Sydney. The cron runs at both 20:00 and
  // 21:00 UTC so exactly one of those matches 7am Sydney depending on DST.
  if (!force && hour !== 7) {
    return res.status(200).json({
      ok: true,
      skipped: 'not-7am-sydney',
      sydneyHour: hour,
      sydneyDayOfWeek: dayOfWeek,
    })
  }

  // Weekend skip: Sat (6) & Sun (0) roll into Monday's 72h digest.
  if (!force && (dayOfWeek === 0 || dayOfWeek === 6)) {
    return res.status(200).json({
      ok: true,
      skipped: 'weekend',
      sydneyDayOfWeek: dayOfWeek,
    })
  }

  const webhookVps  = process.env.SLACK_WEBHOOK_VPS_PAYMENTS
  const webhookJaws = process.env.SLACK_WEBHOOK_JAWS_PAYMENTS
  if (!webhookVps && !webhookJaws) {
    return res.status(500).json({
      ok: false,
      error: 'Neither SLACK_WEBHOOK_VPS_PAYMENTS nor SLACK_WEBHOOK_JAWS_PAYMENTS is set',
    })
  }

  const { since, hours, label: windowLabel } = windowStart(now)

  // Use allSettled so one company's MYOB fetch failing doesn't tank the other.
  const settled = await Promise.allSettled([
    fetchBankTxnsSince('VPS',  since),
    fetchBankTxnsSince('JAWS', since),
  ])

  const safeResult = (label: CompanyFileLabel, s: PromiseSettledResult<CompanyTxnsResult>): CompanyTxnsResult => {
    if (s.status === 'fulfilled') return s.value
    return { label, connected: true, txns: [], error: (s.reason?.message || String(s.reason)).slice(0, 300) }
  }
  const vpsResult  = safeResult('VPS',  settled[0])
  const jawsResult = safeResult('JAWS', settled[1])

  const vpsFiltered  = applyFilter(vpsResult.txns)
  const jawsFiltered = applyFilter(jawsResult.txns)

  // Wrap message-building too — a bad row shouldn't kill the whole digest.
  function safeBuild(label: CompanyFileLabel, r: CompanyTxnsResult, f: FilteredResult) {
    try { return buildMessage(label, r, f, now, windowLabel) }
    catch (e: any) {
      return {
        text: `${label} Payments — digest build failed: ${e?.message || e}`,
        blocks: [
          { type: 'header', text: { type: 'plain_text', text: `${label} Payments — build error` } },
          { type: 'section', text: { type: 'mrkdwn', text: `:warning: Couldn't build message: ${(e?.message || String(e)).slice(0, 200)}` } },
        ],
      }
    }
  }
  const vpsMsg  = safeBuild('VPS',  vpsResult,  vpsFiltered)
  const jawsMsg = safeBuild('JAWS', jawsResult, jawsFiltered)

  if (dryRun) {
    return res.status(200).json({
      ok: true,
      dryRun: true,
      sinceUtc: since.toISOString(),
      windowHours: hours,
      vps:  { result: { ...vpsResult,  txns: vpsResult.txns.length  },  shown: vpsFiltered.txns.length,  hiddenHighValue: vpsFiltered.hiddenHighValue,  message: vpsMsg  },
      jaws: { result: { ...jawsResult, txns: jawsResult.txns.length }, shown: jawsFiltered.txns.length, hiddenHighValue: jawsFiltered.hiddenHighValue, message: jawsMsg },
    })
  }

  // Same allSettled treatment for the posts — VPS webhook erroring out
  // shouldn't prevent the JAWS message from going through.
  async function safePost(label: CompanyFileLabel, url: string | undefined, msg: { text: string; blocks: any[] }) {
    if (!url) return { ok: false, status: 0, body: `SLACK_WEBHOOK_${label}_PAYMENTS not set` }
    try {
      return await postWebhook(url, msg)
    } catch (e: any) {
      return { ok: false, status: 0, body: `fetch threw: ${(e?.message || String(e)).slice(0, 200)}` }
    }
  }
  const [vpsPost, jawsPost] = await Promise.all([
    safePost('VPS',  webhookVps,  vpsMsg),
    safePost('JAWS', webhookJaws, jawsMsg),
  ])

  return res.status(200).json({
    ok: vpsPost.ok && jawsPost.ok,
    sinceUtc: since.toISOString(),
    windowHours: hours,
    vps:  { rawCount: vpsResult.txns.length,  shown: vpsFiltered.txns.length,  hiddenHighValue: vpsFiltered.hiddenHighValue,  posted: vpsPost.ok,  status: vpsPost.status,  body: vpsPost.body,  fetchError: vpsResult.error  || null },
    jaws: { rawCount: jawsResult.txns.length, shown: jawsFiltered.txns.length, hiddenHighValue: jawsFiltered.hiddenHighValue, posted: jawsPost.ok, status: jawsPost.status, body: jawsPost.body, fetchError: jawsResult.error || null },
  })
}
