// lib/quote-extraction.ts
// Claude-powered PDF parser for Mechanics Desk quote emails (Pipeline A).
//
// Mechanics Desk sends a quote PDF as an email attachment whenever a rep
// generates a quote. The PDF format is consistent (template-driven), but
// extracting structured data via PDF text parsing alone is fragile —
// layouts shift slightly between MD versions, and rep notes in the
// transcript area sometimes spill into other extracted regions.
//
// Solution: pass the PDF base64 directly to Claude as a document attachment
// and ask for structured JSON. Claude handles MD's layout reliably, returns
// the same fields regardless of minor template drift, and gives us a tight
// validation surface (single JSON object).
//
// COST: each extraction is one Anthropic API call. Haiku 4.5 with a typical
// 1-2 page MD quote PDF is ~$0.005-0.02 per call. Pipeline A sees one of
// these per quote-emailed-to-rep, low single-digit per hour at most.
//
// REJECT vs RETURN: a quote PDF without a parseable customer.email is
// considered un-actionable (we can't upsert the AC contact reliably), so
// we throw. Worker treats throws as "failed" → ends up in quote_events
// for ops review. Phone is allowed missing — we just can't do call-context
// or Monday match.

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001'

export interface ExtractedQuoteLineItem {
  description: string
  quantity: number | null
  unitPriceExGst: number | null
  totalExGst: number | null
}

export interface ExtractedQuote {
  customer: {
    email: string                  // Required — see REJECT note above
    phone: string | null
    name: string | null            // Full name as one string
    firstName: string | null
    lastName: string | null
    postcode: string | null
  }
  vehicle: {
    rego: string | null            // Number plate
    makeModel: string | null       // e.g. "2022 Toyota LandCruiser 300 Series"
    year: number | null
  }
  quote: {
    number: string                 // The MD quote ID — required for Monday updates feed
    issuedDate: string | null      // ISO date (YYYY-MM-DD) if found on the PDF
    totalExGst: number | null
    totalIncGst: number | null
    gstAmount: number | null
    lineItems: ExtractedQuoteLineItem[]
  }
}

export interface ExtractionResult {
  quote: ExtractedQuote
  model: string
  inputTokens: number
  outputTokens: number
  costMicroUsd: number
}

/**
 * Parse a Mechanics Desk quote PDF using Claude.
 *
 * @param pdfBase64  Base64-encoded PDF bytes (no `data:` prefix)
 * @returns          Validated structured fields + token/cost telemetry
 * @throws           If the API call fails OR if customer.email is missing
 *                   (we can't proceed reliably without it).
 */
export async function extractQuoteFromPdf(pdfBase64: string): Promise<ExtractionResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured')

  const model = process.env.QUOTE_EXTRACTION_MODEL
    || process.env.FOLLOWUP_MODEL                  // share model env with follow-up if set
    || DEFAULT_MODEL

  const body = {
    model,
    max_tokens: 2048,                              // line items can be long; give margin
    system: buildSystemPrompt(),
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 },
          },
          {
            type: 'text',
            text: 'Extract the quote details as JSON per the system instructions. Output ONLY the JSON object.',
          },
        ],
      },
    ],
  }

  const r = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  })

  if (!r.ok) {
    const errText = await r.text()
    throw new Error(`Anthropic API ${r.status} on quote extraction: ${errText.substring(0, 500)}`)
  }

  const data = await r.json()
  const text = data.content?.[0]?.text || ''
  const raw = extractJson(text)
  const quote = validateAndNormalise(raw)

  const inputTokens = data.usage?.input_tokens ?? 0
  const outputTokens = data.usage?.output_tokens ?? 0
  const inputCostPerMTok = Number(process.env.FOLLOWUP_COST_INPUT_MICRO || 1_000_000)
  const outputCostPerMTok = Number(process.env.FOLLOWUP_COST_OUTPUT_MICRO || 5_000_000)
  const costMicroUsd =
    Math.round((inputTokens / 1_000_000) * inputCostPerMTok) +
    Math.round((outputTokens / 1_000_000) * outputCostPerMTok)

  return { quote, model, inputTokens, outputTokens, costMicroUsd }
}

// ── Prompt ──────────────────────────────────────────────────────────────

function buildSystemPrompt(): string {
  return `You are extracting structured data from a Mechanics Desk quote PDF for Just Autos, an Australian automotive performance and tuning workshop.

The PDF is generated by Mechanics Desk software and follows a consistent template: customer details near the top, a vehicle block, line items in a table, and totals at the bottom. The quote number is shown prominently (often labelled "Quote #" or "Quote No.").

Output ONLY a JSON object with this exact shape:

{
  "customer": {
    "email":     "REQUIRED. The customer's email address as shown on the PDF. Lowercase. If you cannot find a clear email, return the string 'MISSING' (we will reject the extraction downstream).",
    "phone":     "The customer's phone number as shown, OR null if not present. Keep the original format (e.g. '0412 345 678' or '+61 412 345 678'). Don't reformat.",
    "name":      "Full name as one string, OR null if not on the PDF (e.g. 'Mark Stevens').",
    "firstName": "First name extracted from the full name, OR null.",
    "lastName":  "Last name extracted from the full name, OR null. If the customer is a business, put the business name here and set firstName to null.",
    "postcode":  "Australian 4-digit postcode if shown in the address, OR null."
  },
  "vehicle": {
    "rego":      "Number plate / registration as shown, OR null.",
    "makeModel": "Make and model in one string, including year if shown (e.g. '2022 Toyota LandCruiser 300 Series', 'Ford Ranger PX3'). Null if no vehicle.",
    "year":      "Vehicle year as an integer, OR null. Only if explicitly shown."
  },
  "quote": {
    "number":      "REQUIRED. The quote number as shown on the PDF (string, even if numeric). Common labels: 'Quote #', 'Quote No.', 'Quote ID'.",
    "issuedDate":  "Date the quote was issued in ISO format (YYYY-MM-DD), OR null if not found. Convert from local format if needed (DD/MM/YYYY → YYYY-MM-DD).",
    "totalExGst":  "Sub-total before GST as a NUMBER (no $, no commas), OR null.",
    "totalIncGst": "Total including GST as a NUMBER, OR null. This is the most important number — what the customer pays.",
    "gstAmount":   "GST line as a NUMBER, OR null.",
    "lineItems":   [
      {
        "description":     "Line item description as shown.",
        "quantity":        "Quantity as a number, OR null.",
        "unitPriceExGst":  "Unit price ex-GST as a number, OR null.",
        "totalExGst":      "Line total ex-GST as a number, OR null."
      }
    ]
  }
}

Rules:
- Output ONLY the JSON. No preamble, no markdown fences, no commentary.
- Use the JSON null literal (not the string 'null') for missing values.
- All money fields are NUMBERS, not strings. Strip currency symbols, commas, and spaces.
- For email: only return values that look like real email addresses (have @ and a domain). If unsure, return 'MISSING'.
- For postcode: Australian postcodes are 4 digits. Don't return state/suburb in this field.
- Don't invent details. If a field isn't visible on the PDF, return null (or 'MISSING' for email).
- Line items: include ALL items shown, in order. If the PDF has fewer than 1 line item, return an empty array [].
- For makeModel and lineItems: preserve the original wording where possible.`
}

// ── Output parsing ──────────────────────────────────────────────────────

function extractJson(text: string): any {
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim()

  try {
    return JSON.parse(cleaned)
  } catch {
    const first = cleaned.indexOf('{')
    const last = cleaned.lastIndexOf('}')
    if (first >= 0 && last > first) {
      return JSON.parse(cleaned.substring(first, last + 1))
    }
    throw new Error(`Could not parse JSON from quote-extraction model output: ${cleaned.substring(0, 200)}`)
  }
}

// ── Validation + normalisation ──────────────────────────────────────────

function validateAndNormalise(raw: any): ExtractedQuote {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Quote extraction: model output is not an object')
  }

  const customer = raw.customer
  if (!customer || typeof customer !== 'object') {
    throw new Error('Quote extraction: customer block missing')
  }

  // Email is required. The model is instructed to return 'MISSING' when
  // it can't find one — we treat that as an error (Pipeline A can't
  // upsert reliably without an email match key).
  const rawEmail = typeof customer.email === 'string' ? customer.email.trim() : ''
  if (!rawEmail || rawEmail.toUpperCase() === 'MISSING' || !rawEmail.includes('@') || !rawEmail.includes('.')) {
    throw new Error(`Quote extraction: customer email missing or invalid (got '${rawEmail}')`)
  }

  const quote = raw.quote
  if (!quote || typeof quote !== 'object') {
    throw new Error('Quote extraction: quote block missing')
  }
  if (!quote.number || typeof quote.number !== 'string' || !quote.number.trim()) {
    throw new Error('Quote extraction: quote.number missing')
  }

  const vehicle = raw.vehicle || {}

  return {
    customer: {
      email:     rawEmail.toLowerCase(),
      phone:     nullableString(customer.phone),
      name:      nullableString(customer.name),
      firstName: nullableString(customer.firstName),
      lastName:  nullableString(customer.lastName),
      postcode:  nullablePostcode(customer.postcode),
    },
    vehicle: {
      rego:      nullableString(vehicle.rego),
      makeModel: nullableString(vehicle.makeModel),
      year:      nullableInt(vehicle.year),
    },
    quote: {
      number:      String(quote.number).trim(),
      issuedDate:  nullableIsoDate(quote.issuedDate),
      totalExGst:  nullableNumber(quote.totalExGst),
      totalIncGst: nullableNumber(quote.totalIncGst),
      gstAmount:   nullableNumber(quote.gstAmount),
      lineItems:   normaliseLineItems(quote.lineItems),
    },
  }
}

function nullableString(v: any): string | null {
  if (v === null || v === undefined) return null
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t ? t : null
}

function nullableNumber(v: any): number | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string') {
    const cleaned = v.replace(/[^\d.\-]/g, '')
    if (!cleaned) return null
    const n = Number(cleaned)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function nullableInt(v: any): number | null {
  const n = nullableNumber(v)
  if (n === null) return null
  return Math.round(n)
}

function nullablePostcode(v: any): string | null {
  const s = nullableString(v)
  if (!s) return null
  // AU postcodes are exactly 4 digits.
  const match = s.match(/\b(\d{4})\b/)
  return match ? match[1] : null
}

function nullableIsoDate(v: any): string | null {
  const s = nullableString(v)
  if (!s) return null
  // Accept already-ISO YYYY-MM-DD and common DD/MM/YYYY forms.
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  const dmy = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/)
  if (dmy) {
    const day = dmy[1].padStart(2, '0')
    const month = dmy[2].padStart(2, '0')
    let year = dmy[3]
    if (year.length === 2) year = (Number(year) > 50 ? '19' : '20') + year
    return `${year}-${month}-${day}`
  }
  // Fallback: try Date parsing.
  const d = new Date(s)
  if (!isNaN(d.getTime())) {
    return d.toISOString().substring(0, 10)
  }
  return null
}

function normaliseLineItems(raw: any): ExtractedQuoteLineItem[] {
  if (!Array.isArray(raw)) return []
  const items: ExtractedQuoteLineItem[] = []
  for (const it of raw) {
    if (!it || typeof it !== 'object') continue
    const description = nullableString(it.description)
    if (!description) continue
    items.push({
      description,
      quantity: nullableNumber(it.quantity),
      unitPriceExGst: nullableNumber(it.unitPriceExGst),
      totalExGst: nullableNumber(it.totalExGst),
    })
  }
  return items
}
