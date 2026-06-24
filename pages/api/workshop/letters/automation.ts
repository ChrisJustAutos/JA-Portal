// pages/api/workshop/letters/automation.ts
// GET  — current automation config + templates (view:diary)
// PUT  — save automation config (admin:settings)

import { withAuth } from '../../../../lib/authServer'
import { roleHasPermission } from '../../../../lib/permissions'
import { getLetterAutomation, setAutomation, listTemplates, LetterAutomation } from '../../../../lib/workshop-letters'
import { runLetterWatch } from '../../../../lib/workshop-letter-watch'

export const config = { maxDuration: 120 }

const NUMERIC_FIELDS = ['min_total'] as const
const BOOL_FIELDS = ['enabled', 'print_envelope'] as const
const TEXT_FIELDS = ['letterhead_name', 'letterhead_abn', 'letterhead_address', 'letterhead_phone', 'letterhead_email', 'letterhead_website', 'return_address', 'template_id'] as const

export default withAuth('view:diary', async (req, res, user) => {
  if (req.method === 'GET') {
    const [automation, templates] = await Promise.all([getLetterAutomation(), listTemplates()])
    return res.status(200).json({ automation, templates })
  }

  if (req.method === 'PUT') {
    if (!roleHasPermission(user.role, 'admin:settings')) return res.status(403).json({ error: 'Admin only' })
    let body: any = {}
    try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) } catch { return res.status(400).json({ error: 'Bad JSON' }) }
    const patch: Partial<LetterAutomation> = {}
    for (const f of BOOL_FIELDS) if (f in body) (patch as any)[f] = !!body[f]
    for (const f of NUMERIC_FIELDS) if (f in body) (patch as any)[f] = Number(body[f]) || 0
    for (const f of TEXT_FIELDS) if (f in body) (patch as any)[f] = body[f] === '' ? null : body[f]
    try { return res.status(200).json({ ok: true, automation: await setAutomation(patch) }) }
    catch (e: any) { return res.status(500).json({ error: e?.message || 'Save failed' }) }
  }

  if (req.method === 'POST') {
    // Admin "Run now" — preview (dry) by default; pass dry:false to actually queue.
    if (!roleHasPermission(user.role, 'admin:settings')) return res.status(403).json({ error: 'Admin only' })
    let body: any = {}
    try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) } catch { return res.status(400).json({ error: 'Bad JSON' }) }
    if (body.action !== 'run') return res.status(400).json({ error: 'Unknown action' })
    try {
      const outcome = await runLetterWatch({ dryRun: body.dry !== false, lookbackDays: body.lookbackDays ? Number(body.lookbackDays) : undefined })
      return res.status(200).json({ ok: true, outcome })
    } catch (e: any) { return res.status(500).json({ error: e?.message || 'Run failed' }) }
  }

  res.setHeader('Allow', 'GET, PUT, POST')
  return res.status(405).json({ error: 'Method not allowed' })
})
