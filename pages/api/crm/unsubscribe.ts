// pages/api/crm/unsubscribe.ts — one-click marketing unsubscribe. ?t=<token>.
// GET shows a confirmation page and opts the contact out; POST supports the
// List-Unsubscribe-Post one-click header. Sets crm_contacts.marketing_opt_out
// (NOT do_not_contact — transactional follow-ups still allowed).
import { createClient } from '@supabase/supabase-js'
import type { NextApiRequest, NextApiResponse } from 'next'

function sb() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  return createClient(url!, key!, { auth: { persistSession: false } })
}

function page(title: string, msg: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>`
    + `<body style="font-family:Arial,Helvetica,sans-serif;background:#f5f6f8;margin:0;padding:48px 16px;color:#222">`
    + `<div style="max-width:440px;margin:0 auto;background:#fff;border:1px solid #e3e3e3;border-radius:12px;padding:28px;text-align:center">`
    + `<div style="width:40px;height:40px;border-radius:10px;background:#4f8ef7;color:#fff;font-weight:700;display:inline-flex;align-items:center;justify-content:center;margin-bottom:14px">JA</div>`
    + `<h1 style="font-size:18px;margin:0 0 8px">${title}</h1><p style="font-size:14px;color:#555;line-height:1.5;margin:0">${msg}</p></div></body></html>`
}

async function optOut(t: string) {
  if (!t) return
  const db = sb()
  const { data: r } = await db.from('crm_campaign_recipients').select('id, campaign_id, contact_id').eq('token', t).single()
  if (!r) return
  await db.from('crm_campaign_recipients').update({ unsubscribed_at: new Date().toISOString() }).eq('id', r.id)
  await db.from('crm_email_events').insert({ recipient_id: r.id, campaign_id: r.campaign_id, type: 'unsubscribe' })
  if (r.contact_id) await db.from('crm_contacts').update({ marketing_opt_out: true }).eq('id', r.contact_id)
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const t = String(req.query.t || '')
  try { await optOut(t) } catch { /* show success anyway — don't leak state */ }
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  if (req.method === 'POST') return res.status(200).json({ ok: true })   // List-Unsubscribe one-click
  return res.status(200).send(page('You\'re unsubscribed', 'You won\'t receive any more marketing emails from Just Autos. If this was a mistake, just reply to one of our emails and we\'ll add you back.'))
}
