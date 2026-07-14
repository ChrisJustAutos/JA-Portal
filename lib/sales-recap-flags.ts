// lib/sales-recap-flags.ts
// LLM "Key Flags & Watch Items" (Section 6) — a short analyst read over the
// already-computed recap numbers. Returns [] on any failure; the assembler
// then uses its deterministic rule-based fallback.

import type { FlagOut, SalesRecap } from './sales-recap'

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'
const MODEL = process.env.CALLS_ANALYSIS_MODEL || 'claude-sonnet-4-6'

export async function generateFlags(numbers: Pick<SalesRecap, 'week' | 'dailyTarget' | 'weekTotal' | 'rolling' | 'monthly' | 'forecast'>): Promise<FlagOut[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return []
  const prompt = `You are a sales analyst for Just Autos (a 4x4 workshop). Below are this week's ORDER/BOOKING figures (not invoiced turnover). Write 3-6 short "watch items" a manager should see. Each is one plain sentence with the specific numbers. Prioritise: HIGH = material decline / risk needing action; MED = notable but not urgent; INFO = positive or neutral context. Be specific and quantitative. No preamble.

Daily target: $${numbers.dailyTarget}.
Recap week (${numbers.week.start}..${numbers.week.end}) total $${numbers.weekTotal.total}, avg $${numbers.weekTotal.dailyAvg}/day over ${numbers.weekTotal.tradingDaysWithData} day(s) with data.
Rolling 4 weeks (newest first): ${numbers.rolling.map(r => `${r.label} $${r.total} (avg $${r.dailyAvg}/d)`).join('; ')}.
Monthly YTD: ${numbers.monthly.map(m => `${m.month} $${m.total}`).join('; ')}.
Forecast: ${numbers.forecast.map(f => `${f.label} $${f.value}`).join('; ') || 'none'}.

Respond ONLY with JSON: {"flags":[{"priority":"HIGH|MED|INFO","item":"..."}]}`
  try {
    const r = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: 900, messages: [{ role: 'user', content: prompt }] }),
    })
    if (!r.ok) return []
    const data = await r.json()
    const text = data.content?.[0]?.text || ''
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim()
    const first = cleaned.indexOf('{'); const last = cleaned.lastIndexOf('}')
    const parsed = JSON.parse(first >= 0 ? cleaned.slice(first, last + 1) : cleaned)
    const flags: FlagOut[] = (Array.isArray(parsed?.flags) ? parsed.flags : [])
      .filter((f: any) => f?.item && ['HIGH', 'MED', 'INFO'].includes(f.priority))
      .map((f: any) => ({ priority: f.priority, item: String(f.item).slice(0, 300) }))
    return flags
  } catch { return [] }
}
