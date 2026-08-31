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
// Then on 2026-09-01 Chris cut it back to a morale note: "Just have top call
// for the day. No notes, No by advisor. Just top call and positives. This is a
// pump up message at the end of the day (ie. finish on a high note)."
//
// TWO sections, and deliberately only two:
//   1. Top call of the day  — the one worth listening to
//   2. What went well       — positives drawn from the analyser's `strengths`
//
// GONE on purpose, do not reinstate without asking: the recurring-improvements
// list, the per-advisor table (calls / average / weakest dimension) and the
// weakest call. Nothing is lost - every call is still scored and readable at
// /calls, and the Monday weekly report still carries the corrective coaching.
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
import { callTypeLabel, outcomeLabel } from './calls-dimensions'

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
  topScore: number | null
  positives: number
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

  // A pump-up note to finish the day on, NOT a coaching debrief (Chris,
  // 2026-09-01: "Just top call and positives. This is a pump up message at the
  // end of the day (ie. finish on a high note)"). Deliberately dropped: the
  // recurring-improvements list, the per-advisor table with its average and
  // weakest dimension, and the weakest call. None of it is lost - every call is
  // still scored and readable at /calls, and the Monday weekly report still
  // carries the full coaching picture including what needs work.
  const blocks: any[] = [{ type: 'divider' }]

  const best = notable.best
  if (best) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:trophy: *Top call of the day* — ${best.advisor}, ${best.score} ${scoreEmoji(best.score)}\n`
          + `${best.customer}${best.type ? ` · ${callTypeLabel(best.type)}` : ''} · ${outcomeLabel(best.outcome) || best.outcome} · ${mins(best.durationSec)}\n`
          + `_${best.summary}_\n<${best.url}|Listen in the portal>`,
      },
    })
  }

  // Positives, summarised from the analyser's per-call `strengths` - NOT
  // `improvements`, which is what this section used to read. Same reason it was
  // never a frequency count: these are long unique paragraphs, so counting exact
  // matches returns every item at n=1. Fails OPEN - no key or any error drops
  // this section and the sales figures still post.
  const positives = await summarisePositives(advisors, win.label).catch(e => {
    console.error('daily recap: positives summary failed (non-fatal):', e?.message || e)
    return [] as string[]
  })
  if (positives.length) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*What went well* — across ${total} call${total === 1 ? '' : 's'} today\n`
          + positives.map(t => '• ' + t).join('\n'),
      },
    })
  }

  // Only the divider = nothing to celebrate. Add nothing rather than hang an
  // empty rule off the bottom of the sales figures.
  if (blocks.length === 1) return null

  // One line for the sales update's plain-text fallback. Built explicitly, not
  // by stripping markdown out of the blocks: a blanket /[*_]/ strip also eats
  // the underscores inside emoji shortcodes.
  const textLine = best
    ? `Top call of the day: ${best.advisor}, ${best.score}.`
    : `${total} call${total === 1 ? '' : 's'} coached today.`

  return {
    blocks, textLine,
    result: {
      ymd: win.ymd, label: win.label, callsAnalysed: total,
      advisors: advisors.filter(a => a.scored > 0).length,
      topScore: best ? best.score : null,
      positives: positives.length,
    },
  }
}

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'
const MODEL = () => process.env.CALLS_ANALYSIS_MODEL || 'claude-sonnet-4-6'

/**
 * The 3-5 things that genuinely went WELL across the day's calls.
 *
 * Reads `strengths`, not `improvements` - this section is the end-of-day
 * pump-up, so it names what the team did well rather than what to fix. The
 * Monday weekly report still carries the corrective side.
 *
 * Input is bounded on purpose: each strength is trimmed to 320 characters and
 * the list capped at 60 items. A busy day produces well over a hundred
 * paragraphs and sending them all in full is slow and pointless - the point is
 * legible from the opening sentence of each.
 */
async function summarisePositives(advisors: { name: string; strengths: string[] }[], label: string): Promise<string[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return []
  const items: string[] = []
  for (const a of advisors) {
    for (const s of (a.strengths || [])) {
      if (s && s.trim()) items.push(a.name + ': ' + s.trim().slice(0, 320))
    }
  }
  if (items.length < 3) return []          // too little to draw a pattern from

  const prompt = [
    'You are the sales coach for Just Autos (Australian 4WD/diesel performance workshop, consultative sales).',
    'Below are the per-call STRENGTHS from ' + label + ', written by the call analyser.',
    '',
    'NOTES:',
    items.slice(0, 60).join('\n'),
    '',
    'This goes in an end-of-day Slack post to finish the team on a high, so name the 3-5 things',
    'that genuinely went WELL today. Credit people by first name where a note clearly belongs to one person.',
    'Return ONLY JSON: { "positives": ["one short line each, max 18 words, specific and celebratory"] }',
    'Rules: only things actually present in the notes, never invented. No criticism, no "but", no advice',
    'about what to do better - this section is praise only. No markdown. Strongest first.',
  ].join('\n')

  const r = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL(), max_tokens: 1200, messages: [{ role: 'user', content: prompt }] }),
  })
  if (!r.ok) throw new Error('Anthropic ' + r.status + ': ' + (await r.text()).slice(0, 200))
  const data = await r.json()
  if (data.stop_reason === 'max_tokens') throw new Error('positives summary truncated at max_tokens')
  const text = String(data.content?.[0]?.text || '')
  const parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1))
  const positives = Array.isArray(parsed.positives) ? parsed.positives : []
  return positives.filter((t: any) => typeof t === 'string' && t.trim()).slice(0, 5)
}
