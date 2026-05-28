// pages/api/imports/meta.ts
// Returns the per-type config: roles (each with its own sheets/fields) + blurb.
// The /imports UI uses this to drive the multi-role mapping form.

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
      id: cfg.id, label: cfg.label, blurb: cfg.blurb,
      roles: cfg.roles.map(r => ({
        id: r.id, label: r.label, sheets: r.sheets, required: r.required !== false, blurb: r.blurb || null,
        fields: r.fields.map(f => ({ id: f.id, label: f.label, aliases: f.aliases, required: !!f.required, hint: f.hint || null })),
      })),
    }
  })
  return res.status(200).json({ types })
})
