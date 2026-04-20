// pages/api/myob/connections.ts
// Admin endpoints for managing MYOB connections.
//
// GET  /api/myob/connections             → list all connections + connection health
// GET  /api/myob/connections?cfs=1&id=X   → list company files for connection X
// POST /api/myob/connections/select-cf    → body: { id, cfId, cfUsername, cfPassword }
// DELETE /api/myob/connections?id=X       → deactivate a connection

import type { NextApiRequest, NextApiResponse } from 'next'
import { requireAdmin } from '../../../lib/auth'
import { listConnections, listCompanyFiles, saveCompanyFile } from '../../../lib/myob'
import { createClient } from '@supabase/supabase-js'

function sb() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

async function handleGet(req: NextApiRequest, res: NextApiResponse) {
  // Optional: list CFs for a specific connection
  if (req.query.cfs === '1') {
    const id = String(req.query.id || '')
    if (!id) return res.status(400).json({ error: 'id required' })
    try {
      const cfs = await listCompanyFiles(id)
      return res.status(200).json({ companyFiles: cfs })
    } catch (e: any) {
      return res.status(500).json({ error: e?.message || 'Failed to list company files' })
    }
  }

  // Default: list connections
  const conns = await listConnections()
  // Strip sensitive tokens from response — admin UI shouldn't display them
  const safe = conns.map(c => ({
    id: c.id,
    label: c.label,
    company_file_id: c.company_file_id,
    company_file_name: c.company_file_name,
    company_file_username: c.company_file_username,
    connected_at: c.connected_at,
    last_refreshed_at: c.last_refreshed_at,
    last_used_at: c.last_used_at,
    access_expires_at: c.access_expires_at,
    is_active: c.is_active,
    has_cf_selected: !!c.company_file_id,
  }))
  res.status(200).json({ connections: safe })
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  return requireAdmin(req, res, async () => {
    if (req.method === 'GET')    return handleGet(req, res)
    if (req.method === 'DELETE') {
      const id = String(req.query.id || '')
      if (!id) { res.status(400).json({ error: 'id required' }); return }
      const { error } = await sb().from('myob_connections').update({ is_active: false }).eq('id', id)
      if (error) { res.status(500).json({ error: error.message }); return }
      res.status(200).json({ ok: true })
      return
    }
    if (req.method === 'POST') {
      // Select a company file for an existing connection
      const body = req.body || {}
      const id = String(body.id || '')
      const cfId = String(body.cfId || '')
      const cfUsername = String(body.cfUsername ?? 'Administrator')
      const cfPassword = String(body.cfPassword ?? '')
      if (!id || !cfId) { res.status(400).json({ error: 'id and cfId required' }); return }
      try {
        const cfs = await listCompanyFiles(id)
        const cf = cfs.find(x => x.Id === cfId)
        if (!cf) { res.status(404).json({ error: 'Company file not found for this connection' }); return }
        await saveCompanyFile(id, cf, cfUsername, cfPassword)
        res.status(200).json({ ok: true, companyFile: { id: cf.Id, name: cf.Name, uri: cf.Uri } })
      } catch (e: any) {
        res.status(500).json({ error: e?.message || 'Failed to save company file' })
      }
      return
    }
    res.status(405).json({ error: 'Method not allowed' })
  })
}
