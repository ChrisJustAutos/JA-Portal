// pages/api/scales/index.ts
// Staff-side management + monitoring of the load-cell bin modules.
//   GET  → { devices: [{ …device, bins: […] }] }
//   POST { action: 'createDevice', name, location? }         → { device } (incl device_key to flash)
//   POST { action: 'updateDevice', id, name?, location?, is_active? }
//   POST { action: 'deleteDevice', id }
//   POST { action: 'addBin', deviceId, channel }
//   POST { action: 'updateBin', id, bin_number?, part_number?, part_name?, unit_weight_g?, alert_min_units? }
//   POST { action: 'deleteBin', id }
//   POST { action: 'tare', id }                → zero_offset_raw := last_raw (bin must be EMPTY)
//   POST { action: 'calibrate', id, knownGrams } → grams_per_raw from last_raw vs tare
//
// Tare/calibrate use the most recent raw sample, so have the module powered
// and reporting when you press them.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../lib/authServer'

function sb() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

export default withAuth('view:diary', async (req: NextApiRequest, res: NextApiResponse) => {
  const c = sb()

  if (req.method === 'GET') {
    const [{ data: devices, error: dErr }, { data: bins, error: bErr }] = await Promise.all([
      c.from('scale_devices').select('*').order('created_at'),
      c.from('scale_bins').select('*').order('channel'),
    ])
    if (dErr) return res.status(500).json({ error: dErr.message })
    if (bErr) return res.status(500).json({ error: bErr.message })
    return res.status(200).json({
      devices: (devices || []).map(d => ({ ...d, bins: (bins || []).filter(b => b.device_id === d.id) })),
    })
  }

  if (req.method === 'POST') {
    const b = req.body || {}
    const act = String(b.action || '')

    if (act === 'createDevice') {
      if (!b.name?.trim()) return res.status(400).json({ error: 'name required' })
      const { data, error } = await c.from('scale_devices')
        .insert({ name: String(b.name).trim(), location: b.location || null }).select('*').single()
      if (error) return res.status(500).json({ error: error.message })
      // Start every module with channel 0 so it works out of the box.
      await c.from('scale_bins').insert({ device_id: data.id, channel: 0 })
      return res.status(200).json({ ok: true, device: data })
    }

    if (act === 'updateDevice') {
      const patch: any = {}
      if (b.name !== undefined) patch.name = String(b.name).trim()
      if (b.location !== undefined) patch.location = b.location || null
      if (b.is_active !== undefined) patch.is_active = !!b.is_active
      const { error } = await c.from('scale_devices').update(patch).eq('id', b.id)
      if (error) return res.status(500).json({ error: error.message })
      return res.status(200).json({ ok: true })
    }

    if (act === 'deleteDevice') {
      const { error } = await c.from('scale_devices').delete().eq('id', b.id)
      if (error) return res.status(500).json({ error: error.message })
      return res.status(200).json({ ok: true })
    }

    if (act === 'addBin') {
      const { error } = await c.from('scale_bins').insert({ device_id: b.deviceId, channel: Number(b.channel) || 0 })
      if (error) return res.status(500).json({ error: error.message })
      return res.status(200).json({ ok: true })
    }

    if (act === 'updateBin') {
      const patch: any = {}
      for (const k of ['bin_number', 'part_number', 'part_name'] as const) {
        if (b[k] !== undefined) patch[k] = b[k] ? String(b[k]).trim() : null
      }
      if (b.unit_weight_g !== undefined) patch.unit_weight_g = b.unit_weight_g === null || b.unit_weight_g === '' ? null : Number(b.unit_weight_g)
      if (b.alert_min_units !== undefined) patch.alert_min_units = b.alert_min_units === null || b.alert_min_units === '' ? null : Number(b.alert_min_units)
      const { error } = await c.from('scale_bins').update(patch).eq('id', b.id)
      if (error) return res.status(500).json({ error: error.message })
      return res.status(200).json({ ok: true })
    }

    if (act === 'deleteBin') {
      const { error } = await c.from('scale_bins').delete().eq('id', b.id)
      if (error) return res.status(500).json({ error: error.message })
      return res.status(200).json({ ok: true })
    }

    if (act === 'tare' || act === 'calibrate') {
      const { data: bin, error: bErr } = await c.from('scale_bins').select('*').eq('id', b.id).single()
      if (bErr || !bin) return res.status(404).json({ error: 'bin not found' })
      if (bin.last_raw == null) return res.status(400).json({ error: 'No reading from the module yet — power it up and wait for a sample.' })
      if (bin.last_reading_at && Date.now() - Date.parse(bin.last_reading_at) > 5 * 60_000) {
        return res.status(400).json({ error: 'Last sample is stale (>5 min) — check the module is online, then retry.' })
      }
      if (act === 'tare') {
        const { error } = await c.from('scale_bins').update({ zero_offset_raw: bin.last_raw }).eq('id', b.id)
        if (error) return res.status(500).json({ error: error.message })
        return res.status(200).json({ ok: true, zero_offset_raw: bin.last_raw })
      }
      const knownGrams = Number(b.knownGrams)
      if (!Number.isFinite(knownGrams) || knownGrams <= 0) return res.status(400).json({ error: 'knownGrams required' })
      const delta = Number(bin.last_raw) - Number(bin.zero_offset_raw)
      if (Math.abs(delta) < 1) return res.status(400).json({ error: 'Raw reading equals the tare value — put the known weight ON the scale first.' })
      const gramsPerRaw = knownGrams / delta
      const { error } = await c.from('scale_bins').update({ grams_per_raw: gramsPerRaw }).eq('id', b.id)
      if (error) return res.status(500).json({ error: error.message })
      return res.status(200).json({ ok: true, grams_per_raw: gramsPerRaw })
    }

    return res.status(400).json({ error: 'unknown action' })
  }

  res.setHeader('Allow', 'GET, POST')
  return res.status(405).json({ error: 'method not allowed' })
})
