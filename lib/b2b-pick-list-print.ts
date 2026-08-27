// lib/b2b-pick-list-print.ts
// SERVER-ONLY. Auto-print the warehouse PICK LIST when a B2B order is paid:
// load the order + lines + catalogue dims, compute the box plan with the SAME
// cartonizer freight quoting/booking uses (lib/b2b-freight.ts packOrderUnits,
// honouring the order's freight_pack_mode override), render the A4 PDF
// (lib/b2b-pick-list.tsx) and enqueue it on the workshop A4 printer via the
// existing label_print_jobs queue.
//
// Print routing: kind='invoice' → the print agent's routeForKind sends it to
// print_agent_settings.invoice_printer (falls back to the Windows default).
// No agent change needed — deliberate, the running copy on the workshop PC
// won't restart for a deploy.
//
// Idempotent per order: the PDF lives at a deterministic path
// (picklists/<orderId>.pdf in b2b-shipping-labels) and we skip when a
// label_print_jobs row for that order+path already exists — Stripe webhook
// retries / the admin mark-paid shortcut never double-print.

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { packOrderUnits, parsePackPlanUnits, type PackForMachShipItem } from './b2b-freight'
import type { PackMode } from './b2b-cartonizer'
import { renderPickListPdf, type PickListBox, type PickListData, type PickListDropShipGroup, type PickListLine } from './b2b-pick-list'

const BUCKET = 'b2b-shipping-labels'   // same bucket book-freight uses for labels + invoice prints

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

export interface QueuePickListResult {
  status: 'queued' | 'skipped' | 'failed'
  reason?: string
  path?: string
}

const round1 = (n: number) => Math.round(n * 10) / 10
const dimsLabel = (l: number, w: number, h: number) => `${Math.round(l)} x ${Math.round(w)} x ${Math.round(h)} mm`
// Component quantities are per-box shares (child total / parent total x in-box
// parent qty) — normally whole numbers; show one decimal when they aren't.
const fmtQty = (n: number) => (Number.isInteger(round1(n)) ? String(Math.round(n)) : round1(n).toFixed(1))

export async function queuePickListPrint(orderId: string, opts: { force?: boolean } = {}): Promise<QueuePickListResult> {
  const c = sb()

  // ── Idempotency: one pick list per order, ever (force = manual reprint) ─
  const path = `picklists/${orderId}.pdf`
  if (!opts.force) {
    const { data: existing, error: exErr } = await c.from('label_print_jobs')
      .select('id').eq('order_id', orderId).eq('storage_path', path).limit(1)
    if (exErr) return { status: 'failed', reason: `dedupe check failed: ${exErr.message}` }
    if (existing && existing.length > 0) return { status: 'skipped', reason: 'pick list already queued for this order', path }
  }

  // ── Load order + distributor + lines ───────────────────────────────────
  const { data: order, error: oErr } = await c.from('b2b_orders').select(`
      id, order_number, status, customer_po, distributor_id, is_test,
      shipping_address_snapshot, freight_pack_mode, freight_pack_plan, created_at, paid_at
    `).eq('id', orderId).maybeSingle()
  if (oErr) return { status: 'failed', reason: oErr.message }
  if (!order) return { status: 'failed', reason: 'Order not found' }

  const { data: dist } = await c.from('b2b_distributors')
    .select('display_name, trading_name, ship_line1, ship_line2, ship_suburb, ship_state, ship_postcode')
    .eq('id', order.distributor_id).maybeSingle()

  const { data: lineRows, error: lErr } = await c.from('b2b_order_lines').select(`
      qty, sku, name, catalogue_id, bundle_parent_catalogue_id, is_drop_ship,
      catalogue:b2b_catalogue!b2b_order_lines_catalogue_id_fkey (
        freight_weight_g, freight_length_mm, freight_width_mm, freight_height_mm,
        freight_packaging, manual_handling, myob_supplier_name
      )`).eq('order_id', orderId)
  if (lErr) return { status: 'failed', reason: lErr.message }
  if (!lineRows || lineRows.length === 0) return { status: 'skipped', reason: 'Order has no lines' }

  // ── Partition the lines (mirrors lib/b2b-freight-book.ts) ──────────────
  type Row = { qty: number; sku: string; name: string; catalogue_id: string | null; isDropShip: boolean; cat: any }
  const rows: Row[] = []
  const childrenByParentCat = new Map<string, Row[]>()  // bundle components, keyed by parent catalogue_id
  for (const r of lineRows as any[]) {
    const cat = Array.isArray(r.catalogue) ? r.catalogue[0] : r.catalogue
    const row: Row = { qty: Number(r.qty) || 0, sku: r.sku || '', name: String(r.name || r.sku || ''), catalogue_id: r.catalogue_id || null, isDropShip: r.is_drop_ship === true, cat }
    if (r.bundle_parent_catalogue_id) {
      const key = String(r.bundle_parent_catalogue_id)
      const arr = childrenByParentCat.get(key) || []
      arr.push(row)
      childrenByParentCat.set(key, arr)
      continue // ships inside the parent's box — never packed on its own
    }
    rows.push(row)
  }

  const packInput: PackForMachShipItem[] = []
  const manual: Row[] = []
  const dropBySupplier = new Map<string, Row[]>()
  // Map parent SKU → its row, so packed-box contents (keyed by SKU) can pick up
  // the parent's bundle components and total qty.
  const parentBySku = new Map<string, Row>()
  for (const r of rows) {
    if (r.isDropShip) {
      const supplier = String(r.cat?.myob_supplier_name || 'supplier not on file')
      const arr = dropBySupplier.get(supplier) || []
      arr.push(r)
      dropBySupplier.set(supplier, arr)
      continue
    }
    parentBySku.set(r.sku || r.name, r)
    const wg = r.cat?.freight_weight_g, lmm = r.cat?.freight_length_mm, wmm = r.cat?.freight_width_mm, hmm = r.cat?.freight_height_mm
    if (!wg || !lmm || !wmm || !hmm) { manual.push(r); continue }
    packInput.push({
      sku: r.sku, name: r.name, qty: r.qty,
      weight_g: Number(wg), length_mm: Number(lmm), width_mm: Number(wmm), height_mm: Number(hmm),
      packaging: r.cat?.freight_packaging ?? null, manual_handling: r.cat?.manual_handling === true,
    })
  }

  // ── Box plan — SAME cartonizer + pack-mode precedence as booking ───────
  const validMode = (m: any): PackMode | undefined => (m === 'pallet' || m === 'cartons' || m === 'auto') ? m : undefined
  const packMode = validMode((order as any).freight_pack_mode)
  // Manual consignment plan (admin combined boxes) wins over the cartonizer —
  // must match what book-freight sends to MachShip.
  const planUnits = parsePackPlanUnits((order as any).freight_pack_plan)
  const packed = planUnits
    ? { units: planUnits, mode: 'cartons' as const, totalWeightG: planUnits.reduce((s, u) => s + u.weight_g * Math.max(1, u.quantity), 0) }
    : (packInput.length > 0 ? await packOrderUnits(packInput, { packMode }) : null)

  // Attach bundle components to a packed content line: the child's share of
  // this box = childQty × (in-box parent qty / parent's total order qty).
  const toPickLine = (sku: string, name: string, qty: number): PickListLine => {
    const parent = parentBySku.get(sku || name)
    const comps: PickListLine[] = []
    if (parent?.catalogue_id) {
      const kids = childrenByParentCat.get(String(parent.catalogue_id)) || []
      const parentTotal = Math.max(1, parent.qty)
      for (const k of kids) comps.push({ sku: k.sku, name: k.name, qty: Number(fmtQty(k.qty * qty / parentTotal)) })
    }
    return { sku, name, qty, ...(comps.length ? { components: comps } : {}) }
  }

  const boxes: PickListBox[] = []
  let totalBoxes = 0
  let totalWeightG = 0
  // Consignment-first structure (Chris 2026-08-11): each section headline is
  // the CONSIGNMENT number; the box being used + its dims/weight sit on the
  // spec row beneath; then the products packed into it.
  if (packed) {
    let boxNo = 0
    for (const u of packed.units) {
      const n = Math.max(1, u.quantity)
      totalBoxes += n
      totalWeightG += u.weight_g * n
      const isPallet = u.itemType === 'Pallet'
      const first = boxNo + 1
      boxNo += n
      boxes.push({
        title: n > 1 ? `CONSIGNMENTS ${first}-${boxNo} — pack ${n} identical` : `CONSIGNMENT ${first}`,
        // ownPackaging = the item fits no configured box (or is unboxed/too
        // heavy) and ships as-is — say so instead of parroting the product
        // name as a "box" (Chris 2026-08-11: "con 1-7 all say Box: <product>").
        boxName: isPallet ? (u.name || 'Pallet') : (u.ownPackaging ? 'No standard box fits — ships in own packaging' : u.name),
        dims: dimsLabel(u.length_mm, u.width_mm, u.height_mm) + (n > 1 ? ' each' : ''),
        weightKg: (u.weight_g * n) / 1000,
        lines: (u.contents || []).map(cl => toPickLine(cl.sku, cl.name, cl.qty)),
        // Pallets carry a box plan: the items are boxed FIRST, then the boxes go
        // on the deck. Show both levels so the packer knows what goes in which
        // box before it is loaded (Chris 2026-08-27).
        ...(u.boxes && u.boxes.length > 0 ? {
          cartons: u.boxes.map(b => ({
            boxName: b.ownPackaging ? `${b.name} — own packaging` : b.name,
            dims: dimsLabel(b.length_mm, b.width_mm, b.height_mm),
            weightKg: b.weight_g / 1000,
            lines: (b.contents || []).map(cl => toPickLine(cl.sku, cl.name, cl.qty)),
          })),
        } : {}),
      })
    }
  } else if (packInput.length > 0) {
    // No standard boxes configured — mirror packForMachShip's fallback:
    // one carton per unit at the item's own dimensions.
    let boxNo = 0
    for (const it of packInput) {
      const n = Math.max(1, Math.floor(it.qty))
      const first = boxNo + 1
      boxNo += n
      totalBoxes += n
      totalWeightG += Number(it.weight_g || 0) * n
      boxes.push({
        title: n > 1 ? `CONSIGNMENTS ${first}-${boxNo} — pack ${n} identical (1 per box)` : `CONSIGNMENT ${first}`,
        boxName: `Own carton — ${it.name.slice(0, 50)}`,
        dims: dimsLabel(Number(it.length_mm || 0), Number(it.width_mm || 0), Number(it.height_mm || 0)) + (n > 1 ? ' each' : ''),
        weightKg: (Number(it.weight_g || 0) * n) / 1000,
        lines: [toPickLine(it.sku, it.name, n)],
      })
    }
  }

  const dropShip: PickListDropShipGroup[] = Array.from(dropBySupplier.entries()).map(([supplier, rs]) => ({
    supplier,
    lines: rs.map(r => toPickLine(r.sku, r.name, r.qty)),
  }))

  // ── Ship-to block (same precedence as booking: snapshot → distributor) ──
  const snap: any = order.shipping_address_snapshot || null
  const pick = (...vals: any[]): string => { for (const v of vals) { if (v == null) continue; const t = String(v).trim(); if (t) return t } return '' }
  const shipToLines = [
    pick(snap?.recipient_name, snap?.contact_name),
    pick(snap?.company_name, dist?.display_name, dist?.trading_name),
    pick(snap?.line1, snap?.address_line1, dist?.ship_line1),
    pick(snap?.line2, snap?.address_line2, dist?.ship_line2),
    [pick(snap?.suburb, dist?.ship_suburb), pick(snap?.state, dist?.ship_state), pick(snap?.postcode, dist?.ship_postcode)].filter(Boolean).join(' '),
  ].filter((l, i, arr) => l && arr.indexOf(l) === i)

  const data: PickListData = {
    orderNumber: order.order_number || orderId.slice(0, 8),
    distributorName: pick(dist?.display_name, dist?.trading_name, 'Unknown distributor'),
    orderDate: order.paid_at || order.created_at || new Date().toISOString(),
    customerPo: order.customer_po || null,
    isTest: (order as any).is_test === true,
    shipToLines,
    packModeNote: planUnits
      ? 'Pack plan: manually adjusted (consignments combined by admin) - matches the freight booking'
      : packed
      ? `Pack plan: ${packed.mode}${packMode ? ` (${packMode} mode set on order)` : ''} - matches the freight quote`
      : (boxes.length > 0 ? 'No standard boxes configured - one box per unit at item dimensions' : null),
    boxes,
    manualLines: manual.map(r => toPickLine(r.sku, r.name, r.qty)),
    dropShip,
    totalBoxes,
    totalWeightKg: totalWeightG / 1000,
  }

  if (data.boxes.length === 0 && data.manualLines.length === 0 && data.dropShip.length === 0) {
    return { status: 'skipped', reason: 'Nothing to print (no packable, manual or drop-ship lines)' }
  }

  // ── Render → upload → enqueue ──────────────────────────────────────────
  const pdf = await renderPickListPdf(data)
  const { error: upErr } = await c.storage.from(BUCKET).upload(path, pdf, { contentType: 'application/pdf', upsert: true })
  if (upErr) return { status: 'failed', reason: `upload failed: ${upErr.message}` }

  const { error: insErr } = await c.from('label_print_jobs').insert({
    order_id: orderId, storage_path: path, bucket: BUCKET, kind: 'invoice', status: 'pending',
  })
  if (insErr) return { status: 'failed', reason: `print queue insert failed: ${insErr.message}` }
  return { status: 'queued', path }
}
