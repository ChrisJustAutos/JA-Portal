// pages/admin/b2b/tune-jobs.tsx — staff-side tune-job management.
// Every Stripe tune receipt ingested from the accounts inbox lands here:
// match unmatched company names to distributors (with a sticky alias),
// dismiss non-jobs, retry failed Monday/letter syncs, and trigger the
// inbox scan / distributor reminders on demand.

import { useEffect, useState } from 'react'
import Head from 'next/head'
import PortalTopBar from '../../../lib/PortalTopBar'
import B2BAdminTabs from '../../../components/b2b/B2BAdminTabs'
import { requirePageAuth } from '../../../lib/authServer'
import { T, alpha } from '../../../lib/ui/theme'
import { useToast } from '../../../components/ui/Feedback'

type JobStatus = 'unmatched' | 'awaiting_details' | 'submitted' | 'synced' | 'dismissed'

interface TuneJob {
  id: string
  status: JobStatus
  company_raw: string | null
  distributor_id: string | null
  distributor_name: string | null
  vin: string | null
  tune_details: string | null
  invoice_number: string | null
  amount: number | null
  email_received_at: string | null
  created_at: string
  invoice_url: string | null
  customer_name: string | null
  sync_error: string | null
}

interface Distributor { id: string; display_name: string }

type Filter = 'all' | JobStatus

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'unmatched', label: 'Unmatched' },
  { id: 'awaiting_details', label: 'Awaiting details' },
  { id: 'submitted', label: 'Submitted' },
  { id: 'synced', label: 'Synced' },
  { id: 'dismissed', label: 'Dismissed' },
]

const STATUS_COLOR: Record<JobStatus, string> = {
  unmatched: T.amber,
  awaiting_details: T.blue,
  submitted: T.teal,
  synced: T.green,
  dismissed: T.text3 as string,
}

const STATUS_LABEL: Record<JobStatus, string> = {
  unmatched: 'Unmatched',
  awaiting_details: 'Awaiting details',
  submitted: 'Submitted',
  synced: 'Synced',
  dismissed: 'Dismissed',
}

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' })
}

export default function TuneJobsAdmin({ user }: { user: any }) {
  const toast = useToast()
  const [jobs, setJobs] = useState<TuneJob[]>([])
  const [distributors, setDistributors] = useState<Distributor[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [distFilter, setDistFilter] = useState<string>('all')  // 'all' | 'unmatched' | distributor id
  const [busy, setBusy] = useState('')            // 'scan' | 'remind' | job id
  // Per-row assign state (unmatched rows)
  const [assignSel, setAssignSel] = useState<Record<string, string>>({})
  const [assignRemember, setAssignRemember] = useState<Record<string, boolean>>({})

  async function load() {
    try {
      const r = await fetch('/api/b2b/admin/tune-jobs')
      const d = await r.json()
      if (!r.ok || d.error) throw new Error(d.error || `HTTP ${r.status}`)
      setJobs(d.jobs || [])
      setDistributors(d.distributors || [])
      setError('')
    } catch (e: any) {
      setError(e.message || 'Load failed')
    }
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  async function post(body: any): Promise<any> {
    const r = await fetch('/api/b2b/admin/tune-jobs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    const d = await r.json()
    if (!r.ok || d.error) throw new Error(d.error || `HTTP ${r.status}`)
    return d
  }

  const [backfillProgress, setBackfillProgress] = useState('')
  // Month-by-month backfill: the mailbox read is capped at the newest ~500
  // messages per window, and the Payments folder holds far more than tune
  // receipts — a single since-January window can never reach past that
  // horizon. Explicit month windows guarantee full coverage; within each
  // month, passes repeat (15 new jobs each) until the month is drained.
  async function backfillSinceJan() {
    setBusy('backfill')
    let total = 0, matched = 0
    const now = new Date()
    const months: Array<{ label: string; since: string; until: string }> = []
    for (let m = 0; ; m++) {
      const start = new Date(Date.UTC(2026, m, 1))
      if (start.getTime() > now.getTime()) break
      const end = new Date(Date.UTC(2026, m + 1, 1))
      months.push({ label: start.toLocaleDateString('en-AU', { month: 'short', year: 'numeric', timeZone: 'UTC' }), since: start.toISOString(), until: end.toISOString() })
    }
    try {
      for (const mo of months) {
        for (let pass = 0; pass < 15; pass++) {
          setBackfillProgress(`${mo.label} — ${total} jobs so far`)
          const d = await post({ action: 'ingest_now', since: mo.since, until: mo.until })
          total += d.created ?? 0
          matched += d.matched ?? 0
          if (!(d.created > 0)) break
        }
        await load().catch(() => {})
      }
      toast(`Backfill complete — ${total} tune job${total === 1 ? '' : 's'} ingested since 1 Jan (${matched} auto-matched).`, 'success')
    } catch (e: any) {
      toast(`Backfill stopped after ${total} jobs: ${e.message || e}`, 'error')
    }
    setBackfillProgress('')
    await load().catch(() => {})
    setBusy('')
  }

  async function scanNow() {
    setBusy('scan')
    try {
      const d = await post({ action: 'ingest_now', lookback_days: 14 })
      const errs = Array.isArray(d.errors) ? d.errors.length : 0
      toast(
        `Scanned ${d.scanned ?? 0} email${d.scanned === 1 ? '' : 's'} — ${d.created ?? 0} new, ${d.matched ?? 0} matched, ${d.skipped ?? 0} skipped${errs ? `, ${errs} error${errs === 1 ? '' : 's'}` : ''}.`,
        errs ? 'error' : 'success',
      )
      await load()
    } catch (e: any) {
      toast(e.message || 'Scan failed', 'error')
      // Jobs created before a timeout are real — show whatever landed.
      await load().catch(() => {})
    }
    setBusy('')
  }

  async function remindNow() {
    setBusy('remind')
    try {
      const d = await post({ action: 'remind_now' })
      toast(`Reminders sent — ${d.distributors ?? 0} distributor${d.distributors === 1 ? '' : 's'}, ${d.jobs ?? 0} job${d.jobs === 1 ? '' : 's'}.`, 'success')
      await load()
    } catch (e: any) { toast(e.message || 'Reminders failed', 'error') }
    setBusy('')
  }

  async function assign(job: TuneJob) {
    const distId = assignSel[job.id]
    if (!distId) { toast('Pick a distributor first.', 'error'); return }
    setBusy(job.id)
    try {
      const d = await post({ action: 'assign', job_id: job.id, distributor_id: distId, save_alias: assignRemember[job.id] !== false })
      const n = Number(d.matched_jobs || 1)
      toast(n > 1 ? `Assigned — matched ${n} jobs with this payer name.` : 'Assigned.', 'success')
      await load()
    } catch (e: any) { toast(e.message || 'Assign failed', 'error') }
    setBusy('')
  }

  async function dismiss(job: TuneJob) {
    setBusy(job.id)
    try {
      const d = await post({ action: 'dismiss', job_id: job.id })
      const n = Number(d.dismissed_jobs || 1)
      toast(d.excluded_name
        ? `Dismissed${n > 1 ? ` ${n} jobs` : ''} — "${d.excluded_name}" is now excluded from future scans.`
        : 'Dismissed.', 'success')
      await load()
    } catch (e: any) { toast(e.message || 'Dismiss failed', 'error') }
    setBusy('')
  }

  async function retrySync(job: TuneJob) {
    setBusy(job.id)
    try {
      await post({ action: 'retry_sync', job_id: job.id })
      toast('Sync retried.', 'success')
      await load()
    } catch (e: any) { toast(e.message || 'Retry failed', 'error') }
    setBusy('')
  }

  const byStatus = filter === 'all' ? jobs : jobs.filter(j => j.status === filter)
  const visible = distFilter === 'all' ? byStatus
    : distFilter === 'unmatched' ? byStatus.filter(j => !j.distributor_id)
    : byStatus.filter(j => j.distributor_id === distFilter)
  // Only offer distributors that actually have jobs, with their counts.
  const distCounts = new Map<string, number>()
  for (const j of jobs) if (j.distributor_id) distCounts.set(j.distributor_id, (distCounts.get(j.distributor_id) || 0) + 1)

  const btn: React.CSSProperties = {
    fontSize: 12, fontWeight: 600, padding: '7px 14px', borderRadius: 7,
    border: `1px solid ${T.border2}`, background: 'transparent', color: T.text2,
    cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap',
  }
  const smallBtn: React.CSSProperties = { ...btn, padding: '5px 10px', fontSize: 11 }

  return (
    <>
      <Head><title>Tune Jobs — Just Autos</title><meta name="robots" content="noindex,nofollow" /></Head>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden', fontFamily: "'DM Sans',system-ui,sans-serif", background: T.bg, color: T.text }}>
        <PortalTopBar activeId="b2b" currentUserRole={user.role} currentUserVisibleTabs={user.visibleTabs} currentUserName={user.displayName} currentUserEmail={user.email} />
        <B2BAdminTabs active="tune_jobs" />
        <div style={{ flex: 1, overflowY: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 1400 }}>

          {/* Toolbar */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <button
              onClick={async () => {
                setBusy('testjob')
                try {
                  const d = await post({ action: 'create_test_job' })
                  await navigator.clipboard.writeText(d.url)
                  toast('Test job created — fill link copied. Enter made-up customer details there, then run the MD worker.', 'success')
                  await load()
                } catch (e: any) { toast(e.message || 'Test job failed', 'error') }
                setBusy('')
              }}
              disabled={busy !== ''}
              style={{ padding: '7px 14px', borderRadius: 6, border: `1px solid ${T.border}`, background: T.bg3, color: T.text2, fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' }}>
              {busy === 'testjob' ? 'Creating…' : '🧪 Create test job'}
            </button>
            {jobs.some(j => j.company_raw === 'JA PORTAL TEST') && (
              <button
                onClick={async () => {
                  setBusy('deltest')
                  try {
                    const d = await post({ action: 'delete_test_jobs' })
                    toast(`Deleted ${d.deleted ?? 0} test job${d.deleted === 1 ? '' : 's'}.`, 'success')
                    await load()
                  } catch (e: any) { toast(e.message || 'Delete failed', 'error') }
                  setBusy('')
                }}
                disabled={busy !== ''}
                style={{ padding: '7px 14px', borderRadius: 6, border: `1px solid ${T.red}50`, background: 'transparent', color: T.red, fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' }}>
                {busy === 'deltest' ? 'Deleting…' : '🗑 Delete test jobs'}
              </button>
            )}
            <button onClick={backfillSinceJan} disabled={busy !== ''}
              style={{ padding: '7px 14px', borderRadius: 6, border: `1px solid ${T.border}`, background: T.bg3, color: T.text2, fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' }}>
              {busy === 'backfill' ? `Backfilling… ${backfillProgress}` : 'Backfill since 1 Jan'}
            </button>
            <button onClick={scanNow} disabled={busy === 'scan'}
              style={{ ...btn, border: `1px solid ${T.blue}`, background: T.blue, color: '#fff', opacity: busy === 'scan' ? 0.6 : 1 }}>
              {busy === 'scan' ? 'Scanning…' : 'Scan inbox now'}
            </button>
            <button onClick={remindNow} disabled={busy === 'remind'} style={{ ...btn, opacity: busy === 'remind' ? 0.6 : 1 }}>
              {busy === 'remind' ? 'Sending…' : 'Send reminders now'}
            </button>
            <span style={{ flex: 1 }} />
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {FILTERS.map(f => {
                const on = filter === f.id
                const count = f.id === 'all' ? jobs.length : jobs.filter(j => j.status === f.id).length
                return (
                  <button key={f.id} onClick={() => setFilter(f.id)}
                    style={{
                      fontSize: 11.5, fontWeight: on ? 700 : 500, padding: '5px 11px', borderRadius: 14,
                      border: `1px solid ${on ? T.blue : T.border2}`,
                      background: on ? `${T.blue}18` : 'transparent',
                      color: on ? T.blue : T.text2, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap',
                    }}>
                    {f.label} <span style={{ opacity: 0.7 }}>({count})</span>
                  </button>
                )
              })}
              <select value={distFilter} onChange={e => setDistFilter(e.target.value)}
                title="Filter by distributor"
                style={{
                  fontSize: 11.5, fontWeight: distFilter === 'all' ? 500 : 700, padding: '4px 8px', borderRadius: 14,
                  border: `1px solid ${distFilter === 'all' ? T.border2 : T.blue}`,
                  background: distFilter === 'all' ? 'transparent' : `${T.blue}18`,
                  color: distFilter === 'all' ? T.text2 : T.blue, cursor: 'pointer', fontFamily: 'inherit', maxWidth: 220,
                }}>
                <option value="all">All distributors</option>
                {distributors.filter(d => distCounts.has(d.id)).map(d => (
                  <option key={d.id} value={d.id}>{d.display_name} ({distCounts.get(d.id)})</option>
                ))}
              </select>
              {distFilter !== 'all' && distFilter !== 'unmatched' && (
                <button
                  onClick={async () => {
                    try {
                      const d = await post({ action: 'fill_link', distributor_id: distFilter })
                      await navigator.clipboard.writeText(d.url)
                      toast('Fill link copied — valid 14 days, opens this distributor’s jobs only.', 'success')
                    } catch (e: any) { toast(e.message || 'Link failed', 'error') }
                  }}
                  style={{ fontSize: 11.5, padding: '5px 11px', borderRadius: 14, border: `1px solid ${T.border2}`, background: 'transparent', color: T.text2, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' }}>
                  🔗 Copy fill link
                </button>
              )}
            </div>
          </div>

          {error && <div style={{ background: 'rgba(240,78,78,0.1)', border: `1px solid ${T.red}40`, borderRadius: 8, padding: 12, color: T.red, fontSize: 13 }}>{error}</div>}
          {loading && <div style={{ color: T.text3, textAlign: 'center', padding: 30 }}>Loading…</div>}
          {!loading && visible.length === 0 && !error && (
            <div style={{ color: T.text3, textAlign: 'center', padding: 30, fontStyle: 'italic' }}>
              {filter === 'all' ? 'No tune jobs yet — “Scan inbox now” pulls in recent receipts.' : 'Nothing with this status.'}
            </div>
          )}

          {!loading && visible.length > 0 && (
            <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 10, overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 1000 }}>
                <thead>
                  <tr style={{ background: T.bg3, borderBottom: `1px solid ${T.border2}` }}>
                    <Th>Received</Th>
                    <Th>Company (raw)</Th>
                    <Th>Distributor</Th>
                    <Th>VIN</Th>
                    <Th>Tune</Th>
                    <Th align="right">Amount</Th>
                    <Th>Status</Th>
                    <Th>Sync error</Th>
                    <Th>Invoice</Th>
                    <Th>Customer</Th>
                    <Th />
                  </tr>
                </thead>
                <tbody>
                  {visible.map(j => (
                    <tr key={j.id} style={{ borderBottom: `1px solid ${T.border}` }}>
                      <Td muted>{formatDate(j.email_received_at || j.created_at)}</Td>
                      <Td>{j.company_raw || '—'}</Td>
                      <Td>
                        {j.distributor_name
                          ? j.distributor_name
                          : j.status === 'unmatched'
                            ? <span style={{ color: T.amber, fontWeight: 700, fontSize: 11 }}>UNMATCHED</span>
                            : <span style={{ color: T.text3 }}>—</span>}
                      </Td>
                      <Td><span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>{j.vin || '—'}</span></Td>
                      <Td muted>{j.tune_details || '—'}</Td>
                      <Td align="right">{j.amount != null ? `$${Number(j.amount).toFixed(2)}` : '—'}</Td>
                      <Td>
                        <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 8, background: alpha(STATUS_COLOR[j.status], '18'), color: STATUS_COLOR[j.status], whiteSpace: 'nowrap' }}>
                          {STATUS_LABEL[j.status] || j.status}
                        </span>
                      </Td>
                      <Td>
                        {j.sync_error
                          ? <span title={j.sync_error} style={{ color: T.red, fontSize: 11, display: 'inline-block', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'bottom' }}>{j.sync_error}</span>
                          : <span style={{ color: T.text3 }}>—</span>}
                      </Td>
                      <Td>
                        {j.invoice_url
                          ? <a href={j.invoice_url} target="_blank" rel="noreferrer" style={{ color: T.blue, textDecoration: 'none', fontSize: 12 }}>View ↗</a>
                          : <span style={{ color: T.text3 }}>—</span>}
                      </Td>
                      <Td muted>{j.customer_name || '—'}</Td>
                      <Td>
                        {j.status === 'unmatched' && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                            <select value={assignSel[j.id] || ''} onChange={e => setAssignSel(s => ({ ...s, [j.id]: e.target.value }))}
                              style={{ fontSize: 11, padding: '4px 6px', borderRadius: 6, border: `1px solid ${T.border2}`, background: T.bg3, color: T.text, fontFamily: 'inherit', maxWidth: 160 }}>
                              <option value="">Distributor…</option>
                              {distributors.map(d => <option key={d.id} value={d.id}>{d.display_name}</option>)}
                            </select>
                            <label style={{ fontSize: 10.5, color: T.text2, display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', whiteSpace: 'nowrap' }}>
                              <input type="checkbox" checked={assignRemember[j.id] !== false} onChange={e => setAssignRemember(s => ({ ...s, [j.id]: e.target.checked }))} />
                              remember this name
                            </label>
                            <button onClick={() => assign(j)} disabled={busy === j.id}
                              style={{ ...smallBtn, border: `1px solid ${T.blue}`, color: T.blue, opacity: busy === j.id ? 0.6 : 1 }}>
                              Assign
                            </button>
                            <button onClick={() => dismiss(j)} disabled={busy === j.id}
                              style={{ ...smallBtn, color: T.red, borderColor: `${T.red}60`, opacity: busy === j.id ? 0.6 : 1 }}>
                              Dismiss
                            </button>
                          </div>
                        )}
                        {j.sync_error && (
                          <button onClick={() => retrySync(j)} disabled={busy === j.id}
                            style={{ ...smallBtn, border: `1px solid ${T.amber}`, color: T.amber, opacity: busy === j.id ? 0.6 : 1, marginTop: j.status === 'unmatched' ? 6 : 0 }}>
                            Retry sync
                          </button>
                        )}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </>
  )
}

function Th({ children, align }: { children?: React.ReactNode; align?: 'left' | 'right' }) {
  return (
    <th style={{ textAlign: align || 'left', fontSize: 10, fontWeight: 500, color: T.text3, textTransform: 'uppercase', letterSpacing: '0.06em', padding: '10px 12px', whiteSpace: 'nowrap' }}>
      {children}
    </th>
  )
}

function Td({ children, align, muted }: { children?: React.ReactNode; align?: 'left' | 'right'; muted?: boolean }) {
  return (
    <td style={{ textAlign: align || 'left', fontSize: 13, color: muted ? T.text2 : T.text, padding: '10px 12px', fontVariantNumeric: align === 'right' ? 'tabular-nums' : undefined }}>
      {children}
    </td>
  )
}

export async function getServerSideProps(context: any) {
  return requirePageAuth(context, 'edit:b2b_distributors')
}
