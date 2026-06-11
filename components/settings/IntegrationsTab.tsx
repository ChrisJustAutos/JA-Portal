// components/settings/IntegrationsTab.tsx
// Self-service integration credentials — Settings → Connections → Integrations.
// Anyone with admin access can paste API keys here and connect: ClickSend
// (SMS), Resend (transactional + campaign mail-outs) and the website lead
// intake token, each with a live test button. Values save to the
// integration_settings table (the comms libs read DB-first, env fallback) —
// no Vercel access needed. MYOB OAuth lives on its own sub-tab; everything
// else (Graph, Stripe, MachShip…) stays env-managed and shows on Health.

import { useEffect, useState } from 'react'
import { T } from '../../lib/ui/theme'
import { useToast } from '../ui/Feedback'

interface FieldInfo { source: 'db' | 'env' | null; preview: string }
type Fields = Record<string, FieldInfo>

const inp: React.CSSProperties = { width: '100%', boxSizing: 'border-box', background: T.bg3, border: `1px solid ${T.border}`, color: T.text, borderRadius: 5, padding: '7px 10px', fontSize: 12, fontFamily: 'inherit', outline: 'none' }
const btn = (bg: string, fg = '#fff'): React.CSSProperties => ({ padding: '7px 14px', borderRadius: 6, fontSize: 12, fontWeight: 600, background: bg, color: fg, border: 'none', cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' })

function SourceBadge({ f }: { f?: FieldInfo }) {
  if (!f || !f.source) return <span style={{ fontSize: 9, fontWeight: 700, color: T.text3, textTransform: 'uppercase' }}>not set</span>
  return (
    <span style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', color: f.source === 'db' ? T.green : T.blue }}>
      {f.source === 'db' ? 'set here' : 'from Vercel env'}
    </span>
  )
}

export default function IntegrationsTab() {
  const toast = useToast()
  const [fields, setFields] = useState<Fields>({})
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [savingCard, setSavingCard] = useState<string | null>(null)
  const [testSmsTo, setTestSmsTo] = useState('')
  const [testEmailTo, setTestEmailTo] = useState('')
  const [testing, setTesting] = useState<string | null>(null)
  const [baseUrl, setBaseUrl] = useState('https://justautos.app')

  useEffect(() => { if (typeof window !== 'undefined') setBaseUrl(window.location.origin) }, [])

  async function load() {
    try {
      const r = await fetch('/api/admin/integrations')
      const d = await r.json()
      if (r.ok) setFields(d.fields || {})
    } catch { /* keep */ } finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

  function setEdit(key: string, v: string) { setEdits(p => ({ ...p, [key]: v })) }

  async function saveCard(card: string, keys: string[]) {
    const values: Record<string, string> = {}
    for (const k of keys) if (k in edits) values[k] = edits[k]
    if (!Object.keys(values).length) { toast('Nothing changed', 'info'); return }
    setSavingCard(card)
    try {
      const r = await fetch('/api/admin/integrations', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ values }) })
      const d = await r.json()
      if (r.ok) {
        setFields(d.fields || {})
        setEdits(p => { const n = { ...p }; for (const k of keys) delete n[k]; return n })
        toast('Saved — takes effect within ~30s everywhere', 'success')
      } else toast(d.error || 'Save failed', 'error')
    } catch (e: any) { toast(e?.message || 'Save failed', 'error') } finally { setSavingCard(null) }
  }

  async function runTest(action: 'test_sms' | 'test_email', to: string) {
    if (!to.trim()) { toast(action === 'test_sms' ? 'Enter a mobile number first' : 'Enter an email address first', 'error'); return }
    setTesting(action)
    try {
      const r = await fetch('/api/admin/integrations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, to }) })
      const d = await r.json()
      if (r.ok) toast(action === 'test_sms' ? `Test SMS sent to ${to} ✓` : `Test email sent to ${to} ✓`, 'success')
      else toast(d.error || 'Test failed', 'error')
    } catch (e: any) { toast(e?.message || 'Test failed', 'error') } finally { setTesting(null) }
  }

  async function regenToken() {
    setTesting('regen')
    try {
      const r = await fetch('/api/admin/integrations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'regen_intake_token' }) })
      const d = await r.json()
      if (r.ok) { toast('New token generated — update the website form to match', 'success'); await load() }
      else toast(d.error || 'Failed', 'error')
    } finally { setTesting(null) }
  }

  function copy(text: string, label: string) {
    navigator.clipboard?.writeText(text).then(() => toast(`${label} copied`, 'success')).catch(() => toast('Copy failed', 'error'))
  }

  // One credential row: label + source badge + input (secrets show masked placeholder).
  function Row({ k, label, secret, placeholder, hint }: { k: string; label: string; secret?: boolean; placeholder?: string; hint?: string }) {
    const f = fields[k]
    return (
      <div style={{ marginBottom: 10 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
          <span style={{ fontSize: 10, fontWeight: 600, color: T.text3, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</span>
          <SourceBadge f={f} />
        </div>
        <input
          type={secret ? 'password' : 'text'}
          autoComplete="off" data-lpignore="true" data-1p-ignore="true" data-form-type="other"
          value={edits[k] ?? (secret ? '' : (f?.source ? f.preview : ''))}
          onChange={e => setEdit(k, e.target.value)}
          placeholder={secret ? (f?.source ? `${f.preview} — type to replace, save blank field as-is` : (placeholder || '')) : (placeholder || '')}
          style={inp}
        />
        {hint && <div style={{ fontSize: 10, color: T.text3, marginTop: 3, lineHeight: 1.4 }}>{hint}</div>}
      </div>
    )
  }

  function Card({ title, desc, children }: { title: string; desc: string; children: React.ReactNode }) {
    return (
      <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 10, padding: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: T.text }}>{title}</div>
        <div style={{ fontSize: 11, color: T.text3, margin: '4px 0 14px', lineHeight: 1.5 }}>{desc}</div>
        {children}
      </div>
    )
  }

  if (loading) return <div style={{ color: T.text3, padding: 30, textAlign: 'center', fontSize: 13 }}>Loading integrations…</div>

  const intakeToken = fields.CRM_INTAKE_TOKEN?.source ? fields.CRM_INTAKE_TOKEN.preview : ''

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))', gap: 14, alignItems: 'start' }}>
      {/* SMS — ClickSend */}
      <Card title="📱 SMS — ClickSend" desc="Powers workshop booking/service reminders, CRM automations and quick SMS. Get the username + API key from clicksend.com → Developers → API Credentials.">
        <Row k="CLICKSEND_USERNAME" label="Username" placeholder="your ClickSend username" />
        <Row k="CLICKSEND_API_KEY" label="API key" secret placeholder="xxxxxxxx-xxxx-…" />
        <Row k="CLICKSEND_FROM" label="Sender ID (optional)" placeholder="JustAutos" hint="Alphanumeric sender shown on the customer's phone — leave blank for a shared number (replies only work with a number)." />
        <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <button onClick={() => saveCard('sms', ['CLICKSEND_USERNAME', 'CLICKSEND_API_KEY', 'CLICKSEND_FROM'])} disabled={savingCard === 'sms'} style={btn(T.accent)}>{savingCard === 'sms' ? 'Saving…' : 'Save'}</button>
          <input value={testSmsTo} onChange={e => setTestSmsTo(e.target.value)} placeholder="04xx xxx xxx" style={{ ...inp, width: 140 }} />
          <button onClick={() => runTest('test_sms', testSmsTo)} disabled={testing === 'test_sms'} style={btn(`${T.teal}22`, T.teal)}>{testing === 'test_sms' ? 'Sending…' : 'Send test SMS'}</button>
        </div>
      </Card>

      {/* Email — Resend */}
      <Card title="✉️ Mail-outs — Resend" desc="Powers ALL outbound email: invoices/quotes, CRM automations, campaigns. Create an API key at resend.com → API Keys; the from-domains must be verified in Resend → Domains.">
        <Row k="RESEND_API_KEY" label="API key" secret placeholder="re_…" />
        <Row k="RESEND_FROM" label="From (transactional)" placeholder="Just Autos <noreply@mail.justautos.app>" hint="Invoices, quotes, automations send from this address." />
        <Row k="RESEND_CAMPAIGN_FROM" label="From (campaigns)" placeholder="Just Autos <news@news.justautos.app>" hint="Bulk campaigns should use a separate subdomain so marketing sends can't dent invoice deliverability." />
        <Row k="RESEND_REPLY_TO" label="Default reply-to" placeholder="accounts@justautosmechanical.com.au" hint="Replies to noreply@ senders land here." />
        <Row k="RESEND_WEBHOOK_SECRET" label="Webhook secret" secret hint="Set the same value on the Resend webhook (URL below) so bounces/complaints auto-opt-out." />
        <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <button onClick={() => saveCard('email', ['RESEND_API_KEY', 'RESEND_FROM', 'RESEND_CAMPAIGN_FROM', 'RESEND_REPLY_TO', 'RESEND_WEBHOOK_SECRET'])} disabled={savingCard === 'email'} style={btn(T.accent)}>{savingCard === 'email' ? 'Saving…' : 'Save'}</button>
          <input value={testEmailTo} onChange={e => setTestEmailTo(e.target.value)} placeholder="you@example.com" style={{ ...inp, width: 200 }} />
          <button onClick={() => runTest('test_email', testEmailTo)} disabled={testing === 'test_email'} style={btn(`${T.teal}22`, T.teal)}>{testing === 'test_email' ? 'Sending…' : 'Send test email'}</button>
        </div>
      </Card>

      {/* Website intake */}
      <Card title="🌐 Website lead intake" desc="The website's quote/contact form posts leads into the CRM with this shared token (round-robin assigns the owner). The form and the portal must hold the SAME token.">
        <div style={{ fontSize: 10, fontWeight: 600, color: T.text3, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>
          Token <span style={{ marginLeft: 6 }}><SourceBadge f={fields.CRM_INTAKE_TOKEN} /></span>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
          <code style={{ flex: 1, fontSize: 11, fontFamily: 'monospace', color: T.text2, background: T.bg3, padding: '7px 10px', borderRadius: 5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {intakeToken || '— not set —'}
          </code>
          {intakeToken && <button onClick={() => copy(intakeToken, 'Token')} style={btn(`${T.blue}22`, T.blue)}>Copy</button>}
          <button onClick={regenToken} disabled={testing === 'regen'} style={btn(`${T.amber}22`, T.amber)} title="Generates a new token — the website form must be updated to match or intake stops">{testing === 'regen' ? '…' : intakeToken ? 'Regenerate' : 'Generate'}</button>
        </div>
        <Row k="CRM_INTAKE_TOKEN" label="Or paste a custom token" placeholder="paste the token the website already uses" />
        <button onClick={() => saveCard('intake', ['CRM_INTAKE_TOKEN'])} disabled={savingCard === 'intake'} style={btn(T.accent)}>{savingCard === 'intake' ? 'Saving…' : 'Save'}</button>
      </Card>

      {/* API endpoints reference */}
      <Card title="🔌 API endpoints" desc="The URLs external systems connect to. Click to copy.">
        {[
          { label: 'Website lead intake (POST + x-crm-token header)', url: `${baseUrl}/api/crm/intake` },
          { label: 'Resend webhook (set in Resend → Webhooks)', url: `${baseUrl}/api/crm/resend-webhook?key=<webhook secret>` },
          { label: 'Automation webhooks (per-flow URL — open the flow’s trigger node)', url: `${baseUrl}/api/crm/automation-hooks/<flow token>` },
        ].map(e => (
          <div key={e.label} style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 10, color: T.text3, marginBottom: 3 }}>{e.label}</div>
            <code onClick={() => copy(e.url, 'URL')} title="Click to copy"
              style={{ display: 'block', fontSize: 11, fontFamily: 'monospace', color: T.text2, background: T.bg3, padding: '7px 10px', borderRadius: 5, cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {e.url}
            </code>
          </div>
        ))}
        <div style={{ fontSize: 10, color: T.text3, marginTop: 12, lineHeight: 1.5, borderTop: `1px solid ${T.border}`, paddingTop: 10 }}>
          MYOB connects via OAuth on the <strong>MYOB Connection</strong> sub-tab. Microsoft Graph, Stripe, MachShip, Deepgram and push keys stay in Vercel env (rarely change) — their live status is on the <strong>Health</strong> sub-tab.
        </div>
      </Card>
    </div>
  )
}
