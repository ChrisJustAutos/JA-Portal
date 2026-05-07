// pages/api/myob/suppliers.ts
// MYOB supplier search + creation, used by the AP supplier preset picker
// and the "Create from invoice" flow on the AP detail page.
//
//   GET  /api/myob/suppliers?q=repco&company=VPS&limit=20
//        → { suppliers: MyobSupplierLite[] }
//
//   POST /api/myob/suppliers
//        body: { company, companyName, abn?, email?, phone?, website?,
//                street?, city?, state?, postcode?, country? }
//        → { supplier: MyobSupplierLite }
//
// POST writes CompanyName + ABN + optional contact card (Location=1 address
// with email/phone/website + street/city/state/postcode/country). Bank
// details, payment terms and the default expense account are NOT set —
// those stay manual in MYOB to keep the wrong-BSB blast radius small.

import type { NextApiRequest, NextApiResponse } from 'next'
import { withAuth } from '../../../lib/authServer'
import { searchSuppliers, createSupplier, CompanyFileLabel } from '../../../lib/ap-myob-lookup'

function parseCompany(v: any): CompanyFileLabel | null {
  const c = String(v || 'VPS').toUpperCase()
  return c === 'VPS' || c === 'JAWS' ? c : null
}

export default withAuth('view:supplier_invoices', async (req: NextApiRequest, res: NextApiResponse, user) => {
  if (req.method === 'GET') {
    const q = String(req.query.q || '').trim()
    const company = parseCompany(req.query.company)
    if (!company) return res.status(400).json({ error: "company must be 'VPS' or 'JAWS'" })
    const limit = Math.min(Math.max(parseInt(String(req.query.limit || '20'), 10), 1), 50)

    try {
      const suppliers = await searchSuppliers(company, q, limit)
      return res.status(200).json({ suppliers, query: q, company })
    } catch (e: any) {
      console.error('MYOB supplier search failed:', e?.message)
      return res.status(502).json({ error: e?.message || 'MYOB lookup failed' })
    }
  }

  if (req.method === 'POST') {
    // Creation requires the AP edit permission — same gate the supplier
    // preset and approve endpoints use. Search is broader (view).
    if (!['admin', 'manager', 'accountant'].includes(user.role)) {
      // withAuth was called with view:supplier_invoices; double-check edit
      // permission inline rather than splitting handlers.
      const { roleHasPermission } = await import('../../../lib/permissions')
      if (!roleHasPermission(user.role, 'edit:supplier_invoices')) {
        return res.status(403).json({ error: 'Forbidden — edit:supplier_invoices required' })
      }
    }

    const body = (req.body || {}) as Record<string, any>
    const company = parseCompany(body.company)
    if (!company) return res.status(400).json({ error: "company must be 'VPS' or 'JAWS'" })

    const companyName = String(body.companyName || '').trim()
    if (!companyName)        return res.status(400).json({ error: 'companyName is required' })
    if (companyName.length > 200) return res.status(400).json({ error: 'companyName too long' })

    const abnRaw = String(body.abn || '').replace(/\s/g, '').trim()
    if (abnRaw && !/^\d{11}$/.test(abnRaw)) {
      return res.status(400).json({ error: 'abn must be 11 digits' })
    }

    const trim = (field: string, max: number): string | null => {
      const v = String(body[field] || '').trim()
      if (!v) return null
      if (v.length > max) {
        throw new Error(`${field} too long (max ${max} chars)`)
      }
      return v
    }

    let email: string | null, phone: string | null, website: string | null
    let street: string | null, city: string | null, state: string | null
    let postcode: string | null, country: string | null
    try {
      email    = trim('email',    255)
      phone    = trim('phone',     30)
      website  = trim('website',  255)
      street   = trim('street',   255)  // MYOB lets multi-line via \n; cap is generous
      city     = trim('city',     100)
      state    = trim('state',     30)
      postcode = trim('postcode',  20)
      country  = trim('country',  100)
    } catch (e: any) {
      return res.status(400).json({ error: e.message })
    }

    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'email is not a valid address' })
    }

    const taxCodeRaw = String(body.taxCode || '').trim().toUpperCase()
    let taxCode: 'GST' | 'FRE' = 'GST'
    if (taxCodeRaw) {
      if (taxCodeRaw !== 'GST' && taxCodeRaw !== 'FRE') {
        return res.status(400).json({ error: "taxCode must be 'GST' or 'FRE'" })
      }
      taxCode = taxCodeRaw
    }

    try {
      const supplier = await createSupplier(company, {
        companyName, abn: abnRaw || null, taxCode,
        email, phone, website, street, city, state, postcode, country,
      })
      return res.status(201).json({ supplier })
    } catch (e: any) {
      console.error('MYOB createSupplier failed:', e?.message)
      return res.status(502).json({ error: e?.message || 'MYOB create failed' })
    }
  }

  res.setHeader('Allow', 'GET, POST')
  return res.status(405).json({ error: 'Method not allowed' })
})
