// pages/api/ap/line-rules/[id].ts
//
// Edit/delete a single rule.
//
// PUT    /api/ap/line-rules/{id}   — partial update (any subset of fields)
// DELETE /api/ap/line-rules/{id}   — hard delete

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

async function PUT(req: NextApiRequest, res: NextApiResponse, ruleId: string) {
  const body = (req.body || {}) as Record<string, any>
  const update: Record<string, any> = {}

  if ('pattern' in body) {
    const v = trimOrNull(body.pattern)
    if (!v) return res.status(400).json({ error: 'pattern cannot be empty' })
    update.pattern = v
  }
  if ('match_type' in body) {
    const v = (trimOrNull(body.match_type) || '').toLowerCase()
    if (!VALID_MATCH_TYPES.has(v)) {
      return res.status(400).json({ error: `match_type must be one of ${Array.from(VALID_MATCH_TYPES).join(', ')}` })
    }
    update.match_type = v
  }
  if ('match_field' in body) {
    const v = (trimOrNull(body.match_field) || '').toLowerCase()
    if (!VALID_MATCH_FIELDS.has(v)) {
      return res.status(400).json({ error: `match_field must be one of ${Array.from(VALID_MATCH_FIELDS).join(', ')}` })
    }
    update.match_field = v
  }
  if ('case_sensitive' in body) update.case_sensitive = !!body.case_sensitive
  if ('priority' in body) {
    const n = Number(body.priority)
    if (!Number.isFinite(n)) return res.status(400).json({ error: 'priority must be a number' })
    update.priority = Math.round(n)
  }
  if ('account_uid' in body) {
    const v = trimOrNull(body.account_uid)
    if (!v || !UUID_REGEX.test(v)) return res.status(400).json({ error: 'account_uid must be a UUID' })
    update.account_uid = v
  }
  if ('account_code' in body) {
    const v = trimOrNull(body.account_code)
    if (!v) return res.status(400).json({ error: 'account_code cannot be empty' })
    update.account_code = v
  }
  if ('account_name' in body) {
    const v = trimOrNull(body.account_name)
    if (!v) return res.status(400).json({ error: 'account_name cannot be empty' })
    update.account_name = v
  }
  if ('supplier_uid' in body)  update.supplier_uid  = trimOrNull(body.supplier_uid)
  if ('supplier_name' in body) update.supplier_name = trimOrNull(body.supplier_name)
  if ('notes' in body)         update.notes         = trimOrNull(body.notes)
  if ('myob_company_file' in body) {
    const v = (trimOrNull(body.myob_company_file) || '').toUpperCase()
    if (!VALID_COMPANY_FILES.has(v)) {
      return res.status(400).json({ error: `myob_company_file must be one of ${Array.from(VALID_COMPANY_FILES).join(', ')}` })
    }
    update.myob_company_file = v
  }

  // If the new effective match_type is regex, validate the pattern compiles.
  // Need to consider partial updates: if only pattern is being changed, look
  // up the current row's match_type to know whether to validate.
  if ((update.match_type === 'regex') || (update.pattern && !update.match_type)) {
    const c = sb()
    const { data: existing } = await c.from('ap_line_account_rules')
      .select('match_type').eq('id', ruleId).maybeSingle()
    const effectiveType = update.match_type || existing?.match_type
    const effectivePattern = update.pattern // already validated non-empty above
    if (effectiveType === 'regex' && effectivePattern) {
      try { new RegExp(effectivePattern) }
      catch (e: any) {
        return res.status(400).json({ error: `pattern is not a valid regex: ${e?.message}` })
      }
    }
  }

  if (Object.keys(update).length === 0) {
    return res.status(400).json({ error: 'no fields provided' })
  }

  const c = sb()
  const { data, error } = await c
    .from('ap_line_account_rules')
    .update(update)
    .eq('id', ruleId)
    .select('*')
    .maybeSingle()

  if (error) return res.status(500).json({ error: error.message })
  if (!data)  return res.status(404).json({ error: 'Rule not found' })
  return res.status(200).json({ rule: data })
}

async function DELETE(req: NextApiRequest, res: NextApiResponse, ruleId: string) {
  const c = sb()
  const { error, count } = await c
    .from('ap_line_account_rules')
    .delete({ count: 'exact' })
    .eq('id', ruleId)
  if (error) return res.status(500).json({ error: error.message })
  if (!count) return res.status(404).json({ error: 'Rule not found' })
  return res.status(200).json({ ok: true, deleted: ruleId })
}

export default withAuth('edit:supplier_invoices', async (req: NextApiRequest, res: NextApiResponse) => {
  const ruleId = String(req.query.id || '').trim()
  if (!ruleId || !UUID_REGEX.test(ruleId)) {
    return res.status(400).json({ error: 'id (UUID) is required' })
  }
  if (req.method === 'PUT')    return PUT(req, res, ruleId)
  if (req.method === 'DELETE') return DELETE(req, res, ruleId)
  return res.status(405).json({ error: 'Method not allowed — use PUT or DELETE' })
})

function trimOrNull(v: any): string | null {
  if (v === null || v === undefined) return null
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t ? t : null
}
