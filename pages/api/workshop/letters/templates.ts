// pages/api/workshop/letters/templates.ts
// GET    — list templates (view:diary)
// POST   — create/update a template (edit:bookings)
// DELETE ?id=  — delete a template (edit:bookings)

import { withAuth } from '../../../../lib/authServer'
import { roleHasPermission } from '../../../../lib/permissions'
import { listTemplates, upsertTemplate, deleteTemplate } from '../../../../lib/workshop-letters'

export default withAuth('view:diary', async (req, res, user) => {
  if (req.method === 'GET') {
    return res.status(200).json({ templates: await listTemplates() })
  }

  if (!roleHasPermission(user.role, 'edit:bookings')) return res.status(403).json({ error: 'Forbidden' })

  if (req.method === 'POST') {
    let body: any = {}
    try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) } catch { return res.status(400).json({ error: 'Bad JSON' }) }
    if (!String(body.name || '').trim() || !String(body.body || '').trim()) return res.status(400).json({ error: 'name and body are required' })
    try {
      const t = await upsertTemplate({
        id: body.id || undefined, name: String(body.name).trim(), category: body.category || null,
        body: String(body.body), sign_off_name: body.sign_off_name || null, sign_off_title: body.sign_off_title || null,
      })
      return res.status(200).json({ ok: true, template: t })
    } catch (e: any) { return res.status(500).json({ error: e?.message || 'Save failed' }) }
  }

  if (req.method === 'DELETE') {
    const id = String(req.query.id || '')
    if (!id) return res.status(400).json({ error: 'id required' })
    try { await deleteTemplate(id); return res.status(200).json({ ok: true }) }
    catch (e: any) { return res.status(500).json({ error: e?.message || 'Delete failed' }) }
  }

  res.setHeader('Allow', 'GET, POST, DELETE')
  return res.status(405).json({ error: 'Method not allowed' })
})
