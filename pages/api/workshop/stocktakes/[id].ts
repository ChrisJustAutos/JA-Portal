// pages/api/workshop/stocktakes/[id].ts
//   GET   [?q=&filter=uncounted|variance]  — session + items + live variance
//   PATCH {item_id, counted_qty, note?} | {items:[...]} | {name} | {status:'review'|'counting'}
//   POST  ?apply=1 {uncounted_policy}     — apply adjustments (MYOB when posting enabled)
//   DELETE                                — cancel a session (not applied ones)

import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../lib/authServer'
import { roleHasPermission } from '../../../../lib/permissions'
import { applyStocktake, computeVariance, WorkshopStocktakeError } from '../../../../lib/workshop-stocktake'

export const config = { maxDuration: 300 }

function sb() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

async function loadItems(db: any, id: string): Promise<any[]> {
  const items: any[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from('workshop_stocktake_items').select('*').eq('stocktake_id', id).order('sku').range(from, from + 999)
    if (error) throw new Error(error.message)
    if (!data || !data.length) break
    items.push(...data)
    if (data.length < 1000) break
  }
  return items
}

export default withAuth('view:stocktakes', async (req, res, user) => {
  const id = String(req.query.id || '').trim()
  if (!id) return res.status(400).json({ error: 'id required' })
  const db = sb()
  const canEdit = roleHasPermission(user.role, 'edit:stocktakes')

  if (req.method === 'GET') {
    const { data: session, error } = await db.from('workshop_stocktakes').select('*').eq('id', id).maybeSingle()
    if (error) return res.status(500).json({ error: error.message })
    if (!session) return res.status(404).json({ error: 'Stocktake not found' })
    let items = await loadItems(db, id)
    const variance = computeVariance(items, session.uncounted_policy || 'keep')
    const q = String(req.query.q || '').trim().toLowerCase()
    const filter = String(req.query.filter || '')
    if (q) items = items.filter(i => String(i.sku || '').toLowerCase().includes(q) || String(i.part_name || '').toLowerCase().includes(q) || String(i.barcode || '').toLowerCase() === q)
    if (filter === 'uncounted') items = items.filter(i => i.counted_qty == null)
    else if (filter === 'variance') items = items.filter(i => i.counted_qty != null && Number(i.counted_qty) !== Number(i.system_qty))
    return res.status(200).json({
      stocktake: session,
      items: items.slice(0, 500),
      itemTotal: items.length,
      summary: { counted: variance.counted, uncounted: variance.uncounted, varianceQty: variance.varianceQty, varianceValue: variance.varianceValue, adjustments: variance.deltas.length },
    })
  }

  if (!canEdit) return res.status(403).json({ error: 'Forbidden' })
  let body: any = {}
  try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
  catch { return res.status(400).json({ error: 'Bad JSON body' }) }

  if (req.method === 'PATCH') {
    const counts: Array<{ item_id: string; counted_qty: number | null; note?: string }> =
      Array.isArray(body.items) ? body.items : (body.item_id ? [{ item_id: body.item_id, counted_qty: body.counted_qty, note: body.note }] : [])
    for (const it of counts) {
      const qty = it.counted_qty == null || it.counted_qty === ('' as any) ? null : Number(it.counted_qty)
      await db.from('workshop_stocktake_items').update({
        counted_qty: qty != null && isFinite(qty) ? qty : null,
        counted_by: user.id, counted_at: new Date().toISOString(),
        ...(it.note !== undefined ? { note: it.note || null } : {}),
      }).eq('id', String(it.item_id)).eq('stocktake_id', id)
    }
    const patch: any = {}
    if (typeof body.name === 'string' && body.name.trim()) patch.name = body.name.trim().slice(0, 120)
    if (body.status === 'review' || body.status === 'counting') patch.status = body.status
    if (Object.keys(patch).length) await db.from('workshop_stocktakes').update(patch).eq('id', id)
    if (counts.length) {
      const { count } = await db.from('workshop_stocktake_items').select('id', { count: 'exact', head: true }).eq('stocktake_id', id).not('counted_qty', 'is', null)
      await db.from('workshop_stocktakes').update({ counted_count: count || 0 }).eq('id', id)
    }
    return res.status(200).json({ ok: true })
  }

  if (req.method === 'POST' && String(req.query.apply || '') === '1') {
    try {
      const result = await applyStocktake(id, body.uncounted_policy === 'zero' ? 'zero' : 'keep', user.id)
      return res.status(200).json({ ok: true, ...result })
    } catch (e: any) {
      if (e instanceof WorkshopStocktakeError) return res.status(409).json({ error: e.message, code: e.code })
      return res.status(500).json({ error: e?.message || 'Apply failed' })
    }
  }

  if (req.method === 'DELETE') {
    const { data: session } = await db.from('workshop_stocktakes').select('status').eq('id', id).maybeSingle()
    if (!session) return res.status(404).json({ error: 'Stocktake not found' })
    if (session.status === 'applied') return res.status(409).json({ error: 'Applied stocktakes can’t be cancelled.' })
    await db.from('workshop_stocktakes').update({ status: 'cancelled', deleted_at: new Date().toISOString() }).eq('id', id)
    return res.status(200).json({ ok: true })
  }

  res.setHeader('Allow', 'GET, PATCH, POST, DELETE')
  return res.status(405).json({ error: 'Unsupported method' })
})
