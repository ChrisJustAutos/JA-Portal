// lib/calls-daily-recap.ts
// SERVER-ONLY. One end-of-day coaching message to #sales-coaching, replacing
// the ~120 per-call cards the channel used to get every day (Chris,
// 2026-08-31: "send 1 message at the end of the day with a recap of coaching
// notes for that day").
//
// Four sections, all four asked for:
//   1. Top call of the day        — the one worth listening to
//   2. Common improvements        — what the team should work on tomorrow
//   3. Per-advisor line           — calls and average score
//   4. A call worth reviewing     — the weakest, for coaching
//
// Figures come from fetchCoachingWindow() in lib/calls-weekly-report, the same
// assembler the Monday report uses, so the daily and weekly numbers cannot
// disagree. Windowed on the BRISBANE calendar day, not a rolling 24 hours: an
// 18:00 recap on a rolling window would fold in yesterday evening's calls.

import { fetchCoachingWindow } from './calls-weekly-report'
import { postMessage } from './slack-bot/slack'

const CHANNEL = () => (process.env.CALLS_COACHING_SLACK_CHANNEL ?? 'C0AU8QWT7QF').trim()
const PORTAL = process.env.JA_PORTAL_BASE_URL || 'https://justautos.app'

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December']

/** Brisbane is UTC+10 year round. */
const brisbane = (now: Date) => new Date(now.getTime() + 10 * 3600_000)

/** UTC bounds of the Brisbane calendar day `now` falls in. */
export function brisbaneDayWindow(now: Date = new Date()): { fromIso: string; toIso: string; label: string; ymd: string } {
  const b = brisbane(now)
  const ymd = b.toISOString().slice(0, 10)
  const startUtcMs = Date.parse(ymd + 'T00:00:00Z') - 10 * 3600_000
  return {
    fromIso: new Date(startUtcMs).toISOString(),
    toIso: new Date(startUtcMs + 86_400_000).toISOString(),
    label: `${DAY_NAMES[b.getUTCDay()]} ${b.getUTCDate()} ${MONTHS[b.getUTCMonth()]}`,
    ymd,
  }
}

function scoreEmoji(score: number | null): string {
  if (score == null) return ':white_circle:'
  if (score >= 80) return ':large_green_circle:'
  if (score >= 60) return ':large_yellow_circle:'
  if (score >= 40) return ':large_orange_circle:'
  return ':red_circle:'
}

const mins = (sec: number) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`

export interface DailyRecapResult {
  posted: boolean
  ymd: string
  callsAnalysed: number
  advisors: number
  topScore: number | null
  skipped?: string
}

/**
 * Build the message. Returns null when the day has nothing analysed — a recap
 * saying "0 calls" every Sunday is the noise this replaced, not an improvement.
 */
export async function buildDailyRecap(now: Date = new Date()): Promise<{ blocks: any[]; text: string; result: DailyRecapResult } | null> {
  const win = brisbaneDayWindow(now)
  const { advisors, total, notable } = await fetchCoachingWindow(1, {
    fromIso: win.fromIso, toIso: win.toIso, label: win.label,
  })
  if (total === 0) {
    return null
  }

  const scored = advisors.filter(a => a.avgScore != null)
  const dayAvg = scored.length
    ? Math.round(scored.reduce((s, a) => s + (a.avgScore || 0) * a.scored, 0) / Math.max(1, scored.reduce((s, a) => s + a.scored, 0)))
    : null

  const blocks: any[] = [{
    type: 'section',
    text: { type: 'mrkdwn', text: `:telephone_receiver: *Coaching recap — ${win.label}*\n${total} call${total === 1 ? '' : 's'} analysed${dayAvg != null ? `  ·  average ${dayAvg} ${scoreEmoji(dayAvg)}` : ''}` },
  }]

  // 1. Top call
  const best = notable.best
  if (best) {
    blocks.push({ type: 'divider' })
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:trophy: *Top call of the day* — ${best.advisor}, ${best.score} ${scoreEmoji(best.score)}\n`
          + `${best.customer}${best.type ? ` · ${best.type}` : ''} · ${best.outcome} · ${mins(best.durationSec)}\n`
          + `_${best.summary}_\n<${best.url}|Listen in the portal>`,
      },
    })
  }

  // 2. Common improvements across the day.
  //
  // NOT a frequency count of the improvement strings: the analyser writes a
  // long, unique paragraph per call ("The close was almost invisible. After Ben
  // confirmed..."), so counting exact matches gives every item n=1 and would
  // print five arbitrary essays. The recurring themes are real - soft closes,
  // shallow discovery, incomplete details captured - but they have to be read
  // out of the prose, so they are summarised. Fails OPEN: if the model or key is
  // unavailable the section is omitted and the rest of the recap still goes.
  const themes = await summariseThemes(advisors, win.label).catch(e => {
    console.error('daily recap: theme summary failed (non-fatal):', e?.message || e)
    return [] as string[]
  })
  if (themes.length) {
    blocks.push({ type: 'divider' })
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '*Coming up most often today*' + '\n' + themes.map(t => '• ' + t).join('\n') },
    })
  }

  // 3. Per-advisor line
  const rows = advisors
    .filter(a => a.scored > 0)
    .sort((a, b) => (b.avgScore || 0) - (a.avgScore || 0))
    .map(a => `${scoreEmoji(a.avgScore)} *${a.name}* — ${a.scored} call${a.scored === 1 ? '' : 's'}, avg ${a.avgScore ?? '—'}`
      + (a.weakestDimension ? `  ·  weakest: ${a.weakestDimension}` : ''))
  if (rows.length) {
    blocks.push({ type: 'divider' })
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '*By advisor*\n' + rows.join('\n') } })
  }

  // 4. One to review
  const worst = notable.worst
  if (worst && (!best || worst.callId !== best.callId)) {
    blocks.push({ type: 'divider' })
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:mag: *Worth a review* — ${worst.advisor}, ${worst.score} ${scoreEmoji(worst.score)}\n`
          + `${worst.customer}${worst.type ? ` · ${worst.type}` : ''} · ${worst.outcome} · ${mins(worst.durationSec)}\n`
          + `_${worst.summary}_\n<${worst.url}|Listen in the portal>`,
      },
    })
  }

  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `Every call is still scored and readable in full at <${PORTAL}/calls|Calls>. This replaces the per-call cards.` }],
  })

  const text = `Coaching recap — ${win.label}: ${total} calls analysed`
    + (dayAvg != null ? `, average ${dayAvg}` : '')
    + (best ? `. Top call ${best.advisor} ${best.score}.` : '.')

  return {
    blocks, text,
    result: {
      posted: false, ymd: win.ymd, callsAnalysed: total,
      advisors: advisors.filter(a => a.scored > 0).length,
      topScore: best ? best.score : null,
    },
  }
}

export async function postDailyRecap(now: Date = new Date()): Promise<DailyRecapResult> {
  const built = await buildDailyRecap(now)
  if (!built) {
    const win = brisbaneDayWindow(now)
    return { posted: false, ymd: win.ymd, callsAnalysed: 0, advisors: 0, topScore: null, skipped: 'nothing analysed today' }
  }
  const res = await postMessage({ channel: CHANNEL(), text: built.text, blocks: built.blocks })
  return { ...built.result, posted: !!res, skipped: res ? undefined : 'Slack rejected the post' }
}

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'
const MODEL = () => process.env.CALLS_ANALYSIS_MODEL || 'claude-sonnet-4-6'

/**
 * The 3-5 coaching themes that genuinely recurred across the day's calls.
 *
 * Input is bounded on purpose: each improvement is trimmed to 320 characters
 * and the list capped at 60 items. A busy day produces ~130 paragraphs and
 * sending them all in full is slow and pointless - the theme is legible from
 * the opening sentence of each.
 */
async function summariseThemes(advisors: { name: string; improvements: string[] }[], label: string): Promise<string[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return []
  const items: string[] = []
  for (const a of advisors) {
    for (const imp of (a.improvements || [])) {
      if (imp && imp.trim()) items.push(a.name + ': ' + imp.trim().slice(0, 320))
    }
  }
  if (items.length < 3) return []          // too little to call anything a theme

  const prompt = [
    'You are the sales coach for Just Autos (Australian 4WD/diesel performance workshop, consultative sales).',
    'Below are the per-call improvement notes from ' + label + ', written by the call analyser.',
    '',
    'NOTES:',
    items.slice(0, 60).join('\n'),
    '',
    'Identify the 3-5 coaching themes that genuinely RECUR across these notes - patterns, not one-offs.',
    'Return ONLY JSON: { "themes": ["one short line each, max 18 words, phrased as what to do differently tomorrow"] }',
    'Rules: only themes actually present in the notes, never invented. No markdown. Most common first.',
  ].join('\n')

  const r = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL(), max_tokens: 1200, messages: [{ role: 'user', content: prompt }] }),
  })
  if (!r.ok) throw new Error('Anthropic ' + r.status + ': ' + (await r.text()).slice(0, 200))
  const data = await r.json()
  if (data.stop_reason === 'max_tokens') throw new Error('theme summary truncated at max_tokens')
  const text = String(data.content?.[0]?.text || '')
  const parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1))
  const themes = Array.isArray(parsed.themes) ? parsed.themes : []
  return themes.filter((t: any) => typeof t === 'string' && t.trim()).slice(0, 5)
}
