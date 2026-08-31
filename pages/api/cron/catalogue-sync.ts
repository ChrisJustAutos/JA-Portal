// pages/api/cron/catalogue-sync.ts
// Hourly: pull JAWS Inventory into b2b_catalogue (Chris, 2026-09-01).
//
// Until now the catalogue only refreshed when somebody pressed Sync on
// Admin → B2B → Catalogue, so an RRP or cost changed in MYOB sat stale in the
// portal until the next manual run.
//
// SAFE TO AUTOMATE because sync does not own the distributor's price.
// lib/b2b-catalogue-sync splits ownership: MYOB-canonical fields (sku, name,
// rrp_ex_gst, is_taxable, cost_price_ex_gst) are refreshed every run, while
// portal-canonical fields — trade_price_ex_gst, b2b_visible, description,
// category, images — are NEVER overwritten. An hourly run therefore cannot
// move what a distributor pays or make a hidden item visible.
//
// ⚠ The corollary, which is a real operational gap and not fixed by this cron:
// because trade_price_ex_gst is untouched, a price rise in MYOB updates the RRP
// and leaves the trade price where it was — so an item set at "20% off RRP"
// quietly becomes a deeper discount. The sync will never tell you. A drift
// report comparing trade price against current RRP is the fix; not built yet.
//
// Runs on the hour at :35 — deliberately off :00/:15/:30 where the every-10,
// -15 and -30-minute crons cluster.
//
// Auth: Bearer CRON_SECRET, with the vercel-cron user-agent fallback.
//   ?force=1 is accepted for a manual curl but changes nothing — the sync is
//   idempotent and has no marker to bypass.

import type { NextApiRequest, NextApiResponse } from 'next'
import { syncJawsCatalogue } from '../../../lib/b2b-catalogue-sync'

export const config = { maxDuration: 300 }

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const cronSecret = process.env.CRON_SECRET
  const authHeader = req.headers.authorization || ''
  const userAgent = String(req.headers['user-agent'] || '').toLowerCase()
  const authorized = cronSecret ? authHeader === `Bearer ${cronSecret}` : userAgent.includes('vercel-cron')
  if (!authorized) return res.status(401).json({ error: 'Unauthorised' })

  const startedMs = Date.now()
  try {
    // performedBy null — no user behind a cron run. The admin route passes the
    // pressing user's id, and the sync records that on its audit row.
    const result = await syncJawsCatalogue(null)
    const tookMs = Date.now() - startedMs

    // Log a line whether or not anything moved: a sync that silently stops
    // working looks identical to a sync with nothing to do, and that ambiguity
    // is exactly how a stale catalogue goes unnoticed for weeks.
    console.log(
      `catalogue-sync: scanned ${result.totalScanned}, added ${result.added}, `
      + `updated ${result.updated}, unchanged ${result.unchanged}, skipped ${result.skipped}, `
      + `errors ${result.errors.length} — ${tookMs}ms`,
    )
    if (result.errors.length) {
      console.error('catalogue-sync: item errors:', result.errors.slice(0, 10))
    }

    return res.status(200).json({ ok: true, tookMs, ...result })
  } catch (e: any) {
    // Throwing (rather than 200-with-error) so a failed run is visible as a
    // failed function in Vercel, not a green tick with a sad payload.
    console.error('catalogue-sync failed:', e?.message || e)
    return res.status(500).json({ ok: false, error: e?.message || String(e) })
  }
}
