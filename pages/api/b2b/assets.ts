// pages/api/b2b/assets.ts
// Distributor-facing resource library.
//   GET            → { sections: [{ name, assets: [...] }] }  (active only)
//   GET ?download=<id> → { url } (60-min signed URL to the private object)

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { withB2BAuth } from '../../../lib/b2bAuthServer'
import { B2B_ASSET_SECTIONS, B2B_ASSETS_BUCKET } from '../../../lib/b2b-assets'

function sb() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

export default withB2BAuth(async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'GET only' }) }
  const c = sb()

  const downloadId = String(req.query.download || '')
  if (downloadId) {
    const { data: row, error } = await c.from('b2b_assets')
      .select('storage_path, file_name, is_active').eq('id', downloadId).single()
    if (error || !row || !row.is_active) return res.status(404).json({ error: 'not found' })
    const { data: signed, error: sErr } = await c.storage.from(B2B_ASSETS_BUCKET)
      .createSignedUrl(row.storage_path, 3600, { download: row.file_name })
    if (sErr || !signed?.signedUrl) return res.status(500).json({ error: sErr?.message || 'sign failed' })
    return res.status(200).json({ url: signed.signedUrl })
  }

  const { data, error } = await c.from('b2b_assets')
    .select('id, section, title, description, file_name, mime, size_bytes, updated_at, created_at')
    .eq('is_active', true).order('sort_order').order('created_at')
  if (error) return res.status(500).json({ error: error.message })
  const bySection = new Map<string, any[]>()
  for (const a of data || []) {
    if (!bySection.has(a.section)) bySection.set(a.section, [])
    bySection.get(a.section)!.push(a)
  }
  // Fixed section order (the menu order), sections without docs omitted.
  const sections = (B2B_ASSET_SECTIONS as readonly string[])
    .filter(s => bySection.has(s))
    .map(s => ({ name: s, assets: bySection.get(s)! }))
  // Any section renamed out of the constant still shows, at the end.
  bySection.forEach((assets, name) => {
    if (!(B2B_ASSET_SECTIONS as readonly string[]).includes(name)) sections.push({ name, assets })
  })
  return res.status(200).json({ sections })
})
