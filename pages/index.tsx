// pages/index.tsx
// Landing page — redirects to the user's first visible tab.
//
// Prior behaviour: everyone redirected to /overview unconditionally, which
// broke for users whose role or custom visible_tabs list excluded overview
// (they'd land on a page their sidebar didn't show). Now we resolve the
// user server-side and send them to the first tab they actually have
// access to. Not-logged-in users go to /login.
//
// The old section-based dashboard (JAWS+VPS merged summary, invoices,
// P&L, stock, payables) still lives at /dashboard.

import type { GetServerSideProps } from 'next'
import type { NextApiRequest } from 'next'
import { getCurrentUser } from '../lib/authServer'
import { visibleNavSections, PORTAL_TABS } from '../lib/permissions'

// Map nav-item id → URL path. Kept in sync with pages/*.tsx file names.
const TAB_TO_ROUTE: Record<string, string> = {
  overview:       '/overview',
  leads:          '/sales',            // pages/sales.tsx handles leads/orders
  distributors:   '/distributors',
  calls:          '/calls',
  reports:        '/reports',
  todos:          '/todos',
  jobs:           '/jobs',
  'vehicle-sales':'/vehicle-sales',
  invoices:       '/dashboard?s=invoices',
  pnl:            '/dashboard?s=pnl',
  stock:          '/stock',
  payables:       '/dashboard?s=payables',
  settings:       '/settings',
}

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const req = ctx.req as unknown as NextApiRequest
  const user = await getCurrentUser(req)

  // Not logged in → login page
  if (!user) {
    return { redirect: { destination: '/login', permanent: false } }
  }

  // Compute the user's visible tabs (role defaults + per-user override).
  const tabs = visibleNavSections(user.role, user.visibleTabs)

  // Find the first tab in PORTAL_TABS order that the user can see.
  // We iterate PORTAL_TABS (not `tabs` directly) to preserve a predictable
  // order regardless of how visibleTabs was persisted.
  const tabIds = new Set(tabs)
  const firstTab = PORTAL_TABS.find(t => tabIds.has(t.id))?.id

  const destination = (firstTab && TAB_TO_ROUTE[firstTab]) || '/overview'

  return {
    redirect: {
      destination,
      permanent: false,
    },
  }
}

// The component never actually renders because of the redirect above,
// but Next requires a default export for the page to be valid.
export default function Index() { return null }
