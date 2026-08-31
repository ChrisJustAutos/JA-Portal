// lib/calls-daily-recap.ts
// SERVER-ONLY. The coaching part of the 5:15pm sales update.
//
// History: this started (Chris, 2026-08-31: "send 1 message at the end of the
// day with a recap of coaching notes for that day") as its own 6:05pm post to
// #sales-coaching, replacing the ~120 per-call cards that channel used to get.
// The same day Chris folded it into the sales update — "one channel to get all
// your information" — so this file no longer posts anything and owns no channel.
// It builds blocks; lib/sales-update-slack appends them to the #sales-updates
// post and is the only thing that sends.
//
// Four sections, all four asked for:
//   1. Top call of the day        — the one worth listening to
//   2. Common improvements        — what the team should work on tomorrow
//   3. Per-advisor line           — calls and average score
//   4. A call worth reviewing     — the weakest, for coaching
//
// Figures come from fetchCoachingWindow() in lib/calls-weekly-report, the same
// assembler the Monday report uses, so the daily and weekly numbers cannot
// disagree.
//
// THE WINDOW IS NOT THE CALENDAR DAY, and deliberately not the same window as
// the sales figures in the same post. fetchCoachingWindow filters on
// `calls.call_date` — the moment the call STARTED — and joins the analysis by
// call id, so a call with no analysis row yet is simply absent. Analysis lags
// the call by ~22.5 min on average, p95 27 min. On a calendar-day window a call
// at 16:55 is inside today's window but unanalysed when the 17:15 post goes,
// and tomorrow's window starts at midnight tonight, so it is coached in NO
// recap — 1-2 scored calls a day. (Call start time was never the problem: over
// 21 weekdays, of 1353 scored calls exactly ONE started after 17:15.)
//
// So the window is a contiguous 16:30 → 16:30 Brisbane span, anchored on the
// calendar date rather than on `now`:
//   • the 45-minute settle margin before the 17:15 post clears p95 analysis lag,
//     so what is inside the window has been analysed by the time it is reported;
//   • the edges are date-anchored, not `now`-anchored, so consecutive posts
//     abut exactly — no call is counted twice when a pass lands late, and none
//     falls in a gap. Calls in the last hour of the day appear in TOMORROW's
//     post instead of vanishing.
// Residual gaps, honestly: a call whose analysis lags more than 45 minutes is
// still missed, and a posting day skipped entirely orphans its window (the
// hourly cron + date marker makes that rare).

import { fetchCoachingWindow } from './calls-weekly-report'
import { callTypeLabel, dimensionLabel, outcomeLabel } from './calls-dimensions'

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December']

/** Brisbane is UTC+10 year round. */
const brisbane = (now: Date) => new Date(now.getTime() + 10 * 3600_000)

/**
 * UTC bounds of the Brisbane calendar day `now` falls in.
 *
 * `now` must be a real UTC instant — do NOT pass a clock that has already been
 * shifted into Brisbane, or the +10 applied here lands the window on tomorrow.
 */
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

/**
 * Cutoff for the coaching window: 16:30 Brisbane, i.e. 45 minutes before the
 * 17:15 post. The margin is what stops the analysis lag (mean 22.5 min, p95
 * 27 min) losing the last calls of the day — widen it here if the analyser
 * slows down, and the window stays contiguous either way.
 */
const CUTOFF_MINUTES = 16 * 60 + 30
const CUTOFF_LABEL = '4:30pm'

/** 16:30 Brisbane on the Brisbane date `ymd`, as a UTC epoch ms. */
const cutoffUtcMs = (ymd: string) => Date.parse(ymd + 'T00:00:00Z') - 10 * 3600_000 + CUTOFF_MINUTES * 60_000

/**
 * The window one end-of-day coaching recap covers: 16:30 Brisbane on the
 * previous WEEKDAY to 16:30 Brisbane today. Monday therefore reaches back to
 * Friday 16:30, so Friday's last calls and anything over the weekend are
 * coached rather than dropped in the weekend gap.
 *
 * Pure function of `now`, which must be a real UTC instant — do NOT pass a
 * clock already shifted into Brisbane, or the +10 applied here lands the whole
 * window a day out.
 */
export function coachingRecapWindow(now: Date = new Date()): { fromIso: string; toIso: string; label: string; ymd: string } {
  const b = brisbane(now)
  const ymd = b.toISOString().slice(0, 10)
  const toMs = cutoffUtcMs(ymd)

  // Step back to the previous weekday: one day, then over Saturday/Sunday.
  let fromMs = toMs - 86_400_000
  for (let guard = 0; guard < 7; guard++) {
    const dow = new Date(fromMs + 10 * 3600_000).getUTCDay()
    if (dow >= 1 && dow <= 5) break
    fromMs -= 86_400_000
  }

  const dayName = (ms: number) => DAY_NAMES[new Date(ms + 10 * 3600_000).getUTCDay()]
  return {
    fromIso: new Date(fromMs).toISOString(),
    toIso: new Date(toMs).toISOString(),
    label: `${dayName(fromMs)} ${CUTOFF_LABEL} to ${dayName(toMs)} ${CUTOFF_LABEL}`,
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

export interface CoachingSectionsResult {
  ymd: string
  label: string
  callsAnalysed: number
  advisors: number
  averageScore: number | null
  topScore: number | null
  themes: number
}

/**
 * Build the coaching blocks. Returns null when the day has nothing analysed —
 * a "0 calls" section on every quiet day is the noise this replaced, not an
 * improvement, and the sales figures should still go out on their own.
 *
 * The blocks open with a divider and a heading naming the exact span covered,
 * so they read as part of the larger sales post — and so nobody mistakes the
 * window for the sales figures beside them. On Friday the sales figures are the
 * WEEK while this part is still one span since the last update; the span in the
 * heading is what makes that unambiguous (the Monday weekly coaching report
 * covers the week).
 */
export async function buildCoachingSections(now: Date = new Date()): Promise<{ blocks: any[]; textLine: string; result: CoachingSectionsResult } | null> {
  const win = coachingRecapWindow(now)
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

  const blocks: any[] = [
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:telephone_receiver: *Calls coached since the last update* — ${win.label}\n`
          + `${total} call${total === 1 ? '' : 's'} analysed`
          + (dayAvg != null ? `  ·  average ${dayAvg} ${scoreEmoji(dayAvg)}` : ''),
      },
    },
  ]

  // 1. Top call
  const best = notable.best
  if (best) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:trophy: *Top call* — ${best.advisor}, ${best.score} ${scoreEmoji(best.score)}\n`
          + `${best.customer}${best.type ? ` · ${callTypeLabel(best.type)}` : ''} · ${outcomeLabel(best.outcome) || best.outcome} · ${mins(best.durationSec)}\n`
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
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '*Coming up most often*' + '\n' + themes.map(t => '• ' + t).join('\n') },
    })
  }

  // 3. Per-advisor line.
  //
  // Labels go through lib/calls-dimensions, never raw. The analyser stores
  // snake_case keys (vehicle_details, information_only, status_support) and
  // printing them verbatim is what the first live post did (Chris: "Only thing
  // that doesnt look clean are the _ between things"). The helpers prettify an
  // unknown key too, so adding a rubric dimension cannot reintroduce it.
  const rows = advisors
    .filter(a => a.scored > 0)
    .sort((a, b) => (b.avgScore || 0) - (a.avgScore || 0))
    .map(a => `${scoreEmoji(a.avgScore)} *${a.name}* — ${a.scored} call${a.scored === 1 ? '' : 's'}, avg ${a.avgScore ?? '—'}`
      + (a.weakestDimension ? `  ·  weakest: ${dimensionLabel(a.weakestDimension)}` : ''))
  if (rows.length) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '*By advisor*\n' + rows.join('\n') } })
  }

  // 4. One to review
  const worst = notable.worst
  if (worst && (!best || worst.callId !== best.callId)) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:mag: *Worth a review* — ${worst.advisor}, ${worst.score} ${scoreEmoji(worst.score)}\n`
          + `${worst.customer}${worst.type ? ` · ${callTypeLabel(worst.type)}` : ''} · ${outcomeLabel(worst.outcome) || worst.outcome} · ${mins(worst.durationSec)}\n`
          + `_${worst.summary}_\n<${worst.url}|Listen in the portal>`,
      },
    })
  }

  // One line for the sales update's plain-text fallback. Built explicitly, not
  // by stripping markdown out of the blocks: a blanket /[*_]/ strip also eats
  // the underscores inside emoji shortcodes.
  const textLine = `Calls coached since the last update (${win.label}): ${total} call${total === 1 ? '' : 's'} analysed`
    + (dayAvg != null ? `, average ${dayAvg}` : '')
    + (best ? `. Top call ${best.advisor} ${best.score}.` : '.')

  return {
    blocks, textLine,
    result: {
      ymd: win.ymd, label: win.label, callsAnalysed: total,
      advisors: advisors.filter(a => a.scored > 0).length,
      averageScore: dayAvg,
      topScore: best ? best.score : null,
      themes: themes.length,
    },
  }
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
