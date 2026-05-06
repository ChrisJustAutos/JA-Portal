// pages/b2b/index.tsx
//
// Root of the distributor portal — pure redirect.
//   - Authenticated → /b2b/catalogue
//   - Not authenticated → /b2b/login

import type { GetServerSideProps } from 'next'
import { getCurrentB2BUser } from '../../lib/b2bAuthServer'

export default function B2BRoot() {
  // Never actually rendered (always redirects in GSSP). Just a fallback.
  return null
}

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const user = await getCurrentB2BUser(ctx.req as any)
  return {
    redirect: {
      destination: user ? '/b2b/catalogue' : '/b2b/login',
      permanent: false,
    },
  }
}
