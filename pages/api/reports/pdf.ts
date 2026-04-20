// pages/api/reports/pdf.ts
// POST — Takes a GeneratedReport (from /api/reports/generate) and renders PDF.
// Returns the PDF binary with a filename the browser will save.
//
// Why split generate + pdf? Previewing is fast; re-fetching data to generate
// the PDF would duplicate API calls and delay the download. The client calls
// /generate once (rendering the preview), then /pdf with the same payload.

import type { NextApiRequest, NextApiResponse } from 'next'
import { withAuth } from '../../../lib/authServer'
import { roleCanGenerateReportType, REPORT_TYPE_LABELS } from '../../../lib/permissions'
import type { GeneratedReport } from '../../../lib/reports/spec'
import { renderReportPdf } from '../../../lib/reports/pdf'

export const config = { maxDuration: 60, api: { bodyParser: { sizeLimit: '4mb' } } }

function filenameFor(report: GeneratedReport): string {
  const slug = (report.title || 'report').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  const start = report.periodStart.replace(/-/g, '')
  const end = report.periodEnd.replace(/-/g, '')
  return `${slug}-${start}-${end}.pdf`
}

async function handler(req: NextApiRequest, res: NextApiResponse, user: any) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const report = req.body as GeneratedReport
  if (!report?.type || !report.sections) {
    return res.status(400).json({ error: 'Invalid report payload' })
  }
  if (!roleCanGenerateReportType(user.role, report.type)) {
    return res.status(403).json({ error: `Your role (${user.role}) cannot generate ${REPORT_TYPE_LABELS[report.type]}` })
  }

  try {
    const buffer = await renderReportPdf(report)
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="${filenameFor(report)}"`)
    res.setHeader('Content-Length', String(buffer.length))
    res.status(200).send(buffer)
  } catch (err: any) {
    console.error('PDF render failed:', err.message)
    res.status(500).json({ error: `PDF render failed: ${err.message}` })
  }
}

export default withAuth('generate:reports', handler)
