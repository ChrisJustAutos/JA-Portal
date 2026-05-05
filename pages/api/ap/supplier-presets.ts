// pages/api/ap/supplier-presets.ts
// Create / list supplier→account preset mappings.
//
// POST /api/ap/supplier-presets
//   Body: {
//     pattern:               string,        // e.g. "REPCO"
//     matchAbn?:             string | null,
//     myobCompanyFile:       'VPS' | 'JAWS',
//     myobSupplierUid:       string,
//     myobSupplierName:      string,
//     defaultAccountUid:     string,
//     defaultAccountCode:    string,        // e.g. "5-1100"
//     defaultAccountName?:   string | null,
//     viaCapricorn?:         boolean,
//     autoApprove?:          boolean,
//     applyToInvoiceId?:     string | null  // re-triage this invoice after save
//   }
//
// GET /api/ap/supplier-presets
//   Returns all presets (most recent first).
//
// Inserting a preset whose `pattern` already exists updates the existing
// preset (the unique constraint on supplier_match_pattern means we'd 23505
// otherwise — upsert keeps the UI flow smooth).

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../lib/authServer'
import { applyTriageAndResolve } from '../../../lib/ap-supabase'
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

export default withAuth(null, async (req, res, user) => {
  if (req.method === 'GET')  return handleList(req, res, user)
  if (req.method === 'POST') return handleCreate(req, res, user)
  return res.status(405).json({ error: 'Method not allowed' })
})

async function handleList(req: NextApiRequest, res: NextApiResponse, user: any) {
  if (!roleHasPermission(user.role, 'view:supplier_invoices')) {
    return res.status(403).json({ error: 'Forbidden' })
  }
  const c = sb()
  const { data, error } = await c
    .from('ap_supplier_account_map')
    .select('*')
    .order('updated_at', { ascending: false })
  if (error) return res.status(500).json({ error: error.message })
  return res.status(200).json({ presets: data || [] })
}

interface CreateBody {
  pattern?: string
  matchAbn?: string | null
  myobCompanyFile?: 'VPS' | 'JAWS'
  myobSupplierUid?: string
  myobSupplierName?: string
  defaultAccountUid?: string
  defaultAccountCode?: string
  defaultAccountName?: string | null
  viaCapricorn?: boolean
  autoApprove?: boolean
  applyToInvoiceId?: string | null
}

async function handleCreate(req: NextApiRequest, res: NextApiResponse, user: any) {
  if (!roleHasPermission(user.role, 'edit:supplier_invoices')) {
    return res.status(403).json({ error: 'Forbidden — edit:supplier_invoices required' })
  }

  const body = (req.body || {}) as CreateBody

  // Validate required fields
  const errors: string[] = []
  const pattern = (body.pattern || '').trim()
  if (!pattern) errors.push('pattern is required')

  const company = body.myobCompanyFile
  if (company !== 'VPS' && company !== 'JAWS') errors.push("myobCompanyFile must be 'VPS' or 'JAWS'")

  if (!body.myobSupplierUid)    errors.push('myobSupplierUid is required')
  if (!body.myobSupplierName)   errors.push('myobSupplierName is required')
  if (!body.defaultAccountUid)  errors.push('defaultAccountUid is required')
  if (!body.defaultAccountCode) errors.push('defaultAccountCode is required')

  if (errors.length > 0) {
    return res.status(400).json({ error: 'Invalid body', details: errors })
  }

  const row = {
    supplier_match_pattern: pattern.toUpperCase(),
    match_abn:              body.matchAbn ? String(body.matchAbn).replace(/\s/g, '') : null,
    myob_company_file:      company,
    myob_supplier_uid:      body.myobSupplierUid!,
    myob_supplier_name:     body.myobSupplierName!,
    default_account_uid:    body.defaultAccountUid!,
    default_account_code:   body.defaultAccountCode!,
    default_account_name:   body.defaultAccountName || null,
    via_capricorn:          body.viaCapricorn === true,
    auto_approve:           body.autoApprove === true,
    created_by:             user.id,
  }

  const c = sb()
  const { data, error } = await c
    .from('ap_supplier_account_map')
    .upsert(row, { onConflict: 'supplier_match_pattern' })
    .select()
    .single()

  if (error) return res.status(500).json({ error: error.message })

  // If the caller supplied an invoice id, re-run triage so it picks up the
  // new preset immediately (clears YELLOW:supplier-not-mapped, populates the
  // resolved_supplier_* fields).
  if (body.applyToInvoiceId) {
    try {
      await applyTriageAndResolve(body.applyToInvoiceId)
    } catch (e: any) {
      console.error('post-preset triage failed:', e?.message)
    }
  }

  return res.status(201).json({ ok: true, preset: data })
}
