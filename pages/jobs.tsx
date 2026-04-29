// pages/jobs.tsx
// Legacy redirect — page renamed to /forecasting on 30 Apr 2026.
// Kept here so any existing bookmarks, browser history, or Slack links to
// /jobs continue to land on the right page. Server-side 308 (Permanent
// Redirect) preserves SEO and avoids the brief client-side flash that a
// useEffect-based redirect would cause.

import { GetServerSideProps } from 'next'

export const getServerSideProps: GetServerSideProps = async () => {
  return {
    redirect: {
      destination: '/forecasting',
      permanent: true,
    },
  }
}

// Stub component so Next.js is happy. Will never render — getServerSideProps
// always returns a redirect.
export default function JobsRedirect() {
  return null
}
