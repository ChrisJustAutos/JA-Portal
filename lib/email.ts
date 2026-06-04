// lib/email.ts
// Unified outbound app email. Prefers Resend (HTTP API) when RESEND_API_KEY is
// set; otherwise falls back to Microsoft Graph sendMail (lib/microsoft-graph).
// Drop-in, signature-compatible with the Graph sendMail so callers just swap the
// import. This lets us move off Graph (which is returning 403 on Mail.Send until
// the Entra app permission is granted) without re-touching every call site.
//
// Env:
//   RESEND_API_KEY  Enables Resend. Without it, the legacy Graph path is used.
//   RESEND_FROM     Verified sender, e.g. `Just Autos <noreply@mail.justautos.app>`.
//                   Must be on a Resend-verified domain. Falls back to the
//                   `mailbox` argument when unset (only works if that domain is
//                   the one verified in Resend).
//   RESEND_REPLY_TO Optional default reply-to (e.g. accounts@justautosmechanical.com.au)
//                   so replies to a noreply@ sender land in a monitored inbox.
//                   A per-call replyTo always wins. Applied to both paths.

import { sendMail as graphSendMail } from './microsoft-graph'

export interface MailOptions {
  to: string[]
  subject: string
  html: string
  cc?: string[]
  replyTo?: string
  attachments?: { name: string; contentType: string; content: Buffer }[]
}

// `mailbox` is the intended sender. With Graph it's the M365 mailbox to send as;
// with Resend it's the fallback "from" when RESEND_FROM isn't configured.
export async function sendMail(mailbox: string, opts: MailOptions): Promise<void> {
  // A per-call replyTo wins; otherwise fall back to the configured default so
  // replies to a noreply@ sender reach a real inbox.
  const replyTo = opts.replyTo || (process.env.RESEND_REPLY_TO || '').trim() || undefined

  const key = (process.env.RESEND_API_KEY || '').trim()
  if (!key) { await graphSendMail(mailbox, { ...opts, replyTo }); return }

  const from = (process.env.RESEND_FROM || '').trim() || mailbox
  const payload: Record<string, any> = {
    from,
    to: opts.to,
    subject: opts.subject,
    html: opts.html,
  }
  if (opts.cc && opts.cc.length) payload.cc = opts.cc
  if (replyTo) payload.reply_to = replyTo
  if (opts.attachments && opts.attachments.length) {
    payload.attachments = opts.attachments.map(a => ({
      filename: a.name,
      content: a.content.toString('base64'),
      content_type: a.contentType,
    }))
  }
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!r.ok) {
    const t = await r.text().catch(() => '')
    throw new Error(`Resend ${r.status}: ${t.slice(0, 400)}`)
  }
}
