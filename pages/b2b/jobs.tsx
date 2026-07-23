// pages/b2b/jobs.tsx
//
// Distributor tune jobs. When a distributor completes a tune we receive the
// Stripe receipt automatically (accounts inbox ingestion); the job lands here
// as "needs your details" and the distributor fills in the customer/vehicle
// info so Just Autos can finish the paperwork (Monday + MechanicDesk +
// thank-you letter). Submitted/synced jobs collapse into a "Completed" list.

import { useEffect, useState } from 'react'
import Head from 'next/head'
import type { GetServerSideProps } from 'next'
import B2BLayout from '../../components/b2b/B2BLayout'
import { requireB2BPageAuth } from '../../lib/b2bAuthServer'
import { T } from '../../lib/ui/theme'
import { useToast } from '../../components/ui/Feedback'

interface Props {
  b2bUser: {
    id: string
    email: string
    fullName: string | null
    role: 'owner' | 'member'
    distributor: { id: string; displayName: string }
  }
}

interface TuneJob {
  id: string
  status: 'awaiting_details' | 'submitted' | 'synced'
  vin: string | null
  tune_details: string | null
  invoice_number: string | null
  amount: number | null
  email_received_at: string | null
  created_at: string
  invoice_url: string | null
  customer_name: string | null
  customer_first_name: string | null
  customer_phone: string | null
  customer_email: string | null
  customer_address_line1: string | null
  customer_suburb: string | null
  customer_state: string | null
  customer_postcode: string | null
  vehicle_rego: string | null
  vehicle_description: string | null
  job_notes: string | null
  filled_at: string | null
}

interface DetailsForm {
  customer_name: string
  customer_first_name: string
  customer_phone: string
  customer_email: string
  customer_address_line1: string
  customer_suburb: string
  customer_state: string
  customer_postcode: string
  vehicle_rego: string
  vehicle_description: string
  job_notes: string
}

const EMPTY_FORM: DetailsForm = {
  customer_name: '', customer_first_name: '', customer_phone: '', customer_email: '',
  customer_address_line1: '', customer_suburb: '', customer_state: '', customer_postcode: '',
  vehicle_rego: '', vehicle_description: '', job_notes: '',
}

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' })
}

const inputStyle: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box',
  fontSize: 13, padding: '8px 10px', borderRadius: 6,
  border: `1px solid ${T.border2}`, background: T.bg3, color: T.text, fontFamily: 'inherit',
}

export default function B2BJobsPage({ b2bUser }: Props) {
  const toast = useToast()
  const [jobs, setJobs] = useState<TuneJob[] | null>(null)
  const [error, setError] = useState('')
  const [completedOpen, setCompletedOpen] = useState(false)

  useEffect(() => {
    fetch('/api/b2b/jobs', { credentials: 'same-origin' })
      .then(r => r.json())
      .then(d => { if (d.error) throw new Error(d.error); setJobs(d.jobs || []) })
      .catch(e => setError(e.message || 'Failed to load'))
  }, [])

  function onSubmitted(id: string, form: DetailsForm) {
    setJobs(js => (js || []).map(j => j.id === id
      ? { ...j, status: 'submitted' as const, filled_at: new Date().toISOString(), customer_name: form.customer_name }
      : j))
    toast('Details submitted — thanks, we’ll take it from here.', 'success')
  }

  const open = (jobs || []).filter(j => j.status === 'awaiting_details')
  const done = (jobs || []).filter(j => j.status === 'submitted' || j.status === 'synced')

  return (
    <>
      <Head><title>Tune Jobs · Just Autos B2B</title><meta name="robots" content="noindex,nofollow" /></Head>
      <B2BLayout user={b2bUser} active="jobs">
        <div style={{ maxWidth: 900, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 18 }}>

          <div>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>Tune Jobs</h1>
            <div style={{ fontSize: 13, color: T.text3, marginTop: 4 }}>
              When you complete a tune we receive the receipt automatically — fill in the customer&rsquo;s details so we can finish the paperwork.
            </div>
          </div>

          {error && (
            <div style={{ background: 'rgba(240,78,78,0.1)', border: `1px solid ${T.red}40`, borderRadius: 8, padding: 12, fontSize: 13, color: T.red }}>
              {error}
            </div>
          )}
          {jobs === null && !error && <div style={{ color: T.text3, padding: 30, textAlign: 'center' }}>Loading…</div>}

          {jobs !== null && jobs.length === 0 && (
            <div style={{ padding: 36, textAlign: 'center', background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 10, color: T.text3, fontStyle: 'italic' }}>
              No tune jobs yet — they&rsquo;ll appear here automatically after each tune you complete.
            </div>
          )}

          {/* ── Needs your details ─────────────────────────────── */}
          {open.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: T.text2 }}>
                Needs your details <span style={{ color: T.amber, fontWeight: 700 }}>({open.length})</span>
              </div>
              {open.map(j => <OpenJobCard key={j.id} job={j} onSubmitted={onSubmitted} />)}
            </div>
          )}

          {/* ── Completed ──────────────────────────────────────── */}
          {done.length > 0 && (
            <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 12, overflow: 'hidden' }}>
              <button onClick={() => setCompletedOpen(o => !o)}
                style={{
                  width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px',
                  background: 'transparent', border: 'none', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left',
                  fontSize: 13, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: T.text2,
                }}>
                <span style={{ color: T.text3, fontSize: 11 }}>{completedOpen ? '▼' : '▶'}</span>
                Completed <span style={{ color: T.text3, fontWeight: 400 }}>({done.length})</span>
              </button>
              {completedOpen && done.map((j, i) => (
                <div key={j.id} style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: '11px 16px', borderTop: `1px solid ${T.border}` }}>
                  <div style={{ flex: 1, minWidth: 180 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: T.text }}>{j.customer_name || '—'}</div>
                    <div style={{ fontSize: 12, color: T.text2, marginTop: 2 }}>
                      {j.tune_details || 'Tune'}
                      {j.vin && <> · <span style={{ fontFamily: 'ui-monospace, monospace' }}>{j.vin}</span></>}
                    </div>
                  </div>
                  <div style={{ fontSize: 11, color: T.text3 }}>filled {formatDate(j.filled_at)}</div>
                  {j.status === 'submitted'
                    ? <StatusChip color={T.amber} label="processing" />
                    : <StatusChip color={T.green} label="done" />}
                </div>
              ))}
            </div>
          )}

        </div>
      </B2BLayout>
    </>
  )
}

function StatusChip({ color, label }: { color: string; label: string }) {
  return (
    <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 8, background: `${color}18`, color, whiteSpace: 'nowrap' }}>
      {label}
    </span>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 11, color: T.text3, fontWeight: 600 }}>{label}</span>
      {children}
    </label>
  )
}

function OpenJobCard({ job, onSubmitted }: { job: TuneJob; onSubmitted: (id: string, form: DetailsForm) => void }) {
  const [formOpen, setFormOpen] = useState(false)
  const [form, setForm] = useState<DetailsForm>({
    ...EMPTY_FORM,
    vehicle_description: job.vehicle_description || '',
    vehicle_rego: job.vehicle_rego || '',
  })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const set = (k: keyof DetailsForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }))

  async function submit() {
    if (!form.customer_name.trim()) { setErr('Customer name is required.'); return }
    setBusy(true); setErr('')
    try {
      const r = await fetch('/api/b2b/jobs', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          job_id: job.id,
          details: {
            customer_name: form.customer_name.trim(),
            customer_first_name: form.customer_first_name.trim(),
            customer_phone: form.customer_phone.trim(),
            customer_email: form.customer_email.trim(),
            customer_address_line1: form.customer_address_line1.trim(),
            customer_suburb: form.customer_suburb.trim(),
            customer_state: form.customer_state.trim(),
            customer_postcode: form.customer_postcode.trim(),
            vehicle_rego: form.vehicle_rego.trim(),
            vehicle_description: form.vehicle_description.trim(),
            job_notes: form.job_notes.trim(),
          },
        }),
      })
      const d = await r.json()
      if (!r.ok || d.error) throw new Error(d.error || `HTTP ${r.status}`)
      onSubmitted(job.id, form)
    } catch (e: any) {
      setErr(e.message || 'Submit failed')
      setBusy(false)
    }
  }

  return (
    <div style={{ background: T.bg2, border: `1px solid ${T.amber}50`, borderRadius: 12, padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: T.text }}>{job.tune_details || 'Tune'}</div>
        <div style={{ fontSize: 11, color: T.text3 }}>received {formatDate(job.email_received_at || job.created_at)}</div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', fontSize: 12, color: T.text2 }}>
        {job.vin && <span>VIN <span style={{ fontFamily: 'ui-monospace, monospace', color: T.text }}>{job.vin}</span></span>}
        {job.invoice_number && <span>Invoice {job.invoice_number}</span>}
        {job.amount != null && <span>${Number(job.amount).toFixed(2)}</span>}
        {job.invoice_url && (
          <a href={job.invoice_url} target="_blank" rel="noreferrer" style={{ color: T.blue, textDecoration: 'none', fontWeight: 600 }}>
            View invoice ↗
          </a>
        )}
      </div>

      {!formOpen && (
        <div>
          <button onClick={() => setFormOpen(true)}
            style={{ fontSize: 12, fontWeight: 700, padding: '9px 18px', borderRadius: 8, border: `1px solid ${T.blue}`, background: T.blue, color: '#fff', cursor: 'pointer', fontFamily: 'inherit' }}>
            Fill in customer details
          </button>
        </div>
      )}

      {formOpen && (
        <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
            <Field label="Customer name *"><input value={form.customer_name} onChange={set('customer_name')} style={inputStyle} placeholder="Full name" /></Field>
            <Field label="First name"><input value={form.customer_first_name} onChange={set('customer_first_name')} style={inputStyle} /></Field>
            <Field label="Phone"><input value={form.customer_phone} onChange={set('customer_phone')} style={inputStyle} inputMode="tel" /></Field>
            <Field label="Email"><input value={form.customer_email} onChange={set('customer_email')} style={inputStyle} inputMode="email" /></Field>
            <Field label="Address line"><input value={form.customer_address_line1} onChange={set('customer_address_line1')} style={inputStyle} /></Field>
            <Field label="Suburb"><input value={form.customer_suburb} onChange={set('customer_suburb')} style={inputStyle} /></Field>
            <Field label="State"><input value={form.customer_state} onChange={set('customer_state')} style={inputStyle} placeholder="QLD" /></Field>
            <Field label="Postcode"><input value={form.customer_postcode} onChange={set('customer_postcode')} style={inputStyle} inputMode="numeric" /></Field>
            <Field label="Rego"><input value={form.vehicle_rego} onChange={set('vehicle_rego')} style={inputStyle} /></Field>
            <Field label="Vehicle description"><input value={form.vehicle_description} onChange={set('vehicle_description')} style={inputStyle} placeholder="e.g. 2021 Hilux SR5" /></Field>
          </div>
          <Field label="Notes">
            <textarea value={form.job_notes} onChange={set('job_notes')} rows={3} style={{ ...inputStyle, resize: 'vertical' }} />
          </Field>
          {err && <div style={{ fontSize: 12, color: T.red }}>{err}</div>}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button onClick={submit} disabled={busy}
              style={{ fontSize: 12, fontWeight: 700, padding: '9px 20px', borderRadius: 8, border: `1px solid ${T.blue}`, background: T.blue, color: '#fff', cursor: busy ? 'wait' : 'pointer', fontFamily: 'inherit', opacity: busy ? 0.6 : 1 }}>
              {busy ? 'Submitting…' : 'Submit details'}
            </button>
            <button onClick={() => setFormOpen(false)} disabled={busy}
              style={{ fontSize: 12, padding: '9px 14px', borderRadius: 8, border: `1px solid ${T.border2}`, background: 'transparent', color: T.text2, cursor: 'pointer', fontFamily: 'inherit' }}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  return await requireB2BPageAuth(ctx) as any
}
