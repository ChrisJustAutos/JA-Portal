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
import { fetchIncomeAccounts } from '../../lib/myob-reporting'

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
  // Direct MYOB OAuth (CData decommissioned 2026-07-14) — income accounts (4-)
  // from the JAWS chart of accounts.
  const data = await fetchIncomeAccounts('JAWS')
  _accountsCache = { data, at: Date.now() }
  return data
}

async function handleGet(res: NextApiResponse) {
  const sb = sbAdmin()
  // NOTE: customer exclusions moved to the dist_groups system and the legacy
  // distributor_report_excluded_customers table was DROPPED — querying it
  // 500'd this whole endpoint and blanked the Revenue Categories screen
  // (found 2026-07-21). excludedCustomers stays in the response shape as []
  // for older clients.
  const [catsRes, accounts] = await Promise.all([
    sb.from('distributor_report_categories').select('id, name, sort_order, account_codes, updated_at').order('sort_order'),
    fetchMyobAccounts().catch((e: any) => {
      console.error('distributor-config: MYOB accounts fetch failed —', e?.message)
      return []
    }),
  ])
  if (catsRes.error) { res.status(500).json({ error: 'Failed to load categories: ' + catsRes.error.message }); return }
  res.status(200).json({
    categories: catsRes.data || [],
    excludedCustomers: [],
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

  // Excluded customers: legacy — the table is gone (exclusions live in the
  // dist_groups Membership system). Anything the client sends is ignored.
  if (excluded.length > 0) {
    console.warn('distributor-config: ignoring legacy excludedCustomers payload —', excluded.length, 'rows (manage exclusions in Distributor Groups)')
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
