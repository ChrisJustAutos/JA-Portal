// components/b2b/FreightMarkupTiersManager.tsx
// Edit the tiered freight markup (migration 208). Chris 2026-08-27: a flat
// percentage charged the same 20% on a $2,800 consignment as on a $60 one.
//
// A band's "Up to" is its INCLUSIVE upper bound on what the CARRIER charges us
// ex GST — $500 exactly is in the "up to $500" band. Leave it blank for the
// open-ended top band; there can be only one, and the API says so plainly if
// you try to add a second.
//
// Styled on the shared Alloy kit, same shape as FreightPackagingManager.

import { useEffect, useState } from 'react'
import { T } from '../../lib/ui/theme'
import { SkeletonRows } from '../ui'
import { useConfirm } from '../ui/Feedback'
import { A, Btn, inputStyle } from './ui'

const inp: React.CSSProperties = { ...inputStyle(), padding: '6px 9px', fontSize: 13, minHeight: 32 }
const money = (n: any) => (n == null || n === '' ? '' : String(Math.round(Number(n) * 100) / 100))

interface Tier { id: string; up_to_ex_gst: number | null; markup_percent: number; sort_order: number; is_active: boolean }

export default function FreightMarkupTiersManager() {
  const confirmDialog = useConfirm()
  const [tiers, setTiers] = useState<Tier[]>([])
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState('')
  const [adding, setAdding] = useState(false)
  const [neu, setNeu] = useState({ up_to_ex_gst: '', markup_percent: '' })

  async function load() {
    setLoading(true)
    try {
      const r = await fetch('/api/b2b/admin/freight-markup-tiers')
      const j = await r.json()
      setTiers(j.tiers || [])
    } catch (e: any) { setMsg(e?.message || 'Load failed') } finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

  async function patch(id: string, body: Record<string, any>) {
    setMsg('')
    const r = await fetch(`/api/b2b/admin/freight-markup-tiers?id=${encodeURIComponent(id)}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) { setMsg(j.error || 'Save failed'); return }
    load()
  }

  async function create() {
    setMsg('')
    const r = await fetch('/api/b2b/admin/freight-markup-tiers', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // Blank deliberately means the open-ended top band, so send it as null
        // rather than omitting the field (the API rejects a missing one).
        up_to_ex_gst: neu.up_to_ex_gst.trim() === '' ? null : Number(neu.up_to_ex_gst),
        markup_percent: Number(neu.markup_percent),
        sort_order: (tiers.length + 1) * 10,
      }),
    })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) { setMsg(j.error || (j.issues || []).join('; ') || 'Add failed'); return }
    setNeu({ up_to_ex_gst: '', markup_percent: '' }); setAdding(false); load()
  }

  async function remove(t: Tier) {
    const label = t.up_to_ex_gst == null ? 'the open-ended top band' : `the band up to $${money(t.up_to_ex_gst)}`
    const ok = await confirmDialog({
      title: 'Delete this band?',
      message: `Remove ${label} at ${t.markup_percent}%? Freight in that range will fall into the next band up.`,
      confirmLabel: 'Delete', danger: true,
    })
    if (!ok) return
    const r = await fetch(`/api/b2b/admin/freight-markup-tiers?id=${encodeURIComponent(t.id)}`, { method: 'DELETE' })
    if (!r.ok) { const j = await r.json().catch(() => ({})); setMsg(j.error || 'Delete failed'); return }
    load()
  }

  // Show each band as the range it actually covers, so nobody has to work out
  // that "up to 1000" starts where "up to 500" stopped.
  const sorted = [...tiers].sort((a, b) => {
    if (a.up_to_ex_gst == null) return 1
    if (b.up_to_ex_gst == null) return -1
    return a.up_to_ex_gst - b.up_to_ex_gst
  })
  function rangeLabel(i: number): string {
    const t = sorted[i]
    const prev = i > 0 ? sorted[i - 1].up_to_ex_gst : null
    const from = prev == null ? 0 : prev
    if (t.up_to_ex_gst == null) return `over $${money(from)}`
    return from === 0 ? `up to $${money(t.up_to_ex_gst)}` : `over $${money(from)} to $${money(t.up_to_ex_gst)}`
  }

  if (loading) return <SkeletonRows rows={3} />

  return (
    <div>
      <div style={{ fontSize: 12.5, color: T.text2, marginBottom: 8 }}>
        The band is chosen by <strong>what the carrier charges us</strong> ex GST, and the upper limit is inclusive —
        a $500.00 carrier price is in the “up to $500” band, $500.01 is in the next one. Leave <em>Up to</em> blank for
        the open-ended top band.
      </div>

      {sorted.length === 0 ? (
        <div style={{ fontSize: 12.5, color: A.warn, marginBottom: 8 }}>
          No bands configured — the flat Markup % below is used for every consignment.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 110px 90px 80px', gap: 8, fontSize: 12, color: T.text3 }}>
            <span>Carrier price</span><span>Up to $</span><span>Markup %</span><span/>
          </div>
          {sorted.map((t, i) => (
            <div key={t.id} style={{ display: 'grid', gridTemplateColumns: '1fr 110px 90px 80px', gap: 8, alignItems: 'center', opacity: t.is_active ? 1 : 0.5 }}>
              <span style={{ fontSize: 13 }}>{rangeLabel(i)}</span>
              <input
                style={inp}
                defaultValue={money(t.up_to_ex_gst)}
                placeholder="(top band)"
                onBlur={e => {
                  const raw = e.target.value.trim()
                  const next = raw === '' ? null : Number(raw)
                  if (next === (t.up_to_ex_gst == null ? null : Number(t.up_to_ex_gst))) return
                  patch(t.id, { up_to_ex_gst: raw === '' ? null : next })
                }}
              />
              <input
                style={inp}
                type="number" min={0} max={500} step={0.1}
                defaultValue={String(t.markup_percent)}
                onBlur={e => {
                  const next = Number(e.target.value)
                  if (next === Number(t.markup_percent)) return
                  patch(t.id, { markup_percent: next })
                }}
              />
              <Btn onClick={() => remove(t)} variant="ghost">Delete</Btn>
            </div>
          ))}
        </div>
      )}

      {msg && <div style={{ fontSize: 12.5, color: A.bad, marginBottom: 8 }}>{msg}</div>}

      {adding ? (
        <div style={{ display: 'grid', gridTemplateColumns: '110px 90px auto auto', gap: 8, alignItems: 'center' }}>
          <input style={inp} placeholder="Up to $" value={neu.up_to_ex_gst} onChange={e => setNeu(v => ({ ...v, up_to_ex_gst: e.target.value }))} />
          <input style={inp} type="number" min={0} max={500} step={0.1} placeholder="%" value={neu.markup_percent} onChange={e => setNeu(v => ({ ...v, markup_percent: e.target.value }))} />
          <Btn onClick={create}>Add band</Btn>
          <Btn onClick={() => { setAdding(false); setMsg('') }} variant="ghost">Cancel</Btn>
        </div>
      ) : (
        <Btn onClick={() => setAdding(true)} variant="ghost">+ Add a band</Btn>
      )}
    </div>
  )
}
