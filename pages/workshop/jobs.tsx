// pages/workshop/jobs.tsx
// Jobs — a searchable, status-filterable list of every job (workshop_bookings),
// on its own roomy page; plus a Job types sub-tab (the preset manager) so both
// live together away from the cramped Settings panel.

import { useCallback, useEffect, useState } from 'react'
import Head from 'next/head'
import { useRouter } from 'next/router'
import PortalTopBar from '../../lib/PortalTopBar'
import WorkshopTabs from '../../components/WorkshopTabs'
import JobTypesManager from '../../components/workshop/JobTypesManager'
import { requirePageAuth } from '../../lib/authServer'
import type { PortalUserSSR } from '../../lib/authServer'
import { BOOKING_STATUS_META, BookingStatus, vehicleLabel } from '../../lib/workshop'
import { T } from '../../components/ui'

const money = (n: number | null | undefined) => n == null ? '' : `$${(Number(n) || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
function bneDateTime(iso: string): string {
  try { return new Date(iso).toLocaleString('en-AU', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Australia/Brisbane' }) } catch { return iso }
}

const STATUS_KEYS = Object.keys(BOOKING_STATUS_META) as BookingStatus[]
const GRID = '150px 1fr 1fr 130px 120px 90px'

export default function WorkshopJobsPage({ user }: { user: PortalUserSSR }) {
  const router = useRouter()
  const [sub, setSub] = useState<'jobs' | 'types'>('jobs')
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('all')
  const [jobs, setJobs] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const p = new URLSearchParams({ status, limit: '200' })
      if (q.trim()) p.set('q', q.trim())
      const r = await fetch(`/api/workshop/jobs?${p.toString()}`)
      const d = await r.json()
      if (r.ok) setJobs(d.jobs || [])
      setLastRefresh(new Date())
    } catch { /* keep prior */ } finally { setLoading(false) }
  }, [q, status])
  useEffect(() => { if (sub !== 'jobs') return; const t = setTimeout(load, 200); return () => clearTimeout(t) }, [load, sub])

  return (
    <>
      <Head><title>Jobs — Just Autos</title><meta name="viewport" content="width=device-width,initial-scale=1" /><meta name="robots" content="noindex,nofollow" /></Head>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden', fontFamily: "'DM Sans',system-ui,sans-serif", color: T.text }}>
        <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet" />
        <PortalTopBar activeId="diary" lastRefresh={lastRefresh} onRefresh={load} refreshing={loading}
          currentUserRole={user.role} currentUserVisibleTabs={user.visibleTabs} currentUserName={user.displayName} currentUserEmail={user.email} />
        <WorkshopTabs active="jobs" role={user.role} />

        {/* Sub-tabs */}
        <div style={{ display: 'flex', gap: 4, padding: '0 20px', background: T.bg2, borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
          {([['jobs', 'All jobs'], ['types', 'Job types']] as const).map(([id, label]) => {
            const on = sub === id
            return <button key={id} onClick={() => setSub(id)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', color: on ? T.text : T.text2, fontSize: 12.5, fontWeight: on ? 600 : 400, padding: '10px 12px', borderBottom: `2px solid ${on ? T.accent : 'transparent'}` }}>{label}</button>
          })}
        </div>

        <div style={{ flex: 1, overflow: 'auto', background: T.bg }}>
          {sub === 'types' ? (
            <div style={{ margin: '0 auto', padding: '20px 28px' }}><JobTypesManager /></div>
          ) : (
            <div style={{ margin: '0 auto', padding: '18px 28px' }}>
              {/* Toolbar */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
                <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search customer, rego, vehicle, job type…"
                  style={{ width: 320, padding: '8px 11px', background: T.bg3, border: `1px solid ${T.border}`, borderRadius: 6, color: T.text, fontSize: 13, fontFamily: 'inherit', outline: 'none' }} />
                <select value={status} onChange={e => setStatus(e.target.value)} style={{ padding: '8px 10px', background: T.bg3, border: `1px solid ${T.border}`, borderRadius: 6, color: T.text, fontSize: 12.5, fontFamily: 'inherit' }}>
                  <option value="all">All statuses</option>
                  {STATUS_KEYS.map(s => <option key={s} value={s}>{BOOKING_STATUS_META[s]?.label || s}</option>)}
                </select>
                <span style={{ flex: 1 }} />
                <span style={{ fontSize: 11, color: T.text3 }}>{loading ? 'Loading…' : `${jobs.length} job${jobs.length === 1 ? '' : 's'}`}{jobs.length >= 200 ? ' (showing first 200 — narrow your search)' : ''}</span>
              </div>

              {/* Status quick chips */}
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
                <Chip label="All" active={status === 'all'} onClick={() => setStatus('all')} color={T.text2} />
                {STATUS_KEYS.map(s => <Chip key={s} label={BOOKING_STATUS_META[s]?.label || s} active={status === s} onClick={() => setStatus(s)} color={BOOKING_STATUS_META[s]?.color || T.text2} />)}
              </div>

              <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 10, overflow: 'hidden' }}>
                <div style={{ display: 'grid', gridTemplateColumns: GRID, gap: 10, padding: '9px 16px', background: T.bg3, borderBottom: `1px solid ${T.border}`, fontSize: 9, color: T.text3, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  <div>When</div><div>Customer</div><div>Vehicle</div><div>Job type</div><div>Status</div><div style={{ textAlign: 'right' }}>Total</div>
                </div>
                {!loading && jobs.length === 0 && <div style={{ padding: 40, textAlign: 'center', color: T.text3, fontSize: 13 }}>No jobs{q ? ' match your search' : ''}.</div>}
                {jobs.map(j => {
                  const meta = BOOKING_STATUS_META[j.status as BookingStatus] || { label: j.status, color: T.text3 }
                  const cust = Array.isArray(j.customer) ? j.customer[0] : j.customer
                  const veh = Array.isArray(j.vehicle) ? j.vehicle[0] : j.vehicle
                  const amount = Number(j.total_inc_gst) || Number(j.estimated_value) || 0
                  return (
                    <div key={j.id} onClick={() => router.push(`/workshop/job/${j.id}`)} style={{ display: 'grid', gridTemplateColumns: GRID, gap: 10, padding: '10px 16px', borderTop: `1px solid ${T.border}`, alignItems: 'center', cursor: 'pointer', fontSize: 12.5 }}>
                      <div style={{ fontFamily: 'monospace', fontSize: 11, color: T.text2 }}>{bneDateTime(j.starts_at)}</div>
                      <div style={{ color: T.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{cust?.name || '—'}</div>
                      <div style={{ color: T.text2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{veh ? vehicleLabel(veh) : '—'}</div>
                      <div style={{ color: T.text3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{j.job_type || '—'}</div>
                      <div><span style={{ fontSize: 10, fontWeight: 700, color: meta.color, background: `${meta.color}1e`, padding: '2px 8px', borderRadius: 4, textTransform: 'uppercase' }}>{meta.label}</span></div>
                      <div style={{ textAlign: 'right', fontFamily: 'monospace', color: T.text2 }}>{amount ? money(amount) : '—'}</div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  )
}

function Chip({ label, active, onClick, color }: { label: string; active: boolean; onClick: () => void; color: string }) {
  return (
    <button onClick={onClick} style={{
      padding: '4px 11px', borderRadius: 20, fontSize: 11.5, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer',
      background: active ? `${color}22` : 'transparent', color: active ? color : T.text2,
      border: `1px solid ${active ? color : T.border2}`,
    }}>{label}</button>
  )
}

export async function getServerSideProps(context: any) {
  return requirePageAuth(context, 'view:diary')
}
