// pages/api/calls/insights/summary.ts
// On-demand Claude narratives for the Calls insight tabs. Triggered by the
// "Generate" button on the Coaching / Words&Objections / Sentiment tabs so we
// only spend tokens when a human asks. Pure aggregates (numbers, word counts)
// come from ./insights.ts and need no AI.
//
// POST body: { startDate, endDate, agent, kind: 'coaching' | 'why_no_booking' | 'sentiment' }

import type { NextApiRequest, NextApiResponse } from 'next'
import { requireAuth } from '../../../../lib/auth'
import {
  makeServiceClient, fetchInsightDataset,
  computeCoaching, computeObjections, computeConversion, computeSentiment,
} from '../../../../lib/calls-insights'

export const config = { maxDuration: 60 }

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || ''
const MODEL = 'claude-sonnet-4-6'

async function callClaude(system: string, user: string, maxTokens = 1400): Promise<string> {
  if (!ANTHROPIC_API_KEY) return ''
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
    })
    if (!resp.ok) {
      console.error('insights summary claude failed:', resp.status, (await resp.text().catch(() => '')).slice(0, 200))
      return ''
    }
    const data = await resp.json()
    return data.content?.find((b: any) => b.type === 'text')?.text || ''
  } catch (e: any) {
    console.error('insights summary claude threw:', e?.message)
    return ''
  }
}

function extractJson(text: string): any | null {
  if (!text) return null
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const raw = fenced ? fenced[1] : text
  const start = raw.search(/[[{]/)
  if (start === -1) return null
  try { return JSON.parse(raw.slice(start)) } catch { return null }
}

const BIZ = `Just Autos — an Australian diesel-performance workshop & wholesaler (VPS workshop + JAWS wholesale). Common topics: DPF/EGR/emissions, tuning/remap, turbos, injectors, warranty, pricing, bookings.`

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  return requireAuth(req, res, async () => {
    try {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
      const { startDate = null, endDate = null, agent = null, kind } = req.body || {}
      if (!['coaching', 'why_no_booking', 'sentiment'].includes(kind)) {
        return res.status(400).json({ error: 'Invalid kind' })
      }
      if (!ANTHROPIC_API_KEY) {
        return res.status(200).json({ available: false, message: 'AI summaries unavailable — ANTHROPIC_API_KEY is not set on the portal.' })
      }

      const sb = makeServiceClient()
      const { dataset } = await fetchInsightDataset(sb, { startDate, endDate, agent })
      const { calls, analyses } = dataset

      if (analyses.length === 0) {
        return res.status(200).json({ available: true, empty: true, message: 'No analysed calls in this range yet — transcribe & analyse some calls first.' })
      }

      // ── Coaching tips per advisor ─────────────────────────────────────
      if (kind === 'coaching') {
        const coaching = computeCoaching(calls, analyses)
          .filter(a => a.analysed >= 2)
          .slice(0, 8)
          .map(a => ({
            advisor: a.advisor,
            analysed: a.analysed,
            avgSalesScore: a.avgSalesScore,
            weakestDimension: a.weakestDimension,
            dimensionAvgs: a.dimensionAvgs,
            // cap improvement notes fed to the model
            improvements: a.improvementsRaw.slice(0, 40),
          }))
        if (coaching.length === 0) {
          return res.status(200).json({ available: true, empty: true, message: 'Not enough analysed calls per advisor to coach yet.' })
        }
        const system = `You are a sales coach for ${BIZ}\nYou turn recurring AI call-review notes into concrete, kind, actionable coaching tips per advisor.\nReturn ONLY JSON: {"advisors":[{"advisor":"<name>","headline":"<one line summary of their focus area>","tips":["<tip>", ...]}]}\nEach advisor: 3-5 tips, each a single specific sentence (max 22 words) the advisor can act on next call. Base tips on their recurring improvement notes and weakest dimension. No preamble.`
        const text = await callClaude(system, JSON.stringify({ advisors: coaching }), 1800)
        const parsed = extractJson(text)
        return res.status(200).json({ available: true, kind, advisors: parsed?.advisors || [], raw: parsed ? undefined : text })
      }

      // ── Why people don't book in ──────────────────────────────────────
      if (kind === 'why_no_booking') {
        const objections = computeObjections(analyses)
        const conv = computeConversion(calls, analyses)
        const nonBookingSummaries = analyses
          .filter(a => a.outcome === 'no_outcome' || a.outcome === 'information_only' || a.outcome === 'quote_given')
          .slice(0, 60)
          .map(a => a.summary)
          .filter(Boolean)
        const payload = {
          outcomeCounts: conv.outcomeCounts,
          topObjections: objections.top.slice(0, 25),
          sampleCallSummaries: nonBookingSummaries,
        }
        const system = `You are a sales analyst for ${BIZ}\nFrom the AI call data below, explain WHY callers are not booking in. Output GitHub-flavoured markdown:\n- A 2-3 sentence overview.\n- "### Top reasons callers don't book" with 4-7 bullets, each a reason + rough how-often + a one-line fix.\n- "### Quick wins" with 2-3 bullets the team can action this week.\nBe specific to the data. No fluff, no preamble.`
        const text = await callClaude(system, JSON.stringify(payload), 1400)
        return res.status(200).json({ available: true, kind, markdown: text || 'Could not generate a summary.' })
      }

      // ── Sentiment narrative ───────────────────────────────────────────
      const sentiment = computeSentiment(calls, analyses)
      const system = `You are an analyst for ${BIZ}\nWrite a short GitHub-flavoured markdown read on customer sentiment from the derived data below (scores 0-100; >=65 positive, 40-64 neutral, <40 negative). 2-4 short paragraphs or bullets: overall mood, any advisor or trend standouts, and one watch-out. Note the score is derived from rapport + outcome + objections, so it's directional not exact. No preamble.`
      const text = await callClaude(system, JSON.stringify({
        overall: sentiment.overall, avgScore: sentiment.avgScore,
        byAdvisor: sentiment.byAdvisor, trend: sentiment.trend,
      }), 900)
      return res.status(200).json({ available: true, kind, markdown: text || 'Could not generate a summary.' })
    } catch (e: any) {
      console.error('insights summary error:', e?.message, e?.stack)
      return res.status(500).json({ error: 'Internal error', message: e?.message || String(e) })
    }
  })
}
