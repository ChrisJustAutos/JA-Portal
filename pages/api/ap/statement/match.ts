// pages/api/ap/statement/match.ts
// POST /api/ap/statement/match
//
// Parse a supplier statement PDF and reconcile it against MYOB.
//
// Request body (JSON):
//   {
//     pdfBase64:   string    // base64-encoded PDF bytes (no data: prefix)
//     filename:    string    // for logging/audit only
//     companyFile: 'VPS' | 'JAWS'
//     supplier:    { uid: string; name: string }   // resolved MYOB supplier
//   }
//
// Response (JSON):
//   {
//     ok: true,
//     statement:   ExtractedStatement,            // full parsed statement
//     match:       StatementMatchOutcome,         // results + orphans + summary
//     supplier:    { uid, name },
//     companyFile: 'VPS' | 'JAWS',
//     filename:    string,
//     parseCost:   { inputTokens, outputTokens, microUsd, model },
//   }
//
// We do not persist the PDF or results — this is a one-shot reconcile.
// Holding statements in storage would create a regulatory question we
// don't need yet (do we redact bank details? RLS? retention?). Keep it
// in memory; user re-uploads if they want to redo.
//
// maxDuration: 60s. Anthropic parse is 5-15s, MYOB pull is 2-10s, match
// is sub-second. 60s gives slack for outlier parses + slow MYOB.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../lib/authServer'
import { roleHasPermission } from '../../../../lib/permissions'
import { extractStatementFromPdf } from '../../../../lib/ap-statement-extraction'
import { matchStatementAgainstMyob } from '../../../../lib/ap-statement-match'
import type { CompanyFileLabel } from '../../../../lib/ap-myob-lookup'

export const config = {
  maxDuration: 60,
  api: {
    // Statement PDFs are usually < 1 MB, base64 inflates ~33% to ~1.3 MB.
    // 4 MB cap leaves slack and stays well under Vercel's hard limit.
    bodyParser: { sizeLimit: '4mb' },
  },
}

function sb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  )
}

interface RequestBody {
  pdfBase64?:   string
  filename?:    string
  companyFile?: string
  supplier?:    { uid?: string; name?: string }
}

export default withAuth(null, async (req: NextApiRequest, res: NextApiResponse, user: any) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  if (!roleHasPermission(user.role, 'edit:supplier_invoices')) {
    return res.status(403).json({ error: 'Forbidden — edit:supplier_invoices required' })
  }

  const body = (req.body || {}) as RequestBody

  const pdfBase64 = String(body.pdfBase64 || '').trim()
  if (!pdfBase64) return res.status(400).json({ error: 'pdfBase64 required' })
  // Strip "data:application/pdf;base64," if the client sent the data URL
  const cleanedPdf = pdfBase64.replace(/^data:application\/pdf;base64,/, '')
  if (!/^[A-Za-z0-9+/=\s]+$/.test(cleanedPdf)) {
    return res.status(400).json({ error: 'pdfBase64 is not valid base64' })
  }

  const filename = String(body.filename || 'statement.pdf').substring(0, 200)
  const companyFile = String(body.companyFile || '').toUpperCase()
  if (companyFile !== 'VPS' && companyFile !== 'JAWS') {
    return res.status(400).json({ error: "companyFile must be 'VPS' or 'JAWS'" })
  }
  const supplierUid  = String(body.supplier?.uid  || '').trim()
  const supplierName = String(body.supplier?.name || '').trim()
  if (!supplierUid)  return res.status(400).json({ error: 'supplier.uid required' })
  if (!supplierName) return res.status(400).json({ error: 'supplier.name required' })

  // ── Step 1: parse the statement PDF ──
  let extraction
  try {
    extraction = await extractStatementFromPdf(cleanedPdf)
  } catch (e: any) {
    console.error('statement extraction failed:', e?.message)
    return res.status(502).json({
      error: `Failed to parse the statement PDF: ${e?.message || 'unknown error'}`,
    })
  }

  if (extraction.statement.lines.length === 0) {
    return res.status(200).json({
      ok: true,
      statement: extraction.statement,
      match: {
        results: [],
        orphans: [],
        summary: {
          total: 0, invoiceLines: 0, matched: 0, amountMismatch: 0, dateMismatch: 0,
          missing: 0, inPortalPending: 0, rejected: 0, skipped: 0, orphans: 0,
        },
        windowFrom: '', windowTo: '',
        myobBillCount: 0, myobBillCountForSupplier: 0,
      },
      supplier:    { uid: supplierUid, name: supplierName },
      companyFile,
      filename,
      parseCost: {
        model:        extraction.model,
        inputTokens:  extraction.inputTokens,
        outputTokens: extraction.outputTokens,
        microUsd:     extraction.costMicroUsd,
      },
      warning: 'Parser returned no transaction lines — verify the PDF is a statement and not an invoice.',
    })
  }

  // ── Step 2: match against MYOB + portal ──
  let match
  try {
    match = await matchStatementAgainstMyob(
      sb(),
      companyFile as CompanyFileLabel,
      supplierUid,
      extraction.statement,
    )
  } catch (e: any) {
    console.error('statement match failed:', e?.message)
    return res.status(502).json({
      error: `Parsed statement OK but MYOB matching failed: ${e?.message || 'unknown error'}`,
      statement: extraction.statement,
    })
  }

  return res.status(200).json({
    ok: true,
    statement: extraction.statement,
    match,
    supplier:    { uid: supplierUid, name: supplierName },
    companyFile,
    filename,
    parseCost: {
      model:        extraction.model,
      inputTokens:  extraction.inputTokens,
      outputTokens: extraction.outputTokens,
      microUsd:     extraction.costMicroUsd,
    },
  })
})
