// lib/calls-weekly-report.ts
//
// Weekly sales-coaching report (Chris 2026-07-07): every Monday morning a
// polished per-advisor digest of last week's coached calls lands in
// #sales-coaching — coaching notes, action items, quick wins, losses
// (customer signalled intent but the booking was missed), and feedback.
//
// Pipeline: aggregate the week's call_analysis rows per advisor (stats,
// best/worst calls, missed-booking candidates = sales-type calls that didn't
// book with a weak closing score), hand the compact dataset to Claude for the
// narrative, then post: one channel message with the team overview + one
// threaded reply per advisor (avoids Slack's 50-block limit and keeps the
// channel tidy).

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { postMessage } from './slack-bot/slack'
import { callTypeLabel, dimensionLabel } from './calls-dimensions'

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'
const MODEL = () => (process.env.CALLS_WEEKLY_REPORT_MODEL || 'claude-sonnet-4-6').trim()
const CHANNEL = () => (process.env.CALLS_COACHING_SLACK_CHANNEL ?? 'C0AU8QWT7QF').trim()

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

const SALES_TYPES = ['new_sales_enquiry', 'quote_follow_up']
const BOOKED = new Set(['sale', 'callback_scheduled'])

interface AdvisorWeek {
  name: string
  slackId: string | null
  scored: number
  avgScore: number | null
  byType: Record<string, { n: number; avg: number }>
  dimensionAvgs: Record<string, number>
  weakestDimension: string | null
  bestCall: { type: string | null; outcome: string; score: number; summary: string } | null
  toughestCalls: { score: number; summary: string }[]
  missedBookings: { customer: string; type: string | null; score: number | null; summary: string }[]
  improvements: string[]
  strengths: string[]
}

export interface WeeklyReportResult {
  weekLabel: string
  advisors: number
  callsAnalysed: number
  posted: boolean
  costMicroUsd: number
  // dry-run payload
  narrative?: any
}

async function fetchWeek(days: number): Promise<{ advisors: AdvisorWeek[]; total: number; weekLabel: string }> {
  const c = sb()
  const fromIso = new Date(Date.now() - days * 86400_000).toISOString()

  const { data: calls, error } = await c.from('calls')
    .select('id, call_date, direction, external_number, caller_name, effective_advisor_name, effective_advisor_slack_user_id, agent_name, agent_ext')
    .gte('call_date', fromIso)
    .order('call_date', { ascending: false })
    .limit(1500)
  if (error) throw error
  const callById = new Map((calls || []).map(cl => [cl.id, cl]))
  const ids = (calls || []).map(cl => cl.id)

  const analyses: any[] = []
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await c.from('call_analysis')
      .select('call_id, call_type, outcome, sales_score, dimension_scores, observations, summary')
      .in('call_id', ids.slice(i, i + 200))
    analyses.push(...(data || []))
  }

  const byAdvisor = new Map<string, { slackId: string | null; rows: { call: any; a: any }[] }>()
  for (const a of analyses) {
    const call = callById.get(a.call_id)
    if (!call) continue
    if (a.sales_score == null) continue                       // unscored (not coachable) — skip
    const name = call.effective_advisor_name || call.agent_name || (call.agent_ext ? `Ext ${call.agent_ext}` : null)
    if (!name) continue
    const cur = byAdvisor.get(name) || { slackId: (call.effective_advisor_slack_user_id || null) as string | null, rows: [] as { call: any; a: any }[] }
    cur.slackId = cur.slackId || call.effective_advisor_slack_user_id || null
    cur.rows.push({ call, a })
    byAdvisor.set(name, cur)
  }

  const advisors: AdvisorWeek[] = []
  for (const [name, { slackId, rows }] of Array.from(byAdvisor.entries())) {
    if (rows.length < 2) continue                             // not enough signal to coach on
    const scores = rows.map(r => Number(r.a.sales_score))
    const avg = Math.round(scores.reduce((s, v) => s + v, 0) / scores.length)

    const byType: Record<string, { n: number; avg: number }> = {}
    const dims: Record<string, { sum: number; n: number }> = {}
    const improvements: string[] = []
    const strengths: string[] = []
    const missed: AdvisorWeek['missedBookings'] = []

    for (const { call, a } of rows) {
      const t = a.call_type || 'unclassified'
      byType[t] = byType[t] || { n: 0, avg: 0 }
      byType[t].n++; byType[t].avg += Number(a.sales_score)
      for (const [d, v] of Object.entries(a.dimension_scores || {})) {
        if (typeof v !== 'number') continue
        dims[d] = dims[d] || { sum: 0, n: 0 }; dims[d].sum += v; dims[d].n++
      }
      for (const s of a.observations?.improvements || []) if (s?.trim()) improvements.push(s.trim())
      for (const s of a.observations?.strengths || []) if (s?.trim()) strengths.push(s.trim())

      const closing = a.dimension_scores?.closing
      if (SALES_TYPES.includes(a.call_type) && !BOOKED.has(a.outcome) && typeof closing === 'number' && closing <= 4 && missed.length < 4) {
        missed.push({
          customer: call.caller_name || call.external_number || 'Unknown',
          type: a.call_type, score: a.sales_score, summary: String(a.summary || '').slice(0, 450),
        })
      }
    }
    for (const t of Object.keys(byType)) byType[t].avg = Math.round(byType[t].avg / byType[t].n)

    const dimensionAvgs: Record<string, number> = {}
    let weakest: string | null = null, weakestVal = Infinity
    for (const [d, agg] of Object.entries(dims)) {
      const v = Math.round((agg.sum / agg.n) * 10) / 10
      dimensionAvgs[d] = v
      if (v < weakestVal) { weakestVal = v; weakest = d }
    }

    const sorted = [...rows].sort((x, y) => Number(y.a.sales_score) - Number(x.a.sales_score))
    const best = sorted[0]
    const toughest = sorted.slice(-2).reverse().map(r => ({ score: Number(r.a.sales_score), summary: String(r.a.summary || '').slice(0, 400) }))

    advisors.push({
      name, slackId, scored: rows.length, avgScore: avg, byType, dimensionAvgs, weakestDimension: weakest,
      bestCall: best ? { type: best.a.call_type, outcome: best.a.outcome, score: Number(best.a.sales_score), summary: String(best.a.summary || '').slice(0, 450) } : null,
      toughestCalls: toughest,
      missedBookings: missed,
      improvements: improvements.slice(0, 12),
      strengths: strengths.slice(0, 8),
    })
  }
  advisors.sort((a, b) => b.scored - a.scored)

  const end = new Date()
  const weekLabel = `week ending ${end.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Australia/Brisbane' })}`
  return { advisors, total: analyses.filter(a => a.sales_score != null).length, weekLabel }
}

async function writeNarrative(advisors: AdvisorWeek[], weekLabel: string): Promise<{ parsed: any; costMicroUsd: number }> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set')

  const prompt = `You are the sales coach for Just Autos (Australian 4WD/diesel performance workshop — consultative sales, A-grade clientele). Below is a week of AI-analysed phone-call coaching data per advisor (${weekLabel}). Write the WEEKLY COACHING REPORT.

DATA:
${JSON.stringify(advisors, null, 1)}

Return ONLY this JSON:
{
  "team_summary": "3-4 sentences: how the team performed this week — call volumes, standout performances, the one team-wide theme to work on. Specific, numbers included.",
  "advisors": [
    {
      "name": "<advisor name exactly as given>",
      "coaching_notes": "2-3 sentences of the week's core coaching story for this advisor — what pattern showed up across their calls.",
      "quick_wins": ["1-3 bullet moments worth celebrating — specific calls or behaviours that worked (draw from bestCall + strengths)"],
      "losses": ["0-3 bullets: genuinely missed opportunities — customers who signalled intent (booking/purchase) that wasn't converted (draw from missedBookings). Name the customer and the miss. Empty array if none."],
      "action_items": ["exactly 2-3 concrete, practise-able actions for THIS week — phrased as instructions with example wording where useful"],
      "feedback": "1-2 sentences of direct, encouraging feedback — the tone of a coach who watched every call."
    }
  ]
}

Rules: be specific (cite scores, call types, customer situations from the data — never invent details not present), constructive not harsh, and keep every string Slack-friendly plain text (no markdown headers).`

  const r = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL(), max_tokens: 4000, messages: [{ role: 'user', content: prompt }] }),
  })
  if (!r.ok) throw new Error(`Anthropic API ${r.status}: ${(await r.text()).slice(0, 300)}`)
  const data = await r.json()
  const text = data.content?.[0]?.text || ''
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim()
  const first = cleaned.indexOf('{'); const last = cleaned.lastIndexOf('}')
  const parsed = JSON.parse(first >= 0 && last > first ? cleaned.slice(first, last + 1) : cleaned)
  const costMicroUsd = Math.round(((data.usage?.input_tokens || 0) / 1e6) * 3_000_000 + ((data.usage?.output_tokens || 0) / 1e6) * 15_000_000)
  return { parsed, costMicroUsd }
}

function advisorBlocks(week: AdvisorWeek, n: any): any[] {
  const mention = week.slackId ? `<@${week.slackId}>` : `*${week.name}*`
  const typeBits = Object.entries(week.byType).map(([t, s]) => `${callTypeLabel(t) || t} ${s.n} (avg ${s.avg})`).join(' · ')
  const blocks: any[] = [
    { type: 'header', text: { type: 'plain_text', text: `${week.name} — avg ${week.avgScore}/100 over ${week.scored} calls`, emoji: true } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `${typeBits}${week.weakestDimension ? ` · focus area: *${dimensionLabel(week.weakestDimension)}*` : ''}` }] },
    { type: 'section', text: { type: 'mrkdwn', text: `${mention} ${n.coaching_notes || ''}`.slice(0, 2900) } },
  ]
  const list = (items: string[], icon: string) => items.map(s => `${icon} ${s}`).join('\n')
  if (n.quick_wins?.length) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*Quick wins*\n${list(n.quick_wins, '🏆')}`.slice(0, 2900) } })
  if (n.losses?.length) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*Missed opportunities*\n${list(n.losses, '⚠️')}`.slice(0, 2900) } })
  if (n.action_items?.length) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*This week's actions*\n${n.action_items.map((s: string, i: number) => `${i + 1}. ${s}`).join('\n')}`.slice(0, 2900) } })
  if (n.feedback) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `💬 ${n.feedback}`.slice(0, 2900) }] })
  return blocks
}

export async function runWeeklyReport(opts: { dryRun?: boolean; days?: number } = {}): Promise<WeeklyReportResult> {
  const days = Math.max(3, Math.min(Number(opts.days) || 7, 31))
  const { advisors, total, weekLabel } = await fetchWeek(days)
  if (!advisors.length) return { weekLabel, advisors: 0, callsAnalysed: total, posted: false, costMicroUsd: 0 }

  const { parsed, costMicroUsd } = await writeNarrative(advisors, weekLabel)
  if (opts.dryRun) return { weekLabel, advisors: advisors.length, callsAnalysed: total, posted: false, costMicroUsd, narrative: parsed }

  const channel = CHANNEL()
  const headerText = `📊 Weekly Sales Coaching Report — ${weekLabel}`
  const main = await postMessage({
    channel,
    text: headerText,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: headerText, emoji: true } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `${total} calls coached across ${advisors.length} advisors · full breakdowns in this thread 🧵` }] },
      { type: 'section', text: { type: 'mrkdwn', text: `*Team overview*\n${parsed.team_summary || ''}`.slice(0, 2900) } },
    ],
  })
  if (!main) throw new Error('Slack post failed (is the bot in the coaching channel?)')

  for (const week of advisors) {
    const n = (parsed.advisors || []).find((x: any) => x.name === week.name) || {}
    try {
      await postMessage({ channel, thread_ts: main.ts, text: `${week.name} — weekly coaching`, blocks: advisorBlocks(week, n) })
    } catch (e: any) {
      console.error(`[weekly-report] advisor post failed for ${week.name}:`, e?.message || e)
    }
  }

  return { weekLabel, advisors: advisors.length, callsAnalysed: total, posted: true, costMicroUsd }
}
