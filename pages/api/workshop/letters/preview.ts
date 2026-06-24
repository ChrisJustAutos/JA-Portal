// pages/api/workshop/letters/preview.ts
// POST { customerId, templateId, body?, recipientName?, recipientAddress?, kind }
//   → streams a preview PDF (kind 'letter' | 'envelope'). No DB writes. (view:diary)

import { withAuth } from '../../../../lib/authServer'
import { renderLetterPreview, getTemplate, getCustomerForLetter } from '../../../../lib/workshop-letters'

export const config = { maxDuration: 30 }

export default withAuth('view:diary', async (req, res) => {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Method not allowed' }) }
  let body: any = {}
  try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) } catch { return res.status(400).json({ error: 'Bad JSON' }) }

  const kind: 'letter' | 'envelope' = body.kind === 'envelope' ? 'envelope' : 'letter'
  const template = await getTemplate(String(body.templateId || ''))
  if (!template) return res.status(404).json({ error: 'Template not found' })
  const found = body.customerId ? await getCustomerForLetter(String(body.customerId)) : null

  try {
    const pdf = await renderLetterPreview({
      trigger: 'manual', customer: found?.customer || { name: body.recipientName || 'Customer', address: body.recipientAddress || '' },
      vehicle: found?.vehicle || null, template,
      bodyOverride: typeof body.body === 'string' ? body.body : null,
      recipientNameOverride: body.recipientName || null,
      recipientAddressOverride: body.recipientAddress || null,
    }, kind)
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `inline; filename="${kind}-preview.pdf"`)
    return res.status(200).send(pdf)
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || 'Preview failed' })
  }
})
