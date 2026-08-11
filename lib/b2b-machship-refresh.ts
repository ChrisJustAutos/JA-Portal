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
  MachShipApiError,
  MachShipNotConfiguredError,
} from './b2b-machship'

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
const TERMINAL_DELIVERED = new Set(['delivered'])
const TERMINAL_CANCELLED = new Set(['cancelled', 'returned'])

export async function refreshOrderFreight(c: SupabaseClient, orderId: string): Promise<RefreshResult> {
  const { data: order, error: oErr } = await c
    .from('b2b_orders')
    .select('id, status, machship_consignment_id, freight_status, delivered_at, tracking_number')
    .eq('id', orderId)
    .maybeSingle()
  if (oErr)   return { ok: false, status: 500, error: oErr.message }
  if (!order) return { ok: false, status: 404, error: 'Order not found' }
  if (!order.machship_consignment_id) {
    return { ok: false, status: 400, error: 'Order has no MachShip consignment id — book it first.' }
  }

  let consignment
  try {
    consignment = await getConsignment(order.machship_consignment_id)
  } catch (e: any) {
    if (e instanceof MachShipNotConfiguredError) return { ok: false, status: 503, error: e.message }
    if (e instanceof MachShipApiError) {
      // Consignment deleted upstream (e.g. manually re-created in MachShip —
      // Torrisi MS70068309 404'd every 30 min forever, 2026-08-11): park it
      // with a visible freight_status so the poller stops and the admin page
      // shows WHY there'll be no more tracking updates.
      if (e.status === 404) {
        await c.from('b2b_orders').update({
          freight_status: 'consignment_missing',
          last_freight_poll_at: new Date().toISOString(),
        }).eq('id', orderId)
        return { ok: false, status: 404, error: 'Consignment no longer exists in MachShip (deleted/re-created there?) — polling stopped; mark the order delivered manually when it lands.' }
      }
      return { ok: false, status: 502, error: e.message }
    }
    return { ok: false, status: 500, error: `getConsignment failed: ${e?.message || e}` }
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
