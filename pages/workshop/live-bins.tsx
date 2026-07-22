// pages/workshop/live-bins.tsx — live inventory from load-cell bin modules
// (load cell → HX711 → ESP32 → /api/scales/ingest). Monitor grid shows live
// units per bin; Setup mode registers modules (device key to flash), assigns
// part/bin numbers + unit weights, and runs tare / known-weight calibration.

import { useEffect, useState, useCallback } from 'react'
import Head from 'next/head'
import PortalTopBar from '../../lib/PortalTopBar'
import WorkshopTabs from '../../components/WorkshopTabs'
import InventoryTabs from '../../components/InventoryTabs'
import { requirePageAuth } from '../../lib/authServer'
import { T } from '../../lib/ui/theme'
import { useConfirm, usePrompt } from '../../components/ui/Feedback'

interface Bin {
  id: string; channel: number; bin_number: string | null; part_number: string | null; part_name: string | null
  unit_weight_g: number | null; zero_offset_raw: number; grams_per_raw: number | null; alert_min_units: number | null
  last_raw: number | null; last_grams: number | null; last_units: number | null; last_reading_at: string | null
}
interface Device {
  id: string; device_key: string; name: string; location: string | null; firmware: string | null
  rssi: number | null; last_seen_at: string | null; is_active: boolean; bins: Bin[]
}

const STALE_MS = 5 * 60_000

export default function LiveBinsPage({ user }: { user: any }) {
  const confirmDialog = useConfirm()
  const promptDialog = usePrompt()
  const [devices, setDevices] = useState<Device[] | null>(null)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const [setup, setSetup] = useState(false)

  const load = useCallback(() => {
    fetch('/api/scales').then(r => r.json())
      .then(d => { if (d.error) throw new Error(d.error); setDevices(d.devices || []); setError('') })
      .catch(e => setError(e.message || 'Load failed'))
  }, [])
  useEffect(() => {
    load()
    const t = setInterval(load, 4_000)
    return () => clearInterval(t)
  }, [load])

  async function act(body: any, okNote?: string) {
    setNote('')
    const r = await fetch('/api/scales', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(x => x.json())
    if (r.error) { setNote(`⚠ ${r.error}`); return null }
    if (okNote) setNote(okNote)
    load()
    return r
  }

  async function addDevice() {
    const name = await promptDialog({ title: 'New scale module', label: 'Name (e.g. Bin rack A — shelf 2)' })
    if (!name?.trim()) return
    const r = await act({ action: 'createDevice', name })
    if (r?.device) setNote(`Module created. Flash this device key into the ESP32: ${r.device.device_key}`)
  }

  async function calibrate(bin: Bin) {
    const v = await promptDialog({ title: 'Calibrate with a known weight', label: 'Weight now on the scale (grams)', inputMode: 'decimal' })
    const g = Number(v)
    if (!Number.isFinite(g) || g <= 0) return
    await act({ action: 'calibrate', id: bin.id, knownGrams: g }, 'Calibrated.')
  }

  // Set g/unit straight off the live reading: count the parts on the scale,
  // we divide the current grams by that count. No second scale needed.
  async function unitFromCount(bin: Bin) {
    if (bin.last_grams == null || bin.grams_per_raw == null) { setNote('⚠ Calibrate first — need a live grams reading.') ; return }
    const v = await promptDialog({ title: 'Set unit weight from what’s on the scale', label: `How many parts are on it right now? (currently ${Math.round(Number(bin.last_grams))} g)`, inputMode: 'numeric' })
    const n = Number(v)
    if (!Number.isFinite(n) || n <= 0) return
    const perUnit = Math.round((Number(bin.last_grams) / n) * 100) / 100
    await act({ action: 'updateBin', id: bin.id, unit_weight_g: perUnit }, `Unit weight set: ${perUnit} g/unit (${Math.round(Number(bin.last_grams))} g ÷ ${n}).`)
  }

  const online = (d: Device) => d.last_seen_at && Date.now() - Date.parse(d.last_seen_at) < STALE_MS
  const input: React.CSSProperties = { fontSize: 12, padding: '5px 8px', borderRadius: 6, border: `1px solid ${T.border}`, background: T.bg3, color: T.text, fontFamily: 'inherit' }
  const btn: React.CSSProperties = { ...input, cursor: 'pointer' }

  return (
    <>
      <Head><title>Live Bins — Just Autos</title><meta name="robots" content="noindex,nofollow" /></Head>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden', fontFamily: "'DM Sans',system-ui,sans-serif", background: T.bg, color: T.text }}>
        <PortalTopBar activeId="workshop" currentUserRole={user.role} currentUserVisibleTabs={user.visibleTabs} currentUserName={user.displayName} currentUserEmail={user.email} />
        <WorkshopTabs active="inventory" role={user.role} />
        <InventoryTabs active={'live-bins' as any} role={user.role} />

        <div style={{ flex: 1, overflowY: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ fontSize: 16, fontWeight: 600 }}>Live bin inventory</div>
            <div style={{ fontSize: 12, color: T.text3 }}>Load-cell modules report every ~30 s · units = weight ÷ unit weight</div>
            <div style={{ flex: 1 }} />
            <button onClick={() => setSetup(s => !s)} style={{ ...btn, borderColor: setup ? T.blue : T.border, color: setup ? T.blue : T.text2 }}>
              {setup ? 'Close setup' : '⚙ Setup'}
            </button>
            {setup && <button onClick={addDevice} style={{ ...btn, borderColor: T.blue, color: T.blue }}>+ Add module</button>}
          </div>

          {note && <div style={{ fontSize: 12, color: note.startsWith('⚠') ? T.red : T.green, background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 8, padding: '8px 12px', fontFamily: 'monospace', wordBreak: 'break-all' }}>{note}</div>}
          {error && <div style={{ fontSize: 13, color: T.red }}>{error}</div>}
          {devices === null && <div style={{ color: T.text3, padding: 30, textAlign: 'center' }}>Loading…</div>}
          {devices !== null && devices.length === 0 && (
            <div style={{ color: T.text3, padding: 30, textAlign: 'center', fontStyle: 'italic' }}>
              No scale modules yet — hit ⚙ Setup → + Add module to register the first ESP32 and get its device key.
            </div>
          )}

          {(devices || []).map(d => (
            <div key={d.id} style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 12, overflow: 'hidden', opacity: d.is_active ? 1 : 0.55 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderBottom: `1px solid ${T.border}` }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: online(d) ? T.green : T.red, boxShadow: online(d) ? `0 0 6px ${T.green}` : 'none' }} />
                <span style={{ fontSize: 14, fontWeight: 600 }}>{d.name}</span>
                {d.location && <span style={{ fontSize: 12, color: T.text3 }}>· {d.location}</span>}
                <span style={{ fontSize: 11, color: T.text3, fontFamily: 'monospace' }}>
                  {online(d) ? `online · ${d.rssi != null ? `${d.rssi} dBm · ` : ''}` : d.last_seen_at ? `last seen ${new Date(d.last_seen_at).toLocaleString('en-AU')} · ` : 'never seen · '}
                  {d.firmware ? `fw ${d.firmware}` : ''}
                </span>
                <div style={{ flex: 1 }} />
                {setup && <>
                  <button onClick={async () => { const n = await promptDialog({ title: 'Rename module', label: 'Name', defaultValue: d.name }); if (n?.trim()) act({ action: 'updateDevice', id: d.id, name: n }) }} style={btn}>Rename</button>
                  <button onClick={() => act({ action: 'addBin', deviceId: d.id, channel: Math.max(-1, ...d.bins.map(b => b.channel)) + 1 })} style={btn}>+ Cell</button>
                  <button onClick={() => { navigator.clipboard?.writeText(d.device_key); setNote(`Device key copied: ${d.device_key}`) }} style={btn} title="The key the ESP32 sends in x-device-key">Copy key</button>
                  <button onClick={() => act({ action: 'updateDevice', id: d.id, is_active: !d.is_active })} style={btn}>{d.is_active ? 'Disable' : 'Enable'}</button>
                  <button onClick={async () => { if (await confirmDialog({ title: `Delete "${d.name}"?`, message: 'Removes the module, its bins and reading history.', danger: true })) act({ action: 'deleteDevice', id: d.id }) }} style={{ ...btn, color: T.red, borderColor: `${T.red}60` }}>✕</button>
                </>}
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12, padding: 14 }}>
                {d.bins.map(b => {
                  const stale = !b.last_reading_at || Date.now() - Date.parse(b.last_reading_at) > STALE_MS
                  const low = b.alert_min_units != null && b.last_units != null && b.last_units <= b.alert_min_units
                  const ready = b.grams_per_raw != null && b.unit_weight_g != null
                  return (
                    <div key={b.id} style={{ background: T.bg3, border: `1px solid ${low ? T.red : T.border}`, borderRadius: 10, padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                        <span style={{ fontSize: 12, fontWeight: 700, color: T.text2 }}>{b.bin_number || `Cell ${b.channel}`}</span>
                        <span style={{ fontSize: 11, color: T.text3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.part_number || 'no part assigned'}</span>
                        <div style={{ flex: 1 }} />
                        {setup && <button onClick={async () => { if (await confirmDialog({ title: 'Remove this cell?', message: 'Removes its config and history.', danger: true })) act({ action: 'deleteBin', id: b.id }) }} style={{ background: 'none', border: 'none', color: T.text3, cursor: 'pointer' }}>✕</button>}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
                        <span style={{ fontSize: 34, fontWeight: 800, fontFamily: 'monospace', color: stale ? T.text3 : low ? T.red : T.green }}>
                          {ready && b.last_units != null ? b.last_units : '—'}
                        </span>
                        <span style={{ fontSize: 11, color: T.text3 }}>
                          units{b.last_grams != null && ` · ${Math.round(Number(b.last_grams))} g`}{stale && b.last_reading_at ? ' · STALE' : ''}
                          {!ready && (b.grams_per_raw == null ? ' · needs calibration' : ' · needs unit weight')}
                        </span>
                      </div>
                      {setup && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                          <div style={{ display: 'flex', gap: 6 }}>
                            <input defaultValue={b.bin_number || ''} placeholder="Bin #" onBlur={e => e.target.value !== (b.bin_number || '') && act({ action: 'updateBin', id: b.id, bin_number: e.target.value })} style={{ ...input, width: 80 }} />
                            <input defaultValue={b.part_number || ''} placeholder="Part number" onBlur={e => e.target.value !== (b.part_number || '') && act({ action: 'updateBin', id: b.id, part_number: e.target.value })} style={{ ...input, flex: 1 }} />
                          </div>
                          <div style={{ display: 'flex', gap: 6 }}>
                            <input defaultValue={b.unit_weight_g != null ? String(b.unit_weight_g) : ''} placeholder="g / unit" onBlur={e => act({ action: 'updateBin', id: b.id, unit_weight_g: e.target.value })} style={{ ...input, width: 90 }} />
                            <input defaultValue={b.alert_min_units != null ? String(b.alert_min_units) : ''} placeholder="Alert ≤" onBlur={e => act({ action: 'updateBin', id: b.id, alert_min_units: e.target.value })} style={{ ...input, width: 70 }} />
                            <button onClick={() => act({ action: 'tare', id: b.id }, 'Tared — zero set to the current reading.')} style={btn} title="Press with the bin EMPTY">Tare</button>
                            <button onClick={() => calibrate(b)} style={btn} title="Tare first, then put a known weight on and press">Calibrate</button>
                            <button onClick={() => unitFromCount(b)} style={btn} title="Put a counted handful of parts on, press, enter the count — g/unit computed from the live reading">g/unit ÷</button>
                          </div>
                          <div style={{ fontSize: 10, color: T.text3, fontFamily: 'monospace' }}>
                            raw {b.last_raw ?? '—'} · zero {b.zero_offset_raw} · {b.grams_per_raw != null ? `${Number(b.grams_per_raw).toPrecision(4)} g/raw` : 'uncalibrated'}
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  )
}

export async function getServerSideProps(context: any) {
  return requirePageAuth(context, 'view:diary')
}
