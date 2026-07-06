// lib/ap-batch-split.ts
//
// Batched-scan handling for AP auto-entry. The office scanner batches several
// paper invoices into ONE multi-page PDF emailed to scans@. Before extraction
// the batch is SEGMENTED — a cheap Claude pass looks at the whole PDF and
// returns the page range of each distinct document (a single invoice may span
// consecutive pages; continuation pages carry no new tax-invoice header) —
// then each range is sliced into its own PDF (pdf-lib) and run through the
// normal one-invoice pipeline.
//
// If segmentation fails, the fallback is one-invoice-per-page, which matches
// the office scanning convention; trailing pages that aren't invoices fail the
// extraction anchor (no number AND no total) and are skipped silently.

import { PDFDocument } from 'pdf-lib'

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001'

export interface PageRange { from: number; to: number }

export async function pdfPageCount(bytes: Buffer): Promise<number> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true })
  return doc.getPageCount()
}

/** Copy pages [from..to] (1-indexed, inclusive) into a standalone PDF. */
export async function splitPdfRange(bytes: Buffer, from: number, to: number): Promise<Buffer> {
  const src = await PDFDocument.load(bytes, { ignoreEncryption: true })
  const n = src.getPageCount()
  const indices: number[] = []
  for (let p = Math.max(1, from); p <= Math.min(n, to); p++) indices.push(p - 1)
  if (!indices.length) throw new Error(`page range ${from}-${to} outside document (1-${n})`)
  const out = await PDFDocument.create()
  const pages = await out.copyPages(src, indices)
  for (const p of pages) out.addPage(p)
  return Buffer.from(await out.save())
}

/** Copy several page ranges (1-indexed, inclusive) into one standalone PDF —
 *  used to build the "leftovers" document of a partially-entered batch. */
export async function extractPageRanges(bytes: Buffer, ranges: PageRange[]): Promise<Buffer> {
  const src = await PDFDocument.load(bytes, { ignoreEncryption: true })
  const n = src.getPageCount()
  const indices: number[] = []
  for (const r of ranges) {
    for (let p = Math.max(1, r.from); p <= Math.min(n, r.to); p++) indices.push(p - 1)
  }
  if (!indices.length) throw new Error('no pages to extract')
  const out = await PDFDocument.create()
  const pages = await out.copyPages(src, indices)
  for (const p of pages) out.addPage(p)
  return Buffer.from(await out.save())
}

/**
 * Ask Claude which page ranges are distinct documents. Returns ranges sorted,
 * clamped to the document, non-overlapping. Throws on API/parse failure —
 * the caller falls back to page-per-invoice.
 */
export async function segmentInvoicePdf(pdfBase64: string, pageCount: number): Promise<{ ranges: PageRange[]; costMicroUsd: number }> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured')
  const model = process.env.AP_EXTRACTION_MODEL || DEFAULT_MODEL

  const prompt = `This ${pageCount}-page PDF is a BATCH of scanned Australian supplier documents (invoices, credit notes, statements, sometimes delivery dockets), scanned back-to-back into one file — usually one document per page, but a single invoice may span consecutive pages (continuation pages show the same supplier and invoice number, or no new tax-invoice header).

Identify each DISTINCT document and its page range. Every page must belong to exactly one range; when unsure whether a page starts a new document, treat it as a new single-page document.

Return ONLY this JSON, nothing else:
{"documents":[{"firstPage":1,"lastPage":1},{"firstPage":2,"lastPage":3}]}`

  const r = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model, max_tokens: 1000,
      messages: [{ role: 'user', content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
        { type: 'text', text: prompt },
      ] }],
    }),
  })
  if (!r.ok) throw new Error(`Anthropic API ${r.status} on batch segmentation: ${(await r.text()).slice(0, 300)}`)
  const data = await r.json()
  const text: string = data.content?.[0]?.text || ''
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim()
  const first = cleaned.indexOf('{'); const last = cleaned.lastIndexOf('}')
  const parsed = JSON.parse(first >= 0 && last > first ? cleaned.slice(first, last + 1) : cleaned)

  const raw: any[] = Array.isArray(parsed?.documents) ? parsed.documents : []
  const ranges: PageRange[] = []
  let cursor = 0
  for (const d of raw) {
    const from = Math.max(1, Math.min(pageCount, Math.round(Number(d?.firstPage))))
    const to = Math.max(1, Math.min(pageCount, Math.round(Number(d?.lastPage))))
    if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) continue
    if (from <= cursor) continue                   // overlap — drop
    ranges.push({ from, to }); cursor = to
  }
  if (!ranges.length) throw new Error('segmentation returned no usable ranges')

  const inputTokens = data.usage?.input_tokens ?? 0
  const outputTokens = data.usage?.output_tokens ?? 0
  const costMicroUsd =
    Math.round((inputTokens / 1_000_000) * Number(process.env.FOLLOWUP_COST_INPUT_MICRO || 1_000_000)) +
    Math.round((outputTokens / 1_000_000) * Number(process.env.FOLLOWUP_COST_OUTPUT_MICRO || 5_000_000))
  return { ranges, costMicroUsd }
}
