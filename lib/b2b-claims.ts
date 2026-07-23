// lib/b2b-claims.ts
//
// Tiny concurrency guard for the B2B money paths (migration 172). The old
// idempotency checks were read-then-act, so a Stripe webhook retry racing an
// admin click could double-post MYOB documents / double-book freight /
// double-raise supplier POs. A claim is one conditional UPDATE — exactly one
// concurrent runner wins; claims from crashed runs expire after 10 minutes.

import type { SupabaseClient } from '@supabase/supabase-js'

const STALE_MS = 10 * 60_000

export type OrderClaimColumn = 'myob_writing_at' | 'freight_booking_at' | 'dropship_raising_at' | 'refunding_at'

/** Try to claim a stage for this order. True = we own it; false = another run does. */
export async function claimOrderStage(c: SupabaseClient, orderId: string, column: OrderClaimColumn): Promise<boolean> {
  const nowIso = new Date().toISOString()
  const { data, error } = await c.from('b2b_orders')
    .update({ [column]: nowIso })
    .eq('id', orderId)
    .is(column, null)
    .select('id')
  if (error) throw new Error(`claim ${column} failed: ${error.message}`)
  if (data && data.length > 0) return true
  // Existing claim — take it over only if it's stale (crashed run).
  const staleBefore = new Date(Date.now() - STALE_MS).toISOString()
  const { data: d2, error: e2 } = await c.from('b2b_orders')
    .update({ [column]: nowIso })
    .eq('id', orderId)
    .lt(column, staleBefore)
    .select('id')
  if (e2) throw new Error(`claim ${column} failed: ${e2.message}`)
  return !!(d2 && d2.length > 0)
}

/** Release a claimed stage (call in finally — the work's own idempotency flags gate re-entry). */
export async function releaseOrderStage(c: SupabaseClient, orderId: string, column: OrderClaimColumn): Promise<void> {
  try {
    await c.from('b2b_orders').update({ [column]: null }).eq('id', orderId)
  } catch { /* stale claim self-expires */ }
}
