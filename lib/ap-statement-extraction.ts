// lib/ap-statement-extraction.ts
// Claude-powered parser for SUPPLIER STATEMENTS (the monthly recap that
// suppliers send listing every transaction in the period). Used by the
// statement-reconciliation feature at /ap/statement to cross-check that
// every invoice on the statement also exists in MYOB.
//
// Statements look very different from invoices:
//   - Header: supplier name + ABN, statement date, period range
//   - Body: tabular ledger of every transaction (invoices + payments +
//     credit notes + adjustments) with a running balance
//   - Footer: aging summary (current / 30 / 60 / 90+) + total balance due
//
// We only need the LINE ITEMS where type === 'invoice' for matching —
// payments and credits are noise for reconciliation purposes — but we
// extract everything so the UI can show the full picture and let the
// user spot weird stuff.
//
// COST: ~$0.01-0.04 per statement via Haiku (statements are 1-3 pages,
// fewer tokens than invoices). Negligible at supplier-statement volume
// (a handful per month).

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001'

// ── Types ───────────────────────────────────────────────────────────────

export type StatementLineType = 'invoice' | 'payment' | 'credit' | 'unknown'

export interface ExtractedStatementLine {
  date: string | null              // ISO YYYY-MM-DD
  reference: string | null         // invoice/credit-note/payment number as printed
  invoiceNumber: string | null     // copy of reference when type='invoice'
  description: string | null
  // Amount as a NUMBER. Positive = charge to us (invoice/debit), negative
  // = payment/credit. We normalise here so callers don't need to interpret
  // separate Debit/Credit columns.
  amount: number | null
  type: StatementLineType
}

export interface ExtractedStatement {
  supplier: {
    name: string | null
    abn:  string | null
  }
  statementDate: string | null
  periodFrom:    string | null
  periodTo:      string | null
  openingBalance: number | null
  closingBalance: number | null
  totalDue:       number | null
  lines: ExtractedStatementLine[]
  parseConfidence: 'high' | 'medium' | 'low'
}

export interface StatementExtractionResult {
  statement: ExtractedStatement
  model: string
  inputTokens: number
  outputTokens: number
  costMicroUsd: number
  rawOutput: string
}

/**
 * Parse a supplier statement PDF using Claude.
 *
 * @param pdfBase64  Base64-encoded PDF bytes (no `data:` prefix)
 */
export async function extractStatementFromPdf(pdfBase64: string): Promise<StatementExtractionResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured')

  const model = process.env.AP_EXTRACTION_MODEL || DEFAULT_MODEL

  const body = {
    model,
    max_tokens: 4096,
    system: buildSystemPrompt(),
    messages: [
      {
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
          { type: 'text', text: 'Extract the supplier statement details as JSON per the system instructions. Output ONLY the JSON object.' },
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
    throw new Error(`Anthropic API ${r.status} on statement extraction: ${errText.substring(0, 500)}`)
  }

  const data = await r.json()
  const text = data.content?.[0]?.text || ''
  const raw = extractJson(text)
  const statement = validateAndNormalise(raw)

  const inputTokens = data.usage?.input_tokens ?? 0
  const outputTokens = data.usage?.output_tokens ?? 0
  const inputCostPerMTok = Number(process.env.FOLLOWUP_COST_INPUT_MICRO || 1_000_000)
  const outputCostPerMTok = Number(process.env.FOLLOWUP_COST_OUTPUT_MICRO || 5_000_000)
  const costMicroUsd =
    Math.round((inputTokens / 1_000_000) * inputCostPerMTok) +
    Math.round((outputTokens / 1_000_000) * outputCostPerMTok)

  return { statement, model, inputTokens, outputTokens, costMicroUsd, rawOutput: text }
}

// ── Prompt ──────────────────────────────────────────────────────────────

function buildSystemPrompt(): string {
  return `You are extracting structured data from an Australian SUPPLIER STATEMENT PDF for Just Autos, an automotive workshop.

A supplier statement is a monthly summary the supplier sends listing every transaction in the period — invoices issued, payments received from us, credit notes, adjustments — usually with a running balance and an aging summary at the bottom.

Your job is to extract every transaction line so we can cross-check that each invoice on the statement also exists in our accounting system (MYOB).

Output ONLY a JSON object with this exact shape:

{
  "supplier": {
    "name": "Supplier name issuing the statement (the company we owe money to). null if unclear.",
    "abn":  "Supplier ABN (11 digits, strip non-digits in output). null if not shown."
  },
  "statementDate": "Date the statement was generated, ISO YYYY-MM-DD. null if not visible.",
  "periodFrom":    "Start of the statement period, ISO YYYY-MM-DD. null if not shown.",
  "periodTo":      "End of the statement period, ISO YYYY-MM-DD. null if not shown.",
  "openingBalance": "Brought-forward balance at the start of the period as a NUMBER. null if not shown.",
  "closingBalance": "Closing balance at the end of the period as a NUMBER. null if not shown.",
  "totalDue":       "Total amount owing per the statement (often = closingBalance) as a NUMBER. null if not shown.",
  "lines": [
    {
      "date":          "Transaction date, ISO YYYY-MM-DD. null if absent.",
      "reference":     "The reference/document number printed on the row (invoice number, payment number, credit-note number). String. null if blank.",
      "invoiceNumber": "Same as reference IF type === 'invoice', else null.",
      "description":   "Free text from the row (e.g. 'INVOICE', 'Payment - thank you', 'CREDIT NOTE 1234'). null if empty.",
      "amount":        "Transaction amount as a SIGNED NUMBER. Positive for charges TO US (invoices, debits). Negative for payments FROM US or credits. So an invoice for $150 ex-GST showing $165 inc-GST should be amount: 165. A payment of $1000 from us should be amount: -1000. A credit note of $50 in our favour should be amount: -50. The intent: positive = increases what we owe, negative = decreases.",
      "type":          "One of: 'invoice', 'payment', 'credit', 'unknown'. Use 'invoice' for charges/debits where the row clearly represents an invoice or tax-invoice issued by the supplier. Use 'payment' for payments-received entries. Use 'credit' for credit notes / adjustments in our favour. Use 'unknown' if you can't tell."
    }
  ],
  "parseConfidence": "Your self-assessment: 'high' = clean scan, all fields read confidently; 'medium' = some ambiguity; 'low' = significant uncertainty."
}

Rules:
- Output ONLY the JSON. No preamble, no markdown fences, no commentary.
- Use the JSON null literal for missing values.
- All money fields are NUMBERS (no $, no commas).
- Dates: convert from DD/MM/YY or DD/MM/YYYY (Australian convention) to ISO YYYY-MM-DD. 28/04/26 = 2026-04-28.
- Capture EVERY transaction row — do not skip rows even if they look like running-balance summaries.
- Statements often have separate Debit and Credit columns. Combine them into a single signed amount: Debit positive, Credit negative.
- Skip aging summary rows (Current / 30 / 60 / 90+) and summary totals — those are NOT transaction lines, they're footers.
- Skip rows that are only the brought-forward balance at the top — that's openingBalance, not a line.
- If a row's amount column is blank or zero, still emit the line if it has a date and reference; set amount: 0.
- Be conservative with type classification: when unsure between invoice and unknown, prefer 'unknown' so the user can review.
- For invoiceNumber: ONLY populate when type === 'invoice'. For payment rows or credits, set invoiceNumber: null even if reference is set.`
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
    throw new Error(`Could not parse JSON from statement extraction: ${cleaned.substring(0, 200)}`)
  }
}

// ── Validation + normalisation ──────────────────────────────────────────

function validateAndNormalise(raw: any): ExtractedStatement {
  if (!raw || typeof raw !== 'object') {
    throw new Error('statement extraction: model output is not an object')
  }

  const supplier = raw.supplier || {}
  const lines = Array.isArray(raw.lines) ? raw.lines : []

  return {
    supplier: {
      name: nullableString(supplier.name),
      abn:  nullableAbn(supplier.abn),
    },
    statementDate:  nullableIsoDate(raw.statementDate),
    periodFrom:     nullableIsoDate(raw.periodFrom),
    periodTo:       nullableIsoDate(raw.periodTo),
    openingBalance: nullableNumber(raw.openingBalance),
    closingBalance: nullableNumber(raw.closingBalance),
    totalDue:       nullableNumber(raw.totalDue),
    lines: normaliseLines(lines),
    parseConfidence: ['high', 'medium', 'low'].includes(raw.parseConfidence)
      ? raw.parseConfidence
      : 'medium',
  }
}

function normaliseLines(raw: any[]): ExtractedStatementLine[] {
  const out: ExtractedStatementLine[] = []
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue
    const type: StatementLineType =
      r.type === 'invoice' || r.type === 'payment' || r.type === 'credit' ? r.type : 'unknown'
    const reference = nullableString(r.reference)
    const invoiceNumber = type === 'invoice'
      ? (nullableString(r.invoiceNumber) || reference)
      : null
    out.push({
      date:          nullableIsoDate(r.date),
      reference,
      invoiceNumber,
      description:   nullableString(r.description),
      amount:        nullableNumber(r.amount),
      type,
    })
  }
  return out
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
    // Statements often print negatives as "(123.45)" — handle that.
    const s = v.trim()
    let sign = 1
    let body = s
    const paren = s.match(/^\((.*)\)$/)
    if (paren) { sign = -1; body = paren[1] }
    const cleaned = body.replace(/[^\d.\-]/g, '')
    if (!cleaned) return null
    const n = Number(cleaned) * sign
    return Number.isFinite(n) ? n : null
  }
  return null
}

function nullableAbn(v: any): string | null {
  const s = nullableString(v)
  if (!s) return null
  const digits = s.replace(/\D/g, '')
  return digits.length === 11 ? digits : null
}

function nullableIsoDate(v: any): string | null {
  const s = nullableString(v)
  if (!s) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  const dmy = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/)
  if (dmy) {
    const day = dmy[1].padStart(2, '0')
    const month = dmy[2].padStart(2, '0')
    let year = dmy[3]
    if (year.length === 2) year = (Number(year) > 50 ? '19' : '20') + year
    return `${year}-${month}-${day}`
  }
  const d = new Date(s)
  if (!isNaN(d.getTime())) return d.toISOString().substring(0, 10)
  return null
}
