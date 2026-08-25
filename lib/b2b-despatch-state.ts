// lib/b2b-despatch-state.ts
//
// ONE definition of "has this order's freight actually left?", shared by every
// screen and guard that asks. Deliberately dependency-free so the client pages
// can import it as safely as the server does.
//
// It existed in three places before, with three different answers:
//   · pages/admin/b2b/orders/index.tsx   — the "N booked, awaiting despatch" banner
//   · pages/admin/b2b/orders/[id].tsx    — whether the Ship Now button appears
//   · lib/b2b-ship-now.ts                — whether Ship Now actually works
// All three checked our own machship_manifest_id, so a consignment manifested
// OUTSIDE the portal (someone re-creating and despatching it in MachShip) left
// that id null forever and every one of them insisted the freight was still
// sitting here. B2B-2026-000047 was counted as awaiting despatch, and offered a
// Ship Now button, on a consignment TNT had already delivered — pressing it
// would have re-manifested the shipment and raised the tax invoice a second time.
//
// The rule: trust the CARRIER's status, not our paperwork. Booking leaves a
// consignment Unmanifested and nothing reaches the carrier until Ship Now
// (Chris 2026-08-20), so those states — and only those — mean it is still here.

/** Carrier states that mean the freight has NOT left yet. Anything else has. */
export const PRE_DESPATCH_STATES = new Set(['', 'unmanifested', 'pending', 'pending_manifest'])

export interface DespatchStateInput {
  freight_status: string | null
  machship_manifest_id: string | null
  machship_consignment_id?: string | null
}

/**
 * Has this consignment been manifested — by us or by anyone?
 *
 * `consignment_missing` counts as manifested here on purpose: the id no longer
 * resolves, so Ship Now cannot work on it anyway and offering it would only
 * produce a confusing failure.
 */
export function isManifested(o: DespatchStateInput): boolean {
  if (o.machship_manifest_id) return true
  return !PRE_DESPATCH_STATES.has((o.freight_status || '').toLowerCase())
}

/** Booked, still sitting here, and genuinely waiting for someone to press Ship Now. */
export function awaitingDespatch(o: DespatchStateInput): boolean {
  if (!o.machship_consignment_id) return false
  return !isManifested(o)
}
