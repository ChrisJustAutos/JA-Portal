// pages/api/job-reports/upload.ts
// Manual upload of a Mechanics Desk job WIP report (CSV/XLSX).
//
// Pipeline C (the nightly Graph webhook at /api/webhooks/graph-jobreport-mail)
// uses the same lib/job-report-upload helper, so behaviour stays identical
// whether the file came from a human upload or from automation.
//
// Request body (JSON):
//   {
//     filename: string,
//     file_base64: string,   // CSV or XLSX as base64
//     notes?: string
//   }

import type { NextApiRequest, NextApiResponse } from 'next'
import { requireAdmin, getSessionUser } from '../../../lib/auth'
import { ingestJobReport } from '../../../lib/job-report-upload'

export const config = {
  api: {
    bodyParser: { sizeLimit: '10mb' },
  },
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.status(405).end(); return }
  return requireAdmin(req, res, async () => {
    const user = await getSessionUser(req)
    try {
      const { filename, file_base64, notes } = req.body || {}
      if (!filename || !file_base64) {
        res.status(400).json({ error: 'filename and file_base64 required' })
        return
      }

      const buffer = Buffer.from(file_base64, 'base64')
      const result = await ingestJobReport({
        buffer,
        filename,
        source: 'manual',
        uploadedBy: user?.id || null,
        notes: notes || null,
      })

      res.status(200).json({
        ok: true,
        run_id: result.runId,
        job_count: result.jobCount,
        warnings: result.warnings,
        headerMap: result.headerMap,
        rematched_invoices: result.rematchedInvoices,
      })
    } catch (e: any) {
      // Differentiate parse/validation errors (422) from server errors (500)
      const msg = e?.message || 'Unknown error'
      const isParseError = /No job rows parsed|Could not find a "Job Number"|File has no sheets/.test(msg)
      res.status(isParseError ? 422 : 500).json({ error: msg })
    }
  })
}
