// pages/api/b2b/admin/assets.ts
// Admin management of the distributor resource library.
//   GET  → { assets }                                (all rows, incl inactive)
//   POST { action:'sign-upload', fileName, mime }    → { path, token } for a
//          direct-to-storage upload (avoids function body limits on media)
//   POST { action:'create', section, title, description?, path, fileName,
//          mime?, sizeBytes?, notify? }              → registers the row;
//          notify=true bells every active distributor user
//   POST { action:'replace', id, path, fileName, mime?, sizeBytes?, notify? }
//          → swaps the file on an existing row (old object removed)
//   PATCH{ id, title?, description?, section?, sort_order?, is_active? }
//   DELETE { id }                                    → row + storage object

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../lib/authServer'
import { B2B_ASSET_SECTIONS, B2B_ASSETS_BUCKET } from '../../../../lib/b2b-assets'

export const config = { maxDuration: 30 }

function sb() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

const cleanName = (s: string) => String(s || 'file').replace(/[^\w.\-]+/g, '_').slice(0, 120)

async function notifyDistributors(c: ReturnType<typeof sb>, title: string, body: string, href: string) {
  const { data: users } = await c.from('b2b_distributor_users').select('id').eq('is_active', true)
  if (!users?.length) return 0
  const rows = users.map(u => ({ b2b_user_id: u.id, title, body, href }))
  const { error } = await c.from('b2b_notifications').insert(rows)
  if (error) console.error('[b2b-assets] notify insert failed:', error.message)
  return users.length
}

export default withAuth('edit:b2b_distributors', async (req: NextApiRequest, res: NextApiResponse, user: any) => {
  const c = sb()

  if (req.method === 'GET') {
    const { data, error } = await c.from('b2b_assets').select('*').order('section').order('sort_order').order('created_at')
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ assets: data || [], sections: B2B_ASSET_SECTIONS })
  }

  if (req.method === 'POST') {
    const b = req.body || {}
    if (b.action === 'sign-upload') {
      const path = `${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}/${cleanName(b.fileName)}`
      const { data, error } = await c.storage.from(B2B_ASSETS_BUCKET).createSignedUploadUrl(path)
      if (error) return res.status(500).json({ error: error.message })
      return res.status(200).json({ path, token: data.token, signedUrl: (data as any).signedUrl })
    }

    if (b.action === 'create') {
      const section = String(b.section || '')
      if (!(B2B_ASSET_SECTIONS as readonly string[]).includes(section)) return res.status(400).json({ error: 'unknown section' })
      if (!b.title?.trim() || !b.path) return res.status(400).json({ error: 'title and path required' })
      const { data, error } = await c.from('b2b_assets').insert({
        section, title: String(b.title).trim(), description: b.description || null,
        storage_path: String(b.path), file_name: cleanName(b.fileName || b.title),
        mime: b.mime || null, size_bytes: b.sizeBytes ?? null,
        updated_by: user?.email || user?.id || 'admin',
      }).select('id').single()
      if (error) return res.status(500).json({ error: error.message })
      let notified = 0
      if (b.notify) notified = await notifyDistributors(c, 'New resource available', `${section}: ${String(b.title).trim()}`, '/b2b/assets')
      return res.status(200).json({ ok: true, id: data.id, notified })
    }

    if (b.action === 'replace') {
      const { data: row, error: rowErr } = await c.from('b2b_assets').select('*').eq('id', b.id).single()
      if (rowErr || !row) return res.status(404).json({ error: 'asset not found' })
      if (!b.path) return res.status(400).json({ error: 'path required' })
      const { error } = await c.from('b2b_assets').update({
        storage_path: String(b.path), file_name: cleanName(b.fileName || row.file_name),
        mime: b.mime || row.mime, size_bytes: b.sizeBytes ?? row.size_bytes,
        updated_at: new Date().toISOString(), updated_by: user?.email || user?.id || 'admin',
      }).eq('id', b.id)
      if (error) return res.status(500).json({ error: error.message })
      await c.storage.from(B2B_ASSETS_BUCKET).remove([row.storage_path]).catch(() => {})
      let notified = 0
      if (b.notify) notified = await notifyDistributors(c, 'Resource updated', `${row.section}: ${row.title}`, '/b2b/assets')
      return res.status(200).json({ ok: true, notified })
    }

    return res.status(400).json({ error: 'unknown action' })
  }

  if (req.method === 'PATCH') {
    const b = req.body || {}
    if (!b.id) return res.status(400).json({ error: 'id required' })
    const patch: any = { updated_at: new Date().toISOString(), updated_by: user?.email || user?.id || 'admin' }
    if (b.title !== undefined) patch.title = String(b.title).trim()
    if (b.description !== undefined) patch.description = b.description || null
    if (b.section !== undefined) {
      if (!(B2B_ASSET_SECTIONS as readonly string[]).includes(String(b.section))) return res.status(400).json({ error: 'unknown section' })
      patch.section = String(b.section)
    }
    if (b.sort_order !== undefined) patch.sort_order = Number(b.sort_order) || 100
    if (b.is_active !== undefined) patch.is_active = !!b.is_active
    const { error } = await c.from('b2b_assets').update(patch).eq('id', b.id)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  if (req.method === 'DELETE') {
    const id = String(req.query.id || req.body?.id || '')
    if (!id) return res.status(400).json({ error: 'id required' })
    const { data: row } = await c.from('b2b_assets').select('storage_path').eq('id', id).single()
    const { error } = await c.from('b2b_assets').delete().eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    if (row?.storage_path) await c.storage.from(B2B_ASSETS_BUCKET).remove([row.storage_path]).catch(() => {})
    return res.status(200).json({ ok: true })
  }

  res.setHeader('Allow', 'GET, POST, PATCH, DELETE')
  return res.status(405).json({ error: 'method not allowed' })
})
