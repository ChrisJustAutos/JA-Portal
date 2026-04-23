// pages/api/distributor-config.ts
// Admin-only: GET returns current categories + excluded customers + MYOB account
// list for the picker. POST saves updated config (full replace semantics — the
// client sends the whole desired state and we overwrite).
//
// Security: gated by requireAdmin. Only admin role can read or write this config
// because changes affect every user of the distributor report.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { requireAdmin, getSessionUser } from '../../lib/auth'
import { cdataQuery } from '../../lib/cdata'

export const config = { maxDuration: 30 }

function sbAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!
  return createClient(url, key, { auth: { persistSession: false } })
}

interface Category {
  id?: string
  name: string
  sort_order: number
  account_codes: string[]
}

// Must match the DB CHECK constraint on distributor_report_excluded_customers.note
// and the validation in /api/exclusions.ts.
const VALID_NOTES = ['Excluded', 'Sundry', 'Internal'] as const
type ExclusionNote = typeof VALID_NOTES[number]

interface ExcludedCustomer {
  id?: string
  customer_name: string
  note: ExclusionNote
}

// Simple in-memory cache for the MYOB account list (changes rarely)
let _accountsCache: { data: any[]; at: number } | null = null
const ACCOUNTS_TTL = 10 * 60 * 1000  // 10 min

async function fetchMyobAccounts(): Promise<Array<{ code: string; name: string }>> {
  if (_accountsCache && Date.now() - _accountsCache.at < ACCOUNTS_TTL) {
    return _accountsCache.data
  }
  const res: any = await cdataQuery('JAWS',
    "SELECT DISTINCT [AccountDisplayID], [AccountName] FROM [MYOB_POWERBI_JAWS].[MYOB].[SaleInvoiceItems] WHERE [AccountDisplayID] LIKE '4-%' ORDER BY [AccountDisplayID]"
  )
  const rows: any[][] = res?.results?.[0]?.rows || []
  const data = rows.map(r => ({ code: String(r[0]), name: String(r[1] || '') }))
  _accountsCache = { data, at: Date.now() }
  return data
}

async function handleGet(res: NextApiResponse) {
  const sb = sbAdmin()
  const [catsRes, exRes, accounts] = await Promise.all([
    sb.from('distributor_report_categories').select('id, name, sort_order, account_codes, updated_at').order('sort_order'),
    sb.from('distributor_report_excluded_customers').select('id, customer_name, note, created_at').order('customer_name'),
    fetchMyobAccounts().catch((e: any) => {
      console.error('distributor-config: MYOB accounts fetch failed —', e?.message)
      return []
    }),
  ])
  if (catsRes.error) { res.status(500).json({ error: 'Failed to load categories: ' + catsRes.error.message }); return }
  if (exRes.error)   { res.status(500).json({ error: 'Failed to load excluded customers: ' + exRes.error.message }); return }
  res.status(200).json({
    categories: catsRes.data || [],
    excludedCustomers: exRes.data || [],
    myobAccounts: accounts,
  })
}

async function handlePost(req: NextApiRequest, res: NextApiResponse) {
  const user = await getSessionUser(req)
  if (!user) { res.status(401).json({ error: 'Unauthorised' }); return }

  const body = req.body || {}
  const categories: Category[] = Array.isArray(body.categories) ? body.categories : []
  const excluded: ExcludedCustomer[] = Array.isArray(body.excludedCustomers) ? body.excludedCustomers : []

  // Validate
  if (categories.length === 0) {
    res.status(400).json({ error: 'At least one category is required' })
    return
  }
  const names = categories.map(c => c.name.trim().toLowerCase())
  if (new Set(names).size !== names.length) {
    res.status(400).json({ error: 'Category names must be unique' })
    return
  }
  for (const c of categories) {
    if (!c.name?.trim()) { res.status(400).json({ error: 'Category name cannot be empty' }); return }
    if (!Array.isArray(c.account_codes)) { res.status(400).json({ error: 'account_codes must be an array' }); return }
  }

  const sb = sbAdmin()

  // Full-replace semantics using a transaction-ish approach: delete-all then insert.
  // Categories: match by name so re-saves don't churn IDs unnecessarily — upsert by name.
  // Simpler approach: delete all, reinsert. Fine for a table this small (handful of rows).
  const { error: delCatsErr } = await sb.from('distributor_report_categories').delete().gte('sort_order', 0)
  if (delCatsErr) { res.status(500).json({ error: 'Failed to clear categories: ' + delCatsErr.message }); return }

  const catRows = categories.map((c, i) => ({
    name: c.name.trim(),
    sort_order: Number.isFinite(c.sort_order) ? c.sort_order : i,
    account_codes: Array.from(new Set(c.account_codes.map(s => s.trim()).filter(Boolean))),
    updated_by: user.id,
  }))
  const { error: insCatsErr } = await sb.from('distributor_report_categories').insert(catRows)
  if (insCatsErr) { res.status(500).json({ error: 'Failed to save categories: ' + insCatsErr.message }); return }

  // Excluded customers: same full-replace approach
  const { error: delExErr } = await sb.from('distributor_report_excluded_customers').delete().neq('customer_name', '___impossible_placeholder___')
  if (delExErr) { res.status(500).json({ error: 'Failed to clear excluded customers: ' + delExErr.message }); return }

  if (excluded.length > 0) {
    // Validate each row: note must be one of the allowed values.
    for (const x of excluded) {
      if (!x.customer_name?.trim()) continue   // skipped below
      if (!VALID_NOTES.includes(x.note as ExclusionNote)) {
        res.status(400).json({
          error: `Invalid note for "${x.customer_name}". Must be one of: ${VALID_NOTES.join(', ')}. Got: ${JSON.stringify(x.note)}`,
        })
        return
      }
    }

    const exRows = excluded
      .filter(x => x.customer_name?.trim())
      .map(x => ({
        customer_name: x.customer_name.trim(),
        note: x.note,   // validated above
        created_by: user.id,
      }))
    // Dedupe by lowercased name
    const seen = new Set<string>()
    const deduped = exRows.filter(r => {
      const k = r.customer_name.toLowerCase()
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
    if (deduped.length > 0) {
      const { error: insExErr } = await sb.from('distributor_report_excluded_customers').insert(deduped)
      if (insExErr) { res.status(500).json({ error: 'Failed to save excluded customers: ' + insExErr.message }); return }
    }
  }

  // Bust the distributor-report cache so changes appear immediately
  res.setHeader('X-Config-Updated', 'true')
  res.status(200).json({ ok: true })
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  return requireAdmin(req, res, async () => {
    if (req.method === 'GET')  return handleGet(res)
    if (req.method === 'POST') return handlePost(req, res)
    res.status(405).json({ error: 'Method not allowed' })
  })
}
