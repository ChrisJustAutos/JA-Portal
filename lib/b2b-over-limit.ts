// lib/b2b-over-limit.ts
// One source of truth for the per-item "large order" rule (migration 125).
//
// A catalogue item may set a soft threshold `over_limit_qty` plus an
// `over_limit_action` ('quote' | 'dropship'). When a cart/order line's qty
// EXCEEDS the threshold, that action kicks in:
//   'quote'    → the line can't self-checkout; route to "Request a quote".
//   'dropship' → the whole line ships from the supplier for that order
//                (bypass warehouse stock cap, use drop-ship freight + auto-PO).
//
// At or below the threshold (or with no threshold set) the line behaves
// normally. Used by the cart, freight quote and checkout so the three agree.

export type OverLimitAction = 'quote' | 'dropship'

export interface OverLimitInput {
  over_limit_qty: number | null | undefined
  over_limit_action: string | null | undefined
}

export interface OverLimitState {
  threshold: number | null      // the configured limit (null = no rule)
  action: OverLimitAction | null
  triggered: boolean            // qty strictly exceeds the threshold
}

export function resolveOverLimit(item: OverLimitInput, qty: number): OverLimitState {
  const threshold = item.over_limit_qty != null && Number(item.over_limit_qty) >= 1
    ? Number(item.over_limit_qty)
    : null
  const action: OverLimitAction | null =
    item.over_limit_action === 'quote' || item.over_limit_action === 'dropship'
      ? item.over_limit_action
      : null
  const triggered = threshold != null && action != null && Number(qty) > threshold
  return { threshold, action, triggered }
}

// Does this line ship from the supplier for THIS order? True when the catalogue
// item is flagged drop-ship, OR the over-limit drop-ship rule has fired.
export function lineShipsFromSupplier(
  item: OverLimitInput & { is_drop_ship?: boolean | null },
  qty: number,
): boolean {
  if (item.is_drop_ship === true) return true
  const ol = resolveOverLimit(item, qty)
  return ol.triggered && ol.action === 'dropship'
}

// Does this line require a manual quote (can't self-checkout) at this qty?
export function lineNeedsQuote(item: OverLimitInput, qty: number): boolean {
  const ol = resolveOverLimit(item, qty)
  return ol.triggered && ol.action === 'quote'
}
