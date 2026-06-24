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
  const top = Math.min(Number(req.query.top) || 80, 400)
  const cutoff = new Date(Date.now() - days * 86400_000).toISOString().substring(0, 10)

  try {
    const conn = await getConnection(WORKSHOP_MYOB_LABEL)
    if (!conn || !conn.company_file_id) return res.status(400).json({ error: `${WORKSHOP_MYOB_LABEL} MYOB connection not configured` })

    // Combined feed returns every invoice layout (Service/Item/…) with Lines.
    const r = await myobFetch(conn.id, `/accountright/${conn.company_file_id}/Sale/Invoice`, {
      query: { '$filter': `Date ge datetime'${cutoff}'`, '$orderby': 'Date desc', '$top': top },
      performedBy: (user as any).id || null,
    })
    if (r.status !== 200) return res.status(502).json({ error: `MYOB GET failed (HTTP ${r.status})`, raw: (r.raw || '').substring(0, 400) })

    const items: any[] = Array.isArray(r.data?.Items) ? r.data.Items : []
    const invoices = items.map(inv => ({
      number: inv.Number ?? null,
      date: inv.Date ?? null,
      type: inv.InvoiceType ?? null,
      customer: inv.Customer?.Name ?? null,
      total: inv.TotalAmount ?? null,
      status: inv.Status ?? null,
      comment: inv.Comment ?? null,
      journalMemo: inv.JournalMemo ?? null,
      lineCount: Array.isArray(inv.Lines) ? inv.Lines.length : null,
      lines: Array.isArray(inv.Lines) ? inv.Lines.map((l: any) => ({ desc: l.Description ?? null, account: acct(l), total: l.Total ?? null })) : null,
    }))

    // Quick tallies to spot patterns at a glance.
    const byType: Record<string, number> = {}
    const accountTally: Record<string, number> = {}
    for (const inv of invoices) {
      byType[String(inv.type)] = (byType[String(inv.type)] || 0) + 1
      for (const l of inv.lines || []) if (l.account) accountTally[l.account] = (accountTally[l.account] || 0) + 1
    }

    return res.status(200).json({ cutoff, count: invoices.length, byType, accountTally, invoices })
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || 'Diagnostic failed' })
  }
})
