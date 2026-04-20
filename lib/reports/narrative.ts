// lib/reports/narrative.ts
// SERVER-ONLY. Uses the Anthropic API to generate report narrative.
//
// Two modes:
//  1. section-specific: generates 2-4 insight bullets for a single section
//  2. overall narrative: weaves the whole report into an executive-style summary

import type { GeneratedSection, ReportConfig } from './spec'
import type { ReportType } from '../permissions'
import { REPORT_TYPE_LABELS } from '../permissions'

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || ''
const MODEL = 'claude-sonnet-4-6'

async function callClaude(system: string, user: string, maxTokens = 600): Promise<string> {
  if (!ANTHROPIC_API_KEY) return ''
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: user }],
      }),
    })
    if (!resp.ok) {
      const err = await resp.text().catch(() => '')
      console.error('Narrative call failed:', resp.status, err.slice(0, 200))
      return ''
    }
    const data = await resp.json()
    return data.content?.find((b: any) => b.type === 'text')?.text || ''
  } catch (err: any) {
    console.error('Narrative call threw:', err.message)
    return ''
  }
}

// ── Section-specific commentary ──────────────────────────────────────
// Parses Claude's response into bullet points (3-4 short insights).

const SECTION_SYSTEM = `You are a commercial analyst writing concise, factual insights for a management report about Just Autos (JAWS wholesale + VPS workshop, Australian automotive business).

RULES:
- Output ONLY 2-4 bullet points prefixed with "• " — nothing else.
- Each bullet: one clear sentence, max 25 words.
- All amounts are ex-GST in AUD. Use $ symbol and k/M suffixes (e.g. $142k, $1.2M).
- Point out what matters: outliers, risks, concentration, trends.
- NO preamble, NO "here are the insights", NO closing remarks. Just bullets.
- If the data is empty or uninformative, output a single bullet stating that.`

export async function generateSectionInsights(
  sectionLabel: string,
  data: any,
): Promise<string[]> {
  const dataJson = JSON.stringify(data, null, 2).slice(0, 4000)
  const user = `Section: ${sectionLabel}\n\nData:\n${dataJson}\n\nWrite 2-4 insight bullets.`
  const reply = await callClaude(SECTION_SYSTEM, user, 400)
  if (!reply) return []
  // Extract bullets starting with • or -
  return reply
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('•') || l.startsWith('-'))
    .map(l => l.replace(/^[•\-]\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 4)
}

// ── Overall report narrative ─────────────────────────────────────────
// This is the main AI-written commentary — typically 2-3 paragraphs woven
// across the whole report.

const OVERALL_SYSTEM = `You are writing the AI-authored narrative for a management report about Just Autos (two entities: JAWS wholesale and VPS workshop). The reader is an executive (CEO/GM).

Write in a clear, confident, analytical tone — not corporate fluff. Structure:

PARAGRAPH 1 — Headline: what's the most important 1-2 things going on?
PARAGRAPH 2 — Drill-down: explain the key numbers, flag risks or opportunities.
PARAGRAPH 3 (optional) — Forward-looking: what to watch / act on next.

RULES:
- Australian English, AUD.
- Amounts are ex-GST. Use $ and k/M (e.g. $142k, $1.2M, $51,233).
- NO bullet lists in the narrative — flowing prose only.
- Quote specific numbers where relevant — don't hedge.
- Keep it under 400 words total.
- Don't start with "This report shows..." or "Based on..." — go straight to the insight.`

export async function generateOverallNarrative(
  config: ReportConfig,
  sections: GeneratedSection[],
): Promise<string> {
  // Build a compact JSON summary of all sections so Claude has the picture.
  const summary = sections.map(s => ({
    section: s.label,
    data: s.data,
  }))
  const summaryJson = JSON.stringify(summary, null, 2).slice(0, 10000)

  const dateRange = `${config.periodStart} → ${config.periodEnd}`
  const entitiesLabel = config.entities.join(' + ')
  const user = `Report type: ${REPORT_TYPE_LABELS[config.type]}
Period: ${dateRange}
Entities: ${entitiesLabel}

Section data (condensed):
${summaryJson}

Write the narrative now (2-3 paragraphs).`

  return (await callClaude(OVERALL_SYSTEM, user, 800)).trim()
}
