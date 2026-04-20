// components/settings/MyobTab.tsx
// Admin-only MYOB connection management.
//  - Shows current connection status (connected / expired / no CF selected / disconnected)
//  - "Connect MYOB" button → redirects to /api/myob/auth/connect
//  - Company file picker (after OAuth, before the connection is usable)
//  - Test button — hits /api/myob/test/invoice to verify end-to-end

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/router'

const T = {
  bg:'#0d0f12', bg2:'#131519', bg3:'#1a1d23', bg4:'#21252d',
  border:'rgba(255,255,255,0.07)', border2:'rgba(255,255,255,0.12)',
  text:'#e8eaf0', text2:'#8b90a0', text3:'#545968',
  blue:'#4f8ef7', teal:'#2dd4bf', green:'#34c77b',
  amber:'#f5a623', red:'#f04e4e', purple:'#a78bfa', accent:'#4f8ef7',
}

interface ConnectionSummary {
  id: string
  label: string
  company_file_id: string | null
  company_file_name: string | null
  company_file_username: string | null
  connected_at: string
  last_refreshed_at: string | null
  last_used_at: string | null
  access_expires_at: string
  is_active: boolean
  has_cf_selected: boolean
}

interface CompanyFile {
  Id: string
  Name: string
  Uri: string
  ProductVersion: string
  LibraryPath: string
  Country?: string
}

export default function MyobTab() {
  const router = useRouter()
  const [loading, setLoading] = useState(true)
  const [connections, setConnections] = useState<ConnectionSummary[]>([])
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')

  // CF picker state
  const [cfPickerFor, setCfPickerFor] = useState<string | null>(null)  // conn id
  const [cfLoading, setCfLoading] = useState(false)
  const [companyFiles, setCompanyFiles] = useState<CompanyFile[]>([])
  const [selectedCfId, setSelectedCfId] = useState('')
  const [cfUsername, setCfUsername] = useState('Administrator')
  const [cfPassword, setCfPassword] = useState('')

  // Test state
  const [testing, setTesting] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<any | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const r = await fetch('/api/myob/connections')
      if (!r.ok) throw new Error((await r.json()).error || 'Load failed')
      const d = await r.json()
      setConnections(d.connections || [])
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])

  // Show "just connected" flash message from the callback redirect
  useEffect(() => {
    if (router.query.connected) {
      setInfo(`Connected to MYOB as "${router.query.connected}". Now pick a company file below.`)
      router.replace({ pathname: '/settings', query: { tab: 'myob' } }, undefined, { shallow: true })
    }
  }, [router])

  function connect() {
    const label = prompt('Label for this MYOB connection (e.g. "JAWS" or "VPS"):', 'JAWS')
    if (!label) return
    window.location.href = `/api/myob/auth/connect?label=${encodeURIComponent(label)}`
  }

  async function loadCompanyFiles(connId: string) {
    setCfPickerFor(connId); setCfLoading(true); setCompanyFiles([]); setError('')
    try {
      const r = await fetch(`/api/myob/connections?cfs=1&id=${connId}`)
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || 'Failed to load company files')
      setCompanyFiles(d.companyFiles || [])
      if (d.companyFiles?.length === 1) setSelectedCfId(d.companyFiles[0].Id)
    } catch (e: any) { setError(e.message) }
    finally { setCfLoading(false) }
  }

  async function saveCf(connId: string) {
    if (!selectedCfId) return
    setError('')
    try {
      const r = await fetch('/api/myob/connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: connId, cfId: selectedCfId, cfUsername, cfPassword }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || 'Failed to save')
      setInfo(`Company file "${d.companyFile.name}" selected.`)
      setCfPickerFor(null)
      await load()
    } catch (e: any) { setError(e.message) }
  }

  async function disconnect(id: string, label: string) {
    if (!confirm(`Disconnect MYOB connection "${label}"? Portal features that depend on it will stop working.`)) return
    try {
      const r = await fetch(`/api/myob/connections?id=${id}`, { method: 'DELETE' })
      if (!r.ok) throw new Error((await r.json()).error || 'Disconnect failed')
      setInfo(`Connection "${label}" disconnected.`)
      await load()
    } catch (e: any) { setError(e.message) }
  }

  async function test(label: string) {
    setTesting(label); setTestResult(null); setError('')
    try {
      const r = await fetch(`/api/myob/test/invoice?label=${encodeURIComponent(label)}`)
      const d = await r.json()
      setTestResult({ ok: r.ok, data: d })
    } catch (e: any) { setError(e.message) }
    finally { setTesting(null) }
  }

  function fmtDate(s: string | null) {
    if (!s) return '—'
    const d = new Date(s)
    if (isNaN(d.getTime())) return s
    return d.toLocaleString('en-AU', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' })
  }

  function fmtRel(s: string | null) {
    if (!s) return '—'
    const t = new Date(s).getTime()
    const diff = t - Date.now()
    const min = Math.round(diff / 60_000)
    if (Math.abs(min) < 60) return min >= 0 ? `in ${min}m` : `${Math.abs(min)}m ago`
    const hr = Math.round(diff / 3_600_000)
    if (Math.abs(hr) < 24) return hr >= 0 ? `in ${hr}h` : `${Math.abs(hr)}h ago`
    const days = Math.round(diff / 86_400_000)
    return days >= 0 ? `in ${days}d` : `${Math.abs(days)}d ago`
  }

  if (loading) return <div style={{padding:40, textAlign:'center', color:T.text3}}>Loading…</div>

  return (
    <div style={{display:'flex', flexDirection:'column', gap:16, maxWidth:1000}}>
      <div>
        <h2 style={{margin:'0 0 6px', fontSize:18, fontWeight:600}}>MYOB Direct Connection</h2>
        <p style={{margin:0, fontSize:13, color:T.text2, lineHeight:1.5}}>
          Connect the portal directly to MYOB AccountRight via OAuth 2.0. This replaces the
          CData path over time and unlocks write operations (purchase bills, invoice creation).
          <br/>
          <strong style={{color:T.text}}>Stage 1</strong> — prove OAuth works and we can read a single invoice end-to-end.
        </p>
      </div>

      {error && <div style={{background:'rgba(240,78,78,0.1)', border:`1px solid ${T.red}40`, borderRadius:8, padding:'10px 14px', color:T.red, fontSize:13}}>{error}</div>}
      {info  && <div style={{background:'rgba(52,199,123,0.1)', border:`1px solid ${T.green}40`, borderRadius:8, padding:'10px 14px', color:T.green, fontSize:13}}>{info}</div>}

      {/* Connect button */}
      <div style={{background:T.bg2, border:`1px solid ${T.border}`, borderRadius:12, padding:20}}>
        <div style={{display:'flex', alignItems:'center', gap:12}}>
          <div style={{flex:1}}>
            <div style={{fontSize:14, fontWeight:600, marginBottom:4}}>New connection</div>
            <div style={{fontSize:12, color:T.text3}}>
              Starts the OAuth flow. You&apos;ll sign in at MYOB, grant access, and come back here.
              Requires the <code style={{background:T.bg3, padding:'1px 5px', borderRadius:3}}>MYOB_CLIENT_ID</code>, <code style={{background:T.bg3, padding:'1px 5px', borderRadius:3}}>MYOB_CLIENT_SECRET</code>, and <code style={{background:T.bg3, padding:'1px 5px', borderRadius:3}}>MYOB_REDIRECT_URI</code> env vars to be set in Vercel.
            </div>
          </div>
          <button onClick={connect}
            style={{padding:'10px 18px', borderRadius:6, border:'none', background:T.accent, color:'#fff', fontSize:13, fontFamily:'inherit', cursor:'pointer', fontWeight:600, flexShrink:0}}>
            + Connect MYOB
          </button>
        </div>
      </div>

      {/* Connection list */}
      {connections.length === 0 && (
        <div style={{background:T.bg2, border:`1px dashed ${T.border2}`, borderRadius:12, padding:40, textAlign:'center', color:T.text3}}>
          No MYOB connections yet. Click &quot;+ Connect MYOB&quot; above to set one up.
        </div>
      )}
      {connections.map(c => {
        const expiresMs = new Date(c.access_expires_at).getTime()
        const tokenExpired = expiresMs < Date.now()
        const isReady = c.is_active && c.has_cf_selected
        const statusColor = !c.is_active ? T.text3 : !c.has_cf_selected ? T.amber : T.green
        const statusLabel = !c.is_active ? 'Disconnected' : !c.has_cf_selected ? 'Needs company file' : 'Ready'
        return (
          <div key={c.id} style={{background:T.bg2, border:`1px solid ${T.border}`, borderLeft:`3px solid ${statusColor}`, borderRadius:12, padding:20}}>
            <div style={{display:'flex', alignItems:'center', gap:12, marginBottom:12}}>
              <div style={{fontSize:16, fontWeight:600}}>{c.label}</div>
              <span style={{fontSize:10, padding:'3px 10px', borderRadius:10, background:`${statusColor}22`, color:statusColor, border:`1px solid ${statusColor}50`, textTransform:'uppercase', fontWeight:600, letterSpacing:'0.05em'}}>{statusLabel}</span>
              <div style={{flex:1}}/>
              {isReady && (
                <button onClick={() => test(c.label)} disabled={testing === c.label}
                  style={{padding:'6px 14px', borderRadius:5, border:`1px solid ${T.border2}`, background:'transparent', color:T.text2, fontSize:12, fontFamily:'inherit', cursor: testing === c.label ? 'wait' : 'pointer'}}>
                  {testing === c.label ? 'Testing…' : 'Test'}
                </button>
              )}
              <button onClick={() => disconnect(c.id, c.label)}
                style={{padding:'6px 12px', borderRadius:5, border:`1px solid ${T.red}40`, background:'transparent', color:T.red, fontSize:12, fontFamily:'inherit', cursor:'pointer'}}>
                Disconnect
              </button>
            </div>

            <div style={{display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(220px, 1fr))', gap:12, fontSize:12, color:T.text2}}>
              <div>
                <div style={{fontSize:10, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em'}}>Company File</div>
                <div style={{marginTop:2, color: c.company_file_name ? T.text : T.amber}}>{c.company_file_name || '— not selected —'}</div>
              </div>
              <div>
                <div style={{fontSize:10, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em'}}>Connected</div>
                <div style={{marginTop:2}}>{fmtDate(c.connected_at)}</div>
              </div>
              <div>
                <div style={{fontSize:10, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em'}}>Token Expires</div>
                <div style={{marginTop:2, color: tokenExpired ? T.amber : T.text2}}>{fmtRel(c.access_expires_at)} {tokenExpired && '(auto-refreshes on next call)'}</div>
              </div>
              <div>
                <div style={{fontSize:10, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em'}}>Last Used</div>
                <div style={{marginTop:2}}>{c.last_used_at ? fmtRel(c.last_used_at) : 'Never'}</div>
              </div>
            </div>

            {/* CF picker */}
            {!c.has_cf_selected && c.is_active && (
              <div style={{marginTop:16, padding:14, background:T.bg3, borderRadius:8, border:`1px solid ${T.amber}40`}}>
                <div style={{fontSize:13, fontWeight:600, color:T.amber, marginBottom:8}}>Select company file</div>
                {cfPickerFor !== c.id ? (
                  <button onClick={() => loadCompanyFiles(c.id)}
                    style={{padding:'7px 14px', borderRadius:5, border:`1px solid ${T.amber}`, background:'transparent', color:T.amber, fontSize:12, cursor:'pointer', fontFamily:'inherit', fontWeight:600}}>
                    Load company files
                  </button>
                ) : cfLoading ? (
                  <div style={{color:T.text3, fontSize:12}}>Loading company files from MYOB…</div>
                ) : (
                  <div>
                    <div style={{display:'flex', flexDirection:'column', gap:6, marginBottom:12}}>
                      {companyFiles.map(cf => (
                        <label key={cf.Id} style={{display:'flex', alignItems:'center', gap:10, padding:'8px 10px', background:T.bg4, borderRadius:6, cursor:'pointer', border:`1px solid ${selectedCfId === cf.Id ? T.accent : T.border}`}}>
                          <input type="radio" name="cf" value={cf.Id} checked={selectedCfId === cf.Id} onChange={e => setSelectedCfId(e.target.value)}/>
                          <div style={{flex:1}}>
                            <div style={{fontSize:13, fontWeight:500}}>{cf.Name}</div>
                            <div style={{fontSize:10, color:T.text3, fontFamily:'monospace'}}>{cf.LibraryPath} · {cf.ProductVersion}</div>
                          </div>
                        </label>
                      ))}
                      {companyFiles.length === 0 && <div style={{color:T.text3, fontSize:12}}>No company files returned.</div>}
                    </div>
                    <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:8, marginBottom:10}}>
                      <div>
                        <div style={{fontSize:10, color:T.text3, marginBottom:4}}>CF Username</div>
                        <input type="text" value={cfUsername} onChange={e => setCfUsername(e.target.value)}
                          style={{width:'100%', padding:'7px 10px', background:T.bg4, border:`1px solid ${T.border2}`, color:T.text, borderRadius:5, fontSize:12, fontFamily:'inherit', outline:'none', boxSizing:'border-box'}}/>
                      </div>
                      <div>
                        <div style={{fontSize:10, color:T.text3, marginBottom:4}}>CF Password (blank if none)</div>
                        <input type="password" value={cfPassword} onChange={e => setCfPassword(e.target.value)}
                          style={{width:'100%', padding:'7px 10px', background:T.bg4, border:`1px solid ${T.border2}`, color:T.text, borderRadius:5, fontSize:12, fontFamily:'inherit', outline:'none', boxSizing:'border-box'}}/>
                      </div>
                    </div>
                    <button onClick={() => saveCf(c.id)} disabled={!selectedCfId}
                      style={{padding:'8px 18px', borderRadius:5, border:'none', background: selectedCfId ? T.accent : T.bg4, color: selectedCfId ? '#fff' : T.text3, fontSize:12, cursor: selectedCfId ? 'pointer' : 'not-allowed', fontFamily:'inherit', fontWeight:600}}>
                      Save company file
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Test result */}
            {testResult && testing === null && (
              <div style={{marginTop:12, padding:14, background:T.bg3, borderRadius:8, border:`1px solid ${testResult.ok ? T.green + '40' : T.red + '40'}`}}>
                <div style={{fontSize:13, fontWeight:600, color: testResult.ok ? T.green : T.red, marginBottom:8}}>
                  {testResult.ok ? '✓ Test passed' : '✗ Test failed'}
                </div>
                <pre style={{margin:0, fontSize:11, fontFamily:'monospace', color:T.text2, whiteSpace:'pre-wrap', wordBreak:'break-word', maxHeight:240, overflow:'auto'}}>
                  {JSON.stringify(testResult.data, null, 2)}
                </pre>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
