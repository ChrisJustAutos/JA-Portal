// pages/api/imports/meta.ts
// Returns the field config (fields + aliases + sheet candidates + blurb) for
// every importable type. The /imports UI uses this to drive the mapping form.

import { withAuth } from '../../../lib/authServer'
import { roleHasPermission } from '../../../lib/permissions'
import { IMPORTERS, IMPORTER_TYPES } from '../../../lib/md-importers'

export const config = { maxDuration: 10 }

export default withAuth('view:diary', async (req, res, user) => {
  if (!roleHasPermission(user.role, 'admin:settings')) return res.status(403).json({ error: 'Admin only' })
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'GET only' }) }
  const types = IMPORTER_TYPES.map(id => {
    const cfg = IMPORTERS[id]
    return {
      id: cfg.id, label: cfg.label, sheets: cfg.sheets, blurb: cfg.blurb,
      fields: cfg.fields.map(f => ({ id: f.id, label: f.label, aliases: f.aliases, required: !!f.required, hint: f.hint || null })),
    }
  })
  return res.status(200).json({ types })
})
