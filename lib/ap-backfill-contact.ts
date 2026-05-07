// lib/ap-backfill-contact.ts
// Shared logic for the contact-fields backfill — re-runs the AI extractor
// against the stored PDF for invoices that don't yet have the new vendor
// contact fields (email, phone, website, address). Only writes those 8
// columns; lines, totals, triage and supplier mapping are left alone.
//
// Used by:
//   - pages/api/ap/admin/backfill-contact.ts   (portal session, admin only)
//   - pages/api/ap/admin/automation.ts          (Bearer AP_AUTOMATION_API_KEY,
//     action='backfill_contact' — for cron / mobile / off-portal invocation)

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { extractInvoiceFromPdf } from './ap-extraction'

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

export interface BackfillEligibleRow {
  id: string
  vendor_name_parsed: string | null
  invoice_number: string | null
  pdf_storage_path: string | null
}

export async function fetchBackfillEligible(limit: number): Promise<BackfillEligibleRow[]> {
  const c = sb()
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
  return (data || []) as BackfillEligibleRow[]
}

export interface BackfillResult {
  processed: number
  ok: number
  failed: number
  results: Array<{ id: string; ok: boolean; updated?: string[]; error?: string }>
}

export async function runContactBackfill(opts: { limit?: number } = {}): Promise<BackfillResult> {
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100)
  const c = sb()
  const eligible = await fetchBackfillEligible(limit)

  const results: BackfillResult['results'] = []
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
  return {
    processed: results.length,
    ok: okCount,
    failed: results.length - okCount,
    results,
  }
}
