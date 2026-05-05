// pages/api/ap/line-rules/index.ts
//
// CRUD for ap_line_account_rules — manual patterns that auto-map line
// descriptions to MYOB accounts in the smart-pickup resolver
// (lib/ap-line-resolver.ts).
//
// GET  /api/ap/line-rules
//   Query params:
//     - supplier_uid?: filter to rules for this supplier
//                      (always also includes global rules unless include_global=0)
//     - include_global?: '0' to exclude global rules (default include)
//     - company_file?: 'VPS' | 'JAWS' (default 'VPS')
//   Response: { rules: Rule[], count }
//
// POST /api/ap/line-rules
//   Body:
//     - pattern (required), match_type?, match_field?, case_sensitive?
//     - account_uid (required UUID), account_code (required), account_name (required)
//     - supplier_uid?, supplier_name? (omit for a global rule)
//     - myob_company_file? (default 'VPS')
//     - priority?, notes?
//   Response: { rule: Rule }
//
// Rule precedence in the resolver: priority DESC; supplier-specific outranks
// global at the same priority.

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

const VALID_MATCH_TYPES = new Set(['contains', 'starts_with', 'exact', 'regex'])
const VALID_MATCH_FIELDS = new Set(['description', 'part_number', 'both'])
const VALID_COMPANY_FILES = new Set(['VPS', 'JAWS'])
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function GET(req: NextApiRequest, res: NextApiResponse, userId: string) {
  const supplierUid = trimOrNull(req.query.supplier_uid as string | undefined)
  const includeGlobal = req.query.include_global !== '0'
  const companyFile = (req.query.company_file as string | undefined)?.toUpperCase() || 'VPS'
  if (!VALID_COMPANY_FILES.has(companyFile)) {
    return res.status(400).json({ error: `company_file must be one of ${Array.from(VALID_COMPANY_FILES).join(', ')}` })
  }

  const c = sb()
  let q = c
    .from('ap_line_account_rules')
    .select('*')
    .eq('myob_company_file', companyFile)
    .order('priority', { ascending: false })
    .order('created_at', { ascending: false })

  // Supabase JS .or() handles "supplier-specific OR global" cleanly:
  //   supplier_uid.eq.X,supplier_uid.is.null
  if (supplierUid && includeGlobal) {
    q = q.or(`supplier_uid.eq.${supplierUid},supplier_uid.is.null`)
  } else if (supplierUid && !includeGlobal) {
    q = q.eq('supplier_uid', supplierUid)
  } else if (!supplierUid && !includeGlobal) {
    // No filter that excludes globals makes sense without a supplier — fall
    // through to "all rules". Could also 400 here; permissive feels right
    // for an admin endpoint.
  }

  const { data, error } = await q
  if (error) return res.status(500).json({ error: error.message })
  return res.status(200).json({ rules: data || [], count: (data || []).length })
}

async function POST(req: NextApiRequest, res: NextApiResponse, userId: string) {
  const body = (req.body || {}) as Record<string, any>

  const pattern = trimOrNull(body.pattern)
  if (!pattern) return res.status(400).json({ error: 'pattern is required' })

  const matchType = (trimOrNull(body.match_type) || 'contains').toLowerCase()
  if (!VALID_MATCH_TYPES.has(matchType)) {
    return res.status(400).json({ error: `match_type must be one of ${Array.from(VALID_MATCH_TYPES).join(', ')}` })
  }
  const matchField = (trimOrNull(body.match_field) || 'description').toLowerCase()
  if (!VALID_MATCH_FIELDS.has(matchField)) {
    return res.status(400).json({ error: `match_field must be one of ${Array.from(VALID_MATCH_FIELDS).join(', ')}` })
  }

  // Validate regex compiles before storing — saves the resolver from
  // silently swallowing every invocation.
  if (matchType === 'regex') {
    try { new RegExp(pattern) }
    catch (e: any) {
      return res.status(400).json({ error: `pattern is not a valid regex: ${e?.message}` })
    }
  }

  const accountUid = trimOrNull(body.account_uid)
  if (!accountUid || !UUID_REGEX.test(accountUid)) {
    return res.status(400).json({ error: 'account_uid (UUID) is required' })
  }
  const accountCode = trimOrNull(body.account_code)
  if (!accountCode) return res.status(400).json({ error: 'account_code is required' })
  const accountName = trimOrNull(body.account_name)
  if (!accountName) return res.status(400).json({ error: 'account_name is required' })

  const supplierUid  = trimOrNull(body.supplier_uid)
  const supplierName = trimOrNull(body.supplier_name)

  const companyFile = (trimOrNull(body.myob_company_file) || 'VPS').toUpperCase()
  if (!VALID_COMPANY_FILES.has(companyFile)) {
    return res.status(400).json({ error: `myob_company_file must be one of ${Array.from(VALID_COMPANY_FILES).join(', ')}` })
  }

  const priority = numOrDefault(body.priority, 100)
  const caseSensitive = !!body.case_sensitive

  const c = sb()
  const { data, error } = await c
    .from('ap_line_account_rules')
    .insert({
      supplier_uid:      supplierUid,
      supplier_name:     supplierName,
      myob_company_file: companyFile,
      pattern,
      match_type:        matchType,
      match_field:       matchField,
      case_sensitive:    caseSensitive,
      account_uid:       accountUid,
      account_code:      accountCode,
      account_name:      accountName,
      priority,
      notes:             trimOrNull(body.notes),
      created_by:        userId,
    })
    .select('*')
    .single()

  if (error) return res.status(500).json({ error: error.message })
  return res.status(201).json({ rule: data })
}

export default withAuth('edit:supplier_invoices', async (req: NextApiRequest, res: NextApiResponse, ctx: any) => {
  const userId: string = ctx?.user?.id || ''
  if (req.method === 'GET')  return GET(req, res, userId)
  if (req.method === 'POST') return POST(req, res, userId)
  return res.status(405).json({ error: 'Method not allowed — use GET or POST' })
})

function trimOrNull(v: any): string | null {
  if (v === null || v === undefined) return null
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t ? t : null
}
function numOrDefault(v: any, d: number): number {
  if (v === null || v === undefined || v === '') return d
  const n = Number(v)
  return Number.isFinite(n) ? n : d
}
