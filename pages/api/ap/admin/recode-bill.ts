// pages/api/ap/admin/recode-bill.ts
// Re-code the line ACCOUNTS on an already-posted MYOB service bill — the
// repair tool for when auto-entry smart-coding picks the wrong account
// (first use: FAL Property Group tenancy-9 rent posted to the tenancy-8
// accounts, 2026-07-15). GET-modify-PUTs the bill so RowVersion and every
// other field stay intact; only matched lines' Account refs change.
//
// Auth: service token with scope 'ap:admin' (X-Service-Token header).
//
// POST {
//   companyFile: 'VPS' | 'JAWS',
//   billUid: '<myob bill uid>',
//   recode: [{ match: 'rent', accountDisplayId: '6-3009' }, …],
//   dryRun?: true   // report what WOULD change without PUTting
// }
// Each line's Description is tested against every recode entry
// (case-insensitive substring); first match wins for that line.

import type { NextApiRequest, NextApiResponse } from 'next'
import { validateServiceToken } from '../../../../lib/service-auth'
import { getConnection, myobFetch } from '../../../../lib/myob'

export const config = { maxDuration: 60 }

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const svc = await validateServiceToken(req, 'ap:admin')
  if (!svc) return res.status(401).json({ error: 'Unauthorised' })
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  let body: any = {}
  try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
  catch { return res.status(400).json({ error: 'Bad JSON body' }) }

  const companyFile = body.companyFile === 'JAWS' ? 'JAWS' : 'VPS'
  const billUid = String(body.billUid || '').trim()
  const recode: { match: string; accountDisplayId: string }[] = Array.isArray(body.recode) ? body.recode : []
  const dryRun = body.dryRun === true
  if (!billUid) return res.status(400).json({ error: 'billUid required' })
  if (!recode.length || recode.some(r => !r?.match || !r?.accountDisplayId)) {
    return res.status(400).json({ error: 'recode must be [{ match, accountDisplayId }, …]' })
  }

  try {
    const conn = await getConnection(companyFile)
    if (!conn?.company_file_id) return res.status(500).json({ error: `no active MYOB connection for ${companyFile}` })

    // Resolve each target DisplayID to a live account UID (exact match).
    const accounts = new Map<string, { uid: string; name: string }>()
    for (const r of recode) {
      const id = String(r.accountDisplayId).trim()
      if (accounts.has(id)) continue
      const got = await myobFetch(conn.id, `/accountright/${conn.company_file_id}/GeneralLedger/Account`, {
        query: { '$filter': `DisplayID eq '${id.replace(/'/g, "''")}'`, '$top': 1 },
      })
      const acc = got.data?.Items?.[0]
      if (!acc?.UID) return res.status(400).json({ error: `account ${id} not found in ${companyFile}` })
      accounts.set(id, { uid: acc.UID, name: acc.Name || id })
    }

    // GET the bill in full (keeps RowVersion + every required field).
    const base = `/accountright/${conn.company_file_id}/Purchase/Bill/Service/${billUid}`
    const got = await myobFetch(conn.id, base)
    if (got.status !== 200 || !got.data?.UID) {
      return res.status(404).json({ error: `bill not found (HTTP ${got.status})` })
    }
    const bill = got.data

    const changed: { line: string; from: string; to: string }[] = []
    for (const line of bill.Lines || []) {
      const desc = String(line.Description || '').toLowerCase()
      const hit = recode.find(r => desc.includes(String(r.match).toLowerCase()))
      if (!hit) continue
      const target = accounts.get(String(hit.accountDisplayId).trim())!
      const fromId = line.Account?.DisplayID || line.Account?.UID || '?'
      if (line.Account?.UID === target.uid) continue // already right
      changed.push({ line: String(line.Description || '').slice(0, 80), from: String(fromId), to: `${hit.accountDisplayId} ${target.name}` })
      line.Account = { UID: target.uid }
    }

    if (!changed.length) return res.status(200).json({ ok: true, changed: [], note: 'no lines matched / all already coded correctly' })
    if (dryRun) return res.status(200).json({ ok: true, dryRun: true, changed })

    const put = await myobFetch(conn.id, base, { method: 'PUT', body: bill, performedBy: `recode-bill:${svc.name || 'service'}` })
    if (![200, 201, 204].includes(put.status)) {
      const msg = put.data?.Errors?.[0]?.Message || put.data?.Message || `HTTP ${put.status}`
      return res.status(502).json({ error: `MYOB rejected the update: ${String(msg).slice(0, 300)}`, changed })
    }

    return res.status(200).json({ ok: true, changed, billNumber: bill.Number || null, supplierInvoiceNumber: bill.SupplierInvoiceNumber || null })
  } catch (e: any) {
    return res.status(500).json({ error: (e?.message || String(e)).slice(0, 400) })
  }
}
