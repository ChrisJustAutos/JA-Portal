// pages/api/admin/distributors-diag.ts
// GET ?start=2025-07-01&end=2026-06-30&q=penrith — reconciliation diagnostics
// for the Distributors report (built 2026-07-20 chasing the Penrith 4x4 EOFY
// undercount). Pulls the SAME raw MYOB invoices the report uses, then shows
// where dollars fall out of the report's pipeline:
//   1. customers matching ?q — raw MYOB card names, alias resolution, invoice
//      count + gross total straight off the invoice headers (no filtering)
//   2. their revenue split by account code, flagged whether each account is in
//      the report's category config (unconfigured = invisible on the report)
//   3. their invoices with ZERO configured lines (the "gaps" in the drill-down)
//   4. range-wide: top unconfigured account codes by ex-GST revenue across ALL
//      customers — systemic blind spots, not just this one customer.

import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../lib/authServer'
import { fetchSaleInvoicesWithLines, fetchSaleInvoices } from '../../../lib/myob-reporting'
import { lineExGst } from '../../../lib/gst'
import { getGrouping, groupNameFor } from '../../../lib/distGroups'

export const config = { maxDuration: 120 }

function sbAdmin() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

export default withAuth('view:reports', async (req, res) => {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'GET only' }) }
  const start = String(req.query.start || '2025-07-01')
  const end   = String(req.query.end   || '2026-06-30')
  const q     = String(req.query.q || '').trim().toLowerCase()
  // The report reads JAWS only; ?file=VPS lets reconciliation check whether
  // the "missing" revenue actually lives in the other company file.
  const file  = String(req.query.file || 'JAWS').toUpperCase() === 'VPS' ? 'VPS' as const : 'JAWS' as const

  // ?invoice=JAWS-1234 — trace one specific invoice number straight against
  // MYOB (no date filter): which type endpoint has it, whose card, what date.
  // Decisive for "I can see it in MYOB but not on the report".
  const invoiceNo = String(req.query.invoice || '').trim()
  if (invoiceNo) {
    const { fetchSaleInvoiceByNumber, fetchSaleInvoices } = await import('../../../lib/myob-reporting')
    const { sameInvoiceNumberLoose } = await import('../../../lib/ap-myob-bill')
    const hit = await fetchSaleInvoiceByNumber(file, invoiceNo)
    if (hit.invoice) return res.status(200).json({ file, invoice: invoiceNo, found: true, detail: hit })

    // Exact number missed — loose scan of recent headers (all types): catches
    // suffix variants ("JAWS-1364 - S", "CR JAWS-1364S") and near-misses.
    const sinceIso = new Date(Date.now() - 420 * 86400_000).toISOString().slice(0, 10)
    const headers = await fetchSaleInvoices(file, { start: sinceIso })
    const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '')
    const target = norm(invoiceNo)
    const candidates = headers
      .filter(h => h.Number && (norm(h.Number).includes(target) || sameInvoiceNumberLoose(h.Number, invoiceNo)))
      .slice(0, 10)
      .map(h => ({ number: h.Number, date: h.Date?.slice(0, 10), type: h.InvoiceType, customer: h.CustomerName, total: h.TotalAmount, status: h.Status }))
    return res.status(200).json({ file, invoice: invoiceNo, found: false, detail: null, looseMatches: candidates })
  }

  const catsRes = await sbAdmin().from('distributor_report_categories').select('name, account_codes')
  const accToCat = new Map<string, string>()
  for (const c of catsRes.data || []) for (const a of (c.account_codes || [])) accToCat.set(String(a), String(c.name))

  const grouping = await getGrouping()
  // endExclusive: day after `end`, matching the report's inclusive range.
  const endEx = new Date(Date.parse(end + 'T00:00:00Z') + 86400_000).toISOString().slice(0, 10)
  const { invoices, lines } = await fetchSaleInvoicesWithLines(file, { start, endExclusive: endEx })

  const linesByInv = new Map<string, typeof lines>()
  for (const l of lines) {
    const arr = linesByInv.get(l.SaleInvoiceId) || []
    arr.push(l); linesByInv.set(l.SaleInvoiceId, arr)
  }

  // 4. range-wide unconfigured accounts (all customers)
  const unconfigured = new Map<string, { name: string | null; total: number }>()
  for (const inv of invoices) {
    for (const l of linesByInv.get(inv.ID) || []) {
      const acc = l.AccountDisplayID || '(none)'
      if (accToCat.has(acc)) continue
      const amt = lineExGst(Number(l.Total) || 0, inv.IsTaxInclusive, l.TaxCodeCode)
      const e = unconfigured.get(acc) || { name: l.AccountName, total: 0 }
      e.total += amt; unconfigured.set(acc, e)
    }
  }

  // 1-3. per matching customer
  const matches = q ? invoices.filter(i => (i.CustomerName || '').toLowerCase().includes(q)) : []
  const byCard = new Map<string, any>()
  for (const inv of matches) {
    const raw = inv.CustomerName || '(none)'
    if (!byCard.has(raw)) {
      const canonical = grouping.aliasMap[raw] || raw
      byCard.set(raw, {
        myobCardName: raw,
        canonical,
        typeGroup: groupNameFor(canonical, 'type', grouping) || '(none → shown as distributor)',
        invoiceCount: 0, grossTotal: 0, byAccount: {} as Record<string, any>,
        invoicesWithZeroConfiguredLines: [] as any[],
      })
    }
    const c = byCard.get(raw)
    c.invoiceCount++; c.grossTotal += Number(inv.TotalAmount) || 0
    let configuredSum = 0
    for (const l of linesByInv.get(inv.ID) || []) {
      const acc = l.AccountDisplayID || '(none)'
      const amt = lineExGst(Number(l.Total) || 0, inv.IsTaxInclusive, l.TaxCodeCode)
      const slot = c.byAccount[acc] || { accountName: l.AccountName, category: accToCat.get(acc) || 'NOT CONFIGURED', total: 0 }
      slot.total = Math.round((slot.total + amt) * 100) / 100
      c.byAccount[acc] = slot
      if (accToCat.has(acc)) configuredSum += amt
    }
    if (configuredSum < 0.005) {
      c.invoicesWithZeroConfiguredLines.push({
        number: inv.Number, date: inv.Date?.slice(0, 10), total: inv.TotalAmount, type: inv.InvoiceType,
        accounts: (linesByInv.get(inv.ID) || []).map(l => l.AccountDisplayID),
      })
    }
  }

  // Cross-check: the bare /Sale/Invoice endpoint spans ALL invoice types
  // (header-only). Anything it has that the typed pull lacks = an invoice
  // type we aren't fetching lines for.
  const headers = await fetchSaleInvoices(file, { start, endExclusive: endEx })
  const typedIds = new Set(invoices.map(i => i.ID))
  const missingFromTyped = headers.filter(h => !typedIds.has(h.ID))

  // ?samples=1 — raw line samples for the matching customers, split
  // tuning-vs-parts by the category config. For designing the per-vehicle
  // breakdown: shows whether descriptions/items carry the vehicle type.
  const wantSamples = String(req.query.samples || '') === '1'
  const lineSamples: any = wantSamples ? { tuning: [], parts: [] } : undefined
  if (wantSamples) {
    const catByAcc = accToCat
    const matchIds = new Set(matches.map(i => i.ID))
    for (const l of lines) {
      if (!matchIds.has(l.SaleInvoiceId)) continue
      const cat = catByAcc.get(l.AccountDisplayID || '')
      const bucket = cat === 'Tuning' ? lineSamples.tuning : cat === 'Parts' ? lineSamples.parts : null
      if (bucket && bucket.length < 40) bucket.push({
        account: l.AccountDisplayID, item: l.ItemNumber, itemName: l.ItemName,
        description: (l.Description || '').slice(0, 120), total: l.Total,
      })
    }
  }

  const out = {
    range: { start, end }, q, file,
    lineSamples,
    crossCheck: {
      headerEndpointCount: headers.length,
      typedEndpointsCount: invoices.length,
      missingFromTypedCount: missingFromTyped.length,
      missingByType: missingFromTyped.reduce((m: Record<string, number>, h) => { const t = h.InvoiceType || '?'; m[t] = (m[t] || 0) + 1; return m }, {}),
      missingSample: missingFromTyped.slice(0, 15).map(h => ({ number: h.Number, date: h.Date?.slice(0, 10), type: h.InvoiceType, customer: h.CustomerName, total: h.TotalAmount })),
      missingMatchingQ: q ? missingFromTyped.filter(h => (h.CustomerName || '').toLowerCase().includes(q)).map(h => ({ number: h.Number, date: h.Date?.slice(0, 10), type: h.InvoiceType, total: h.TotalAmount })) : [],
    },
    pull: {
      invoices: invoices.length, lines: lines.length,
      byType: invoices.reduce((m: Record<string, number>, i) => { const t = i.InvoiceType || '?'; m[t] = (m[t] || 0) + 1; return m }, {}),
    },
    customers: Array.from(byCard.values()).map(c => ({ ...c, grossTotal: Math.round(c.grossTotal * 100) / 100 })),
    unconfiguredAccountsRangeWide: Array.from(unconfigured.entries())
      .map(([code, v]) => ({ code, name: v.name, exGstTotal: Math.round(v.total * 100) / 100 }))
      .sort((a, b) => b.exGstTotal - a.exGstTotal).slice(0, 25),
  }
  console.log('[distributors-diag]', JSON.stringify(out).slice(0, 4000))
  return res.status(200).json(out)
})
