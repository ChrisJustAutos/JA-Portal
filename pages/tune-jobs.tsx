// pages/tune-jobs.tsx
// Login-less tune-job fill page, reached from the weekly reminder email.
// The ?token= is a signed, expiring capability scoped to ONE distributor —
// the page shows that distributor's open jobs only, with the same customer-
// details form as /b2b/jobs. Submissions go to /api/tune-jobs-submit with the
// token; there is no session and nothing else is reachable from here.

import { useState } from 'react'
import Head from 'next/head'
import type { GetServerSidePropsContext } from 'next'
import { T } from '../lib/ui/theme'

interface OpenJob {
  id: string
  vin: string | null
  tune_details: string | null
  invoice_number: string | null
  amount: number | null
  created_at: string
  invoice_url: string | null
}

interface Props {
  ok: boolean
  reason?: string
  distributorName?: string
  token?: string
  jobs?: OpenJob[]
}

export async function getServerSideProps(context: GetServerSidePropsContext): Promise<{ props: Props }> {
  const token = String(context.query.token || '')
  const { verifyOrderAction } = await import('../lib/order-action-token')
  const v = token ? verifyOrderAction(token, 'tune_jobs') : null
  if (!v) return { props: { ok: false, reason: 'This link has expired or is invalid — use the newest reminder email, or sign in to the portal and open the Jobs tab.' } }

  const { createClient } = await import('@supabase/supabase-js')
  const c = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  const distributorId = v.orderId  // tune_jobs tokens carry the distributor id
  const { data: dist } = await c.from('b2b_distributors').select('display_name').eq('id', distributorId).maybeSingle()
  if (!dist) return { props: { ok: false, reason: 'This link is no longer valid.' } }

  const { data: jobs } = await c.from('b2b_tune_jobs')
    .select('id, vin, tune_details, invoice_number, amount, created_at, invoice_pdf_path')
    .eq('distributor_id', distributorId)
    .eq('status', 'awaiting_details')
    .order('created_at', { ascending: false })
    .limit(100)

  const out: OpenJob[] = []
  for (const j of jobs || []) {
    let invoiceUrl: string | null = null
    if (j.invoice_pdf_path) {
      const { data: signed } = await c.storage.from('b2b-tune-invoices').createSignedUrl(j.invoice_pdf_path, 3600)
      invoiceUrl = signed?.signedUrl || null
    }
    out.push({ id: j.id, vin: j.vin, tune_details: j.tune_details, invoice_number: j.invoice_number, amount: j.amount != null ? Number(j.amount) : null, created_at: j.created_at, invoice_url: invoiceUrl })
  }
  return { props: { ok: true, distributorName: dist.display_name || 'your business', token, jobs: out } }
}

const FIELDS: Array<{ key: string; label: string; type?: string; required?: boolean; wide?: boolean }> = [
  { key: 'customer_name', label: 'Customer name', required: true },
  { key: 'customer_first_name', label: 'First name' },
  { key: 'customer_phone', label: 'Phone' },
  { key: 'customer_email', label: 'Email', type: 'email' },
  { key: 'customer_address_line1', label: 'Address', wide: true },
  { key: 'customer_suburb', label: 'Suburb' },
  { key: 'customer_state', label: 'State' },
  { key: 'customer_postcode', label: 'Postcode' },
  { key: 'vehicle_rego', label: 'Rego' },
  { key: 'vehicle_description', label: 'Vehicle (e.g. 2022 LC79)' },
]

function JobCard({ job, token, onDone }: { job: OpenJob; token: string; onDone: (id: string) => void }) {
  const [form, setForm] = useState<Record<string, string>>({})
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setErr('')
    try {
      const r = await fetch('/api/tune-jobs-submit', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, job_id: job.id, details: { ...form, job_notes: notes } }),
      })
      const d = await r.json()
      if (!r.ok || d.error) throw new Error(d.error || `HTTP ${r.status}`)
      onDone(job.id)
    } catch (e: any) { setErr(e?.message || 'Submit failed') }
    setBusy(false)
  }

  return (
    <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 10, padding: 16, marginBottom: 16 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'baseline', marginBottom: 10 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: T.text }}>{job.tune_details || 'Tune'}</div>
        <div style={{ fontSize: 12, color: T.text3, fontFamily: 'monospace' }}>{job.vin ? `VIN ${job.vin}` : ''}</div>
        <div style={{ fontSize: 12, color: T.text3 }}>{new Date(job.created_at).toLocaleDateString('en-AU')}{job.invoice_number ? ` · ${job.invoice_number}` : ''}{job.amount ? ` · $${job.amount.toFixed(2)}` : ''}</div>
        {job.invoice_url && <a href={job.invoice_url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12, color: T.blue }}>View invoice →</a>}
      </div>
      <form onSubmit={submit}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 8 }}>
          {FIELDS.map(f => (
            <label key={f.key} style={{ gridColumn: f.wide ? '1 / -1' : undefined, fontSize: 11, color: T.text3, display: 'flex', flexDirection: 'column', gap: 3 }}>
              {f.label}{f.required ? ' *' : ''}
              <input
                type={f.type || 'text'} required={f.required}
                value={form[f.key] || ''} onChange={e => setForm({ ...form, [f.key]: e.target.value })}
                style={{ padding: '8px 10px', borderRadius: 6, border: `1px solid ${T.border}`, background: T.bg3, color: T.text, fontSize: 13, fontFamily: 'inherit' }} />
            </label>
          ))}
        </div>
        <label style={{ fontSize: 11, color: T.text3, display: 'flex', flexDirection: 'column', gap: 3, marginTop: 8 }}>
          Notes about the job (what was done)
          <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2}
            style={{ padding: '8px 10px', borderRadius: 6, border: `1px solid ${T.border}`, background: T.bg3, color: T.text, fontSize: 13, fontFamily: 'inherit', resize: 'vertical' }} />
        </label>
        {err && <div style={{ marginTop: 8, fontSize: 12, color: T.red }}>{err}</div>}
        <button type="submit" disabled={busy}
          style={{ marginTop: 10, padding: '9px 18px', borderRadius: 7, border: 'none', background: T.green, color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', opacity: busy ? 0.6 : 1, fontFamily: 'inherit' }}>
          {busy ? 'Submitting…' : 'Submit details'}
        </button>
      </form>
    </div>
  )
}

export default function TuneJobsFillPage(props: Props) {
  const [jobs, setJobs] = useState<OpenJob[]>(props.jobs || [])
  const [doneCount, setDoneCount] = useState(0)

  return (
    <>
      <Head><title>Tune Jobs — Just Autos</title><meta name="robots" content="noindex,nofollow" /></Head>
      <div style={{ minHeight: '100vh', background: T.bg, padding: '32px 16px' }}>
        <div style={{ maxWidth: 720, margin: '0 auto' }}>
          <div style={{ fontSize: 20, fontWeight: 700, color: T.text, marginBottom: 4 }}>Just Autos — Tune Jobs</div>
          {!props.ok ? (
            <div style={{ marginTop: 16, padding: 16, background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 10, color: T.text2, fontSize: 14 }}>
              {props.reason}
            </div>
          ) : (
            <>
              <div style={{ fontSize: 13, color: T.text3, marginBottom: 20 }}>
                {props.distributorName} — fill in the customer details for each tune below so we can finish the paperwork. Only your jobs are shown here.
              </div>
              {doneCount > 0 && <div style={{ marginBottom: 14, fontSize: 13, color: T.green }}>✓ {doneCount} job{doneCount === 1 ? '' : 's'} submitted — thank you!</div>}
              {jobs.length === 0
                ? <div style={{ padding: 16, background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 10, color: T.text2, fontSize: 14 }}>All done — no jobs waiting on details. 🎉</div>
                : jobs.map(j => <JobCard key={j.id} job={j} token={props.token!} onDone={id => { setJobs(prev => prev.filter(x => x.id !== id)); setDoneCount(n => n + 1) }} />)}
            </>
          )}
        </div>
      </div>
    </>
  )
}
