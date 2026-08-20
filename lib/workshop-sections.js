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
// nobody. What the portal genuinely provides around MD stays on: letters, the
// parts worklist, purchase orders, Pre Pick and the counting tools.
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
 * @property {string} href      top-level tab target
 * @property {boolean} active
 * @property {string} [perm]    extra permission beyond view:diary
 * @property {string[]} [routes] every route the section owns, for the notice rewrites
 */

/** @type {WorkshopSection[]} */
const WORKSHOP_SECTIONS = [
  // ── Parked: MechanicDesk does these ──────────────────────────────────
  { id: 'diary',     label: 'Diary',     href: '/diary',               active: false, routes: ['/diary'] },
  { id: 'jobs',      label: 'Jobs',      href: '/workshop/jobs',       active: false, routes: ['/workshop/jobs', '/workshop/job/:path*'] },
  { id: 'customers', label: 'Customers', href: '/workshop/customers',  active: false, routes: ['/workshop/customers', '/workshop/customer/:path*'] },
  { id: 'vehicles',  label: 'Vehicles',  href: '/workshop/vehicles',   active: false, routes: ['/workshop/vehicles', '/workshop/vehicle/:path*'] },
  { id: 'quotes',    label: 'Quotes',    href: '/workshop/quotes',     active: false, routes: ['/workshop/quotes', '/workshop/quote/:path*'] },
  { id: 'invoices',  label: 'Invoices',  href: '/workshop/invoices',   active: false, routes: ['/workshop/invoices', '/workshop/invoice/:path*'] },
  { id: 'comms',     label: 'Comms',     href: '/workshop/comms',      active: false, routes: ['/workshop/comms'] },
  // Reports over the portal's own workshop tables — which stay empty while MD
  // is the system of record, so the screen only ever shows near-zero.
  { id: 'reports',   label: 'Reports',   href: '/workshop/reports',    active: false, routes: ['/workshop/reports'], perm: 'view:reports' },

  // ── Live: these are fed by MYOB, MD or the portal itself ─────────────
  { id: 'orders',    label: 'Orders',    href: '/workshop/orders',     active: true },
  { id: 'letters',   label: 'Letters',   href: '/workshop/letters',    active: true },
  { id: 'inventory', label: 'Inventory', href: '/workshop/inventory',  active: true },
]

// Where the Workshop app tile and any parked screen point people instead.
// Inventory, because it carries the second-level strip (Live Bins, Cash Count,
// Pre Pick, Suppliers, Purchase Orders, both stocktakes, Stock Transfer) — one
// click from there to everything still in use.
const WORKSHOP_LANDING = '/workshop/inventory'

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
