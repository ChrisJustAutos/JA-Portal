// pages/imports.tsx
// Admin page for importing MechanicDesk data. Step-driven flow:
//   1. Pick the file.
//   2. Pick the sheet (auto-suggested but always shown).
//   3. Map portal fields ← source columns (auto-suggested via aliases).
//   4. Preview counts.
//   5. Run import.
// Browser parses the file with SheetJS, applies the mapping, and POSTs the
// pre-mapped rows. The server runs the type's normalizer + runner.

import { useEffect, useMemo, useRef, useState } from 'react'
import Head from 'next/head'
import Link from 'next/link'
import * as XLSX from 'xlsx'

const T = {
  bg: '#0d0e10', bg2: '#16181c', bg3: '#1d2025',
  border: '#26282e', border2: '#33363c',
  text: '#e8ebef', text2: '#a7afba', text3: '#6b7480',
  amber: '#d4a574', green: '#7fb069', teal: '#5fb3a8',
  red: '#d97757', purple: '#a78bbd', cobalt: '#5e8acf',
} as const

interface FieldDef { id: string; label: string; aliases: string[]; required: boolean; hint: string | null }
interface TypeMeta { id: string; label: string; sheets: string[]; blurb: string; fields: FieldDef[] }

interface ImportRow {
  id: string; type: string; filename: string; uploaded_at: string
  status: 'parsed' | 'running' | 'completed' | 'failed' | 'cancelled'
  parsed_summary: any; result_summary: any; error: string | null
}

export default function ImportsPage() {
  const [types, setTypes] = useState<TypeMeta[]>([])
  const [active, setActive] = useState<string>('customers')
  const [history, setHistory] = useState<ImportRow[]>([])
  const [refreshing, setRefreshing] = useState(false)
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
        <div style={{ maxWidth: 1100, margin: '0 auto', padding: '24px 32px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 22, gap: 16, flexWrap: 'wrap' }}>
            <div>
              <Link href="/settings" style={{ fontSize: 11, color: T.text3, textDecoration: 'none', fontFamily: 'monospace' }}>← Settings</Link>
              <h1 style={{ fontSize: 22, fontWeight: 600, margin: '6px 0 2px' }}>Imports</h1>
              <div style={{ fontSize: 12, color: T.text3 }}>Drop a spreadsheet, pick the sheet, confirm which column maps to which field, then run.</div>
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
              }}>{t.label}</button>
            ))}
          </div>

          {activeMeta && <ImportFlow key={active} meta={activeMeta} onComplete={reload} />}

          <div style={{ marginTop: 28 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: T.text3, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 }}>Recent imports</div>
            {history.length === 0 ? (
              <div style={{ padding: 24, textAlign: 'center', fontSize: 12, color: T.text3, background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 8 }}>No imports yet.</div>
            ) : (
              <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 8, overflow: 'hidden' }}>
                {history.map((h, i) => <HistoryRow key={h.id} row={h} first={i === 0} typeLabel={types.find(t => t.id === h.type)?.label || h.type} onChange={reload} />)}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  )
}

// ── Step-driven flow per type ─────────────────────────────────────────────────
type Step = 'idle' | 'sheet' | 'mapping' | 'preview' | 'result'

function ImportFlow({ meta, onComplete }: { meta: TypeMeta; onComplete: () => void }) {
  const [step, setStep] = useState<Step>('idle')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')
  const [err, setErr] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [wb, setWb] = useState<XLSX.WorkBook | null>(null)
  const [sheetName, setSheetName] = useState<string>('')
  const [columns, setColumns] = useState<string[]>([])
  const [sampleRows, setSampleRows] = useState<any[]>([])
  const [mapping, setMapping] = useState<Record<string, string>>({})
  const [preview, setPreview] = useState<{ id: string; summary: any } | null>(null)
  const [result, setResult] = useState<{ summary: any } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  function reset() {
    setStep('idle'); setBusy(false); setProgress(''); setErr('')
    setFile(null); setWb(null); setSheetName(''); setColumns([]); setSampleRows([])
    setMapping({}); setPreview(null); setResult(null)
  }

  async function onFile(f: File) {
    reset()
    if (!/\.xlsx?$/i.test(f.name)) { setErr('File must be .xls or .xlsx'); return }
    setBusy(true); setFile(f)
    try {
      const buf = await f.arrayBuffer()
      const w = XLSX.read(buf, { type: 'array' })
      setWb(w)
      // Auto-pick the first matching sheet from candidates; otherwise show picker.
      const sheet = pickSheet(w, meta.sheets) || w.SheetNames[0]
      if (sheet) {
        loadSheet(w, sheet)
        // Always show the sheet picker so the user can change their mind.
        setStep('sheet')
      } else {
        setErr('No sheets found in the file.')
      }
    } catch (e: any) { setErr(e?.message || 'Failed to read file') }
    finally { setBusy(false) }
  }

  function loadSheet(w: XLSX.WorkBook, name: string) {
    setSheetName(name)
    const sheet = w.Sheets[name]
    const arr: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null })
    const headers = (arr[0] || []).map(h => String(h ?? '').trim()).filter(Boolean)
    setColumns(headers)
    // first 3 data rows for the preview pane on the mapping screen
    const obj = XLSX.utils.sheet_to_json(sheet, { defval: null })
    setSampleRows(obj.slice(0, 3))
    // auto-suggest mapping
    const m: Record<string, string> = {}
    for (const f of meta.fields) {
      const hit = bestMatch(headers, f.aliases, f.label, f.id)
      if (hit) m[f.id] = hit
    }
    setMapping(m)
  }

  async function submitMapping() {
    if (!wb || !sheetName) return
    const missing = meta.fields.filter(f => f.required && !mapping[f.id])
    if (missing.length) { setErr(`Required field${missing.length > 1 ? 's' : ''} not mapped: ${missing.map(f => f.label).join(', ')}.`); return }
    setBusy(true); setErr(''); setProgress('Reading rows…')
    try {
      const sheet = wb.Sheets[sheetName]
      const raw = XLSX.utils.sheet_to_json(sheet, { defval: null }) as any[]
      const mapped = raw.map(r => {
        const out: any = {}
        for (const f of meta.fields) {
          const col = mapping[f.id]
          if (col) out[f.id] = r[col]
        }
        return out
      })

      // Chunked upload — Vercel's request-body limit is ~4.5MB, so split.
      const CHUNK = 1500
      const chunkCount = Math.max(1, Math.ceil(mapped.length / CHUNK))
      setProgress(`Uploading 1 / ${chunkCount} chunks (${mapped.length} rows)…`)

      const r0 = await fetch('/api/imports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: meta.id, filename: file?.name || 'upload.xls', rows: mapped.slice(0, CHUNK), chunk_count: chunkCount }),
      })
      const d0 = await safeJson(r0)
      if (!r0.ok) { setErr(d0?.error || `Upload failed (HTTP ${r0.status})`); return }
      const importId = d0.id

      for (let i = 1; i < chunkCount; i++) {
        setProgress(`Uploading ${i + 1} / ${chunkCount} chunks…`)
        const r = await fetch(`/api/imports/${importId}/chunk`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chunk_index: i, rows: mapped.slice(i * CHUNK, (i + 1) * CHUNK) }),
        })
        if (!r.ok) { const e = await safeJson(r); setErr(e?.error || `Chunk ${i + 1} failed (HTTP ${r.status})`); return }
      }

      setProgress('Finalising…')
      const rf = await fetch(`/api/imports/${importId}/finalize`, { method: 'POST' })
      const df = await safeJson(rf)
      if (!rf.ok) { setErr(df?.error || `Finalise failed (HTTP ${rf.status})`); return }
      setPreview({ id: importId, summary: df.parsed_summary })
      setStep('preview')
    } catch (e: any) { setErr(e?.message || 'Upload failed') }
    finally { setBusy(false); setProgress('') }
  }

  async function safeJson(r: Response): Promise<any> {
    try { return await r.clone().json() } catch {
      const text = await r.text().catch(() => '')
      return { error: text ? `Server returned non-JSON: ${text.substring(0, 200)}` : `HTTP ${r.status}` }
    }
  }

  async function runImport() {
    if (!preview) return
    setBusy(true); setErr('')
    try {
      const r = await fetch(`/api/imports/${preview.id}/run`, { method: 'POST' })
      const d = await r.json()
      if (!r.ok) { setErr(d.error || 'Import failed'); return }
      setResult({ summary: d.result_summary })
      setStep('result')
      onComplete()
    } catch (e: any) { setErr(e?.message || 'Import failed') }
    finally { setBusy(false) }
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
          <div style={{ fontSize: 10, color: T.text3, marginTop: 6 }}>Parsed in your browser — nothing is uploaded until you confirm.</div>
        </div>
      )}

      {step === 'sheet' && wb && (
        <div>
          <Section label="1. Sheet" />
          <div style={{ fontSize: 11, color: T.text3, marginBottom: 8 }}>File: <strong style={{ color: T.text2 }}>{file?.name}</strong></div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 14 }}>
            {wb.SheetNames.map(n => {
              const isSel = n === sheetName
              const rowCount = (() => { try { return XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, defval: null }).length } catch { return '?' } })()
              return (
                <label key={n} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', background: isSel ? T.bg3 : 'transparent', border: `1px solid ${isSel ? T.amber : T.border}`, borderRadius: 6, cursor: 'pointer' }}>
                  <input type="radio" name="sheet" checked={isSel} onChange={() => loadSheet(wb, n)} />
                  <span style={{ fontSize: 13, color: T.text }}>{n}</span>
                  <span style={{ fontSize: 11, color: T.text3, marginLeft: 'auto' }}>{rowCount} rows</span>
                </label>
              )
            })}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => setStep('mapping')} disabled={!sheetName || columns.length === 0} style={btn(true)}>Continue → Map columns</button>
            <button onClick={reset} style={btn(false)}>Start over</button>
          </div>
          {columns.length === 0 && sheetName && <div style={{ marginTop: 10, fontSize: 11, color: T.amber }}>This sheet has no header row. Pick a different sheet.</div>}
        </div>
      )}

      {step === 'mapping' && (
        <div>
          <Section label="2. Column mapping" />
          <div style={{ fontSize: 11, color: T.text3, marginBottom: 12 }}>Auto-suggested from headers in the <strong style={{ color: T.text2 }}>{sheetName}</strong> sheet. Adjust where needed.</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }}>
            {meta.fields.map(f => (
              <div key={f.id} style={{ display: 'grid', gridTemplateColumns: '200px 1fr', gap: 10, alignItems: 'center' }}>
                <div>
                  <div style={{ fontSize: 12, color: T.text2 }}>
                    {f.label}{f.required && <span style={{ color: T.red, marginLeft: 4 }}>*</span>}
                  </div>
                  {f.hint && <div style={{ fontSize: 10, color: T.text3, marginTop: 1 }}>{f.hint}</div>}
                </div>
                <select value={mapping[f.id] || ''} onChange={e => setMapping(m => ({ ...m, [f.id]: e.target.value }))} style={inp}>
                  <option value="">— not in this sheet —</option>
                  {columns.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            ))}
          </div>

          {sampleRows.length > 0 && (
            <details style={{ marginBottom: 14 }}>
              <summary style={{ cursor: 'pointer', fontSize: 11, color: T.text3, marginBottom: 8 }}>Preview first 3 rows (mapped)</summary>
              <pre style={{ background: T.bg3, padding: 10, borderRadius: 6, fontSize: 10, color: T.text2, overflow: 'auto', maxHeight: 200 }}>
{JSON.stringify(sampleRows.slice(0, 3).map(r => Object.fromEntries(meta.fields.map(f => [f.id, mapping[f.id] ? r[mapping[f.id]] : null]).filter(([_, v]) => v != null))), null, 2)}
              </pre>
            </details>
          )}

          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button onClick={submitMapping} disabled={busy} style={btn(true)}>{busy ? 'Uploading…' : 'Continue → Preview'}</button>
            <button onClick={() => setStep('sheet')} disabled={busy} style={btn(false)}>← Back</button>
            <button onClick={reset} disabled={busy} style={btn(false)}>Start over</button>
            {busy && progress && <span style={{ fontSize: 11, color: T.text3, marginLeft: 8 }}>{progress}</span>}
          </div>
        </div>
      )}

      {step === 'preview' && preview && (
        <div>
          <Section label="3. Preview" />
          <div style={{ padding: 14, background: T.bg3, border: `1px solid ${T.border}`, borderRadius: 6, marginBottom: 14 }}>
            <SummaryGrid s={preview.summary} type={meta.id} />
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={runImport} disabled={busy} style={btn(true)}>{busy ? 'Running…' : 'Run import'}</button>
            <button onClick={() => setStep('mapping')} disabled={busy} style={btn(false)}>← Back</button>
            <button onClick={reset} disabled={busy} style={btn(false)}>Cancel</button>
          </div>
        </div>
      )}

      {step === 'result' && result && (
        <div>
          <Section label="✓ Done" />
          <div style={{ padding: 14, background: T.bg3, border: `1px solid ${T.green}33`, borderRadius: 6, marginBottom: 14 }}>
            <ResultGrid s={result.summary} type={meta.id} />
          </div>
          <button onClick={reset} style={btn(false)}>Run another import</button>
        </div>
      )}

      {err && <div style={{ marginTop: 12, padding: 10, background: '#3a1d1d', border: `1px solid ${T.red}`, borderRadius: 6, color: T.red, fontSize: 12 }}>{err}</div>}
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

// ── Summaries ─────────────────────────────────────────────────────────────────
function SummaryGrid({ s, type }: { s: any; type: string }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10, fontSize: 12 }}>
      {Object.entries(s || {}).map(([k, v]) => (
        <Stat key={k} label={prettyLabel(k)} value={v as any}
          accent={k === 'total_to_import' ? 'text' : k.startsWith('skipped') ? undefined : undefined}
          muted={k.startsWith('skipped')} />
      ))}
    </div>
  )
}
function ResultGrid({ s, type }: { s: any; type: string }) {
  const order = ['inserted', 'updated', 'upserted', 'matched_by_mobile', 'matched_by_email', 'matched_by_name', 'matched_md_id', 'matched_rego', 'matched_sku', 'already_linked', 'no_customer', 'no_vehicle', 'errors']
  const keys = Object.keys(s || {}).sort((a, b) => {
    const ia = order.indexOf(a), ib = order.indexOf(b)
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
  })
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10, fontSize: 12 }}>
      {keys.map(k => (
        <Stat key={k} label={prettyLabel(k)} value={s[k]}
          accent={k === 'inserted' ? 'green' : k === 'updated' || k === 'upserted' ? 'teal' : k === 'errors' && s[k] > 0 ? 'red' : undefined}
          muted={k.startsWith('matched') || k === 'already_linked' || k === 'no_customer' || k === 'no_vehicle'} />
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
function HistoryRow({ row, first, typeLabel, onChange }: { row: ImportRow; first: boolean; typeLabel: string; onChange: () => void }) {
  async function del() {
    if (!confirm(`Delete this import record (${row.filename})? It won't undo what was imported.`)) return
    const r = await fetch(`/api/imports/${row.id}`, { method: 'DELETE' })
    if (r.ok) onChange()
  }
  const colour = row.status === 'completed' ? T.green : row.status === 'failed' ? T.red : row.status === 'running' ? T.amber : T.text3
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '110px 1fr 1fr 120px 100px 30px', gap: 10, padding: '10px 14px', borderTop: first ? 'none' : `1px solid ${T.border}`, alignItems: 'center', fontSize: 12 }}>
      <div style={{ color: T.text2, fontFamily: 'monospace' }}>{typeLabel}</div>
      <div style={{ color: T.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.filename}</div>
      <div style={{ color: T.text3, fontFamily: 'monospace', fontSize: 11 }}>
        {row.result_summary ? summariseRun(row.result_summary)
         : row.parsed_summary ? `${row.parsed_summary.total_to_import || row.parsed_summary.total_in_file || '?'} parsed`
         : '—'}
        {row.error && <span style={{ color: T.red, marginLeft: 6 }}>· {row.error.substring(0, 60)}</span>}
      </div>
      <div style={{ color: T.text3, fontSize: 11 }}>{new Date(row.uploaded_at).toLocaleString()}</div>
      <div style={{ color: colour, fontWeight: 600, fontSize: 11 }}>{row.status}</div>
      <button onClick={del} title="Delete record" style={{ background: 'none', border: 'none', color: T.text3, cursor: 'pointer', fontSize: 14 }}>×</button>
    </div>
  )
}
function summariseRun(s: any): string {
  if (s.inserted != null || s.updated != null) return `+${s.inserted || 0} new · ${s.updated || 0} merged${s.errors ? ` · ${s.errors} err` : ''}`
  if (s.upserted != null) return `${s.upserted} upserted${s.errors ? ` · ${s.errors} err` : ''}`
  return Object.entries(s || {}).map(([k, v]) => `${prettyLabel(k)}: ${v}`).join(' · ').substring(0, 80)
}

const btn = (primary: boolean): React.CSSProperties => ({
  padding: '8px 16px', borderRadius: 6, fontSize: 12, fontFamily: 'inherit', fontWeight: 600,
  background: primary ? T.amber : 'transparent', color: primary ? '#1a1d23' : T.text2,
  border: primary ? 'none' : `1px solid ${T.border2}`, cursor: 'pointer',
})
const inp: React.CSSProperties = {
  padding: '6px 10px', background: T.bg3, border: `1px solid ${T.border2}`, borderRadius: 4,
  color: T.text, fontSize: 12, fontFamily: 'inherit', width: '100%',
}
