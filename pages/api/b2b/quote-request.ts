// pages/api/b2b/quote-request.ts
//
// POST /api/b2b/quote-request
//   body: { note?: string }
//
// A distributor whose cart contains a line over its per-item "quote" threshold
// (migration 125) can't self-checkout that line. This endpoint emails the
// office the distributor + the full cart (flagging the over-limit items that
// need pricing) so a person can prepare a manual quote. No order is created.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withB2BAuth, B2BUser } from '../../../lib/b2bAuthServer'
import { sendMail } from '../../../lib/email'
import { getFromMailbox } from '../../../lib/b2b-settings'
import { linesTableHtml } from '../../../lib/email-templates'
import { resolveOverLimit } from '../../../lib/b2b-over-limit'

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

function esc(s: any): string {
  return String(s ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch] as string))
}

async function resolveRecipients(c: SupabaseClient): Promise<string[]> {
  const { data } = await c.from('b2b_settings').select('admin_order_notify_emails').eq('id', 'singleton').maybeSingle()
  const raw = String(data?.admin_order_notify_emails || process.env.B2B_ADMIN_NOTIFY_EMAILS || '').trim()
  return raw.split(/[,;\s]+/).map(s => s.trim()).filter(s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s))
}

export default withB2BAuth(async (req: NextApiRequest, res: NextApiResponse, user: B2BUser) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'POST only' })
  }

  let note = ''
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {})
    if (typeof body.note === 'string') note = body.note.trim().slice(0, 1000)
  } catch { /* ignore bad body */ }

  const c = sb()

  // Load the distributor's cart.
  const { data: cart } = await c
    .from('b2b_carts').select('id').eq('distributor_user_id', user.id).maybeSingle()
  if (!cart) return res.status(400).json({ error: 'Your cart is empty' })

  const { data: rows, error: rErr } = await c
    .from('b2b_cart_items')
    .select(`
      qty,
      catalogue:b2b_catalogue!b2b_cart_items_catalogue_id_fkey (
        sku, name, over_limit_qty, over_limit_action
      )
    `)
    .eq('cart_id', cart.id)
    .order('added_at', { ascending: true })
  if (rErr) return res.status(500).json({ error: rErr.message })

  const all = (rows || []).map((r: any) => {
    const cat = Array.isArray(r.catalogue) ? r.catalogue[0] : r.catalogue
    const qty = Number(r.qty || 0)
    const ol = cat ? resolveOverLimit(cat, qty) : { triggered: false, action: null, threshold: null }
    return { sku: cat?.sku || '', name: cat?.name || cat?.sku || '(item)', qty, needsQuote: ol.triggered && ol.action === 'quote', threshold: ol.threshold }
  })
  const quoteLines = all.filter(l => l.needsQuote)
  if (quoteLines.length === 0) {
    return res.status(400).json({ error: 'No items in your cart need a quote.' })
  }

  const recipients = await resolveRecipients(c)
  if (recipients.length === 0) {
    return res.status(503).json({ error: 'Quote requests aren’t configured yet — please contact your account manager directly.' })
  }

  // Pull the distributor's contact details so the office can reply.
  const { data: dist } = await c
    .from('b2b_distributors')
    .select('display_name, primary_contact_email, primary_contact_phone')
    .eq('id', user.distributor.id)
    .maybeSingle()

  const quoteTable = linesTableHtml(quoteLines.map(l => ({
    description: `${[l.sku, l.name].filter(Boolean).join(' — ')} (over the ${l.threshold}-unit limit)`,
    qty: l.qty,
  })))
  const restLines = all.filter(l => !l.needsQuote)
  const restTable = restLines.length
    ? `<h3 style="font-size:14px;margin:18px 0 6px">Rest of the cart</h3>${linesTableHtml(restLines.map(l => ({ description: [l.sku, l.name].filter(Boolean).join(' — '), qty: l.qty })))}`
    : ''

  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;color:#222;font-size:14px;line-height:1.5">
      <h2 style="font-size:18px;margin:0 0 12px">B2B quote request</h2>
      <p><strong>${esc(dist?.display_name || user.distributor.displayName || 'Distributor')}</strong> has asked for a quote on a large-quantity order.</p>
      <p style="margin:4px 0">
        Requested by: ${esc(user.email || '')}${dist?.primary_contact_phone ? ` · ${esc(dist.primary_contact_phone)}` : ''}<br/>
        Reply to: ${esc(dist?.primary_contact_email || user.email || '')}
      </p>
      <h3 style="font-size:14px;margin:18px 0 6px">Items needing a quote</h3>
      ${quoteTable}
      ${note ? `<p style="margin:14px 0;padding:10px 12px;background:#f6f6f6;border-radius:6px"><strong>Note from distributor:</strong><br/>${esc(note)}</p>` : ''}
      ${restTable}
      <p style="color:#888;font-size:12px;margin-top:18px">Sent from the JA Portal B2B cart. No order has been created.</p>
    </div>`

  try {
    await sendMail(await getFromMailbox(), {
      to: recipients,
      subject: `B2B quote request — ${dist?.display_name || user.distributor.displayName || 'Distributor'}`,
      html,
    })
  } catch (e: any) {
    return res.status(502).json({ error: `Couldn’t send the quote request: ${e?.message || e}` })
  }

  return res.status(200).json({ ok: true, notified: recipients.length, items: quoteLines.length })
})
