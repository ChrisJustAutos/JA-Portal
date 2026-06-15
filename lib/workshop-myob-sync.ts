// lib/workshop-myob-sync.ts
// Pull MYOB (VPS — Vehicle Performance Solutions) Contacts → workshop_customers
// and Inventory Items → workshop_inventory, so the workshop diary/job-card
// pickers run on live MYOB data. MYOB is the master for these; the sync upserts
// on myob_uid and only touches the synced columns (portal-added notes etc. are
// preserved on update). Mirrors the b2b-catalogue-sync paging pattern.

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { getConnection, myobFetch } from './myob'
import { WORKSHOP_MYOB_LABEL } from './workshop'

const PAGE_SIZE = 400          // MYOB caps $top at 400
const GST_RATE = 0.10
const MAX_PAGES = 60           // sanity bound (24k rows)

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

const round2 = (n: number) => Math.round(n * 100) / 100

export interface WorkshopSyncResult {
  kind: 'customers' | 'inventory'
  scanned: number
  upserted: number
  errors: string[]
  durationMs: number
}

// Resolve the workshop (VPS) connection + company-file path, shared by both syncs.
async function workshopConn(): Promise<{ connId: string; cfPath: string }> {
  const conn = await getConnection(WORKSHOP_MYOB_LABEL)
  if (!conn || !conn.is_active) throw new Error(`No active ${WORKSHOP_MYOB_LABEL} MYOB connection. Connect via Settings → MYOB.`)
  if (!conn.company_file_id) throw new Error(`${WORKSHOP_MYOB_LABEL} MYOB connection has no company file selected.`)
  return { connId: conn.id, cfPath: `/accountright/${conn.company_file_id}` }
}

// Page through an AccountRight collection endpoint, returning all Items.
async function pageAll(connId: string, path: string, performedBy: string | null): Promise<any[]> {
  const all: any[] = []
  let skip = 0
  for (let page = 0; page < MAX_PAGES; page++) {
    const { status, data, raw } = await myobFetch(connId, path, {
      method: 'GET',
      query: { '$top': PAGE_SIZE, '$skip': skip },
      performedBy,
    })
    if (status !== 200) {
      const msg = data?.Errors?.[0]?.Message || data?.Message || (raw || '').substring(0, 300)
      throw new Error(`MYOB ${path} failed (skip=${skip}, HTTP ${status}): ${msg}`)
    }
    const items: any[] = Array.isArray(data?.Items) ? data.Items : []
    all.push(...items)
    if (items.length < PAGE_SIZE) break
    skip += PAGE_SIZE
  }
  return all
}

// Bulk upsert in chunks; fall back per-row so one bad row can't fail the batch.
async function upsertChunked(table: string, rows: any[], onConflict: string, errors: string[]): Promise<number> {
  const c = sb()
  const CHUNK = 500
  let ok = 0
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK)
    const { error } = await c.from(table).upsert(slice, { onConflict })
    if (!error) { ok += slice.length; continue }
    for (const row of slice) {
      const { error: e2 } = await c.from(table).upsert(row, { onConflict })
      if (e2) errors.push(`${row[onConflict]}: ${e2.message}`)
      else ok++
    }
  }
  return ok
}

// ── Customers (MYOB Contact/Customer) ───────────────────────────────────
export async function syncWorkshopCustomers(performedBy: string | null = null): Promise<WorkshopSyncResult> {
  const start = Date.now()
  const { connId, cfPath } = await workshopConn()
  const errors: string[] = []
  const contacts = await pageAll(connId, `${cfPath}/Contact/Customer`, performedBy)

  const nowIso = new Date().toISOString()
  const rows = contacts
    .filter(ct => ct?.UID)
    .map(ct => {
      const addr = Array.isArray(ct.Addresses) ? ct.Addresses[0] : null
      const individual = ct.IsIndividual !== false && !ct.CompanyName
      const name = (ct.CompanyName && ct.CompanyName.trim())
        || [ct.FirstName, ct.LastName].filter(Boolean).join(' ').trim()
        || ct.DisplayID || 'Customer'
      const address = addr
        ? [addr.Street, addr.City, addr.State, addr.PostCode].filter(Boolean).join(', ') || null
        : null
      return {
        myob_uid: ct.UID,
        name,
        first_name: ct.FirstName || null,
        last_name: ct.LastName || null,
        company: ct.CompanyName || null,
        customer_type: individual ? 'individual' : 'company',
        customer_number: ct.DisplayID || null,
        phone: addr?.Phone1 || null,
        mobile: addr?.Phone2 || null,
        email: addr?.Email || null,
        address,
        updated_at: nowIso,
      }
    })

  const upserted = await upsertChunked('workshop_customers', rows, 'myob_uid', errors)
  return { kind: 'customers', scanned: contacts.length, upserted, errors, durationMs: Date.now() - start }
}

// ── Inventory (MYOB Inventory/Item) ─────────────────────────────────────
export async function syncWorkshopInventory(performedBy: string | null = null): Promise<WorkshopSyncResult> {
  const start = Date.now()
  const { connId, cfPath } = await workshopConn()
  const errors: string[] = []
  const items = await pageAll(connId, `${cfPath}/Inventory/Item`, performedBy)

  // Items edited in the portal but not yet pushed to MYOB: don't overwrite the
  // user's edited fields (still refresh live stock quantities for them).
  const { data: dirtyRows } = await sb().from('workshop_inventory').select('myob_uid').eq('myob_dirty', true)
  const dirty = new Set((dirtyRows || []).map((r: any) => r.myob_uid))

  const nowIso = new Date().toISOString()
  const fullRows: any[] = []
  const stockRows: any[] = []
  for (const it of items) {
    if (!it?.UID || !it.Number || !it.Name) continue
    const stock = {
      myob_uid: it.UID,
      quantity: Number(it.QuantityOnHand ?? 0) || 0,
      available: Number(it.QuantityAvailable ?? it.QuantityOnHand ?? 0) || 0,
      allocated: Number(it.QuantityCommitted ?? 0) || 0,
      on_order: Number(it.QuantityOnOrder ?? 0) || 0,
      updated_at: nowIso,
    }
    if (dirty.has(it.UID)) { stockRows.push(stock); continue }   // protect edits
    const baseSell = Number(it.SellingDetails?.BaseSellingPrice || 0)
    const inclusive = !!it.SellingDetails?.IsTaxInclusive
    const sellEx = baseSell > 0 ? round2(inclusive ? baseSell / (1 + GST_RATE) : baseSell) : 0
    const buy = Number(it.BuyingDetails?.StandardCost ?? it.AverageCost ?? 0) || 0
    const supplier = it.BuyingDetails?.RestockingInformation?.Supplier?.Name || null
    fullRows.push({
      ...stock,
      sku: it.Number,
      part_name: it.Name,
      sale_description: it.Description || null,
      supplier,
      buy_price: round2(buy),
      sell_price: sellEx,
      uom: it.BuyingDetails?.BuyingUnitOfMeasure || it.SellingDetails?.SellingUnitOfMeasure || null,
      is_non_stock: it.IsInventoried === false,
      deactivated: it.IsActive === false,
    })
  }

  let upserted = await upsertChunked('workshop_inventory', fullRows, 'myob_uid', errors)
  if (stockRows.length) upserted += await upsertChunked('workshop_inventory', stockRows, 'myob_uid', errors)
  return { kind: 'inventory', scanned: items.length, upserted, errors, durationMs: Date.now() - start }
}
