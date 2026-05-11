// pages/stripe-myob.tsx
// Stripe → MYOB push tool. Lists Stripe invoices for a connected
// account + date range, shows their MYOB sync status, and lets
// authorised users push them to MYOB (creates the Professional
// Invoice + Customer Payment pair using lib/stripe-myob-sync.ts).
//
// This is the manual fallback for when the Make.com automation
// stops working — same pattern, but visible and auditable in the
// portal.

import { useState, useEffect, useMemo, useCallback } from 'react'
import Head from 'next/head'
import PortalSidebar from '../lib/PortalSidebar'
import { requirePageAuth } from '../lib/authServer'
import { UserRole, roleHasPermission } from '../lib/permissions'

const T = {
  bg:'#0d0f12', bg2:'#131519', bg3:'#1a1d23', bg4:'#21252d',
  border:'rgba(255,255,255,0.07)', border2:'rgba(255,255,255,0.12)',
  text:'#e8eaf0', text2:'#8b90a0', text3:'#545968',
  blue:'#4f8ef7', teal:'#2dd4bf', green:'#34c77b',
  amber:'#f5a623', red:'#f04e4e', purple:'#a78bfa',
  accent:'#4f8ef7',
}

// Date the Make.com Stripe→MYOB automation broke. Pushes for invoices
// dated before this are higher-risk for duplicates because Make almost
// certainly already created them. Adjust if the cutover shifts.
const MAKE_CUTOVER_DATE = '2026-04-16'

function isPreCutover(iso: string | null): boolean {
  if (!iso) return false
  return iso.slice(0, 10) < MAKE_CUTOVER_DATE
}

type AccountLabel = 'JAWS_JMACX' | 'JAWS_ET'

interface StripeInvoiceRow {
  id: string
  number: string | null
  status: string
  paid: boolean
  created: string
  paid_at: string | null
  customer: string | null
  customer_email: string | null
  customer_name: string | null
  total_cents: number
  currency: string
  description: string | null
  lines: Array<{ id: string; amount_cents: number; description: string | null; quantity: number | null }>
  // sync log
  myobStatus: 'pending' | 'pushed' | 'failed' | 'skipped_duplicate'
  myobInvoiceUid: string | null
  myobPaymentUid: string | null
  myobCustomerUid: string | null
  myobFeeCents: number | null
  myobNetCents: number | null
  lastError: string | null
  pushedAt: string | null
  attempts: number
}

interface ListResponse {
  ok: true
  account: AccountLabel
  since: string
  until: string
  stripeAccount: any
  summary: { total: number; pushed: number; pending: number; failed: number; duplicate: number }
  invoices: StripeInvoiceRow[]
}

interface PushPreview {
  stripeInvoiceId: string
  stripeNumber: string | null
  stripeStatus: 'idempotent' | 'duplicate-in-myob' | 'ready' | 'blocked'
  blockedReason?: string
  gross_cents: number
  fee_cents: number
  net_cents: number
  feeResolution: string
  customer: {
    decision: 'reuse' | 'create' | 'ambiguous' | 'error'
    myobUid?: string
    myobDisplayId?: string
    myobName?: string
    candidates?: Array<{ uid: string; name: string; displayId: string }>
    note?: string
    stripeEmail: string | null
    stripeName: string | null
  }
  invoicePayload: any
  paymentPayload: any | null
  pushed?: boolean
  myobInvoiceUid?: string
  myobInvoiceNumber?: string
  error?: string
}

// ── Helpers ─────────────────────────────────────────────────────────────

function fmtMoneyCents(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '—'
  return '$' + (cents / 100).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function fmtDateShort(s: string | null): string {
  if (!s) return '—'
  const d = new Date(s)
  if (isNaN(d.getTime())) return s
  return d.toLocaleDateString('en-AU', { day:'2-digit', month:'short', year:'2-digit' })
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}
function daysAgoIso(n: number): string {
  return new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10)
}

function StatusBadge({ status, compact=false }: { status: StripeInvoiceRow['myobStatus'], compact?: boolean }) {
  const map: Record<StripeInvoiceRow['myobStatus'], { label: string; color: string }> = {
    pending:           { label: 'Pending', color: T.amber },
    pushed:            { label: 'Pushed',  color: T.green },
    failed:            { label: 'Failed',  color: T.red },
    skipped_duplicate: { label: 'Already in MYOB', color: T.purple },
  }
  const m = map[status]
  return (
    <span style={{
      display:'inline-block',
      padding: compact ? '2px 7px' : '3px 10px',
      borderRadius: 10,
      background: `${m.color}22`,
      color: m.color,
      border: `1px solid ${m.color}55`,
      fontSize: compact ? 10 : 11,
      fontWeight: 600,
      textTransform: 'uppercase',
      letterSpacing: '0.04em',
      whiteSpace: 'nowrap',
    }}>{m.label}</span>
  )
}

// ── Auth — page-level ───────────────────────────────────────────────────
export async function getServerSideProps(ctx: any) {
  return requirePageAuth(ctx, 'view:stripe_myob')
}

interface PageUser { id: string; email: string; role: UserRole; displayName: string | null }

export default function StripeMyobPage({ user }: { user: PageUser }) {
  const canPush = roleHasPermission(user.role, 'edit:stripe_myob')

  // ── Filters ─────────────────────────────────────────────────────────
  const [account, setAccount] = useState<AccountLabel>('JAWS_JMACX')
  const [since, setSince] = useState<string>(daysAgoIso(60))
  const [until, setUntil] = useState<string>(todayIso())

  // ── Data ────────────────────────────────────────────────────────────
  const [rows, setRows] = useState<StripeInvoiceRow[]>([])
  const [summary, setSummary] = useState<ListResponse['summary'] | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // ── Push state ──────────────────────────────────────────────────────
  const [pushingIds, setPushingIds] = useState<Set<string>>(new Set())
  const [activePreview, setActivePreview] = useState<PushPreview | null>(null)
  const [activeRowDate, setActiveRowDate] = useState<string | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [overrideCustomerUid, setOverrideCustomerUid] = useState<string | null>(null)
  const [preCutoverAck, setPreCutoverAck] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [syncResult, setSyncResult] = useState<{ scanned: number; matched: number } | null>(null)

  // ── Load data ───────────────────────────────────────────────────────
  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const qs = new URLSearchParams({ account, since, until })
      const res = await fetch(`/api/stripe-myob/list?${qs.toString()}`, { credentials: 'include' })
      const json: any = await res.json()
      if (!res.ok || !json.ok) {
        throw new Error(json.error || `HTTP ${res.status}`)
      }
      const data = json as ListResponse
      setRows(data.invoices)
      setSummary(data.summary)
    } catch (e: any) {
      setErr(e?.message || String(e))
      setRows([])
      setSummary(null)
    } finally {
      setLoading(false)
    }
  }, [account, since, until])

  useEffect(() => { load() }, [load])

  // ── Push handlers ───────────────────────────────────────────────────
  const dryRun = useCallback(async (row: StripeInvoiceRow): Promise<PushPreview | null> => {
    setPreviewLoading(true)
    try {
      const res = await fetch('/api/stripe-myob/push?dry=1', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account, stripeInvoiceIds: [row.id] }),
      })
      const json: any = await res.json()
      if (!res.ok || !json.ok) throw new Error(json.error || `HTTP ${res.status}`)
      return json.results?.[0] || null
    } catch (e: any) {
      setErr(e?.message || String(e))
      return null
    } finally {
      setPreviewLoading(false)
    }
  }, [account])

  const onPreviewClick = useCallback(async (row: StripeInvoiceRow) => {
    setActivePreview(null)
    setOverrideCustomerUid(null)
    setPreCutoverAck(false)
    setActiveRowDate(row.paid_at || row.created)
    const preview = await dryRun(row)
    if (preview) setActivePreview(preview)
  }, [dryRun])

  const onPushConfirm = useCallback(async () => {
    if (!activePreview) return
    const id = activePreview.stripeInvoiceId
    setPushingIds(prev => new Set(prev).add(id))
    try {
      const body: any = {
        account,
        stripeInvoiceIds: [id],
      }
      if (overrideCustomerUid) body.customerOverrideUid = overrideCustomerUid

      const res = await fetch('/api/stripe-myob/push?dry=0', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json: any = await res.json()
      if (!res.ok || !json.ok) throw new Error(json.error || `HTTP ${res.status}`)
      const result = json.results?.[0]
      if (result?.error) {
        setErr(result.error)
      } else {
        setActivePreview(null)
        await load()
      }
    } catch (e: any) {
      setErr(e?.message || String(e))
    } finally {
      setPushingIds(prev => {
        const next = new Set(prev); next.delete(id); return next
      })
    }
  }, [activePreview, account, overrideCustomerUid, load])

  const syncFromMyob = useCallback(async () => {
    setSyncing(true)
    setSyncResult(null)
    setErr(null)
    try {
      const res = await fetch('/api/stripe-myob/sync', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account, since, until }),
      })
      const json: any = await res.json()
      if (!res.ok || !json.ok) throw new Error(json.error || `HTTP ${res.status}`)
      setSyncResult(json.summary)
      await load()
    } catch (e: any) {
      setErr(e?.message || String(e))
    } finally {
      setSyncing(false)
    }
  }, [account, since, until, load])

  const totalGross  = useMemo(() => rows.reduce((s, r) => s + r.total_cents, 0), [rows])
  const pendingRows = useMemo(() => rows.filter(r => r.myobStatus === 'pending'), [rows])
  const rangeIncludesPreCutover = useMemo(() => since < MAKE_CUTOVER_DATE, [since])

  return (
    <>
      <Head><title>Stripe → MYOB · JA Portal</title></Head>
      <div style={{ display:'flex', minHeight:'100vh', background:T.bg, color:T.text }}>
        <PortalSidebar activeId="stripe-myob" />
        <div style={{ flex:1, padding:'24px 32px', maxWidth:1400 }}>

          {/* Header */}
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:20 }}>
            <div>
              <h1 style={{ margin:0, fontSize:24, fontWeight:600 }}>Stripe → MYOB</h1>
              <div style={{ marginTop:4, color:T.text2, fontSize:13 }}>
                Manual fallback for the Make automation. Reviews Stripe sales and pushes them into MYOB JAWS as Professional Invoices + Customer Payments.
              </div>
            </div>
          </div>

          {/* Filters */}
          <div style={{
            display:'flex', gap:12, alignItems:'flex-end',
            padding:'14px 16px', background:T.bg2, border:`1px solid ${T.border}`, borderRadius:8,
            marginBottom:16,
          }}>
            <div>
              <label style={{ display:'block', fontSize:11, color:T.text2, marginBottom:4 }}>Stripe account</label>
              <select value={account} onChange={e => setAccount(e.target.value as AccountLabel)}
                style={selectStyle}>
                <option value="JAWS_JMACX">JAWS - JMACX</option>
                <option value="JAWS_ET">JAWS - ET (Easy Tune)</option>
              </select>
            </div>
            <div>
              <label style={{ display:'block', fontSize:11, color:T.text2, marginBottom:4 }}>Since</label>
              <input type="date" value={since} onChange={e => setSince(e.target.value)} style={inputStyle} />
            </div>
            <div>
              <label style={{ display:'block', fontSize:11, color:T.text2, marginBottom:4 }}>Until</label>
              <input type="date" value={until} onChange={e => setUntil(e.target.value)} style={inputStyle} />
            </div>
            <button onClick={load} disabled={loading} style={primaryBtnStyle}>
              {loading ? 'Loading…' : 'Refresh'}
            </button>
            {canPush && (
              <button onClick={syncFromMyob} disabled={syncing || loading} style={syncBtnStyle} title="Scan MYOB for any of these invoices that already exist there (e.g. from Make) and mark them as Already in MYOB">
                {syncing ? 'Syncing…' : 'Sync from MYOB'}
              </button>
            )}
            {syncResult && (
              <span style={{ fontSize:12, color:T.text2 }}>
                Scanned {syncResult.scanned}, matched <strong style={{ color:T.purple }}>{syncResult.matched}</strong>
              </span>
            )}
            {err && <span style={{ color:T.red, fontSize:12, marginLeft:'auto' }}>{err}</span>}
          </div>

          {/* Summary */}
          {summary && (
            <div style={{ display:'flex', gap:10, marginBottom:16, flexWrap:'wrap' }}>
              <KpiChip label="Total in window" value={String(summary.total)} color={T.blue} />
              <KpiChip label="Pending push"   value={String(summary.pending)}  color={T.amber} />
              <KpiChip label="Pushed"         value={String(summary.pushed)}   color={T.green} />
              <KpiChip label="Failed"         value={String(summary.failed)}   color={T.red} />
              <KpiChip label="Already in MYOB" value={String(summary.duplicate)} color={T.purple} />
              <KpiChip label="Gross window"   value={fmtMoneyCents(totalGross)} color={T.teal} />
            </div>
          )}

          {/* Table */}
          <div style={{ background:T.bg2, border:`1px solid ${T.border}`, borderRadius:8, overflow:'hidden' }}>
            <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
              <thead>
                <tr style={{ background:T.bg3, borderBottom:`1px solid ${T.border}` }}>
                  <th style={thStyle}>Stripe #</th>
                  <th style={thStyle}>Paid</th>
                  <th style={thStyle}>Customer</th>
                  <th style={{...thStyle, textAlign:'right'}}>Gross</th>
                  <th style={{...thStyle, textAlign:'right'}}>Fee</th>
                  <th style={{...thStyle, textAlign:'right'}}>Net</th>
                  <th style={thStyle}>MYOB</th>
                  <th style={thStyle}>Action</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && !loading && (
                  <tr><td colSpan={8} style={{ padding:'40px 20px', textAlign:'center', color:T.text3 }}>
                    No invoices in this window.
                  </td></tr>
                )}
                {rows.map(r => (
                  <tr key={r.id} style={{ borderBottom:`1px solid ${T.border}` }}>
                    <td style={tdStyle}>
                      <div style={{ fontWeight:600 }}>{r.number || '—'}</div>
                      <div style={{ fontSize:10, color:T.text3, fontFamily:'monospace' }}>{r.id}</div>
                    </td>
                    <td style={tdStyle}>
                      {fmtDateShort(r.paid_at || r.created)}
                      {isPreCutover(r.paid_at || r.created)
                        && r.myobStatus !== 'pushed'
                        && r.myobStatus !== 'skipped_duplicate' && (
                        <div title="Before Make cutover — possible Make duplicate"
                          style={{ fontSize:10, color:T.red, marginTop:3 }}>⚠ pre-cutover</div>
                      )}
                    </td>
                    <td style={tdStyle}>
                      <div>{r.customer_name || '—'}</div>
                      <div style={{ fontSize:11, color:T.text3 }}>{r.customer_email || ''}</div>
                    </td>
                    <td style={{...tdStyle, textAlign:'right', fontVariantNumeric:'tabular-nums'}}>{fmtMoneyCents(r.total_cents)}</td>
                    <td style={{...tdStyle, textAlign:'right', fontVariantNumeric:'tabular-nums', color:T.text2}}>
                      {r.myobFeeCents !== null ? fmtMoneyCents(r.myobFeeCents) : '—'}
                    </td>
                    <td style={{...tdStyle, textAlign:'right', fontVariantNumeric:'tabular-nums'}}>
                      {r.myobNetCents !== null ? fmtMoneyCents(r.myobNetCents) : '—'}
                    </td>
                    <td style={tdStyle}>
                      <StatusBadge status={r.myobStatus} />
                      {r.lastError && <div style={{ fontSize:10, color:T.red, marginTop:3, maxWidth:200 }}>{r.lastError.slice(0, 80)}</div>}
                    </td>
                    <td style={tdStyle}>
                      {r.myobStatus === 'pushed' || r.myobStatus === 'skipped_duplicate' ? (
                        <span style={{ color:T.text3, fontSize:11 }}>—</span>
                      ) : canPush ? (
                        <button onClick={() => onPreviewClick(r)}
                          disabled={pushingIds.has(r.id) || previewLoading}
                          style={pushBtnStyle}>
                          {pushingIds.has(r.id) ? 'Pushing…' : 'Preview & push'}
                        </button>
                      ) : (
                        <span style={{ color:T.text3, fontSize:11 }}>Read-only</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Preview modal */}
          {activePreview && (
            <PreviewModal
              preview={activePreview}
              rowDate={activeRowDate}
              overrideCustomerUid={overrideCustomerUid}
              setOverrideCustomerUid={setOverrideCustomerUid}
              preCutoverAck={preCutoverAck}
              setPreCutoverAck={setPreCutoverAck}
              onClose={() => { setActivePreview(null); setOverrideCustomerUid(null); setPreCutoverAck(false) }}
              onConfirm={onPushConfirm}
              pushing={pushingIds.has(activePreview.stripeInvoiceId)}
            />
          )}

        </div>
      </div>
    </>
  )
}

// ── Sub-components ─────────────────────────────────────────────────────

function KpiChip({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{
      padding:'10px 14px', background:T.bg2,
      border:`1px solid ${T.border}`, borderRadius:8, minWidth:130,
    }}>
      <div style={{ fontSize:10, color:T.text2, textTransform:'uppercase', letterSpacing:'0.05em' }}>{label}</div>
      <div style={{ fontSize:18, fontWeight:600, color, marginTop:2, fontVariantNumeric:'tabular-nums' }}>{value}</div>
    </div>
  )
}

interface PreviewModalProps {
  preview: PushPreview
  rowDate: string | null
  overrideCustomerUid: string | null
  setOverrideCustomerUid: (s: string | null) => void
  preCutoverAck: boolean
  setPreCutoverAck: (b: boolean) => void
  onClose: () => void
  onConfirm: () => void
  pushing: boolean
}

function PreviewModal(p: PreviewModalProps) {
  const pv = p.preview
  const cust = pv.customer
  const isBlocked = pv.stripeStatus === 'blocked'
  const isAmbiguous = cust.decision === 'ambiguous'
  const isDuplicate = pv.stripeStatus === 'duplicate-in-myob' || pv.stripeStatus === 'idempotent'
  const isPreCutoverRow = isPreCutover(p.rowDate)

  const overrideOk = isAmbiguous ? !!p.overrideCustomerUid : true
  const cutoverOk = !isPreCutoverRow || p.preCutoverAck
  const canConfirm = !isDuplicate && overrideOk && cutoverOk && !p.pushing

  return (
    <div style={{
      position:'fixed', inset:0, background:'rgba(0,0,0,0.6)',
      display:'flex', alignItems:'center', justifyContent:'center', zIndex:1000,
      padding:20,
    }} onClick={p.onClose}>
      <div onClick={e => e.stopPropagation()} style={{
        background:T.bg2, border:`1px solid ${T.border2}`, borderRadius:10,
        maxWidth:680, width:'100%', maxHeight:'85vh', overflow:'auto',
        padding:24,
      }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:14 }}>
          <div>
            <h2 style={{ margin:0, fontSize:18 }}>Push to MYOB: {pv.stripeNumber || pv.stripeInvoiceId}</h2>
            <div style={{ fontSize:11, color:T.text3, marginTop:3, fontFamily:'monospace' }}>{pv.stripeInvoiceId}</div>
          </div>
          <button onClick={p.onClose} style={closeBtnStyle}>×</button>
        </div>

        {isDuplicate && (
          <div style={infoBoxStyle(T.purple)}>
            Already exists in MYOB — nothing to do.
            {pv.myobInvoiceNumber && <div style={{ marginTop:4 }}>MYOB invoice: <strong>{pv.myobInvoiceNumber}</strong></div>}
          </div>
        )}

        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:10, marginBottom:14 }}>
          <Kv label="Gross"  value={fmtMoneyCents(pv.gross_cents)} />
          <Kv label="Fee"    value={fmtMoneyCents(pv.fee_cents)} />
          <Kv label="Net"    value={fmtMoneyCents(pv.net_cents)} />
        </div>
        <div style={{ fontSize:11, color:T.text3, marginBottom:14 }}>Fee resolution: {pv.feeResolution}</div>

        {/* Customer */}
        <div style={{ marginBottom:14 }}>
          <div style={{ fontSize:11, color:T.text2, marginBottom:4, textTransform:'uppercase', letterSpacing:'0.05em' }}>Customer</div>
          <div>
            <div><strong>{cust.stripeName || '—'}</strong> <span style={{ color:T.text3, fontSize:12 }}>({cust.stripeEmail || 'no email'})</span></div>
            <div style={{ fontSize:12, color:T.text2, marginTop:4 }}>
              {cust.decision === 'reuse' && cust.myobName && <>Match: <strong style={{ color:T.green }}>{cust.myobName}</strong> ({cust.myobDisplayId})</>}
              {cust.decision === 'create' && <>Will <strong style={{ color:T.teal }}>create new</strong> MYOB customer card</>}
              {isAmbiguous && <>
                <div style={{ color:T.amber, marginBottom:6 }}>{cust.note}</div>
                <select value={p.overrideCustomerUid || ''} onChange={e => p.setOverrideCustomerUid(e.target.value || null)} style={{...inputStyle, width:'100%'}}>
                  <option value="">— pick MYOB customer —</option>
                  {(cust.candidates || []).map(c => (
                    <option key={c.uid} value={c.uid}>{c.name} ({c.displayId})</option>
                  ))}
                </select>
              </>}
            </div>
          </div>
        </div>

        {/* Payload preview */}
        {pv.invoicePayload && (
          <details style={{ marginBottom:14 }}>
            <summary style={{ cursor:'pointer', color:T.text2, fontSize:12 }}>MYOB Invoice payload</summary>
            <pre style={preStyle}>{JSON.stringify(pv.invoicePayload, null, 2)}</pre>
          </details>
        )}
        {pv.paymentPayload && (
          <details style={{ marginBottom:14 }}>
            <summary style={{ cursor:'pointer', color:T.text2, fontSize:12 }}>MYOB Customer Payment payload</summary>
            <pre style={preStyle}>{JSON.stringify(pv.paymentPayload, null, 2)}</pre>
          </details>
        )}

        {pv.error && <div style={infoBoxStyle(T.red)}>Last error: {pv.error}</div>}

        {/* Pre-cutover acknowledgement */}
        {isPreCutoverRow && !isDuplicate && (
          <div style={infoBoxStyle(T.red)}>
            <strong>This invoice is dated before {MAKE_CUTOVER_DATE}</strong> — when Make was working. The duplicate scan didn't find a match in MYOB JournalMemo, but Make may have used a different memo format and missed it.
            <label style={{ display:'flex', alignItems:'center', gap:8, marginTop:10, cursor:'pointer' }}>
              <input type="checkbox"
                checked={p.preCutoverAck}
                onChange={e => p.setPreCutoverAck(e.target.checked)} />
              <span style={{ fontSize:12 }}>I've checked MYOB manually — this invoice is not already there. Push it.</span>
            </label>
          </div>
        )}

        {/* Actions */}
        <div style={{ display:'flex', gap:10, justifyContent:'flex-end', marginTop:16 }}>
          <button onClick={p.onClose} style={secondaryBtnStyle}>Close</button>
          {!isDuplicate && (
            <button onClick={p.onConfirm} disabled={!canConfirm} style={{...primaryBtnStyle, opacity:canConfirm ? 1 : 0.5}}>
              {p.pushing ? 'Pushing…' : isBlocked ? 'Push with override' : 'Push to MYOB'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function Kv({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize:10, color:T.text2, textTransform:'uppercase', letterSpacing:'0.05em' }}>{label}</div>
      <div style={{ fontSize:16, fontWeight:600, marginTop:2, fontVariantNumeric:'tabular-nums' }}>{value}</div>
    </div>
  )
}

// ── Inline styles ──────────────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  padding:'6px 8px', fontSize:13, background:T.bg3, color:T.text,
  border:`1px solid ${T.border2}`, borderRadius:6,
}
const selectStyle: React.CSSProperties = { ...inputStyle, paddingRight:24, cursor:'pointer' }
const primaryBtnStyle: React.CSSProperties = {
  padding:'8px 16px', background:T.accent, color:'#fff', border:'none', borderRadius:6,
  fontSize:13, fontWeight:600, cursor:'pointer',
}
const secondaryBtnStyle: React.CSSProperties = {
  padding:'8px 14px', background:'transparent', color:T.text2,
  border:`1px solid ${T.border2}`, borderRadius:6, fontSize:13, cursor:'pointer',
}
const syncBtnStyle: React.CSSProperties = {
  padding:'8px 14px', background:T.purple, color:'#fff',
  border:'none', borderRadius:6, fontSize:13, fontWeight:600, cursor:'pointer',
}
const pushBtnStyle: React.CSSProperties = {
  padding:'5px 12px', fontSize:12, background:T.accent, color:'#fff',
  border:'none', borderRadius:5, cursor:'pointer', fontWeight:500,
}
const closeBtnStyle: React.CSSProperties = {
  background:'transparent', border:'none', color:T.text2, fontSize:24, cursor:'pointer', lineHeight:1,
}
const thStyle: React.CSSProperties = {
  padding:'10px 12px', fontSize:11, color:T.text2,
  textAlign:'left', textTransform:'uppercase', letterSpacing:'0.05em', fontWeight:600,
}
const tdStyle: React.CSSProperties = { padding:'10px 12px', verticalAlign:'top' }
const preStyle: React.CSSProperties = {
  background:T.bg3, padding:10, borderRadius:6, fontSize:11, lineHeight:1.5,
  overflowX:'auto', color:T.text2, margin:'6px 0 0 0',
}
function infoBoxStyle(color: string): React.CSSProperties {
  return {
    padding:'10px 14px', background:`${color}1a`, color, border:`1px solid ${color}55`,
    borderRadius:6, fontSize:12, marginBottom:14,
  }
}
