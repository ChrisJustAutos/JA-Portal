// lib/ap-extraction.ts
// Claude-powered PDF parser for supplier invoices (AP Invoice Processor).
//
// Inputs: a supplier invoice PDF (Repco, BNT, Burson, Capricorn statement,
// direct-billed vendors, etc).
// Outputs: structured invoice header + line items + Capricorn detection.
//
// Mirrors lib/quote-extraction.ts in shape — same Claude PDF document
// attachment pattern, same JSON-only output discipline, same telemetry
// returned for later cost reporting.
//
// COST: ~$0.005-0.02 per invoice via Haiku. AP volume is low (a few
// invoices per workshop day), so total spend is negligible.
//
// REJECT vs RETURN: extraction never throws on missing optional fields.
// We DO throw if invoice_number AND total_inc_gst are both missing —
// without those two anchors we can't trust anything else. Caller catches
// and parks the row with status='error', parse_error populated.

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001'

// ── Types ───────────────────────────────────────────────────────────────

export interface ExtractedAPLineItem {
  lineNo: number
  partNumber: string | null
  description: string
  qty: number | null
  uom: string | null
  unitPriceExGst: number | null
  lineTotalExGst: number | null
  gstAmount: number | null
  // Tax code as printed on the invoice (supplier-specific): 'GST', 'FRE',
  // 'GST 10%', '3', etc. We map to MYOB tax codes downstream.
  taxCodeRaw: string | null
  // Resolved AU tax code: 'GST' | 'FRE' | null. Best-effort guess.
  taxCode: 'GST' | 'FRE' | null
}

export interface ExtractedAPInvoice {
  vendor: {
    name: string | null              // e.g. "Repco" or "GPC Asia Pacific Pty Ltd"
    abn: string | null               // 11-digit ABN if present
    // Supplier contact + address — used to pre-fill the "Create new MYOB
    // supplier" form on the AP detail page. All optional; the model returns
    // null for any field that isn't visible on the PDF.
    email:    string | null
    phone:    string | null
    website:  string | null
    street:   string | null
    city:     string | null
    state:    string | null
    postcode: string | null
    country:  string | null
  }
  invoiceNumber: string | null
  invoiceDate: string | null         // ISO YYYY-MM-DD
  dueDate: string | null             // ISO YYYY-MM-DD
  poNumber: string | null
  totals: {
    subtotalExGst: number | null
    gstAmount: number | null
    totalIncGst: number | null
  }
  capricorn: {
    via: boolean                     // true if this invoice was charged to Capricorn
    reference: string | null         // e.g. "046766"
    memberNumber: string | null      // our customer/member number on the invoice
  }
  notes: string | null               // free-text annotations on the PDF
  lineItems: ExtractedAPLineItem[]
  parseConfidence: 'high' | 'medium' | 'low'
}

export interface ExtractionResult {
  invoice: ExtractedAPInvoice
  model: string
  inputTokens: number
  outputTokens: number
  costMicroUsd: number
  rawOutput: string                  // for debugging
}

/**
 * Parse a supplier invoice PDF using Claude.
 *
 * @param pdfBase64  Base64-encoded PDF bytes (no `data:` prefix)
 * @returns          Validated structured invoice + telemetry
 * @throws           If the API call fails OR if both invoice_number and
 *                   total_inc_gst are missing (no anchor to trust the rest).
 */
export async function extractInvoiceFromPdf(pdfBase64: string): Promise<ExtractionResult> {
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
          { type: 'text', text: 'Extract the supplier invoice details as JSON per the system instructions. Output ONLY the JSON object.' },
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
    throw new Error(`Anthropic API ${r.status} on AP extraction: ${errText.substring(0, 500)}`)
  }

  const data = await r.json()
  const text = data.content?.[0]?.text || ''
  const raw = extractJson(text)
  const invoice = validateAndNormalise(raw)

  const inputTokens = data.usage?.input_tokens ?? 0
  const outputTokens = data.usage?.output_tokens ?? 0
  const inputCostPerMTok = Number(process.env.FOLLOWUP_COST_INPUT_MICRO || 1_000_000)
  const outputCostPerMTok = Number(process.env.FOLLOWUP_COST_OUTPUT_MICRO || 5_000_000)
  const costMicroUsd =
    Math.round((inputTokens / 1_000_000) * inputCostPerMTok) +
    Math.round((outputTokens / 1_000_000) * outputCostPerMTok)

  return { invoice, model, inputTokens, outputTokens, costMicroUsd, rawOutput: text }
}

// ── Prompt ──────────────────────────────────────────────────────────────

function buildSystemPrompt(): string {
  return `You are extracting structured data from an Australian supplier invoice PDF for Just Autos, an automotive workshop in Queensland.

The invoices come from various suppliers (Repco, BNT, Burson, Capricorn, direct-billed vendors). Layouts vary widely. Some are charged through Capricorn Society Ltd (a buying group) — those typically show "CHARGE TO: CAPRICORN SOCIETY LTD" or "** CAPRICORN <number> **" near the top, but the actual supplier (Repco, BNT, etc) is the entity issuing the invoice and providing the goods/services. Track BOTH.

Output ONLY a JSON object with this exact shape:

{
  "vendor": {
    "name":     "The actual supplier issuing the invoice (e.g. 'Repco', 'GPC Asia Pacific Pty Ltd', 'BNT'). NOT Capricorn — Capricorn is the billing intermediary, not the vendor. Use the most prominent supplier branding/header. null if unclear.",
    "abn":      "Supplier's ABN as shown (11 digits, may have spaces). Strip non-digits in output. null if not shown.",
    "email":    "Supplier's contact / accounts email if printed on the invoice (header or footer). null if not shown.",
    "phone":    "Supplier's primary phone number as printed. Keep formatting roughly as shown. null if not shown.",
    "website":  "Supplier's website URL as printed (e.g. 'www.repco.com.au'). null if not shown.",
    "street":   "Supplier's street address — building number + street. Multi-line allowed (use \\n between lines). null if not shown. Use the supplier's own address (header/footer), NOT 'Bill To' / 'Ship To'.",
    "city":     "Supplier's suburb / city / town. null if not shown.",
    "state":    "Supplier's state — Australian abbreviation if obvious (QLD, NSW, VIC, WA, SA, TAS, NT, ACT). null if not shown.",
    "postcode": "Supplier's postcode (4 digits in AU). null if not shown.",
    "country":  "Supplier's country. Default to 'Australia' for Australian addresses if state/postcode look AU; null only if address truly absent."
  },
  "invoiceNumber": "Invoice number / Tax invoice number as shown. String even if numeric. Required where shown — null only if genuinely absent.",
  "invoiceDate":   "Date the invoice was issued, ISO format YYYY-MM-DD. Convert from DD/MM/YY or DD/MM/YYYY. null if not present.",
  "dueDate":       "Payment due date, ISO format YYYY-MM-DD. null if not shown.",
  "poNumber":      "Purchase order number from the 'P.O. No.' field or similar. Often blank on Capricorn-routed invoices — null in that case.",
  "totals": {
    "subtotalExGst": "Subtotal before GST as a NUMBER (no $, no commas). null if only inc-GST shown.",
    "gstAmount":     "GST amount as a NUMBER. null if not shown.",
    "totalIncGst":   "Total including GST as a NUMBER. The amount payable. null if genuinely missing."
  },
  "capricorn": {
    "via":          "true if 'CAPRICORN' appears prominently as the billing channel (e.g. 'CHARGE TO: CAPRICORN SOCIETY LTD' or '** CAPRICORN <ref> **'), else false.",
    "reference":    "The Capricorn reference number if shown (e.g. '046766' from '** CAPRICORN 046766 **'). null otherwise.",
    "memberNumber": "Just Autos's customer/member number with this supplier (e.g. '5734438-0001'). Often labelled CUSTOMER NUMBER. null if not shown."
  },
  "notes": "Any free-text annotations relevant to the order — names of staff who placed it ('N: MATTHEW'), delivery instructions ('T: REPCO TO DELIVER'), special remarks. Concatenate multiple into one string with semicolons. null if nothing notable.",
  "lineItems": [
    {
      "lineNo":          "Line number as shown (often 0001, 0002...). Cast to integer. Use 1-based sequence if not shown.",
      "partNumber":      "Part number / SKU as shown. null if not present.",
      "description":     "Line description as shown.",
      "qty":             "Quantity supplied as a number. null if not shown.",
      "uom":             "Unit of measure (e.g. 'EACH', 'KG', 'L'). null if not shown.",
      "unitPriceExGst":  "Unit price ex-GST as a number. null if not shown.",
      "lineTotalExGst":  "Line total ex-GST as a number. null if not shown.",
      "gstAmount":       "GST charged on this line as a number. null if not shown.",
      "taxCodeRaw":      "The tax-code marker as printed on the line ('GST', 'FRE', '3', '0', '*', etc). null if no marker shown. Many supplier invoices include a code legend near the totals — if a numeric code maps to '10%' or 'GST' in the legend, set this to the raw code (e.g. '3') so we can map downstream.",
      "taxCode":         "Best-effort resolved tax code: 'GST' (10% applicable), 'FRE' (no GST / free), or null if uncertain. Default to 'GST' if the line clearly shows a GST charge but no explicit code."
    }
  ],
  "parseConfidence": "Your self-assessment of extraction accuracy. 'high' = clear scan, all key fields read confidently. 'medium' = some fields ambiguous or layout unusual. 'low' = significant uncertainty, manual review essential."
}

Rules:
- Output ONLY the JSON. No preamble, no markdown fences, no commentary.
- Use the JSON null literal (not the string 'null') for missing values.
- All money fields are NUMBERS, not strings. Strip currency symbols, commas, spaces.
- Don't invent fields. If something isn't visible on the PDF, return null.
- For dates: convert to ISO YYYY-MM-DD. Australian convention is DD/MM/YYYY — read accordingly. 28/04/26 means 28 April 2026.
- For ABN: strip spaces, return as digits-only string, or null.
- Capture every line item shown in order. Even single-line invoices need lineItems as an array.
- "via Capricorn" matters: it changes downstream accounting. Look for explicit Capricorn branding/markers, not just any mention.
- If GST appears to be charged on a line but no explicit tax code is shown, default taxCode to 'GST'.
- If the line shows "FREE" / "NO GST" / 0% charged, taxCode is 'FRE'.`
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
    throw new Error(`Could not parse JSON from AP extraction model output: ${cleaned.substring(0, 200)}`)
  }
}

// ── Validation + normalisation ──────────────────────────────────────────

function validateAndNormalise(raw: any): ExtractedAPInvoice {
  if (!raw || typeof raw !== 'object') {
    throw new Error('AP extraction: model output is not an object')
  }

  const vendor = raw.vendor || {}
  const totals = raw.totals || {}
  const capricorn = raw.capricorn || {}

  const invoiceNumber = nullableString(raw.invoiceNumber)
  const totalIncGst = nullableNumber(totals.totalIncGst)

  // Anchor check: need at least invoice number AND total to trust anything.
  // The caller catches this and parks the row as 'error' with parse_error.
  if (!invoiceNumber && totalIncGst === null) {
    throw new Error('AP extraction: missing both invoice_number and total_inc_gst — no anchors to trust extraction')
  }

  return {
    vendor: {
      name:     nullableString(vendor.name),
      abn:      nullableAbn(vendor.abn),
      email:    nullableEmail(vendor.email),
      phone:    nullableString(vendor.phone),
      website:  nullableString(vendor.website),
      street:   nullableString(vendor.street),
      city:     nullableString(vendor.city),
      state:    nullableString(vendor.state),
      postcode: nullableString(vendor.postcode),
      country:  nullableString(vendor.country),
    },
    invoiceNumber,
    invoiceDate: nullableIsoDate(raw.invoiceDate),
    dueDate:     nullableIsoDate(raw.dueDate),
    poNumber:    nullableString(raw.poNumber),
    totals: {
      subtotalExGst: nullableNumber(totals.subtotalExGst),
      gstAmount:     nullableNumber(totals.gstAmount),
      totalIncGst,
    },
    capricorn: {
      via:          capricorn.via === true,
      reference:    nullableString(capricorn.reference),
      memberNumber: nullableString(capricorn.memberNumber),
    },
    notes: nullableString(raw.notes),
    lineItems: normaliseLineItems(raw.lineItems),
    parseConfidence: ['high', 'medium', 'low'].includes(raw.parseConfidence) ? raw.parseConfidence : 'medium',
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

function nullableAbn(v: any): string | null {
  const s = nullableString(v)
  if (!s) return null
  const digits = s.replace(/\D/g, '')
  return digits.length === 11 ? digits : null
}

// Drops obviously bad emails (no @, no dot). The model occasionally returns
// the literal "(email not shown)" or similar — this filter prevents those
// strings ending up in the supplier card.
function nullableEmail(v: any): string | null {
  const s = nullableString(v)
  if (!s) return null
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : null
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

function normaliseLineItems(raw: any): ExtractedAPLineItem[] {
  if (!Array.isArray(raw)) return []
  const items: ExtractedAPLineItem[] = []
  let autoLineNo = 1
  for (const it of raw) {
    if (!it || typeof it !== 'object') continue
    const description = nullableString(it.description)
    if (!description) continue

    const taxCodeRaw = nullableString(it.taxCodeRaw)
    let taxCode: 'GST' | 'FRE' | null = null
    if (it.taxCode === 'GST' || it.taxCode === 'FRE') {
      taxCode = it.taxCode
    } else if (taxCodeRaw) {
      // Heuristic mapping for common code styles
      const r = taxCodeRaw.toUpperCase()
      if (r === 'GST' || r === '10%' || r === '3' || r === 'S' || r === '*') taxCode = 'GST'
      else if (r === 'FRE' || r === '0%' || r === '0' || r === 'FREE') taxCode = 'FRE'
    }

    const ln = nullableInt(it.lineNo)
    items.push({
      lineNo: ln && ln > 0 ? ln : autoLineNo,
      partNumber:     nullableString(it.partNumber),
      description,
      qty:            nullableNumber(it.qty),
      uom:            nullableString(it.uom),
      unitPriceExGst: nullableNumber(it.unitPriceExGst),
      lineTotalExGst: nullableNumber(it.lineTotalExGst),
      gstAmount:      nullableNumber(it.gstAmount),
      taxCodeRaw,
      taxCode,
    })
    autoLineNo++
  }
  return items
}
