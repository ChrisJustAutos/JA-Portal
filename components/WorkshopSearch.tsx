// components/WorkshopSearch.tsx
// Workshop-wide search box (lives in the WorkshopTabs strip, so it's on every
// workshop screen). Searches customers / vehicles / jobs / invoices through
// /api/workshop/search, which normalises phone (digits-only) and rego/VIN
// (whitespace-stripped) matching — "0410 599 778" finds "0410599778",
// "254 PE4" finds "254PE4".
//
// Keyboard: ↑/↓ move, Enter opens, Esc closes. Click-outside closes.

import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/router'
import { T, alpha } from '../lib/ui/theme'

interface CustomerHit { id: string; name: string; company: string | null; customer_number: string | null; phone: string | null; mobile: string | null; email: string | null }
interface VehicleHit { id: string; rego: string | null; vin: string | null; make: string | null; model: string | null; year: number | null; customer_name: string | null }
interface JobHit { id: string; status: string; starts_at: string; job_type: string | null; description: string | null; summary: string | null; customer_name: string | null; rego: string | null; make: string | null; model: string | null }
interface InvoiceHit { id: string; md_id: string | null; status: string; total: number | null; created_at: string; customer_name: string | null }

interface Results { customers: CustomerHit[]; vehicles: VehicleHit[]; jobs: JobHit[]; invoices: InvoiceHit[] }
const EMPTY: Results = { customers: [], vehicles: [], jobs: [], invoices: [] }

interface FlatRow { key: string; href: string; title: string; sub: string; badge?: string; badgeColor?: string }

const JOB_STATUS_COLORS: Record<string, string> = {
  prebooked: T.text2, booking: T.text2, confirmed: T.blue, in_progress: T.amber,
  awaiting_parts: T.purple, ready: T.teal, done: T.green, invoiced: T.green,
  paid: T.green, cancelled: T.red, no_show: T.red,
}
const INVOICE_STATUS_COLORS: Record<string, string> = {
  pending: T.amber, sent: T.blue, paid: T.green, overdue: T.red, void: T.text3,
}

function fmtJobDate(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: '2-digit' })
}

export default function WorkshopSearch() {
  const router = useRouter()
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [results, setResults] = useState<Results>(EMPTY)
  const [sel, setSel] = useState(0)
  const boxRef = useRef<HTMLDivElement>(null)
  const seqRef = useRef(0)

  // Debounced fetch — drop out-of-order responses so fast typing can't show
  // results for a stale query.
  useEffect(() => {
    const query = q.trim()
    if (query.length < 2) { setResults(EMPTY); setLoading(false); return }
    setLoading(true)
    const seq = ++seqRef.current
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/workshop/search?q=${encodeURIComponent(query)}`)
        const d = await r.json()
        if (seqRef.current !== seq) return
        setResults(r.ok ? { customers: d.customers || [], vehicles: d.vehicles || [], jobs: d.jobs || [], invoices: d.invoices || [] } : EMPTY)
      } catch { if (seqRef.current === seq) setResults(EMPTY) }
      finally { if (seqRef.current === seq) setLoading(false) }
    }, 250)
    return () => clearTimeout(t)
  }, [q])

  // Close on outside click
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  // Flatten grouped results for keyboard navigation
  const groups = useMemo(() => {
    const g: { label: string; rows: FlatRow[] }[] = []
    if (results.customers.length) g.push({
      label: 'Customers',
      rows: results.customers.map(c => ({
        key: `c${c.id}`, href: `/workshop/customer/${c.id}`,
        title: c.company ? `${c.name} · ${c.company}` : c.name,
        sub: [c.customer_number && `#${c.customer_number}`, c.mobile || c.phone, c.email].filter(Boolean).join(' · '),
      })),
    })
    if (results.vehicles.length) g.push({
      label: 'Vehicles',
      rows: results.vehicles.map(v => ({
        key: `v${v.id}`, href: `/workshop/vehicle/${v.id}`,
        title: [v.rego || '(no rego)', [v.year, v.make, v.model].filter(Boolean).join(' ')].filter(Boolean).join(' — '),
        sub: [v.customer_name, v.vin && `VIN ${v.vin}`].filter(Boolean).join(' · '),
      })),
    })
    if (results.jobs.length) g.push({
      label: 'Jobs',
      rows: results.jobs.map(j => ({
        key: `j${j.id}`, href: `/workshop/job/${j.id}`,
        title: [j.customer_name || 'Job', j.rego].filter(Boolean).join(' — '),
        sub: [fmtJobDate(j.starts_at), [j.make, j.model].filter(Boolean).join(' '), (j.description || j.summary || '').slice(0, 60)].filter(Boolean).join(' · '),
        badge: j.status.replace(/_/g, ' '), badgeColor: JOB_STATUS_COLORS[j.status] || T.text2,
      })),
    })
    if (results.invoices.length) g.push({
      label: 'Invoices',
      rows: results.invoices.map(i => ({
        key: `i${i.id}`, href: `/workshop/invoice/${i.id}`,
        title: [i.md_id ? `Invoice #${i.md_id}` : 'Invoice', i.customer_name].filter(Boolean).join(' — '),
        sub: [fmtJobDate(i.created_at), i.total != null ? `$${Number(i.total).toLocaleString('en-AU', { minimumFractionDigits: 2 })}` : null].filter(Boolean).join(' · '),
        badge: i.status, badgeColor: INVOICE_STATUS_COLORS[i.status] || T.text2,
      })),
    })
    return g
  }, [results])

  const flat = useMemo(() => groups.flatMap(g => g.rows), [groups])
  useEffect(() => { setSel(0) }, [q, flat.length])

  const showPanel = open && q.trim().length >= 2

  // The tab strip is an overflow-x:auto container, which would clip an
  // absolutely-positioned dropdown — so the panel is position:fixed, anchored
  // to the input's on-screen rect.
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null)
  useEffect(() => {
    if (!showPanel) return
    const update = () => {
      const r = boxRef.current?.getBoundingClientRect()
      if (r) setPos({ top: r.bottom + 6, right: Math.max(12, window.innerWidth - r.right) })
    }
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [showPanel])

  function go(href: string) {
    setOpen(false)
    setQ('')
    router.push(href)
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') { setOpen(false); (e.target as HTMLInputElement).blur(); return }
    if (!flat.length) return
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel(s => Math.min(flat.length - 1, s + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel(s => Math.max(0, s - 1)) }
    else if (e.key === 'Enter') { e.preventDefault(); const row = flat[sel]; if (row) go(row.href) }
  }

  let flatIdx = -1
  return (
    <div ref={boxRef} style={{ position: 'relative', marginLeft: 'auto', flexShrink: 1, minWidth: 120, width: 280 }}>
      <input
        value={q}
        onChange={e => { setQ(e.target.value); setOpen(true) }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        placeholder="Search name, phone, rego, VIN, invoice #…"
        style={{
          width: '100%', boxSizing: 'border-box', padding: '6px 10px', background: T.bg3, color: T.text,
          border: `1px solid ${T.border2}`, borderRadius: 6, fontSize: 12, fontFamily: 'inherit', outline: 'none',
        }}
      />
      {showPanel && pos && (
        <div style={{
          position: 'fixed', top: pos.top, right: pos.right, zIndex: 200,
          width: 420, maxWidth: 'calc(100vw - 24px)', maxHeight: 480, overflowY: 'auto',
          background: T.bg2, border: `1px solid ${T.border2}`, borderRadius: 10,
          boxShadow: '0 12px 32px rgba(0,0,0,0.35)',
        }}>
          {flat.length === 0 && (
            <div style={{ padding: '16px 14px', fontSize: 12, color: T.text3 }}>
              {loading ? 'Searching…' : 'No matches — try a name, phone, rego, VIN, customer # or invoice #.'}
            </div>
          )}
          {groups.map(g => (
            <div key={g.label}>
              <div style={{
                padding: '7px 12px 4px', fontSize: 10, fontWeight: 700, color: T.text3,
                textTransform: 'uppercase', letterSpacing: '0.06em',
                borderTop: `1px solid ${T.border}`,
              }}>{g.label}</div>
              {g.rows.map(row => {
                flatIdx++
                const idx = flatIdx
                const active = idx === sel
                return (
                  <div key={row.key}
                    onMouseDown={e => { e.preventDefault(); go(row.href) }}
                    onMouseEnter={() => setSel(idx)}
                    style={{
                      padding: '7px 12px', cursor: 'pointer',
                      background: active ? alpha(T.accent, '1a') : 'transparent',
                      display: 'flex', alignItems: 'baseline', gap: 8,
                    }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12.5, fontWeight: 600, color: T.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.title}</div>
                      {row.sub && <div style={{ fontSize: 11, color: T.text2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginTop: 1 }}>{row.sub}</div>}
                    </div>
                    {row.badge && (
                      <span style={{
                        flexShrink: 0, fontSize: 9, fontWeight: 700, textTransform: 'uppercase',
                        color: row.badgeColor, background: alpha(row.badgeColor || T.text2, '1e'),
                        padding: '2px 7px', borderRadius: 4,
                      }}>{row.badge}</span>
                    )}
                  </div>
                )
              })}
            </div>
          ))}
          {loading && flat.length > 0 && (
            <div style={{ padding: '6px 12px', fontSize: 10, color: T.text3, borderTop: `1px solid ${T.border}` }}>Updating…</div>
          )}
        </div>
      )}
    </div>
  )
}
