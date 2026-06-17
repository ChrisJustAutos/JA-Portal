// pages/api/workshop/prepick/pdf.ts
// POST — renders the Pre Pick list the screen is showing as a stylised PDF.
// The client sends the already-filtered rows + summary (so the PDF matches the
// view exactly, including the live low-warning threshold and active filter).
// Gated view:diary.

import type { NextApiRequest, NextApiResponse } from 'next'
import { withAuth } from '../../../../lib/authServer'
import { renderPrePickPdf } from '../../../../lib/workshop/prepick-pdf'
import type { PrePickPdfPayload, PrePickPdfItem } from '../../../../lib/workshop/prepick-pdf'

export const config = { maxDuration: 60, api: { bodyParser: { sizeLimit: '6mb' } } }

const n = (v: any) => { const x = Number(v); return isFinite(x) ? x : 0 }

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }) }

  let body: any = {}
  try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
  catch { return res.status(400).json({ error: 'Bad JSON body' }) }

  const rawItems = Array.isArray(body.items) ? body.items : []
  const items: PrePickPdfItem[] = rawItems.slice(0, 5000).map((it: any) => {
    const status: PrePickPdfItem['status'] = it.status === 'red' || it.status === 'orange' ? it.status : 'green'
    return {
      sku: String(it.sku || ''),
      part_name: String(it.part_name || ''),
      supplier: it.supplier ? String(it.supplier) : null,
      location: it.location ? String(it.location) : null,
      buy_price: it.buy_price != null ? n(it.buy_price) : null,
      to_pick: n(it.to_pick),
      current_stock: n(it.current_stock),
      remaining: n(it.remaining),
      to_order: n(it.to_order),
      status,
    }
  })

  const payload: PrePickPdfPayload = {
    from: body.from || null,
    to: body.to || null,
    synced_at: body.synced_at || null,
    generated_at: new Date().toISOString(),
    jobs_count: n(body.jobs_count),
    low_threshold: n(body.low_threshold) || 5,
    filter_label: String(body.filter_label || 'All'),
    counts: {
      green: n(body.counts?.green),
      orange: n(body.counts?.orange),
      red: n(body.counts?.red),
      orderCount: n(body.counts?.orderCount),
      orderValue: n(body.counts?.orderValue),
    },
    items,
  }

  try {
    const buffer = await renderPrePickPdf(payload)
    const tag = `${(payload.from || '').replace(/-/g, '')}_${(payload.to || '').replace(/-/g, '')}`
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="pre-pick-${tag || 'list'}.pdf"`)
    res.setHeader('Content-Length', String(buffer.length))
    res.status(200).send(buffer)
  } catch (err: any) {
    console.error('Pre Pick PDF render failed:', err?.message)
    res.status(500).json({ error: `PDF render failed: ${err?.message}` })
  }
}

export default withAuth('view:diary', handler)
