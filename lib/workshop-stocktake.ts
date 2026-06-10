// lib/workshop-stocktake.ts
//
// Portal-native stocktake over workshop_inventory (runs in parallel with the
// MechanicDesk stocktake until MD is cancelled).
//
// Flow: create session (snapshot active stock — system_qty + buy_price frozen
// so a mid-count MYOB sync can't move the goalposts) → count (PATCH item
// counts) → review variance → APPLY:
//   • posting enabled → one MYOB /Inventory/Adjustment (delta qty per item,
//     against workshop_settings.inventory_adjust_account_uid), idempotent on
//     myob_adjustment_uid, then syncWorkshopInventory() pulls the
//     authoritative quantities back (never hand-patch and race the sync);
//   • posting disabled (pre-cutover dry runs) → patch workshop_inventory
//     directly and mark the session "local only".

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { getConnection, myobFetch } from './myob'
import { WORKSHOP_MYOB_LABEL } from './workshop'
import { getWorkshopSettings } from './workshop-myob-invoice'
import { syncWorkshopInventory } from './workshop-myob-sync'
import { logWorkshopActivity } from './workshop-activity'

const UUID_REGEX_G = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const round2 = (n: number) => Math.round(n * 100) / 100

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  _sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  return _sb
}

export class WorkshopStocktakeError extends Error {
  code: 'not_found' | 'bad_status' | 'adjust_account_not_set' | 'no_items' | 'myob_error'
  constructor(code: WorkshopStocktakeError['code'], message: string) { super(message); this.code = code }
}

export interface StocktakeScope { location?: string; category?: string; supplier?: string; q?: string }

export async function createStocktakeSession(name: string, scope: StocktakeScope | null, createdBy: string | null): Promise<{ id: string; st_seq: number; item_count: number }> {
  const c = sb()

  // Snapshot the active, stocked items (page past the 1000-row cap).
  const snapshot: any[] = []
  for (let from = 0; ; from += 1000) {
    let qy = c.from('workshop_inventory')
      .select('id, myob_uid, sku, part_name, barcode, location, bin, quantity, buy_price')
      .eq('deactivated', false).eq('is_non_stock', false)
      .order('sku', { ascending: true }).range(from, from + 999)
    if (scope?.location) qy = qy.ilike('location', `%${scope.location}%`)
    if (scope?.category) qy = qy.ilike('category', `%${scope.category}%`)
    if (scope?.supplier) qy = qy.ilike('supplier', `%${scope.supplier}%`)
    if (scope?.q) qy = qy.or(`sku.ilike.%${scope.q}%,part_name.ilike.%${scope.q}%`)
    const { data, error } = await qy
    if (error) throw new Error(error.message)
    if (!data || !data.length) break
    snapshot.push(...data)
    if (data.length < 1000) break
  }
  if (!snapshot.length) throw new WorkshopStocktakeError('no_items', 'No stocked items match that scope.')

  const { data: session, error: sErr } = await c.from('workshop_stocktakes').insert({
    name: name || `Stocktake ${new Date().toLocaleDateString('en-AU')}`,
    scope_filter: scope && Object.values(scope).some(Boolean) ? scope : null,
    item_count: snapshot.length, created_by: createdBy,
  }).select('id, st_seq').single()
  if (sErr) throw new Error(sErr.message)

  // Chunked inserts (same idea as workshop-myob-sync upsertChunked).
  const rows = snapshot.map(i => ({
    stocktake_id: session.id, inventory_id: i.id, myob_uid: i.myob_uid || null,
    sku: i.sku || null, part_name: i.part_name || null, barcode: i.barcode || null,
    location: i.location || null, bin: i.bin || null,
    system_qty: Number(i.quantity) || 0, buy_price: Number(i.buy_price) || 0,
  }))
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await c.from('workshop_stocktake_items').insert(rows.slice(i, i + 500))
    if (error) {
      await c.from('workshop_stocktakes').delete().eq('id', session.id)
      throw new Error(`Snapshot insert failed: ${error.message}`)
    }
  }

  await logWorkshopActivity(c, {
    action: 'created', entity: 'stocktake', entity_id: session.id, entity_label: `ST-${session.st_seq}`,
    detail: `${snapshot.length} items snapshotted`, actor_id: createdBy,
  })
  return { id: session.id, st_seq: session.st_seq, item_count: snapshot.length }
}

export interface StocktakeVariance {
  counted: number
  uncounted: number
  varianceQty: number
  varianceValue: number
  deltas: Array<{ item: any; delta: number; value: number }>
}

export function computeVariance(items: any[], uncountedPolicy: 'keep' | 'zero'): StocktakeVariance {
  let counted = 0, uncounted = 0, varianceQty = 0, varianceValue = 0
  const deltas: StocktakeVariance['deltas'] = []
  for (const it of items) {
    const sysQty = Number(it.system_qty) || 0
    if (it.counted_qty == null) {
      uncounted++
      if (uncountedPolicy === 'zero' && sysQty !== 0) {
        const value = round2(-sysQty * (Number(it.buy_price) || 0))
        deltas.push({ item: it, delta: -sysQty, value })
        varianceQty += -sysQty; varianceValue += value
      }
      continue
    }
    counted++
    const delta = round2((Number(it.counted_qty) || 0) - sysQty)
    if (delta !== 0) {
      const value = round2(delta * (Number(it.buy_price) || 0))
      deltas.push({ item: it, delta, value })
      varianceQty += delta; varianceValue += value
    }
  }
  return { counted, uncounted, varianceQty: round2(varianceQty), varianceValue: round2(varianceValue), deltas }
}

export interface ApplyResult {
  applied: number
  varianceQty: number
  varianceValue: number
  postedToMyob: boolean
  myobWarning: string | null
}

export async function applyStocktake(id: string, uncountedPolicy: 'keep' | 'zero', performedBy: string | null): Promise<ApplyResult> {
  const c = sb()
  const { data: session } = await c.from('workshop_stocktakes').select('*').eq('id', id).maybeSingle()
  if (!session) throw new WorkshopStocktakeError('not_found', 'Stocktake not found')
  if (session.status === 'applied') throw new WorkshopStocktakeError('bad_status', 'This stocktake has already been applied.')
  if (session.status === 'cancelled') throw new WorkshopStocktakeError('bad_status', 'This stocktake was cancelled.')

  const items: any[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await c.from('workshop_stocktake_items').select('*').eq('stocktake_id', id).order('sku').range(from, from + 999)
    if (error) throw new Error(error.message)
    if (!data || !data.length) break
    items.push(...data)
    if (data.length < 1000) break
  }

  const v = computeVariance(items, uncountedPolicy)
  const settings = await getWorkshopSettings()
  let postedToMyob = false
  let myobWarning: string | null = null

  if (v.deltas.length === 0) {
    // Perfect count — nothing to adjust.
  } else if (settings.myob_posting_enabled) {
    const adjustAcct = (settings as any).inventory_adjust_account_uid as string | null
    if (!adjustAcct) throw new WorkshopStocktakeError('adjust_account_not_set', 'Pick the MYOB inventory-adjustment account in Workshop Settings → MYOB accounts first.')
    const myobDeltas = v.deltas.filter(d => d.item.myob_uid)
    const skipped = v.deltas.length - myobDeltas.length
    if (!myobDeltas.length) throw new WorkshopStocktakeError('myob_error', 'None of the variance items have a MYOB link — sync inventory first.')
    if (!session.myob_adjustment_uid) {
      const conn = await getConnection(WORKSHOP_MYOB_LABEL)
      if (!conn || !conn.company_file_id) throw new WorkshopStocktakeError('myob_error', `${WORKSHOP_MYOB_LABEL} MYOB connection not configured`)
      const body = {
        Date: new Date().toISOString().substring(0, 10),
        Memo: `Portal stocktake ST-${session.st_seq} — ${session.name}`.substring(0, 255),
        Lines: myobDeltas.map(d => ({
          Item: { UID: d.item.myob_uid },
          Quantity: d.delta,
          UnitCost: round2(Number(d.item.buy_price) || 0),
          Account: { UID: adjustAcct },
          Memo: String(d.item.sku || d.item.part_name || '').substring(0, 255),
        })),
      }
      const r = await myobFetch(conn.id, `/accountright/${conn.company_file_id}/Inventory/Adjustment`, { method: 'POST', body, performedBy })
      if (r.status !== 201 && r.status !== 200) {
        const msg = `MYOB Inventory/Adjustment failed (HTTP ${r.status}): ${(r.raw || '').substring(0, 300)}`
        await c.from('workshop_stocktakes').update({ myob_write_error: msg }).eq('id', id)
        throw new WorkshopStocktakeError('myob_error', msg)
      }
      const loc = (r.headers || {})['location'] || (r.headers || {})['Location'] || ''
      const uuids = String(loc).match(UUID_REGEX_G) || []
      const uid = uuids[uuids.length - 1] || null
      await c.from('workshop_stocktakes').update({ myob_adjustment_uid: uid || 'posted', myob_write_error: null }).eq('id', id)
    }
    postedToMyob = true
    if (skipped > 0) myobWarning = `${skipped} variance item(s) had no MYOB link and were adjusted locally only.`
    // Pull authoritative quantities back from MYOB (covers the adjusted items).
    try { await syncWorkshopInventory(performedBy) } catch (e: any) { myobWarning = `${myobWarning ? myobWarning + ' ' : ''}Post-apply inventory re-sync failed: ${e?.message || e}` }
    // Items MYOB doesn't know about still need the local patch.
    for (const d of v.deltas.filter(x => !x.item.myob_uid)) {
      const newQty = uncountedPolicy === 'zero' && d.item.counted_qty == null ? 0 : Number(d.item.counted_qty) || 0
      await c.from('workshop_inventory').update({ quantity: newQty, available: newQty }).eq('id', d.item.inventory_id)
    }
  } else {
    // Posting off (pre-cutover dry run): patch local quantities directly.
    myobWarning = 'MYOB posting is off — quantities adjusted locally only (next MYOB sync will overwrite them).'
    for (const d of v.deltas) {
      const newQty = d.item.counted_qty == null ? 0 : Number(d.item.counted_qty) || 0
      await c.from('workshop_inventory').update({ quantity: newQty, available: newQty }).eq('id', d.item.inventory_id)
    }
  }

  await c.from('workshop_stocktakes').update({
    status: 'applied', uncounted_policy: uncountedPolicy,
    counted_count: v.counted, variance_qty: v.varianceQty, variance_value: v.varianceValue,
    applied_at: new Date().toISOString(), applied_by: performedBy,
  }).eq('id', id)

  await logWorkshopActivity(c, {
    action: 'updated', entity: 'stocktake', entity_id: id, entity_label: `ST-${session.st_seq}`,
    detail: `Applied: ${v.deltas.length} adjustments, variance ${v.varianceQty} units / $${v.varianceValue.toFixed(2)}${postedToMyob ? ' (MYOB)' : ' (local only)'}`,
    actor_id: performedBy,
  })

  return { applied: v.deltas.length, varianceQty: v.varianceQty, varianceValue: v.varianceValue, postedToMyob, myobWarning }
}
