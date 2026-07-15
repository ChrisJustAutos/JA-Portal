// lib/sales-recap-slack.ts
//
// Feedback-channel pulls for the Weekly Sales Recap: everything posted in the
// negative and positive customer-feedback Slack channels (automation cards
// AND manual staff posts alike) over the report period. Kept out of
// lib/sales-recap.ts so the assembler stays pure/IO-free.
//
// The negative channel is the same one the call-concerns automation posts to
// (lib/call-concerns CHANNEL). Reading history needs the portal bot IN each
// channel with groups:history — true for the negative channel (the concern
// follow-up sweep reads it); the positive channel needs the bot invited once.

import { listChannelHistory, getUserName } from './slack-bot/slack'
import { feedbackSpan, type RecapWeek, type FeedbackOut, type FeedbackItem } from './sales-recap'

const NEGATIVE_CHANNEL = process.env.CONCERN_SLACK_CHANNEL || 'G01GB6P2MU1'          // #customer-feedback-negative
const POSITIVE_CHANNEL = process.env.SLACK_FEEDBACK_POSITIVE_CHANNEL || 'C05UVDQ96ES' // #customer-feedback-positive

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

async function fetchChannelFeedback(channel: string, week: RecapWeek, nowMs: number): Promise<FeedbackOut> {
  const { startMs, endMs } = feedbackSpan(week, nowMs)
  const messages = await listChannelHistory(channel, startMs / 1000, endMs / 1000)

  // Resolve human posters' names once each; bot cards carry the advisor's
  // voice in the text, so they get no author line.
  const names = new Map<string, string | null>()
  const items: FeedbackItem[] = []
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

  // Plain date-range label ("Mon, 13 July → Fri, 17 July") — the span is
  // whole Brisbane days now; endMs sits at midnight AFTER the last included
  // day (or `now`), so step back 1ms for the display date.
  const fmtDay = (ms: number) => new Date(ms).toLocaleDateString('en-AU', {
    timeZone: 'Australia/Brisbane', weekday: 'short', day: '2-digit', month: 'short',
  })
  return {
    start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString(),
    label: `${fmtDay(startMs)} → ${fmtDay(Math.max(startMs, endMs - 1))}`, items,
  }
}

export const fetchNegativeFeedback = (week: RecapWeek, nowMs: number) => fetchChannelFeedback(NEGATIVE_CHANNEL, week, nowMs)
export const fetchPositiveFeedback = (week: RecapWeek, nowMs: number) => fetchChannelFeedback(POSITIVE_CHANNEL, week, nowMs)
