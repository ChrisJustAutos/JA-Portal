// pages/api/workshop/labels.ts
// GET ?ids=<uuid,uuid…>&copies=N&layout=KEY&skip=N
//   → renders a printable A4 parts-label sheet (PDF, Code 128 barcodes) for the
//     given inventory items, inline so it opens in a tab for the browser print
//     dialog (prints on any printer). Gated view:diary.

import type { NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../lib/authServer'
import { renderLabelSheetPdf, getLayout, LabelItem } from '../../../lib/workshop-label-pdf'

export const config = { maxDuration: 30 }

function sb(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase not configured')
  return createClient(url, key, { auth: { persistSession: false } })
}

export default withAuth('view:diary', async (req, res: NextApiResponse) => {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'GET only' }) }

  const ids = String(req.query.ids || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 500)
  if (!ids.length) return res.status(400).json({ error: 'ids required' })
  const copies = Math.min(Math.max(parseInt(String(req.query.copies || '1'), 10) || 1, 1), 100)
  const skip = Math.min(Math.max(parseInt(String(req.query.skip || '0'), 10) || 0, 0), 200)
  const layout = getLayout(String(req.query.layout || ''))

  const db = sb()
  const { data, error } = await db.from('workshop_inventory')
    .select('id, sku, part_name, sell_price, location, bin, barcode')
    .in('id', ids)
  if (error) return res.status(500).json({ error: error.message })

  const byId = new Map((data || []).map((r: any) => [r.id, r]))
  const items: LabelItem[] = []
  for (const id of ids) {                       // preserve the requested order
    const r = byId.get(id)
    if (!r) continue
    const item: LabelItem = {
      name: r.part_name || r.sku || '',
      sku: r.sku || '',
      barcodeValue: (r.barcode && String(r.barcode).trim()) || r.sku || r.id,
      price: r.sell_price != null ? Number(r.sell_price) : null,
      location: r.location || null,
      bin: r.bin || null,
    }
    for (let c = 0; c < copies; c++) items.push(item)
  }
  if (!items.length) return res.status(404).json({ error: 'no_items' })

  try {
    const pdf = await renderLabelSheetPdf(items, layout, skip)
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', 'inline; filename="parts-labels.pdf"')
    res.setHeader('Cache-Control', 'no-store')
    return res.status(200).send(pdf)
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || 'render_failed' })
  }
})
