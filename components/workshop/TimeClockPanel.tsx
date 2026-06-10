// components/workshop/TimeClockPanel.tsx
// Tech time clock for the job card Activity tab: clock on/off per technician,
// live elapsed timer, entries table, and actual-vs-quoted hours (quoted =
// the sum of labour-line qty, which the workshop quotes in hours).

import { useCallback, useEffect, useState } from 'react'

const T = {
  bg2: '#131519', bg3: '#1a1d23',
  border: 'rgba(255,255,255,0.07)', border2: 'rgba(255,255,255,0.12)',
  text: '#e8eaf0', text2: '#8b90a0', text3: '#545968',
  blue: '#4f8ef7', green: '#34c77b', amber: '#f5a623', red: '#f04e4e',
}

interface TimeEntry { id: string; technician_code: string; started_at: string; ended_at: string | null; minutes: number | null }
interface Tech { code: string; name: string }

const fmtHrs = (mins: number) => `${(mins / 60).toFixed(1)} h`
const fmtClock = (mins: number) => {
  const h = Math.floor(mins / 60), m = mins % 60
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`
}
const fmtDT = (iso: string) => new Date(iso).toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })

export default function TimeClockPanel({ bookingId, defaultTech, quotedHours, canEdit }: {
  bookingId: string; defaultTech?: string | null; quotedHours: number; canEdit: boolean
}) {
  const [entries, setEntries] = useState<TimeEntry[]>([])
  const [techs, setTechs] = useState<Tech[]>([])
  const [sel, setSel] = useState(defaultTech || '')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [, setTick] = useState(0) // re-render for the live timer

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/workshop/time-entries?booking_id=${bookingId}`)
      if (r.ok) setEntries((await r.json()).entries || [])
    } catch { /* keep prior */ }
  }, [bookingId])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch('/api/workshop/technicians')
        if (r.ok) {
          const list = ((await r.json()).technicians || []).filter((t: any) => t.active !== false)
          setTechs(list.map((t: any) => ({ code: t.code, name: t.name })))
        }
      } catch { /* ignore */ }
    })()
  }, [])
  useEffect(() => { if (!sel && defaultTech) setSel(defaultTech) }, [defaultTech, sel])

  const anyRunning = entries.some(e => !e.ended_at)
  useEffect(() => {
    if (!anyRunning) return
    const t = setInterval(() => setTick(n => n + 1), 1000)
    return () => clearInterval(t)
  }, [anyRunning])

  const now = Date.now()
  const entryMins = (e: TimeEntry) => e.ended_at ? (Number(e.minutes) || 0) : Math.max(0, Math.round((now - new Date(e.started_at).getTime()) / 60000))
  const totalMins = entries.reduce((s, e) => s + entryMins(e), 0)
  const selOpen = entries.find(e => !e.ended_at && e.technician_code === sel)
  const techName = (code: string) => techs.find(t => t.code === code)?.name || code
  const over = quotedHours > 0 && totalMins / 60 > quotedHours

  async function clock(action: 'on' | 'off') {
    if (!sel) { setMsg('Pick a technician first'); return }
    setBusy(true); setMsg('')
    const body: any = { booking_id: bookingId, technician_code: sel }
    if (action === 'off') body.action = 'stop'
    const r = await fetch('/api/workshop/time-entries', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    if (!r.ok) setMsg((await r.json()).error || 'Failed')
    setBusy(false)
    await load()
  }

  async function removeEntry(id: string) {
    if (!confirm('Remove this time entry?')) return
    await fetch(`/api/workshop/time-entries?id=${id}`, { method: 'DELETE' })
    await load()
  }

  return (
    <div style={{ padding: 16 }}>
      {canEdit && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 14 }}>
          <select value={sel} onChange={e => setSel(e.target.value)} style={{
            padding: '6px 10px', background: T.bg3, border: `1px solid ${T.border2}`, borderRadius: 5,
            color: T.text, fontSize: 12, fontFamily: 'inherit', minWidth: 160,
          }}>
            <option value="">— technician —</option>
            {techs.map(t => <option key={t.code} value={t.code}>{t.name}</option>)}
          </select>
          {selOpen ? (
            <button onClick={() => clock('off')} disabled={busy} style={clockBtn(T.red)}>
              ■ Clock off · {fmtClock(entryMins(selOpen))}
            </button>
          ) : (
            <button onClick={() => clock('on')} disabled={busy || !sel} style={clockBtn(T.green)}>▶ Clock on</button>
          )}
          {msg && <span style={{ fontSize: 11, color: T.amber }}>{msg}</span>}
        </div>
      )}

      {/* Totals */}
      <div style={{ display: 'flex', gap: 18, marginBottom: 12, fontSize: 12 }}>
        <span style={{ color: T.text2 }}>Actual: <strong style={{ color: over ? T.red : T.green, fontFamily: 'monospace' }}>{fmtHrs(totalMins)}</strong></span>
        <span style={{ color: T.text2 }}>Quoted labour: <strong style={{ color: T.text, fontFamily: 'monospace' }}>{quotedHours ? `${quotedHours.toFixed(1)} h` : '—'}</strong></span>
        {entries.some(e => !e.ended_at) && <span style={{ color: T.amber }}>⏱ {entries.filter(e => !e.ended_at).map(e => techName(e.technician_code)).join(', ')} on the clock</span>}
      </div>

      {entries.length === 0 ? (
        <div style={{ padding: 16, textAlign: 'center', fontSize: 12, color: T.text3 }}>No time recorded on this job yet.</div>
      ) : (
        <div style={{ border: `1px solid ${T.border}`, borderRadius: 8, overflow: 'hidden' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 130px 130px 90px 40px', gap: 8, padding: '7px 12px', background: T.bg3, fontSize: 9, color: T.text3, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            <div>Technician</div><div>Start</div><div>End</div><div style={{ textAlign: 'right' }}>Time</div><div />
          </div>
          {entries.map(e => (
            <div key={e.id} style={{ display: 'grid', gridTemplateColumns: '1fr 130px 130px 90px 40px', gap: 8, padding: '8px 12px', borderTop: `1px solid ${T.border}`, fontSize: 12, alignItems: 'center' }}>
              <div style={{ color: T.text }}>{techName(e.technician_code)}</div>
              <div style={{ color: T.text2, fontFamily: 'monospace', fontSize: 11 }}>{fmtDT(e.started_at)}</div>
              <div style={{ color: e.ended_at ? T.text2 : T.amber, fontFamily: 'monospace', fontSize: 11 }}>{e.ended_at ? fmtDT(e.ended_at) : 'running…'}</div>
              <div style={{ textAlign: 'right', fontFamily: 'monospace', color: e.ended_at ? T.text : T.amber }}>{fmtClock(entryMins(e))}</div>
              <div style={{ textAlign: 'right' }}>
                {canEdit && <button onClick={() => removeEntry(e.id)} title="Remove entry" style={{ background: 'none', border: 'none', color: T.text3, cursor: 'pointer', fontSize: 12 }}>×</button>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

const clockBtn = (c: string): React.CSSProperties => ({
  padding: '7px 16px', borderRadius: 6, fontSize: 12, fontWeight: 700, fontFamily: 'inherit',
  background: `${c}1e`, color: c, border: `1px solid ${c}55`, cursor: 'pointer',
})
