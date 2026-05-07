// pages/api/ap/admin/backfill-contact.ts
//
// One-off backfill: re-runs the AI extractor against the stored PDF for
// invoices that don't yet have the new vendor contact fields (email,
// phone, website, address). Only writes those 8 columns — leaves
// everything else (totals, lines, triage, mappings) untouched.
//
//   GET  /api/ap/admin/backfill-contact            → preview eligible rows
//   POST /api/ap/admin/backfill-contact?limit=25   → run backfill (default 25, max 100)
//
// Eligibility: vendor_email IS NULL AND vendor_phone IS NULL AND
// vendor_street IS NULL AND status != 'posted' AND pdf_storage_path
// IS NOT NULL.
//
// Posted invoices are skipped — there's no reason to re-touch a row that's
// already in MYOB. If fewer fields than expected come back from a re-parse
// (e.g. the PDF doesn't actually show a phone number), the row's columns
// stay NULL and the invoice still counts as "processed" so it's not picked
// up again on the next run.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../lib/authServer'
import { extractInvoiceFromPdf } from '../../../../lib/ap-extraction'

const STORAGE_BUCKET = 'ap-invoices'

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

export const config = { maxDuration: 300 }

interface EligibleRow {
  id: string
  vendor_name_parsed: string | null
  invoice_number: string | null
  pdf_storage_path: string | null
}

async function fetchEligible(c: SupabaseClient, limit: number): Promise<EligibleRow[]> {
  // We treat a row as needing backfill when none of the new fields are set.
  // (Old rows have all 8 = NULL; rows already processed by the new extractor
  // will have at least one filled and so are excluded.)
  const { data, error } = await c
    .from('ap_invoices')
    .select('id, vendor_name_parsed, invoice_number, pdf_storage_path')
    .neq('status', 'posted')
    .not('pdf_storage_path', 'is', null)
    .is('vendor_email', null)
    .is('vendor_phone', null)
    .is('vendor_website', null)
    .is('vendor_street', null)
    .is('vendor_city', null)
    .is('vendor_state', null)
    .is('vendor_postcode', null)
    .is('vendor_country', null)
    .order('received_at', { ascending: false })
    .limit(limit)
  if (error) throw new Error(error.message)
  return (data || []) as EligibleRow[]
}

export default withAuth('admin:settings', async (req: NextApiRequest, res: NextApiResponse) => {
  const c = sb()

  if (req.method === 'GET') {
    const eligible = await fetchEligible(c, 200)
    return res.status(200).json({ count: eligible.length, sample: eligible.slice(0, 10) })
  }

  if (req.method === 'POST') {
    const limit = Math.min(Math.max(parseInt(String(req.query.limit || '25'), 10) || 25, 1), 100)
    const eligible = await fetchEligible(c, limit)

    const results: Array<{ id: string; ok: boolean; updated?: string[]; error?: string }> = []

    for (const inv of eligible) {
      try {
        if (!inv.pdf_storage_path) {
          results.push({ id: inv.id, ok: false, error: 'no pdf_storage_path' })
          continue
        }
        const { data: blob, error: dlErr } = await c.storage
          .from(STORAGE_BUCKET)
          .download(inv.pdf_storage_path)
        if (dlErr || !blob) {
          results.push({ id: inv.id, ok: false, error: dlErr?.message || 'PDF download returned empty' })
          continue
        }
        const arr = new Uint8Array(await blob.arrayBuffer())
        const b64 = Buffer.from(arr).toString('base64')
        const { invoice: ex } = await extractInvoiceFromPdf(b64)

        // Only update the new contact / address fields. Everything else
        // (line items, totals, triage state, supplier mapping) is left
        // alone — those may have been edited since the original extract.
        const patch: Record<string, any> = {
          vendor_email:    ex.vendor.email,
          vendor_phone:    ex.vendor.phone,
          vendor_website:  ex.vendor.website,
          vendor_street:   ex.vendor.street,
          vendor_city:     ex.vendor.city,
          vendor_state:    ex.vendor.state,
          vendor_postcode: ex.vendor.postcode,
          vendor_country:  ex.vendor.country,
        }
        const filled = Object.entries(patch).filter(([_, v]) => !!v).map(([k]) => k)

        const { error: upErr } = await c.from('ap_invoices').update(patch).eq('id', inv.id)
        if (upErr) {
          results.push({ id: inv.id, ok: false, error: upErr.message })
          continue
        }
        results.push({ id: inv.id, ok: true, updated: filled })
      } catch (e: any) {
        results.push({ id: inv.id, ok: false, error: e?.message || String(e) })
      }
    }

    const okCount  = results.filter(r => r.ok).length
    const errCount = results.length - okCount
    return res.status(200).json({
      processed: results.length,
      ok: okCount,
      failed: errCount,
      results,
    })
  }

  res.setHeader('Allow', 'GET, POST')
  return res.status(405).json({ error: 'Method not allowed' })
})
