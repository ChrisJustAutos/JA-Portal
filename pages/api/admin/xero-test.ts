// pages/api/admin/xero-test.ts
// Admin test harness for the Xero connection + XeroAdapter (MYOB→Xero
// migration). Everything here is read-only or draft-only + reversible —
// the roundtrip never AUTHORISES a document.
//
//   POST { action, label: 'VPS' | 'JAWS' }
//     action:
//       'ping'                 — GET /Organisation → org name
//       'list_accounts'        — first 20 chart-of-accounts codes+names
//       'list_tax_rates'       — GET /TaxRates
//       'list_contacts_sample' — first 10 contacts
//       'list_items_sample'    — first 10 items (via adapter.listItems)
//       'draft_bill_roundtrip' — find-or-create contact "JA PORTAL TEST
//                                SUPPLIER", create a DRAFT ACCPAY bill for
//                                $1.10 inc, then immediately delete it;
//                                reports each step.

import { withAuth } from '../../../lib/authServer'
import { roleHasPermission } from '../../../lib/permissions'
import { xeroFetch, XeroLabel } from '../../../lib/xero'
import { XeroAdapter } from '../../../lib/accounting/xero-adapter'

export const config = { maxDuration: 60 }

const TEST_SUPPLIER_NAME = 'JA PORTAL TEST SUPPLIER'

interface Step { step: string; ok: boolean; detail?: any; error?: string }

export default withAuth(null, async (req, res, user) => {
  if (!roleHasPermission(user.role, 'admin:settings')) return res.status(403).json({ error: 'Admin only' })
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'POST only' })
  }

  let body: any = {}
  try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
  catch { return res.status(400).json({ error: 'Bad JSON body' }) }

  const label: XeroLabel | null = body.label === 'VPS' ? 'VPS' : body.label === 'JAWS' ? 'JAWS' : null
  if (!label) return res.status(400).json({ error: "label must be 'VPS' or 'JAWS'" })
  const action = String(body.action || '')
  const adapter = new XeroAdapter(label)

  try {
    if (action === 'ping') {
      const name = await adapter.ping()
      return res.status(200).json({ ok: true, label, organisation: name })
    }

    if (action === 'list_accounts') {
      const j = await xeroFetch(label, '/Accounts')
      const accounts = (j?.Accounts || []).slice(0, 20).map((a: any) => ({
        code: a.Code || '', name: a.Name || '', type: a.Type || '', taxType: a.TaxType || '', status: a.Status || '',
      }))
      return res.status(200).json({ ok: true, label, count: (j?.Accounts || []).length, accounts })
    }

    if (action === 'list_tax_rates') {
      const j = await xeroFetch(label, '/TaxRates')
      const taxRates = (j?.TaxRates || []).map((t: any) => ({
        name: t.Name || '', taxType: t.TaxType || '', effectiveRate: t.EffectiveRate, status: t.Status || '',
      }))
      return res.status(200).json({ ok: true, label, taxRates })
    }

    if (action === 'list_contacts_sample') {
      const j = await xeroFetch(label, '/Contacts?page=1&pageSize=10&summaryOnly=True')
      const contacts = (j?.Contacts || []).map((c: any) => ({
        id: c.ContactID, name: c.Name || '', isSupplier: !!c.IsSupplier, isCustomer: !!c.IsCustomer, status: c.ContactStatus || '',
      }))
      return res.status(200).json({ ok: true, label, contacts })
    }

    if (action === 'list_items_sample') {
      const items = await adapter.listItems()
      return res.status(200).json({ ok: true, label, count: items.length, items: items.slice(0, 10) })
    }

    if (action === 'draft_bill_roundtrip') {
      // Reversible end-to-end write test: DRAFT documents only, deleted at
      // the end. Never leaves an AUTHORISED document behind.
      const steps: Step[] = []
      const run = async <T>(step: string, fn: () => Promise<T>): Promise<T | null> => {
        try {
          const detail = await fn()
          steps.push({ step, ok: true, detail })
          return detail
        } catch (e: any) {
          steps.push({ step, ok: false, error: String(e?.message || e).slice(0, 400) })
          return null
        }
      }

      // 1. find or create the dedicated test supplier contact
      let contact = await run('find_contact', () =>
        adapter.findContact({ kind: 'supplier', name: TEST_SUPPLIER_NAME }))
      if (!contact) {
        contact = await run('create_contact', () =>
          adapter.createContact({ kind: 'supplier', name: TEST_SUPPLIER_NAME }))
      }
      if (!contact) {
        return res.status(502).json({ ok: false, label, steps, error: 'Could not find or create the test supplier contact' })
      }

      // 2. create a DRAFT ACCPAY bill for $1.10 inc GST (drafts don't need
      //    an account code, post to the ledger, or affect reports)
      const reference = `JA-PORTAL-TEST-${Date.now()}`
      const bill = await run('create_draft_bill', () =>
        adapter.createBill({
          contactId: contact!.id,
          reference,
          dateIso: new Date().toISOString().slice(0, 10),
          lines: [{ description: 'JA Portal Xero connectivity test — draft, deleted immediately', amount: 1.10, taxType: 'GST' }],
          status: 'draft',
        }))

      // 3. delete it again (voidDocument picks DELETED for drafts)
      if (bill) {
        await run('delete_draft_bill', async () => {
          await adapter.voidDocument('bill', bill.id)
          return { id: bill.id, reference: bill.reference, adopted: !!bill.adopted }
        })
      }

      const ok = steps.every(s => s.ok)
      return res.status(ok ? 200 : 502).json({ ok, label, contact, steps })
    }

    return res.status(400).json({ error: `Unknown action '${action}'` })
  } catch (e: any) {
    return res.status(502).json({ ok: false, label, action, error: String(e?.message || e).slice(0, 500) })
  }
})
