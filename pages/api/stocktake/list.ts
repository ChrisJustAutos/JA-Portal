// pages/api/stocktake/list.ts
//
// List recent stocktake uploads.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../lib/authServer'

function sb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  )
}

export default withAuth('view:stocktakes', async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const { data, error } = await sb()
    .from('stocktake_uploads')
    .select(`
      id, uploaded_at, filename, status,
      total_rows, matched_count, unmatched_count, pushed_count,
      mechanicdesk_stocktake_id, push_completed_at,
      uploaded_by
    `)
    .order('uploaded_at', { ascending: false })
    .limit(50)
  if (error) return res.status(500).json({ error: error.message })

  const uploaderIds = Array.from(new Set((data || []).map((r: any) => r.uploaded_by).filter(Boolean)))
  let uploaderMap: Record<string, string> = {}
  if (uploaderIds.length > 0) {
    const { data: profiles } = await sb()
      .from('user_profiles')
      .select('id, display_name')
      .in('id', uploaderIds)
    if (profiles) {
      uploaderMap = profiles.reduce((acc: Record<string, string>, p: any) => {
        acc[p.id] = p.display_name || ''
        return acc
      }, {})
    }
  }

  return res.status(200).json({
    uploads: (data || []).map((r: any) => ({
      ...r,
      uploaded_by_name: r.uploaded_by ? (uploaderMap[r.uploaded_by] || null) : null,
    })),
  })
})
