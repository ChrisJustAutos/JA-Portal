// pages/admin/b2b/settings.tsx
//
// B2B portal settings — staff-only.
// Layout matches the rest of /admin/b2b/* (PortalSidebar + main content).

import { useEffect, useMemo, useState } from 'react'
import Head from 'next/head'
import PortalSidebar from '../../../lib/PortalSidebar'
import { requirePageAuth } from '../../../lib/authServer'
import type { UserRole } from '../../../lib/permissions'

const T = {
  bg:'#0d0f12', bg2:'#131519', bg3:'#1a1d23', bg4:'#21252d',
  border:'rgba(255,255,255,0.07)', border2:'rgba(255,255,255,0.12)',
  text:'#e8eaf0', text2:'#8b90a0', text3:'#545968',
  blue:'#4f8ef7', teal:'#2dd4bf', green:'#34c77b',
  amber:'#f5a623', red:'#f04e4e', purple:'#a78bfa', accent:'#4f8ef7',
}

interface Props {
  user: {
    id: string
    email: string
    displayName: string | null
    role: UserRole
    visibleTabs: string[] | null
  }
}

interface Settings {
  card_fee_percent: number
  card_fee_fixed: number
  myob_company_file: string
  myob_jaws_gst_tax_code_uid: string | null
  myob_jaws_fre_tax_code_uid: string | null
  myob_card_fee_account_uid: string | null
  myob_card_fee_account_code: string | null
  myob_invoice_number_prefix: string
  myob_invoice_number_padding: number
  myob_invoice_number_seq: number
  myob_credit_note_number_prefix: string
  myob_credit_note_number_padding: number
  myob_credit_note_number_seq: number
  slack_new_order_webhook_url: string | null
  last_catalogue_sync_at: string | null
  last_catalogue_sync_added: number | null
  last_catalogue_sync_updated: number | null
  last_catalogue_sync_error: string | null
  updated_at: string
}

interface ApiResponse {
  settings: Settings
  next_invoice_number_preview: string | null
  next_credit_note_number_preview: string | null
  stripe_env: {
    secret_key_set: boolean
    webhook_secret_set: boolean
  }
}

export default function B2BSettingsPage({ user }: Props) {
  const [data, setData] = useState<ApiResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [savedFlash, setSavedFlash] = useState<string | null>(null)

  // Local edit state
  const [prefix, setPrefix]   = useState('')
  const [padding, setPadding] = useState(6)
  const [seqInput, setSeqInput] = useState<string>('')
  const [cnPrefix, setCnPrefix]     = useState('')
  const [cnPadding, setCnPadding]   = useState(6)
  const [cnSeqInput, setCnSeqInput] = useState<string>('')
  const [feePct, setFeePct]   = useState(0)
  const [feeFixed, setFeeFixed] = useState(0)
  const [slackUrl, setSlackUrl] = useState('')

  async function load() {
    setLoading(true); setError(null)
    try {
      const r = await fetch('/api/b2b/admin/settings', { credentials: 'same-origin' })
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`)
      const j: ApiResponse = await r.json()
      setData(j)
      setPrefix(j.settings.myob_invoice_number_prefix || 'JA')
      setPadding(j.settings.myob_invoice_number_padding || 6)
      setSeqInput(String(j.settings.myob_invoice_number_seq ?? 0))
      setCnPrefix(j.settings.myob_credit_note_number_prefix || 'CR')
      setCnPadding(j.settings.myob_credit_note_number_padding || 6)
      setCnSeqInput(String(j.settings.myob_credit_note_number_seq ?? 0))
      setFeePct(Number(j.settings.card_fee_percent || 0.017))
      setFeeFixed(Number(j.settings.card_fee_fixed || 0.30))
      setSlackUrl(j.settings.slack_new_order_webhook_url || '')
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [])

  // Live preview based on local edits
  const livePreview = useMemo(() => {
    const p = (prefix || '').trim()
    const seq = parseInt(seqInput || '0', 10) || 0
    const pad = padding || 6
    if (!p) return ''
    const num = String(seq + 1).padStart(pad, '0')
    return p + num
  }, [prefix, padding, seqInput])

  const livePreviewLength = livePreview.length
  const overLimit = livePreviewLength > 13

  const cnLivePreview = useMemo(() => {
    const p = (cnPrefix || '').trim()
    const seq = parseInt(cnSeqInput || '0', 10) || 0
    const pad = cnPadding || 6
    if (!p) return ''
    const num = String(seq + 1).padStart(pad, '0')
    return p + num
  }, [cnPrefix, cnPadding, cnSeqInput])

  const cnLivePreviewLength = cnLivePreview.length
  const cnOverLimit = cnLivePreviewLength > 13

  async function save(payload: Record<string, any>) {
    setSaving(true); setError(null); setSavedFlash(null)
    try {
      const r = await fetch('/api/b2b/admin/settings', {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const j = await r.json()
      if (!r.ok) {
        if (j?.issues && Array.isArray(j.issues)) {
          throw new Error(j.issues.join(' • '))
        }
        throw new Error(j?.error || `HTTP ${r.status}`)
      }
      setSavedFlash('Saved')
      setTimeout(() => setSavedFlash(null), 2000)
      await load()
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <Head><title>B2B Settings · JA Portal</title></Head>
      <div style={{display:'flex',minHeight:'100vh',background:T.bg,color:T.text,fontFamily:'system-ui,-apple-system,sans-serif'}}>
        <PortalSidebar
          activeId="b2b"
          currentUserRole={user.role}
          currentUserVisibleTabs={user.visibleTabs}
          currentUserName={user.displayName}
          currentUserEmail={user.email}
        />
        <main style={{flex:1,padding:'28px 32px',maxWidth:1100}}>

          {/* Breadcrumb header — same pattern as catalogue.tsx */}
          <header style={{marginBottom:18}}>
            <div style={{fontSize:11,color:T.text3,textTransform:'uppercase',letterSpacing:'0.08em',marginBottom:4}}>
              <a href="/admin/b2b" style={{color:T.text3,textDecoration:'none'}}>B2B Portal</a>
              {' / '}
              <span style={{color:T.text2}}>Settings</span>
            </div>
            <h1 style={{fontSize:22,fontWeight:600,margin:0,letterSpacing:'-0.01em'}}>B2B portal settings</h1>
            <div style={{fontSize:12,color:T.text3,marginTop:4}}>
              Configure how the distributor portal interacts with Stripe and MYOB.
            </div>
          </header>

          {error && (
            <div style={{padding:12,background:`${T.red}15`,border:`1px solid ${T.red}40`,borderRadius:7,color:T.red,fontSize:12,marginBottom:14}}>
              {error}
            </div>
          )}

          {savedFlash && (
            <div style={{padding:'8px 12px',background:`${T.green}15`,border:`1px solid ${T.green}40`,borderRadius:7,color:T.green,fontSize:12,marginBottom:14}}>
              ✓ {savedFlash}
            </div>
          )}

          {loading && !data && (
            <div style={{padding:36,textAlign:'center',color:T.text3,fontSize:12}}>Loading…</div>
          )}

          {data && (
            <>
              {/* ─── Invoice numbering ─── */}
              <Section title="MYOB Invoice Numbering"
                description="Each B2B order writes a Sale.Invoice to MYOB JAWS. The invoice number is portal-controlled (prefix + zero-padded sequence). MYOB caps the field at 13 characters total.">

                <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:14,marginBottom:14}}>
                  <Field label="Prefix" hint="Letters/digits, no spaces. Max 8 chars.">
                    <input
                      type="text"
                      value={prefix}
                      onChange={e => setPrefix(e.target.value.replace(/\s/g, ''))}
                      maxLength={8}
                      style={inputStyle()}
                    />
                  </Field>
                  <Field label="Sequence padding" hint="Zero-pad width (4-8 digits)">
                    <input
                      type="number"
                      value={padding}
                      onChange={e => setPadding(Math.max(4, Math.min(8, parseInt(e.target.value || '6', 10) || 6)))}
                      min={4}
                      max={8}
                      style={inputStyle()}
                    />
                  </Field>
                  <Field label="Current sequence" hint="Last consumed value. Edit to skip ahead.">
                    <input
                      type="number"
                      value={seqInput}
                      onChange={e => setSeqInput(e.target.value)}
                      min={0}
                      style={inputStyle()}
                    />
                  </Field>
                </div>

                <div style={{
                  padding:'12px 14px',
                  background:T.bg3,
                  border:`1px solid ${overLimit ? T.red : T.border2}`,
                  borderRadius:6,
                  marginBottom:14,
                  display:'flex',justifyContent:'space-between',alignItems:'center',gap:12,
                }}>
                  <div>
                    <div style={{fontSize:10,color:T.text3,textTransform:'uppercase',letterSpacing:'0.06em',marginBottom:2}}>Next invoice number</div>
                    <div style={{fontSize:18,fontWeight:600,fontFamily:'monospace',color:overLimit?T.red:T.text}}>
                      {livePreview || '—'}
                    </div>
                  </div>
                  <div style={{textAlign:'right',fontSize:11,color: overLimit ? T.red : T.text3}}>
                    {livePreviewLength} / 13 chars
                    {overLimit && <div style={{fontWeight:500}}>Exceeds MYOB limit</div>}
                  </div>
                </div>

                <button
                  onClick={() => save({
                    myob_invoice_number_prefix: prefix,
                    myob_invoice_number_padding: padding,
                    myob_invoice_number_seq: parseInt(seqInput || '0', 10) || 0,
                  })}
                  disabled={saving || overLimit || !prefix.trim()}
                  style={primaryBtn(!saving && !overLimit && !!prefix.trim())}>
                  {saving ? 'Saving…' : 'Save numbering'}
                </button>
              </Section>

              {/* ─── Credit note numbering ─── */}
              <Section title="MYOB Credit Note Numbering"
                description="Refund credit notes are written to MYOB JAWS as a separate stream from order invoices. Same 13-character MYOB cap applies.">

                <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:14,marginBottom:14}}>
                  <Field label="Prefix" hint="Letters/digits, no spaces. Max 8 chars.">
                    <input
                      type="text"
                      value={cnPrefix}
                      onChange={e => setCnPrefix(e.target.value.replace(/\s/g, ''))}
                      maxLength={8}
                      style={inputStyle()}
                    />
                  </Field>
                  <Field label="Sequence padding" hint="Zero-pad width (4-8 digits)">
                    <input
                      type="number"
                      value={cnPadding}
                      onChange={e => setCnPadding(Math.max(4, Math.min(8, parseInt(e.target.value || '6', 10) || 6)))}
                      min={4}
                      max={8}
                      style={inputStyle()}
                    />
                  </Field>
                  <Field label="Current sequence" hint="Last consumed value. Edit to skip ahead.">
                    <input
                      type="number"
                      value={cnSeqInput}
                      onChange={e => setCnSeqInput(e.target.value)}
                      min={0}
                      style={inputStyle()}
                    />
                  </Field>
                </div>

                <div style={{
                  padding:'12px 14px',
                  background:T.bg3,
                  border:`1px solid ${cnOverLimit ? T.red : T.border2}`,
                  borderRadius:6,
                  marginBottom:14,
                  display:'flex',justifyContent:'space-between',alignItems:'center',gap:12,
                }}>
                  <div>
                    <div style={{fontSize:10,color:T.text3,textTransform:'uppercase',letterSpacing:'0.06em',marginBottom:2}}>Next credit note number</div>
                    <div style={{fontSize:18,fontWeight:600,fontFamily:'monospace',color:cnOverLimit?T.red:T.text}}>
                      {cnLivePreview || '—'}
                    </div>
                  </div>
                  <div style={{textAlign:'right',fontSize:11,color: cnOverLimit ? T.red : T.text3}}>
                    {cnLivePreviewLength} / 13 chars
                    {cnOverLimit && <div style={{fontWeight:500}}>Exceeds MYOB limit</div>}
                  </div>
                </div>

                <button
                  onClick={() => save({
                    myob_credit_note_number_prefix: cnPrefix,
                    myob_credit_note_number_padding: cnPadding,
                    myob_credit_note_number_seq: parseInt(cnSeqInput || '0', 10) || 0,
                  })}
                  disabled={saving || cnOverLimit || !cnPrefix.trim()}
                  style={primaryBtn(!saving && !cnOverLimit && !!cnPrefix.trim())}>
                  {saving ? 'Saving…' : 'Save numbering'}
                </button>
              </Section>

              {/* ─── Card surcharge ─── */}
              <Section title="Card Surcharge"
                description="Pass-through Stripe processing fee. Applied to each order during checkout to make the JAWS payout equal the goods subtotal (inc GST) after Stripe takes its cut.">

                <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:14,marginBottom:14}}>
                  <Field label="Percent" hint="Stripe AU domestic card rate (1.7% = 0.017)">
                    <input
                      type="number"
                      value={feePct}
                      onChange={e => setFeePct(Number(e.target.value || 0))}
                      step="0.001"
                      min={0} max={0.10}
                      style={inputStyle()}
                    />
                  </Field>
                  <Field label="Fixed amount ($)" hint="Stripe per-transaction fee ($0.30)">
                    <input
                      type="number"
                      value={feeFixed}
                      onChange={e => setFeeFixed(Number(e.target.value || 0))}
                      step="0.01"
                      min={0} max={5}
                      style={inputStyle()}
                    />
                  </Field>
                </div>

                <button
                  onClick={() => save({ card_fee_percent: feePct, card_fee_fixed: feeFixed })}
                  disabled={saving}
                  style={primaryBtn(!saving)}>
                  {saving ? 'Saving…' : 'Save surcharge'}
                </button>
              </Section>

              {/* ─── Slack ─── */}
              <Section title="Slack Notifications"
                description="Optional. If set, a message posts to the channel each time an order is paid.">

                <Field label="Incoming webhook URL" hint="Must start with https://hooks.slack.com/">
                  <input
                    type="text"
                    value={slackUrl}
                    onChange={e => setSlackUrl(e.target.value)}
                    placeholder="https://hooks.slack.com/services/..."
                    style={inputStyle()}
                  />
                </Field>

                <div style={{marginTop:14}}>
                  <button
                    onClick={() => save({ slack_new_order_webhook_url: slackUrl })}
                    disabled={saving}
                    style={primaryBtn(!saving)}>
                    {saving ? 'Saving…' : 'Save Slack URL'}
                  </button>
                </div>
              </Section>

              {/* ─── Read-only diagnostics ─── */}
              <Section title="System Status" description="Read-only — for debugging.">
                <DiagRow label="Stripe Secret Key"     status={data.stripe_env.secret_key_set     ? 'ok' : 'missing'} value={data.stripe_env.secret_key_set     ? 'Set in env' : 'Not configured — checkout disabled'}/>
                <DiagRow label="Stripe Webhook Secret" status={data.stripe_env.webhook_secret_set ? 'ok' : 'missing'} value={data.stripe_env.webhook_secret_set ? 'Set in env' : 'Not configured — webhooks will be rejected'}/>
                <DiagRow label="MYOB GST Tax Code"     status={data.settings.myob_jaws_gst_tax_code_uid ? 'ok' : 'pending'} value={data.settings.myob_jaws_gst_tax_code_uid ? 'Resolved' : 'Will auto-resolve on first checkout'}/>
                <DiagRow label="MYOB FRE Tax Code"     status={data.settings.myob_jaws_fre_tax_code_uid ? 'ok' : 'pending'} value={data.settings.myob_jaws_fre_tax_code_uid ? 'Resolved' : 'Will auto-resolve on first checkout'}/>
                <DiagRow label="Card Fee Account"      status={data.settings.myob_card_fee_account_uid  ? 'ok' : 'missing'} value={data.settings.myob_card_fee_account_code || 'Not configured — checkout disabled'}/>
                <DiagRow label="Last Catalogue Sync"   status={data.settings.last_catalogue_sync_at     ? 'ok' : 'pending'} value={
                  data.settings.last_catalogue_sync_at
                    ? `${new Date(data.settings.last_catalogue_sync_at).toLocaleString('en-AU')} · added ${data.settings.last_catalogue_sync_added || 0}, updated ${data.settings.last_catalogue_sync_updated || 0}${data.settings.last_catalogue_sync_error ? ` · ⚠ ${data.settings.last_catalogue_sync_error}` : ''}`
                    : 'Never run'
                }/>
              </Section>
            </>
          )}

        </main>
      </div>
    </>
  )
}

// ─── UI helpers ────────────────────────────────────────────────────────
function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section style={{
      background:T.bg2,border:`1px solid ${T.border}`,borderRadius:10,
      padding:'24px 28px',marginBottom:18,
    }}>
      <h2 style={{fontSize:14,fontWeight:600,margin:'0 0 4px',letterSpacing:'-0.005em'}}>{title}</h2>
      {description && (
        <p style={{fontSize:12,color:T.text3,margin:'0 0 18px',lineHeight:1.5}}>{description}</p>
      )}
      {children}
    </section>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label style={{display:'flex',flexDirection:'column',gap:4}}>
      <span style={{fontSize:11,color:T.text2,fontWeight:500}}>{label}</span>
      {children}
      {hint && <span style={{fontSize:10,color:T.text3}}>{hint}</span>}
    </label>
  )
}

function inputStyle(): React.CSSProperties {
  return {
    background:T.bg3,border:`1px solid ${T.border2}`,color:T.text,
    borderRadius:5,padding:'8px 10px',fontSize:13,outline:'none',
    fontFamily:'inherit',width:'100%',boxSizing:'border-box',
  }
}

function primaryBtn(enabled: boolean): React.CSSProperties {
  return {
    padding:'9px 16px',borderRadius:6,
    border:`1px solid ${enabled ? T.blue : T.border2}`,
    background: enabled ? T.blue : T.bg3,
    color: enabled ? '#fff' : T.text3,
    fontSize:12,fontWeight:500,
    cursor: enabled ? 'pointer' : 'not-allowed',
    fontFamily:'inherit',
  }
}

function DiagRow({ label, status, value }: { label: string; status: 'ok'|'pending'|'missing'; value: string }) {
  const color = status === 'ok' ? T.green : status === 'pending' ? T.amber : T.red
  const dot = status === 'ok' ? '●' : status === 'pending' ? '◐' : '○'
  return (
    <div style={{display:'flex',alignItems:'center',gap:12,padding:'8px 0',borderTop:`1px solid ${T.border}`}}>
      <span style={{color, fontSize:14, width:14}}>{dot}</span>
      <span style={{fontSize:12,color:T.text2,minWidth:160}}>{label}</span>
      <span style={{fontSize:12,color:T.text3,flex:1}}>{value}</span>
    </div>
  )
}

export async function getServerSideProps(context: any) {
  return requirePageAuth(context, 'edit:b2b_distributors')
}
