// pages/api/b2b/admin/suppliers/catalogue-suppliers.ts
// GET — distinct MYOB suppliers present on the catalogue (uid, name, item
// count) so admins can pick which supplier card(s) a supplier login covers.
import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../../lib/authServer'

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  _sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  return _sb
}

export default withAuth('view:b2b', async (_req: NextApiRequest, res: NextApiResponse) => {
  const { data, error } = await sb().from('b2b_catalogue').select('myob_supplier_uid, myob_supplier_name')
  if (error) return res.status(500).json({ error: error.message })
  const map = new Map<string, { uid: string; name: string; items: number }>()
  for (const r of (data || []) as any[]) {
    if (!r.myob_supplier_uid) continue
    const m = map.get(r.myob_supplier_uid) || { uid: r.myob_supplier_uid, name: r.myob_supplier_name || '(unnamed supplier)', items: 0 }
    m.items++
    if (r.myob_supplier_name) m.name = r.myob_supplier_name
    map.set(r.myob_supplier_uid, m)
  }
  const suppliers = Array.from(map.values()).sort((a, b) => b.items - a.items)
  return res.status(200).json({ suppliers })
})
