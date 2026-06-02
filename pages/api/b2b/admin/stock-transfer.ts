// pages/api/b2b/admin/stock-transfer.ts
// Staff endpoint for internal JAWS → VPS stock transfers.
//
// GET  ?view=items     — catalogue items + live JAWS average cost / on-hand
// GET  ?view=history   — past transfers (with lines)
// GET  ?lookup=customers|suppliers|accounts&q=… — MYOB typeahead for setup:
//        customers → JAWS Contact/Customer (the "VPS" card the invoice bills)
//        suppliers → VPS Contact/Supplier (the "JAWS" card the bill comes from)
//        accounts  → VPS GeneralLedger/Account (postable, where the bill lands)
// GET  (default)       — transfer config (the three picked references)
// POST {action:'save-settings', …}  — persist the three MYOB references
// POST {action:'execute', lines:[{catalogue_id, qty}], note} — run a transfer
// POST {action:'retry', transferId} — re-attempt the VPS bill of a partial

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../lib/authServer'
import { getConnection, myobFetch } from '../../../../lib/myob'
import {
  loadTransferConfig, fetchJawsItemCosts, executeStockTransfer, retryVpsBill,
} from '../../../../lib/b2b-stock-transfer'

// Big transfers = one MYOB invoice with hundreds of item lines + a bill +
// a full stock refresh. Give it room.
export const config = { maxDuration: 300 }

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

function escapeOData(s: string): string { return s.replace(/'/g, "''") }

function contactName(c: any): string {
  const company = (c.CompanyName || '').trim()
  return company || [c.FirstName, c.LastName].filter(Boolean).join(' ').trim() || '(unnamed)'
}

export default withAuth('edit:b2b_distributors', async (req: NextApiRequest, res: NextApiResponse, user) => {
  const c = sb()

  try {
    if (req.method === 'GET') {
      const view = String(req.query.view || '').trim()
      const lookup = String(req.query.lookup || '').trim()

      // ── MYOB typeahead lookups for setup ──────────────────────────────
      if (lookup) {
        const q = String(req.query.q || '').trim().toLowerCase()
        const top = 20
        if (lookup === 'customers' || lookup === 'suppliers') {
          const label = lookup === 'customers' ? 'JAWS' : 'VPS'
          const entity = lookup === 'customers' ? 'Customer' : 'Supplier'
          const conn = await getConnection(label)
          if (!conn) return res.status(500).json({ error: `${label} MYOB connection not configured` })
          const params: Record<string, string | number> = { '$top': top, '$orderby': 'CompanyName' }
          if (q) {
            const safe = escapeOData(q)
            params['$filter'] = `IsActive eq true and (substringof('${safe}',tolower(CompanyName)) or substringof('${safe}',tolower(LastName)) or substringof('${safe}',tolower(DisplayID)))`
          } else {
            params['$filter'] = 'IsActive eq true'
          }
          const r = await myobFetch(conn.id, `/accountright/${conn.company_file_id}/Contact/${entity}`, { query: params })
          if (r.status !== 200) return res.status(502).json({ error: `MYOB ${entity} search failed (HTTP ${r.status})` })
          const items: any[] = Array.isArray(r.data?.Items) ? r.data.Items : []
          return res.status(200).json({ items: items.map(it => ({ uid: it.UID, name: contactName(it), display_id: it.DisplayID || '' })) })
        }
        if (lookup === 'accounts') {
          const conn = await getConnection('VPS')
          if (!conn) return res.status(500).json({ error: 'VPS MYOB connection not configured' })
          const params: Record<string, string | number> = { '$top': top, '$orderby': 'DisplayID' }
          const base = 'IsActive eq true and IsHeader eq false'
          params['$filter'] = q
            ? `${base} and (substringof('${escapeOData(q)}',tolower(Name)) or substringof('${escapeOData(q)}',DisplayID))`
            : base
          const r = await myobFetch(conn.id, `/accountright/${conn.company_file_id}/GeneralLedger/Account`, { query: params })
          if (r.status !== 200) return res.status(502).json({ error: `MYOB account search failed (HTTP ${r.status})` })
          const items: any[] = Array.isArray(r.data?.Items) ? r.data.Items : []
          return res.status(200).json({
            items: items.map(it => ({ uid: it.UID, name: `${it.DisplayID || ''} ${it.Name || ''}`.trim(), display_id: it.DisplayID || '', type: it.Type || '' })),
          })
        }
        return res.status(400).json({ error: 'lookup must be customers, suppliers or accounts' })
      }

      // ── Items: catalogue + live JAWS cost / on-hand ───────────────────
      if (view === 'items') {
        const [{ data: rows, error }, costs] = await Promise.all([
          c.from('b2b_catalogue')
            .select('id, sku, name, myob_item_uid, is_taxable')
            .not('myob_item_uid', 'is', null)
            .order('sku', { ascending: true })
            .limit(2000),
          fetchJawsItemCosts(),
        ])
        if (error) return res.status(500).json({ error: error.message })
        const items = (rows || [])
          .map((r: any) => {
            const cost = r.myob_item_uid ? costs[r.myob_item_uid] : null
            return {
              catalogue_id: r.id,
              sku: r.sku,
              name: r.name,
              is_taxable: r.is_taxable !== false,
              on_hand: cost?.isInventoried ? Number(cost.onHand) : 0,
              // 2dp to match exactly what the invoice line will charge
              // (see the LineTotalUnbalanced note in lib/b2b-stock-transfer.ts)
              avg_cost: cost ? Math.round(Number(cost.avgCost) * 100) / 100 : 0,
              is_inventoried: cost?.isInventoried === true,
            }
          })
          .filter(i => i.is_inventoried && i.on_hand > 0)
        return res.status(200).json({ items })
      }

      // ── History ───────────────────────────────────────────────────────
      if (view === 'history') {
        const { data: transfers, error } = await c
          .from('b2b_stock_transfers')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(50)
        if (error) return res.status(500).json({ error: error.message })
        return res.status(200).json({ transfers: transfers || [] })
      }

      // ── Default: config ───────────────────────────────────────────────
      const cfg = await loadTransferConfig()
      return res.status(200).json({ config: cfg })
    }

    if (req.method === 'POST') {
      let body: any = {}
      try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
      catch { return res.status(400).json({ error: 'Bad JSON body' }) }
      const action = String(body.action || '').trim()

      if (action === 'save-settings') {
        const update: Record<string, any> = { updated_at: new Date().toISOString() }
        const FIELDS: Array<[string, string]> = [
          ['customer_uid', 'myob_transfer_customer_uid'], ['customer_name', 'myob_transfer_customer_name'],
          ['supplier_uid', 'myob_transfer_supplier_uid'], ['supplier_name', 'myob_transfer_supplier_name'],
          ['account_uid', 'myob_transfer_account_uid'],   ['account_name', 'myob_transfer_account_name'],
        ]
        for (const [from, to] of FIELDS) {
          if (from in body) update[to] = String(body[from] || '').trim() || null
        }
        const { error } = await c.from('b2b_settings').update(update).eq('id', 'singleton')
        if (error) return res.status(500).json({ error: error.message })
        return res.status(200).json({ ok: true, config: await loadTransferConfig() })
      }

      if (action === 'execute') {
        const lines = Array.isArray(body.lines) ? body.lines : []
        if (!lines.length) return res.status(400).json({ error: 'No lines supplied' })
        const result = await executeStockTransfer({
          lines: lines.map((l: any) => ({ catalogue_id: String(l.catalogue_id || ''), qty: Number(l.qty) })),
          note: body.note ? String(body.note) : null,
          poReference: body.po_reference ? String(body.po_reference) : null,
          userId: user.id,
        })
        return res.status(200).json({ ok: true, result })
      }

      if (action === 'retry') {
        const transferId = String(body.transferId || '').trim()
        if (!transferId) return res.status(400).json({ error: 'transferId required' })
        const result = await retryVpsBill(transferId, user.id)
        return res.status(200).json({ ok: true, result })
      }

      return res.status(400).json({ error: 'action must be save-settings, execute or retry' })
    }

    res.setHeader('Allow', 'GET, POST')
    return res.status(405).json({ error: 'GET or POST only' })
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || String(e) })
  }
})
