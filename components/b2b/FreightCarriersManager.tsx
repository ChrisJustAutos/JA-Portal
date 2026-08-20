// components/b2b/FreightCarriersManager.tsx
// Admin UI for connecting B2B freight carriers (Shippit, StarShipIT,
// AusPost, Sendle). Each carrier gets a card with: connection status,
// last-test result, and Connect / Edit / Test / Disconnect actions.
//
// This pass is credentials only — once a connection is saved and tested
// green, the actual quote/book/label endpoints get wired in follow-ups.
// Until then b2b_freight_zones (manual postcode rates) stays the
// fallback at checkout.
// Restyled onto the shared Alloy kit (components/b2b/ui) 2026-08-12.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useConfirm } from '../ui/Feedback'
import { T, alpha } from '../../lib/ui/theme'
import { A, Btn, StatusPill, Banner, inputStyle, RADIUS } from './ui'

interface CarrierField {
  key: string
  label: string
  hint: string | null
  type: 'text' | 'secret'
  required: boolean
}

interface Carrier {
  provider: string
  label: string
  blurb: string
  docsUrl: string
  environments: ('live' | 'sandbox')[]
  fields: CarrierField[]
  connected: boolean
  is_active: boolean
  environment: 'live' | 'sandbox'
  credentials: Record<string, string>
  last_test_at: string | null
  last_test_ok: boolean | null
  last_test_error: string | null
  updated_at: string | null
}

function relativeTime(iso: string | null): string {
  if (!iso) return 'never'
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 0) return 'in the future'
  if (ms < 60_000)     return `${Math.floor(ms/1_000)}s ago`
  if (ms < 3_600_000)  return `${Math.floor(ms/60_000)}m ago`
  if (ms < 86_400_000) return `${Math.floor(ms/3_600_000)}h ago`
  return `${Math.floor(ms/86_400_000)}d ago`
}

export default function FreightCarriersManager() {
  const [carriers, setCarriers] = useState<Carrier[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [openProvider, setOpenProvider] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const r = await fetch('/api/b2b/admin/freight-carriers', { credentials: 'same-origin' })
      const j = await r.json()
      if (!r.ok) throw new Error(j?.error || 'Load failed')
      setCarriers(j.carriers || [])
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])

  const anyConnected = useMemo(() => carriers.some(c => c.connected && c.is_active), [carriers])

  return (
    <div>
      <div style={{display:'flex', alignItems:'center', gap:10, marginBottom:6}}>
        <div style={{fontSize:14, fontWeight:650, color:T.text, flex:1}}>Carrier connections</div>
        <StatusPill color={anyConnected ? A.good : T.text3}>
          {anyConnected
            ? `${carriers.filter(c => c.connected && c.is_active).length} connected`
            : 'None connected'}
        </StatusPill>
      </div>
      <div style={{fontSize:12.5, color:T.text3, marginBottom:14, lineHeight:1.5}}>
        Save credentials so we can call each carrier's API. Once a connection tests green, we'll wire that
        carrier's live quote and booking into the cart and admin order screens. Until then the postcode
        zones below are what distributors see at checkout.
      </div>

      {error && (
        <div style={{marginBottom:10}}>
          <Banner tone="error">{error}</Banner>
        </div>
      )}

      {loading && carriers.length === 0 && (
        <div style={{fontSize:12.5, color:T.text3, padding:'10px 0'}}>Loading carriers…</div>
      )}

      {carriers.map(c => (
        <CarrierCard
          key={c.provider}
          carrier={c}
          isOpen={openProvider === c.provider}
          onToggle={() => setOpenProvider(p => p === c.provider ? null : c.provider)}
          onChanged={() => { void load() }}
        />
      ))}
    </div>
  )
}

// ─── Single carrier card ────────────────────────────────────────────

function CarrierCard({ carrier, isOpen, onToggle, onChanged }: {
  carrier: Carrier
  isOpen: boolean
  onToggle: () => void
  onChanged: () => void
}) {
  const status: 'connected' | 'error' | 'never_tested' | 'disconnected' =
    !carrier.connected ? 'disconnected'
    : carrier.last_test_at == null ? 'never_tested'
    : carrier.last_test_ok ? 'connected'
    : 'error'

  const statusMeta: Record<typeof status, { label: string; color: string }> = {
    connected:    { label: 'Connected',      color: A.good },
    error:        { label: 'Last test failed', color: A.bad },
    never_tested: { label: 'Not tested yet', color: A.warn },
    disconnected: { label: 'Not connected',  color: T.text3 },
  }
  const meta = statusMeta[status]

  return (
    <div style={{
      marginBottom:10, padding:'14px 16px',
      background: T.bg3,
      border: `1px solid ${isOpen ? T.border2 : 'transparent'}`,
      borderRadius:RADIUS.sm + 2,
      opacity: carrier.connected && !carrier.is_active ? 0.6 : 1,
    }}>
      <div style={{display:'flex', alignItems:'center', gap:12, flexWrap:'wrap'}}>
        <div style={{flex:1, minWidth:200}}>
          <div style={{display:'flex', alignItems:'center', gap:8, flexWrap:'wrap'}}>
            <strong style={{fontSize:13, color:T.text}}>{carrier.label}</strong>
            <StatusPill color={meta.color}>{meta.label}</StatusPill>
            {carrier.connected && (
              <span style={{fontSize:12, color:T.text3, fontFamily:'monospace'}}>
                {carrier.environment}
              </span>
            )}
          </div>
          <div style={{fontSize:12.5, color:T.text3, marginTop:3, lineHeight:1.4}}>
            {carrier.blurb}
          </div>
          {status === 'error' && carrier.last_test_error && (
            <div style={{fontSize:12, color:A.bad, marginTop:5, fontFamily:'monospace'}}>
              {carrier.last_test_error}
            </div>
          )}
          {status === 'connected' && carrier.last_test_at && (
            <div style={{fontSize:12, color:T.text3, marginTop:3}}>
              Last tested {relativeTime(carrier.last_test_at)}
            </div>
          )}
        </div>
        <Btn variant="ghost" size="sm" onClick={onToggle}>
          {isOpen ? 'Close' : carrier.connected ? 'Edit' : 'Connect'}
        </Btn>
      </div>

      {isOpen && (
        <CarrierForm carrier={carrier} onChanged={onChanged} onClose={onToggle}/>
      )}
    </div>
  )
}

// ─── Edit form (also handles Test + Disconnect) ─────────────────────

function CarrierForm({ carrier, onChanged, onClose }: {
  carrier: Carrier
  onChanged: () => void
  onClose: () => void
}) {
  const confirmDialog = useConfirm()
  const [env, setEnv] = useState<'live' | 'sandbox'>(carrier.environment)
  const [isActive, setIsActive] = useState<boolean>(carrier.is_active || !carrier.connected)
  const [values, setValues] = useState<Record<string, string>>({ ...carrier.credentials })
  const [savingMsg, setSavingMsg] = useState<string | null>(null)
  const [err, setErr] = useState('')
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null)

  async function save() {
    setSavingMsg('Saving…'); setErr(''); setTestMsg(null)
    try {
      const r = await fetch(`/api/b2b/admin/freight-carriers/${carrier.provider}`, {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          environment: env,
          is_active:   isActive,
          credentials: values,
        }),
      })
      const j = await r.json()
      if (!r.ok) throw new Error(j?.error || 'Save failed')
      setSavingMsg('Saved · running test…')
      // Run a test immediately so the admin gets feedback in one click.
      await runTest()
      onChanged()
    } catch (e: any) {
      setErr(e?.message || 'save failed')
    } finally {
      setSavingMsg(null)
    }
  }

  async function runTest() {
    setErr(''); setTestMsg(null)
    try {
      const r = await fetch(`/api/b2b/admin/freight-carriers/${carrier.provider}/test`, {
        method: 'POST',
        credentials: 'same-origin',
      })
      const j = await r.json()
      if (!r.ok) {
        setTestMsg({ ok: false, text: j?.error || `HTTP ${r.status}` })
      } else {
        setTestMsg({ ok: !!j.ok, text: j.message || (j.ok ? 'Connected' : 'Test failed') })
      }
      onChanged()
    } catch (e: any) {
      setTestMsg({ ok: false, text: e?.message || 'Test failed' })
    }
  }

  async function disconnect() {
    if (!(await confirmDialog({ title: `Disconnect ${carrier.label}?`, message: 'Stored credentials will be deleted.', danger: true }))) return
    setErr('')
    try {
      const r = await fetch(`/api/b2b/admin/freight-carriers/${carrier.provider}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(j?.error || 'Disconnect failed')
      onChanged()
      onClose()
    } catch (e: any) {
      setErr(e?.message || 'disconnect failed')
    }
  }

  // Credential inputs sit on bg3, so lift them one surface.
  const fieldInput: React.CSSProperties = { ...inputStyle(), background: T.bg2, fontSize: 14 }

  return (
    <div style={{
      marginTop:14, paddingTop:14,
      borderTop:`1px solid ${T.border}`,
      display:'flex', flexDirection:'column', gap:12,
    }}>
      {/* Field grid */}
      <div style={{display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(220px,1fr))', gap:12}}>
        {carrier.fields.map(f => (
          <label key={f.key} style={{display:'flex', flexDirection:'column', gap:5}}>
            <span style={{fontSize:12, color:T.text2, fontWeight:650}}>
              {f.label}{f.required && <span style={{color:T.text3}}> *</span>}
            </span>
            <input
              type={f.type === 'secret' ? 'password' : 'text'}
              value={values[f.key] || ''}
              onChange={e => setValues(v => ({ ...v, [f.key]: e.target.value }))}
              autoComplete="off"
              spellCheck={false}
              style={fieldInput}
            />
            {f.hint && <span style={{fontSize:12, color:T.text3, lineHeight:1.45}}>{f.hint}</span>}
          </label>
        ))}

        {carrier.environments.length > 1 && (
          <label style={{display:'flex', flexDirection:'column', gap:5}}>
            <span style={{fontSize:12, color:T.text2, fontWeight:650}}>Environment</span>
            <select value={env} onChange={e => setEnv(e.target.value as 'live' | 'sandbox')}
              style={{...fieldInput, cursor:'pointer'}}>
              {carrier.environments.map(e => (
                <option key={e} value={e}>{e === 'live' ? 'Live (production)' : 'Sandbox (test)'}</option>
              ))}
            </select>
            <span style={{fontSize:12, color:T.text3, lineHeight:1.45}}>Each environment uses different credentials at the carrier.</span>
          </label>
        )}

        <label style={{display:'flex', flexDirection:'column', gap:5}}>
          <span style={{fontSize:12, color:T.text2, fontWeight:650}}>Status</span>
          <label style={{display:'flex', alignItems:'center', gap:6, color:T.text2, fontSize:13, cursor:'pointer'}}>
            <input type="checkbox" checked={isActive} onChange={e => setIsActive(e.target.checked)}/>
            Use this connection
          </label>
          <span style={{fontSize:12, color:T.text3, lineHeight:1.45}}>Uncheck to keep the credentials but skip this carrier at checkout.</span>
        </label>
      </div>

      {testMsg && (
        <Banner tone={testMsg.ok ? 'success' : 'error'}>
          {testMsg.ok ? '✓ ' : '✗ '}{testMsg.text}
        </Banner>
      )}

      {err && (
        <Banner tone="error">{err}</Banner>
      )}

      <div style={{display:'flex', gap:8, alignItems:'center', flexWrap:'wrap'}}>
        <Btn size="sm" onClick={save} disabled={!!savingMsg}>
          {savingMsg || (carrier.connected ? 'Save changes' : 'Connect')}
        </Btn>

        {carrier.connected && (
          <Btn variant="secondary" size="sm" onClick={runTest} disabled={!!savingMsg}>
            Test connection
          </Btn>
        )}

        <span style={{flex:1}}/>

        <a href={carrier.docsUrl} target="_blank" rel="noreferrer"
          style={{fontSize:12, color:T.text3, textDecoration:'underline'}}>
          {carrier.label} API docs ↗
        </a>

        {carrier.connected && (
          <button onClick={disconnect} disabled={!!savingMsg}
            className="al-press al-focus"
            style={{
              padding:'7px 14px', borderRadius:RADIUS.pill, minHeight:36,
              border:`1px solid ${alpha(A.bad,'40')}`, background:'transparent',
              color: A.bad, fontSize:13, fontWeight:600,
              cursor:'pointer', fontFamily:'inherit',
            }}>
            Disconnect
          </button>
        )}
      </div>
    </div>
  )
}
