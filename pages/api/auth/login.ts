// pages/api/auth/login.ts
// DEPRECATED — the old username+password login is replaced by Supabase Auth.
// Login now happens client-side via supabase.auth.signInWithPassword(), which
// then POSTs the session token to /api/auth/session to set httpOnly cookies.
// This stub remains only to return a clear error if any old client code still
// hits it. Safe to delete after confirming no references remain.

import type { NextApiRequest, NextApiResponse } from 'next'

export default async function handler(_req: NextApiRequest, res: NextApiResponse) {
  res.status(410).json({
    error: 'This endpoint is deprecated. Use the /login page, which signs in via Supabase Auth.',
    migration: 'POST /api/auth/session with { access_token, refresh_token } from supabase.auth.signInWithPassword()',
  })
}
