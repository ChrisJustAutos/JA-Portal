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

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'
const MODEL = process.env.CALLS_ANALYSIS_MODEL || 'claude-sonnet-4-6'

// The negative channel doubles as a discussion space — staff questions,
// acknowledgements and process chat land between the genuine complaint posts.
// The recap should only surface actual customer issues, so human posts run
// through a keep/drop LLM screen. Bot posts skip it (the call-concerns
// automation only ever posts concern cards). Fails open: no API key or any
// error → everything stays, the panel is never emptied by an outage.
async function filterToIssues(items: FeedbackItem[]): Promise<FeedbackItem[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  const humans = items.map((it, idx) => ({ it, idx })).filter(x => x.it.author !== null)
  if (!apiKey || humans.length === 0) return items
  const listing = humans.map((x, n) => `${n + 1}. ${x.it.text.replace(/\s+/g, ' ').slice(0, 400)}`).join('\n')
  const prompt = `Below are staff posts from a workshop's #customer-feedback-negative Slack channel. Keep ONLY posts reporting an actual customer issue: a complaint, concern, fault/comeback, refund request, bad review, or an unhappy customer. Drop general chat: questions to colleagues, acknowledgements or replies, scheduling/process talk, jokes, and anything not describing a specific customer problem.

${listing}

Respond ONLY with JSON: {"keep":[<numbers of the posts to keep>]}`
  try {
    const r = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: 500, messages: [{ role: 'user', content: prompt }] }),
    })
    if (!r.ok) return items
    const data = await r.json()
    const text = data.content?.[0]?.text || ''
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim()
    const first = cleaned.indexOf('{'); const last = cleaned.lastIndexOf('}')
    const parsed = JSON.parse(first >= 0 ? cleaned.slice(first, last + 1) : cleaned)
    if (!Array.isArray(parsed?.keep)) return items
    // An empty keep list is a legitimate verdict (all human posts were chat).
    const keep = new Set(parsed.keep.map((n: any) => Number(n)))
    const drop = new Set(humans.filter((x, n) => !keep.has(n + 1)).map(x => x.idx))
    return items.filter((_, idx) => !drop.has(idx))
  } catch { return items }
}

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

async function fetchChannelFeedback(channel: string, week: RecapWeek, nowMs: number, issuesOnly = false): Promise<FeedbackOut> {
  const { startMs, endMs } = feedbackSpan(week, nowMs)
  const messages = await listChannelHistory(channel, startMs / 1000, endMs / 1000)

  // Resolve human posters' names once each; bot cards carry the advisor's
  // voice in the text, so they get no author line.
  const names = new Map<string, string | null>()
  let items: FeedbackItem[] = []
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

  if (issuesOnly) items = await filterToIssues(items)

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

export const fetchNegativeFeedback = (week: RecapWeek, nowMs: number) => fetchChannelFeedback(NEGATIVE_CHANNEL, week, nowMs, true)
export const fetchPositiveFeedback = (week: RecapWeek, nowMs: number) => fetchChannelFeedback(POSITIVE_CHANNEL, week, nowMs)
