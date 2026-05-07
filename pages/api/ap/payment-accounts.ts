// pages/api/ap/payment-accounts.ts
// Admin CRUD for ap_payment_accounts — the list of clearing accounts
// the AP detail page offers when "Mark as paid" is ticked. Used by the
// MYOB Connection settings page and (read-only) by the AP detail page
// to populate the payment-account dropdown.
//
//   GET    /api/ap/payment-accounts                    → list all
//   GET    /api/ap/payment-accounts?company=VPS&active → filtered
//   POST   /api/ap/payment-accounts                    → create
//   PATCH  /api/ap/payment-accounts?id=<uuid>          → update
//   DELETE /api/ap/payment-accounts?id=<uuid>          → delete
//
// Read is allowed for any user with view:supplier_invoices (the AP
// detail page needs the list). Write is admin:settings — same gate as
// the MYOB connection settings.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../lib/authServer'
import { roleHasPermission } from '../../../lib/permissions'

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function parseCompany(v: any): 'VPS' | 'JAWS' | null {
  const c = String(v || '').toUpperCase()
  return c === 'VPS' || c === 'JAWS' ? c : null
}

const PATCHABLE = new Set([
  'label', 'account_uid', 'account_code', 'account_name',
  'is_default_for_capricorn', 'is_active', 'sort_order',
])

export default withAuth('view:supplier_invoices', async (req: NextApiRequest, res: NextApiResponse, user) => {
  const c = sb()

  if (req.method === 'GET') {
    const company = parseCompany(req.query.company)
    const onlyActive = req.query.active === '1' || req.query.active === 'true'
    let q = c.from('ap_payment_accounts').select('*').order('sort_order', { ascending: true })
    if (company)    q = q.eq('myob_company_file', company)
    if (onlyActive) q = q.eq('is_active', true)
    const { data, error } = await q
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ accounts: data || [] })
  }

  // Mutations require admin:settings.
  if (!roleHasPermission(user.role, 'admin:settings')) {
    return res.status(403).json({ error: 'Forbidden — admin:settings required' })
  }

  if (req.method === 'POST') {
    const body = (req.body || {}) as Record<string, any>
    const company = parseCompany(body.myob_company_file)
    if (!company) return res.status(400).json({ error: "myob_company_file must be 'VPS' or 'JAWS'" })

    const label = String(body.label || '').trim().slice(0, 80)
    if (!label) return res.status(400).json({ error: 'label is required' })

    const accountUid = String(body.account_uid || '').trim()
    if (!UUID_REGEX.test(accountUid)) return res.status(400).json({ error: 'account_uid must be a UUID' })

    const accountCode = String(body.account_code || '').trim().slice(0, 30)
    const accountName = String(body.account_name || '').trim().slice(0, 200)
    if (!accountCode || !accountName) {
      return res.status(400).json({ error: 'account_code and account_name are required' })
    }

    const isCapDefault = body.is_default_for_capricorn === true
    const isActive     = body.is_active !== false
    const sortOrder    = Number.isFinite(Number(body.sort_order)) ? Number(body.sort_order) : 0

    // Enforce single Cap-default per company file: if this row is being
    // flagged, clear any existing default in the same file first.
    if (isCapDefault) {
      await c.from('ap_payment_accounts')
        .update({ is_default_for_capricorn: false })
        .eq('myob_company_file', company)
        .eq('is_default_for_capricorn', true)
    }

    const { data, error } = await c.from('ap_payment_accounts').insert({
      myob_company_file: company,
      label,
      account_uid:  accountUid,
      account_code: accountCode,
      account_name: accountName,
      is_default_for_capricorn: isCapDefault,
      is_active:    isActive,
      sort_order:   sortOrder,
    }).select().single()
    if (error) return res.status(500).json({ error: error.message })
    return res.status(201).json({ account: data })
  }

  const id = String(req.query.id || '').trim()
  if (!id || !UUID_REGEX.test(id)) {
    return res.status(400).json({ error: 'id query param required (UUID)' })
  }

  if (req.method === 'PATCH') {
    const body = (req.body || {}) as Record<string, any>
    const update: Record<string, any> = {}
    for (const k of Object.keys(body)) {
      if (PATCHABLE.has(k)) update[k] = body[k]
    }
    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'No patchable fields supplied' })
    }
    if ('account_uid' in update && !UUID_REGEX.test(String(update.account_uid))) {
      return res.status(400).json({ error: 'account_uid must be a UUID' })
    }

    // If flipping is_default_for_capricorn → true, clear any other default
    // in the same company file first.
    if (update.is_default_for_capricorn === true) {
      const { data: row } = await c.from('ap_payment_accounts')
        .select('myob_company_file').eq('id', id).maybeSingle()
      if (row) {
        await c.from('ap_payment_accounts')
          .update({ is_default_for_capricorn: false })
          .eq('myob_company_file', row.myob_company_file)
          .eq('is_default_for_capricorn', true)
          .neq('id', id)
      }
    }

    const { data, error } = await c.from('ap_payment_accounts')
      .update(update).eq('id', id).select().single()
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ account: data })
  }

  if (req.method === 'DELETE') {
    const { error } = await c.from('ap_payment_accounts').delete().eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  res.setHeader('Allow', 'GET, POST, PATCH, DELETE')
  return res.status(405).json({ error: 'Method not allowed' })
})
