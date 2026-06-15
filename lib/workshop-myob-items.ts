// lib/workshop-myob-items.ts
// Push a portal-edited inventory item back to MYOB AccountRight (VPS file).
// MYOB stays the master of record; the portal lets you edit and then PUTs the
// changed fields to the MYOB Item. Uses GET-modify-PUT so required fields and
// RowVersion (optimistic concurrency) are preserved. Only number/name/description/
// cost/sell price/income account are written — portal-only fields (barcode,
// trade/wholesale tiers, location, bin, alerts) never leave the portal.

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { getConnection, myobFetch } from './myob'
import { WORKSHOP_MYOB_LABEL } from './workshop'

const GST_RATE = 0.10
const round2 = (n: number) => Math.round(n * 100) / 100

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

export interface PushResult { ok: boolean; error?: string }

export async function pushInventoryItemToMyob(itemId: string, performedBy: string | null = null): Promise<PushResult> {
  const db = sb()
  const { data: item } = await db.from('workshop_inventory').select('*').eq('id', itemId).maybeSingle()
  if (!item) return { ok: false, error: 'Item not found.' }
  if (!item.myob_uid) return { ok: false, error: 'This item is not linked to MYOB yet. Create it in MYOB, then re-sync.' }

  const conn = await getConnection(WORKSHOP_MYOB_LABEL)
  if (!conn || !conn.is_active || !conn.company_file_id) {
    return { ok: false, error: 'No active workshop MYOB connection. Connect via Settings → MYOB.' }
  }
  const base = `/accountright/${conn.company_file_id}/Inventory/Item/${item.myob_uid}`

  // GET current item — keeps RowVersion + every required field intact.
  const got = await myobFetch(conn.id, base, { method: 'GET', performedBy })
  if (got.status !== 200 || !got.data?.UID) {
    return { ok: false, error: `Couldn't load the MYOB item (HTTP ${got.status}).` }
  }
  const obj = got.data

  // Mutate only the fields the portal manages.
  if (item.sku) obj.Number = String(item.sku)
  if (item.part_name) obj.Name = String(item.part_name)
  if (item.sale_description != null) obj.Description = item.sale_description || null

  obj.SellingDetails = obj.SellingDetails || {}
  const inclusive = !!obj.SellingDetails.IsTaxInclusive
  const sellEx = Number(item.sell_price) || 0
  obj.SellingDetails.BaseSellingPrice = round2(inclusive ? sellEx * (1 + GST_RATE) : sellEx)
  if (item.sale_account_uid) obj.SellingDetails.IncomeAccount = { UID: item.sale_account_uid }

  obj.BuyingDetails = obj.BuyingDetails || {}
  obj.BuyingDetails.StandardCost = Number(item.buy_price) || 0

  const put = await myobFetch(conn.id, base, { method: 'PUT', body: obj, performedBy })
  if (![200, 201, 204].includes(put.status)) {
    const msg = put.data?.Errors?.[0]?.Message || put.data?.Message || `HTTP ${put.status}`
    await db.from('workshop_inventory').update({ myob_push_error: String(msg).slice(0, 400) }).eq('id', itemId)
    return { ok: false, error: msg }
  }
  await db.from('workshop_inventory').update({
    myob_dirty: false, myob_pushed_at: new Date().toISOString(), myob_push_error: null,
  }).eq('id', itemId)
  return { ok: true }
}
