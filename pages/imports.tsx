// pages/imports.tsx
// Admin imports page.
//
// Flow:
//   1. Pick a file (browser parses with SheetJS).
//   2. For each role the type defines: pick a sheet → map portal fields ←
//      source columns. Optional roles can be skipped. Single-role types
//      (customers, vehicles, inventory, job types, quotes) have one role
//      called "main"; multi-role types (invoices) have several.
//   3. Click Continue — chunks upload per role.
//   4. Server normalises + returns preview counts.
//   5. Run import.

import { useEffect, useMemo, useRef, useState } from 'react'
import Head from 'next/head'
import Link from 'next/link'
import * as XLSX from 'xlsx'
import { useConfirm } from '../components/ui/Feedback'

const T = {
  bg: '#0d0e10', bg2: '#16181c', bg3: '#1d2025',
  border: '#26282e', border2: '#33363c',
  text: '#e8ebef', text2: '#a7afba', text3: '#6b7480',
  amber: '#d4a574', green: '#7fb069', teal: '#5fb3a8',
  red: '#d97757', purple: '#a78bbd', cobalt: '#5e8acf',
} as const

interface FieldDef { id: string; label: string; aliases: string[]; required: boolean; hint: string | null }
interface RoleDef { id: string; label: string; sheets: string[]; required: boolean; blurb: string | null; fields: FieldDef[] }
interface TypeMeta { id: string; label: string; blurb: string; roles: RoleDef[] }

interface ImportRow {
  id: string; type: string; filename: string; uploaded_at: string
  status: 'uploading' | 'parsed' | 'running' | 'completed' | 'failed' | 'cancelled'
  parsed_summary: any; result_summary: any; error: string | null
  started_at: string | null; completed_at: string | null
}

export default function ImportsPage() {
  const [types, setTypes] = useState<TypeMeta[]>([])
  const [active, setActive] = useState<string>('customers')
  const [history, setHistory] = useState<ImportRow[]>([])
  const [refreshing, setRefreshing] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const activeMeta = useMemo(() => types.find(t => t.id === active), [types, active])

  useEffect(() => {
    fetch('/api/imports/meta').then(r => r.json()).then(d => setTypes(d.types || [])).catch(() => undefined)
  }, [])
  const reload = async () => {
    const r = await fetch('/api/imports'); const d = await r.json()
    if (r.ok) setHistory(d.imports || [])
  }
  useEffect(() => { reload() }, [])

  return (
    <>
      <Head><title>Imports · JA Portal</title></Head>
      <div style={{ minHeight: '100vh', background: T.bg, color: T.text, fontFamily: '"DM Sans", system-ui, sans-serif' }}>
        <div style={{ maxWidth: 1500, margin: '0 auto', padding: '24px 32px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 22, gap: 16, flexWrap: 'wrap' }}>
            <div>
              <Link href="/settings" style={{ fontSize: 11, color: T.text3, textDecoration: 'none', fontFamily: 'monospace' }}>← Settings</Link>
              <h1 style={{ fontSize: 22, fontWeight: 600, margin: '6px 0 2px' }}>Imports</h1>
              <div style={{ fontSize: 12, color: T.text3 }}>Drop a spreadsheet, pick the sheet(s), confirm which column maps to which field, then run.</div>
            </div>
            <button onClick={() => { setRefreshing(true); reload().finally(() => setRefreshing(false)) }} style={btn(false)}>{refreshing ? '↻ Refreshing…' : '↻ Refresh'}</button>
          </div>

          <div style={{ display: 'flex', gap: 4, borderBottom: `1px solid ${T.border}`, marginBottom: 18, overflowX: 'auto' }}>
            {types.map(t => (
              <button key={t.id} onClick={() => setActive(t.id)} style={{
                padding: '8px 14px', background: 'transparent',
                border: 'none', borderBottom: active === t.id ? `2px solid ${T.amber}` : '2px solid transparent',
                color: active === t.id ? T.text : T.text3,
                fontSize: 12, fontFamily: 'inherit', fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
              }}>{t.label}{t.roles.length > 1 && <span style={{ marginLeft: 6, fontSize: 9, color: T.text3, fontWeight: 400 }}>{t.roles.length} sheets</span>}</button>
            ))}
          </div>

          {activeMeta && <ImportFlow key={active} meta={activeMeta} onComplete={reload} />}

          <div style={{ marginTop: 28 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: T.text3, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 }}>Recent imports</div>
            {history.length === 0 ? (
              <div style={{ padding: 24, textAlign: 'center', fontSize: 12, color: T.text3, background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 8 }}>No imports yet.</div>
            ) : (
              <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 8, overflow: 'hidden' }}>
                {history.map((h, i) => <HistoryRow key={h.id} row={h} first={i === 0} typeLabel={types.find(t => t.id === h.type)?.label || h.type} onOpen={() => setSelectedId(h.id)} onChange={reload} />)}
              </div>
            )}
          </div>
        </div>
        {selectedId && (
          <ImportDetail id={selectedId} typeLabel={(h => types.find(t => t.id === h?.type)?.label || h?.type || '')(history.find(h => h.id === selectedId))} onClose={() => setSelectedId(null)} onChange={reload} />
        )}
      </div>
    </>
  )
}

// ── Per-role config tracked in state ─────────────────────────────────────────
// sheetNames is a LIST — for multi-sheet roles (e.g. invoice items split
// across "Invoice Items", "Invoice Items 2", etc.) the user adds each one
// and they all share the same column mapping (derived from the first sheet).
interface RoleConfig {
  skipped: boolean
  sheetNames: string[]
  columns: string[]
  sampleRows: any[]
  mapping: Record<string, string>
}

type Step = 'idle' | 'config' | 'preview' | 'result'

function ImportFlow({ meta, onComplete }: { meta: TypeMeta; onComplete: () => void }) {
  const [step, setStep] = useState<Step>('idle')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')
  const [err, setErr] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [wb, setWb] = useState<XLSX.WorkBook | null>(null)
  const [configs, setConfigs] = useState<Record<string, RoleConfig>>({})
  const [preview, setPreview] = useState<{ id: string; summary: any } | null>(null)
  const [result, setResult] = useState<{ summary: any } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  function reset() {
    setStep('idle'); setBusy(false); setProgress(''); setErr('')
    setFile(null); setWb(null); setConfigs({}); setPreview(null); setResult(null)
  }

  /** Build a role config from a sheet — extracts headers + auto-maps fields. */
  function buildConfigFromSheet(w: XLSX.WorkBook, roleId: string, sheetName: string): RoleConfig {
    const role = meta.roles.find(r => r.id === roleId)!
    const sheet = w.Sheets[sheetName]
    const arr: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null })
    const headers = (arr[0] || []).map(h => String(h ?? '').trim()).filter(Boolean)
    const obj = XLSX.utils.sheet_to_json(sheet, { defval: null }).slice(0, 3)
    const mapping: Record<string, string> = {}
    for (const f of role.fields) {
      const hit = bestMatch(headers, f.aliases, f.label, f.id)
      if (hit) mapping[f.id] = hit
    }
    return { skipped: false, sheetNames: [sheetName], columns: headers, sampleRows: obj, mapping }
  }

  /** Auto-pick all sheets whose names match the role's aliases (handles MD
   *  splitting items across "Invoice Items", "Invoice Items 2", etc.). */
  function autoSheetsForRole(w: XLSX.WorkBook, sheetAliases: string[]): string[] {
    const norm = (s: string) => s.trim().toLowerCase()
    const aliasN = sheetAliases.map(norm)
    const hits: string[] = []
    for (const n of w.SheetNames) {
      const nn = norm(n)
      // Exact match OR alias is a prefix (catches "Invoice Items 2", "3"…)
      if (aliasN.some(a => nn === a || nn.startsWith(a))) hits.push(n)
    }
    return hits
  }

  async function onFile(f: File) {
    reset()
    if (!/\.xlsx?$/i.test(f.name)) { setErr('File must be .xls or .xlsx'); return }
    setBusy(true); setFile(f)
    try {
      const buf = await f.arrayBuffer()
      const w = XLSX.read(buf, { type: 'array' })
      setWb(w)
      // Auto-pick the best sheets for each role. Pick ALL matching sheets so
      // splits like "Invoice Items / Items 2 / Items 3" all land in one role.
      const next: Record<string, RoleConfig> = {}
      for (const role of meta.roles) {
        const hits = autoSheetsForRole(w, role.sheets)
        if (hits.length > 0) {
          const cfg = buildConfigFromSheet(w, role.id, hits[0])
          cfg.sheetNames = hits  // keep all matched sheets
          next[role.id] = cfg
        } else {
          next[role.id] = { skipped: false, sheetNames: [], columns: [], sampleRows: [], mapping: {} }
        }
      }
      setConfigs(next)
      setStep('config')
    } catch (e: any) { setErr(e?.message || 'Failed to read file') }
    finally { setBusy(false) }
  }

  function setRoleSheet(roleId: string, name: string) {
    if (!wb) return
    if (!name) {
      setConfigs(prev => ({ ...prev, [roleId]: { skipped: prev[roleId]?.skipped || false, sheetNames: [], columns: [], sampleRows: [], mapping: {} } }))
      return
    }
    setConfigs(prev => ({ ...prev, [roleId]: buildConfigFromSheet(wb!, roleId, name) }))
  }
  function addSheetToRole(roleId: string, sheetName: string) {
    if (!wb || !sheetName) return
    setConfigs(prev => {
      const cur = prev[roleId]
      if (!cur || cur.sheetNames.includes(sheetName)) return prev
      return { ...prev, [roleId]: { ...cur, sheetNames: [...cur.sheetNames, sheetName] } }
    })
  }
  function removeSheetFromRole(roleId: string, sheetName: string) {
    setConfigs(prev => {
      const cur = prev[roleId]
      if (!cur) return prev
      const remaining = cur.sheetNames.filter(n => n !== sheetName)
      if (remaining.length === 0) return { ...prev, [roleId]: { skipped: cur.skipped, sheetNames: [], columns: [], sampleRows: [], mapping: {} } }
      // If we removed the leading sheet, rebuild mapping from the new leader.
      if (cur.sheetNames[0] === sheetName && wb) {
        const cfg = buildConfigFromSheet(wb, roleId, remaining[0])
        cfg.sheetNames = remaining
        return { ...prev, [roleId]: cfg }
      }
      return { ...prev, [roleId]: { ...cur, sheetNames: remaining } }
    })
  }
  function setRoleMapping(roleId: string, fieldId: string, columnName: string) {
    setConfigs(prev => ({ ...prev, [roleId]: { ...prev[roleId], mapping: { ...prev[roleId].mapping, [fieldId]: columnName } } }))
  }
  function toggleSkip(roleId: string, skip: boolean) {
    setConfigs(prev => ({ ...prev, [roleId]: { ...prev[roleId], skipped: skip, ...(skip ? { sheetNames: [], columns: [], mapping: {} } : {}) } }))
  }

  // Validate: every required role must have at least one sheet picked + every
  // required field mapped.
  function validate(): string | null {
    for (const role of meta.roles) {
      const cfg = configs[role.id]
      if (role.required) {
        if (!cfg?.sheetNames?.length) return `${role.label}: pick a sheet`
        const missing = role.fields.filter(f => f.required && !cfg.mapping[f.id])
        if (missing.length) return `${role.label}: missing required field${missing.length > 1 ? 's' : ''} ${missing.map(f => f.label).join(', ')}`
      } else if (cfg && !cfg.skipped && cfg.sheetNames.length > 0) {
        const missing = role.fields.filter(f => f.required && !cfg.mapping[f.id])
        if (missing.length) return `${role.label}: missing required field${missing.length > 1 ? 's' : ''} ${missing.map(f => f.label).join(', ')}`
      }
    }
    return null
  }

  async function submit() {
    if (!wb) return
    const v = validate(); if (v) { setErr(v); return }
    setBusy(true); setErr(''); setProgress('Reading rows…')
    try {
      // Build per-role mapped row arrays. For a role with multiple sheets
      // selected (e.g. invoice items split across 4 sheets), iterate all of
      // them and concatenate — using the same mapping for each.
      const perRole: { roleId: string; rows: any[] }[] = []
      for (const role of meta.roles) {
        const cfg = configs[role.id]
        if (!cfg || cfg.skipped || cfg.sheetNames.length === 0) continue
        const allMapped: any[] = []
        for (const sheetName of cfg.sheetNames) {
          const sheet = wb.Sheets[sheetName]
          if (!sheet) continue
          const raw = XLSX.utils.sheet_to_json(sheet, { defval: null }) as any[]
          for (const r of raw) {
            const out: any = {}
            for (const f of role.fields) {
              const col = cfg.mapping[f.id]
              if (col) out[f.id] = r[col]
            }
            allMapped.push(out)
          }
        }
        perRole.push({ roleId: role.id, rows: allMapped })
      }

      // Create the import row.
      const r0 = await fetch('/api/imports', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: meta.id, filename: file?.name || 'upload.xls' }),
      })
      const d0 = await safeJson(r0)
      if (!r0.ok) { setErr(d0?.error || `Upload failed (HTTP ${r0.status})`); return }
      const importId = d0.id

      // Build every (role, chunk_index) task up front, then run them through
      // a small concurrency pool. Was sequential — for 270k-row imports that
      // meant 5+ minutes of HTTP roundtrips. Now ~12x faster.
      const CHUNK = 2500   // ~1MB per chunk (safe vs Vercel's ~4.5MB body limit)
      const CONCURRENCY = 6
      type Task = { role: string; index: number; rows: any[] }
      const tasks: Task[] = []
      for (const { roleId, rows } of perRole) {
        const count = Math.max(1, Math.ceil(rows.length / CHUNK))
        for (let i = 0; i < count; i++) tasks.push({ role: roleId, index: i, rows: rows.slice(i * CHUNK, (i + 1) * CHUNK) })
      }
      const total = tasks.length
      let done = 0
      let failed: string | null = null
      let nextIdx = 0
      const worker = async (): Promise<void> => {
        while (true) {
          if (failed) return
          const i = nextIdx++
          if (i >= tasks.length) return
          const t = tasks[i]
          const r = await fetch(`/api/imports/${importId}/chunk`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ role: t.role, chunk_index: t.index, rows: t.rows }),
          })
          if (!r.ok) {
            const e = await safeJson(r)
            if (!failed) failed = e?.error || `Chunk failed (HTTP ${r.status})`
            return
          }
          done++
          setProgress(`Uploading ${done} / ${total} chunks (${CONCURRENCY} in parallel)`)
        }
      }
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, () => worker()))
      if (failed) { setErr(failed); return }

      setProgress('Finalising…')
      const rf = await fetch(`/api/imports/${importId}/finalize`, { method: 'POST' })
      const df = await safeJson(rf)
      if (!rf.ok) { setErr(df?.error || `Finalise failed (HTTP ${rf.status})`); return }
      setPreview({ id: importId, summary: df.parsed_summary })
      setStep('preview')
    } catch (e: any) { setErr(e?.message || 'Upload failed') }
    finally { setBusy(false); setProgress('') }
  }

  async function runImport() {
    if (!preview) return
    setBusy(true); setErr('')
    try {
      const r = await fetch(`/api/imports/${preview.id}/run`, { method: 'POST' })
      const d = await safeJson(r)
      if (!r.ok) { setErr(d?.error || 'Import failed'); return }
      setResult({ summary: d.result_summary })
      setStep('result')
      onComplete()
    } catch (e: any) { setErr(e?.message || 'Import failed') }
    finally { setBusy(false) }
  }

  async function safeJson(r: Response): Promise<any> {
    try { return await r.clone().json() } catch {
      const text = await r.text().catch(() => '')
      return { error: text ? `Server returned non-JSON: ${text.substring(0, 200)}` : `HTTP ${r.status}` }
    }
  }

  return (
    <div style={{ padding: 20, background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 10 }}>
      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Import {meta.label.toLowerCase()}</div>
      <div style={{ fontSize: 11, color: T.text3, marginBottom: 14 }}>{meta.blurb}</div>

      {step === 'idle' && (
        <div onClick={() => fileRef.current?.click()}
             onDragOver={e => e.preventDefault()}
             onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) onFile(f) }}
             style={{ padding: '36px 20px', textAlign: 'center', border: `2px dashed ${T.border2}`, borderRadius: 8, cursor: busy ? 'default' : 'pointer', background: T.bg3 }}>
          <input ref={fileRef} type="file" accept=".xls,.xlsx" style={{ display: 'none' }} onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f) }} />
          <div style={{ fontSize: 13, color: T.text2, fontWeight: 500 }}>{busy ? 'Reading…' : 'Drop .xls/.xlsx here, or click to browse'}</div>
          <div style={{ fontSize: 10, color: T.text3, marginTop: 6 }}>Parsed in your browser — nothing's uploaded until you confirm.</div>
        </div>
      )}

      {step === 'config' && wb && (
        <div>
          <div style={{ fontSize: 11, color: T.text3, marginBottom: 10 }}>File: <strong style={{ color: T.text2 }}>{file?.name}</strong> · {wb.SheetNames.length} sheet{wb.SheetNames.length === 1 ? '' : 's'}</div>
          {meta.roles.map(role => (
            <RolePanel key={role.id} role={role} wb={wb}
              config={configs[role.id]}
              onSetSheet={n => setRoleSheet(role.id, n)}
              onAddSheet={n => addSheetToRole(role.id, n)}
              onRemoveSheet={n => removeSheetFromRole(role.id, n)}
              onPickMapping={(f, c) => setRoleMapping(role.id, f, c)}
              onSkip={s => toggleSkip(role.id, s)}
            />
          ))}

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}>
            <button onClick={submit} disabled={busy} style={btn(true)}>{busy ? 'Uploading…' : 'Continue → Preview'}</button>
            <button onClick={reset} disabled={busy} style={btn(false)}>Start over</button>
            {busy && progress && <span style={{ fontSize: 11, color: T.text3, marginLeft: 8 }}>{progress}</span>}
          </div>
        </div>
      )}

      {step === 'preview' && preview && (
        <div>
          <Section label="Preview" />
          <div style={{ padding: 14, background: T.bg3, border: `1px solid ${T.border}`, borderRadius: 6, marginBottom: 14 }}>
            <SummaryGrid s={preview.summary} />
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={runImport} disabled={busy} style={btn(true)}>{busy ? 'Running…' : 'Run import'}</button>
            <button onClick={() => setStep('config')} disabled={busy} style={btn(false)}>← Back</button>
            <button onClick={reset} disabled={busy} style={btn(false)}>Cancel</button>
          </div>
        </div>
      )}

      {step === 'result' && result && (
        <div>
          <Section label="✓ Done" />
          <div style={{ padding: 14, background: T.bg3, border: `1px solid ${T.green}33`, borderRadius: 6, marginBottom: 14 }}>
            <ResultGrid s={result.summary} />
          </div>
          <button onClick={reset} style={btn(false)}>Run another import</button>
        </div>
      )}

      {err && <div style={{ marginTop: 12, padding: 10, background: '#3a1d1d', border: `1px solid ${T.red}`, borderRadius: 6, color: T.red, fontSize: 12 }}>{err}</div>}
    </div>
  )
}

// ── Per-role config panel ────────────────────────────────────────────────────
function RolePanel({ role, wb, config, onSetSheet, onAddSheet, onRemoveSheet, onPickMapping, onSkip }: {
  role: RoleDef; wb: XLSX.WorkBook; config: RoleConfig | undefined
  onSetSheet: (n: string) => void
  onAddSheet: (n: string) => void
  onRemoveSheet: (n: string) => void
  onPickMapping: (fieldId: string, col: string) => void
  onSkip: (skip: boolean) => void
}) {
  const skipped = config?.skipped === true
  const picked = config?.sheetNames || []
  // Row counts for the picker label.
  const sheetMeta = (n: string) => { try { return XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, defval: null }).length } catch { return 0 } }
  return (
    <div style={{ marginBottom: 16, padding: 14, background: T.bg3, border: `1px solid ${skipped ? T.border : T.border2}`, borderRadius: 8, opacity: skipped ? 0.5 : 1 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: T.text }}>{role.label}</div>
        {!role.required && <span style={{ fontSize: 9, color: T.text3, fontFamily: 'monospace', textTransform: 'uppercase' }}>optional</span>}
        {role.required && <span style={{ fontSize: 9, color: T.amber, fontFamily: 'monospace', textTransform: 'uppercase' }}>required</span>}
        <div style={{ flex: 1 }} />
        {!role.required && (
          <button onClick={() => onSkip(!skipped)} style={{ background: 'none', border: 'none', color: T.text3, fontSize: 11, cursor: 'pointer', fontFamily: 'inherit' }}>
            {skipped ? 'Include' : 'Skip'}
          </button>
        )}
      </div>
      {role.blurb && <div style={{ fontSize: 11, color: T.text3, marginBottom: 10 }}>{role.blurb}</div>}

      {skipped ? (
        <div style={{ fontSize: 11, color: T.text3, padding: '8px 0' }}>Skipped — no rows will be uploaded for this role.</div>
      ) : (
        <>
          <div style={{ fontSize: 10, color: T.text3, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6, marginTop: 6 }}>
            Sheet{picked.length > 1 ? 's' : ''} {picked.length > 0 && <span style={{ color: T.amber, marginLeft: 4 }}>· {picked.length} selected</span>}
          </div>

          {picked.length === 0 ? (
            <select value="" onChange={e => onSetSheet(e.target.value)} style={{ ...inp, marginBottom: 12 }}>
              <option value="">— pick a sheet —</option>
              {wb.SheetNames.map(n => <option key={n} value={n}>{n} · {sheetMeta(n)} rows</option>)}
            </select>
          ) : (
            <>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                {picked.map((n, i) => (
                  <span key={n} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 8px 4px 10px', background: T.bg2, border: `1px solid ${T.amber}55`, borderRadius: 4, fontSize: 11, color: T.text2 }}>
                    {n} · {sheetMeta(n)} rows
                    <button onClick={() => onRemoveSheet(n)} title="Remove" style={{ background: 'none', border: 'none', color: T.text3, cursor: 'pointer', fontSize: 13, padding: 0, lineHeight: 1 }}>×</button>
                  </span>
                ))}
              </div>
              {wb.SheetNames.filter(n => !picked.includes(n)).length > 0 && (
                <select value="" onChange={e => { if (e.target.value) onAddSheet(e.target.value) }} style={{ ...inp, marginBottom: 12 }} title="Add another sheet — picks up extra rows using the same column mapping (e.g. Invoice Items, Invoice Items 2…)">
                  <option value="">+ Add another sheet</option>
                  {wb.SheetNames.filter(n => !picked.includes(n)).map(n => <option key={n} value={n}>{n} · {sheetMeta(n)} rows</option>)}
                </select>
              )}
            </>
          )}

          {picked.length > 0 && config && config.columns.length > 0 && (
            <>
              <div style={{ fontSize: 10, color: T.text3, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Column mapping</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                {role.fields.map(f => (
                  <div key={f.id} style={{ display: 'grid', gridTemplateColumns: '200px 1fr', gap: 10, alignItems: 'center' }}>
                    <div>
                      <div style={{ fontSize: 11, color: T.text2 }}>
                        {f.label}{f.required && <span style={{ color: T.red, marginLeft: 4 }}>*</span>}
                      </div>
                      {f.hint && <div style={{ fontSize: 9, color: T.text3, marginTop: 1 }}>{f.hint}</div>}
                    </div>
                    <select value={config.mapping[f.id] || ''} onChange={e => onPickMapping(f.id, e.target.value)} style={inp}>
                      <option value="">— not in this sheet —</option>
                      {config.columns.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                ))}
              </div>
              {config.sampleRows.length > 0 && (
                <details style={{ marginTop: 10 }}>
                  <summary style={{ cursor: 'pointer', fontSize: 11, color: T.text3 }}>Preview first 3 rows (mapped)</summary>
                  <pre style={{ background: T.bg2, padding: 10, borderRadius: 6, fontSize: 10, color: T.text2, overflow: 'auto', maxHeight: 200, marginTop: 6 }}>
{JSON.stringify(config.sampleRows.map(r => Object.fromEntries(role.fields.map(f => [f.id, config.mapping[f.id] ? r[config.mapping[f.id]] : null]).filter(([_, v]) => v != null))), null, 2)}
                  </pre>
                </details>
              )}
            </>
          )}
          {picked.length > 0 && config && config.columns.length === 0 && <div style={{ fontSize: 11, color: T.amber }}>That sheet has no header row.</div>}
        </>
      )}
    </div>
  )
}

function Section({ label }: { label: string }) {
  return <div style={{ fontSize: 10, fontWeight: 700, color: T.amber, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>{label}</div>
}

// ── Auto-suggest helpers ──────────────────────────────────────────────────────
function pickSheet(wb: XLSX.WorkBook, candidates: string[]): string | null {
  for (const c of candidates) if (wb.Sheets[c]) return c
  const norm = wb.SheetNames.map(n => ({ orig: n, n: n.trim().toLowerCase() }))
  for (const c of candidates) {
    const cn = c.trim().toLowerCase()
    const hit = norm.find(x => x.n === cn) || norm.find(x => x.n.includes(cn) || cn.includes(x.n))
    if (hit) return hit.orig
  }
  return null
}

function bestMatch(columns: string[], aliases: string[], label: string, id: string): string | null {
  const cols = columns.map(c => ({ orig: c, n: c.trim().toLowerCase() }))
  const candidates = [label, id, ...aliases]
  for (const a of candidates) {
    const an = a.trim().toLowerCase()
    const exact = cols.find(c => c.n === an)
    if (exact) return exact.orig
  }
  for (const a of candidates) {
    const an = a.trim().toLowerCase()
    const partial = cols.find(c => c.n.includes(an) || an.includes(c.n))
    if (partial) return partial.orig
  }
  return null
}

// ── Summaries (generic — render whatever keys come back) ─────────────────────
function SummaryGrid({ s }: { s: any }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10, fontSize: 12 }}>
      {Object.entries(s || {}).map(([k, v]) => (
        <Stat key={k} label={prettyLabel(k)} value={v as any}
          muted={k.startsWith('skipped') || k.startsWith('headers_no_') || k.startsWith('payments_orphan') || k.startsWith('items_orphan')} />
      ))}
    </div>
  )
}
function ResultGrid({ s }: { s: any }) {
  const order = ['inserted', 'updated', 'upserted', 'headers_inserted', 'items_inserted', 'payments_inserted',
                 'matched_by_mobile', 'matched_by_email', 'matched_by_name', 'matched_md_id', 'matched_rego', 'matched_sku',
                 'already_linked', 'duplicate_in_file', 'headers_skipped', 'headers_no_customer', 'items_orphan', 'payments_orphan',
                 'no_customer', 'no_vehicle', 'errors', 'first_error']
  const keys = Object.keys(s || {}).sort((a, b) => {
    const ia = order.indexOf(a), ib = order.indexOf(b)
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
  })
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10, fontSize: 12 }}>
      {keys.map(k => k === 'first_error' && s[k] ? (
        <div key={k} style={{ gridColumn: '1 / -1', padding: 8, background: '#3a1d1d', border: `1px solid ${T.red}55`, borderRadius: 4, fontSize: 11, color: T.red }}>
          <strong>First error:</strong> {s[k]}
        </div>
      ) : (
        <Stat key={k} label={prettyLabel(k)} value={s[k]}
          accent={k.includes('inserted') || k === 'upserted' ? 'green' : k === 'updated' ? 'teal' : k === 'errors' && s[k] > 0 ? 'red' : undefined}
          muted={k.startsWith('matched') || k === 'already_linked' || k === 'duplicate_in_file' || k.includes('orphan') || k.includes('no_') || k === 'headers_skipped'} />
      ))}
    </div>
  )
}
function prettyLabel(k: string) { return k.replace(/_/g, ' ').replace(/(^|\s)\w/g, m => m.toUpperCase()) }
function Stat({ label, value, accent, muted }: { label: string; value: any; accent?: 'green' | 'teal' | 'red' | 'text'; muted?: boolean }) {
  const c = accent === 'green' ? T.green : accent === 'teal' ? T.teal : accent === 'red' ? T.red : accent === 'text' ? T.text : (muted ? T.text3 : T.text2)
  return (
    <div>
      <div style={{ fontSize: 9, color: T.text3, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 3 }}>{label}</div>
      <div style={{ fontSize: 18, color: c, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{typeof value === 'number' ? value : (value ?? 0)}</div>
    </div>
  )
}

// ── History row ───────────────────────────────────────────────────────────────
function HistoryRow({ row, first, typeLabel, onOpen, onChange }: { row: ImportRow; first: boolean; typeLabel: string; onOpen: () => void; onChange: () => void }) {
  const confirmDialog = useConfirm()
  async function del(e: React.MouseEvent) {
    e.stopPropagation()
    if (!(await confirmDialog({ title: `Delete this import record (${row.filename})?`, message: "It won't undo what was imported.", danger: true }))) return
    const r = await fetch(`/api/imports/${row.id}`, { method: 'DELETE' })
    if (r.ok) onChange()
  }
  const colour = row.status === 'completed' ? T.green : row.status === 'failed' ? T.red : row.status === 'running' || row.status === 'uploading' ? T.amber : T.text3
  return (
    <div onClick={onOpen} style={{ display: 'grid', gridTemplateColumns: '110px 1fr 1fr 120px 100px 30px', gap: 10, padding: '10px 14px', borderTop: first ? 'none' : `1px solid ${T.border}`, alignItems: 'center', fontSize: 12, cursor: 'pointer' }}>
      <div style={{ color: T.text2, fontFamily: 'monospace' }}>{typeLabel}</div>
      <div style={{ color: T.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.filename}</div>
      <div style={{ color: T.text3, fontFamily: 'monospace', fontSize: 11 }}>
        {row.result_summary ? summariseRun(row.result_summary) : row.parsed_summary ? `${Object.values(row.parsed_summary).filter((v: any) => typeof v === 'number').reduce((a: number, b: any) => a + b, 0)} rows parsed` : '—'}
        {row.error && <span style={{ color: T.red, marginLeft: 6 }}>· {row.error.substring(0, 60)}</span>}
      </div>
      <div style={{ color: T.text3, fontSize: 11 }}>{new Date(row.uploaded_at).toLocaleString()}</div>
      <div style={{ color: colour, fontWeight: 600, fontSize: 11 }}>{row.status}</div>
      <button onClick={del} title="Delete record" style={{ background: 'none', border: 'none', color: T.text3, cursor: 'pointer', fontSize: 14 }}>×</button>
    </div>
  )
}
function summariseRun(s: any): string {
  const parts: string[] = []
  if (s.inserted != null) parts.push(`+${s.inserted}`)
  if (s.updated != null) parts.push(`${s.updated} merged`)
  if (s.headers_inserted != null) parts.push(`${s.headers_inserted} hdrs`)
  if (s.items_inserted != null) parts.push(`${s.items_inserted} items`)
  if (s.payments_inserted != null) parts.push(`${s.payments_inserted} pmts`)
  if (s.upserted != null) parts.push(`${s.upserted} upserted`)
  if (s.errors) parts.push(`${s.errors} err`)
  return parts.join(' · ') || '—'
}

// ── Import detail (inspect a history row) ─────────────────────────────────────
function ImportDetail({ id, typeLabel, onClose, onChange }: { id: string; typeLabel: string; onClose: () => void; onChange: () => void }) {
  const confirmDialog = useConfirm()
  const [row, setRow] = useState<ImportRow | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  async function load() {
    try { const r = await fetch(`/api/imports/${id}`); const d = await r.json(); if (r.ok) setRow(d); else setErr(d.error || 'Failed to load') }
    catch (e: any) { setErr(e?.message || 'Failed to load') }
  }
  useEffect(() => { load() }, [id])
  useEffect(() => {
    if (!row) return
    if (row.status !== 'running' && row.status !== 'uploading') return
    const iv = setInterval(load, 3000); return () => clearInterval(iv)
  }, [row?.status])

  async function runImport() {
    if (!row) return
    setBusy(true); setErr('')
    try {
      const r = await fetch(`/api/imports/${id}/run`, { method: 'POST' })
      const d = await r.json(); if (!r.ok) { setErr(d.error || 'Run failed'); return }
      await load(); onChange()
    } catch (e: any) { setErr(e?.message || 'Run failed') } finally { setBusy(false) }
  }
  async function cancelOrDelete() {
    if (!row) return
    if (!(await (row.status === 'uploading'
      ? confirmDialog({ title: 'Cancel this upload?', message: 'Any uploaded chunks will be discarded.', danger: true })
      : confirmDialog({ title: `Delete this import record (${row.filename})?`, message: "Won't undo what was imported.", danger: true })))) return
    setBusy(true); setErr('')
    try {
      const r = await fetch(`/api/imports/${id}`, { method: 'DELETE' })
      const d = await r.json().catch(() => ({})); if (!r.ok) { setErr(d.error || 'Failed'); return }
      onChange(); onClose()
    } catch (e: any) { setErr(e?.message || 'Failed') } finally { setBusy(false) }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 9000, backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '40px 20px', overflowY: 'auto' }}>
      <div style={{ width: '100%', maxWidth: 640, background: T.bg2, border: `1px solid ${T.border2}`, borderRadius: 12, maxHeight: 'calc(100vh - 80px)', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'center', padding: '14px 18px', borderBottom: `1px solid ${T.border}` }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>{typeLabel} import</div>
            <div style={{ fontSize: 11, color: T.text3, marginTop: 2 }}>{row?.filename}</div>
          </div>
          <button onClick={onClose} aria-label="Close" style={{ width: 30, height: 30, borderRadius: 6, background: T.bg3, border: `1px solid ${T.border}`, color: T.text2, cursor: 'pointer', fontSize: 16 }}>×</button>
        </div>

        <div style={{ padding: 18, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {!row && !err && <div style={{ fontSize: 12, color: T.text3 }}>Loading…</div>}
          {err && <div style={{ padding: 10, background: '#3a1d1d', border: `1px solid ${T.red}`, borderRadius: 6, color: T.red, fontSize: 12 }}>{err}</div>}
          {row && (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10, fontSize: 11 }}>
                <Info label="Status" value={<span style={{ color: row.status === 'completed' ? T.green : row.status === 'failed' ? T.red : row.status === 'uploading' || row.status === 'running' ? T.amber : T.text2, fontWeight: 600, textTransform: 'uppercase', fontSize: 11 }}>{row.status}</span>} />
                <Info label="Uploaded" value={new Date(row.uploaded_at).toLocaleString()} />
                {row.started_at && <Info label="Started" value={new Date(row.started_at).toLocaleString()} />}
                {row.completed_at && <Info label="Finished" value={new Date(row.completed_at).toLocaleString()} />}
              </div>
              {row.parsed_summary && (
                <div>
                  <div style={{ fontSize: 10, color: T.text3, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8, fontWeight: 600 }}>Parsed</div>
                  <div style={{ padding: 12, background: T.bg3, border: `1px solid ${T.border}`, borderRadius: 6 }}>
                    <SummaryGrid s={row.parsed_summary} />
                  </div>
                </div>
              )}
              {row.result_summary && (
                <div>
                  <div style={{ fontSize: 10, color: T.text3, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8, fontWeight: 600 }}>Result</div>
                  <div style={{ padding: 12, background: T.bg3, border: `1px solid ${row.status === 'completed' ? T.green + '33' : T.border}`, borderRadius: 6 }}>
                    <ResultGrid s={row.result_summary} />
                  </div>
                </div>
              )}
              {row.error && (
                <div style={{ padding: 10, background: '#3a1d1d', border: `1px solid ${T.red}`, borderRadius: 6, color: T.red, fontSize: 12 }}>
                  <div style={{ fontWeight: 600, marginBottom: 4 }}>Error</div>
                  {row.error}
                </div>
              )}
              {row.status === 'uploading' && (
                <div style={{ padding: 10, background: T.bg3, border: `1px solid ${T.amber}55`, borderRadius: 6, fontSize: 12, color: T.text2 }}>
                  This upload was interrupted before all chunks arrived. The file isn't on the server — cancel this record and re-upload.
                </div>
              )}
            </>
          )}
        </div>

        {row && (
          <div style={{ padding: '12px 18px', borderTop: `1px solid ${T.border}`, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {row.status === 'parsed' && <button onClick={runImport} disabled={busy} style={btn(true)}>{busy ? 'Running…' : 'Run import'}</button>}
            <button onClick={cancelOrDelete} disabled={busy} style={{ ...btn(false), color: T.red, borderColor: T.red + '55' }}>
              {row.status === 'uploading' ? 'Cancel upload' : row.status === 'parsed' ? 'Discard' : 'Delete record'}
            </button>
            <div style={{ flex: 1 }} />
            <button onClick={onClose} disabled={busy} style={btn(false)}>Close</button>
          </div>
        )}
      </div>
    </div>
  )
}

function Info({ label, value }: { label: string; value: any }) {
  return (
    <div>
      <div style={{ fontSize: 9, color: T.text3, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
      <div style={{ fontSize: 12, color: T.text2, marginTop: 2 }}>{value}</div>
    </div>
  )
}

const btn = (primary: boolean): React.CSSProperties => ({
  padding: '8px 16px', borderRadius: 6, fontSize: 12, fontFamily: 'inherit', fontWeight: 600,
  background: primary ? T.amber : 'transparent', color: primary ? 'var(--t-bg3)' : T.text2,
  border: primary ? 'none' : `1px solid ${T.border2}`, cursor: 'pointer',
})
const inp: React.CSSProperties = {
  padding: '6px 10px', background: T.bg3, border: `1px solid ${T.border2}`, borderRadius: 4,
  color: T.text, fontSize: 12, fontFamily: 'inherit', width: '100%',
}
