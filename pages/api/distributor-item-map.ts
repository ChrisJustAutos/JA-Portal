// pages/api/distributor-item-map.ts
// Parts-item → vehicle-model tick map for the Distributors Parts:Tunes view.
//   GET  → { items: [{ item_number, item_name, models: string[] }] }
//   POST → { items: [{ item_number, item_name?, models: string[] }] }
//          Replaces each posted item's ticks wholesale (empty models = untick
//          everything). Items not posted are left untouched.
// Model names are the VIN-rule model names (vin_model_codes) — the same
// buckets the Distributor Sales tab derives from tune-invoice VINs.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { requireAuth } from '../../lib/auth'

function getSb() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars not configured')
  return createClient(url, key, { auth: { persistSession: false } })
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  return requireAuth(req, res, async () => {
    const sb = getSb()

    if (req.method === 'GET') {
      const { data, error } = await sb.from('dist_item_model_map')
        .select('item_number, item_name, model').order('item_number')
      if (error) return res.status(500).json({ error: error.message })
      const byItem = new Map<string, { item_number: string; item_name: string | null; models: string[] }>()
      for (const r of (data || []) as Array<{ item_number: string; item_name: string | null; model: string }>) {
        const e = byItem.get(r.item_number) || { item_number: r.item_number, item_name: r.item_name, models: [] }
        e.models.push(r.model)
        if (!e.item_name && r.item_name) e.item_name = r.item_name
        byItem.set(r.item_number, e)
      }
      return res.status(200).json({ items: Array.from(byItem.values()) })
    }

    if (req.method === 'POST') {
      const items: any[] = Array.isArray(req.body?.items) ? req.body.items : []
      if (!items.length) return res.status(400).json({ error: 'items required' })
      for (const it of items) {
        const num = String(it.item_number || '').trim()
        if (!num) continue
        const models: string[] = Array.isArray(it.models) ? it.models.map(String).filter(Boolean) : []
        const del = await sb.from('dist_item_model_map').delete().eq('item_number', num)
        if (del.error) return res.status(500).json({ error: del.error.message })
        if (models.length) {
          const ins = await sb.from('dist_item_model_map').insert(models.map(m => ({
            item_number: num, item_name: it.item_name || null, model: m,
          })))
          if (ins.error) return res.status(500).json({ error: ins.error.message })
        }
      }
      return res.status(200).json({ ok: true, saved: items.length })
    }

    res.setHeader('Allow', 'GET, POST')
    return res.status(405).json({ error: 'GET or POST only' })
  })
}
