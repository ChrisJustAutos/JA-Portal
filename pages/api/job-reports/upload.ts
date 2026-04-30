// pages/api/job-reports/upload.ts
// Manual upload of a Mechanics Desk Job Report (forecast lane).
//
// Auth: admin user session OR service token with scope 'upload:job-report'.
// The service-token path is used by GitHub Actions to push the auto-pulled
// daily report from Mechanics Desk into the Forecasting lane.

import type { NextApiRequest, NextApiResponse } from 'next'
import { requireAdminOrServiceToken } from '../../../lib/service-auth'
import { ingestJobReport } from '../../../lib/job-report-upload'

export const config = {
  api: {
    bodyParser: { sizeLimit: '10mb' },
  },
  // Playwright might push a 5MB file; ingestion takes ~3-5s. Generous.
  maxDuration: 60,
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.status(405).end(); return }

  return requireAdminOrServiceToken(req, res, 'upload:job-report', async (authCtx) => {
    try {
      const { filename, file_base64, notes } = req.body || {}
      if (!filename || !file_base64) {
        res.status(400).json({ error: 'filename and file_base64 required' })
        return
      }

      const buffer = Buffer.from(file_base64, 'base64')

      // Tag the source so the audit trail distinguishes humans from automation.
      const source: 'manual' | 'api' = authCtx.kind === 'user' ? 'manual' : 'api'
      const uploadedBy = authCtx.kind === 'user' ? authCtx.userId : null
      const finalNotes = notes
        || (authCtx.kind === 'service'
            ? `Auto-pulled from Mechanics Desk by "${authCtx.tokenName}" at ${new Date().toISOString()}`
            : null)

      const result = await ingestJobReport({
        buffer,
        filename,
        source,
        reportType: 'forecast',
        uploadedBy,
        notes: finalNotes,
      })

      res.status(200).json({
        ok: true,
        run_id: result.runId,
        job_count: result.jobCount,
        warnings: result.warnings,
        headerMap: result.headerMap,
        rematched_invoices: result.rematchedInvoices,
        report_type: result.reportType,
        auth: authCtx.kind,  // 'user' or 'service' — useful for the GH Actions log
      })
    } catch (e: any) {
      const msg = e?.message || 'Unknown error'
      const isParseError = /No job rows parsed|Could not find a "Job Number"|File has no sheets/.test(msg)
      res.status(isParseError ? 422 : 500).json({ error: msg })
    }
  })
}
