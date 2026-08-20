// pages/workshop/cash-count.tsx — Cash Count on the Live Bins scale rig.
// Pick a calibrated scale channel, tare with the empty tray, then work
// through the denominations: tip each one onto the scale, the count and
// value appear live (grams ÷ official coin mass), capture, next. Notes are
// manual-count until calibrated from a sample. Saves the till count with
// expected-vs-counted variance.

import { useEffect, useMemo, useState, useCallback } from 'react'
import Head from 'next/head'
import PortalTopBar from '../../lib/PortalTopBar'
import WorkshopTabs from '../../components/WorkshopTabs'
import { requirePageAuth } from '../../lib/authServer'
import { T } from '../../lib/ui/theme'
import { usePrompt, useToast } from '../../components/ui/Feedback'

interface Bin {
  id: string; channel: number; bin_number: string | null; part_name: string | null
  grams_per_raw: number | null; last_grams: number | null; last_reading_at: string | null
}
interface Device { id: string; name: string; last_seen_at: string | null; is_active: boolean; bins: Bin[] }
interface Denom { id: string; label: string; value_cents: number; unit_weight_g: number | null; sort: number; is_note: boolean }
interface Line { denom_id: string; label: string; count: number; value_cents: number; grams: number | null; manual: boolean }
interface SavedCount { id: string; counted_at: string; counted_by: string | null; total_cents: number; expected_cents: number | null; variance_cents: number | null }

const STALE_MS = 5 * 60_000
const money = (cents: number) => `$${(cents / 100).toFixed(2)}`

export default function CashCountPage({ user }: { user: any }) {
  const promptDialog = usePrompt()
  const toast = useToast()
  const [devices, setDevices] = useState<Device[]>([])
  const [denoms, setDenoms] = useState<Denom[]>([])
  const [history, setHistory] = useState<SavedCount[]>([])
  const [binId, setBinId] = useState<string>('')
  const [selected, setSelected] = useState<string>('')          // denomination id
  const [lines, setLines] = useState<Record<string, Line>>({})
  const [expected, setExpected] = useState('')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const loadScales = useCallback(() => {
    fetch('/api/scales').then(r => r.json())
      .then(d => { if (!d.error) setDevices(d.devices || []) })
      .catch(() => {})
  }, [])
  const loadCash = useCallback(() => {
    fetch('/api/workshop/cash-count').then(r => r.json())
      .then(d => { if (d.error) throw new Error(d.error); setDenoms(d.denominations || []); setHistory(d.counts || []) })
      .catch(e => setErr(e.message || 'Load failed'))
  }, [])
  useEffect(() => {
    loadScales(); loadCash()
    const t = setInterval(loadScales, 2_000)
    return () => clearInterval(t)
  }, [loadScales, loadCash])

  const allBins = useMemo(() =>
    devices.flatMap(d => d.bins.filter(b => b.grams_per_raw != null).map(b => ({
      ...b, deviceName: d.name,
      online: !!d.last_seen_at && Date.now() - Date.parse(d.last_seen_at) < STALE_MS,
    }))), [devices])
  const bin = allBins.find(b => b.id === binId) || null
  useEffect(() => { if (!binId && allBins.length === 1) setBinId(allBins[0].id) }, [allBins, binId])

  const grams = bin?.last_grams != null ? Number(bin.last_grams) : null
  const denom = denoms.find(d => d.id === selected) || null
  const liveCount = denom?.unit_weight_g && grams != null && grams > Number(denom.unit_weight_g) / 2
    ? Math.round(grams / Number(denom.unit_weight_g))
    : 0

  async function tare() {
    if (!bin) return
    setBusy(true)
    const r = await fetch('/api/scales', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'tare', id: bin.id }) }).then(x => x.json())
    setBusy(false)
    if (r.error) toast(r.error, 'error')
    else toast('Tared — the empty tray now reads 0 g.', 'success')
  }

  function capture(d: Denom, count: number, manual: boolean) {
    if (count <= 0) return
    setLines(ls => ({
      ...ls,
      [d.id]: { denom_id: d.id, label: d.label, count, value_cents: count * d.value_cents, grams: manual ? null : grams, manual },
    }))
    setSelected('')
    if (!manual) toast(`${d.label} captured: ${count} = ${money(count * d.value_cents)}. Take them off the scale, then pick the next denomination.`, 'success')
  }

  async function manualEntry(d: Denom) {
    const v = await promptDialog({ title: `${d.label} — manual count`, label: `How many ${d.label}${d.is_note ? ' notes' : ' coins'}?`, inputMode: 'numeric' })
    const n = Number(v)
    if (!Number.isFinite(n) || n < 0) return
    capture(d, Math.round(n), true)
  }

  // Calibrate a denomination's unit weight from a counted sample on the scale.
  async function weighFromSample(d: Denom) {
    if (grams == null || grams < 1) { toast('Put a counted sample on the scale first (and make sure it’s tared).', 'error'); return }
    const v = await promptDialog({ title: `Calibrate ${d.label} weight`, label: `How many ${d.label} are on the scale right now? (${Math.round(grams)} g)`, inputMode: 'numeric' })
    const n = Number(v)
    if (!Number.isFinite(n) || n <= 0) return
    const w = Math.round((grams / n) * 1000) / 1000
    const r = await fetch('/api/workshop/cash-count', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'setWeight', id: d.id, unit_weight_g: w }) }).then(x => x.json())
    if (r.error) toast(r.error, 'error')
    else { toast(`${d.label} = ${w} g each (${Math.round(grams)} g ÷ ${n}).`, 'success'); loadCash() }
  }

  const lineList = denoms.map(d => lines[d.id]).filter(Boolean) as Line[]
  const total = lineList.reduce((s, l) => s + l.value_cents, 0)
  const expectedCents = expected.trim() === '' ? null : Math.round(Number(expected) * 100)
  const variance = expectedCents == null || !Number.isFinite(expectedCents) ? null : total - expectedCents

  async function save() {
    if (!lineList.length) { toast('Nothing captured yet.', 'error'); return }
    setBusy(true)
    const r = await fetch('/api/workshop/cash-count', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'save', lines: lineList, total_cents: total, expected_cents: expectedCents, notes }),
    }).then(x => x.json())
    setBusy(false)
    if (r.error) { toast(r.error, 'error'); return }
    toast(`Count saved — ${money(total)}${variance != null ? ` (${variance >= 0 ? '+' : ''}${money(variance).replace('$-', '-$')} vs expected)` : ''}.`, 'success')
    setLines({}); setExpected(''); setNotes(''); setSelected('')
    loadCash()
  }

  const btn: React.CSSProperties = { fontSize: 12, padding: '6px 12px', borderRadius: 6, border: `1px solid ${T.border}`, background: T.bg3, color: T.text2, cursor: 'pointer', fontFamily: 'inherit' }
  const input: React.CSSProperties = { fontSize: 13, padding: '7px 10px', borderRadius: 6, border: `1px solid ${T.border}`, background: T.bg3, color: T.text, fontFamily: 'inherit' }

  return (
    <>
      <Head><title>Cash Count — Just Autos</title><meta name="robots" content="noindex,nofollow" /></Head>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden', fontFamily: "'DM Sans',system-ui,sans-serif", background: T.bg, color: T.text }}>
        <PortalTopBar activeId="workshop" currentUserRole={user.role} currentUserVisibleTabs={user.visibleTabs} currentUserName={user.displayName} currentUserEmail={user.email} />
        <WorkshopTabs active="inventory" role={user.role} />

        <div style={{ flex: 1, overflowY: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 1100 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ fontSize: 16, fontWeight: 600 }}>Cash count</div>
            <div style={{ fontSize: 12, color: T.text3 }}>Tare the empty tray → tip one denomination on → capture → next. Notes can be typed in.</div>
          </div>
          {err && <div style={{ fontSize: 13, color: T.red }}>{err}</div>}

          {/* Scale strip */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 10, padding: '12px 14px' }}>
            <select value={binId} onChange={e => setBinId(e.target.value)} style={input}>
              <option value="">Pick a scale…</option>
              {allBins.map(b => <option key={b.id} value={b.id}>{(b as any).deviceName} · ch {b.channel}{(b as any).online ? '' : ' (offline)'}</option>)}
            </select>
            <button onClick={tare} disabled={!bin || busy} style={{ ...btn, opacity: !bin || busy ? 0.5 : 1 }}>⚖ Tare (empty tray)</button>
            <div style={{ flex: 1 }} />
            <div style={{ fontSize: 26, fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>
              {grams != null ? `${Math.round(grams)} g` : '— g'}
            </div>
            {bin && !(bin as any).online && <span style={{ fontSize: 11, color: T.red, fontWeight: 700 }}>SCALE OFFLINE</span>}
          </div>

          {/* Denominations */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 10 }}>
            {denoms.map(d => {
              const line = lines[d.id]
              const isSel = selected === d.id
              const weighable = d.unit_weight_g != null && bin != null
              const selCount = isSel ? liveCount : 0
              return (
                <div key={d.id}
                  onClick={() => weighable ? setSelected(isSel ? '' : d.id) : manualEntry(d)}
                  style={{
                    background: T.bg2, border: `2px solid ${isSel ? T.blue : line ? T.green : T.border}`,
                    borderRadius: 10, padding: 12, cursor: 'pointer', userSelect: 'none',
                  }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
                    <div style={{ fontSize: 17, fontWeight: 800 }}>{d.label}</div>
                    <div style={{ fontSize: 10.5, color: T.text3 }}>{d.unit_weight_g != null ? `${d.unit_weight_g} g` : 'manual'}</div>
                  </div>
                  {isSel ? (
                    <div style={{ marginTop: 6 }}>
                      <div style={{ fontSize: 24, fontWeight: 800, color: T.blue, fontVariantNumeric: 'tabular-nums' }}>{selCount}</div>
                      <div style={{ fontSize: 12, color: T.text2 }}>{money(selCount * d.value_cents)}</div>
                      <button onClick={e => { e.stopPropagation(); capture(d, selCount, false) }} disabled={selCount <= 0}
                        style={{ ...btn, marginTop: 6, width: '100%', borderColor: T.blue, color: T.blue, opacity: selCount > 0 ? 1 : 0.4 }}>
                        ✓ Capture
                      </button>
                    </div>
                  ) : line ? (
                    <div style={{ marginTop: 6, fontSize: 13, color: T.green, fontWeight: 700 }}>
                      {line.count} = {money(line.value_cents)}{line.manual ? ' ✎' : ''}
                    </div>
                  ) : (
                    <div style={{ marginTop: 6, fontSize: 11.5, color: T.text3 }}>{weighable ? 'tap to weigh' : 'tap to type count'}</div>
                  )}
                  <div style={{ marginTop: 8, display: 'flex', gap: 6 }}>
                    <button onClick={e => { e.stopPropagation(); manualEntry(d) }} style={{ ...btn, fontSize: 10.5, padding: '3px 8px' }}>type</button>
                    {bin && <button onClick={e => { e.stopPropagation(); weighFromSample(d) }} title="Set this denomination's weight from a counted sample on the scale" style={{ ...btn, fontSize: 10.5, padding: '3px 8px' }}>⚖ cal</button>}
                  </div>
                </div>
              )
            })}
          </div>

          {/* Summary + save */}
          <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 10, padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
              <div style={{ fontSize: 14, fontWeight: 700 }}>Total counted: <span style={{ fontSize: 20, fontWeight: 800 }}>{money(total)}</span></div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 12, color: T.text3 }}>Expected $</span>
                <input value={expected} onChange={e => setExpected(e.target.value)} placeholder="e.g. 300" inputMode="decimal" style={{ ...input, width: 90 }} />
              </div>
              {variance != null && Number.isFinite(variance) && (
                <div style={{ fontSize: 14, fontWeight: 800, color: variance === 0 ? T.green : variance > 0 ? T.blue : T.red }}>
                  {variance === 0 ? '✓ balanced' : `${variance > 0 ? 'over' : 'short'} ${money(Math.abs(variance))}`}
                </div>
              )}
              <div style={{ flex: 1 }} />
              <button onClick={save} disabled={busy || !lineList.length}
                style={{ ...btn, border: `1px solid ${T.blue}`, background: T.blue, color: '#fff', fontWeight: 700, padding: '9px 20px', opacity: busy || !lineList.length ? 0.5 : 1 }}>
                💾 Save count
              </button>
            </div>
            <input value={notes} onChange={e => setNotes(e.target.value)} placeholder="Notes (optional — e.g. till #1, morning float)" style={input} />
            {lineList.length > 0 && (
              <div style={{ fontSize: 12.5, color: T.text2 }}>
                {lineList.map(l => (
                  <span key={l.denom_id} style={{ marginRight: 14 }}>
                    {l.label}×{l.count} <b>{money(l.value_cents)}</b>
                    <button onClick={() => setLines(ls => { const n = { ...ls }; delete n[l.denom_id]; return n })}
                      style={{ background: 'none', border: 'none', color: T.red, cursor: 'pointer', fontSize: 12, padding: '0 2px' }}>✕</button>
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* History */}
          {history.length > 0 && (
            <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 10, padding: 14 }}>
              <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Recent counts</div>
              {history.map(h => (
                <div key={h.id} style={{ display: 'flex', gap: 14, fontSize: 12.5, padding: '5px 0', borderTop: `1px solid ${T.border}`, flexWrap: 'wrap' }}>
                  <span style={{ color: T.text3, minWidth: 150 }}>{new Date(h.counted_at).toLocaleString('en-AU', { timeZone: 'Australia/Brisbane', day: '2-digit', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true })}</span>
                  <b>{money(h.total_cents)}</b>
                  {h.variance_cents != null && (
                    <span style={{ color: h.variance_cents === 0 ? T.green : h.variance_cents > 0 ? T.blue : T.red, fontWeight: 700 }}>
                      {h.variance_cents === 0 ? 'balanced' : `${h.variance_cents > 0 ? 'over' : 'short'} ${money(Math.abs(h.variance_cents))}`}
                    </span>
                  )}
                  <span style={{ color: T.text3 }}>{h.counted_by || ''}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  )
}

export async function getServerSideProps(context: any) {
  return requirePageAuth(context, 'view:diary')
}
