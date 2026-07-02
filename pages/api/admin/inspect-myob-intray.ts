// pages/api/admin/inspect-myob-intray.ts
//
// STEP-0 DIAGNOSTIC for the "MYOB In Tray as an auto-entry source" feature.
// The AccountRight In Tray API isn't used anywhere else in the repo, so before
// building the client we need to see the real response shape. This tries the
// documented endpoint(s) and returns the raw JSON so we can confirm the doc UID,
// file link, and fields.
//
// Auth: Bearer $CRON_SECRET, or a logged-in staffer with view:supplier_invoices.
// ?file=<uid> additionally probes how to download that document's file.

import type { NextApiRequest, NextApiResponse } from 'next'
import { getConnection, myobFetch } from '../../../lib/myob'
import { getCurrentUser } from '../../../lib/authServer'
import { roleHasPermission } from '../../../lib/permissions'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const bearerOk = !!process.env.CRON_SECRET && req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`
  if (!bearerOk) {
    const user = await getCurrentUser(req)
    if (!user || !roleHasPermission(user.role, 'view:supplier_invoices')) {
      return res.status(401).json({ error: 'Unauthorized' })
    }
  }

  const label = (req.query.cf as string) || 'VPS'
  try {
    const conn = await getConnection(label)
    if (!conn?.company_file_id) return res.status(400).json({ error: `No active MYOB connection / company file for ${label}` })
    const cf = conn.company_file_id

    // Try the documented In Tray list endpoint(s); report status + a trimmed
    // sample of each so we can see the real shape without dumping everything.
    const candidatePaths = [
      // Control: a known-good AccountRight resource. If THIS 401s too, the
      // token/connection is broken (affects posting as well); if it's 200 but
      // In Tray 401s, In Tray isn't accessible via this AccountRight connection.
      `/accountright/${cf}/Contact/Supplier`,
      `/accountright/${cf}/InTray/Document`,
      `/accountright/${cf}/InTray/Documents`,
    ]
    const probes: { path: string; cfAuth: boolean }[] = [
      { path: candidatePaths[0], cfAuth: true },
      { path: candidatePaths[1], cfAuth: true },
      { path: candidatePaths[2], cfAuth: true },
      // Same In Tray path WITHOUT the company-file token header — some MYOB
      // endpoints reject the cf-token; rules out a header issue vs a scope block.
      { path: candidatePaths[1], cfAuth: false },
    ]
    const attempts: any[] = []
    for (const p of probes) {
      try {
        const r = await myobFetch(conn.id, p.path, { query: { '$top': 5 }, requiresCfAuth: p.cfAuth })
        attempts.push({
          path: p.path, cfAuth: p.cfAuth,
          status: r.status,
          count: Array.isArray(r.data?.Items) ? r.data.Items.length : (Array.isArray(r.data) ? r.data.length : null),
          sample: Array.isArray(r.data?.Items) ? r.data.Items.slice(0, 3) : (Array.isArray(r.data) ? r.data.slice(0, 3) : r.data),
          rawSnippet: !r.data ? (r.raw || '').slice(0, 400) : undefined,
        })
      } catch (e: any) {
        attempts.push({ path: p.path, cfAuth: p.cfAuth, error: (e?.message || String(e)).slice(0, 300) })
      }
    }

    return res.status(200).json({ ok: true, companyFile: label, attempts })
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: (e?.message || String(e)).slice(0, 500) })
  }
}
