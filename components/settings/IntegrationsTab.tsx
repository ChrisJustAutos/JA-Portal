// components/settings/IntegrationsTab.tsx
// Self-service integration credentials — Settings → Connections → Integrations.
// Paste API keys, hit test, connected: ClickSend (SMS), Resend (mail-outs)
// and the website lead intake token. Values save to integration_settings
// (the comms libs read DB-first, env fallback) so no Vercel access is needed.
//
// Layout: single column of uniform cards — header (icon · title · status
// chip), aligned label/field rows, divider, footer with Save on the left and
// the live-test control on the right.

import { useEffect, useState } from 'react'
import { T } from '../../lib/ui/theme'
import { useToast } from '../ui/Feedback'

interface FieldInfo { source: 'db' | 'env' | null; preview: string }
type Fields = Record<string, FieldInfo>

const LABEL_W = 170
const inp: React.CSSProperties = { width: '100%', boxSizing: 'border-box', background: T.bg3, border: `1px solid ${T.border}`, color: T.text, borderRadius: 6, padding: '7px 10px', fontSize: 12, fontFamily: 'inherit', outline: 'none' }
const btn = (bg: string, fg = '#fff'): React.CSSProperties => ({ padding: '7px 16px', borderRadius: 6, fontSize: 12, fontWeight: 600, background: bg, color: fg, border: 'none', cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' })

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
        toast('Saved — live within ~30 seconds', 'success')
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

  // ── Building blocks ─────────────────────────────────────────────────
  function StatusChip({ on }: { on: boolean }) {
    const c = on ? T.green : T.text3
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 10px', borderRadius: 12, background: `${c}18`, border: `1px solid ${c}40`, color: c, fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: c }} />
        {on ? 'Connected' : 'Not configured'}
      </span>
    )
  }

  function Source({ f }: { f?: FieldInfo }) {
    if (!f?.source) return null
    return (
      <span style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: f.source === 'db' ? T.green : T.blue, whiteSpace: 'nowrap' }}>
        {f.source === 'db' ? 'set here' : 'env'}
      </span>
    )
  }

  function Row({ k, label, secret, placeholder, hint }: { k: string; label: string; secret?: boolean; placeholder?: string; hint?: string }) {
    const f = fields[k]
    return (
      <div style={{ display: 'grid', gridTemplateColumns: `${LABEL_W}px 1fr`, gap: 12, alignItems: 'start', padding: '7px 0' }}>
        <div style={{ paddingTop: 8 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: T.text2 }}>{label}</div>
          <Source f={f} />
        </div>
        <div>
          <input
            type={secret ? 'password' : 'text'}
            autoComplete="off" data-lpignore="true" data-1p-ignore="true" data-form-type="other"
            value={edits[k] ?? (secret ? '' : (f?.source ? f.preview : ''))}
            onChange={e => setEdit(k, e.target.value)}
            placeholder={secret ? (f?.source ? `${f.preview} — type to replace` : (placeholder || '')) : (placeholder || '')}
            style={inp}
          />
          {hint && <div style={{ fontSize: 10, color: T.text3, marginTop: 4, lineHeight: 1.45 }}>{hint}</div>}
        </div>
      </div>
    )
  }

  function Card({ icon, title, desc, connected, children, footer }: {
    icon: string; title: string; desc: string; connected?: boolean
    children: React.ReactNode; footer?: React.ReactNode
  }) {
    return (
      <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 12, overflow: 'hidden' }}>
        <div style={{ padding: '14px 18px', borderBottom: `1px solid ${T.border}`, display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 16 }}>{icon}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: T.text }}>{title}</div>
            <div style={{ fontSize: 11, color: T.text3, marginTop: 2, lineHeight: 1.4 }}>{desc}</div>
          </div>
          {connected !== undefined && <StatusChip on={connected} />}
        </div>
        <div style={{ padding: '8px 18px' }}>{children}</div>
        {footer && (
          <div style={{ padding: '12px 18px', borderTop: `1px solid ${T.border}`, background: T.bg3, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            {footer}
          </div>
        )}
      </div>
    )
  }

  if (loading) return <div style={{ color: T.text3, padding: 30, textAlign: 'center', fontSize: 13 }}>Loading integrations…</div>

  const smsConnected = !!(fields.CLICKSEND_USERNAME?.source && fields.CLICKSEND_API_KEY?.source)
  const mailConnected = !!fields.RESEND_API_KEY?.source
  const intakeToken = fields.CRM_INTAKE_TOKEN?.source ? fields.CRM_INTAKE_TOKEN.preview : ''

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 760 }}>
      {/* SMS — ClickSend */}
      <Card icon="📱" title="SMS — ClickSend" connected={smsConnected}
        desc="Booking & service reminders, CRM automations, quick SMS. Credentials: clicksend.com → Developers → API Credentials."
        footer={<>
          <button onClick={() => saveCard('sms', ['CLICKSEND_USERNAME', 'CLICKSEND_API_KEY', 'CLICKSEND_FROM'])} disabled={savingCard === 'sms'} style={btn(T.accent)}>{savingCard === 'sms' ? 'Saving…' : 'Save'}</button>
          <span style={{ flex: 1 }} />
          <input value={testSmsTo} onChange={e => setTestSmsTo(e.target.value)} placeholder="04xx xxx xxx" style={{ ...inp, width: 150 }} />
          <button onClick={() => runTest('test_sms', testSmsTo)} disabled={testing === 'test_sms'} style={btn(`${T.teal}22`, T.teal)}>{testing === 'test_sms' ? 'Sending…' : 'Send test SMS'}</button>
        </>}>
        <Row k="CLICKSEND_USERNAME" label="Username" placeholder="ClickSend account username" />
        <Row k="CLICKSEND_API_KEY" label="API key" secret placeholder="xxxxxxxx-xxxx-…" />
        <Row k="CLICKSEND_FROM" label="Sender ID" placeholder="JustAutos (optional)" hint="Name shown on the customer's phone. Leave blank for a shared number — replies only work with a number." />
      </Card>

      {/* Email — Resend */}
      <Card icon="✉️" title="Mail-outs — Resend" connected={mailConnected}
        desc="All outbound email: invoices, quotes, automations, campaigns. API key: resend.com → API Keys. From-domains must be verified in Resend → Domains."
        footer={<>
          <button onClick={() => saveCard('email', ['RESEND_API_KEY', 'RESEND_FROM', 'RESEND_CAMPAIGN_FROM', 'RESEND_REPLY_TO', 'RESEND_WEBHOOK_SECRET'])} disabled={savingCard === 'email'} style={btn(T.accent)}>{savingCard === 'email' ? 'Saving…' : 'Save'}</button>
          <span style={{ flex: 1 }} />
          <input value={testEmailTo} onChange={e => setTestEmailTo(e.target.value)} placeholder="you@example.com" style={{ ...inp, width: 210 }} />
          <button onClick={() => runTest('test_email', testEmailTo)} disabled={testing === 'test_email'} style={btn(`${T.teal}22`, T.teal)}>{testing === 'test_email' ? 'Sending…' : 'Send test email'}</button>
        </>}>
        <Row k="RESEND_API_KEY" label="API key" secret placeholder="re_…" />
        <Row k="RESEND_FROM" label="From — transactional" placeholder="Just Autos <noreply@mail.justautos.app>" hint="Invoices, quotes and automations send from this address." />
        <Row k="RESEND_CAMPAIGN_FROM" label="From — campaigns" placeholder="Just Autos <news@news.justautos.app>" hint="Use a separate subdomain so bulk sends can't dent invoice deliverability." />
        <Row k="RESEND_REPLY_TO" label="Default reply-to" placeholder="accounts@justautosmechanical.com.au" hint="Replies to noreply@ senders land here." />
        <Row k="RESEND_WEBHOOK_SECRET" label="Webhook secret" secret hint="Set the same value on the Resend webhook (URL in the endpoints card below) so bounces auto-opt-out." />
      </Card>

      {/* Website intake */}
      <Card icon="🌐" title="Website lead intake" connected={!!intakeToken}
        desc="The website's quote form posts leads into the CRM with this shared token; round-robin assigns the owner. The form and the portal must hold the SAME token."
        footer={<>
          <button onClick={() => saveCard('intake', ['CRM_INTAKE_TOKEN'])} disabled={savingCard === 'intake'} style={btn(T.accent)}>{savingCard === 'intake' ? 'Saving…' : 'Save'}</button>
          <span style={{ flex: 1 }} />
          {intakeToken && <button onClick={() => copy(intakeToken, 'Token')} style={btn(`${T.blue}22`, T.blue)}>Copy token</button>}
          <button onClick={regenToken} disabled={testing === 'regen'} style={btn(`${T.amber}22`, T.amber)} title="Generates a new token — update the website form to match or intake stops">
            {testing === 'regen' ? '…' : intakeToken ? 'Regenerate' : 'Generate'}
          </button>
        </>}>
        <div style={{ display: 'grid', gridTemplateColumns: `${LABEL_W}px 1fr`, gap: 12, alignItems: 'center', padding: '7px 0' }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: T.text2 }}>Current token <span style={{ marginLeft: 4 }}><Source f={fields.CRM_INTAKE_TOKEN} /></span></div>
          <code style={{ fontSize: 11, fontFamily: 'monospace', color: T.text2, background: T.bg3, padding: '7px 10px', borderRadius: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {intakeToken || '— not set —'}
          </code>
        </div>
        <Row k="CRM_INTAKE_TOKEN" label="Set a custom token" placeholder="paste the token the website already uses" />
      </Card>

      {/* API endpoints reference */}
      <Card icon="🔌" title="API endpoints" desc="The URLs external systems connect to — click any to copy.">
        {[
          { label: 'Website lead intake', sub: 'POST + x-crm-token header', url: `${baseUrl}/api/crm/intake` },
          { label: 'Resend webhook', sub: 'set in Resend → Webhooks', url: `${baseUrl}/api/crm/resend-webhook?key=<webhook secret>` },
          { label: 'Automation webhooks', sub: 'per-flow URL — open the flow’s trigger node', url: `${baseUrl}/api/crm/automation-hooks/<flow token>` },
        ].map(e => (
          <div key={e.label} style={{ display: 'grid', gridTemplateColumns: `${LABEL_W}px 1fr`, gap: 12, alignItems: 'center', padding: '7px 0' }}>
            <div>
              <div style={{ fontSize: 11, fontWeight: 600, color: T.text2 }}>{e.label}</div>
              <div style={{ fontSize: 9, color: T.text3 }}>{e.sub}</div>
            </div>
            <code onClick={() => copy(e.url, 'URL')} title="Click to copy"
              style={{ display: 'block', fontSize: 11, fontFamily: 'monospace', color: T.text2, background: T.bg3, padding: '7px 10px', borderRadius: 6, cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {e.url}
            </code>
          </div>
        ))}
        <div style={{ fontSize: 10, color: T.text3, margin: '10px 0 6px', lineHeight: 1.5 }}>
          MYOB connects via OAuth on the <strong>MYOB Connection</strong> sub-tab. Microsoft Graph, Stripe, MachShip, Deepgram and push keys stay in Vercel env (rarely change) — live status on the <strong>Health</strong> sub-tab.
        </div>
      </Card>
    </div>
  )
}
