// pages/admin/b2b/stock-transfer.tsx
// Internal stock transfers between the two MYOB entities — both directions.
//
//   JAWS → VPS: JAWS Sale Invoice (Item, at average cost — relieves JAWS
//     stock) + VPS Purchase Bill (Service, to the stock-transfer account).
//     Also queues the matching MechanicDesk purchase order (GH worker).
//   VPS → JAWS: VPS Sale Invoice (Service, from the same account) + JAWS
//     Purchase Bill (Item — RECEIVES the stock back into JAWS inventory).
//
// Pick items (nothing pre-selected), set quantities, enter the required PO
// reference (lands on both MYOB documents), review totals, execute.
//
// Setup panel (first run): pick the MYOB references via typeahead — three
// for the forward direction, two more for reverse.

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

type Direction = 'JAWS_TO_VPS' | 'VPS_TO_JAWS'

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
  customerUidVps: string | null; customerNameVps: string | null
  supplierUidJaws: string | null; supplierNameJaws: string | null
  mdPurchaseSupplierId: number | null
}

interface TransferRow {
  id: string
  status: 'pending' | 'awaiting_md' | 'complete' | 'partial' | 'failed'
  direction: Direction | null
  note: string | null
  line_count: number
  subtotal_ex_gst: number
  gst: number
  total_inc: number
  jaws_invoice_number: string | null
  vps_invoice_number: string | null
  vps_bill_uid: string | null
  jaws_bill_uid: string | null
  po_reference: string | null
  md_po_status: string | null
  md_po_ref: string | null
  md_po_error: string | null
  error: string | null
  created_at: string
}

const fmt$ = (n: number) => `$${Number(n || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export default function StockTransferPage({ user }: Props) {
  const [direction, setDirection] = useState<Direction>('JAWS_TO_VPS')
  const forward = direction === 'JAWS_TO_VPS'
  const [cfg, setCfg] = useState<TransferConfig | null>(null)
  const [items, setItems] = useState<Item[] | null>(null)
  const [itemsError, setItemsError] = useState<string | null>(null)
  const [history, setHistory] = useState<TransferRow[] | null>(null)
  const [filter, setFilter] = useState('')
  // catalogue_id → qty as a string ('' = selected but no qty entered yet).
  // Presence of the key means selected; the value is what the user types.
  const [selected, setSelected] = useState<Record<string, string>>({})
  const [note, setNote] = useState('')
  const [poRef, setPoRef] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<{ kind: 'ok' | 'partial' | 'error'; text: string } | null>(null)
  const [retrying, setRetrying] = useState<string | null>(null)
  const [mdFiring, setMdFiring] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)

  function loadConfig() {
    fetch('/api/b2b/admin/stock-transfer', { credentials: 'same-origin' })
      .then(r => r.ok ? r.json() : null).then(j => { if (j?.config) setCfg(j.config) }).catch(() => {})
  }
  function loadItems(dir: Direction) {
    setItems(null); setItemsError(null)
    fetch(`/api/b2b/admin/stock-transfer?view=items&direction=${dir}`, { credentials: 'same-origin' })
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
  useEffect(() => { loadConfig(); loadHistory() }, [])
  useEffect(() => { setSelected({}); loadItems(direction) }, [direction])

  const configured = forward
    ? !!(cfg?.customerUid && cfg?.supplierUid && cfg?.accountUid)
    : !!(cfg?.customerUidVps && cfg?.supplierUidJaws && cfg?.accountUid)

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return items || []
    return (items || []).filter(i => i.sku.toLowerCase().includes(q) || i.name.toLowerCase().includes(q))
  }, [items, filter])

  const qtyOf = (id: string) => Number(selected[id]) || 0
  // Selection order, not alphabetical — Object keys keep insertion order, so
  // the picked summary lists items in the order they were ticked.
  const picked = useMemo(() => {
    const byId = new Map((items || []).map(i => [i.catalogue_id, i]))
    return Object.keys(selected).map(id => byId.get(id)).filter((i): i is Item => !!i)
  }, [items, selected])
  // Every picked line needs a quantity > 0 before the transfer can run.
  const allHaveQty = picked.length > 0 && picked.every(i => qtyOf(i.catalogue_id) > 0)
  const totalUnits = picked.reduce((s, i) => s + qtyOf(i.catalogue_id), 0)
  const totals = useMemo(() => {
    let ex = 0, gst = 0
    for (const i of picked) {
      const lineEx = qtyOf(i.catalogue_id) * i.avg_cost
      ex += lineEx
      if (i.is_taxable) gst += lineEx * 0.10
    }
    return { ex, gst, inc: ex + gst }
  }, [picked, selected])

  function toggle(i: Item) {
    setSelected(s => {
      const next = { ...s }
      // Toggling on leaves the qty BLANK for the user to type a value.
      if (i.catalogue_id in next) delete next[i.catalogue_id]
      else next[i.catalogue_id] = ''
      return next
    })
  }
  function setQty(i: Item, raw: string) {
    // Keep only digits; cap at on-hand for forward. Empty stays empty.
    let clean = raw.replace(/[^0-9]/g, '')
    if (clean !== '' && forward) clean = String(Math.min(i.on_hand, Number(clean)))
    setSelected(s => ({ ...s, [i.catalogue_id]: clean }))
  }

  async function execute() {
    setRunning(true); setResult(null)
    try {
      const lines = picked
        .map(i => ({ catalogue_id: i.catalogue_id, qty: qtyOf(i.catalogue_id) }))
        .filter(l => l.qty > 0)
      const r = await fetch('/api/b2b/admin/stock-transfer', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'execute', direction, lines, note: note.trim() || null, po_reference: poRef.trim() || null }),
      })
      const j = await r.json().catch(() => null)
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`)
      const tr = j.result
      if (tr.status === 'awaiting_md') {
        // Forward (MD-first): MechanicDesk raises the PO + assigns its number,
        // then the MYOB sale + bill post. All async via the worker.
        setResult({ kind: 'ok', text: `Transfer staged (${fmt$(tr.totalInc)} inc GST). MechanicDesk is raising the PO and assigning its number, then the MYOB sale + bill post — refresh in ~1 min.` })
      } else {
        const saleSide = `VPS invoice ${tr.saleDocNumber || ''}`.trim()
        if (tr.status === 'complete') {
          setResult({ kind: 'ok', text: `Transfer complete — ${saleSide} + JAWS bill (stock received) written (${fmt$(tr.totalInc)} inc GST).` })
        } else {
          setResult({ kind: 'partial', text: `${saleSide} written, but the JAWS bill failed: ${tr.error}. Use Retry in the history below.` })
        }
      }
      setSelected({}); setNote(''); setPoRef('')
      loadItems(direction); setTimeout(loadHistory, 1500)
    } catch (e: any) {
      setResult({ kind: 'error', text: e?.message || String(e) })
    } finally {
      setRunning(false); setConfirming(false)
    }
  }

  async function removeTransfer(id: string) {
    if (!confirm('Remove this transfer from the portal history?\n\nThis only clears the portal record — any MYOB invoice/bill or MechanicDesk PO already posted stays put.')) return
    setDeleting(id)
    try {
      const r = await fetch('/api/b2b/admin/stock-transfer', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', transferId: id }),
      })
      const j = await r.json().catch(() => null)
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`)
      setHistory(h => (h || []).filter(t => t.id !== id))
    } catch (e: any) {
      setResult({ kind: 'error', text: `Delete failed: ${e?.message || String(e)}` })
    } finally {
      setDeleting(null)
    }
  }

  async function dispatchMdPo(id: string) {
    setMdFiring(id)
    try {
      const r = await fetch('/api/b2b/admin/stock-transfer', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'dispatch-md-po', transferId: id }),
      })
      const j = await r.json().catch(() => null)
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`)
      setResult({ kind: 'ok', text: 'MechanicDesk purchase-order worker triggered — refresh in ~1 minute to see the result.' })
      setTimeout(loadHistory, 2000)
    } catch (e: any) {
      setResult({ kind: 'error', text: `MD PO trigger failed: ${e?.message || String(e)}` })
    } finally {
      setMdFiring(null)
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
      setResult({ kind: 'ok', text: 'Purchase side written — transfer complete.' })
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
  // Forward is MD-first — MD assigns the PO number, so no PO ref needed.
  // Reverse still requires a PO reference.
  const blocked = !configured || picked.length === 0 || running || !allHaveQty || (!forward && !poRef.trim())

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

          <div style={{display:'flex',alignItems:'center',gap:14,marginBottom:4,flexWrap:'wrap'}}>
            <h1 style={{fontSize:20,fontWeight:600,margin:0}}>Internal stock transfer</h1>
            {/* Direction toggle */}
            <div style={{display:'flex',border:`1px solid ${T.border2}`,borderRadius:9,overflow:'hidden'}}>
              {(['JAWS_TO_VPS','VPS_TO_JAWS'] as Direction[]).map(d => (
                <button key={d} onClick={()=>setDirection(d)} disabled={running}
                  style={{
                    background: direction===d ? T.blue : 'transparent', border:'none',
                    color: direction===d ? '#fff' : T.text2, fontWeight: direction===d ? 600 : 500,
                    padding:'7px 14px', fontSize:12.5, fontFamily:'inherit', cursor:'pointer',
                  }}>
                  {d === 'JAWS_TO_VPS' ? 'JAWS → VPS' : 'VPS → JAWS'}
                </button>
              ))}
            </div>
          </div>
          <div style={{fontSize:13,color:T.text3,marginBottom:20}}>
            {forward ? (
              <>Sells the picked items out of JAWS at <b style={{color:T.text2}}>average cost</b> (Sale Invoice → VPS customer card),
              books the matching purchase in VPS (Service Bill → stock-transfer account), and queues the MechanicDesk purchase order.</>
            ) : (
              <>Sells the picked items back from VPS at cost (Service Invoice → JAWS customer card) and books a JAWS
              <b style={{color:T.text2}}> Item Bill</b> that <b style={{color:T.text2}}>receives the stock into JAWS inventory</b>.</>
            )}
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

          {/* ── Pick items (browser) + Picked items (summary) ─────────── */}
          <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit, minmax(380px, 1fr))',gap:20,marginBottom:20,alignItems:'start'}}>

            {/* Left: available items to pick from */}
            <section style={{background:T.bg2,border:`1px solid ${T.border}`,borderRadius:12,padding:18}}>
              <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:12,flexWrap:'wrap'}}>
                <h2 style={{fontSize:15,fontWeight:600,margin:0}}>Pick items</h2>
                <span style={{flex:1}}/>
                <input value={filter} onChange={e=>setFilter(e.target.value)} placeholder="Filter SKU or name…" style={{...inp,width:200}}/>
                <button onClick={()=>loadItems(direction)} style={{...inp,cursor:'pointer',color:T.text2}}>↻</button>
              </div>

              {items === null && !itemsError && <div style={{color:T.text3,fontSize:13,padding:'18px 0'}}>Loading items + live JAWS costs…</div>}
              {itemsError && <div style={{color:T.red,fontSize:13,padding:'12px 0'}}>Failed to load items: {itemsError}</div>}
              {items !== null && items.length === 0 && <div style={{color:T.text3,fontSize:13,padding:'12px 0'}}>{forward ? 'No inventoried items with stock on hand.' : 'No inventoried catalogue items.'}</div>}

              {items !== null && items.length > 0 && (
                <div style={{maxHeight:460,overflowY:'auto',border:`1px solid ${T.border}`,borderRadius:8}}>
                  <table style={{width:'100%',borderCollapse:'collapse',fontSize:13}}>
                    <thead style={{position:'sticky',top:0,background:T.bg2,zIndex:1}}>
                      <tr style={{color:T.text3,fontSize:11,textTransform:'uppercase',letterSpacing:'0.06em'}}>
                        <th style={{textAlign:'left',padding:'7px 8px'}}></th>
                        <th style={{textAlign:'left',padding:'7px 8px'}}>SKU</th>
                        <th style={{textAlign:'left',padding:'7px 8px'}}>Item</th>
                        <th style={{textAlign:'right',padding:'7px 8px'}}>On hand</th>
                        <th style={{textAlign:'right',padding:'7px 8px'}}>Cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visible.map(i => {
                        const on = selected[i.catalogue_id] != null
                        return (
                          <tr key={i.catalogue_id}
                            onClick={()=>toggle(i)}
                            style={{borderTop:`1px solid ${T.border}`,background:on?'rgba(79,142,247,0.08)':'transparent',cursor:'pointer'}}>
                            <td style={{padding:'7px 8px'}}>
                              <input type="checkbox" checked={on} readOnly style={{cursor:'pointer',pointerEvents:'none'}}/>
                            </td>
                            <td style={{padding:'7px 8px',fontFamily:'monospace',fontSize:12}}>{i.sku}</td>
                            <td style={{padding:'7px 8px',color:T.text2}}>{i.name}{!i.is_taxable && <span style={{color:T.text3,fontSize:10,marginLeft:6}}>FRE</span>}</td>
                            <td style={{padding:'7px 8px',textAlign:'right',fontFamily:'monospace'}}>{i.on_hand}</td>
                            <td style={{padding:'7px 8px',textAlign:'right',fontFamily:'monospace'}}>{fmt$(i.avg_cost)}</td>
                          </tr>
                        )
                      })}
                      {visible.length === 0 && (
                        <tr><td colSpan={5} style={{padding:'14px 8px',color:T.text3,fontSize:12,textAlign:'center'}}>No items match “{filter}”.</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {/* Right: picked items summary */}
            <section style={{background:T.bg2,border:`1px solid ${T.border}`,borderRadius:12,padding:18}}>
              <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:12}}>
                <h2 style={{fontSize:15,fontWeight:600,margin:0}}>Picked items</h2>
                <span style={{fontSize:12,color:T.text3}}>({picked.length})</span>
                <span style={{flex:1}}/>
                {picked.length > 0 && (
                  <button onClick={()=>setSelected({})} style={{...inp,cursor:'pointer',color:T.text2,padding:'5px 10px',fontSize:12}}>Clear all</button>
                )}
              </div>

              {picked.length === 0 ? (
                <div style={{color:T.text3,fontSize:13,padding:'28px 8px',textAlign:'center',border:`1px dashed ${T.border2}`,borderRadius:8}}>
                  Nothing selected yet — tick items on the left to build the transfer.
                </div>
              ) : (
                <div style={{maxHeight:460,overflowY:'auto',border:`1px solid ${T.border}`,borderRadius:8}}>
                  <table style={{width:'100%',borderCollapse:'collapse',fontSize:13}}>
                    <thead style={{position:'sticky',top:0,background:T.bg2,zIndex:1}}>
                      <tr style={{color:T.text3,fontSize:11,textTransform:'uppercase',letterSpacing:'0.06em'}}>
                        <th style={{textAlign:'left',padding:'7px 8px'}}>SKU</th>
                        <th style={{textAlign:'left',padding:'7px 8px'}}>Item</th>
                        <th style={{textAlign:'right',padding:'7px 8px'}}>Qty</th>
                        <th style={{textAlign:'right',padding:'7px 8px'}}>Line total</th>
                        <th style={{padding:'7px 8px'}}></th>
                      </tr>
                    </thead>
                    <tbody>
                      {picked.map(i => {
                        const qtyStr = selected[i.catalogue_id] ?? ''
                        const qtyN = Number(qtyStr) || 0
                        const empty = qtyStr === ''
                        return (
                          <tr key={i.catalogue_id} style={{borderTop:`1px solid ${T.border}`}}>
                            <td style={{padding:'7px 8px',fontFamily:'monospace',fontSize:12}}>{i.sku}</td>
                            <td style={{padding:'7px 8px',color:T.text2}}>{i.name}</td>
                            <td style={{padding:'7px 8px',textAlign:'right'}}>
                              <input
                                type="number" min={0} max={forward ? i.on_hand : undefined} value={qtyStr}
                                onChange={e=>setQty(i, e.target.value)}
                                placeholder="qty"
                                style={{...inp,width:72,padding:'4px 8px',textAlign:'right',fontFamily:'monospace',borderColor: empty ? T.amber+'88' : T.border2}}
                              />
                              {forward && <div style={{fontSize:10,color:T.text3,marginTop:2}}>of {i.on_hand}</div>}
                            </td>
                            <td style={{padding:'7px 8px',textAlign:'right',fontFamily:'monospace',color:empty?T.text3:T.text}}>{empty ? '—' : fmt$(qtyN * i.avg_cost)}</td>
                            <td style={{padding:'7px 8px',textAlign:'center'}}>
                              <button onClick={()=>toggle(i)} title="Remove"
                                style={{background:'none',border:'none',color:T.text3,fontSize:15,cursor:'pointer',lineHeight:1,padding:'0 3px'}}
                                onMouseEnter={e=>{e.currentTarget.style.color=T.red}}
                                onMouseLeave={e=>{e.currentTarget.style.color=T.text3}}>×</button>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Totals */}
              {picked.length > 0 && (
                <div style={{marginTop:12,paddingTop:12,borderTop:`1px solid ${T.border}`,fontSize:13,color:T.text2,display:'flex',justifyContent:'space-between'}}>
                  <span>{picked.length} item{picked.length===1?'':'s'}</span>
                  <span><b style={{color:T.text}}>{fmt$(totals.ex)}</b> ex · GST {fmt$(totals.gst)} · <b style={{color:T.text}}>{fmt$(totals.inc)}</b> inc</span>
                </div>
              )}
            </section>
          </div>

          {/* ── Execute footer ──────────────────────────────────────── */}
          <section style={{background:T.bg2,border:`1px solid ${T.border}`,borderRadius:12,padding:18,marginBottom:20}}>
            <div style={{display:'flex',alignItems:'center',gap:16,flexWrap:'wrap'}}>
              <div style={{fontSize:13,color:T.text2}}>
                {picked.length === 0
                  ? 'Select items to transfer'
                  : <>Transferring <b style={{color:T.text}}>{picked.length}</b> item{picked.length===1?'':'s'} · <b style={{color:T.text}}>{totalUnits}</b> unit{totalUnits===1?'':'s'} — <b style={{color:T.text}}>{fmt$(totals.inc)}</b> inc GST{!allHaveQty && <span style={{color:T.amber}}> · enter a qty for each item</span>}</>}
              </div>
              <span style={{flex:1}}/>
              {forward ? (
                <span style={{fontSize:12,color:T.text3,maxWidth:200}}>MechanicDesk assigns the PO number</span>
              ) : (
                <input
                  value={poRef} onChange={e=>setPoRef(e.target.value)} maxLength={20}
                  placeholder="PO reference (required)"
                  title="Lands on both MYOB documents: Customer PO No. on the sale invoice and Supplier Invoice No. on the bill"
                  style={{...inp,width:180,fontFamily:'monospace',borderColor: poRef.trim() ? T.border2 : T.amber+'88'}}
                />
              )}
              <input value={note} onChange={e=>setNote(e.target.value)} placeholder="Note (optional)" style={{...inp,width:220}}/>
              <button
                disabled={blocked}
                onClick={()=>setConfirming(true)}
                title={!configured ? 'Complete the MYOB setup above first' : picked.length===0 ? 'Pick at least one item' : !allHaveQty ? 'Enter a quantity for every picked item' : (!forward && !poRef.trim()) ? 'Enter a PO reference first' : undefined}
                style={{
                  ...inp, cursor: blocked?'not-allowed':'pointer',
                  background: blocked && !running ? T.bg3 : T.blue, border:'none',
                  color: blocked && !running ? T.text3 : '#fff', fontWeight:600, padding:'9px 18px',
                }}>
                {running ? 'Transferring…' : forward ? 'Transfer to VPS →' : 'Transfer to JAWS →'}
              </button>
            </div>
          </section>

          {/* ── History ─────────────────────────────────────────────── */}
          <section style={{background:T.bg2,border:`1px solid ${T.border}`,borderRadius:12,padding:18}}>
            <h2 style={{fontSize:15,fontWeight:600,margin:'0 0 12px'}}>Transfer history</h2>
            {history === null && <div style={{color:T.text3,fontSize:13}}>Loading…</div>}
            {history !== null && history.length === 0 && <div style={{color:T.text3,fontSize:13}}>No transfers yet.</div>}
            {history !== null && history.length > 0 && (
              <div style={{overflowX:'auto'}}>
                <table style={{width:'100%',borderCollapse:'collapse',fontSize:13}}>
                  <thead>
                    <tr style={{color:T.text3,fontSize:11,textTransform:'uppercase',letterSpacing:'0.06em'}}>
                      <th style={{textAlign:'left',padding:'6px 8px'}}>Date</th>
                      <th style={{textAlign:'left',padding:'6px 8px'}}>Direction</th>
                      <th style={{textAlign:'right',padding:'6px 8px'}}>Items</th>
                      <th style={{textAlign:'right',padding:'6px 8px'}}>Total (inc)</th>
                      <th style={{textAlign:'left',padding:'6px 8px'}}>PO ref</th>
                      <th style={{textAlign:'left',padding:'6px 8px'}}>Sale doc</th>
                      <th style={{textAlign:'left',padding:'6px 8px'}}>Bill</th>
                      <th style={{textAlign:'left',padding:'6px 8px'}}>MD PO</th>
                      <th style={{textAlign:'left',padding:'6px 8px'}}>Status</th>
                      <th style={{textAlign:'left',padding:'6px 8px'}}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map(t => {
                      const fwd = (t.direction || 'JAWS_TO_VPS') !== 'VPS_TO_JAWS'
                      const billDone = fwd ? !!t.vps_bill_uid : !!t.jaws_bill_uid
                      return (
                        <tr key={t.id} style={{borderTop:`1px solid ${T.border}`}}>
                          <td style={{padding:'7px 8px',color:T.text2,whiteSpace:'nowrap'}}>
                            {new Date(t.created_at).toLocaleString('en-AU',{day:'numeric',month:'short',hour:'numeric',minute:'2-digit'})}
                          </td>
                          <td style={{padding:'7px 8px',fontSize:12,color:fwd?T.teal:T.purple,whiteSpace:'nowrap'}}>{fwd ? 'JAWS → VPS' : 'VPS → JAWS'}</td>
                          <td style={{padding:'7px 8px',textAlign:'right',fontFamily:'monospace'}}>{t.line_count}</td>
                          <td style={{padding:'7px 8px',textAlign:'right',fontFamily:'monospace'}}>{fmt$(t.total_inc)}</td>
                          <td style={{padding:'7px 8px',fontFamily:'monospace',fontSize:12}}>{(fwd ? (t.md_po_ref || t.po_reference) : t.po_reference) || '—'}</td>
                          <td style={{padding:'7px 8px',fontFamily:'monospace',fontSize:12}}>{(fwd ? t.jaws_invoice_number : t.vps_invoice_number) || '—'}</td>
                          <td style={{padding:'7px 8px',fontSize:12,color:billDone?T.green:T.text3}}>{billDone ? '✓ written' : '—'}</td>
                          <td style={{padding:'7px 8px',fontSize:12}}>
                            {!fwd ? <span style={{color:T.text3}}>n/a</span> : (
                              <div style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}}>
                                {t.md_po_status === 'done'
                                  ? <span style={{color:T.green}} title={t.md_po_error || 'PO entered and received into MechanicDesk stock'}>✓ {t.md_po_ref || 'received'}</span>
                                : t.md_po_status === 'created'
                                  ? <span style={{color:T.amber}} title={t.md_po_error || 'PO entered but not received — receive it in the MD UI'}>{t.md_po_ref || 'entered'} (receive in MD)</span>
                                : t.md_po_status === 'failed' ? <span style={{color:T.red}} title={t.md_po_error || ''}>failed</span>
                                : t.md_po_status === 'queued' ? <span style={{color:T.amber}}>queued…</span>
                                : <span style={{color:T.text3}}>not raised</span>}
                                {t.md_po_status !== 'done' && t.md_po_status !== 'queued' && (
                                  <button onClick={()=>dispatchMdPo(t.id)} disabled={mdFiring===t.id}
                                    title="Create + receive the purchase order in MechanicDesk"
                                    style={{...inp,cursor:'pointer',padding:'3px 9px',fontSize:11,color:T.blue}}>
                                    {mdFiring===t.id ? '…' : (t.md_po_status === 'failed' ? 'Retry MD PO' : 'Raise MD PO')}
                                  </button>
                                )}
                              </div>
                            )}
                          </td>
                          <td style={{padding:'7px 8px'}}>
                            <span style={{
                              fontSize:11, fontWeight:600, padding:'2px 8px', borderRadius:10,
                              color: t.status==='complete'?T.green:(t.status==='partial'||t.status==='awaiting_md')?T.amber:t.status==='failed'?T.red:T.text3,
                              background: t.status==='complete'?'rgba(52,199,123,0.12)':(t.status==='partial'||t.status==='awaiting_md')?'rgba(245,166,35,0.12)':t.status==='failed'?'rgba(240,78,78,0.12)':T.bg3,
                            }}>{t.status==='awaiting_md'?'awaiting MD':t.status}</span>
                            {t.error && <div style={{fontSize:11,color:T.red,marginTop:3,maxWidth:300}}>{t.error}</div>}
                          </td>
                          <td style={{padding:'7px 8px'}}>
                            <div style={{display:'flex',alignItems:'center',gap:8}}>
                              {t.status === 'partial' && (
                                <button onClick={()=>retry(t.id)} disabled={retrying===t.id}
                                  style={{...inp,cursor:'pointer',padding:'4px 10px',fontSize:12,color:T.amber}}>
                                  {retrying===t.id ? 'Retrying…' : 'Retry bill'}
                                </button>
                              )}
                              <button onClick={()=>removeTransfer(t.id)} disabled={deleting===t.id}
                                title="Remove from history"
                                style={{background:'none',border:'none',color:T.text3,fontSize:15,cursor:'pointer',lineHeight:1,padding:'0 3px'}}
                                onMouseEnter={e=>{e.currentTarget.style.color=T.red}}
                                onMouseLeave={e=>{e.currentTarget.style.color=T.text3}}>
                                {deleting===t.id ? '…' : '×'}
                              </button>
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </main>
      </div>

      {/* Confirm modal */}
      {confirming && (
        <div onClick={()=>!running && setConfirming(false)}
          style={{position:'fixed',inset:0,zIndex:950,background:'rgba(8,10,13,0.8)',backdropFilter:'blur(4px)',display:'flex',alignItems:'center',justifyContent:'center',padding:24}}>
          <div onClick={e=>e.stopPropagation()}
            style={{width:'100%',maxWidth:560,background:T.bg2,border:`1px solid ${T.border2}`,borderRadius:14,padding:22,fontFamily:'inherit',color:T.text}}>
            <h3 style={{margin:'0 0 12px',fontSize:16,fontWeight:600}}>Confirm stock transfer — {forward ? 'JAWS → VPS' : 'VPS → JAWS'}</h3>

            {/* Summary of stock being transferred */}
            <div style={{maxHeight:240,overflowY:'auto',border:`1px solid ${T.border}`,borderRadius:8,marginBottom:12}}>
              <table style={{width:'100%',borderCollapse:'collapse',fontSize:12.5}}>
                <thead style={{position:'sticky',top:0,background:T.bg2}}>
                  <tr style={{color:T.text3,fontSize:11,textTransform:'uppercase',letterSpacing:'0.06em'}}>
                    <th style={{textAlign:'left',padding:'6px 8px'}}>SKU</th>
                    <th style={{textAlign:'left',padding:'6px 8px'}}>Item</th>
                    <th style={{textAlign:'right',padding:'6px 8px'}}>Qty</th>
                    <th style={{textAlign:'right',padding:'6px 8px'}}>Line total</th>
                  </tr>
                </thead>
                <tbody>
                  {picked.map(i => (
                    <tr key={i.catalogue_id} style={{borderTop:`1px solid ${T.border}`}}>
                      <td style={{padding:'6px 8px',fontFamily:'monospace',fontSize:11.5}}>{i.sku}</td>
                      <td style={{padding:'6px 8px',color:T.text2,maxWidth:220,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{i.name}</td>
                      <td style={{padding:'6px 8px',textAlign:'right',fontFamily:'monospace'}}>{qtyOf(i.catalogue_id)}</td>
                      <td style={{padding:'6px 8px',textAlign:'right',fontFamily:'monospace'}}>{fmt$(qtyOf(i.catalogue_id) * i.avg_cost)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr style={{borderTop:`1px solid ${T.border2}`,fontWeight:600}}>
                    <td style={{padding:'6px 8px'}} colSpan={2}>{picked.length} item{picked.length===1?'':'s'} · {totalUnits} unit{totalUnits===1?'':'s'}</td>
                    <td style={{padding:'6px 8px',textAlign:'right',fontFamily:'monospace'}}>{totalUnits}</td>
                    <td style={{padding:'6px 8px',textAlign:'right',fontFamily:'monospace'}}>{fmt$(totals.ex)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>

            <div style={{fontSize:13,color:T.text2,lineHeight:1.6,marginBottom:16}}>
              At cost{forward ? <> · PO number assigned by MechanicDesk</> : <> · PO <b style={{color:T.text,fontFamily:'monospace'}}>{poRef.trim()}</b></>}:
              {' '}{fmt$(totals.ex)} ex GST + {fmt$(totals.gst)} GST = <b style={{color:T.text}}>{fmt$(totals.inc)}</b><br/><br/>
              {forward ? (
                <>MechanicDesk raises the PO (and receives the stock), then the <b style={{color:T.text}}>JAWS Sale Invoice</b>
                {' '}and <b style={{color:T.text}}>VPS Purchase Bill</b> post in MYOB referencing that PO number — all within ~1 minute.</>
              ) : (
                <>This writes a <b style={{color:T.text}}>Sale Invoice in VPS</b> and a <b style={{color:T.text}}>Purchase Bill in JAWS</b>
                {' '}that receives the stock back into JAWS inventory.</>
              )}
              {' '}It cannot be undone from the portal — reversals are manual in MYOB.
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

// ── Setup panel: the five MYOB references ──────────────────────────────
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
          ? <span style={{fontSize:11,fontWeight:600,color:T.green,background:'rgba(52,199,123,0.12)',padding:'2px 8px',borderRadius:10}}>configured for this direction</span>
          : <span style={{fontSize:11,fontWeight:600,color:T.amber,background:'rgba(245,166,35,0.12)',padding:'2px 8px',borderRadius:10}}>setup required</span>}
        <span style={{flex:1}}/>
        <span style={{color:T.text3,fontSize:12}}>{open ? '▲' : '▼'}</span>
      </div>
      {open && (
        <>
          <div style={{fontSize:11,color:T.text3,margin:'12px 0 6px',textTransform:'uppercase',letterSpacing:'0.06em'}}>JAWS → VPS</div>
          <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit, minmax(280px, 1fr))',gap:14}}>
            <MyobPicker
              label="VPS customer card (in JAWS)"
              hint="The JAWS sale invoice bills this customer"
              lookup="customers" file="JAWS"
              current={cfg.customerName}
              onPick={async (uid, name) => onSaved(await saveSetting({ customer_uid: uid, customer_name: name }))}
            />
            <MyobPicker
              label="JAWS supplier card (in VPS)"
              hint="The VPS purchase bill comes from this supplier"
              lookup="suppliers" file="VPS"
              current={cfg.supplierName}
              onPick={async (uid, name) => onSaved(await saveSetting({ supplier_uid: uid, supplier_name: name }))}
            />
            <MyobPicker
              label="VPS stock-transfer account"
              hint="VPS account for transfer value (both directions)"
              lookup="accounts" file="VPS"
              current={cfg.accountName}
              onPick={async (uid, name) => onSaved(await saveSetting({ account_uid: uid, account_name: name }))}
            />
          </div>
          <div style={{fontSize:11,color:T.text3,margin:'14px 0 6px',textTransform:'uppercase',letterSpacing:'0.06em'}}>VPS → JAWS</div>
          <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit, minmax(280px, 1fr))',gap:14}}>
            <MyobPicker
              label="JAWS customer card (in VPS)"
              hint="The VPS sale invoice bills this customer"
              lookup="customers" file="VPS"
              current={cfg.customerNameVps}
              onPick={async (uid, name) => onSaved(await saveSetting({ customer_uid_vps: uid, customer_name_vps: name }))}
            />
            <MyobPicker
              label="VPS supplier card (in JAWS)"
              hint="The JAWS item bill (stock receipt) comes from this supplier"
              lookup="suppliers" file="JAWS"
              current={cfg.supplierNameJaws}
              onPick={async (uid, name) => onSaved(await saveSetting({ supplier_uid_jaws: uid, supplier_name_jaws: name }))}
            />
          </div>
          <div style={{fontSize:11,color:T.text3,margin:'14px 0 6px',textTransform:'uppercase',letterSpacing:'0.06em'}}>MechanicDesk (JAWS → VPS auto-PO)</div>
          <MdSupplierField current={cfg.mdPurchaseSupplierId} onSaved={onSaved}/>
        </>
      )}
    </section>
  )
}

// MechanicDesk supplier id — numeric MD id of the supplier card the workshop
// PO is raised on (e.g. "Just Autos Wholesale"). Plain number input.
function MdSupplierField({ current, onSaved }: { current: number | null; onSaved: (c: TransferConfig) => void }) {
  const [val, setVal] = useState(current != null ? String(current) : '')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  useEffect(() => { setVal(current != null ? String(current) : '') }, [current])
  return (
    <div style={{background:T.bg3,border:`1px solid ${T.border}`,borderRadius:10,padding:13,maxWidth:420}}>
      <div style={{fontSize:12.5,fontWeight:600,marginBottom:2}}>MechanicDesk supplier id</div>
      <div style={{fontSize:11,color:T.text3,marginBottom:8}}>Numeric MD id of the supplier the PO is raised on (find it in the MD supplier URL). Leave blank to skip MD PO creation.</div>
      <div style={{display:'flex',gap:6}}>
        <input
          value={val} onChange={e=>{ setVal(e.target.value.replace(/[^0-9]/g,'')); setSaved(false) }}
          placeholder="e.g. 1091329"
          style={{flex:1,background:T.bg2,border:`1px solid ${T.border2}`,color:T.text,borderRadius:7,padding:'6px 9px',fontSize:12,fontFamily:'monospace',outline:'none'}}
        />
        <button
          disabled={saving}
          onClick={async ()=>{ setSaving(true); try { onSaved(await saveSetting({ md_purchase_supplier_id: val })); setSaved(true) } finally { setSaving(false) } }}
          style={{background:T.bg2,border:`1px solid ${T.border2}`,color:T.text2,borderRadius:7,padding:'6px 12px',fontSize:12,fontFamily:'inherit',cursor:'pointer'}}>
          {saving ? '…' : saved ? '✓ Saved' : 'Save'}
        </button>
      </div>
    </div>
  )
}

async function saveSetting(fields: Record<string, string | number>): Promise<TransferConfig> {
  const r = await fetch('/api/b2b/admin/stock-transfer', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'save-settings', ...fields }),
  })
  const j = await r.json().catch(() => null)
  if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`)
  return j.config
}

function MyobPicker({ label, hint, lookup, file, current, onPick }: {
  label: string
  hint: string
  lookup: 'customers' | 'suppliers' | 'accounts'
  file: 'JAWS' | 'VPS'
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
      const r = await fetch(`/api/b2b/admin/stock-transfer?lookup=${lookup}&file=${file}&q=${encodeURIComponent(q)}`, { credentials: 'same-origin' })
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
