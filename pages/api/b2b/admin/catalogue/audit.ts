// pages/api/b2b/admin/catalogue/audit.ts
//
// Catalogue audit CSV — every catalogue item with its visibility, pricing,
// stock, image/model/type coverage, and a computed "issues" column flagging
// gaps that affect what distributors can see/find:
//   • HIDDEN                          — not published to distributors
//   • no image                        — visible but no product photo
//   • no model (hidden from browse)   — visible but no vehicle model → unreachable
//                                        via the model→type browse flow (search only)
//   • dropship 0-stock: check orderable
//   • zero stock                      — visible, stocked item with 0 on-hand/available
//   • no trade price
//   • hidden but priced+stocked: review to publish
//
// Opens as a download in the browser. Gated on view:b2b.
//   https://justautos.app/api/b2b/admin/catalogue/audit

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../../lib/authServer'

function sb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  )
}

const yn = (v: any) => (v ? 'Y' : 'N')
const csvCell = (v: any) => {
  const s = v == null ? '' : String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export default withAuth('view:b2b', async (_req: NextApiRequest, res: NextApiResponse) => {
  const db = sb()

  const [{ data: cat, error }, { data: ptypes }, { data: models }, { data: links }] = await Promise.all([
    db.from('b2b_catalogue').select('id, sku, name, b2b_visible, trade_price_ex_gst, rrp_ex_gst, qty_on_hand, qty_available, primary_image_url, model_id, product_type_id, is_drop_ship, is_special_order, is_inventoried, call_for_availability_when_zero, last_synced_from_myob_at'),
    db.from('b2b_product_types').select('id, name'),
    db.from('b2b_models').select('id, name'),
    db.from('b2b_catalogue_models').select('catalogue_id, model_id'),
  ])
  if (error) return res.status(500).json({ error: error.message })

  const ptypeById = new Map((ptypes || []).map((p: any) => [p.id, p.name]))
  const modelById = new Map((models || []).map((m: any) => [m.id, m.name]))
  const modelsByCat = new Map<string, string[]>()
  for (const l of (links || []) as any[]) {
    const arr = modelsByCat.get(l.catalogue_id) || []
    const nm = modelById.get(l.model_id)
    if (nm) arr.push(nm)
    modelsByCat.set(l.catalogue_id, arr)
  }

  const rows = (cat || []).map((r: any) => {
    const onHand = Number(r.qty_on_hand) || 0
    const avail = Number(r.qty_available) || 0
    const trade = Number(r.trade_price_ex_gst) || 0
    const hasImg = !!(r.primary_image_url && r.primary_image_url.trim())
    const linkedModels = modelsByCat.get(r.id) || []
    const hasModel = !!r.model_id || linkedModels.length > 0

    const issues: string[] = []
    if (!r.b2b_visible) issues.push('HIDDEN')
    if (r.b2b_visible && !hasImg) issues.push('no image')
    if (r.b2b_visible && !hasModel) issues.push('no model (hidden from model browse)')
    if (r.b2b_visible && onHand <= 0 && avail <= 0 && r.is_drop_ship) issues.push('dropship 0-stock: check orderable')
    if (r.b2b_visible && onHand <= 0 && avail <= 0 && !r.is_drop_ship && !r.is_special_order) issues.push('zero stock')
    if (trade <= 0) issues.push('no trade price')
    if (!r.b2b_visible && trade > 0 && onHand > 0 && r.is_inventoried) issues.push('hidden but priced+stocked: review to publish')

    return {
      visible: yn(r.b2b_visible),
      sku: r.sku || '',
      name: r.name || '',
      product_type: ptypeById.get(r.product_type_id) || '',
      models: linkedModels.sort().join(' | '),
      trade,
      rrp: Number(r.rrp_ex_gst) || 0,
      on_hand: onHand,
      available: avail,
      image: yn(hasImg),
      has_model: yn(hasModel),
      dropship: yn(r.is_drop_ship),
      special_order: yn(r.is_special_order),
      inventoried: yn(r.is_inventoried),
      issues: issues.join('; '),
    }
  })

  // Sort: visible first, then items-with-issues first, then by name.
  rows.sort((a, b) =>
    (a.visible === b.visible ? 0 : a.visible === 'Y' ? -1 : 1) ||
    ((a.issues ? 0 : 1) - (b.issues ? 0 : 1)) ||
    a.name.localeCompare(b.name),
  )

  const headers = ['Visible', 'SKU', 'Name', 'Product Type', 'Models', 'Trade ex GST', 'RRP ex GST', 'On Hand', 'Available', 'Image', 'HasModel', 'Dropship', 'SpecialOrder', 'Inventoried', 'Issues']
  const lines = [headers.join(',')]
  for (const r of rows) {
    lines.push([r.visible, r.sku, r.name, r.product_type, r.models, r.trade, r.rrp, r.on_hand, r.available, r.image, r.has_model, r.dropship, r.special_order, r.inventoried, r.issues].map(csvCell).join(','))
  }
  const lastSync = (cat || []).reduce((mx: string, r: any) => (r.last_synced_from_myob_at && r.last_synced_from_myob_at > mx ? r.last_synced_from_myob_at : mx), '')
  lines.push('')
  lines.push(csvCell(`Generated from live catalogue. Last MYOB sync: ${lastSync || 'unknown'}. ${rows.length} items, ${rows.filter(r => r.visible === 'Y').length} visible to distributors.`))

  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', 'attachment; filename="b2b-catalogue-audit.csv"')
  return res.status(200).send('﻿' + lines.join('\r\n'))
})
