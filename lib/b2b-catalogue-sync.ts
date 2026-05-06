// lib/b2b-catalogue-sync.ts
// Sync the b2b_catalogue table from MYOB JAWS Inventory.
//
// Pull strategy:
//   GET /accountright/{cf_id}/Inventory/Item
//     ?$filter=IsSelling eq true and IsActive eq true
//     ?$top=1000&$skip=N
//   Response shape: { Items: [...], NextPageLink, Count }
//
// Field ownership:
//   MYOB-canonical (refreshed every sync):
//     sku (Number), name (Name), rrp_ex_gst (SellingDetails.BaseSellingPrice
//     adjusted for IsTaxInclusive), is_taxable (SellingDetails.TaxCode),
//     myob_snapshot, last_synced_from_myob_at.
//   Portal-canonical (NEVER overwritten by sync):
//     trade_price_ex_gst, b2b_visible, description, category_id,
//     primary_image_url, spec_sheet_url, b2b_catalogue_images rows.
//
// First-time ingest:
//   - description seeded from MYOB Description
//   - trade_price_ex_gst seeded from rrp_ex_gst (admin overrides later)
//   - b2b_visible defaults to false — admin reviews each item before going live
//
// Run via /api/b2b/admin/catalogue/sync. Long-running for big catalogues
// (~1 MYOB request per 1000 items + bulk upsert) — Vercel maxDuration set
// to 300s on the API route. If JAWS catalogue ever grows past ~10k items
// or the sync routinely brushes the timeout, move to GH Actions following
// the stocktake worker pattern.

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { getConnection, myobFetch } from './myob'

const PAGE_SIZE = 400  // MYOB AccountRight caps $top at 400 per page
const GST_RATE = 0.10

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

interface MyobItem {
  UID: string
  Number: string
  Name: string
  Description: string | null
  IsActive: boolean
  IsSold: boolean
  IsBought: boolean
  IsInventoried: boolean
  SellingDetails?: {
    BaseSellingPrice?: number
    IsTaxInclusive?: boolean
    TaxCode?: { UID: string; Code: string } | null
  } | null
  [k: string]: any
}

export interface CatalogueSyncResult {
  totalScanned: number
  added: number
  updated: number
  unchanged: number
  errors: Array<{ uid: string; sku: string; error: string }>
  durationMs: number
  startedAt: string
  finishedAt: string
}

export async function syncJawsCatalogue(
  performedBy: string | null = null,
): Promise<CatalogueSyncResult> {
  const startedAt = new Date()
  const startMs = Date.now()

  // ── 0. Resolve JAWS connection ─────────────────────────────────────────
  const conn = await getConnection('JAWS')
  if (!conn || !conn.is_active) {
    throw new Error('No active JAWS MYOB connection. Connect via Settings → MYOB.')
  }
  if (!conn.company_file_id) {
    throw new Error('JAWS MYOB connection has no company file selected.')
  }

  const cfPath = `/accountright/${conn.company_file_id}`
  const result: CatalogueSyncResult = {
    totalScanned: 0,
    added: 0,
    updated: 0,
    unchanged: 0,
    errors: [],
    durationMs: 0,
    startedAt: startedAt.toISOString(),
    finishedAt: '',
  }

  // ── 1. Page through MYOB Inventory/Item ────────────────────────────────
  // No OData $filter on the request — we filter IsActive/IsSold in JS.
  // MYOB Item OData filters are fragile across tenants, and pulling the full
  // catalogue then filtering locally is a few hundred KB extra per sync.
  let skip = 0
  const allItems: MyobItem[] = []
  // Cap at 50 pages (20k items at 400/page) as a sanity bound
  for (let page = 0; page < 50; page++) {
    const { status, data, raw } = await myobFetch(conn.id, `${cfPath}/Inventory/Item`, {
      method: 'GET',
      query: {
        '$top':  PAGE_SIZE,
        '$skip': skip,
      },
      performedBy,
    })
    if (status !== 200) {
      const myobMsg = data?.Errors?.[0]?.Message
                   || data?.Message
                   || (raw || '').substring(0, 400)
      throw new Error(
        `MYOB Inventory/Item fetch failed (skip=${skip}, HTTP ${status}): ${myobMsg}`
      )
    }
    const items: MyobItem[] = Array.isArray(data?.Items) ? data.Items : []
    allItems.push(...items)
    result.totalScanned += items.length
    if (items.length < PAGE_SIZE) break
    skip += PAGE_SIZE
  }

  // ── 2. Load existing rows for diff ─────────────────────────────────────
  const c = sb()
  const uids = allItems.map(i => i.UID).filter(Boolean)
  const existingByUid = new Map<string, any>()
  const CHUNK = 500
  for (let i = 0; i < uids.length; i += CHUNK) {
    const slice = uids.slice(i, i + CHUNK)
    const { data, error } = await c
      .from('b2b_catalogue')
      .select('id, myob_item_uid, sku, name, rrp_ex_gst, is_taxable')
      .in('myob_item_uid', slice)
    if (error) throw new Error(`Load existing catalogue failed: ${error.message}`)
    for (const row of data || []) existingByUid.set(row.myob_item_uid, row)
  }

  // ── 3. Build insert + update payloads ──────────────────────────────────
  type SyncRow = {
    myob_item_uid: string
    myob_company_file: 'JAWS'
    sku: string
    name: string
    rrp_ex_gst: number | null
    is_taxable: boolean
    last_synced_from_myob_at: string
    myob_snapshot: any
    // Insert-only seed fields
    description?: string | null
    trade_price_ex_gst?: number
    b2b_visible?: boolean
    created_by?: string | null
  }

  const inserts: SyncRow[] = []
  const updates: SyncRow[] = []
  const nowIso = new Date().toISOString()

  for (const it of allItems) {
    if (!it.UID || !it.Number || !it.Name) {
      result.errors.push({
        uid: it.UID || '?',
        sku: it.Number || '?',
        error: 'Missing UID, Number or Name on MYOB item',
      })
      continue
    }

    // JS-side filter for what we want to ingest. Treats undefined as
    // "include" so an item missing these flags doesn't get silently dropped.
    if (it.IsActive === false || it.IsSold === false) {
      continue
    }

    const baseSelling = Number(it.SellingDetails?.BaseSellingPrice || 0)
    const isInclusive = !!it.SellingDetails?.IsTaxInclusive
    const rrpExGst    = baseSelling > 0
      ? round2(isInclusive ? baseSelling / (1 + GST_RATE) : baseSelling)
      : null
    const isTaxable   = !!it.SellingDetails?.TaxCode
    const existing    = existingByUid.get(it.UID)

    const base: SyncRow = {
      myob_item_uid: it.UID,
      myob_company_file: 'JAWS',
      sku: it.Number,
      name: it.Name,
      rrp_ex_gst: rrpExGst,
      is_taxable: isTaxable,
      last_synced_from_myob_at: nowIso,
      myob_snapshot: it,
    }

    if (!existing) {
      inserts.push({
        ...base,
        description: it.Description || null,
        trade_price_ex_gst: rrpExGst ?? 0,
        b2b_visible: false,
        created_by: performedBy,
      })
    } else {
      const changed = existing.sku        !== it.Number
                   || existing.name       !== it.Name
                   || Number(existing.rrp_ex_gst || 0) !== Number(rrpExGst || 0)
                   || existing.is_taxable !== isTaxable
      if (!changed) {
        result.unchanged++
        continue
      }
      updates.push(base)
    }
  }

  // ── 4. Apply ────────────────────────────────────────────────────────────
  // Bulk first; on error fall back per-row so one bad row doesn't kill the batch.
  if (inserts.length > 0) {
    for (let i = 0; i < inserts.length; i += CHUNK) {
      const slice = inserts.slice(i, i + CHUNK)
      const { error } = await c.from('b2b_catalogue').insert(slice)
      if (error) {
        for (const row of slice) {
          const { error: e2 } = await c.from('b2b_catalogue').insert(row)
          if (e2) {
            result.errors.push({ uid: row.myob_item_uid, sku: row.sku, error: e2.message })
          } else {
            result.added++
          }
        }
      } else {
        result.added += slice.length
      }
    }
  }

  if (updates.length > 0) {
    for (let i = 0; i < updates.length; i += CHUNK) {
      const slice = updates.slice(i, i + CHUNK)
      const { error } = await c
        .from('b2b_catalogue')
        .upsert(slice, { onConflict: 'myob_item_uid' })
      if (error) {
        for (const row of slice) {
          const { error: e2 } = await c
            .from('b2b_catalogue')
            .update({
              sku: row.sku,
              name: row.name,
              rrp_ex_gst: row.rrp_ex_gst,
              is_taxable: row.is_taxable,
              last_synced_from_myob_at: row.last_synced_from_myob_at,
              myob_snapshot: row.myob_snapshot,
            })
            .eq('myob_item_uid', row.myob_item_uid)
          if (e2) {
            result.errors.push({ uid: row.myob_item_uid, sku: row.sku, error: e2.message })
          } else {
            result.updated++
          }
        }
      } else {
        result.updated += slice.length
      }
    }
  }

  // ── 5. Record sync stats in b2b_settings ───────────────────────────────
  const finishedAt = new Date()
  result.durationMs = Date.now() - startMs
  result.finishedAt = finishedAt.toISOString()

  await c.from('b2b_settings').update({
    last_catalogue_sync_at:      result.finishedAt,
    last_catalogue_sync_added:   result.added,
    last_catalogue_sync_updated: result.updated,
    last_catalogue_sync_error:   result.errors.length > 0
      ? `${result.errors.length} row error(s); see latest sync result`
      : null,
  }).eq('id', 'singleton')

  return result
}
