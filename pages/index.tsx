// pages/index.tsx
// Landing page — redirects straight to /overview (the widget dashboard).
// The old section-based dashboard (JAWS+VPS merged summary, invoices, P&L,
// stock, payables) lives at /dashboard.

import type { GetServerSideProps } from 'next'

export const getServerSideProps: GetServerSideProps = async () => {
  return {
    redirect: {
      destination: '/overview',
      permanent: false,
    },
  }
}

// The component will never actually render due to the redirect above, but
// Next requires a default export for the page to be valid.
export default function Index() { return null }
