// pages/api/admin/library/[slug].ts
// Serves a Library document's PDF to signed-in admins.
//
// These PDFs are deliberately NOT in public/ — the handover documents where
// every credential lives, the Supabase project id, Tailscale addresses and the
// current security gaps. Anything in public/ is served to the whole internet to
// anyone holding the URL, with no sign-in. So it goes through an auth gate.
//
//   GET /api/admin/library/sop           → inline (browser PDF viewer)
//   GET /api/admin/library/sop?download=1 → attachment (Save as…)

import type { NextApiRequest, NextApiResponse } from 'next'
import { withAuth } from '../../../../lib/authServer'
import { findDoc, readPdf } from '../../../../lib/library-docs'

export default withAuth('admin:settings', async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'GET only' }) }

  const doc = findDoc(req.query.slug)
  if (!doc) return res.status(404).json({ error: 'Unknown document' })

  let pdf: Buffer
  try {
    pdf = readPdf(doc)
  } catch {
    // The markdown is the source of truth; the PDF is generated. Say so plainly
    // rather than a bare 500 — it means the render step hasn't been run.
    return res.status(404).json({ error: `${doc.title}: PDF not built. Run scripts/render-doc-pdf.js and redeploy.` })
  }

  const filename = `${doc.slug === 'sop' ? 'JA-Portal-SOP' : 'JA-Portal-Handover'}.pdf`
  const disposition = req.query.download ? 'attachment' : 'inline'

  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Content-Length', String(pdf.length))
  res.setHeader('Content-Disposition', `${disposition}; filename="${filename}"`)
  // Private: it's per-user authorised, so no shared/CDN caching.
  res.setHeader('Cache-Control', 'private, max-age=300')
  return res.status(200).send(pdf)
})
