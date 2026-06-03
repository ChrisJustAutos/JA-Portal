// pages/api/b2b/admin/stock-transfer.ts
// Staff endpoint for internal JAWS → VPS stock transfers.
//
// GET  ?view=items&direction=… — catalogue items + live JAWS costs.
//        JAWS_TO_VPS: only items with stock on hand (capped); VPS_TO_JAWS:
//        all catalogue items (VPS stock is untracked), avg-cost falling
//        back to standard cost.
// GET  ?view=history   — past transfers
// GET  ?lookup=customers|suppliers|accounts&file=JAWS|VPS&q=… — MYOB
//        typeahead for setup (accounts are always VPS).
// GET  (default)       — transfer config
// POST {action:'save-settings', …}  — persist the MYOB references
// POST {action:'execute', direction, lines, note, po_reference} — run a transfer
// POST {action:'retry', transferId} — re-attempt the purchase side of a partial

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../lib/authServer'
import { getConnection, myobFetch } from '../../../../lib/myob'
import {
  loadTransferConfig, fetchJawsItemCosts, executeStockTransfer, retryPurchaseSide,
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

// Trigger the GH Actions worker that creates + receives the matching
// MechanicDesk purchase order (MD has no public API — the worker drives it
// with the same Playwright session the stocktake system uses). Mirrors the
// stocktake dispatch pattern. Best-effort: the MYOB side of the transfer is
// already complete; MD status is tracked on the transfer row.
async function dispatchMdPurchaseOrder(transferId: string): Promise<void> {
  const ghToken = process.env.GH_DISPATCH_TOKEN
  const ghOwner = process.env.GH_REPO_OWNER || 'ChrisJustAutos'
  const ghRepo = process.env.GH_REPO_NAME || 'JA-Portal'
  if (!ghToken) {
    // Record the failure so it's visible in the UI rather than silently stuck.
    await sb().from('b2b_stock_transfers').update({
      md_po_status: 'failed',
      md_po_error: 'GH_DISPATCH_TOKEN not set in Vercel — cannot trigger the MD purchase-order worker',
      md_po_updated_at: new Date().toISOString(),
    }).eq('id', transferId)
    throw new Error('GH_DISPATCH_TOKEN missing')
  }
  const r = await fetch(`https://api.github.com/repos/${ghOwner}/${ghRepo}/dispatches`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${ghToken}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ event_type: 'md-purchase-order', client_payload: { transfer_id: transferId } }),
  })
  if (!r.ok) {
    const t = await r.text().catch(() => '')
    await sb().from('b2b_stock_transfers').update({
      md_po_status: 'failed',
      md_po_error: `Dispatch failed: ${r.status} ${t.slice(0, 200)}`,
      md_po_updated_at: new Date().toISOString(),
    }).eq('id', transferId)
    throw new Error(`GH dispatch ${r.status}`)
  }
}

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
          // Default files match the forward direction; reverse passes ?file=.
          const file = String(req.query.file || '').toUpperCase()
          const label = file === 'VPS' || file === 'JAWS' ? file : (lookup === 'customers' ? 'JAWS' : 'VPS')
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
        const reverse = String(req.query.direction || '') === 'VPS_TO_JAWS'
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
            // 2dp to match exactly what the invoice line will charge
            // (see the LineTotalUnbalanced note in lib/b2b-stock-transfer.ts).
            // Reverse falls back to standard cost when average reads 0.
            const raw = reverse
              ? (Number(cost?.avgCost) || Number(cost?.standardCost) || 0)
              : Number(cost?.avgCost || 0)
            return {
              catalogue_id: r.id,
              sku: r.sku,
              name: r.name,
              is_taxable: r.is_taxable !== false,
              on_hand: cost?.isInventoried ? Number(cost.onHand) : 0,
              avg_cost: Math.round(raw * 100) / 100,
              is_inventoried: cost?.isInventoried === true,
            }
          })
          .filter(i => reverse ? i.is_inventoried : (i.is_inventoried && i.on_hand > 0))
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
          ['customer_uid_vps', 'myob_transfer_customer_uid_vps'], ['customer_name_vps', 'myob_transfer_customer_name_vps'],
          ['supplier_uid_jaws', 'myob_transfer_supplier_uid_jaws'], ['supplier_name_jaws', 'myob_transfer_supplier_name_jaws'],
        ]
        for (const [from, to] of FIELDS) {
          if (from in body) update[to] = String(body[from] || '').trim() || null
        }
        // MechanicDesk supplier id (numeric) the workshop PO is raised on.
        if ('md_purchase_supplier_id' in body) {
          const v = parseInt(String(body.md_purchase_supplier_id), 10)
          update.md_purchase_supplier_id = Number.isFinite(v) && v > 0 ? v : null
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
          direction: body.direction === 'VPS_TO_JAWS' ? 'VPS_TO_JAWS' : 'JAWS_TO_VPS',
          note: body.note ? String(body.note) : null,
          poReference: body.po_reference ? String(body.po_reference) : null,
          userId: user.id,
        })
        // Forward transfers also raise + receive the matching MechanicDesk
        // purchase order via a GH Actions worker (best-effort dispatch).
        if (result.direction === 'JAWS_TO_VPS') {
          await dispatchMdPurchaseOrder(result.transferId).catch(e =>
            console.error('MD PO dispatch failed (non-fatal):', e?.message || e))
        }
        return res.status(200).json({ ok: true, result })
      }

      if (action === 'retry') {
        const transferId = String(body.transferId || '').trim()
        if (!transferId) return res.status(400).json({ error: 'transferId required' })
        const result = await retryPurchaseSide(transferId, user.id)
        return res.status(200).json({ ok: true, result })
      }

      // Re-fire (or first-fire) the MechanicDesk purchase-order worker for an
      // existing forward transfer — e.g. one created before the MD-PO feature,
      // or one whose dispatch failed.
      if (action === 'dispatch-md-po') {
        const transferId = String(body.transferId || '').trim()
        if (!transferId) return res.status(400).json({ error: 'transferId required' })
        const { data: t } = await c.from('b2b_stock_transfers').select('direction').eq('id', transferId).maybeSingle()
        if (!t) return res.status(404).json({ error: 'Transfer not found' })
        if ((t.direction || 'JAWS_TO_VPS') !== 'JAWS_TO_VPS') {
          return res.status(400).json({ error: 'MD purchase orders only apply to JAWS → VPS transfers' })
        }
        await c.from('b2b_stock_transfers').update({
          md_po_status: 'queued', md_po_error: null, md_po_updated_at: new Date().toISOString(),
        }).eq('id', transferId)
        try {
          await dispatchMdPurchaseOrder(transferId)
        } catch (e: any) {
          return res.status(502).json({ error: `Dispatch failed: ${e?.message || e}` })
        }
        return res.status(200).json({ ok: true, message: 'MD purchase-order worker triggered — updates in ~1 minute.' })
      }

      // Delete a transfer's portal record (lines cascade). Does NOT touch any
      // MYOB docs or MechanicDesk PO already posted — just clears the row.
      if (action === 'delete') {
        const transferId = String(body.transferId || '').trim()
        if (!transferId) return res.status(400).json({ error: 'transferId required' })
        const { error } = await c.from('b2b_stock_transfers').delete().eq('id', transferId)
        if (error) return res.status(500).json({ error: error.message })
        return res.status(200).json({ ok: true })
      }

      return res.status(400).json({ error: 'action must be save-settings, execute, retry, dispatch-md-po or delete' })
    }

    res.setHeader('Allow', 'GET, POST')
    return res.status(405).json({ error: 'GET or POST only' })
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || String(e) })
  }
})
