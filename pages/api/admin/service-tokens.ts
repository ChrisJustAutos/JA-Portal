// pages/api/admin/service-tokens.ts
// Manage service tokens for external automation. Admin only.
//
//   GET    /api/admin/service-tokens             — list tokens (no plaintext)
//   POST   /api/admin/service-tokens             — create a new token; returns
//                                                   plaintext ONCE in response
//   DELETE /api/admin/service-tokens?id=...      — revoke (sets is_active=false)
//
// Tokens are stored as SHA-256 hashes. The plaintext value is shown to the
// admin exactly once on creation and never logged or returned again.

import type { NextApiRequest, NextApiResponse } from 'next'
import { randomBytes } from 'crypto'
import { createClient } from '@supabase/supabase-js'
import { requireAdmin, getSessionUser } from '../../../lib/auth'
import { hashToken } from '../../../lib/service-auth'

const VALID_SCOPES = ['upload:job-report'] as const
type Scope = typeof VALID_SCOPES[number]

function sb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  )
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  return requireAdmin(req, res, async () => {
    if (req.method === 'GET')    return list(req, res)
    if (req.method === 'POST')   return create(req, res)
    if (req.method === 'DELETE') return revoke(req, res)
    res.setHeader('Allow', 'GET, POST, DELETE')
    res.status(405).end()
  })
}

async function list(_req: NextApiRequest, res: NextApiResponse) {
  const { data, error } = await sb()
    .from('service_tokens')
    .select('id, name, scopes, created_at, last_used_at, last_used_ip, is_active, notes')
    .order('created_at', { ascending: false })
  if (error) { res.status(500).json({ error: error.message }); return }
  res.status(200).json({ tokens: data || [] })
}

async function create(req: NextApiRequest, res: NextApiResponse) {
  const { name, scopes, notes } = req.body || {}
  if (!name || typeof name !== 'string' || name.length < 3) {
    res.status(400).json({ error: 'name must be at least 3 characters' })
    return
  }
  if (!Array.isArray(scopes) || scopes.length === 0) {
    res.status(400).json({ error: 'scopes must be a non-empty array' })
    return
  }
  for (const s of scopes) {
    if (!VALID_SCOPES.includes(s as Scope)) {
      res.status(400).json({ error: `invalid scope: ${s}. Valid: ${VALID_SCOPES.join(', ')}` })
      return
    }
  }

  // 32 bytes = 64 hex chars. Cryptographically random. Prefix 'jat_' so it's
  // recognisable in logs / config files (Just Autos Token).
  const plaintext = 'jat_' + randomBytes(32).toString('hex')
  const hash = hashToken(plaintext)

  const user = await getSessionUser(req)
  const { data, error } = await sb().from('service_tokens').insert({
    name,
    token_hash: hash,
    scopes,
    notes: notes || null,
    created_by: user?.id || null,
  }).select('id, name, scopes, created_at').single()
  if (error || !data) {
    res.status(500).json({ error: error?.message || 'Insert failed' })
    return
  }

  res.status(201).json({
    ok: true,
    token: { ...data, plaintext },  // plaintext shown ONCE — never returned again
    warning: 'This token will not be shown again. Copy it now and store it securely.',
  })
}

async function revoke(req: NextApiRequest, res: NextApiResponse) {
  const id = (req.query.id as string) || ''
  if (!id) { res.status(400).json({ error: 'id query param required' }); return }
  const { error } = await sb().from('service_tokens').update({ is_active: false }).eq('id', id)
  if (error) { res.status(500).json({ error: error.message }); return }
  res.status(200).json({ ok: true, revoked: id })
}
