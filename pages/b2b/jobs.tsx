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
import { T, alpha } from '../../lib/ui/theme'
import { A, Banner, Btn, Card, EmptyState, Field, PageTitle, SectionLabel, StatusPill, inputStyle } from '../../components/b2b/ui'
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
  customer_phone: string
  customer_email: string
  customer_address_line1: string
  customer_suburb: string
  customer_state: string
  customer_postcode: string
  vehicle_rego: string
  vehicle_make: string
  vehicle_model: string
  vehicle_year: string
  job_notes: string
}

const EMPTY_FORM: DetailsForm = {
  customer_name: '', customer_phone: '', customer_email: '',
  customer_address_line1: '', customer_suburb: '', customer_state: '', customer_postcode: '',
  vehicle_rego: '', vehicle_make: '', vehicle_model: '', vehicle_year: '', job_notes: '',
}

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' })
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
        <div style={{ maxWidth: 900, margin: '0 auto' }}>

          <PageTitle sub={'When you complete a tune we receive the receipt automatically — fill in the customer’s details so we can finish the paperwork.'}>
            Tune Jobs
          </PageTitle>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

            {error && <Banner tone="error">{error}</Banner>}
            {jobs === null && !error && <div style={{ color: T.text3, padding: 30, textAlign: 'center', fontSize: 13 }}>Loading…</div>}

            {jobs !== null && jobs.length === 0 && (
              <EmptyState
                title="No tune jobs yet"
                sub={'They’ll appear here automatically after each tune you complete.'}/>
            )}

            {/* ── Needs your details ─────────────────────────────── */}
            {open.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <SectionLabel>
                  Needs your details <span style={{ color: A.warn }}>({open.length})</span>
                </SectionLabel>
                {open.map(j => <OpenJobCard key={j.id} job={j} onSubmitted={onSubmitted} />)}
              </div>
            )}

            {/* ── Completed ──────────────────────────────────────── */}
            {done.length > 0 && (
              <Card pad={false}>
                <button onClick={() => setCompletedOpen(o => !o)} className="al-press al-focus"
                  style={{
                    width: '100%', display: 'flex', alignItems: 'center', gap: 9, padding: '14px 18px', minHeight: 48,
                    background: 'transparent', border: 'none', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left',
                    fontSize: 13.5, fontWeight: 650, color: T.text2,
                  }}>
                  <span aria-hidden style={{ color: T.text3, fontSize: 10, transform: completedOpen ? 'rotate(180deg)' : 'none', transition: 'transform .15s ease', display: 'inline-block' }}>▾</span>
                  Completed <span style={{ color: T.text3, fontWeight: 400 }}>({done.length})</span>
                </button>
                {completedOpen && done.map(j => (
                  <div key={j.id} style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: '12px 18px', borderTop: `1px solid ${T.border}` }}>
                    <div style={{ flex: 1, minWidth: 180 }}>
                      <div style={{ fontSize: 14, fontWeight: 600, color: T.text }}>{j.customer_name || '—'}</div>
                      <div style={{ fontSize: 12.5, color: T.text2, marginTop: 2 }}>
                        {j.tune_details || 'Tune'}
                        {j.vin && <> · <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>{j.vin}</span></>}
                      </div>
                    </div>
                    <div style={{ fontSize: 12, color: T.text3 }}>filled {formatDate(j.filled_at)}</div>
                    {j.status === 'submitted'
                      ? <StatusPill color={A.warn}>Processing</StatusPill>
                      : <StatusPill color={A.good}>Done</StatusPill>}
                  </div>
                ))}
              </Card>
            )}

          </div>
        </div>
      </B2BLayout>
    </>
  )
}

function OpenJobCard({ job, onSubmitted }: { job: TuneJob; onSubmitted: (id: string, form: DetailsForm) => void }) {
  const [formOpen, setFormOpen] = useState(false)
  const [form, setForm] = useState<DetailsForm>({
    ...EMPTY_FORM,
    vehicle_rego: job.vehicle_rego || '',
  })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const set = (k: keyof DetailsForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }))

  async function submit() {
    const name = form.customer_name.trim().replace(/\s+/g, ' ')
    if (!name) { setErr('Customer name is required.'); return }
    if (name.split(' ').length < 2) { setErr('Please enter the customer’s first and last name.'); return }
    const phoneDigits = form.customer_phone.replace(/\D/g, '')
    if (!((phoneDigits.length === 10 && phoneDigits.startsWith('0')) || (phoneDigits.length === 11 && phoneDigits.startsWith('61')))) {
      setErr('Please enter the customer’s full phone number (10 digits, e.g. 0400 123 456).'); return
    }
    setBusy(true); setErr('')
    try {
      const r = await fetch('/api/b2b/jobs', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          job_id: job.id,
          details: {
            customer_name: name,
            customer_phone: form.customer_phone.trim(),
            customer_email: form.customer_email.trim(),
            customer_address_line1: form.customer_address_line1.trim(),
            customer_suburb: form.customer_suburb.trim(),
            customer_state: form.customer_state.trim(),
            customer_postcode: form.customer_postcode.trim(),
            vehicle_rego: form.vehicle_rego.trim(),
            vehicle_make: form.vehicle_make.trim(),
            vehicle_model: form.vehicle_model.trim(),
            vehicle_year: form.vehicle_year.trim(),
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
    <Card style={{ border: `1px solid ${alpha(A.warn, '50')}`, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 15, fontWeight: 650, color: T.text }}>{job.tune_details || 'Tune'}</div>
        <div style={{ fontSize: 12, color: T.text3 }}>received {formatDate(job.email_received_at || job.created_at)}</div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', fontSize: 12.5, color: T.text2 }}>
        {job.vin && <span>VIN <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12, color: T.text }}>{job.vin}</span></span>}
        {job.invoice_number && <span>Invoice {job.invoice_number}</span>}
        {job.amount != null && <span style={{ fontVariantNumeric: 'tabular-nums' }}>${Number(job.amount).toFixed(2)}</span>}
        {job.invoice_url && (
          <a href={job.invoice_url} target="_blank" rel="noreferrer" style={{ color: A.accent, textDecoration: 'none', fontWeight: 600 }}>
            View invoice
          </a>
        )}
      </div>

      {!formOpen && (
        <div>
          <Btn onClick={() => setFormOpen(true)}>Fill in customer details</Btn>
        </div>
      )}

      {formOpen && (
        <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
            <Field label="Customer name (first & last)" required><input value={form.customer_name} onChange={set('customer_name')} style={inputStyle()} placeholder="e.g. John Smith" /></Field>
            <Field label="Phone" required><input value={form.customer_phone} onChange={set('customer_phone')} style={inputStyle()} inputMode="tel" placeholder="e.g. 0400 123 456" /></Field>
            <Field label="Email"><input value={form.customer_email} onChange={set('customer_email')} style={inputStyle()} inputMode="email" /></Field>
            <Field label="Address line"><input value={form.customer_address_line1} onChange={set('customer_address_line1')} style={inputStyle()} /></Field>
            <Field label="Suburb"><input value={form.customer_suburb} onChange={set('customer_suburb')} style={inputStyle()} /></Field>
            <Field label="State"><input value={form.customer_state} onChange={set('customer_state')} style={inputStyle()} placeholder="QLD" /></Field>
            <Field label="Postcode"><input value={form.customer_postcode} onChange={set('customer_postcode')} style={inputStyle()} inputMode="numeric" /></Field>
            <Field label="Rego"><input value={form.vehicle_rego} onChange={set('vehicle_rego')} style={inputStyle()} /></Field>
            <Field label="Make"><input value={form.vehicle_make} onChange={set('vehicle_make')} style={inputStyle()} placeholder="e.g. Toyota" /></Field>
            <Field label="Model"><input value={form.vehicle_model} onChange={set('vehicle_model')} style={inputStyle()} placeholder="e.g. Hilux SR5" /></Field>
            <Field label="Year"><input value={form.vehicle_year} onChange={set('vehicle_year')} style={inputStyle()} inputMode="numeric" placeholder="e.g. 2021" /></Field>
          </div>
          <Field label="Package details (what was done)">
            <textarea value={form.job_notes} onChange={set('job_notes')} rows={3} style={{ ...inputStyle(), resize: 'vertical' }} placeholder="e.g. Stage 1 tune package — exhaust, intake, ECU calibration" />
          </Field>
          {err && <Banner tone="error">{err}</Banner>}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <Btn onClick={submit} disabled={busy}>{busy ? 'Submitting…' : 'Submit details'}</Btn>
            <Btn variant="ghost" onClick={() => setFormOpen(false)} disabled={busy}>Cancel</Btn>
          </div>
        </div>
      )}
    </Card>
  )
}

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  return await requireB2BPageAuth(ctx) as any
}
