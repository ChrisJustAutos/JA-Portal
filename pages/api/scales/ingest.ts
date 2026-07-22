// pages/api/scales/ingest.ts
// ESP32 load-cell modules POST here. Auth = x-device-key header (the uuid
// flashed into the module, from Workshop → Live Bins → module setup).
//
//   POST { readings: [{ channel: 0, raw: 84213 }], rssi?: -61, firmware?: "1.0" }
//   → { ok, bins: [{ channel, grams, units }] }
//
// The device sends RAW HX711 counts — tare + calibration + unit weights live
// server-side so everything is adjustable from the portal without reflashing.
// History rows are written on meaningful change (≥ half a unit or ≥ 20 g) or
// every 15 min as a heartbeat; the bin snapshot updates on every post.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'

export const config = { maxDuration: 10 }

function sb() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }) }
  const key = String(req.headers['x-device-key'] || '')
  if (!key) return res.status(401).json({ error: 'x-device-key required' })

  const c = sb()
  const { data: dev, error: devErr } = await c.from('scale_devices')
    .select('id, is_active').eq('device_key', key).maybeSingle()
  if (devErr) return res.status(500).json({ error: devErr.message })
  if (!dev || !dev.is_active) return res.status(401).json({ error: 'unknown or inactive device' })

  const body = req.body || {}
  const readings: Array<{ channel?: number; raw?: number }> = Array.isArray(body.readings) ? body.readings : []

  await c.from('scale_devices').update({
    last_seen_at: new Date().toISOString(),
    rssi: Number.isFinite(Number(body.rssi)) ? Number(body.rssi) : null,
    firmware: body.firmware ? String(body.firmware).slice(0, 40) : undefined,
  }).eq('id', dev.id)

  const { data: bins } = await c.from('scale_bins').select('*').eq('device_id', dev.id)
  const out: any[] = []
  for (const r of readings) {
    const raw = Number(r.raw)
    if (!Number.isFinite(raw)) continue
    const bin = (bins || []).find(b => b.channel === Number(r.channel ?? 0))
    if (!bin) { out.push({ channel: r.channel ?? 0, error: 'no bin configured' }); continue }

    const grams = bin.grams_per_raw != null ? (raw - Number(bin.zero_offset_raw)) * Number(bin.grams_per_raw) : null
    let units: number | null = null
    if (grams != null && bin.unit_weight_g != null && Number(bin.unit_weight_g) > 0) {
      const unitsFloat = grams / Number(bin.unit_weight_g)
      // Sticky rounding: with naturally varying parts the estimate hovers
      // near unit boundaries (45.6 for a true 46) and the count flaps ±1.
      // Keep the previous count unless the estimate moves clearly (>0.7
      // units) away from it — a real one-part change always exceeds that.
      const prev = bin.last_units != null ? Number(bin.last_units) : null
      units = prev != null && Math.abs(unitsFloat - prev) < 0.7
        ? prev
        : Math.max(0, Math.round(unitsFloat))
    }

    const lastAt = bin.last_reading_at ? Date.parse(bin.last_reading_at) : 0
    const gramsMoved = grams != null && bin.last_grams != null ? Math.abs(grams - Number(bin.last_grams)) : Infinity
    const threshold = bin.unit_weight_g != null ? Math.max(20, Number(bin.unit_weight_g) / 2) : 20
    const shouldLog = gramsMoved >= threshold || Date.now() - lastAt > 15 * 60_000

    await c.from('scale_bins').update({
      last_raw: raw, last_grams: grams, last_units: units, last_reading_at: new Date().toISOString(),
    }).eq('id', bin.id)
    if (shouldLog) await c.from('scale_readings').insert({ bin_id: bin.id, raw, grams, units })

    out.push({ channel: bin.channel, grams: grams != null ? Math.round(grams) : null, units })
  }

  return res.status(200).json({ ok: true, bins: out })
}
