// pages/admin/b2b/tune-jobs.tsx — staff-side tune-job management.
// Every Stripe tune receipt ingested from the accounts inbox lands here:
// match unmatched company names to distributors (with a sticky alias),
// dismiss non-jobs, retry failed Monday/letter syncs, and trigger the
// inbox scan / distributor reminders on demand.
//
// Alloy restyle 2026-08-12: kit pills/cards/banners; teal retired — status
// colours map onto the semantic A set (in motion = accent, done = good).

import { Fragment, useEffect, useState } from 'react'
import Head from 'next/head'
import PortalTopBar from '../../../lib/PortalTopBar'
import B2BAdminTabs from '../../../components/b2b/B2BAdminTabs'
import { requirePageAuth } from '../../../lib/authServer'
import { T, alpha } from '../../../lib/ui/theme'
import { useToast } from '../../../components/ui/Feedback'
import { A, RADIUS, Btn, btnStyle, cardStyle, Banner, StatusPill, EmptyState } from '../../../components/b2b/ui'

type JobStatus = 'unmatched' | 'awaiting_details' | 'submitted' | 'synced' | 'dismissed' | 'merged'

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
  // Full submission (shown in the expanded row)
  customer_first_name: string | null
  customer_phone: string | null
  customer_email: string | null
  customer_address_line1: string | null
  customer_suburb: string | null
  customer_state: string | null
  customer_postcode: string | null
  vehicle_rego: string | null
  vehicle_make: string | null
  vehicle_model: string | null
  vehicle_year: string | null
  vehicle_description: string | null
  job_notes: string | null
  filled_at: string | null
  monday_item_id: string | null
  md_customer_md_id: string | null
  md_synced_at: string | null
  md_resync_pending: boolean | null
  admin_edited_at: string | null
  letter_queued_at: string | null
  synced_at: string | null
}

// The fields staff can correct after a distributor's submission.
const EDIT_FIELDS: Array<{ key: keyof TuneJob; label: string; width?: number; textarea?: boolean }> = [
  { key: 'customer_name', label: 'Customer name (first & last)' },
  { key: 'customer_phone', label: 'Phone' },
  { key: 'customer_email', label: 'Email' },
  { key: 'customer_address_line1', label: 'Street address' },
  { key: 'customer_suburb', label: 'Suburb' },
  { key: 'customer_state', label: 'State', width: 90 },
  { key: 'customer_postcode', label: 'Postcode', width: 110 },
  { key: 'vehicle_rego', label: 'Rego', width: 120 },
  { key: 'vehicle_make', label: 'Make' },
  { key: 'vehicle_model', label: 'Model' },
  { key: 'vehicle_year', label: 'Year', width: 90 },
  { key: 'vin', label: 'VIN' },
  { key: 'tune_details', label: 'Tune / calibration' },
  { key: 'job_notes', label: 'Package details', textarea: true },
]

// Monday follow-up board (lib/b2b-tune-jobs TUNE_FOLLOWUP_BOARD) — for the
// "open in Monday" link on expanded rows.
const MONDAY_FOLLOWUP_BOARD_URL = 'https://just-autos.monday.com/boards/5030245210/pulses'

interface Distributor { id: string; display_name: string }

type Filter = 'all' | JobStatus

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'unmatched', label: 'Unmatched' },
  { id: 'awaiting_details', label: 'Awaiting details' },
  { id: 'submitted', label: 'Submitted' },
  { id: 'synced', label: 'Synced' },
  { id: 'dismissed', label: 'Dismissed' },
  // no 'merged' chip: merged receipt rows are folded into their primary job
  // and the API no longer returns them — one tune shows as ONE job.
]

// amber = needs staff attention, accent = in motion (with the distributor /
// syncing), green = landed, grey = closed. Teal retired with the Alloy refresh.
const STATUS_COLOR: Record<JobStatus, string> = {
  unmatched: A.warn,
  awaiting_details: A.accent,
  submitted: A.accent,
  synced: A.good,
  dismissed: T.text3 as string,
  merged: T.text3 as string,
}

const STATUS_LABEL: Record<JobStatus, string> = {
  unmatched: 'Unmatched',
  awaiting_details: 'Awaiting details',
  submitted: 'Submitted',
  synced: 'Synced',
  dismissed: 'Dismissed',
  merged: 'Merged (same VIN)',
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
  const [expanded, setExpanded] = useState<string | null>(null)  // job id with detail open
  // Per-row assign state (unmatched rows)
  const [assignSel, setAssignSel] = useState<Record<string, string>>({})
  const [assignRemember, setAssignRemember] = useState<Record<string, boolean>>({})
  // Edit-details modal (staff corrections to a distributor's submission)
  const [editJob, setEditJob] = useState<TuneJob | null>(null)
  const [editForm, setEditForm] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  function openEdit(job: TuneJob) {
    const form: Record<string, string> = {}
    for (const f of EDIT_FIELDS) form[f.key as string] = String(job[f.key] ?? '')
    setEditForm(form)
    setEditJob(job)
  }

  async function saveEdit() {
    if (!editJob) return
    const name = (editForm.customer_name || '').trim().replace(/\s+/g, ' ')
    if (name.split(' ').length < 2) { toast('Customer name needs first AND last name.', 'error'); return }
    const digits = (editForm.customer_phone || '').replace(/\D/g, '')
    if (!((digits.length === 10 && digits.startsWith('0')) || (digits.length === 11 && digits.startsWith('61')))) {
      toast('Phone must be a full AU number (10 digits, e.g. 0400 123 456).', 'error'); return
    }
    setSaving(true)
    try {
      const d = await post({ action: 'edit_details', job_id: editJob.id, fields: editForm })
      if (!d.changed?.length) {
        toast('No changes to save.', 'info')
      } else {
        const bits = [`Saved (${d.changed.join(', ')}).`]
        bits.push(d.mondayUpdated ? 'Monday item updated.' : (editJob.monday_item_id ? 'Monday update FAILED — see sync error.' : ''))
        if (d.mdResyncQueued) bits.push('MechanicDesk correction queued for tonight’s 2:30am worker.')
        if (d.letterNote) bits.push(d.letterNote)
        toast(bits.filter(Boolean).join(' '), d.mondayUpdated || !editJob.monday_item_id ? 'success' : 'error')
      }
      setEditJob(null)
      await load()
    } catch (e: any) { toast(e.message || 'Save failed', 'error') }
    setSaving(false)
  }

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

  // "Backfill since 1 Jan" + "Scan inbox now" buttons removed 2026-08-11
  // (Chris: not needed) — the backfill was the one-time historical import and
  // the hourly cron scans the inbox; the ingest_now API action remains for
  // emergencies.
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

  return (
    <>
      <Head><title>Tune Jobs — Just Autos</title><meta name="robots" content="noindex,nofollow" /></Head>
      {/* Normal page scroll (minHeight, NOT height + overflow:hidden) — the
          flex min-height:auto trap killed scrolling here, exactly as it did on
          the Training page. b2b-admin-main also brings the shared mobile CSS,
          so the wide job table scrolls sideways on a phone instead of
          stretching the page. */}
      <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh', fontFamily: "'DM Sans',system-ui,sans-serif", background: T.bg, color: T.text }}>
        <PortalTopBar activeId="b2b" currentUserRole={user.role} currentUserVisibleTabs={user.visibleTabs} currentUserName={user.displayName} currentUserEmail={user.email} />
        <main className="b2b-admin-main" style={{ flex: 1, padding: '20px 20px 40px', width: '100%', boxSizing: 'border-box' }}>
        <B2BAdminTabs active="tune_jobs" />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 1400 }}>

          {/* Toolbar — test-job create/delete buttons removed 2026-08-11
              (Chris: not needed); the API actions remain for emergencies. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <Btn variant="secondary" size="sm" onClick={remindNow} disabled={busy === 'remind'}>
              {busy === 'remind' ? 'Sending…' : 'Send reminders now'}
            </Btn>
            <span style={{ flex: 1 }} />
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
              {FILTERS.map(f => {
                const on = filter === f.id
                const count = f.id === 'all' ? jobs.length : jobs.filter(j => j.status === f.id).length
                return (
                  <button key={f.id} onClick={() => setFilter(f.id)} className="al-press al-focus"
                    style={{
                      fontSize: 12, fontWeight: on ? 700 : 500, padding: '5px 12px', borderRadius: RADIUS.pill,
                      border: '1px solid transparent',
                      background: on ? alpha(A.accent, '18') : 'transparent',
                      color: on ? A.accent : T.text2, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap',
                    }}>
                    {f.label} <span style={{ opacity: 0.7 }}>({count})</span>
                  </button>
                )
              })}
              <select value={distFilter} onChange={e => setDistFilter(e.target.value)}
                title="Filter by distributor"
                style={{
                  fontSize: 12, fontWeight: distFilter === 'all' ? 500 : 700, padding: '5px 8px', borderRadius: RADIUS.pill,
                  border: '1px solid transparent',
                  background: distFilter === 'all' ? T.bg3 : alpha(A.accent, '18'),
                  color: distFilter === 'all' ? T.text2 : A.accent, cursor: 'pointer', fontFamily: 'inherit', maxWidth: 220, outline: 'none',
                }}>
                <option value="all">All distributors</option>
                {distributors.filter(d => distCounts.has(d.id)).map(d => (
                  <option key={d.id} value={d.id}>{d.display_name} ({distCounts.get(d.id)})</option>
                ))}
              </select>
              {distFilter !== 'all' && distFilter !== 'unmatched' && (
                <Btn variant="ghost" size="sm"
                  onClick={async () => {
                    try {
                      const d = await post({ action: 'fill_link', distributor_id: distFilter })
                      await navigator.clipboard.writeText(d.url)
                      toast('Fill link copied — valid 14 days, opens this distributor’s jobs only.', 'success')
                    } catch (e: any) { toast(e.message || 'Link failed', 'error') }
                  }}>
                  Copy fill link
                </Btn>
              )}
              {distFilter !== 'all' && distFilter !== 'unmatched' && (
                <Btn variant="ghost" size="sm"
                  onClick={async () => {
                    try {
                      const d = await post({ action: 'preview_link', distributor_id: distFilter })
                      await navigator.clipboard.writeText(d.url)
                      toast('Portal preview link copied — read-only, valid 24h. Open in a private window for your Scribe.', 'success')
                    } catch (e: any) { toast(e.message || 'Link failed', 'error') }
                  }}>
                  Copy preview link
                </Btn>
              )}
            </div>
          </div>

          {error && <Banner tone="error" onDismiss={() => setError('')}>{error}</Banner>}
          {loading && <div style={{ color: T.text3, textAlign: 'center', padding: 30 }}>Loading…</div>}
          {!loading && visible.length === 0 && !error && (
            <EmptyState
              title={filter === 'all' ? 'No tune jobs yet' : 'Nothing with this status'}
              sub={filter === 'all' ? 'The hourly inbox scan pulls in new receipts.' : undefined} />
          )}

          {!loading && visible.length > 0 && (
            <div style={{ ...cardStyle(false), overflowX: 'auto' }}>
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
                    <Fragment key={j.id}>
                    <tr
                      onClick={e => {
                        // Row click opens the detail — unless the click was on
                        // an interactive element (links, assign controls, retry).
                        if ((e.target as HTMLElement).closest('a,button,select,input,label')) return
                        setExpanded(x => x === j.id ? null : j.id)
                      }}
                      style={{ borderBottom: `1px solid ${T.border}`, cursor: 'pointer', background: expanded === j.id ? T.bg3 : undefined }}>
                      <Td muted>{formatDate(j.email_received_at || j.created_at)}</Td>
                      <Td>{j.company_raw || '—'}</Td>
                      <Td>
                        {j.distributor_name
                          ? j.distributor_name
                          : j.status === 'unmatched'
                            ? <span style={{ color: A.warn, fontWeight: 700, fontSize: 12 }}>Unmatched</span>
                            : <span style={{ color: T.text3 }}>—</span>}
                      </Td>
                      <Td><span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>{j.vin || '—'}</span></Td>
                      <Td muted>{j.tune_details || '—'}</Td>
                      <Td align="right">{j.amount != null ? `$${Number(j.amount).toFixed(2)}` : '—'}</Td>
                      <Td>
                        <StatusPill color={STATUS_COLOR[j.status]}>{STATUS_LABEL[j.status] || j.status}</StatusPill>
                      </Td>
                      <Td>
                        {j.sync_error
                          ? <span title={j.sync_error} style={{ color: A.bad, fontSize: 12, display: 'inline-block', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'bottom' }}>{j.sync_error}</span>
                          : <span style={{ color: T.text3 }}>—</span>}
                      </Td>
                      <Td>
                        {j.invoice_url
                          ? <a href={j.invoice_url} target="_blank" rel="noreferrer" style={{ color: A.accent, textDecoration: 'none', fontSize: 12.5 }}>View ↗</a>
                          : <span style={{ color: T.text3 }}>—</span>}
                      </Td>
                      <Td muted>{j.customer_name || '—'}</Td>
                      <Td>
                        {j.status === 'unmatched' && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                            <select value={assignSel[j.id] || ''} onChange={e => setAssignSel(s => ({ ...s, [j.id]: e.target.value }))}
                              style={{ fontSize: 12, padding: '5px 7px', borderRadius: RADIUS.sm, border: '1px solid transparent', background: T.bg3, color: T.text, fontFamily: 'inherit', maxWidth: 160, outline: 'none' }}>
                              <option value="">Distributor…</option>
                              {distributors.map(d => <option key={d.id} value={d.id}>{d.display_name}</option>)}
                            </select>
                            <label style={{ fontSize: 12, color: T.text2, display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', whiteSpace: 'nowrap' }}>
                              <input type="checkbox" checked={assignRemember[j.id] !== false} onChange={e => setAssignRemember(s => ({ ...s, [j.id]: e.target.checked }))} />
                              remember this name
                            </label>
                            <button onClick={() => assign(j)} disabled={busy === j.id} className="al-press al-focus al-ghost"
                              style={{ ...btnStyle('ghost', 'sm', busy === j.id), fontSize: 12, color: A.accent }}>
                              Assign
                            </button>
                            <button onClick={() => dismiss(j)} disabled={busy === j.id} className="al-press al-focus al-ghost"
                              style={{ ...btnStyle('ghost', 'sm', busy === j.id), fontSize: 12, color: A.bad }}>
                              Dismiss
                            </button>
                          </div>
                        )}
                        {j.sync_error && (
                          <button onClick={() => retrySync(j)} disabled={busy === j.id} className="al-press al-focus al-ghost"
                            style={{ ...btnStyle('ghost', 'sm', busy === j.id), fontSize: 12, color: A.warn, marginTop: j.status === 'unmatched' ? 6 : 0 }}>
                            Retry sync
                          </button>
                        )}
                      </Td>
                    </tr>
                    {expanded === j.id && (
                      <tr style={{ borderBottom: `1px solid ${T.border}` }}>
                        <td colSpan={11} style={{ padding: '14px 16px', background: T.bg3 }}>
                          <JobDetail job={j} onEdit={['submitted', 'synced'].includes(j.status) ? () => openEdit(j) : undefined} />
                        </td>
                      </tr>
                    )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        </main>

        {/* Staff correction modal — fixes a distributor's submission and
            re-pushes: Monday item now, MechanicDesk via the nightly worker. */}
        {editJob && (
          <div style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
            onClick={e => { if (e.target === e.currentTarget && !saving) setEditJob(null) }}>
            <div style={{ ...cardStyle(false), width: 720, maxWidth: '100%', maxHeight: '90vh', overflowY: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div>
                <div style={{ fontSize: 15, fontWeight: 700 }}>Edit submission — {editJob.customer_name || 'job'}</div>
                <div style={{ fontSize: 12, color: T.text2, marginTop: 4 }}>
                  {editJob.distributor_name || editJob.company_raw} · saving pushes the corrections to the Monday follow-up item now
                  {editJob.md_customer_md_id ? ' and queues a MechanicDesk correction for tonight’s worker run' : ''}.
                </div>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                {EDIT_FIELDS.map(f => (
                  <label key={f.key as string} style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11.5, color: T.text2, flex: f.textarea ? '1 1 100%' : (f.width ? `0 0 ${f.width}px` : '1 1 200px') }}>
                    {f.label}
                    {f.textarea ? (
                      <textarea value={editForm[f.key as string] || ''} rows={3}
                        onChange={e => setEditForm(s => ({ ...s, [f.key as string]: e.target.value }))}
                        style={{ fontSize: 13, padding: '8px 10px', borderRadius: RADIUS.sm, border: `1px solid ${T.border2}`, background: T.bg3, color: T.text, fontFamily: 'inherit', resize: 'vertical', outline: 'none' }} />
                    ) : (
                      <input value={editForm[f.key as string] || ''}
                        onChange={e => setEditForm(s => ({ ...s, [f.key as string]: e.target.value }))}
                        style={{ fontSize: 13, padding: '8px 10px', borderRadius: RADIUS.sm, border: `1px solid ${T.border2}`, background: T.bg3, color: T.text, fontFamily: 'inherit', outline: 'none' }} />
                    )}
                  </label>
                ))}
              </div>
              {editJob.letter_queued_at && (
                <Banner tone="warn">The thank-you letter for this job was already queued — corrections here can’t recall it.</Banner>
              )}
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <Btn variant="ghost" size="sm" onClick={() => setEditJob(null)} disabled={saving}>Cancel</Btn>
                <Btn variant="primary" size="sm" onClick={saveEdit} disabled={saving}>{saving ? 'Saving…' : 'Save & re-push'}</Btn>
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  )
}

// Full submission view — everything the distributor entered plus where the
// job got to downstream (MD / Monday / letter). onEdit (submitted/synced
// rows) opens the staff correction modal.
function JobDetail({ job, onEdit }: { job: TuneJob; onEdit?: () => void }) {
  const vehicle = [job.vehicle_year, job.vehicle_make, job.vehicle_model].filter(Boolean).join(' ')
    || job.vehicle_description || null
  const address = [job.customer_address_line1, [job.customer_suburb, job.customer_state, job.customer_postcode].filter(Boolean).join(' ')]
    .filter(Boolean).join(', ') || null

  const section: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 200 }
  const heading: React.CSSProperties = { fontSize: 12, fontWeight: 650, color: T.text2 }

  function Row({ label, children }: { label: string; children?: React.ReactNode }) {
    return (
      <div style={{ display: 'flex', gap: 8, fontSize: 12.5, lineHeight: 1.45 }}>
        <span style={{ color: T.text3, minWidth: 86, flexShrink: 0 }}>{label}</span>
        <span style={{ color: T.text }}>{children || <span style={{ color: T.text3 }}>—</span>}</span>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap' }}>
        <div style={section}>
          <div style={heading}>Customer</div>
          <Row label="Name">{job.customer_name}</Row>
          <Row label="Phone">{job.customer_phone && <a href={`tel:${job.customer_phone}`} style={{ color: A.accent, textDecoration: 'none' }}>{job.customer_phone}</a>}</Row>
          <Row label="Email">{job.customer_email && <a href={`mailto:${job.customer_email}`} style={{ color: A.accent, textDecoration: 'none' }}>{job.customer_email}</a>}</Row>
          <Row label="Address">{address}</Row>
        </div>
        <div style={section}>
          <div style={heading}>Vehicle</div>
          <Row label="Vehicle">{vehicle}</Row>
          <Row label="Rego">{job.vehicle_rego}</Row>
          <Row label="VIN">{job.vin && <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>{job.vin}</span>}</Row>
        </div>
        <div style={section}>
          <div style={heading}>Tune</div>
          <Row label="Calibration">{job.tune_details}</Row>
          <Row label="Invoice">{job.invoice_number}{job.amount != null ? ` · $${Number(job.amount).toFixed(2)}` : ''}</Row>
          <Row label="Distributor">{job.distributor_name || job.company_raw}</Row>
          <Row label="Filled">{job.filled_at ? formatDate(job.filled_at) : null}</Row>
        </div>
        <div style={section}>
          <div style={heading}>Downstream</div>
          <Row label="MechanicDesk">{job.md_customer_md_id
            ? <>customer #{job.md_customer_md_id}{job.md_synced_at ? ` · ${formatDate(job.md_synced_at)}` : ''}</>
            : job.status === 'submitted' ? <span style={{ color: A.warn }}>queued — nightly 2:30am worker</span> : null}</Row>
          <Row label="Monday">{job.monday_item_id && (
            <a href={`${MONDAY_FOLLOWUP_BOARD_URL}/${job.monday_item_id}`} target="_blank" rel="noreferrer" style={{ color: A.accent, textDecoration: 'none' }}>
              Follow-up item ↗
            </a>
          )}</Row>
          <Row label="Letter">{job.letter_queued_at ? `queued ${formatDate(job.letter_queued_at)}` : <span style={{ color: T.text3 }}>not queued{!address ? ' (no address)' : ''}</span>}</Row>
          {job.admin_edited_at && (
            <Row label="Corrected">
              {formatDate(job.admin_edited_at)}
              {job.md_resync_pending && <span style={{ color: A.warn }}> · MD correction queued (nightly worker)</span>}
            </Row>
          )}
          {job.sync_error && <Row label="Sync error"><span style={{ color: A.bad }}>{job.sync_error}</span></Row>}
        </div>
      </div>
      <div>
        <div style={heading}>Package details</div>
        <div style={{ fontSize: 12.5, color: job.job_notes ? T.text : T.text3, marginTop: 5, whiteSpace: 'pre-wrap', maxWidth: 900 }}>
          {job.job_notes || 'None provided.'}
        </div>
      </div>
      {onEdit && (
        <div>
          <Btn variant="secondary" size="sm" onClick={onEdit}>✏️ Edit details</Btn>
        </div>
      )}
    </div>
  )
}

function Th({ children, align }: { children?: React.ReactNode; align?: 'left' | 'right' }) {
  return (
    <th style={{ textAlign: align || 'left', fontSize: 12, fontWeight: 650, color: T.text2, padding: '10px 12px', whiteSpace: 'nowrap' }}>
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
