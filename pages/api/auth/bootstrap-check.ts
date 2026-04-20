// pages/api/auth/bootstrap-check.ts
// Public endpoint — used by the login page to decide whether to show the
// first-time setup form or the normal login form.
// Returns { needsBootstrap: boolean }

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' })

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !anonKey) return res.status(500).json({ error: 'Supabase not configured' })

  const sb = createClient(url, anonKey)
  const { data, error } = await sb.rpc('has_any_admin')
  if (error) return res.status(500).json({ error: error.message })

  return res.status(200).json({ needsBootstrap: data === false })
}
