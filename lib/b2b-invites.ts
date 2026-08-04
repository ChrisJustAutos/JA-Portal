// lib/b2b-invites.ts
//
// Fresh-invite resend, shared by the per-user admin route and the
// distributor-list bulk action. Invite links are single-use — corporate
// mail scanners pre-click them, so they read as "expired" to the human.
// Resending mints a NEW single-use set-password link and emails it via the
// portal transport (not Supabase's mailer), then refreshes invited_at.

import { SupabaseClient } from '@supabase/supabase-js'

export async function resendInviteEmail(
  c: SupabaseClient,
  userId: string,
): Promise<{ ok: boolean; sent_to?: string; error?: string }> {
  const { data: u, error: fetchErr } = await c
    .from('b2b_distributor_users')
    .select('id, auth_user_id, email, full_name, last_login_at, distributor:b2b_distributors!b2b_distributor_users_distributor_id_fkey ( display_name )')
    .eq('id', userId)
    .maybeSingle()
  if (fetchErr) return { ok: false, error: fetchErr.message }
  if (!u) return { ok: false, error: 'User not found' }
  if (u.last_login_at) {
    return { ok: false, error: 'They have already signed in — no invite needed. "Forgot password" on the login page covers a lost password.' }
  }

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://justautos.app'
  const redirectTo = `${baseUrl}/reset-password?welcome=1&next=${encodeURIComponent('/b2b')}`

  // 'recovery' works for existing (invited) auth users; 'invite' as fallback.
  let link: string | null = null
  let linkErr: string | null = null
  for (const type of ['recovery', 'invite'] as const) {
    try {
      const { data, error } = await c.auth.admin.generateLink({ type, email: u.email, options: { redirectTo } })
      if (!error && data?.properties?.action_link) { link = data.properties.action_link; break }
      linkErr = error?.message || linkErr
    } catch (e: any) { linkErr = e?.message || String(e) }
  }
  if (!link) return { ok: false, error: `Could not generate a fresh invite link${linkErr ? `: ${linkErr}` : ''}` }

  const dist: any = Array.isArray(u.distributor) ? u.distributor[0] : u.distributor
  const distName = dist?.display_name || 'your distributor'
  const firstName = (u.full_name || '').trim().split(/\s+/)[0] || null
  const [{ sendMail }, { buttonHtml }, { getFromMailbox }] = await Promise.all([
    import('./email'), import('./email-templates'), import('./b2b-settings'),
  ])
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
    return { ok: false, error: `Link generated but the email failed to send: ${e?.message || String(e)}` }
  }

  await c.from('b2b_distributor_users').update({ invited_at: new Date().toISOString() }).eq('id', u.id)
  return { ok: true, sent_to: u.email }
}
