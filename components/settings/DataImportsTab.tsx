// components/settings/DataImportsTab.tsx
// Unified upload hub for admin-only data imports.
// Sections:
//   1. Forecasting target           — monthly $ target line (org-wide setting)
//   2. Mechanics Desk Job Report    — manual upload + auto-pull status
//   3. Supplier Invoice PDF         — Claude-parsed invoice intake
//   4. Service tokens               — bearer tokens for external automation

import { useState, useEffect, useRef, useCallback } from 'react'
import Link from 'next/link'

const T = {
  bg2:'#131519', bg3:'#1a1d23', bg4:'#21252d',
  border:'rgba(255,255,255,0.07)', border2:'rgba(255,255,255,0.12)',
  text:'#e8eaf0', text2:'#8b90a0', text3:'#545968',
  blue:'#4f8ef7', teal:'#2dd4bf', green:'#34c77b', amber:'#f5a623', red:'#f04e4e', purple:'#a78bfa',
}

function fmtDate(iso: string | null | undefined) {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    if (isNaN(d.getTime())) return iso
    return d.toLocaleString('en-AU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })
  } catch { return iso }
}

async function fileToBase64(file: File): Promise<string> {
  const buf = await file.arrayBuffer()
  let binary = ''
  const bytes = new Uint8Array(buf)
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunkSize)) as any)
  }
  return btoa(binary)
}

// ═══════════════════════════════════════════════════════════════════
// FORECASTING TARGET CARD
// ═══════════════════════════════════════════════════════════════════

function ForecastingTargetCard() {
  const [target, setTarget] = useState<number | null>(null)
  const [draft, setDraft] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [updatedAt, setUpdatedAt] = useState<string | null>(null)
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await fetch('/api/admin/forecasting-target')
      const d = await r.json()
      setTarget(d.target_monthly || 0)
      setDraft(String(d.target_monthly || 0))
      setUpdatedAt(d.updated_at)
    } catch (e: any) { /* swallow */ }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  async function save() {
    const num = Number(draft.replace(/[$,\s]/g, ''))
    if (!isFinite(num) || num < 0) {
      setMessage({ kind: 'err', text: 'Must be a non-negative number' })
      return
    }
    setSaving(true); setMessage(null)
    try {
      const r = await fetch('/api/admin/forecasting-target', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_monthly: num }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || 'Save failed')
      setTarget(d.target_monthly)
      setMessage({ kind: 'ok', text: `Saved. New target: $${d.target_monthly.toLocaleString('en-AU')}/month` })
      setTimeout(() => setMessage(null), 3000)
      await load()
    } catch (e: any) {
      setMessage({ kind: 'err', text: e.message || 'Save failed' })
    } finally {
      setSaving(false)
    }
  }

  const dirty = String(target || 0) !== draft.replace(/[$,\s]/g, '')

  return (
    <div style={{background:T.bg2, border:`1px solid ${T.border}`, borderRadius:10, padding:20}}>
      <div style={{display:'flex', alignItems:'baseline', justifyContent:'space-between', gap:12, marginBottom:4}}>
        <h3 style={{margin:0, fontSize:14, fontWeight:600, color:T.text}}>Forecasting target</h3>
        <Link href="/forecasting" style={{fontSize:11, color:T.blue, textDecoration:'none'}}>View forecasting →</Link>
      </div>
      <div style={{fontSize:11, color:T.text3, marginBottom:14}}>
        Monthly $ target. Renders as a horizontal reference line on the Forecasting bar chart. Set to 0 to hide the line.
      </div>

      {loading ? (
        <div style={{fontSize:12, color:T.text3}}>Loading…</div>
      ) : (
        <>
          <div style={{display:'flex', gap:8, alignItems:'center'}}>
            <div style={{position:'relative', flex:1, maxWidth:280}}>
              <span style={{position:'absolute', left:10, top:'50%', transform:'translateY(-50%)', color:T.text3, fontSize:13, pointerEvents:'none'}}>$</span>
              <input
                type="text"
                inputMode="numeric"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && dirty && !saving) save() }}
                placeholder="e.g. 250000"
                style={{
                  width:'100%', padding:'8px 12px 8px 22px',
                  background:T.bg3, border:`1px solid ${T.border2}`,
                  color:T.text, borderRadius:6, fontSize:13,
                  fontFamily:'inherit', outline:'none',
                  fontVariantNumeric:'tabular-nums',
                  boxSizing:'border-box',
                }}/>
            </div>
            <button
              onClick={save}
              disabled={!dirty || saving}
              style={{
                padding:'8px 16px', borderRadius:6, border:'none',
                background: !dirty || saving ? T.bg4 : T.blue,
                color: !dirty || saving ? T.text3 : '#fff',
                fontSize:12, fontWeight:600, cursor: !dirty || saving ? 'default' : 'pointer',
                fontFamily:'inherit',
              }}>
              {saving ? 'Saving…' : 'Save target'}
            </button>
          </div>
          {updatedAt && (
            <div style={{fontSize:10, color:T.text3, marginTop:8}}>
              Last updated {fmtDate(updatedAt)}
            </div>
          )}
          {message && (
            <div style={{
              marginTop:10, padding:'7px 10px', borderRadius:5, fontSize:11,
              background: message.kind === 'ok' ? 'rgba(52,199,123,0.1)' : 'rgba(240,78,78,0.1)',
              border:`1px solid ${message.kind === 'ok' ? T.green : T.red}40`,
              color: message.kind === 'ok' ? T.green : T.red,
            }}>{message.text}</div>
          )}
        </>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════
// JOB REPORTS CARD
// ═══════════════════════════════════════════════════════════════════
interface JobRun {
  id: string; uploaded_at: string; filename: string | null;
  row_count: number; is_current: boolean; notes: string | null;
  source?: string; report_type?: string;
}

function JobReportCard() {
  const [runs, setRuns] = useState<JobRun[]>([])
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [message, setMessage] = useState<{ kind: 'ok' | 'err' | 'warn'; text: string } | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await fetch('/api/job-reports/list')
      const d = await r.json()
      setRuns(d.runs || [])
    } catch (e: any) { /* swallow */ }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  async function upload(file: File) {
    const ok = /\.(csv|xlsx|xls)$/i.test(file.name)
    if (!ok) { setMessage({ kind: 'err', text: 'File must be .csv, .xls or .xlsx' }); return }
    setUploading(true); setMessage(null)
    try {
      const file_base64 = await fileToBase64(file)
      const r = await fetch('/api/job-reports/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: file.name, file_base64 }),
      })
      const d = await r.json()
      if (!r.ok) {
        setMessage({ kind: 'err', text: d.error || 'Upload failed' })
      } else {
        const warnLine = d.warnings?.length ? ` (${d.warnings.length} warning${d.warnings.length > 1 ? 's' : ''})` : ''
        setMessage({
          kind: d.warnings?.length ? 'warn' : 'ok',
          text: `Parsed ${d.job_count} jobs${warnLine}. ${d.rematched_invoices || 0} pending invoice${(d.rematched_invoices || 0) === 1 ? '' : 's'} re-matched.`,
        })
        await load()
      }
    } catch (e: any) {
      setMessage({ kind: 'err', text: e.message || 'Upload failed' })
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault(); setDragOver(false)
    const file = e.dataTransfer.files?.[0]
    if (file) upload(file)
  }

  // Filter to forecast-lane runs only — wip_snapshot lane is internal plumbing
  const forecastRuns = runs.filter(r => r.report_type === 'forecast' || r.report_type === undefined || r.report_type === null)
  const current = forecastRuns.find(r => r.is_current) || null

  function srcBadge(r: JobRun) {
    if (r.source === 'api') return <span style={{marginLeft:8, fontSize:9, padding:'1px 5px', borderRadius:3, background:`${T.teal}22`, color:T.teal, fontWeight:600}}>AUTO-PULL</span>
    if (r.source === 'manual') return <span style={{marginLeft:8, fontSize:9, padding:'1px 5px', borderRadius:3, background:`${T.purple}22`, color:T.purple, fontWeight:600}}>MANUAL</span>
    return null
  }

  return (
    <div style={{background:T.bg2, border:`1px solid ${T.border}`, borderRadius:10, padding:20}}>
      <div style={{display:'flex', alignItems:'baseline', justifyContent:'space-between', gap:12, marginBottom:4}}>
        <h3 style={{margin:0, fontSize:14, fontWeight:600, color:T.text}}>Mechanics Desk job report</h3>
        <Link href="/forecasting" style={{fontSize:11, color:T.blue, textDecoration:'none'}}>View forecasting →</Link>
      </div>
      <div style={{fontSize:11, color:T.text3, marginBottom:14}}>
        Auto-pulled by GitHub Actions every 2 hours (8am, 10am, 12pm, 2pm, 4pm AEST). You can also drop a file here for an immediate refresh.
      </div>

      {current && (
        <div style={{background:T.bg3, border:`1px solid ${T.border2}`, borderRadius:6, padding:'8px 12px', marginBottom:12, fontSize:11, display:'flex', justifyContent:'space-between', alignItems:'center', gap:8}}>
          <span style={{color:T.text2, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>
            Current: <strong style={{color:T.text}}>{current.filename || 'unnamed'}</strong> — {current.row_count} jobs{srcBadge(current)}
          </span>
          <span style={{color:T.text3, fontSize:10, whiteSpace:'nowrap'}}>{fmtDate(current.uploaded_at)}</span>
        </div>
      )}

      <div onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
           onDragLeave={() => setDragOver(false)}
           onDrop={onDrop}
           onClick={() => fileRef.current?.click()}
           style={{
             border: `2px dashed ${dragOver ? T.blue : T.border2}`,
             background: dragOver ? 'rgba(79,142,247,0.08)' : T.bg3,
             borderRadius: 8, padding: '20px 16px', textAlign:'center', cursor:'pointer',
             transition: 'all 0.15s ease',
           }}>
        <div style={{fontSize:12, color:T.text2, marginBottom:4}}>
          {uploading ? 'Uploading…' : 'Drag a file here or click to browse'}
        </div>
        <div style={{fontSize:10, color:T.text3}}>.csv · .xls · .xlsx</div>
        <input ref={fileRef} type="file" accept=".csv,.xls,.xlsx"
               onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f) }}
               style={{display:'none'}} disabled={uploading}/>
      </div>

      {message && (
        <div style={{
          marginTop:10, padding:'8px 12px', borderRadius:6, fontSize:11,
          background: message.kind === 'ok' ? 'rgba(52,199,123,0.1)' : message.kind === 'warn' ? 'rgba(245,166,35,0.1)' : 'rgba(240,78,78,0.1)',
          border:`1px solid ${message.kind === 'ok' ? T.green : message.kind === 'warn' ? T.amber : T.red}40`,
          color: message.kind === 'ok' ? T.green : message.kind === 'warn' ? T.amber : T.red,
        }}>{message.text}</div>
      )}

      <div style={{marginTop:16}}>
        <div style={{fontSize:10, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em', fontWeight:600, marginBottom:8}}>
          Recent uploads
        </div>
        {loading ? (
          <div style={{fontSize:11, color:T.text3, padding:'8px 0'}}>Loading…</div>
        ) : forecastRuns.length === 0 ? (
          <div style={{fontSize:11, color:T.text3, padding:'8px 0'}}>No uploads yet.</div>
        ) : (
          <div style={{border:`1px solid ${T.border}`, borderRadius:6, maxHeight:200, overflowY:'auto'}}>
            {forecastRuns.slice(0, 10).map(r => (
              <div key={r.id} style={{display:'grid', gridTemplateColumns:'1fr auto auto', gap:10, padding:'7px 10px', borderBottom:`1px solid ${T.border}`, fontSize:11, alignItems:'center'}}>
                <div style={{color:T.text, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>
                  {r.filename || 'unnamed'}
                  {srcBadge(r)}
                  {r.is_current && <span style={{marginLeft:8, fontSize:9, padding:'1px 6px', borderRadius:3, background:T.green, color:'#fff', fontWeight:600}}>CURRENT</span>}
                </div>
                <div style={{color:T.text2, fontVariantNumeric:'tabular-nums'}}>{r.row_count} jobs</div>
                <div style={{color:T.text3, fontSize:10}}>{fmtDate(r.uploaded_at)}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════
// SERVICE TOKENS CARD
// ═══════════════════════════════════════════════════════════════════
interface ServiceToken {
  id: string; name: string; scopes: string[]; created_at: string;
  last_used_at: string | null; last_used_ip: string | null; is_active: boolean;
}

function ServiceTokensCard() {
  const [tokens, setTokens] = useState<ServiceToken[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [createName, setCreateName] = useState('')
  const [createScopes, setCreateScopes] = useState<string[]>(['upload:job-report'])
  const [newToken, setNewToken] = useState<string | null>(null)
  const [error, setError] = useState('')

  const VALID_SCOPES = [
    { id: 'upload:job-report', label: 'Upload job report (Forecasting)' },
  ]

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const r = await fetch('/api/admin/service-tokens')
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || 'Load failed')
      setTokens(d.tokens || [])
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  async function createToken() {
    if (createName.length < 3) { setError('Name must be at least 3 characters'); return }
    if (createScopes.length === 0) { setError('Select at least one scope'); return }
    setCreating(true); setError('')
    try {
      const r = await fetch('/api/admin/service-tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: createName, scopes: createScopes }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || 'Create failed')
      setNewToken(d.token.plaintext)
      setCreateName('')
      await load()
    } catch (e: any) { setError(e.message) }
    finally { setCreating(false) }
  }

  async function revoke(id: string, name: string) {
    if (!confirm(`Revoke token "${name}"? Any automation using this token will stop working immediately.`)) return
    try {
      const r = await fetch(`/api/admin/service-tokens?id=${id}`, { method: 'DELETE' })
      if (!r.ok) {
        const d = await r.json()
        throw new Error(d.error || 'Revoke failed')
      }
      await load()
    } catch (e: any) { setError(e.message) }
  }

  return (
    <div style={{background:T.bg2, border:`1px solid ${T.border}`, borderRadius:10, padding:20}}>
      <div style={{display:'flex', alignItems:'baseline', justifyContent:'space-between', gap:12, marginBottom:4}}>
        <h3 style={{margin:0, fontSize:14, fontWeight:600, color:T.text}}>Service tokens</h3>
        <span style={{fontSize:10, color:T.text3}}>For external automation</span>
      </div>
      <div style={{fontSize:11, color:T.text3, marginBottom:14}}>
        Long-lived bearer tokens used by GitHub Actions / external integrations. The plaintext value is shown once at creation. Stored as SHA-256 hash.
      </div>

      {/* Newly-created token banner — show ONCE then disappear */}
      {newToken && (
        <div style={{background:`${T.amber}11`, border:`1px solid ${T.amber}66`, borderRadius:6, padding:12, marginBottom:14}}>
          <div style={{fontSize:12, color:T.amber, fontWeight:600, marginBottom:6}}>Save this token — it will not be shown again</div>
          <div style={{display:'flex', gap:6, alignItems:'center'}}>
            <code style={{flex:1, fontSize:11, padding:'7px 10px', background:T.bg3, border:`1px solid ${T.border2}`, borderRadius:4, color:T.text, wordBreak:'break-all', userSelect:'all'}}>{newToken}</code>
            <button onClick={() => { navigator.clipboard.writeText(newToken); setNewToken(null) }}
              style={{padding:'7px 14px', borderRadius:4, border:'none', background:T.amber, color:'#000', fontSize:11, fontWeight:600, cursor:'pointer', fontFamily:'inherit'}}>
              Copy & dismiss
            </button>
          </div>
        </div>
      )}

      {/* Create form */}
      <div style={{background:T.bg3, border:`1px solid ${T.border}`, borderRadius:6, padding:14, marginBottom:14}}>
        <div style={{fontSize:11, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em', fontWeight:600, marginBottom:8}}>Create token</div>
        <div style={{display:'flex', gap:8, alignItems:'flex-end', flexWrap:'wrap', marginBottom:8}}>
          <div style={{flex:1, minWidth:200}}>
            <div style={{fontSize:10, color:T.text3, marginBottom:4}}>Name</div>
            <input value={createName} onChange={e=>setCreateName(e.target.value)}
              placeholder="e.g. github-actions-md-pull"
              style={{width:'100%', padding:'7px 10px', background:T.bg2, border:`1px solid ${T.border2}`, color:T.text, borderRadius:4, fontSize:12, fontFamily:'inherit', outline:'none', boxSizing:'border-box'}}/>
          </div>
          <button onClick={createToken} disabled={creating || createName.length < 3}
            style={{padding:'7px 14px', borderRadius:4, border:'none', background: creating || createName.length < 3 ? T.bg4 : T.blue, color: creating || createName.length < 3 ? T.text3 : '#fff', fontSize:12, fontWeight:600, cursor: creating || createName.length < 3 ? 'default' : 'pointer', fontFamily:'inherit'}}>
            {creating ? 'Creating…' : 'Create token'}
          </button>
        </div>
        <div style={{display:'flex', gap:10, flexWrap:'wrap'}}>
          {VALID_SCOPES.map(s => {
            const checked = createScopes.includes(s.id)
            return (
              <label key={s.id} style={{display:'inline-flex', gap:6, alignItems:'center', fontSize:11, cursor:'pointer'}}>
                <input type="checkbox" checked={checked}
                  onChange={() => setCreateScopes(prev => prev.includes(s.id) ? prev.filter(x => x !== s.id) : [...prev, s.id])}/>
                <span style={{color: checked ? T.text : T.text3}}>{s.label}</span>
              </label>
            )
          })}
        </div>
      </div>

      {error && <div style={{marginBottom:12, padding:'8px 12px', background:`${T.red}15`, border:`1px solid ${T.red}40`, borderRadius:6, color:T.red, fontSize:11}}>{error}</div>}

      {/* List */}
      {loading ? (
        <div style={{fontSize:12, color:T.text3, padding:'8px 0'}}>Loading…</div>
      ) : tokens.length === 0 ? (
        <div style={{fontSize:11, color:T.text3, padding:'8px 0'}}>No service tokens yet.</div>
      ) : (
        <div style={{border:`1px solid ${T.border}`, borderRadius:6, overflow:'hidden'}}>
          {tokens.map(t => (
            <div key={t.id} style={{display:'grid', gridTemplateColumns:'1fr auto auto auto', gap:10, padding:'9px 12px', borderBottom:`1px solid ${T.border}`, fontSize:11, alignItems:'center', opacity: t.is_active ? 1 : 0.5}}>
              <div>
                <div style={{color:T.text, fontWeight:500}}>
                  {t.name}
                  {!t.is_active && <span style={{marginLeft:8, fontSize:9, padding:'1px 5px', borderRadius:3, background:`${T.red}22`, color:T.red, fontWeight:600}}>REVOKED</span>}
                </div>
                <div style={{fontSize:10, color:T.text3, marginTop:2}}>
                  {t.scopes.join(', ')}
                </div>
              </div>
              <div style={{fontSize:10, color:T.text3, textAlign:'right', minWidth:120}}>
                <div>Created {fmtDate(t.created_at)}</div>
                <div>{t.last_used_at ? `Used ${fmtDate(t.last_used_at)}` : 'Never used'}</div>
              </div>
              <div style={{fontSize:10, color:T.text3, fontFamily:'monospace'}}>
                {t.last_used_ip || '—'}
              </div>
              <div>
                {t.is_active && (
                  <button onClick={() => revoke(t.id, t.name)}
                    style={{padding:'4px 8px', borderRadius:3, border:'none', background:'transparent', color:T.red, fontSize:11, cursor:'pointer', fontFamily:'inherit'}}>
                    Revoke
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════
// SUPPLIER INVOICES CARD (unchanged)
// ═══════════════════════════════════════════════════════════════════
interface SupplierInvoice { id: string; received_at: string; filename: string | null; supplier_name: string | null; status: string; invoice_number: string | null }

function SupplierInvoiceCard() {
  const [recent, setRecent] = useState<SupplierInvoice[]>([])
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [message, setMessage] = useState<{ kind: 'ok' | 'err' | 'warn'; text: string } | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await fetch('/api/supplier-invoices/list?pageSize=10')
      const d = await r.json()
      setRecent(d.invoices || [])
    } catch (e: any) { /* swallow */ }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  async function upload(file: File) {
    if (!/\.pdf$/i.test(file.name)) { setMessage({ kind: 'err', text: 'File must be a .pdf' }); return }
    setUploading(true); setMessage(null)
    try {
      const pdf_base64 = await fileToBase64(file)
      const r = await fetch('/api/supplier-invoices/intake', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: file.name, pdf_base64, source: 'manual' }),
      })
      const d = await r.json()
      if (!r.ok) {
        setMessage({ kind: 'err', text: d.error || 'Upload failed' })
      } else {
        const matchLine = d.po_matches_job && d.matched_job
          ? ` — matched to job ${d.matched_job.job_number}${d.matched_job.customer_name ? ` (${d.matched_job.customer_name})` : ''}`
          : ' — no job match'
        const autoLine = d.auto_approved ? ' · auto-approved (paid)' : ''
        setMessage({
          kind: d.po_matches_job ? 'ok' : 'warn',
          text: `Parsed "${d.parsed?.invoice_number || '?'}"${matchLine}${autoLine}.`,
        })
        await load()
      }
    } catch (e: any) {
      setMessage({ kind: 'err', text: e.message || 'Upload failed' })
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault(); setDragOver(false)
    const file = e.dataTransfer.files?.[0]
    if (file) upload(file)
  }

  function statusPill(s: string) {
    const colors: Record<string, { bg: string; fg: string }> = {
      parsed:         { bg: 'rgba(245,166,35,0.15)', fg: T.amber },
      auto_approved:  { bg: 'rgba(52,199,123,0.15)', fg: T.green },
      approved:       { bg: 'rgba(52,199,123,0.15)', fg: T.green },
      rejected:       { bg: 'rgba(240,78,78,0.15)',  fg: T.red },
      queued_myob:    { bg: 'rgba(79,142,247,0.15)', fg: T.blue },
      pushed_to_myob: { bg: 'rgba(45,212,191,0.15)', fg: T.teal },
      push_failed:    { bg: 'rgba(240,78,78,0.15)',  fg: T.red },
    }
    const c = colors[s] || { bg: T.bg4, fg: T.text3 }
    return <span style={{fontSize:9, padding:'1px 6px', borderRadius:3, background:c.bg, color:c.fg, fontWeight:600}}>{s.toUpperCase().replace('_', ' ')}</span>
  }

  return (
    <div style={{background:T.bg2, border:`1px solid ${T.border}`, borderRadius:10, padding:20}}>
      <div style={{display:'flex', alignItems:'baseline', justifyContent:'space-between', gap:12, marginBottom:4}}>
        <h3 style={{margin:0, fontSize:14, fontWeight:600, color:T.text}}>Supplier invoice</h3>
        <Link href="/supplier-invoices" style={{fontSize:11, color:T.blue, textDecoration:'none'}}>View queue →</Link>
      </div>
      <div style={{fontSize:11, color:T.text3, marginBottom:14}}>
        PDF invoice from a supplier. Parsed via Claude, matched to job report POs, added to the approval queue.
      </div>

      <div onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
           onDragLeave={() => setDragOver(false)}
           onDrop={onDrop}
           onClick={() => fileRef.current?.click()}
           style={{
             border: `2px dashed ${dragOver ? T.blue : T.border2}`,
             background: dragOver ? 'rgba(79,142,247,0.08)' : T.bg3,
             borderRadius: 8, padding: '20px 16px', textAlign:'center', cursor:'pointer',
             transition: 'all 0.15s ease',
           }}>
        <div style={{fontSize:12, color:T.text2, marginBottom:4}}>
          {uploading ? 'Parsing PDF…' : 'Drag a PDF here or click to browse'}
        </div>
        <div style={{fontSize:10, color:T.text3}}>.pdf · up to 20 MB</div>
        <input ref={fileRef} type="file" accept=".pdf,application/pdf"
               onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f) }}
               style={{display:'none'}} disabled={uploading}/>
      </div>

      {message && (
        <div style={{
          marginTop:10, padding:'8px 12px', borderRadius:6, fontSize:11,
          background: message.kind === 'ok' ? 'rgba(52,199,123,0.1)' : message.kind === 'warn' ? 'rgba(245,166,35,0.1)' : 'rgba(240,78,78,0.1)',
          border:`1px solid ${message.kind === 'ok' ? T.green : message.kind === 'warn' ? T.amber : T.red}40`,
          color: message.kind === 'ok' ? T.green : message.kind === 'warn' ? T.amber : T.red,
        }}>{message.text}</div>
      )}

      <div style={{marginTop:16}}>
        <div style={{fontSize:10, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em', fontWeight:600, marginBottom:8}}>
          Recent invoices
        </div>
        {loading ? (
          <div style={{fontSize:11, color:T.text3, padding:'8px 0'}}>Loading…</div>
        ) : recent.length === 0 ? (
          <div style={{fontSize:11, color:T.text3, padding:'8px 0'}}>No invoices yet.</div>
        ) : (
          <div style={{border:`1px solid ${T.border}`, borderRadius:6, maxHeight:200, overflowY:'auto'}}>
            {recent.map(inv => (
              <div key={inv.id} style={{display:'grid', gridTemplateColumns:'1fr auto auto', gap:10, padding:'7px 10px', borderBottom:`1px solid ${T.border}`, fontSize:11, alignItems:'center'}}>
                <div style={{color:T.text, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>
                  {inv.supplier_name || inv.filename || 'unknown'}
                  {inv.invoice_number && <span style={{marginLeft:6, color:T.text3}}>#{inv.invoice_number}</span>}
                </div>
                <div>{statusPill(inv.status)}</div>
                <div style={{color:T.text3, fontSize:10}}>{fmtDate(inv.received_at)}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════
// TAB CONTAINER
// ═══════════════════════════════════════════════════════════════════
export default function DataImportsTab() {
  return (
    <div style={{maxWidth:1100}}>
      <div style={{marginBottom:16}}>
        <h2 style={{margin:0, fontSize:18, fontWeight:600, color:T.text}}>Data imports</h2>
        <div style={{fontSize:12, color:T.text3, marginTop:4}}>
          Manage forecasting target, file uploads, and external automation tokens. Admin-only.
        </div>
      </div>

      {/* Forecasting target — full width on its own row */}
      <div style={{marginBottom:16}}>
        <ForecastingTargetCard/>
      </div>

      {/* Job report + Supplier invoice — side by side */}
      <div style={{display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(400px, 1fr))', gap:16, marginBottom:16}}>
        <JobReportCard/>
        <SupplierInvoiceCard/>
      </div>

      {/* Service tokens — full width */}
      <ServiceTokensCard/>
    </div>
  )
}
