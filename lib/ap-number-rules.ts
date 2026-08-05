// lib/ap-number-rules.ts
//
// Supplier-specific invoice-number FORMAT rules (Chris 2026-08-06, after the
// Ken Mills duplicate storm). For suppliers whose numbers follow a known
// shape, the LLM's read is repaired deterministically (OCR confusables:
// P1↔PI, O↔0, S↔5, l↔1, B↔8), corroborated against the PDF's own text
// layer, and anything STILL non-conforming is marked suspect so it flags
// for a human instead of posting a mangled number.
//
// Ken Mills: always "PI" + exactly 8 digits (plus a PI23xxxxxx series that
// also fits PI+8).

export interface SupplierNumberRule {
  name: string
  match: RegExp            // against vendor name and/or sender address
  hunt: RegExp             // tolerant pattern over the PDF text layer
  canon: (raw: string | null | undefined) => string | null  // → conforming number or null
}

const CONFUSABLES: Record<string, string> = { O: '0', S: '5', B: '8', Z: '2', I: '1', L: '1' }

function mapDigits(s: string): string {
  return s.split('').map(ch => CONFUSABLES[ch] ?? ch).join('').replace(/[^0-9]/g, '')
}

function kenMillsCanon(raw: string | null | undefined): string | null {
  const s = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (!s.startsWith('P')) return null
  const rest = s.slice(1)
  // The character after P is the (often-misread) "I" — but a dropped I means
  // the digits start immediately. Try both interpretations; exactly one can
  // yield the required 8 digits.
  const candidates = [rest]
  if (/^[IL1]/.test(rest)) candidates.unshift(rest.slice(1))
  for (const c of candidates) {
    const digits = mapDigits(c)
    if (digits.length === 8) return `PI${digits}`
  }
  return null
}

export const SUPPLIER_NUMBER_RULES: SupplierNumberRule[] = [
  {
    name: 'ken-mills',
    match: /ken\s*mills/i,
    hunt: /P\s?[I1L|l]\s?[\dOSBILZ|l]{7,11}/g,
    canon: kenMillsCanon,
  },
]

export function supplierNumberRule(vendorName?: string | null, fromAddress?: string | null): SupplierNumberRule | null {
  for (const r of SUPPLIER_NUMBER_RULES) {
    if ((vendorName && r.match.test(vendorName)) || (fromAddress && r.match.test(fromAddress))) return r
  }
  return null
}

export interface NumberRuleResult {
  number: string | null
  source: 'llm' | 'repaired' | 'pdf-text'
  suspect: string | null
}

// Apply a rule: repair the LLM read; corroborate/override from the PDF text
// layer; report suspect when nothing conforms.
export function applySupplierNumberRule(
  rule: SupplierNumberRule,
  input: { number: string | null | undefined; rawText: string | null },
): NumberRuleResult {
  const llmCanon = rule.canon(input.number)

  // Conforming candidates found in the document's own text.
  const textCanon: string[] = []
  if (input.rawText) {
    const seen = new Set<string>()
    for (const m of input.rawText.match(rule.hunt) || []) {
      const c = rule.canon(m)
      if (c && !seen.has(c)) { seen.add(c); textCanon.push(c) }
    }
  }

  // Text layer agrees with (or repairs) the LLM read → strongest signal.
  if (llmCanon && textCanon.includes(llmCanon)) {
    return { number: llmCanon, source: llmCanon === input.number ? 'llm' : 'repaired', suspect: null }
  }
  // Unique conforming number in the document text beats a non-conforming or
  // absent LLM read — and even a conforming-but-different LLM repair (the
  // text layer is the document; the LLM read passed through vision).
  if (textCanon.length === 1) {
    return { number: textCanon[0], source: 'pdf-text', suspect: null }
  }
  if (textCanon.length > 1) {
    return {
      number: llmCanon || textCanon[0],
      source: llmCanon ? 'repaired' : 'pdf-text',
      suspect: `document text contains ${textCanon.length} number-like candidates (${textCanon.slice(0, 3).join(', ')}…)`,
    }
  }
  // No text layer (scan) — the repaired LLM read stands if it conforms.
  if (llmCanon) {
    return { number: llmCanon, source: llmCanon === input.number ? 'llm' : 'repaired', suspect: null }
  }
  return {
    number: input.number || null,
    source: 'llm',
    suspect: `read "${input.number || '(none)'}" does not fit this supplier's number format`,
  }
}

// Our PO number off the invoice's text layer, when the extractor missed it.
// Conservative: labelled fields only, never the invoice number itself.
export function huntPoNumber(rawText: string, invoiceNumber?: string | null): string | null {
  const re = /(?:P\.?\s?O\.?|CUST(?:OMER)?\s+ORDER|YOUR\s+(?:ORDER|REF(?:ERENCE)?)|ORDER)\s*(?:NO\.?|NUMBER|#)?\s*[:.\-]?\s*([A-Z0-9][A-Z0-9\/-]{2,14})/gi
  const inv = String(invoiceNumber || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  let m: RegExpExecArray | null
  while ((m = re.exec(rawText)) !== null) {
    const cand = m[1].toUpperCase()
    const norm = cand.replace(/[^A-Z0-9]/g, '')
    if (!norm || norm === inv) continue
    if (/^PI\d{6,}/.test(norm)) continue            // their own number series
    if (/^\d{1,2}[-/]\d{1,2}[-/]\d{2,4}$/.test(cand)) continue  // date-like
    if (/^(NO|NUMBER|DATE|PAGE)$/.test(norm)) continue
    return cand
  }
  return null
}
