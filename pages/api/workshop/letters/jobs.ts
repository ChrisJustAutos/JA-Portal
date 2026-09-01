// pages/api/workshop/letters/jobs.ts
// GET                          — letter history (view:diary)
// POST { action:'manual', customerId, templateId, body?, recipientName?, recipientAddress? }
//                              — render + queue a manual letter (edit:bookings)
// POST { action:'reprint', id } — re-queue an existing letter's print jobs (edit:bookings)
// POST { action:'retry',   id } — rebuild a FAILED letter from scratch (edit:bookings)
// POST { action:'dismiss', id } — clear a letter off the worklist (edit:bookings)

import { withAuth } from '../../../../lib/authServer'
import { roleHasPermission } from '../../../../lib/permissions'
import { listLetterJobs, enqueueLetter, reprintLetter, retryLetter, dismissLetter, getTemplate, getCustomerForLetter } from '../../../../lib/workshop-letters'

export default withAuth('view:diary', async (req, res, user) => {
  if (req.method === 'GET') {
    const limit = Math.min(Number(req.query.limit) || 100, 500)
    const offset = Number(req.query.offset) || 0
    // ?all=1 shows settled letters too (printed / skipped / written off);
    // the default is the worklist.
    const includeAll = String(req.query.all || '') === '1'
    return res.status(200).json({ jobs: await listLetterJobs(limit, offset, includeAll) })
  }

  if (req.method === 'POST') {
    if (!roleHasPermission(user.role, 'edit:bookings')) return res.status(403).json({ error: 'Forbidden' })
    let body: any = {}
    try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) } catch { return res.status(400).json({ error: 'Bad JSON' }) }

    if (body.action === 'reprint') {
      if (!body.id) return res.status(400).json({ error: 'id required' })
      const r = await reprintLetter(String(body.id))
      return res.status(r.status === 'failed' ? 500 : 200).json(r)
    }

    // Rebuild a failed letter. reprint only re-queues an EXISTING pdf, which is
    // no help when the render or upload is what failed and there is no pdf.
    if (body.action === 'retry') {
      if (!body.id) return res.status(400).json({ error: 'id required' })
      const r = await retryLetter(String(body.id), user.id)
      return res.status(r.status === 'failed' ? 500 : 200).json(r)
    }

    if (body.action === 'dismiss') {
      if (!body.id) return res.status(400).json({ error: 'id required' })
      const r = await dismissLetter(String(body.id), typeof body.note === 'string' ? body.note : undefined)
      return res.status(r.status === 'failed' ? 500 : 200).json(r)
    }

    // Manual letter
    const customerId = String(body.customerId || '')
    const templateId = String(body.templateId || '')
    if (!customerId || !templateId) return res.status(400).json({ error: 'customerId and templateId required' })
    const found = await getCustomerForLetter(customerId)
    if (!found) return res.status(404).json({ error: 'Customer not found' })
    const template = await getTemplate(templateId)
    if (!template) return res.status(404).json({ error: 'Template not found' })

    const r = await enqueueLetter({
      trigger: 'manual', customer: found.customer, vehicle: found.vehicle, template,
      bodyOverride: typeof body.body === 'string' ? body.body : null,
      recipientNameOverride: body.recipientName || null,
      recipientAddressOverride: body.recipientAddress || null,
      createdBy: (user as any).id || null,
    })
    return res.status(r.status === 'failed' ? 500 : 200).json(r)
  }

  res.setHeader('Allow', 'GET, POST')
  return res.status(405).json({ error: 'Method not allowed' })
})
