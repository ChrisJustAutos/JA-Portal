// lib/b2b-machship-refresh.ts
//
// Shared helper for refreshing a B2B order's MachShip consignment
// state. Called by both the admin "Refresh from MachShip" button and
// the every-30-min cron poller — extracting it keeps both code paths
// in sync (status mapping, delivered_at stamping, error handling).
//
// The status name comes back from MachShip in PascalCase ("InTransit",
// "Delivered", etc). We snake_case it on the way into the DB so the
// distributor-facing UI can show a clean "in_transit" pill without
// having to handle every variant.

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  getConsignment,
  findConsignmentsByCarrierConsignmentId,
  findConsignmentsByReference1,
  MachShipApiError,
  MachShipNotConfiguredError,
} from './b2b-machship'
import type { Consignment } from './b2b-machship'

export interface RefreshResult {
  ok:    boolean
  status?: number
  error?:  string
  order?: {
    id: string
    status: string
    freight_status: string | null
    freight_eta_at: string | null
    last_freight_poll_at: string
    tracking_number: string | null
  }
}

// Normalised B2B status strings we'll write to freight_status. Keep
// in sync with whatever the distributor UI displays.
// MachShip finishes a consignment as "Complete" at least as often as
// "Delivered" — B2B-2026-000047 (MS70727168) sat on status `shipped` with a
// null delivered_at for six days after TNT delivered it, because only
// 'delivered' was listed here. Both mean the freight job is finished.
const TERMINAL_DELIVERED = new Set(['delivered', 'complete', 'completed'])
const TERMINAL_CANCELLED = new Set(['cancelled', 'returned'])

// Re-find a consignment whose internal id has stopped resolving.
//
// Order of attack, most durable identifier first:
//   1. the CARRIER tracking number (e.g. TNT "EYA000002055") — printed on the
//      label, so it survives a delete-and-re-create in MachShip
//   2. Reference 1 — "<order number> / <customer PO>", exactly what
//      lib/b2b-freight-book.ts sends as customerReference. Only matches if
//      whoever re-created it typed the same reference.
//
// Note we canNOT look up by our stored MachShip consignment number (MS…):
// MachShip publishes no endpoint for it, and a re-created consignment gets a
// new MS number anyway. Where the old number IS still live, the tracking
// number finds the same record — which is the case this exists for.
//
// Returns null on any doubt. A wrong match here would attach an order to
// someone else's shipment, so a lookup that returns several consignments only
// counts when exactly one of them matches on tracking number.
async function reResolveConsignment(order: any): Promise<Consignment | null> {
  const wantTracking = String(order.tracking_number || '').trim()

  const pick = (list: Consignment[]): Consignment | null => {
    const live = (list || []).filter(x => x && x.id)
    if (!live.length) return null
    if (wantTracking) {
      const exact = live.filter(x => String(x.carrierConsignmentId || '').trim() === wantTracking)
      if (exact.length === 1) return exact[0]
      if (exact.length > 1) return null
    }
    return live.length === 1 ? live[0] : null
  }

  try {
    if (wantTracking) {
      const byTracking = pick(await findConsignmentsByCarrierConsignmentId([wantTracking]))
      if (byTracking) return byTracking
    }
    const reference = order.order_number
      ? order.order_number + (order.customer_po ? ` / ${order.customer_po}` : '')
      : ''
    if (reference) {
      const byRef = pick(await findConsignmentsByReference1([reference]))
      if (byRef) return byRef
    }
  } catch (e: any) {
    console.error(`[machship] re-resolve failed for order ${order.id}:`, e?.message || e)
  }
  return null
}

export async function refreshOrderFreight(c: SupabaseClient, orderId: string): Promise<RefreshResult> {
  const { data: order, error: oErr } = await c
    .from('b2b_orders')
    .select('id, status, machship_consignment_id, machship_consignment_number, freight_status, delivered_at, tracking_number, order_number, customer_po')
    .eq('id', orderId)
    .maybeSingle()
  if (oErr)   return { ok: false, status: 500, error: oErr.message }
  if (!order) return { ok: false, status: 404, error: 'Order not found' }
  if (!order.machship_consignment_id) {
    return { ok: false, status: 400, error: 'Order has no MachShip consignment id — book it first.' }
  }

  // Every failure path below RETURNS. The only way out of this catch is with
  // `consignment` assigned — a fall-through here previously threw away a
  // successfully re-resolved consignment and reported "getConsignment failed"
  // instead of using it.
  let consignment: Consignment
  try {
    consignment = await getConsignment(order.machship_consignment_id)
  } catch (e: any) {
    if (e instanceof MachShipNotConfiguredError) return { ok: false, status: 503, error: e.message }
    if (!(e instanceof MachShipApiError)) {
      return { ok: false, status: 500, error: `getConsignment failed: ${e?.message || e}` }
    }
    if (e.status !== 404) return { ok: false, status: 502, error: e.message }

    // 404 — the id is dead. The shipment usually isn't: someone deleted and
    // re-created the consignment in MachShip, which issues a new internal id
    // while the carrier tracking number (printed on the label) stays put.
    // Re-resolve by that, then by our Reference 1, and carry on.
    const found = await reResolveConsignment(order)
    if (!found) {
      await c.from('b2b_orders').update({
        freight_status: 'consignment_missing',
        last_freight_poll_at: new Date().toISOString(),
      }).eq('id', orderId)
      return { ok: false, status: 404, error: 'Consignment no longer exists in MachShip, and no consignment matches this tracking number or order reference either — polling stopped; mark the order delivered manually when it lands.' }
    }
    await c.from('b2b_orders').update({
      machship_consignment_id:     String(found.id),
      machship_consignment_number: found.consignmentNumber || order.machship_consignment_number,
    }).eq('id', orderId)
    console.warn(`[machship] order ${orderId}: consignment id re-resolved ${order.machship_consignment_id} → ${found.id} (${found.consignmentNumber})`)
    consignment = found
  }

  const nowIso = new Date().toISOString()
  const statusName = (consignment.status?.name || '').trim().toLowerCase().replace(/\s+/g, '_')
  const update: Record<string, any> = {
    freight_status:        statusName || order.freight_status,
    freight_eta_at:        consignment.etaUtc || consignment.etaLocal || null,
    last_freight_poll_at:  nowIso,
    // Keep the stored number when a poll transiently omits it — assigning
    // null here erased real tracking numbers from the distributor UI.
    tracking_number:       consignment.carrierConsignmentId || undefined,
  }
  // Status transitions that pull the order along — only forward, never
  // back. We don't overwrite a pre-existing delivered_at if MachShip
  // briefly reports an earlier status (carriers occasionally re-emit).
  if (TERMINAL_DELIVERED.has(statusName) && order.status !== 'delivered') {
    update.status       = 'delivered'
    update.delivered_at = order.delivered_at || nowIso
  } else if (TERMINAL_CANCELLED.has(statusName) && order.status !== 'cancelled') {
    // Don't auto-cancel orders from a returned-to-sender event — we
    // want admin to look at those manually. Log only.
  }

  const { error: uErr } = await c.from('b2b_orders').update(update).eq('id', orderId)
  if (uErr) return { ok: false, status: 500, error: `Persist failed: ${uErr.message}` }

  // Live shipping updates to the distributor: one email + bell/push per
  // genuine carrier-status TRANSITION (the persisted freight_status is the
  // dedupe — both the 30-min cron and the manual refresh button land here,
  // but only the first poll that sees a new status fires). Pre-carrier
  // statuses stay quiet; the "shipped" email already covers booking.
  const QUIET = new Set(['', 'unmanifested', 'manifested', 'pending_manifest'])
  if (!QUIET.has(statusName) && statusName !== (order.freight_status || '')) {
    try {
      const { sendDistributorFreightUpdateEmail } = await import('./b2b-order-notify')
      await sendDistributorFreightUpdateEmail(orderId, {
        statusName,
        etaIso: update.freight_eta_at,
        trackingNumber: update.tracking_number ?? order.tracking_number ?? null,
      })
    } catch (e: any) {
      console.error(`freight-update notify failed for ${orderId} (non-fatal):`, e?.message || e)
    }
  }

  return {
    ok: true,
    order: {
      id: orderId,
      status: update.status || order.status,
      freight_status: update.freight_status,
      freight_eta_at: update.freight_eta_at,
      last_freight_poll_at: nowIso,
      tracking_number: update.tracking_number,
    },
  }
}
