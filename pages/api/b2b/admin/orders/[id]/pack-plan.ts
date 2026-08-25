// GET/POST /api/b2b/admin/orders/{id}/pack-plan — the "Combine consignments"
// tool. GET returns the order's EFFECTIVE consignment plan (the saved manual
// plan if one exists, else what the cartonizer would produce right now) plus
// the configured standard boxes. POST { action:'combine', indexes, box? }
// merges the selected consignments into one box and saves the WHOLE plan on
// the order (freight_pack_plan); POST { action:'reset' } returns to automatic
// packing. Freight booking and the pick list both use the saved plan verbatim,
// so what MachShip charges is exactly what the warehouse packs.
//
// Combining is a pre-booking operation: once a consignment exists the plan is
// locked (rebooking with force would honour a change, but that's deliberate).

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../../../lib/authServer'
import { loadOrderPackInput } from '../../../../../../lib/b2b-freight-book'
import { packOrderUnits, parsePackPlanUnits } from '../../../../../../lib/b2b-freight'
import { isManifested } from '../../../../../../lib/b2b-despatch-state'
import type { PackedUnit, PackedContent } from '../../../../../../lib/b2b-cartonizer'

let _sb: SupabaseClient | null = null
function svc(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

const validMode = (m: any): 'auto' | 'pallet' | 'cartons' | undefined =>
  (m === 'pallet' || m === 'cartons' || m === 'auto') ? m : undefined

// The order's effective plan: saved manual plan, else a fresh cartonizer run.
async function effectiveUnits(c: SupabaseClient, order: any): Promise<{ units: PackedUnit[]; overridden: boolean } | { httpStatus: number; error: string; detail?: any }> {
  const saved = parsePackPlanUnits(order.freight_pack_plan)
  if (saved) return { units: saved, overridden: true }
  const loaded = await loadOrderPackInput(c, order.id)
  if ('error' in loaded) return loaded
  const packed = loaded.packInput.length > 0
    ? await packOrderUnits(loaded.packInput, { packMode: validMode(order.freight_pack_mode) })
    : null
  if (!packed) return { httpStatus: 400, error: 'No packable lines (or no standard boxes configured) — nothing to combine.' }
  return { units: packed.units, overridden: false }
}

function mergeContents(units: PackedUnit[]): PackedContent[] {
  const bySku = new Map<string, PackedContent>()
  for (const u of units) for (const cl of u.contents || []) {
    const key = cl.sku || cl.name
    const cur = bySku.get(key)
    if (cur) cur.qty += cl.qty
    else bySku.set(key, { ...cl })
  }
  return Array.from(bySku.values())
}

export default withAuth('edit:b2b_orders', async (req: NextApiRequest, res: NextApiResponse) => {
  const orderId = String(req.query.id || '').trim()
  if (!orderId) return res.status(400).json({ error: 'Missing order id' })
  const c = svc()

  const { data: order, error: oErr } = await c.from('b2b_orders')
    .select('id, order_number, status, machship_consignment_id, machship_manifest_id, freight_status, freight_pack_mode, freight_pack_plan')
    .eq('id', orderId).maybeSingle()
  if (oErr) return res.status(500).json({ error: oErr.message })
  if (!order) return res.status(404).json({ error: 'Order not found' })

  if (req.method === 'GET') {
    const eff = await effectiveUnits(c, order)
    if ('error' in eff) return res.status(eff.httpStatus).json({ error: eff.error, detail: eff.detail })
    const { data: boxes } = await c.from('b2b_freight_boxes')
      .select('name, length_mm, width_mm, height_mm, max_weight_g')
      .eq('is_active', true).order('sort_order', { ascending: true })
    return res.status(200).json({
      ok: true, overridden: eff.overridden, booked: !!order.machship_consignment_id,
      units: eff.units, boxes: boxes || [],
    })
  }

  if (req.method === 'POST') {
    // MANIFESTED is the lock, not merely booked.
    //
    // A booked-but-unmanifested consignment exists in MachShip, but nothing has
    // reached the carrier and no label is in anyone's hands yet - re-boxing at
    // that point is a normal part of packing, and "Re-book freight" applies it.
    // Once the consignment is manifested the carrier has been told exactly what
    // is coming, and a changed plan would print the warehouse a pick list for
    // boxes nobody is expecting. That is where it stops.
    if (isManifested(order as any)) {
      return res.status(409).json({
        error: 'This consignment has already been manifested with the carrier, so the boxes are fixed. Cancel and rebook the freight if the packing has to change.',
      })
    }
    const action = String(req.body?.action || '')

    if (action === 'reset') {
      const { error: uErr } = await c.from('b2b_orders').update({ freight_pack_plan: null }).eq('id', orderId)
      if (uErr) return res.status(500).json({ error: uErr.message })
      return res.status(200).json({ ok: true })
    }

    if (action === 'combine') {
      const indexes: number[] = Array.isArray(req.body?.indexes) ? req.body.indexes.map((n: any) => Number(n)) : []
      const boxName: string = String(req.body?.box || '').trim()
      if (indexes.length < 2) return res.status(400).json({ error: 'Select at least two consignments to combine.' })

      const eff = await effectiveUnits(c, order)
      if ('error' in eff) return res.status(eff.httpStatus).json({ error: eff.error, detail: eff.detail })
      const units = eff.units
      const uniq = Array.from(new Set(indexes)).sort((a, b) => a - b)
      for (const i of uniq) {
        if (!Number.isInteger(i) || i < 0 || i >= units.length) return res.status(400).json({ error: `Invalid consignment index ${i}.` })
        if (units[i].quantity > 1) return res.status(400).json({ error: 'A grouped pallet unit can’t be combined — switch pack mode instead.' })
      }

      const selected = uniq.map(i => units[i])
      const weight_g = selected.reduce((s, u) => s + u.weight_g, 0)
      let merged: PackedUnit
      let warning: string | null = null
      if (boxName) {
        const { data: box } = await c.from('b2b_freight_boxes')
          .select('name, length_mm, width_mm, height_mm, max_weight_g')
          .eq('is_active', true).eq('name', boxName).maybeSingle()
        if (!box) return res.status(400).json({ error: `Box "${boxName}" not found in the configured boxes.` })
        if (weight_g > Number(box.max_weight_g)) {
          warning = `Combined weight ${(weight_g / 1000).toFixed(1)} kg exceeds ${box.name}'s ${(Number(box.max_weight_g) / 1000).toFixed(1)} kg limit — make sure the box (and whoever lifts it) can take it.`
        }
        merged = {
          itemType: 'Carton', name: box.name, quantity: 1, weight_g,
          length_mm: Number(box.length_mm), width_mm: Number(box.width_mm), height_mm: Number(box.height_mm),
          contents: mergeContents(selected),
        }
      } else {
        // No box picked: one parcel at the envelope of the selected units.
        merged = {
          itemType: 'Carton', name: 'Combined package', ownPackaging: true, quantity: 1, weight_g,
          length_mm: Math.max(...selected.map(u => u.length_mm)),
          width_mm: Math.max(...selected.map(u => u.width_mm)),
          height_mm: Math.max(...selected.map(u => u.height_mm)),
          contents: mergeContents(selected),
        }
      }

      const drop = new Set(uniq)
      const plan: PackedUnit[] = []
      units.forEach((u, i) => {
        if (i === uniq[0]) plan.push(merged)
        if (!drop.has(i)) plan.push(u)
      })

      const { error: uErr } = await c.from('b2b_orders').update({ freight_pack_plan: plan }).eq('id', orderId)
      if (uErr) return res.status(500).json({ error: uErr.message })
      return res.status(200).json({ ok: true, warning, units: plan })
    }

    // Change the box ONE consignment ships in, without combining anything.
    // The cartonizer picks the smallest box an item fits, which is often not
    // the box the warehouse actually uses — and its dimensions are what
    // MachShip prices and what the carrier bills. This is the "edit the boxes"
    // control: pick a different standard box, or "" to fall back to the item's
    // own packaging at its own dimensions.
    //
    // Weight is carried over untouched: re-boxing changes what it travels in,
    // not what is in it.
    if (action === 'setbox') {
      const index = Number(req.body?.index)
      const boxName: string = String(req.body?.box || '').trim()

      const eff = await effectiveUnits(c, order)
      if ('error' in eff) return res.status(eff.httpStatus).json({ error: eff.error, detail: eff.detail })
      const units = eff.units
      if (!Number.isInteger(index) || index < 0 || index >= units.length) {
        return res.status(400).json({ error: `Invalid consignment index ${req.body?.index}.` })
      }
      const target = units[index]
      if (target.quantity > 1) {
        return res.status(400).json({ error: 'A grouped pallet unit can’t be re-boxed — switch pack mode instead.' })
      }

      let replacement: PackedUnit
      let warning: string | null = null
      if (boxName) {
        const { data: box } = await c.from('b2b_freight_boxes')
          .select('name, length_mm, width_mm, height_mm, max_weight_g')
          .eq('is_active', true).eq('name', boxName).maybeSingle()
        if (!box) return res.status(400).json({ error: `Box "${boxName}" not found in the configured boxes.` })
        if (target.weight_g > Number(box.max_weight_g)) {
          warning = `${(target.weight_g / 1000).toFixed(1)} kg exceeds ${box.name}'s ${(Number(box.max_weight_g) / 1000).toFixed(1)} kg limit — make sure the box (and whoever lifts it) can take it.`
        }
        replacement = {
          itemType: target.itemType, name: box.name, quantity: 1, weight_g: target.weight_g,
          length_mm: Number(box.length_mm), width_mm: Number(box.width_mm), height_mm: Number(box.height_mm),
          contents: target.contents,
        }
      } else {
        // Back to its own packaging — keep the unit's existing dimensions and
        // just stop claiming it's in one of our standard boxes.
        replacement = { ...target, name: target.contents?.[0]?.name || target.name, ownPackaging: true, quantity: 1 }
      }

      const plan = units.map((u, i) => (i === index ? replacement : u))
      const { error: uErr } = await c.from('b2b_orders').update({ freight_pack_plan: plan }).eq('id', orderId)
      if (uErr) return res.status(500).json({ error: uErr.message })
      return res.status(200).json({ ok: true, warning, units: plan })
    }

    return res.status(400).json({ error: 'Unknown action — use "combine", "setbox" or "reset".' })
  }

  res.setHeader('Allow', 'GET, POST')
  return res.status(405).json({ error: 'GET or POST only' })
})
