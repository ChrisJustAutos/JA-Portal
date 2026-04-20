// pages/api/reports/generate.ts
// Generates a report bundle: raw data + AI-generated narrative.
// The client then renders it to HTML (for printing) and XLSX (for download).

import type { NextApiRequest, NextApiResponse } from 'next'
import { requireAuth } from '../../../lib/auth'
import { buildReportData, type SectionKey, type ReportData } from '../../../lib/reportData'

export interface Narrative {
  executiveSummary: string       // 2-3 paragraphs
  perSection: Record<string, string>   // section key -> commentary
  callouts: string[]              // bullet-point narrative hits
  recommendations: string[]       // action items
}

export interface ReportBundle {
  id: string                      // short random id, used for /reports/view/[id]
  data: ReportData
  narrative: Narrative
  meta: {
    generatedAt: string
    startDate: string
    endDate: string
    sections: SectionKey[]
  }
}

export const config = {
  api: { responseLimit: false },
  maxDuration: 60,
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  await requireAuth(req, res, async () => {
    try {
      const body = req.body as { startDate?: string; endDate?: string; sections?: SectionKey[] }
      const startDate = body.startDate || defaultStart()
      const endDate = body.endDate || defaultEnd()
      const sections: SectionKey[] = (body.sections && body.sections.length > 0) ? body.sections as SectionKey[] : ['overview']

      // 1. Build data slice
      const data = await buildReportData({ startDate, endDate, sections })

      // 2. Call Claude for narrative
      const narrative = await generateNarrative(data, sections)

      // 3. Bundle
      const bundle: ReportBundle = {
        id: shortId(),
        data,
        narrative,
        meta: {
          generatedAt: new Date().toISOString(),
          startDate, endDate, sections,
        },
      }

      res.status(200).json(bundle)
    } catch (err: any) {
      console.error('reports/generate error:', err)
      res.status(500).json({ error: 'report_generation_failed', message: String(err?.message || err) })
    }
  })
}

function defaultStart(): string {
  const d = new Date(); d.setDate(1)
  return d.toISOString().slice(0, 10)
}
function defaultEnd(): string {
  return new Date().toISOString().slice(0, 10)
}
function shortId(): string {
  return Math.random().toString(36).substring(2, 10) + Date.now().toString(36).slice(-4)
}

// ─────────────────────────────────────────────────────────────
// Claude narrative generation
// ─────────────────────────────────────────────────────────────

async function generateNarrative(data: ReportData, sections: SectionKey[]): Promise<Narrative> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    // Graceful fallback if no API key — return a minimal structural narrative
    return fallbackNarrative(data, sections)
  }

  const prompt = buildPrompt(data, sections)

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 2500,
        messages: [{ role: 'user', content: prompt }],
      }),
    })
    if (!r.ok) {
      const errText = await r.text().catch(() => '')
      console.error('Claude API error:', r.status, errText)
      return fallbackNarrative(data, sections)
    }
    const resp = await r.json()
    const text = resp.content?.[0]?.text || ''
    return parseNarrative(text, sections)
  } catch (err) {
    console.error('Claude call failed:', err)
    return fallbackNarrative(data, sections)
  }
}

function buildPrompt(d: ReportData, sections: SectionKey[]): string {
  const { context } = d
  let p = `You are writing a business report for Just Autos — an Australian automotive business operating two entities: JAWS (wholesale/distribution, 14 Australian distributors) and VPS (single-site workshop). The report covers the period ${context.startDate} to ${context.endDate}.

Below is the raw data. Produce a JSON response with this exact structure (no markdown, no preamble, just the JSON object):

{
  "executiveSummary": "2-3 short paragraphs covering the headline story of the period — what changed, what stands out, what matters",
  "perSection": {
    ${sections.map(s => `"${s}": "paragraph of commentary for this section"`).join(',\n    ')}
  },
  "callouts": ["narrative callout 1", "narrative callout 2", "..."],
  "recommendations": ["actionable recommendation 1", "actionable recommendation 2", "..."]
}

Write for an internal audience (operations manager + directors). Reference specific dollar amounts, customer/supplier names, invoice numbers where relevant. Use Australian spelling and currency conventions ($ = AUD).

Be direct, concise, and substantive. Don't hedge. If something is bad, say so.

Include 3-5 callouts (specific data observations — "Peely's owes $13k on invoice JAWS-1117, aged 14 days")
Include 3-5 recommendations (concrete actions — "Chase Peely's for immediate payment; largest outstanding invoice in the period")

DATA:
`

  if (d.jaws) {
    p += `
JAWS WHOLESALE
- Income: $${fmt(d.jaws.income)} | COS: $${fmt(d.jaws.cos)} | Net: $${fmt(d.jaws.net)} | Margin: ${(d.jaws.netMargin*100).toFixed(1)}%
- Open receivables: ${d.jaws.openCount} invoices, $${fmt(d.jaws.openTotal)} owed
- Stock on hand: $${fmt(d.jaws.stockValue)} across ${d.jaws.stockSkuCount} SKUs
- Open bills payable: ${d.jaws.openBills?.length ?? 0}, $${fmt(d.jaws.billsTotal ?? 0)}
- Top 10 customers by revenue this period: ${d.jaws.topCustomers.slice(0,10).map(c => `${c.name} $${fmt(c.revenue)} (${c.invoiceCount}inv)`).join('; ')}
- Top 5 open invoices (ranked by balance owed): ${d.jaws.openInvoices.slice(0,5).map((i:any) => `${i.Number} ${i.CustomerName} $${fmt(Number(i.BalanceDueAmount)||0)}`).join('; ')}
- Top income accounts: ${d.jaws.pnlIncome.slice(0,5).map(r => `${r.name} $${fmt(r.total)}`).join('; ')}
- Top COS accounts: ${d.jaws.pnlCos.slice(0,5).map(r => `${r.name} $${fmt(r.total)}`).join('; ')}`
    if (d.jaws.openOrders && d.jaws.openOrders.length > 0) {
      p += `
- Open orders (not yet invoiced): ${d.jaws.openOrders.length} orders, $${fmt(d.jaws.openOrdersTotal||0)}, ${d.jaws.openOrdersPrepaid} prepaid awaiting fulfilment
- Converted to invoice last 30d: ${d.jaws.convertedOrders30d} orders, $${fmt(d.jaws.convertedTotal30d||0)}`
    }
  }

  if (d.vps) {
    p += `

VPS WORKSHOP
- Income: $${fmt(d.vps.income)} | COS: $${fmt(d.vps.cos)} | Overheads: $${fmt(d.vps.overheads)} | Net: $${fmt(d.vps.net)} | Gross margin: ${(d.vps.grossMargin*100).toFixed(1)}%
- Open receivables: ${d.vps.openCount} invoices, $${fmt(d.vps.openTotal)} owed
- Open bills payable: ${d.vps.openBills?.length ?? 0}, $${fmt(d.vps.billsTotal ?? 0)}
- Top 10 customers by revenue: ${d.vps.topCustomers.slice(0,10).map(c => `${c.name} $${fmt(c.revenue)} (${c.invoiceCount}inv)`).join('; ')}
- Top income accounts: ${d.vps.pnlIncome.slice(0,5).map(r => `${r.name} $${fmt(r.total)}`).join('; ')}
- Top overheads: ${d.vps.pnlOverheads.slice(0,5).map(r => `${r.name} $${fmt(r.total)}`).join('; ')}`
  }

  if (d.distributors) {
    p += `

DISTRIBUTORS (JAWS network)
- ${d.distributors.count} distributors generated $${fmt(d.distributors.totalRevenue)} combined this period
- Average per distributor: $${fmt(d.distributors.avgRevenue)}
- Top 10: ${d.distributors.rows.slice(0,10).map(d => `${d.name} $${fmt(d.revenue)} (${d.invoiceCount}inv)`).join('; ')}`
  }

  if (d.inventory) {
    p += `

INVENTORY (JAWS)
- ${d.inventory.totalSkus} active SKUs, ${d.inventory.qtyOnHand} units on hand, $${fmt(d.inventory.stockValue)} held value
- Low stock / reorder needed: ${d.inventory.lowStockCount} below level + ${d.inventory.outOfStockCount} out of stock = ${d.inventory.reorderSuggestCount} items needing restock at ~$${fmt(d.inventory.reorderSuggestValue)}
- Dead stock (90d+ no sales): ${d.inventory.deadStock90dCount} items holding $${fmt(d.inventory.deadStock90dValue)}
- Top 5 by held value: ${d.inventory.topHeldByValue.slice(0,5).map(i => `${i.name} (${i.number}) $${fmt(i.value)} — ${i.qtyOnHand} on hand, ${i.daysOfCover==null?'no sales data':Math.round(i.daysOfCover)+'d cover'}`).join('; ')}
- Most urgent reorders: ${d.inventory.reorderNeeded.slice(0,5).map(i => `${i.name} (${i.number}) ${i.qtyOnHand} on hand, ${i.daysOfCover==null?'unknown':Math.round(i.daysOfCover)+'d'} cover`).join('; ')}`
  }

  p += `

Now generate the JSON response. Output ONLY the JSON object, no markdown fences, no prose before or after.`

  return p
}

function parseNarrative(text: string, sections: SectionKey[]): Narrative {
  // Claude sometimes wraps in ```json fences despite instructions; strip them
  const clean = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim()
  try {
    const parsed = JSON.parse(clean)
    return {
      executiveSummary: String(parsed.executiveSummary || ''),
      perSection: parsed.perSection || {},
      callouts: Array.isArray(parsed.callouts) ? parsed.callouts.map(String) : [],
      recommendations: Array.isArray(parsed.recommendations) ? parsed.recommendations.map(String) : [],
    }
  } catch (err) {
    console.error('Failed to parse Claude JSON:', err, 'Raw:', text.slice(0, 500))
    return {
      executiveSummary: text.slice(0, 800),
      perSection: Object.fromEntries(sections.map(s => [s, ''])),
      callouts: [],
      recommendations: ['AI narrative parsing failed — raw output captured in executive summary above. Try regenerating the report.'],
    }
  }
}

function fallbackNarrative(d: ReportData, sections: SectionKey[]): Narrative {
  const parts: string[] = []
  if (d.jaws) parts.push(`JAWS: $${fmt(d.jaws.income)} income, $${fmt(d.jaws.net)} net (${(d.jaws.netMargin*100).toFixed(1)}% margin), $${fmt(d.jaws.openTotal)} in ${d.jaws.openCount} open receivables.`)
  if (d.vps) parts.push(`VPS: $${fmt(d.vps.income)} income, $${fmt(d.vps.net)} net, $${fmt(d.vps.openTotal)} in ${d.vps.openCount} open receivables.`)
  return {
    executiveSummary: parts.join(' ') || 'No data in selected period.',
    perSection: Object.fromEntries(sections.map(s => [s, 'AI narrative unavailable — ANTHROPIC_API_KEY not configured.'])),
    callouts: [],
    recommendations: ['Configure ANTHROPIC_API_KEY on Vercel to enable AI narrative generation.'],
  }
}

function fmt(n: number): string {
  return Math.round(n).toLocaleString('en-AU')
}
