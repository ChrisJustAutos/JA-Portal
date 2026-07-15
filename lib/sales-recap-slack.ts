// lib/sales-recap-slack.ts
//
// Negative-feedback pull for the Weekly Sales Recap: everything posted in the
// negative Slack channel (#customer-feedback-negative — the call-concerns
// automation's cards AND anything staff post there manually) over the report
// period. Kept out of lib/sales-recap.ts so the assembler stays pure/IO-free.
//
// Same channel the concern automation posts to (lib/call-concerns CHANNEL).
// Reading history needs the bot in the channel with groups:history — already
// true for the concern follow-up sweep's messageExists checks.

import { listChannelHistory, getUserName } from './slack-bot/slack'
import { negativeFeedbackSpan, type RecapWeek, type NegativeFeedbackOut, type NegativeFeedbackItem } from './sales-recap'

const CHANNEL = process.env.CONCERN_SLACK_CHANNEL || 'G01GB6P2MU1' // #customer-feedback-negative

// Slack mrkdwn → plain-ish text for the report: resolve <url|label> and
// <#C…|name> to their labels, drop raw <@U…> mention brackets.
function cleanSlackText(s: string): string {
  return s
    .replace(/<[^>|]+\|([^>]+)>/g, '$1')
    .replace(/<@([A-Z0-9]+)>/g, '@$1')
    .replace(/<([^>]+)>/g, '$1')
    .replace(/\s+\n/g, '\n')
    .trim()
}

export async function fetchNegativeFeedback(week: RecapWeek, nowMs: number): Promise<NegativeFeedbackOut> {
  const { startMs, endMs } = negativeFeedbackSpan(week, nowMs)
  const messages = await listChannelHistory(CHANNEL, startMs / 1000, endMs / 1000)

  // Resolve human posters' names once each; bot cards carry the advisor's
  // voice in the text, so they get no author line.
  const names = new Map<string, string | null>()
  const items: NegativeFeedbackItem[] = []
  for (const m of messages) {
    let author: string | null = null
    if (!m.bot && m.user) {
      if (!names.has(m.user)) names.set(m.user, await getUserName(m.user))
      author = names.get(m.user) || 'staff'
    }
    items.push({
      at: new Date(Number(m.ts) * 1000).toISOString(),
      author,
      text: cleanSlackText(m.text).slice(0, 500),
    })
  }

  const fmt = (ms: number) => new Date(ms).toLocaleString('en-AU', {
    timeZone: 'Australia/Brisbane', weekday: 'short', day: '2-digit', month: 'short',
    hour: 'numeric', minute: '2-digit', hour12: true,
  })
  return {
    start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString(),
    label: `${fmt(startMs)} → ${fmt(endMs)}`, items,
  }
}
