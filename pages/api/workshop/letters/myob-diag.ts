// pages/api/workshop/letters/myob-diag.ts
// TEMPORARY diagnostic (admin:settings): pull recent VPS Sale Invoices via the
// portal's MYOB OAuth connection (NOT CData) so we can see how a MechanicDesk
// booking *deposit* invoice differs from a finalised *job* invoice — which field
// (InvoiceType, line account, comment) cleanly separates them. Once we pick the
// rule, the hourly poller uses it and this endpoint can be removed.
//
// Open while logged in:  /api/workshop/letters/myob-diag?days=90&top=80

import { withAuth } from '../../../../lib/authServer'
import { roleHasPermission } from '../../../../lib/permissions'
import { getConnection, myobFetch } from '../../../../lib/myob'
import { WORKSHOP_MYOB_LABEL } from '../../../../lib/workshop'

export const config = { maxDuration: 60 }

const acct = (l: any) => {
  const a = l?.Account
  if (a) return [a.DisplayID, a.Name].filter(Boolean).join(' ')
  if (l?.Item) return `ITEM ${[l.Item.Number, l.Item.Name].filter(Boolean).join(' ')}`
  return ''
}

export default withAuth('view:diary', async (req, res, user) => {
  if (!roleHasPermission(user.role, 'admin:settings')) return res.status(403).json({ error: 'Admin only' })

  const days = Math.min(Number(req.query.days) || 90, 365)
  const top = Math.min(Number(req.query.top) || 60, 400)
  const detail = Math.min(Number(req.query.detail) || 30, 80) // how many to fetch full lines for
  const only = String(req.query.only || '').trim() // optional: comma-sep invoice numbers to detail
  const cutoff = new Date(Date.now() - days * 86400_000).toISOString().substring(0, 10)

  try {
    const conn = await getConnection(WORKSHOP_MYOB_LABEL)
    if (!conn || !conn.company_file_id) return res.status(400).json({ error: `${WORKSHOP_MYOB_LABEL} MYOB connection not configured` })
    const base = `/accountright/${conn.company_file_id}/Sale/Invoice`

    // 1) List feed (no lines, but gives UID + summary). With `only`, look the
    //    specific invoice numbers up directly (ignores the date window); else
    //    pull the recent window.
    const onlyNums = only ? only.split(',').map(s => s.trim()).filter(Boolean) : []
    const filter = onlyNums.length
      ? onlyNums.map(n => `Number eq '${n.replace(/'/g, "''")}'`).join(' or ')
      : `Date ge datetime'${cutoff}'`
    const r = await myobFetch(conn.id, base, {
      query: { '$filter': filter, '$orderby': 'Date desc', '$top': onlyNums.length ? 50 : top },
      performedBy: (user as any).id || null,
    })
    if (r.status !== 200) return res.status(502).json({ error: `MYOB GET failed (HTTP ${r.status})`, raw: (r.raw || '').substring(0, 400) })
    const items: any[] = Array.isArray(r.data?.Items) ? r.data.Items : []

    // 2) Fetch line detail for the wanted set.
    const wanted = onlyNums.length ? items : items.slice(0, detail)
    const detailed: any[] = []
    for (const inv of wanted) {
      const layout = inv.InvoiceType || 'Item'
      const d = await myobFetch(conn.id, `${base}/${layout}/${inv.UID}`, { performedBy: (user as any).id || null })
      const full = d.status === 200 ? d.data : null
      detailed.push({
        number: inv.Number ?? null, date: inv.Date ?? null, customer: inv.Customer?.Name ?? null,
        total: inv.TotalAmount ?? null, status: inv.Status ?? null,
        comment: full?.Comment ?? null, poNumber: full?.CustomerPurchaseOrderNumber ?? null,
        lines: Array.isArray(full?.Lines) ? full.Lines.map((l: any) => ({ type: l.Type ?? null, desc: l.Description ?? null, account: acct(l), total: l.Total ?? null })) : null,
      })
    }

    // Tally line accounts + item-vs-account split across the detailed set.
    const accountTally: Record<string, number> = {}
    for (const inv of detailed) for (const l of inv.lines || []) if (l.account) accountTally[l.account] = (accountTally[l.account] || 0) + 1

    const summary = items.map(i => ({ number: i.Number, customer: i.Customer?.Name, total: i.TotalAmount, status: i.Status }))
    return res.status(200).json({ cutoff, listCount: items.length, detailedCount: detailed.length, accountTally, detailed, summary })
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || 'Diagnostic failed' })
  }
})
