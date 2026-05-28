// pages/imports.tsx
// Admin page for importing MechanicDesk data into the portal. Drop an .xls/.xlsx,
// the browser parses it with SheetJS, the server normalises + previews, you
// confirm, the server runs it.
//
// Phase 1: Customers (live). Others stubbed as "coming soon".

import { useEffect, useRef, useState } from 'react'
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

type ImportType = 'customers' | 'job_types' | 'vehicles' | 'inventory' | 'quotes' | 'invoices' | 'purchase_orders'

const TYPES: { id: ImportType; label: string; sheets: string[]; status: 'live' | 'soon' }[] = [
  { id: 'customers',        label: 'Customers',        sheets: ['Customers', 'Customer'],                     status: 'live' },
  { id: 'job_types',        label: 'Job types',        sheets: ['Job Type Summaries', 'Job Types'],           status: 'soon' },
  { id: 'vehicles',         label: 'Vehicles',         sheets: ['Vehicles', 'Vehicle'],                       status: 'soon' },
  { id: 'inventory',        label: 'Inventory',        sheets: ['Stocks', 'Stock', 'Inventory'],              status: 'soon' },
  { id: 'quotes',           label: 'Quotes',           sheets: ['Quotes', 'Quote'],                           status: 'soon' },
  { id: 'invoices',         label: 'Invoices',         sheets: ['Invoices', 'Invoice'],                       status: 'soon' },
  { id: 'purchase_orders',  label: 'Purchase orders',  sheets: ['Purchases', 'Purchase Orders', 'Purchase'],  status: 'soon' },
]

// Try to resolve the right sheet from a workbook. Order:
//   1. exact match against any candidate
//   2. case-insensitive + trimmed match
//   3. partial substring match either direction
function resolveSheet(wb: XLSX.WorkBook, candidates: string[]): { name: string; sheet: XLSX.WorkSheet } | null {
  for (const c of candidates) if (wb.Sheets[c]) return { name: c, sheet: wb.Sheets[c] }
  const norm = wb.SheetNames.map(n => ({ orig: n, n: n.trim().toLowerCase() }))
  for (const c of candidates) {
    const cn = c.trim().toLowerCase()
    const hit = norm.find(x => x.n === cn)
    if (hit) return { name: hit.orig, sheet: wb.Sheets[hit.orig] }
  }
  for (const c of candidates) {
    const cn = c.trim().toLowerCase()
    const hit = norm.find(x => x.n.includes(cn) || cn.includes(x.n))
    if (hit) return { name: hit.orig, sheet: wb.Sheets[hit.orig] }
  }
  return null
}

interface ImportRow {
  id: string
  type: ImportType
  filename: string
  uploaded_at: string
  status: 'parsed' | 'running' | 'completed' | 'failed' | 'cancelled'
  parsed_summary: any
  result_summary: any
  error: string | null
  started_at: string | null
  completed_at: string | null
}

export default function ImportsPage() {
  const [active, setActive] = useState<ImportType>('customers')
  const [history, setHistory] = useState<ImportRow[]>([])
  const [refreshing, setRefreshing] = useState(false)

  const reload = async () => {
    const r = await fetch('/api/imports')
    const d = await r.json()
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
              <div style={{ fontSize: 12, color: T.text3 }}>Bring MechanicDesk data into the portal. Drop an XLS/XLSX export from MD; the portal parses it, shows a preview, and you confirm before anything is written.</div>
            </div>
            <button onClick={() => { setRefreshing(true); reload().finally(() => setRefreshing(false)) }} style={btn(false)}>{refreshing ? '↻ Refreshing…' : '↻ Refresh'}</button>
          </div>

          {/* Type tabs */}
          <div style={{ display: 'flex', gap: 4, borderBottom: `1px solid ${T.border}`, marginBottom: 18, overflowX: 'auto' }}>
            {TYPES.map(t => (
              <button key={t.id} onClick={() => setActive(t.id)} style={{
                padding: '8px 14px', background: 'transparent',
                border: 'none', borderBottom: active === t.id ? `2px solid ${T.amber}` : '2px solid transparent',
                color: active === t.id ? T.text : T.text3,
                fontSize: 12, fontFamily: 'inherit', fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
              }}>
                {t.label}{t.status === 'soon' && <span style={{ marginLeft: 6, fontSize: 9, color: T.text3, fontWeight: 400 }}>soon</span>}
              </button>
            ))}
          </div>

          <UploadCard type={active} typeMeta={TYPES.find(t => t.id === active)!} onComplete={reload} />

          {/* History */}
          <div style={{ marginTop: 28 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: T.text3, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 }}>Recent imports</div>
            {history.length === 0 ? (
              <div style={{ padding: 24, textAlign: 'center', fontSize: 12, color: T.text3, background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 8 }}>No imports yet.</div>
            ) : (
              <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 8, overflow: 'hidden' }}>
                {history.map((h, i) => <HistoryRow key={h.id} row={h} first={i === 0} onChange={reload} />)}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  )
}

// ── Upload card ───────────────────────────────────────────────────────────────
function UploadCard({ type, typeMeta, onComplete }: { type: ImportType; typeMeta: { label: string; sheets: string[]; status: 'live' | 'soon' }; onComplete: () => void }) {
  const [busy, setBusy] = useState<'parse' | 'run' | null>(null)
  const [preview, setPreview] = useState<{ id: string; summary: any; filename: string } | null>(null)
  const [result, setResult] = useState<{ summary: any } | null>(null)
  const [err, setErr] = useState('')
  // If we couldn't auto-find the sheet, stash the parsed workbook + filename
  // here so the user can pick which sheet to use.
  const [pendingPick, setPendingPick] = useState<{ wb: XLSX.WorkBook; filename: string } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const reset = () => { setPreview(null); setResult(null); setErr(''); setPendingPick(null) }

  async function uploadSheet(wb: XLSX.WorkBook, sheetName: string, filename: string) {
    setBusy('parse')
    try {
      const sheet = wb.Sheets[sheetName]
      if (!sheet) { setErr(`Sheet "${sheetName}" not found.`); return }
      const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: null })
      const r = await fetch('/api/imports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, filename, raw_rows: rawRows }),
      })
      const d = await r.json()
      if (!r.ok) { setErr(d.error || 'Parse failed'); return }
      setPreview({ id: d.id, summary: d.parsed_summary, filename })
      setPendingPick(null)
    } catch (e: any) { setErr(e?.message || 'Parse failed') }
    finally { setBusy(null) }
  }

  async function onFile(file: File) {
    reset()
    if (typeMeta.status === 'soon') { setErr(`The ${typeMeta.label} importer isn't live yet — coming soon.`); return }
    if (!/\.xlsx?$/i.test(file.name)) { setErr('File must be .xls or .xlsx'); return }
    setBusy('parse')
    try {
      const buf = await file.arrayBuffer()
      const wb = XLSX.read(buf, { type: 'array' })
      const hit = resolveSheet(wb, typeMeta.sheets)
      if (!hit) {
        // Let the user pick which sheet to use.
        setBusy(null)
        setPendingPick({ wb, filename: file.name })
        return
      }
      await uploadSheet(wb, hit.name, file.name)
    } catch (e: any) { setErr(e?.message || 'Failed to read file'); setBusy(null) }
  }

  async function run() {
    if (!preview) return
    setBusy('run'); setErr('')
    try {
      const r = await fetch(`/api/imports/${preview.id}/run`, { method: 'POST' })
      const d = await r.json()
      if (!r.ok) { setErr(d.error || 'Import failed'); return }
      setResult({ summary: d.result_summary })
      onComplete()
    } catch (e: any) { setErr(e?.message || 'Import failed') }
    finally { setBusy(null) }
  }

  if (typeMeta.status === 'soon') {
    return (
      <div style={{ padding: 28, background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 10, textAlign: 'center' }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: T.text, marginBottom: 6 }}>{typeMeta.label} importer — coming soon</div>
        <div style={{ fontSize: 12, color: T.text3 }}>Phase 1 ships with the Customers importer. {typeMeta.label.toLowerCase()} follows in the next batch.</div>
      </div>
    )
  }

  return (
    <div style={{ padding: 20, background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 10 }}>
      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Import {typeMeta.label.toLowerCase()}</div>
      <div style={{ fontSize: 11, color: T.text3, marginBottom: 14 }}>Expects the MD <code style={{ fontFamily: 'monospace', color: T.text2 }}>{typeMeta.sheets[0]}</code> sheet (case-insensitive — you'll be asked to pick if auto-detect can't find it). Customers are merged with existing rows by mobile → email → name; unmatched rows are inserted.</div>

      {!preview && !result && !pendingPick && (
        <div onClick={() => inputRef.current?.click()}
             onDragOver={e => e.preventDefault()}
             onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) onFile(f) }}
             style={{ padding: '36px 20px', textAlign: 'center', border: `2px dashed ${T.border2}`, borderRadius: 8, cursor: busy ? 'default' : 'pointer', background: T.bg3 }}>
          <input ref={inputRef} type="file" accept=".xls,.xlsx" style={{ display: 'none' }} onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f) }} />
          <div style={{ fontSize: 13, color: T.text2, fontWeight: 500 }}>{busy === 'parse' ? 'Parsing…' : 'Drop .xls/.xlsx here, or click to browse'}</div>
          <div style={{ fontSize: 10, color: T.text3, marginTop: 6 }}>The file isn't uploaded — your browser parses it and posts the rows as JSON.</div>
        </div>
      )}

      {pendingPick && !preview && !result && (
        <div style={{ padding: 14, background: T.bg3, border: `1px solid ${T.amber}55`, borderRadius: 6 }}>
          <div style={{ fontSize: 12, color: T.text2, marginBottom: 8 }}>
            Couldn't auto-find the {typeMeta.label.toLowerCase()} sheet (looked for: <code style={{ fontFamily: 'monospace', color: T.text3 }}>{typeMeta.sheets.join(', ')}</code>). Pick the right one:
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {pendingPick.wb.SheetNames.map(n => (
              <button key={n} onClick={() => uploadSheet(pendingPick.wb, n, pendingPick.filename)} disabled={busy === 'parse'} style={{
                padding: '6px 12px', borderRadius: 4, fontSize: 11, fontFamily: 'inherit', fontWeight: 600,
                background: 'transparent', color: T.text2, border: `1px solid ${T.border2}`, cursor: 'pointer',
              }}>{n}</button>
            ))}
          </div>
          <button onClick={reset} style={{ ...btn(false), marginTop: 10, padding: '5px 10px', fontSize: 11 }}>Cancel</button>
        </div>
      )}

      {preview && !result && (
        <div>
          <div style={{ padding: 14, background: T.bg3, border: `1px solid ${T.border}`, borderRadius: 6, marginBottom: 14 }}>
            <div style={{ fontSize: 12, color: T.text2, marginBottom: 8 }}>Parsed <strong style={{ color: T.text }}>{preview.filename}</strong></div>
            <SummaryGrid s={preview.summary} type={type} />
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={run} disabled={busy === 'run'} style={btn(true)}>{busy === 'run' ? 'Running…' : 'Run import'}</button>
            <button onClick={reset} disabled={busy === 'run'} style={btn(false)}>Cancel</button>
          </div>
        </div>
      )}

      {result && (
        <div>
          <div style={{ padding: 14, background: T.bg3, border: `1px solid ${T.green}33`, borderRadius: 6, marginBottom: 14 }}>
            <div style={{ fontSize: 13, color: T.green, fontWeight: 600, marginBottom: 8 }}>✓ Import complete</div>
            <ResultGrid s={result.summary} type={type} />
          </div>
          <button onClick={reset} style={btn(false)}>Run another import</button>
        </div>
      )}

      {err && <div style={{ marginTop: 12, padding: 10, background: '#3a1d1d', border: `1px solid ${T.red}`, borderRadius: 6, color: T.red, fontSize: 12 }}>{err}</div>}
    </div>
  )
}

// ── Summary grids ─────────────────────────────────────────────────────────────
function SummaryGrid({ s, type }: { s: any; type: ImportType }) {
  if (type === 'customers') {
    return (
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, fontSize: 12 }}>
        <Stat label="In file"        value={s.total_in_file} />
        <Stat label="To import"      value={s.total_to_import} accent="text" />
        <Stat label="Skipped — third-party" value={s.skipped_third_party} muted />
        <Stat label="Skipped — no name"     value={s.skipped_no_name} muted />
      </div>
    )
  }
  return <pre style={{ fontSize: 11, color: T.text2 }}>{JSON.stringify(s, null, 2)}</pre>
}

function ResultGrid({ s, type }: { s: any; type: ImportType }) {
  if (type === 'customers') {
    const matched = (s.matched_by_mobile || 0) + (s.matched_by_email || 0) + (s.matched_by_name || 0)
    return (
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, fontSize: 12 }}>
        <Stat label="New (inserted)" value={s.inserted} accent="green" />
        <Stat label="Merged into existing" value={s.updated} accent="teal" />
        <Stat label="Already linked" value={s.already_linked} muted />
        <Stat label="Matched by mobile" value={s.matched_by_mobile} muted />
        <Stat label="Matched by email" value={s.matched_by_email} muted />
        <Stat label="Matched by name" value={s.matched_by_name} muted />
        {s.errors > 0 && <Stat label="Errors" value={s.errors} accent="red" />}
      </div>
    )
  }
  return <pre style={{ fontSize: 11, color: T.text2 }}>{JSON.stringify(s, null, 2)}</pre>
}

function Stat({ label, value, accent, muted }: { label: string; value: any; accent?: 'green' | 'teal' | 'red' | 'text'; muted?: boolean }) {
  const c = accent === 'green' ? T.green : accent === 'teal' ? T.teal : accent === 'red' ? T.red : accent === 'text' ? T.text : (muted ? T.text3 : T.text2)
  return (
    <div>
      <div style={{ fontSize: 9, color: T.text3, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 3 }}>{label}</div>
      <div style={{ fontSize: 18, color: c, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{value ?? 0}</div>
    </div>
  )
}

// ── History row ───────────────────────────────────────────────────────────────
function HistoryRow({ row, first, onChange }: { row: ImportRow; first: boolean; onChange: () => void }) {
  async function del() {
    if (!confirm(`Delete this import record (${row.filename})? It won't undo what was imported.`)) return
    const r = await fetch(`/api/imports/${row.id}`, { method: 'DELETE' })
    if (r.ok) onChange()
  }
  const colour = row.status === 'completed' ? T.green : row.status === 'failed' ? T.red : row.status === 'running' ? T.amber : T.text3
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '100px 1fr 1fr 120px 100px 30px', gap: 10, padding: '10px 14px', borderTop: first ? 'none' : `1px solid ${T.border}`, alignItems: 'center', fontSize: 12 }}>
      <div style={{ color: T.text2, fontFamily: 'monospace' }}>{TYPES.find(t => t.id === row.type)?.label || row.type}</div>
      <div style={{ color: T.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.filename}</div>
      <div style={{ color: T.text3, fontFamily: 'monospace', fontSize: 11 }}>
        {row.result_summary ? <ResultInline s={row.result_summary} type={row.type} /> : row.parsed_summary ? <span>{row.parsed_summary.total_to_import || row.parsed_summary.total_in_file} parsed</span> : '—'}
      </div>
      <div style={{ color: T.text3, fontSize: 11 }}>{new Date(row.uploaded_at).toLocaleString()}</div>
      <div style={{ color: colour, fontWeight: 600, fontSize: 11 }}>{row.status}</div>
      <button onClick={del} title="Delete record" style={{ background: 'none', border: 'none', color: T.text3, cursor: 'pointer', fontSize: 14 }}>×</button>
    </div>
  )
}

function ResultInline({ s, type }: { s: any; type: ImportType }) {
  if (type === 'customers') {
    return <span>+{s.inserted || 0} new · {s.updated || 0} merged{s.errors ? ` · ${s.errors} err` : ''}</span>
  }
  return <span>—</span>
}

const btn = (primary: boolean): React.CSSProperties => ({
  padding: '8px 16px', borderRadius: 6, fontSize: 12, fontFamily: 'inherit', fontWeight: 600,
  background: primary ? T.amber : 'transparent', color: primary ? '#1a1d23' : T.text2,
  border: primary ? 'none' : `1px solid ${T.border2}`, cursor: 'pointer',
})
