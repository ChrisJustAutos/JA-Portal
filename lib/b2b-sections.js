// lib/b2b-sections.js
//
// Which parts of the B2B module are switched on. ONE source of truth,
// deliberately plain CommonJS so both next.config.js (which can't import TS)
// and the React components read the same list — same arrangement as
// lib/workshop-sections.js, for the same reason.
//
// WHY THIS EXISTS (Chris, 2026-08-26): Stock Wall and Suppliers are no longer
// needed. Neither was ever really used — b2b_suppliers and b2b_supplier_users
// were both empty — so this is retiring dead surface rather than taking a
// working tool away.
//
// The pages and tables are LEFT IN PLACE. Nothing is deleted: the tabs go, the
// URLs explain themselves, and flipping `active` back to true brings the whole
// thing back with no other change.
//
// TO REVIVE A SECTION: flip `active` to true. That restores its tab, and
// next.config.js stops routing it to the "not in use" notice.
//
// TO PEEK AT A PARKED SCREEN without switching it back on, append ?preview=1
// (e.g. /admin/b2b/suppliers?preview=1) — the rewrite is skipped when that
// query is present.

/**
 * @typedef {Object} B2BSection
 * @property {string} id
 * @property {boolean} active
 * @property {string} label
 * @property {string} [why]      why it was parked, shown on the notice
 * @property {string[]} [routes] every route the section owns, for the rewrites
 */

/** @type {B2BSection[]} */
const B2B_SECTIONS = [
  {
    id: 'stock_overview',
    label: 'Stock Wall',
    active: false,
    why: 'The Slack parts bot answers stock questions now, and the Stock Order tab covers reordering.',
    routes: ['/admin/b2b/stock-overview'],
  },
  {
    id: 'suppliers',
    label: 'Suppliers',
    active: false,
    why: 'Read-only supplier logins were never taken up — no supplier account was ever created. Drop-ship POs reach suppliers by email instead.',
    // Includes the supplier-facing portal itself: leaving a login surface open
    // for a module nobody administers is worse than closing it.
    routes: ['/admin/b2b/suppliers', '/b2b/supplier'],
  },
]

function isB2BSectionActive(id) {
  const s = B2B_SECTIONS.find(x => x.id === id)
  return !s || s.active === true   // unknown ids stay visible — fail open
}

function parkedB2BRewrites() {
  const out = []
  for (const s of B2B_SECTIONS) {
    if (s.active || !s.routes) continue
    for (const source of s.routes) {
      out.push({
        source,
        destination: `/b2b-not-in-use?section=${s.id}`,
        missing: [{ type: 'query', key: 'preview' }],
      })
    }
  }
  return out
}

module.exports = { B2B_SECTIONS, isB2BSectionActive, parkedB2BRewrites }
