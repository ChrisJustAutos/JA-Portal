// pages/api/b2b/session/switch.ts
//
// POST /api/b2b/session/switch   body: { distributor_id }
//
// Multi-account users (one login on several distributor accounts) select
// which distributor their session acts as. Validates the caller genuinely
// holds an active membership on the target, then sets the ja-b2b-dist
// cookie that getCurrentB2BUser honours.

import type { NextApiRequest, NextApiResponse } from 'next'
import { withB2BAuth, B2BUser, B2B_DIST_COOKIE, getServiceClient } from '../../../../lib/b2bAuthServer'

export default withB2BAuth(async (req: NextApiRequest, res: NextApiResponse, user: B2BUser) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'POST only' })
  }

  const distributorId = String((req.body || {}).distributor_id || '').trim()
  if (!distributorId) return res.status(400).json({ error: 'distributor_id required' })

  const { data: row } = await getServiceClient()
    .from('b2b_distributor_users')
    .select('id, is_active, distributor:b2b_distributors!b2b_distributor_users_distributor_id_fkey ( id, is_active, display_name )')
    .eq('auth_user_id', user.authUserId)
    .eq('distributor_id', distributorId)
    .maybeSingle()
  const dist: any = Array.isArray(row?.distributor) ? row?.distributor[0] : row?.distributor
  if (!row || row.is_active === false || !dist || dist.is_active === false) {
    return res.status(403).json({ error: 'You are not a member of that distributor account.' })
  }

  res.setHeader('Set-Cookie',
    `${B2B_DIST_COOKIE}=${encodeURIComponent(distributorId)}; Path=/; Max-Age=31536000; SameSite=Lax; Secure; HttpOnly`)
  return res.status(200).json({ ok: true, distributor_id: distributorId, display_name: dist.display_name })
})
