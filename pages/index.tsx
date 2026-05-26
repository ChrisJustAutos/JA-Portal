// pages/index.tsx
// Landing — sends users to the app launcher (pages/home.tsx). Not-logged-in
// users go to /login. The launcher is the Odoo-style grid of app tiles;
// from there users pick an app rather than being dropped straight into one.
//
// The old section-based dashboard (JAWS+VPS merged summary, invoices,
// P&L, stock, payables) still lives at /dashboard.

import type { GetServerSideProps } from 'next'
import type { NextApiRequest } from 'next'
import { getCurrentUser } from '../lib/authServer'

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const req = ctx.req as unknown as NextApiRequest
  const user = await getCurrentUser(req)
  if (!user) {
    return { redirect: { destination: '/login', permanent: false } }
  }
  return { redirect: { destination: '/home', permanent: false } }
}

// Never renders (redirect above), but Next requires a default export.
export default function Index() { return null }
