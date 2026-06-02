// pages/admin/b2b/stock-transfer.tsx
// Internal stock transfer JAWS → VPS.
//
// Pick catalogue items (nothing pre-selected), set quantities (defaults to
// full on-hand once ticked), review the cost totals, and execute: the
// portal writes a JAWS Sale.Invoice at average cost to the VPS customer
// card, and a matching VPS Purchase.Bill to the stock-transfer account.
//
// Setup panel (first run): pick the three MYOB references via typeahead —
// the VPS customer card (in JAWS), the JAWS supplier card (in VPS), and
// the VPS account the bill posts to.

import { useEffect, useMemo, useState } from 'react'
import Head from 'next/head'
import PortalTopBar from '../../../lib/PortalTopBar'
import B2BAdminTabs from '../../../components/b2b/B2BAdminTabs'
import { requirePageAuth } from '../../../lib/authServer'
import type { UserRole } from '../../../lib/permissions'

const T = {
  bg:'#0d0f12', bg2:'#131519', bg3:'#1a1d23', bg4:'#21252d',
  border:'rgba(255,255,255,0.07)', border2:'rgba(255,255,255,0.12)',
  text:'#e8eaf0', text2:'#aab0c0', text3:'#8d93a4',
  blue:'#4f8ef7', teal:'#2dd4bf', green:'#34c77b',
  amber:'#f5a623', red:'#f04e4e', purple:'#a78bfa',
}

export async function getServerSideProps(ctx: any) {
  return requirePageAuth(ctx, 'edit:b2b_distributors')
}

interface Props {
  user: { id: string; email: string; displayName: string | null; role: UserRole; visibleTabs: string[] | null }
}

interface Item {
  catalogue_id: string
  sku: string
  name: string
  is_taxable: boolean
  on_hand: number
  avg_cost: number
}

interface TransferConfig {
  customerUid: string | null; customerName: string | null
  supplierUid: string | null; supplierName: string | null
  accountUid: string | null;  accountName: string | null
}

interface TransferRow {
  id: string
  status: 'pending' | 'complete' | 'partial' | 'failed'
  note: string | null
  line_count: number
  subtotal_ex_gst: number
  gst: number
  total_inc: number
  jaws_invoice_number: string | null
  vps_bill_uid: string | null
  error: string | null
  created_at: string
}

const fmt$ = (n: number) => `$${Number(n || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export default function StockTransferPage({ user }: Props) {
  const [cfg, setCfg] = useState<TransferConfig | null>(null)
  const [items, setItems] = useState<Item[] | null>(null)
  const [itemsError, setItemsError] = useState<string | null>(null)
  const [history, setHistory] = useState<TransferRow[] | null>(null)
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState<Record<string, number>>({})  // catalogue_id → qty
  const [note, setNote] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<{ kind: 'ok' | 'partial' | 'error'; text: string } | null>(null)
  const [retrying, setRetrying] = useState<string | null>(null)

  function loadConfig() {
    fetch('/api/b2b/admin/stock-transfer', { credentials: 'same-origin' })
      .then(r => r.ok ? r.json() : null).then(j => { if (j?.config) setCfg(j.config) }).catch(() => {})
  }
  function loadItems() {
    setItems(null); setItemsError(null)
    fetch('/api/b2b/admin/stock-transfer?view=items', { credentials: 'same-origin' })
      .then(async r => {
        const j = await r.json().catch(() => null)
        if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`)
        setItems(j.items || [])
      })
      .catch(e => setItemsError(e?.message || String(e)))
  }
  function loadHistory() {
    fetch('/api/b2b/admin/stock-transfer?view=history', { credentials: 'same-origin' })
      .then(r => r.ok ? r.json() : null).then(j => { if (j) setHistory(j.transfers || []) }).catch(() => {})
  }
  useEffect(() => { loadConfig(); loadItems(); loadHistory() }, [])

  const configured = !!(cfg?.customerUid && cfg?.supplierUid && cfg?.accountUid)

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return items || []
    return (items || []).filter(i => i.sku.toLowerCase().includes(q) || i.name.toLowerCase().includes(q))
  }, [items, filter])

  const picked = useMemo(() => (items || []).filter(i => selected[i.catalogue_id] != null), [items, selected])
  const totals = useMemo(() => {
    let ex = 0, gst = 0
    for (const i of picked) {
      const lineEx = (selected[i.catalogue_id] || 0) * i.avg_cost
      ex += lineEx
      if (i.is_taxable) gst += lineEx * 0.10
    }
    return { ex, gst, inc: ex + gst }
  }, [picked, selected])

  function toggle(i: Item) {
    setSelected(s => {
      const next = { ...s }
      if (next[i.catalogue_id] != null) delete next[i.catalogue_id]
      else next[i.catalogue_id] = i.on_hand
      return next
    })
  }
  function setQty(i: Item, raw: string) {
    const v = Math.max(0, Math.min(i.on_hand, Number(raw) || 0))
    setSelected(s => ({ ...s, [i.catalogue_id]: v }))
  }

  async function execute() {
    setRunning(true); setResult(null)
    try {
      const lines = picked
        .map(i => ({ catalogue_id: i.catalogue_id, qty: selected[i.catalogue_id] }))
        .filter(l => l.qty > 0)
      const r = await fetch('/api/b2b/admin/stock-transfer', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'execute', lines, note: note.trim() || null }),
      })
      const j = await r.json().catch(() => null)
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`)
      const tr = j.result
      if (tr.status === 'complete') {
        setResult({ kind: 'ok', text: `Transfer complete — JAWS invoice ${tr.jawsInvoiceNumber} + VPS bill written (${fmt$(tr.totalInc)} inc GST).` })
      } else {
        setResult({ kind: 'partial', text: `JAWS invoice ${tr.jawsInvoiceNumber} written, but the VPS bill failed: ${tr.error}. Use Retry in the history below.` })
      }
      setSelected({}); setNote('')
      loadItems(); loadHistory()
    } catch (e: any) {
      setResult({ kind: 'error', text: e?.message || String(e) })
    } finally {
      setRunning(false); setConfirming(false)
    }
  }

  async function retry(id: string) {
    setRetrying(id)
    try {
      const r = await fetch('/api/b2b/admin/stock-transfer', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'retry', transferId: id }),
      })
      const j = await r.json().catch(() => null)
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`)
      setResult({ kind: 'ok', text: 'VPS bill written — transfer complete.' })
      loadHistory()
    } catch (e: any) {
      setResult({ kind: 'error', text: `Retry failed: ${e?.message || String(e)}` })
    } finally {
      setRetrying(null)
    }
  }

  const inp: React.CSSProperties = {
    background: T.bg3, border: `1px solid ${T.border2}`, color: T.text,
    borderRadius: 8, padding: '8px 11px', fontSize: 13, fontFamily: 'inherit', outline: 'none',
  }

  return (
    <>
      <Head><title>Stock Transfer · B2B · JA Portal</title></Head>
      <div style={{display:'flex',flexDirection:'column',minHeight:'100vh',background:T.bg,color:T.text,fontFamily:'system-ui,-apple-system,sans-serif'}}>
        <PortalTopBar
          activeId="b2b"
          currentUserRole={user.role}
          currentUserVisibleTabs={user.visibleTabs}
          currentUserName={user.displayName}
          currentUserEmail={user.email}
        />
        <main style={{flex:1,padding:'28px 32px',maxWidth:1200,width:'100%',boxSizing:'border-box'}}>
          <B2BAdminTabs active="stock-transfer"/>

          <h1 style={{fontSize:20,fontWeight:600,margin:'0 0 4px'}}>Internal stock transfer — JAWS → VPS</h1>
          <div style={{fontSize:13,color:T.text3,marginBottom:20}}>
            Sells the picked items out of JAWS at <b style={{color:T.text2}}>average cost</b> (Sale Invoice to the VPS customer card)
            and books the matching purchase in VPS (Service Bill to the stock-transfer account). No margin — pure book-value movement.
          </div>

          {result && (
            <div style={{
              padding:'10px 14px', borderRadius:8, fontSize:13, marginBottom:16,
              background: result.kind==='ok' ? 'rgba(52,199,123,0.12)' : result.kind==='partial' ? 'rgba(245,166,35,0.12)' : 'rgba(240,78,78,0.12)',
              color: result.kind==='ok' ? T.green : result.kind==='partial' ? T.amber : T.red,
              border: `1px solid ${result.kind==='ok' ? T.green : result.kind==='partial' ? T.amber : T.red}33`,
            }}>{result.text}</div>
          )}

          <SetupPanel cfg={cfg} onSaved={c => setCfg(c)} configured={configured}/>

          {/* ── Item picker ─────────────────────────────────────────── */}
          <section style={{background:T.bg2,border:`1px solid ${T.border}`,borderRadius:12,padding:18,marginBottom:20}}>
            <div style={{display:'flex',alignItems:'center',gap:12,marginBottom:12,flexWrap:'wrap'}}>
              <h2 style={{fontSize:15,fontWeight:600,margin:0}}>Pick items to transfer</h2>
              <span style={{flex:1}}/>
              <input value={filter} onChange={e=>setFilter(e.target.value)} placeholder="Filter by SKU or name…" style={{...inp,width:240}}/>
              <button onClick={loadItems} style={{...inp,cursor:'pointer',color:T.text2}}>↻ Refresh</button>
            </div>

            {items === null && !itemsError && <div style={{color:T.text3,fontSize:13,padding:'18px 0'}}>Loading items + live JAWS costs…</div>}
            {itemsError && <div style={{color:T.red,fontSize:13,padding:'12px 0'}}>Failed to load items: {itemsError}</div>}
            {items !== null && items.length === 0 && <div style={{color:T.text3,fontSize:13,padding:'12px 0'}}>No inventoried items with stock on hand.</div>}

            {items !== null && items.length > 0 && (
              <div style={{overflowX:'auto'}}>
                <table style={{width:'100%',borderCollapse:'collapse',fontSize:13}}>
                  <thead>
                    <tr style={{color:T.text3,fontSize:11,textTransform:'uppercase',letterSpacing:'0.06em'}}>
                      <th style={{textAlign:'left',padding:'6px 8px'}}></th>
                      <th style={{textAlign:'left',padding:'6px 8px'}}>SKU</th>
                      <th style={{textAlign:'left',padding:'6px 8px'}}>Item</th>
                      <th style={{textAlign:'right',padding:'6px 8px'}}>On hand</th>
                      <th style={{textAlign:'right',padding:'6px 8px'}}>Avg cost (ex)</th>
                      <th style={{textAlign:'right',padding:'6px 8px'}}>Transfer qty</th>
                      <th style={{textAlign:'right',padding:'6px 8px'}}>Line total (ex)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map(i => {
                      const on = selected[i.catalogue_id] != null
                      const qty = selected[i.catalogue_id] ?? 0
                      return (
                        <tr key={i.catalogue_id} style={{borderTop:`1px solid ${T.border}`,background:on?'rgba(79,142,247,0.06)':'transparent'}}>
                          <td style={{padding:'7px 8px'}}>
                            <input type="checkbox" checked={on} onChange={()=>toggle(i)} style={{cursor:'pointer'}}/>
                          </td>
                          <td style={{padding:'7px 8px',fontFamily:'monospace',fontSize:12}}>{i.sku}</td>
                          <td style={{padding:'7px 8px',color:T.text2}}>{i.name}{!i.is_taxable && <span style={{color:T.text3,fontSize:10,marginLeft:6}}>FRE</span>}</td>
                          <td style={{padding:'7px 8px',textAlign:'right',fontFamily:'monospace'}}>{i.on_hand}</td>
                          <td style={{padding:'7px 8px',textAlign:'right',fontFamily:'monospace'}}>{fmt$(i.avg_cost)}</td>
                          <td style={{padding:'7px 8px',textAlign:'right'}}>
                            {on ? (
                              <input
                                type="number" min={0} max={i.on_hand} value={qty}
                                onChange={e=>setQty(i, e.target.value)}
                                style={{...inp,width:80,padding:'4px 8px',textAlign:'right',fontFamily:'monospace'}}
                              />
                            ) : <span style={{color:T.text3}}>—</span>}
                          </td>
                          <td style={{padding:'7px 8px',textAlign:'right',fontFamily:'monospace',color:on?T.text:T.text3}}>
                            {on ? fmt$(qty * i.avg_cost) : '—'}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {/* Footer: totals + execute */}
            <div style={{display:'flex',alignItems:'center',gap:16,marginTop:14,paddingTop:14,borderTop:`1px solid ${T.border}`,flexWrap:'wrap'}}>
              <div style={{fontSize:13,color:T.text2}}>
                {picked.length} item{picked.length===1?'':'s'} selected
                {picked.length > 0 && <> — <b style={{color:T.text}}>{fmt$(totals.ex)}</b> ex GST · GST {fmt$(totals.gst)} · <b style={{color:T.text}}>{fmt$(totals.inc)}</b> inc</>}
              </div>
              <span style={{flex:1}}/>
              <input value={note} onChange={e=>setNote(e.target.value)} placeholder="Note (optional)" style={{...inp,width:220}}/>
              <button
                disabled={!configured || picked.length===0 || running}
                onClick={()=>setConfirming(true)}
                title={!configured ? 'Complete the MYOB setup above first' : undefined}
                style={{
                  ...inp, cursor: (!configured||picked.length===0||running)?'not-allowed':'pointer',
                  background: (!configured||picked.length===0) ? T.bg3 : T.blue, border:'none',
                  color: (!configured||picked.length===0) ? T.text3 : '#fff', fontWeight:600, padding:'9px 18px',
                }}>
                {running ? 'Transferring…' : 'Transfer to VPS →'}
              </button>
            </div>
          </section>

          {/* ── History ─────────────────────────────────────────────── */}
          <section style={{background:T.bg2,border:`1px solid ${T.border}`,borderRadius:12,padding:18}}>
            <h2 style={{fontSize:15,fontWeight:600,margin:'0 0 12px'}}>Transfer history</h2>
            {history === null && <div style={{color:T.text3,fontSize:13}}>Loading…</div>}
            {history !== null && history.length === 0 && <div style={{color:T.text3,fontSize:13}}>No transfers yet.</div>}
            {history !== null && history.length > 0 && (
              <table style={{width:'100%',borderCollapse:'collapse',fontSize:13}}>
                <thead>
                  <tr style={{color:T.text3,fontSize:11,textTransform:'uppercase',letterSpacing:'0.06em'}}>
                    <th style={{textAlign:'left',padding:'6px 8px'}}>Date</th>
                    <th style={{textAlign:'right',padding:'6px 8px'}}>Items</th>
                    <th style={{textAlign:'right',padding:'6px 8px'}}>Total (inc)</th>
                    <th style={{textAlign:'left',padding:'6px 8px'}}>JAWS invoice</th>
                    <th style={{textAlign:'left',padding:'6px 8px'}}>VPS bill</th>
                    <th style={{textAlign:'left',padding:'6px 8px'}}>Status</th>
                    <th style={{textAlign:'left',padding:'6px 8px'}}></th>
                  </tr>
                </thead>
                <tbody>
                  {history.map(t => (
                    <tr key={t.id} style={{borderTop:`1px solid ${T.border}`}}>
                      <td style={{padding:'7px 8px',color:T.text2,whiteSpace:'nowrap'}}>
                        {new Date(t.created_at).toLocaleString('en-AU',{day:'numeric',month:'short',hour:'numeric',minute:'2-digit'})}
                      </td>
                      <td style={{padding:'7px 8px',textAlign:'right',fontFamily:'monospace'}}>{t.line_count}</td>
                      <td style={{padding:'7px 8px',textAlign:'right',fontFamily:'monospace'}}>{fmt$(t.total_inc)}</td>
                      <td style={{padding:'7px 8px',fontFamily:'monospace',fontSize:12}}>{t.jaws_invoice_number || '—'}</td>
                      <td style={{padding:'7px 8px',fontSize:12,color:t.vps_bill_uid?T.green:T.text3}}>{t.vps_bill_uid ? '✓ written' : '—'}</td>
                      <td style={{padding:'7px 8px'}}>
                        <span style={{
                          fontSize:11, fontWeight:600, padding:'2px 8px', borderRadius:10,
                          color: t.status==='complete'?T.green:t.status==='partial'?T.amber:t.status==='failed'?T.red:T.text3,
                          background: t.status==='complete'?'rgba(52,199,123,0.12)':t.status==='partial'?'rgba(245,166,35,0.12)':t.status==='failed'?'rgba(240,78,78,0.12)':T.bg3,
                        }}>{t.status}</span>
                        {t.error && <div style={{fontSize:11,color:T.red,marginTop:3,maxWidth:340}}>{t.error}</div>}
                      </td>
                      <td style={{padding:'7px 8px'}}>
                        {t.status === 'partial' && (
                          <button onClick={()=>retry(t.id)} disabled={retrying===t.id}
                            style={{...inp,cursor:'pointer',padding:'4px 10px',fontSize:12,color:T.amber}}>
                            {retrying===t.id ? 'Retrying…' : 'Retry VPS bill'}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </main>
      </div>

      {/* Confirm modal */}
      {confirming && (
        <div onClick={()=>!running && setConfirming(false)}
          style={{position:'fixed',inset:0,zIndex:950,background:'rgba(8,10,13,0.8)',backdropFilter:'blur(4px)',display:'flex',alignItems:'center',justifyContent:'center',padding:24}}>
          <div onClick={e=>e.stopPropagation()}
            style={{width:'100%',maxWidth:480,background:T.bg2,border:`1px solid ${T.border2}`,borderRadius:14,padding:22,fontFamily:'inherit',color:T.text}}>
            <h3 style={{margin:'0 0 10px',fontSize:16,fontWeight:600}}>Confirm stock transfer</h3>
            <div style={{fontSize:13,color:T.text2,lineHeight:1.6,marginBottom:16}}>
              <b style={{color:T.text}}>{picked.length} item{picked.length===1?'':'s'}</b> will move JAWS → VPS at average cost:<br/>
              {fmt$(totals.ex)} ex GST + {fmt$(totals.gst)} GST = <b style={{color:T.text}}>{fmt$(totals.inc)}</b><br/><br/>
              This writes a <b style={{color:T.text}}>Sale Invoice in JAWS</b> (relieves stock immediately) and a
              {' '}<b style={{color:T.text}}>Purchase Bill in VPS</b>. It cannot be undone from the portal — reversals are manual in MYOB.
            </div>
            <div style={{display:'flex',gap:10,justifyContent:'flex-end'}}>
              <button onClick={()=>setConfirming(false)} disabled={running}
                style={{background:'transparent',border:`1px solid ${T.border2}`,color:T.text2,borderRadius:8,padding:'8px 14px',fontSize:13,fontFamily:'inherit',cursor:'pointer'}}>
                Cancel
              </button>
              <button onClick={execute} disabled={running}
                style={{background:T.blue,border:'none',color:'#fff',borderRadius:8,padding:'8px 16px',fontSize:13,fontWeight:600,fontFamily:'inherit',cursor:running?'wait':'pointer'}}>
                {running ? 'Transferring…' : `Transfer ${picked.length} item${picked.length===1?'':'s'}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

// ── Setup panel: the three MYOB references ─────────────────────────────
function SetupPanel({ cfg, onSaved, configured }: {
  cfg: TransferConfig | null
  onSaved: (c: TransferConfig) => void
  configured: boolean
}) {
  const [open, setOpen] = useState(false)
  useEffect(() => { if (cfg && !configured) setOpen(true) }, [cfg, configured])

  if (!cfg) return null
  return (
    <section style={{background:T.bg2,border:`1px solid ${configured?T.border:T.amber+'55'}`,borderRadius:12,padding:18,marginBottom:20}}>
      <div onClick={()=>setOpen(o=>!o)} style={{display:'flex',alignItems:'center',gap:10,cursor:'pointer'}}>
        <h2 style={{fontSize:15,fontWeight:600,margin:0}}>MYOB setup</h2>
        {configured
          ? <span style={{fontSize:11,fontWeight:600,color:T.green,background:'rgba(52,199,123,0.12)',padding:'2px 8px',borderRadius:10}}>configured</span>
          : <span style={{fontSize:11,fontWeight:600,color:T.amber,background:'rgba(245,166,35,0.12)',padding:'2px 8px',borderRadius:10}}>setup required</span>}
        <span style={{flex:1}}/>
        <span style={{color:T.text3,fontSize:12}}>{open ? '▲' : '▼'}</span>
      </div>
      {open && (
        <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit, minmax(280px, 1fr))',gap:14,marginTop:14}}>
          <MyobPicker
            label="VPS customer card (in JAWS)"
            hint="The JAWS sale invoice bills this customer"
            lookup="customers"
            current={cfg.customerName}
            onPick={async (uid, name) => onSaved(await saveSetting({ customer_uid: uid, customer_name: name }))}
          />
          <MyobPicker
            label="JAWS supplier card (in VPS)"
            hint="The VPS purchase bill comes from this supplier"
            lookup="suppliers"
            current={cfg.supplierName}
            onPick={async (uid, name) => onSaved(await saveSetting({ supplier_uid: uid, supplier_name: name }))}
          />
          <MyobPicker
            label="VPS stock-transfer account"
            hint="The VPS account the bill lines post to (e.g. Stock on Hand or Purchases)"
            lookup="accounts"
            current={cfg.accountName}
            onPick={async (uid, name) => onSaved(await saveSetting({ account_uid: uid, account_name: name }))}
          />
        </div>
      )}
    </section>
  )
}

async function saveSetting(fields: Record<string, string>): Promise<TransferConfig> {
  const r = await fetch('/api/b2b/admin/stock-transfer', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'save-settings', ...fields }),
  })
  const j = await r.json().catch(() => null)
  if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`)
  return j.config
}

function MyobPicker({ label, hint, lookup, current, onPick }: {
  label: string
  hint: string
  lookup: 'customers' | 'suppliers' | 'accounts'
  current: string | null
  onPick: (uid: string, name: string) => Promise<void>
}) {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<Array<{ uid: string; name: string; display_id: string }> | null>(null)
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  async function search() {
    setSearching(true); setError(null)
    try {
      const r = await fetch(`/api/b2b/admin/stock-transfer?lookup=${lookup}&q=${encodeURIComponent(q)}`, { credentials: 'same-origin' })
      const j = await r.json().catch(() => null)
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`)
      setResults(j.items || [])
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setSearching(false)
    }
  }

  return (
    <div style={{background:T.bg3,border:`1px solid ${T.border}`,borderRadius:10,padding:13}}>
      <div style={{fontSize:12.5,fontWeight:600,marginBottom:2}}>{label}</div>
      <div style={{fontSize:11,color:T.text3,marginBottom:8}}>{hint}</div>
      <div style={{fontSize:12.5,marginBottom:8,color: current?T.green:T.text3}}>
        {current ? `✓ ${current}` : 'Not set'}
      </div>
      <div style={{display:'flex',gap:6}}>
        <input
          value={q} onChange={e=>setQ(e.target.value)}
          onKeyDown={e=>{ if (e.key==='Enter') search() }}
          placeholder="Search MYOB…"
          style={{flex:1,background:T.bg2,border:`1px solid ${T.border2}`,color:T.text,borderRadius:7,padding:'6px 9px',fontSize:12,fontFamily:'inherit',outline:'none'}}
        />
        <button onClick={search} disabled={searching}
          style={{background:T.bg2,border:`1px solid ${T.border2}`,color:T.text2,borderRadius:7,padding:'6px 10px',fontSize:12,fontFamily:'inherit',cursor:'pointer'}}>
          {searching ? '…' : 'Search'}
        </button>
      </div>
      {error && <div style={{fontSize:11,color:T.red,marginTop:6}}>{error}</div>}
      {results !== null && (
        <div style={{marginTop:8,maxHeight:160,overflowY:'auto',border:`1px solid ${T.border}`,borderRadius:7}}>
          {results.length === 0 && <div style={{fontSize:12,color:T.text3,padding:8}}>No matches.</div>}
          {results.map(r => (
            <button key={r.uid} disabled={saving}
              onClick={async ()=>{ setSaving(true); try { await onPick(r.uid, r.name); setResults(null); setQ('') } catch(e:any){ setError(e?.message||String(e)) } finally { setSaving(false) } }}
              style={{display:'block',width:'100%',textAlign:'left',background:'none',border:'none',borderBottom:`1px solid ${T.border}`,color:T.text2,padding:'7px 9px',fontSize:12,fontFamily:'inherit',cursor:'pointer'}}>
              {r.name} {r.display_id && <span style={{color:T.text3}}>· {r.display_id}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
