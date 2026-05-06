// pages/api/b2b/admin/settings.ts
//
// Staff endpoint for reading + updating B2B portal settings.
//
// GET   → returns current settings + computed preview of next invoice number
// PATCH → updates editable fields (prefix, padding, sequence reset)
//
// Permission gate: edit:b2b_distributors (admin/manager). For chunk 3c we
// might split this into a dedicated edit:b2b_settings perm, but reusing
// the existing admin-only perm is fine for V1.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../lib/authServer'

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

export default withAuth('edit:b2b_distributors', async (req: NextApiRequest, res: NextApiResponse) => {
  const c = sb()

  if (req.method === 'GET') {
    const { data: settings, error } = await c
      .from('b2b_settings')
      .select(`
        id,
        card_fee_percent, card_fee_fixed,
        myob_company_file,
        myob_jaws_gst_tax_code_uid, myob_jaws_fre_tax_code_uid,
        myob_card_fee_account_uid, myob_card_fee_account_code,
        myob_invoice_number_prefix, myob_invoice_number_padding, myob_invoice_number_seq,
        myob_credit_note_number_prefix, myob_credit_note_number_padding, myob_credit_note_number_seq,
        slack_new_order_webhook_url,
        last_catalogue_sync_at, last_catalogue_sync_added, last_catalogue_sync_updated, last_catalogue_sync_error,
        updated_at, updated_by
      `)
      .eq('id', 'singleton')
      .maybeSingle()
    if (error) return res.status(500).json({ error: error.message })

    // Compute previews of next numbers using the SQL functions
    const { data: invPreviewRow } = await c.rpc('b2b_preview_next_myob_invoice_number')
    const next_invoice_number_preview = (typeof invPreviewRow === 'string') ? invPreviewRow : null

    const { data: cnPreviewRow } = await c.rpc('b2b_preview_next_myob_credit_note_number')
    const next_credit_note_number_preview = (typeof cnPreviewRow === 'string') ? cnPreviewRow : null

    return res.status(200).json({
      settings,
      next_invoice_number_preview,
      next_credit_note_number_preview,
      stripe_env: {
        secret_key_set:    !!process.env.STRIPE_SECRET_KEY,
        webhook_secret_set:!!process.env.STRIPE_WEBHOOK_SECRET,
      },
    })
  }

  if (req.method === 'PATCH') {
    const body = (req.body && typeof req.body === 'object') ? req.body : {}

    // Build update payload from whitelisted fields
    const update: Record<string, any> = {}
    const issues: string[] = []

    if ('myob_invoice_number_prefix' in body) {
      const p = String(body.myob_invoice_number_prefix || '').trim()
      if (!p) issues.push('Prefix cannot be empty')
      else if (/\s/.test(p)) issues.push('Prefix cannot contain whitespace')
      else if (p.length > 8) issues.push('Prefix max 8 characters')
      else update.myob_invoice_number_prefix = p
    }

    if ('myob_invoice_number_padding' in body) {
      const v = parseInt(String(body.myob_invoice_number_padding), 10)
      if (!isFinite(v) || v < 4 || v > 8) issues.push('Padding must be between 4 and 8')
      else update.myob_invoice_number_padding = v
    }

    if ('myob_invoice_number_seq' in body) {
      const v = parseInt(String(body.myob_invoice_number_seq), 10)
      if (!isFinite(v) || v < 0) issues.push('Sequence must be a non-negative integer')
      else update.myob_invoice_number_seq = v
    }

    if ('myob_credit_note_number_prefix' in body) {
      const p = String(body.myob_credit_note_number_prefix || '').trim()
      if (!p) issues.push('Credit note prefix cannot be empty')
      else if (/\s/.test(p)) issues.push('Credit note prefix cannot contain whitespace')
      else if (p.length > 8) issues.push('Credit note prefix max 8 characters')
      else update.myob_credit_note_number_prefix = p
    }

    if ('myob_credit_note_number_padding' in body) {
      const v = parseInt(String(body.myob_credit_note_number_padding), 10)
      if (!isFinite(v) || v < 4 || v > 8) issues.push('Credit note padding must be between 4 and 8')
      else update.myob_credit_note_number_padding = v
    }

    if ('myob_credit_note_number_seq' in body) {
      const v = parseInt(String(body.myob_credit_note_number_seq), 10)
      if (!isFinite(v) || v < 0) issues.push('Credit note sequence must be a non-negative integer')
      else update.myob_credit_note_number_seq = v
    }

    if ('card_fee_percent' in body) {
      const v = Number(body.card_fee_percent)
      if (!isFinite(v) || v < 0 || v > 0.10) issues.push('Card fee % must be between 0 and 0.10 (10%)')
      else update.card_fee_percent = v
    }

    if ('card_fee_fixed' in body) {
      const v = Number(body.card_fee_fixed)
      if (!isFinite(v) || v < 0 || v > 5) issues.push('Card fee fixed must be between $0 and $5')
      else update.card_fee_fixed = v
    }

    if ('slack_new_order_webhook_url' in body) {
      const u = String(body.slack_new_order_webhook_url || '').trim()
      if (u && !u.startsWith('https://hooks.slack.com/')) issues.push('Slack webhook URL must start with https://hooks.slack.com/')
      else update.slack_new_order_webhook_url = u || null
    }

    // Cross-field validation: prefix + padding ≤ 13 (MYOB cap) for both streams
    const willInvPrefix  = update.myob_invoice_number_prefix  ?? null
    const willInvPadding = update.myob_invoice_number_padding ?? null
    const willCnPrefix   = update.myob_credit_note_number_prefix  ?? null
    const willCnPadding  = update.myob_credit_note_number_padding ?? null
    if (willInvPrefix != null || willInvPadding != null || willCnPrefix != null || willCnPadding != null) {
      const { data: cur } = await c
        .from('b2b_settings')
        .select('myob_invoice_number_prefix, myob_invoice_number_padding, myob_credit_note_number_prefix, myob_credit_note_number_padding')
        .eq('id', 'singleton')
        .maybeSingle()

      if (willInvPrefix != null || willInvPadding != null) {
        const prefix = willInvPrefix ?? cur?.myob_invoice_number_prefix ?? 'JA'
        const padding = willInvPadding ?? cur?.myob_invoice_number_padding ?? 6
        if (prefix.length + padding > 13) {
          issues.push(`Invoice prefix + padding length must be ≤ 13. With prefix="${prefix}" and padding=${padding}, the total would be ${prefix.length + padding} chars.`)
        }
      }

      if (willCnPrefix != null || willCnPadding != null) {
        const prefix = willCnPrefix ?? cur?.myob_credit_note_number_prefix ?? 'CR'
        const padding = willCnPadding ?? cur?.myob_credit_note_number_padding ?? 6
        if (prefix.length + padding > 13) {
          issues.push(`Credit note prefix + padding length must be ≤ 13. With prefix="${prefix}" and padding=${padding}, the total would be ${prefix.length + padding} chars.`)
        }
      }
    }

    if (issues.length > 0) {
      return res.status(400).json({ error: 'Validation failed', issues })
    }
    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'No editable fields supplied' })
    }

    update.updated_at = new Date().toISOString()
    const { error } = await c.from('b2b_settings').update(update).eq('id', 'singleton')
    if (error) return res.status(500).json({ error: error.message })

    return res.status(200).json({ ok: true, updated: update })
  }

  res.setHeader('Allow', 'GET, PATCH')
  return res.status(405).json({ error: 'GET or PATCH only' })
})
