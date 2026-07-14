// pages/api/reports/sales-recap/latest.ts
// Returns the current stored Weekly Sales Recap (payload + html) for the
// portal Reports → Sales Report page. Auth: staff with view:reports.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { getCurrentUser } from '../../../../lib/authServer'
import { roleHasPermission } from '../../../../lib/permissions'

function sb() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const user = await getCurrentUser(req)
  if (!user || !roleHasPermission(user.role, 'view:reports')) return res.status(401).json({ error: 'Unauthorised' })

  const { data, error } = await sb()
    .from('sales_recap_reports')
    .select('week_start, week_end, generated_at, payload, html, emailed_to')
    .eq('is_current', true)
    .order('generated_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) return res.status(500).json({ error: error.message })
  if (!data) return res.status(200).json({ report: null })
  return res.status(200).json({ report: data })
}
