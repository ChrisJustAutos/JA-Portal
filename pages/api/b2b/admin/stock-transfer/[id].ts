// pages/api/b2b/admin/stock-transfer/[id].ts
// Service-token endpoint for the MechanicDesk purchase-order worker
// (GH Actions). Mirrors the stocktake worker's auth (X-Service-Token, scope
// 'stocktake:write').
//
// GET   → transfer header + lines + the MD supplier id to raise the PO on.
// PATCH → report MD PO outcome back: { md_po_status, md_po_ref, md_po_error }.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { validateServiceToken } from '../../../../../lib/service-auth'

function sb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  )
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const id = req.query.id as string
  if (!id) return res.status(400).json({ error: 'Missing transfer id' })

  const svc = await validateServiceToken(req, 'stocktake:write')
  if (!svc) return res.status(401).json({ error: 'Invalid or missing X-Service-Token (scope stocktake:write)' })

  const c = sb()

  if (req.method === 'GET') {
    const { data: transfer, error } = await c
      .from('b2b_stock_transfers')
      .select('id, direction, status, po_reference, note, line_count, md_po_status')
      .eq('id', id).maybeSingle()
    if (error) return res.status(500).json({ error: error.message })
    if (!transfer) return res.status(404).json({ error: 'Transfer not found' })
    const { data: lines } = await c
      .from('b2b_stock_transfer_lines')
      .select('sku, name, qty, unit_cost_ex, is_taxable')
      .eq('transfer_id', id).order('sort_order', { ascending: true })
    // The MD supplier the PO is raised on (the "Just Autos Wholesale" card in
    // the workshop's MD) is configured once in b2b_settings.
    const { data: settings } = await c
      .from('b2b_settings').select('md_purchase_supplier_id').eq('id', 'singleton').maybeSingle()
    return res.status(200).json({
      transfer,
      lines: lines || [],
      md_supplier_id: settings?.md_purchase_supplier_id || null,
    })
  }

  if (req.method === 'PATCH') {
    let body: any = {}
    try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
    catch { return res.status(400).json({ error: 'Bad JSON body' }) }
    const update: Record<string, any> = { md_po_updated_at: new Date().toISOString() }
    if ('md_po_status' in body) update.md_po_status = body.md_po_status ? String(body.md_po_status) : null
    if ('md_po_ref' in body)    update.md_po_ref = body.md_po_ref ? String(body.md_po_ref) : null
    if ('md_po_error' in body)  update.md_po_error = body.md_po_error ? String(body.md_po_error).slice(0, 1000) : null
    const { error } = await c.from('b2b_stock_transfers').update(update).eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  res.setHeader('Allow', 'GET, PATCH')
  return res.status(405).json({ error: 'GET or PATCH only' })
}
