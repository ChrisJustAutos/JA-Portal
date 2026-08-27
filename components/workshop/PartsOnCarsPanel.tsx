// components/workshop/PartsOnCarsPanel.tsx
//
// "On cars" panel for Stocktake (MD). Parts already fitted to cars sitting in
// the workshop, on jobs MechanicDesk hasn't invoiced — so MD still counts them
// as on-hand and the shelf count comes up short by exactly this much.
//
// The whole point is to make a variance explainable: you counted 4, MD says 6,
// and two are on the Hilux that's been on hoist 3 for a fortnight. So every SKU
// expands to the actual cars.
//
// Only STARTED jobs count (MD diary status `new`, date arrived, invoice not
// finalised). Jobs MD has booked ahead with parts prepped are excluded — those
// parts may be off the shelf but the car isn't here.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { T } from '../../lib/ui/theme'
import { SkeletonRows } from '../ui'

interface OnCarItem {
  md_stock_id: number | null
  sku: string | null
  name: string | null
  on_cars: number
  jobs_count: number
  on_hand: number | null
  available: number | null
  buy_price: number | null
  bin: string | null
  location: string | null
}
interface OnCarJob {
  md_job_id: number
  job_number: string | null
  customer_name: string | null
  vehicle: string | null
  rego: string | null
  description: string | null
  invoice_number: string | null
  days_open: number | null
  parts_count: number
  parts_qty: number
  parts_value: number
}
interface OnCarJobItem { md_job_id: number; md_stock_id: number | null; sku: string | null; quantity: number }

const MD_BASE = 'https://www.mechanicdesk.com.au'
const n2 = (v: number) => (Math.round(v * 100) / 100).toLocaleString('en-AU')
const money = (v: number) => `$${(Math.round(v * 100) / 100).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export default function PartsOnCarsPanel({ canEdit }: { canEdit: boolean }) {
  const [loading, setLoading] = useState(true)
  const [run, setRun] = useState<any>(null)
  const [items, setItems] = useState<OnCarItem[]>([])
  const [jobs, setJobs] = useState<OnCarJob[]>([])
  const [jobItems, setJobItems] = useState<OnCarJobItem[]>([])
  const [inFlight, setInFlight] = useState(false)
  const [err, setErr] = useState('')
  const [msg, setMsg] = useState('')
  const [q, setQ] = useState('')
  const [expanded, setExpanded] = useState<number | null>(null)
  const [view, setView] = useState<'parts' | 'cars'>('parts')

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/workshop/oncar')
      if (!r.ok) throw new Error(`${r.status}`)
      const d = await r.json()
      setRun(d.run || null)
      setItems(d.items || [])
      setJobs(d.jobs || [])
      setJobItems(d.job_items || [])
      setInFlight(!!d.in_flight)
      setErr(d.error || '')
    } catch {
      setErr('Could not load the on-cars snapshot.')
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  // Poll only while a pull is actually running.
  useEffect(() => {
    if (!inFlight) return
    const t = setInterval(load, 5000)
    return () => clearInterval(t)
  }, [inFlight, load])

  async function refresh() {
    setMsg(''); setErr('')
    const r = await fetch('/api/workshop/oncar/refresh', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    })
    const d = await r.json().catch(() => ({}))
    if (!r.ok) { setErr(d.error || 'Could not start the check.'); return }
    setInFlight(true)
    setMsg(d.message || 'Checking MechanicDesk…')
  }

  const jobsById = useMemo(() => {
    const m = new Map<number, OnCarJob>()
    for (const j of jobs) m.set(j.md_job_id, j)
    return m
  }, [jobs])

  const jobsForStock = useMemo(() => {
    const m = new Map<number, { job: OnCarJob; qty: number }[]>()
    for (const li of jobItems) {
      if (li.md_stock_id == null) continue
      const j = jobsById.get(li.md_job_id)
      if (!j) continue
      if (!m.has(li.md_stock_id)) m.set(li.md_stock_id, [])
      m.get(li.md_stock_id)!.push({ job: j, qty: li.quantity })
    }
    for (const arr of Array.from(m.values())) arr.sort((a, b) => b.qty - a.qty)
    return m
  }, [jobItems, jobsById])

  const filteredItems = useMemo(() => {
    const s = q.trim().toLowerCase()
    if (!s) return items
    return items.filter(i => `${i.sku || ''} ${i.name || ''} ${i.bin || ''} ${i.location || ''}`.toLowerCase().includes(s))
  }, [items, q])

  const filteredJobs = useMemo(() => {
    const s = q.trim().toLowerCase()
    if (!s) return jobs
    return jobs.filter(j => `${j.rego || ''} ${j.vehicle || ''} ${j.customer_name || ''} ${j.job_number || ''}`.toLowerCase().includes(s))
  }, [jobs, q])

  const totalUnits = run ? Number(run.units_total || 0) : 0
  const totalValue = run ? Number(run.value_total || 0) : 0
  const stale = run?.completed_at ? (Date.now() - new Date(run.completed_at).getTime()) / 3600000 : null

  return (
    <div style={{ marginTop: 30 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 10 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: T.text2, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            On cars — not yet off the books
          </h2>
          <div style={{ fontSize: 11, color: T.text3, marginTop: 4, maxWidth: 720, lineHeight: 1.6 }}>
            Parts already fitted to cars in the workshop, on jobs Mechanics Desk hasn&apos;t invoiced yet — so they still
            count as on-hand. <strong style={{ color: T.text2 }}>Your shelf count will be short by this much, and that&apos;s correct.</strong>{' '}
            Cars booked in for later aren&apos;t counted, even if their parts are already picked.
          </div>
        </div>
        {canEdit && (
          <button onClick={refresh} disabled={inFlight}
            style={{
              background: 'none', border: `1px solid ${T.border2}`, borderRadius: 6, color: inFlight ? T.text3 : T.text2,
              fontSize: 12, padding: '7px 12px', cursor: inFlight ? 'default' : 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap',
            }}>
            {inFlight ? 'Checking…' : '↻ Check Mechanics Desk'}
          </button>
        )}
      </div>

      {msg && <div style={{ background: `${T.blue}14`, border: `1px solid ${T.blue}40`, borderRadius: 8, padding: '8px 12px', color: T.blue, fontSize: 12, marginBottom: 10 }}>{msg}</div>}
      {err && <div style={{ background: `${T.red}14`, border: `1px solid ${T.red}40`, borderRadius: 8, padding: '8px 12px', color: T.red, fontSize: 12, marginBottom: 10 }}>{err}</div>}

      {loading ? <SkeletonRows rows={4} /> : !run ? (
        <div style={{ padding: 20, textAlign: 'center', color: T.text3, fontSize: 13, background: T.bg2, borderRadius: 8, border: `1px dashed ${T.border2}` }}>
          {inFlight ? 'Checking Mechanics Desk — this takes a couple of minutes.' : 'No check has been run yet.'}
          {canEdit && !inFlight && <> Press <strong>Check Mechanics Desk</strong> to build the list.</>}
        </div>
      ) : (
        <>
          {/* Totals */}
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
            <Tile label="units on cars" value={n2(totalUnits)} color={T.amber} />
            <Tile label="at cost" value={money(totalValue)} color={T.amber} />
            <Tile label="cars" value={String(run.jobs_count ?? jobs.length)} color={T.blue} />
            <Tile label="part numbers" value={String(run.items_count ?? items.length)} color={T.blue} />
          </div>

          <div style={{ fontSize: 11, color: T.text3, marginBottom: 10 }}>
            Checked {run.completed_at ? new Date(run.completed_at).toLocaleString('en-AU') : '—'}
            {stale != null && stale > 24 && <span style={{ color: T.amber }}> · over a day old, press Check before you rely on it</span>}
            {run.days_swept ? ` · swept ${run.days_swept} days back to ${run.from_date}` : ''}
            {run.days_failed > 0 && (
              <span style={{ color: T.amber }}> · ⚠ {run.days_failed} day(s) didn&apos;t load, so this may be under-reporting — press Check again</span>
            )}
          </div>

          {/* View switch + search */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            {(['parts', 'cars'] as const).map(v => (
              <button key={v} onClick={() => { setView(v); setExpanded(null) }}
                style={{
                  background: view === v ? `${T.blue}1f` : 'none', border: `1px solid ${view === v ? `${T.blue}66` : T.border2}`,
                  borderRadius: 6, color: view === v ? T.blue : T.text3, fontSize: 12, padding: '5px 11px',
                  cursor: 'pointer', fontFamily: 'inherit',
                }}>
                {v === 'parts' ? 'By part' : 'By car'}
              </button>
            ))}
            <input value={q} onChange={e => setQ(e.target.value)}
              placeholder={view === 'parts' ? 'Search SKU, name or bin…' : 'Search rego, vehicle or customer…'}
              style={{ flex: 1, minWidth: 200, background: T.bg2, border: `1px solid ${T.border2}`, borderRadius: 6, color: T.text, fontSize: 12, padding: '6px 10px', fontFamily: 'inherit' }} />
          </div>

          {view === 'parts' ? (
            <ItemTable items={filteredItems} jobsForStock={jobsForStock} expanded={expanded} setExpanded={setExpanded} />
          ) : (
            <JobTable jobs={filteredJobs} jobItems={jobItems} expanded={expanded} setExpanded={setExpanded} />
          )}
        </>
      )}
    </div>
  )
}

function Tile({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{ background: `${color}14`, border: `1px solid ${color}66`, borderRadius: 8, padding: '8px 14px', minWidth: 110 }}>
      <div style={{ fontSize: 18, fontWeight: 600, color: T.text }}>{value}</div>
      <div style={{ fontSize: 10, color: T.text3, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
    </div>
  )
}

const HEAD: React.CSSProperties = {
  padding: '9px 14px', borderBottom: `1px solid ${T.border}`, background: T.bg3, fontSize: 10, color: T.text3,
  textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600,
}

function ItemTable({ items, jobsForStock, expanded, setExpanded }: {
  items: OnCarItem[]
  jobsForStock: Map<number, { job: OnCarJob; qty: number }[]>
  expanded: number | null
  setExpanded: (v: number | null) => void
}) {
  const cols = '1fr 90px 80px 80px 90px 110px'
  if (!items.length) return <Empty>Nothing on a car right now.</Empty>
  return (
    <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 10, overflow: 'hidden' }}>
      <div style={{ display: 'grid', gridTemplateColumns: cols, gap: 12, ...HEAD }}>
        <div>Part</div>
        <div style={{ textAlign: 'right' }}>On cars</div>
        <div style={{ textAlign: 'right' }}>Cars</div>
        <div style={{ textAlign: 'right' }}>MD on-hand</div>
        <div style={{ textAlign: 'right' }}>Should count</div>
        <div>Bin</div>
      </div>
      {items.map(i => {
        const sid = i.md_stock_id ?? -1
        const drill = jobsForStock.get(sid) || []
        const open = expanded === sid
        // What the shelf should physically hold: MD's on-hand less what's on cars.
        const shouldCount = i.on_hand != null ? i.on_hand - i.on_cars : null
        return (
          <div key={`${sid}-${i.sku}`}>
            <div onClick={() => setExpanded(open ? null : sid)}
              style={{ display: 'grid', gridTemplateColumns: cols, gap: 12, padding: '9px 14px', borderBottom: `1px solid ${T.border}`, fontSize: 12, alignItems: 'center', cursor: drill.length ? 'pointer' : 'default' }}>
              <div style={{ overflow: 'hidden' }}>
                <div style={{ color: T.text, fontFamily: 'monospace', fontSize: 11 }}>{i.sku || '—'}</div>
                <div style={{ fontSize: 11, color: T.text3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {drill.length ? (open ? '▾ ' : '▸ ') : ''}{i.name || ''}
                </div>
              </div>
              <div style={{ textAlign: 'right', color: T.amber, fontWeight: 600 }}>{n2(i.on_cars)}</div>
              <div style={{ textAlign: 'right', color: T.text3 }}>{i.jobs_count}</div>
              <div style={{ textAlign: 'right', color: T.text2 }}>{i.on_hand != null ? n2(i.on_hand) : '—'}</div>
              <div style={{ textAlign: 'right', color: T.text, fontWeight: 600 }}>{shouldCount != null ? n2(shouldCount) : '—'}</div>
              <div style={{ color: T.text3, fontSize: 11 }}>{[i.location, i.bin].filter(Boolean).join(' · ') || '—'}</div>
            </div>
            {open && drill.length > 0 && (
              <div style={{ background: T.bg3, borderBottom: `1px solid ${T.border}`, padding: '4px 14px 8px 14px' }}>
                {drill.map(({ job, qty }) => (
                  <div key={job.md_job_id} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '5px 0', fontSize: 11, borderBottom: `1px solid ${T.border}22` }}>
                    <span style={{ color: T.amber, fontWeight: 600, minWidth: 34 }}>{n2(qty)}×</span>
                    <span style={{ color: T.text, fontFamily: 'monospace' }}>{job.rego || '—'}</span>
                    <span style={{ color: T.text2 }}>{job.vehicle || ''}</span>
                    <span style={{ color: T.text3 }}>{job.customer_name || ''}</span>
                    <span style={{ marginLeft: 'auto', color: job.days_open != null && job.days_open > 30 ? T.amber : T.text3 }}>
                      {job.days_open != null ? `${job.days_open}d` : ''}
                    </span>
                    <a href={`${MD_BASE}/auto_workshop/app#/jobs/${job.md_job_id}`} target="_blank" rel="noreferrer"
                      onClick={e => e.stopPropagation()} style={{ color: T.blue, textDecoration: 'none' }}>
                      job {job.job_number || job.md_job_id} ↗
                    </a>
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function JobTable({ jobs, jobItems, expanded, setExpanded }: {
  jobs: OnCarJob[]
  jobItems: OnCarJobItem[]
  expanded: number | null
  setExpanded: (v: number | null) => void
}) {
  const cols = '1fr 150px 80px 90px 90px'
  if (!jobs.length) return <Empty>No cars with parts on them right now.</Empty>
  return (
    <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 10, overflow: 'hidden' }}>
      <div style={{ display: 'grid', gridTemplateColumns: cols, gap: 12, ...HEAD }}>
        <div>Car</div>
        <div>Customer</div>
        <div style={{ textAlign: 'right' }}>Parts</div>
        <div style={{ textAlign: 'right' }}>Units</div>
        <div style={{ textAlign: 'right' }}>Open</div>
      </div>
      {jobs.map(j => {
        const open = expanded === j.md_job_id
        const lines = jobItems.filter(li => li.md_job_id === j.md_job_id).sort((a, b) => b.quantity - a.quantity)
        const oldish = j.days_open != null && j.days_open > 30
        return (
          <div key={j.md_job_id}>
            <div onClick={() => setExpanded(open ? null : j.md_job_id)}
              style={{ display: 'grid', gridTemplateColumns: cols, gap: 12, padding: '9px 14px', borderBottom: `1px solid ${T.border}`, fontSize: 12, alignItems: 'center', cursor: 'pointer' }}>
              <div style={{ overflow: 'hidden' }}>
                <div style={{ color: T.text, fontFamily: 'monospace', fontSize: 11 }}>{open ? '▾ ' : '▸ '}{j.rego || `job ${j.job_number || j.md_job_id}`}</div>
                <div style={{ fontSize: 11, color: T.text3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{j.vehicle || j.description || ''}</div>
              </div>
              <div style={{ color: T.text2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{j.customer_name || '—'}</div>
              <div style={{ textAlign: 'right', color: T.text3 }}>{j.parts_count}</div>
              <div style={{ textAlign: 'right', color: T.amber, fontWeight: 600 }}>{n2(j.parts_qty)}</div>
              <div style={{ textAlign: 'right', color: oldish ? T.amber : T.text3 }}>{j.days_open != null ? `${j.days_open}d` : '—'}</div>
            </div>
            {open && (
              <div style={{ background: T.bg3, borderBottom: `1px solid ${T.border}`, padding: '4px 14px 8px 14px' }}>
                {lines.map(li => (
                  <div key={`${li.md_job_id}-${li.md_stock_id}`} style={{ display: 'flex', gap: 10, padding: '5px 0', fontSize: 11, borderBottom: `1px solid ${T.border}22` }}>
                    <span style={{ color: T.amber, fontWeight: 600, minWidth: 34 }}>{n2(li.quantity)}×</span>
                    <span style={{ color: T.text, fontFamily: 'monospace' }}>{li.sku || '—'}</span>
                  </div>
                ))}
                <div style={{ paddingTop: 6 }}>
                  <a href={`${MD_BASE}/auto_workshop/app#/jobs/${j.md_job_id}`} target="_blank" rel="noreferrer"
                    onClick={e => e.stopPropagation()} style={{ color: T.blue, textDecoration: 'none', fontSize: 11 }}>
                    Open job {j.job_number || j.md_job_id} in Mechanics Desk ↗
                  </a>
                </div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ padding: 20, textAlign: 'center', color: T.text3, fontSize: 13, background: T.bg2, borderRadius: 8, border: `1px dashed ${T.border2}` }}>
      {children}
    </div>
  )
}
