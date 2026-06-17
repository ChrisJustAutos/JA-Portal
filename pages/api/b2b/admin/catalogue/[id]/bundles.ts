// pages/api/b2b/admin/catalogue/[id]/bundles.ts
//
// Manage the "includes" bundle for a parent catalogue product.
//
//   GET  /api/b2b/admin/catalogue/{id}/bundles
//        → { children: [{ child_catalogue_id, qty, price_mode, sort_order, child:{...} }] }
//
//   PUT  /api/b2b/admin/catalogue/{id}/bundles
//        body: { children: [{ child_catalogue_id, qty?, price_mode? }] }
//        Replaces the whole set (delete-then-insert). Validates each child
//        exists, isn't the parent itself, and isn't duplicated.
//
// Permission: edit:b2b_catalogue (same as the catalogue editor).

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../../../lib/authServer'
import { loadBundleChildren } from '../../../../../../lib/b2b-bundles'

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

export default withAuth('edit:b2b_catalogue', async (req: NextApiRequest, res: NextApiResponse) => {
  const parentId = String(req.query.id || '').trim()
  if (!parentId) return res.status(400).json({ error: 'Missing id' })
  const c = sb()

  if (req.method === 'GET') {
    // Include hidden children here so the admin sees exactly what's configured.
    const map = await loadBundleChildren(c, [parentId], { includeHidden: true })
    const children = (map.get(parentId) || []).map(ch => ({
      child_catalogue_id: ch.child_catalogue_id,
      qty: ch.qty,
      price_mode: ch.price_mode,
      sort_order: ch.sort_order,
      child: ch.child,
    }))
    return res.status(200).json({ children })
  }

  if (req.method !== 'PUT') {
    res.setHeader('Allow', 'GET, PUT')
    return res.status(405).json({ error: 'GET or PUT only' })
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : {}
  const rawChildren = Array.isArray((body as any).children) ? (body as any).children : null
  if (rawChildren === null) return res.status(400).json({ error: 'children array required' })

  // Parse + validate the incoming rows.
  const seen = new Set<string>()
  const rows: { child_catalogue_id: string; qty: number; price_mode: 'included' | 'added'; sort_order: number }[] = []
  for (let i = 0; i < rawChildren.length; i++) {
    const r = rawChildren[i] || {}
    const childId = String(r.child_catalogue_id || '').trim()
    if (!childId) return res.status(400).json({ error: `children[${i}].child_catalogue_id required` })
    if (childId === parentId) return res.status(400).json({ error: 'A product cannot include itself' })
    if (seen.has(childId)) return res.status(400).json({ error: 'Duplicate child product in bundle' })
    seen.add(childId)
    const qty = Math.floor(Number(r.qty))
    if (!Number.isFinite(qty) || qty < 1) return res.status(400).json({ error: `children[${i}].qty must be an integer >= 1` })
    const price_mode = r.price_mode === 'added' ? 'added' : 'included'
    rows.push({ child_catalogue_id: childId, qty, price_mode, sort_order: i })
  }

  // Confirm the parent exists.
  const { data: parent, error: pErr } = await c
    .from('b2b_catalogue').select('id').eq('id', parentId).maybeSingle()
  if (pErr) return res.status(500).json({ error: pErr.message })
  if (!parent) return res.status(404).json({ error: 'Parent catalogue item not found' })

  // Confirm every child exists.
  if (rows.length > 0) {
    const { data: found, error: cErr } = await c
      .from('b2b_catalogue').select('id').in('id', rows.map(r => r.child_catalogue_id))
    if (cErr) return res.status(500).json({ error: cErr.message })
    const foundIds = new Set((found || []).map((x: any) => x.id))
    const missing = rows.filter(r => !foundIds.has(r.child_catalogue_id))
    if (missing.length > 0) return res.status(400).json({ error: 'One or more child products no longer exist' })
  }

  // Replace the set (delete-then-insert in one logical update).
  const { error: delErr } = await c.from('b2b_product_bundles').delete().eq('parent_catalogue_id', parentId)
  if (delErr) return res.status(500).json({ error: delErr.message })
  if (rows.length > 0) {
    const { error: insErr } = await c.from('b2b_product_bundles').insert(
      rows.map(r => ({ parent_catalogue_id: parentId, ...r })),
    )
    if (insErr) return res.status(500).json({ error: insErr.message })
  }

  const map = await loadBundleChildren(c, [parentId], { includeHidden: true })
  const children = (map.get(parentId) || []).map(ch => ({
    child_catalogue_id: ch.child_catalogue_id,
    qty: ch.qty,
    price_mode: ch.price_mode,
    sort_order: ch.sort_order,
    child: ch.child,
  }))
  return res.status(200).json({ ok: true, children })
})
