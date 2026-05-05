// pages/api/ap/upload.ts
// Manual PDF upload endpoint for the AP Invoice Processor.
//
// Backstop / test path. Same pipeline as the email webhook (Round 4) — both
// hit insertInvoiceWithLines + applyTriageAndResolve. Useful for:
//   - Testing parser changes against real invoices without waiting for email
//   - Re-processing PDFs that arrived via email but failed to parse
//   - Suppliers that don't email invoices (e.g. picked up in person)
//
// Body: JSON { pdfBase64: string, filename: string }
// Auth: requires edit:supplier_invoices permission

import type { NextApiRequest, NextApiResponse } from 'next'
import { withAuth } from '../../../lib/authServer'
import { extractInvoiceFromPdf } from '../../../lib/ap-extraction'
import {
  insertInvoiceWithLines,
  uploadInvoicePdf,
  applyTriageAndResolve,
} from '../../../lib/ap-supabase'

// PDFs base64-encoded land at ~1.3-1.5x source size. Cap at 15MB body so
// invoices up to ~10MB PDFs (way more than realistic) pass through.
export const config = {
  api: { bodyParser: { sizeLimit: '15mb' } },
  maxDuration: 60,
}

export default withAuth('edit:supplier_invoices', async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const { pdfBase64, filename } = (req.body || {}) as { pdfBase64?: string; filename?: string }
  if (!pdfBase64 || typeof pdfBase64 !== 'string') {
    return res.status(400).json({ error: 'pdfBase64 (string) is required in body' })
  }
  if (!filename || typeof filename !== 'string') {
    return res.status(400).json({ error: 'filename (string) is required in body' })
  }

  // Strip data URL prefix if present (defensive)
  const cleanBase64 = pdfBase64.replace(/^data:application\/pdf;base64,/, '').trim()

  // Quick sanity check: PDFs start with %PDF- in their decoded header
  let pdfBytes: Buffer
  try {
    pdfBytes = Buffer.from(cleanBase64, 'base64')
  } catch (e: any) {
    return res.status(400).json({ error: 'Failed to decode pdfBase64: ' + (e?.message || 'invalid base64') })
  }
  if (pdfBytes.length < 100 || !pdfBytes.subarray(0, 5).toString('ascii').startsWith('%PDF-')) {
    return res.status(400).json({ error: 'Decoded bytes are not a valid PDF (missing %PDF- header)' })
  }

  // ── Parse via Claude ──
  let extraction
  try {
    extraction = await extractInvoiceFromPdf(cleanBase64)
  } catch (e: any) {
    return res.status(422).json({
      error: 'PDF extraction failed',
      detail: e?.message || String(e),
    })
  }

  // ── Insert invoice + lines ──
  let inserted
  try {
    inserted = await insertInvoiceWithLines({
      source: 'upload',
      pdfFilename: filename,
      extracted: extraction.invoice,
      rawExtraction: {
        rawOutput: extraction.rawOutput,
        model: extraction.model,
        inputTokens: extraction.inputTokens,
        outputTokens: extraction.outputTokens,
        costMicroUsd: extraction.costMicroUsd,
      },
    })
  } catch (e: any) {
    return res.status(500).json({ error: 'DB insert failed: ' + (e?.message || String(e)) })
  }

  // ── Upload PDF to storage ──
  try {
    await uploadInvoicePdf(inserted.pdfStoragePath, pdfBytes)
  } catch (e: any) {
    // Don't fail the whole request — the invoice row exists. Log + flag.
    console.error(`PDF upload failed for invoice ${inserted.id}:`, e)
  }

  // ── Apply triage + supplier resolution ──
  try {
    await applyTriageAndResolve(inserted.id)
  } catch (e: any) {
    console.error(`triage failed for invoice ${inserted.id}:`, e)
  }

  return res.status(201).json({
    ok: true,
    invoiceId: inserted.id,
    extraction: {
      vendor: extraction.invoice.vendor,
      invoiceNumber: extraction.invoice.invoiceNumber,
      totalIncGst: extraction.invoice.totals.totalIncGst,
      lineCount: extraction.invoice.lineItems.length,
      parseConfidence: extraction.invoice.parseConfidence,
      viaCapricorn: extraction.invoice.capricorn.via,
    },
    cost: { inputTokens: extraction.inputTokens, outputTokens: extraction.outputTokens, microUsd: extraction.costMicroUsd },
  })
})
