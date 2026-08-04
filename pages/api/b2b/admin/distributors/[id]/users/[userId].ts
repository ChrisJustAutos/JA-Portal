// pages/api/b2b/admin/distributors/[id]/users/[userId].ts
//
// PATCH  /api/b2b/admin/distributors/{id}/users/{userId}  — update role, full_name, is_active
// DELETE /api/b2b/admin/distributors/{id}/users/{userId}  — remove user (also removes auth.users row
//                                                           unless they belong to another distributor)
// POST   /api/b2b/admin/distributors/{id}/users/{userId}  — body {action:'resend_invite'}: mint a FRESH
//                                                           single-use set-password link and email it
//                                                           (original invite links get consumed by mail
//                                                           scanners / double clicks and read as "expired")
//
// Permission: edit:b2b_distributors

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth, PortalUser } from '../../../../../../../lib/authServer'

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

const VALID_ROLES = ['owner', 'member'] as const
const EDITABLE = ['full_name', 'role', 'is_active'] as const

export default withAuth('edit:b2b_distributors', async (req: NextApiRequest, res: NextApiResponse, _user: PortalUser) => {
  const distributorId = String(req.query.id || '').trim()
  const userId        = String(req.query.userId || '').trim()
  if (!distributorId) return res.status(400).json({ error: 'Missing distributor id' })
  if (!userId)        return res.status(400).json({ error: 'Missing user id' })

  if (req.method === 'PATCH')  return handlePatch(distributorId, userId, req, res)
  if (req.method === 'DELETE') return handleDelete(distributorId, userId, res)
  if (req.method === 'POST' && (req.body || {}).action === 'resend_invite') {
    return handleResendInvite(distributorId, userId, res)
  }
  res.setHeader('Allow', 'PATCH, DELETE, POST')
  return res.status(405).json({ error: 'PATCH, DELETE, or POST {action:"resend_invite"} only' })
})

async function handleResendInvite(distId: string, userId: string, res: NextApiResponse) {
  const c = sb()
  const { data: u, error: fetchErr } = await c
    .from('b2b_distributor_users')
    .select('id, auth_user_id, email, full_name, last_login_at, distributor:b2b_distributors!b2b_distributor_users_distributor_id_fkey ( display_name )')
    .eq('id', userId)
    .eq('distributor_id', distId)
    .maybeSingle()
  if (fetchErr) return res.status(500).json({ error: fetchErr.message })
  if (!u) return res.status(404).json({ error: 'User not found on this distributor' })
  if (u.last_login_at) {
    return res.status(400).json({ error: 'They have already signed in — no invite needed. If they forgot their password, "Forgot password" on the login page works.' })
  }

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://justautos.app'
  const redirectTo = `${baseUrl}/reset-password?welcome=1&next=${encodeURIComponent('/b2b')}`

  // Mint a fresh single-use link. 'recovery' works for existing (invited)
  // auth users; fall back to 'invite' for any edge case.
  let link: string | null = null
  let linkErr: string | null = null
  for (const type of ['recovery', 'invite'] as const) {
    try {
      const { data, error } = await c.auth.admin.generateLink({ type, email: u.email, options: { redirectTo } })
      if (!error && data?.properties?.action_link) { link = data.properties.action_link; break }
      linkErr = error?.message || linkErr
    } catch (e: any) { linkErr = e?.message || String(e) }
  }
  if (!link) return res.status(502).json({ error: 'Could not generate a fresh invite link', detail: linkErr })

  const dist: any = Array.isArray(u.distributor) ? u.distributor[0] : u.distributor
  const distName = dist?.display_name || 'your distributor'
  const firstName = (u.full_name || '').trim().split(/\s+/)[0] || null
  const [{ sendMail }, { buttonHtml }] = await Promise.all([import('../../../../../../../lib/email'), import('../../../../../../../lib/email-templates')])
  const { getFromMailbox } = await import('../../../../../../../lib/b2b-settings')
  const html = `
    <div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;max-width:560px;margin:0 auto;color:#1c2733">
      <h2 style="font-size:20px;margin:18px 0 6px">Your fresh portal invite</h2>
      <p>Hi${firstName ? ' ' + firstName : ''},</p>
      <p>Here's a new sign-up link for the <b>Just Autos B2B Portal</b> (${distName}) — the previous one had already been used, which can happen when email security software checks links automatically.</p>
      <p style="margin:18px 0">${buttonHtml('Set your password & sign in', link)}</p>
      <p style="color:#5c6b7a;font-size:13px">This link is single-use. If the button doesn't work, it may have been consumed by your mail scanner again — reply to this email and we'll sort it another way.</p>
    </div>`
  try {
    await sendMail(await getFromMailbox(), {
      to: [u.email],
      subject: 'Your Just Autos B2B Portal invite — fresh link',
      html,
    })
  } catch (e: any) {
    return res.status(502).json({ error: 'Link generated but the email failed to send', detail: e?.message || String(e) })
  }

  await c.from('b2b_distributor_users').update({ invited_at: new Date().toISOString() }).eq('id', u.id)
  return res.status(200).json({ ok: true, sent_to: u.email })
}

async function handlePatch(distId: string, userId: string, req: NextApiRequest, res: NextApiResponse) {
  const body = (req.body && typeof req.body === 'object') ? req.body : {}
  const update: Record<string, any> = {}
  for (const key of EDITABLE) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      update[key] = body[key]
    }
  }
  if (Object.keys(update).length === 0) {
    return res.status(400).json({ error: 'No editable fields supplied' })
  }
  if ('role' in update && !VALID_ROLES.includes(update.role)) {
    return res.status(400).json({ error: `role must be one of ${VALID_ROLES.join(', ')}` })
  }
  if ('is_active' in update && typeof update.is_active !== 'boolean') {
    return res.status(400).json({ error: 'is_active must be boolean' })
  }
  if ('full_name' in update && update.full_name != null) {
    update.full_name = String(update.full_name).trim() || null
  }

  const c = sb()
  const { data, error } = await c
    .from('b2b_distributor_users')
    .update(update)
    .eq('id', userId)
    .eq('distributor_id', distId)
    .select()
    .single()
  if (error) return res.status(500).json({ error: error.message })
  if (!data) return res.status(404).json({ error: 'User not found on this distributor' })
  return res.status(200).json({ user: data })
}

async function handleDelete(distId: string, userId: string, res: NextApiResponse) {
  const c = sb()
  // Look up the user first so we can also clean up the auth.users record
  const { data: existing, error: fetchErr } = await c
    .from('b2b_distributor_users')
    .select('id, auth_user_id, email')
    .eq('id', userId)
    .eq('distributor_id', distId)
    .maybeSingle()
  if (fetchErr) return res.status(500).json({ error: fetchErr.message })
  if (!existing) return res.status(404).json({ error: 'User not found on this distributor' })

  const { error: delErr } = await c
    .from('b2b_distributor_users')
    .delete()
    .eq('id', userId)
  if (delErr) return res.status(500).json({ error: delErr.message })

  // Best-effort: remove the auth.users record so the email can be re-invited
  // later — but ONLY if this was their last membership (multi-site people
  // keep their login for their other distributors).
  if (existing.auth_user_id) {
    const { data: others } = await c
      .from('b2b_distributor_users')
      .select('id')
      .eq('auth_user_id', existing.auth_user_id)
      .limit(1)
    if (!others || others.length === 0) {
      try { await c.auth.admin.deleteUser(existing.auth_user_id) } catch { /* swallow */ }
    }
  }

  return res.status(200).json({ ok: true, removed_email: existing.email })
}
