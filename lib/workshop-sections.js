// lib/workshop-sections.js
//
// Which parts of the Workshop module are switched on. ONE source of truth,
// deliberately plain CommonJS so both next.config.js (which can't import TS)
// and the React components can read the same list.
//
// WHY THIS EXISTS (Chris, 2026-08-20): the MechanicDesk replacement is paused.
// MD remains the workshop system of record — diary, job cards, customers,
// vehicles, quotes and invoicing all happen there. Those screens still exist in
// this codebase but must not be used, because work entered into them reaches
// nobody. What survives is the handful of things the portal genuinely does
// around MD.
//
// The nav is a SINGLE flat strip (2026-08-20). It used to be two levels, with
// Inventory wrapping a second strip — once Inventory, Live Bins, Cash Count,
// Suppliers and Orders came off there was almost nothing left to wrap, so the
// second level (components/InventoryTabs.tsx) was deleted and its survivors
// promoted up here.
//
// TO REVIVE A SECTION: flip `active` to true. That restores its tab, and
// next.config.js stops routing it to the "not in use" notice. Nothing else.
//
// TO PEEK AT A PARKED SCREEN without switching it back on, append ?preview=1
// (e.g. /diary?preview=1) — the rewrite is skipped when that query is present.

/**
 * @typedef {Object} WorkshopSection
 * @property {string} id
 * @property {string} label
 * @property {string} href
 * @property {boolean} active
 * @property {string} [perm]    extra permission beyond view:diary
 * @property {string[]} [routes] every route the section owns, for the notice rewrites
 */

/** @type {WorkshopSection[]} */
const WORKSHOP_SECTIONS = [
  // ── Live ─────────────────────────────────────────────────────────────
  // Fed by MYOB, by the MechanicDesk workers, or by the portal itself —
  // none of these depend on the paused workshop build.
  { id: 'letters',          label: 'Letters',            href: '/workshop/letters',         active: true },
  { id: 'prepick',          label: 'Pre Pick',           href: '/workshop/prepick',         active: true },
  { id: 'stocktake-md',     label: 'Stocktake (MD)',     href: '/stocktake',                active: true, perm: 'view:stocktakes' },
  { id: 'stock-transfer',   label: 'Stock Transfer',     href: '/admin/b2b/stock-transfer', active: true, perm: 'edit:b2b_distributors' },

  // ── Parked: MechanicDesk does these ──────────────────────────────────
  { id: 'diary',     label: 'Diary',     href: '/diary',              active: false, routes: ['/diary'] },
  { id: 'jobs',      label: 'Jobs',      href: '/workshop/jobs',      active: false, routes: ['/workshop/jobs', '/workshop/job/:path*'] },
  { id: 'customers', label: 'Customers', href: '/workshop/customers', active: false, routes: ['/workshop/customers', '/workshop/customer/:path*'] },
  { id: 'vehicles',  label: 'Vehicles',  href: '/workshop/vehicles',  active: false, routes: ['/workshop/vehicles', '/workshop/vehicle/:path*'] },
  { id: 'quotes',    label: 'Quotes',    href: '/workshop/quotes',    active: false, routes: ['/workshop/quotes', '/workshop/quote/:path*'] },
  { id: 'invoices',  label: 'Invoices',  href: '/workshop/invoices',  active: false, routes: ['/workshop/invoices', '/workshop/invoice/:path*'] },
  { id: 'comms',     label: 'Comms',     href: '/workshop/comms',     active: false, routes: ['/workshop/comms'] },
  // Reports over the portal's own workshop tables — which stay empty while MD
  // is the system of record, so the screen only ever shows near-zero.
  { id: 'reports',   label: 'Reports',   href: '/workshop/reports',   active: false, routes: ['/workshop/reports'], perm: 'view:reports' },

  // ── Parked 2026-08-20 (second wave) ──────────────────────────────────
  // Orders was the per-day parts worklist off the portal diary, so it went
  // dark with the diary. The rest were the old Inventory sub-strip.
  { id: 'orders',     label: 'Orders',     href: '/workshop/orders',     active: false, routes: ['/workshop/orders'] },
  { id: 'inventory',  label: 'Inventory',  href: '/workshop/inventory',  active: false, routes: ['/workshop/inventory'] },
  { id: 'live-bins',  label: 'Live Bins',  href: '/workshop/live-bins',  active: false, routes: ['/workshop/live-bins'] },
  { id: 'cash-count', label: 'Cash Count', href: '/workshop/cash-count', active: false, routes: ['/workshop/cash-count'] },
  { id: 'suppliers',  label: 'Suppliers',  href: '/workshop/suppliers',  active: false, routes: ['/workshop/suppliers'] },

  // ── Parked 2026-09-02 (third wave) ───────────────────────────────────
  // Chris: "Remove Purchase orders from Workshop section and Stocktake
  // Portal — functions not used." Purchase Orders raised POs against the
  // portal's own workshop tables, which stay empty while MD is the system of
  // record. Stocktake (PORTAL) counted against those same tables.
  //
  // ⚠ Stocktake (MD) at /stocktake is a DIFFERENT screen and stays live — it
  // counts against MechanicDesk on-hand and carries the "parts on cars" panel
  // shipped 2026-08-27. Do not confuse the two when reviving anything.
  { id: 'po',               label: 'Purchase Orders',    href: '/workshop/purchase-orders', active: false, routes: ['/workshop/purchase-orders'] },
  { id: 'stocktake-portal', label: 'Stocktake (Portal)', href: '/workshop/stocktake',       active: false, routes: ['/workshop/stocktake', '/workshop/stocktake/:path*'], perm: 'view:stocktakes' },
]

// Where the Workshop app tile and any parked screen send people instead.
const WORKSHOP_LANDING = '/workshop/prepick'

const activeWorkshopSections = () => WORKSHOP_SECTIONS.filter(s => s.active)

const isWorkshopSectionActive = id => !!WORKSHOP_SECTIONS.find(s => s.id === id && s.active)

/**
 * Rewrites that keep the URL but render the "not in use" notice.
 * A rewrite (not a redirect) so an old bookmark still shows which screen was
 * asked for, and ?preview=1 still reaches the real page.
 */
function parkedWorkshopRewrites() {
  const out = []
  for (const s of WORKSHOP_SECTIONS) {
    if (s.active || !s.routes) continue
    for (const source of s.routes) {
      out.push({
        source,
        destination: `/workshop/not-in-use?section=${s.id}`,
        missing: [{ type: 'query', key: 'preview' }],
      })
    }
  }
  return out
}

module.exports = {
  WORKSHOP_SECTIONS,
  WORKSHOP_LANDING,
  activeWorkshopSections,
  isWorkshopSectionActive,
  parkedWorkshopRewrites,
}
