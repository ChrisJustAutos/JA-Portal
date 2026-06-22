// pages/api/ap/statement/scans.ts
// GET — recent automated statement-watch scans (ap_statement_scans), for the
// "Auto-scan history" panel on /ap/statement. Read-only. Gated view:supplier_invoices.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../lib/authServer'

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  _sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  return _sb
}

export default withAuth('view:supplier_invoices', async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'GET only' }) }
  const limit = Math.min(Math.max(parseInt(String(req.query.limit || '40'), 10) || 40, 1), 200)
  const { data, error } = await sb()
    .from('ap_statement_scans')
    .select('id, company_file, supplier_name, supplier_uid, attachment_name, match_status, invoice_lines, missing_count, missing, error, scanned_at')
    .order('scanned_at', { ascending: false })
    .limit(limit)
  if (error) return res.status(500).json({ error: error.message })
  return res.status(200).json({ scans: data || [] })
})
