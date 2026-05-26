// pages/api/b2b/admin/machship-sender-from-myob.ts
//
// Fetches the JAWS company file's CompanyInformation from MYOB and
// returns it shaped as the MachShip sender (pickup) fields, so the
// B2B Settings page can prefill the address inputs without staff
// having to re-type what MYOB already knows.
//
// This is a read-through helper — we do NOT persist to b2b_settings
// here. The admin reviews the values and clicks "Save sender address"
// to commit. That way an unexpected MYOB blip can't silently flip a
// configured pickup address, and admins can override per-shipment
// preferences (different sender phone for freight contact, etc.).
//
//   GET /api/b2b/admin/machship-sender-from-myob
//     → { sender: { name, company, phone, email,
//                   address_line1, address_line2,
//                   suburb, postcode, state } }

import type { NextApiRequest, NextApiResponse } from 'next'
import { withAuth } from '../../../../lib/authServer'
import { getConnection, myobFetch } from '../../../../lib/myob'

export default withAuth('edit:b2b_distributors', async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'GET only' })
  }

  const conn = await getConnection('JAWS')
  if (!conn) {
    return res.status(503).json({ error: 'MYOB JAWS not connected — reconnect in Settings → MYOB Connection.' })
  }
  if (!conn.company_file_id) {
    return res.status(503).json({ error: 'MYOB JAWS has no company file selected.' })
  }

  let info: any
  try {
    const { status, data } = await myobFetch(
      conn.id,
      `/accountright/${conn.company_file_id}/CompanyInformation`,
    )
    if (status !== 200) {
      return res.status(502).json({ error: `MYOB CompanyInformation returned ${status}` })
    }
    info = data
  } catch (e: any) {
    return res.status(502).json({ error: `MYOB CompanyInformation failed: ${e?.message || e}` })
  }

  // MYOB AccountRight returns CompanyName + an array of Addresses (the
  // "Mailing" entry is what businesses use for pickup/freight). Fall
  // back to whichever address is populated when Mailing is empty.
  const addresses: any[] = Array.isArray(info?.Addresses) ? info.Addresses : []
  const mailing = addresses.find(a => /mailing/i.test(String(a?.Location || a?.Type || '')))
              ?? addresses.find(a => String(a?.Street || '').trim() !== '')
              ?? null

  // The CompanyName lives at the top of the response; ContactName and
  // PhoneNumber live on the chosen address.
  const sender = {
    name:           String(mailing?.ContactName || '').trim() || null,
    company:        String(info?.CompanyName    || '').trim() || null,
    phone:          String(mailing?.PhoneNumber1 || mailing?.Phone1 || '').trim() || null,
    email:          String(mailing?.Email       || '').trim() || null,
    address_line1:  splitStreet(mailing?.Street).line1,
    address_line2:  splitStreet(mailing?.Street).line2,
    suburb:         String(mailing?.City        || '').trim() || null,
    postcode:       String(mailing?.PostCode    || '').trim() || null,
    state:          String(mailing?.State       || '').trim() || null,
  }

  return res.status(200).json({ sender })
})

// MYOB's Street field is a single multi-line string (newline-separated
// in the data, sometimes a literal "\n" or "\r\n"). MachShip wants two
// discrete address lines, so split on the first line break.
function splitStreet(raw: any): { line1: string | null; line2: string | null } {
  if (!raw || typeof raw !== 'string') return { line1: null, line2: null }
  const parts = raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean)
  if (parts.length === 0) return { line1: null, line2: null }
  return {
    line1: parts[0] || null,
    line2: parts.slice(1).join(' ') || null,
  }
}
