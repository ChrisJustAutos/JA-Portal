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
//
// Alloy restyle 2026-08-12: theme T + kit cards/pills/banners. This page sits
// under Inventory tabs (not B2BAdminTabs), so <AlloyStyles/> mounts locally.

import { useEffect, useMemo, useState } from 'react'
import Head from 'next/head'
import PortalTopBar from '../../../lib/PortalTopBar'
import WorkshopTabs from '../../../components/WorkshopTabs'
import { requirePageAuth } from '../../../lib/authServer'
import type { UserRole } from '../../../lib/permissions'
import { money } from '../../../lib/ui/format'
import { useConfirm } from '../../../components/ui/Feedback'
import { T, alpha } from '../../../lib/ui/theme'
import { A, RADIUS, SHADOW, AlloyStyles, Btn, btnStyle, cardStyle, Banner, PageTitle, StatusPill, Seg } from '../../../components/b2b/ui'

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

const fmt$ = money

// Dense table header cell style — staff-table density at the 12px type floor.
const th: React.CSSProperties = { fontSize: 12, fontWeight: 650, color: T.text3 }

export default function StockTransferPage({ user }: Props) {
  const confirmDialog = useConfirm()
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
    if (!(await confirmDialog({ title: 'Remove this transfer from the portal history?', message: 'This only clears the portal record — any MYOB invoice/bill or MechanicDesk PO already posted stays put.', danger: true }))) return
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
    background: T.bg3, border: '1px solid transparent', color: T.text,
    borderRadius: RADIUS.sm, padding: '8px 11px', fontSize: 13, fontFamily: 'inherit', outline: 'none',
  }
  // Forward is MD-first — MD assigns the PO number, so no PO ref needed.
  // Reverse still requires a PO reference.
  const blocked = !configured || picked.length === 0 || running || !allHaveQty || (!forward && !poRef.trim())

  return (
    <>
      <Head><title>Stock Transfer · Inventory · JA Portal</title></Head>
      <AlloyStyles/>
      <div style={{display:'flex',flexDirection:'column',minHeight:'100vh',background:T.bg,color:T.text,fontFamily:'system-ui,-apple-system,sans-serif'}}>
        <PortalTopBar
          activeId="diary"
          currentUserRole={user.role}
          currentUserVisibleTabs={user.visibleTabs}
          currentUserName={user.displayName}
          currentUserEmail={user.email}
        />
        <WorkshopTabs active="stock-transfer" role={user.role} />
        <main className="b2b-admin-main" style={{flex:1,padding:'28px 32px',width:'100%',boxSizing:'border-box'}}>

          <PageTitle
            sub={forward ? (
              <>Sells the picked items out of JAWS at <b style={{color:T.text2}}>average cost</b> (Sale Invoice → VPS customer card),
              books the matching purchase in VPS (Service Bill → stock-transfer account), and queues the MechanicDesk purchase order.</>
            ) : (
              <>Sells the picked items back from VPS at cost (Service Invoice → JAWS customer card) and books a JAWS
              <b style={{color:T.text2}}> Item Bill</b> that <b style={{color:T.text2}}>receives the stock into JAWS inventory</b>.</>
            )}
            action={
              /* Direction toggle */
              <div style={{minWidth:240}}>
                <Seg<Direction>
                  options={[{ id: 'JAWS_TO_VPS', label: 'JAWS → VPS' }, { id: 'VPS_TO_JAWS', label: 'VPS → JAWS' }]}
                  value={direction}
                  onChange={d => { if (!running) setDirection(d) }}
                />
              </div>
            }>
            Internal stock transfer
          </PageTitle>

          {result && (
            <div style={{marginBottom:16}}>
              <Banner tone={result.kind==='ok' ? 'success' : result.kind==='partial' ? 'warn' : 'error'} onDismiss={() => setResult(null)}>
                {result.text}
              </Banner>
            </div>
          )}

          <SetupPanel cfg={cfg} onSaved={c => setCfg(c)} configured={configured}/>

          {/* ── Pick items (browser) + Picked items (summary) ─────────── */}
          <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit, minmax(380px, 1fr))',gap:20,marginBottom:20,alignItems:'start'}}>

            {/* Left: available items to pick from */}
            <section style={cardStyle()}>
              <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:12,flexWrap:'wrap'}}>
                <h2 style={{fontSize:15,fontWeight:600,margin:0}}>Pick items</h2>
                <span style={{flex:1}}/>
                <input value={filter} onChange={e=>setFilter(e.target.value)} placeholder="Filter SKU or name…" style={{...inp,width:200}}/>
                <Btn variant="ghost" size="sm" onClick={()=>loadItems(direction)}>Refresh</Btn>
              </div>

              {items === null && !itemsError && <div style={{color:T.text3,fontSize:13,padding:'18px 0'}}>Loading items + live JAWS costs…</div>}
              {itemsError && <div style={{color:A.bad,fontSize:13,padding:'12px 0'}}>Failed to load items: {itemsError}</div>}
              {items !== null && items.length === 0 && <div style={{color:T.text3,fontSize:13,padding:'12px 0'}}>{forward ? 'No inventoried items with stock on hand.' : 'No inventoried catalogue items.'}</div>}

              {items !== null && items.length > 0 && (
                <div style={{maxHeight:460,overflowY:'auto',border:`1px solid ${T.border}`,borderRadius:RADIUS.sm}}>
                  <table style={{width:'100%',borderCollapse:'collapse',fontSize:13}}>
                    <thead style={{position:'sticky',top:0,background:T.bg2,zIndex:1}}>
                      <tr style={th}>
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
                            style={{borderTop:`1px solid ${T.border}`,background:on?alpha(A.accent,'14'):'transparent',cursor:'pointer'}}>
                            <td style={{padding:'7px 8px'}}>
                              <input type="checkbox" checked={on} readOnly style={{cursor:'pointer',pointerEvents:'none'}}/>
                            </td>
                            <td style={{padding:'7px 8px',fontFamily:'monospace',fontSize:12}}>{i.sku}</td>
                            <td style={{padding:'7px 8px',color:T.text2}}>{i.name}{!i.is_taxable && <span style={{color:T.text3,fontSize:12,marginLeft:6}}>FRE</span>}</td>
                            <td style={{padding:'7px 8px',textAlign:'right',fontFamily:'monospace',fontVariantNumeric:'tabular-nums'}}>{i.on_hand}</td>
                            <td style={{padding:'7px 8px',textAlign:'right',fontFamily:'monospace',fontVariantNumeric:'tabular-nums'}}>{fmt$(i.avg_cost)}</td>
                          </tr>
                        )
                      })}
                      {visible.length === 0 && (
                        <tr><td colSpan={5} style={{padding:'14px 8px',color:T.text3,fontSize:12.5,textAlign:'center'}}>No items match “{filter}”.</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {/* Right: picked items summary */}
            <section style={cardStyle()}>
              <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:12}}>
                <h2 style={{fontSize:15,fontWeight:600,margin:0}}>Picked items</h2>
                <span style={{fontSize:12.5,color:T.text3}}>({picked.length})</span>
                <span style={{flex:1}}/>
                {picked.length > 0 && (
                  <Btn variant="ghost" size="sm" onClick={()=>setSelected({})}>Clear all</Btn>
                )}
              </div>

              {picked.length === 0 ? (
                <div style={{color:T.text3,fontSize:13,padding:'28px 8px',textAlign:'center',border:`1px dashed ${T.border2}`,borderRadius:RADIUS.sm}}>
                  Nothing selected yet — tick items on the left to build the transfer.
                </div>
              ) : (
                <div style={{maxHeight:460,overflowY:'auto',border:`1px solid ${T.border}`,borderRadius:RADIUS.sm}}>
                  <table style={{width:'100%',borderCollapse:'collapse',fontSize:13}}>
                    <thead style={{position:'sticky',top:0,background:T.bg2,zIndex:1}}>
                      <tr style={th}>
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
                                className="al-nospin"
                                style={{...inp,width:72,padding:'4px 8px',textAlign:'right',fontFamily:'monospace',fontVariantNumeric:'tabular-nums',border:`1px solid ${empty ? alpha(A.warn,'88') : 'transparent'}`}}
                              />
                              {forward && <div style={{fontSize:12,color:T.text3,marginTop:2}}>of {i.on_hand}</div>}
                            </td>
                            <td style={{padding:'7px 8px',textAlign:'right',fontFamily:'monospace',fontVariantNumeric:'tabular-nums',color:empty?T.text3:T.text}}>{empty ? '—' : fmt$(qtyN * i.avg_cost)}</td>
                            <td style={{padding:'7px 8px',textAlign:'center'}}>
                              <button onClick={()=>toggle(i)} title="Remove" className="al-press"
                                style={{background:'none',border:'none',color:T.text3,fontSize:15,cursor:'pointer',lineHeight:1,padding:'0 3px',fontFamily:'inherit'}}
                                onMouseEnter={e=>{e.currentTarget.style.color=A.bad}}
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
                  <span style={{fontVariantNumeric:'tabular-nums'}}><b style={{color:T.text}}>{fmt$(totals.ex)}</b> ex · GST {fmt$(totals.gst)} · <b style={{color:T.text}}>{fmt$(totals.inc)}</b> inc</span>
                </div>
              )}
            </section>
          </div>

          {/* ── Execute footer ──────────────────────────────────────── */}
          <section style={{...cardStyle(),marginBottom:20}}>
            <div style={{display:'flex',alignItems:'center',gap:16,flexWrap:'wrap'}}>
              <div style={{fontSize:13,color:T.text2}}>
                {picked.length === 0
                  ? 'Select items to transfer'
                  : <>Transferring <b style={{color:T.text}}>{picked.length}</b> item{picked.length===1?'':'s'} · <b style={{color:T.text}}>{totalUnits}</b> unit{totalUnits===1?'':'s'} — <b style={{color:T.text}}>{fmt$(totals.inc)}</b> inc GST{!allHaveQty && <span style={{color:A.warn}}> · enter a qty for each item</span>}</>}
              </div>
              <span style={{flex:1}}/>
              {forward ? (
                <span style={{fontSize:12.5,color:T.text3,maxWidth:200}}>MechanicDesk assigns the PO number</span>
              ) : (
                <input
                  value={poRef} onChange={e=>setPoRef(e.target.value)} maxLength={20}
                  placeholder="PO reference (required)"
                  title="Lands on both MYOB documents: Customer PO No. on the sale invoice and Supplier Invoice No. on the bill"
                  style={{...inp,width:180,fontFamily:'monospace',border:`1px solid ${poRef.trim() ? 'transparent' : alpha(A.warn,'88')}`}}
                />
              )}
              <input value={note} onChange={e=>setNote(e.target.value)} placeholder="Note (optional)" style={{...inp,width:220}}/>
              <Btn
                disabled={blocked}
                onClick={()=>setConfirming(true)}
                title={!configured ? 'Complete the MYOB setup above first' : picked.length===0 ? 'Pick at least one item' : !allHaveQty ? 'Enter a quantity for every picked item' : (!forward && !poRef.trim()) ? 'Enter a PO reference first' : undefined}>
                {running ? 'Transferring…' : forward ? 'Transfer to VPS →' : 'Transfer to JAWS →'}
              </Btn>
            </div>
          </section>

          {/* ── History ─────────────────────────────────────────────── */}
          <section style={cardStyle()}>
            <h2 style={{fontSize:15,fontWeight:600,margin:'0 0 12px'}}>Transfer history</h2>
            {history === null && <div style={{color:T.text3,fontSize:13}}>Loading…</div>}
            {history !== null && history.length === 0 && <div style={{color:T.text3,fontSize:13}}>No transfers yet.</div>}
            {history !== null && history.length > 0 && (
              <div style={{overflowX:'auto'}}>
                <table className="b2b-cards" style={{width:'100%',borderCollapse:'collapse',fontSize:13}}>
                  <thead>
                    <tr style={th}>
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
                          <td className="b2b-card-title" style={{padding:'7px 8px',color:T.text2,whiteSpace:'nowrap'}}>
                            {new Date(t.created_at).toLocaleString('en-AU',{day:'numeric',month:'short',hour:'numeric',minute:'2-digit'})}
                          </td>
                          {/* teal/purple retired — forward rides the accent (in motion out of JAWS), reverse green (stock received back) */}
                          <td data-label="Direction" style={{padding:'7px 8px',fontSize:12,color:fwd?A.accent:A.good,whiteSpace:'nowrap'}}>{fwd ? 'JAWS → VPS' : 'VPS → JAWS'}</td>
                          <td data-label="Items" style={{padding:'7px 8px',textAlign:'right',fontFamily:'monospace',fontVariantNumeric:'tabular-nums'}}>{t.line_count}</td>
                          <td data-label="Total (inc)" style={{padding:'7px 8px',textAlign:'right',fontFamily:'monospace',fontVariantNumeric:'tabular-nums'}}>{fmt$(t.total_inc)}</td>
                          <td data-label="PO ref" style={{padding:'7px 8px',fontFamily:'monospace',fontSize:12}}>{(fwd ? (t.md_po_ref || t.po_reference) : t.po_reference) || '—'}</td>
                          <td data-label="Sale doc" style={{padding:'7px 8px',fontFamily:'monospace',fontSize:12}}>{(fwd ? t.jaws_invoice_number : t.vps_invoice_number) || '—'}</td>
                          <td data-label="Bill" style={{padding:'7px 8px',fontSize:12,color:billDone?A.good:T.text3}}>{billDone ? '✓ written' : '—'}</td>
                          <td data-label="MD PO" style={{padding:'7px 8px',fontSize:12}}>
                            {!fwd ? <span style={{color:T.text3}}>n/a</span> : (
                              <div style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}}>
                                {t.md_po_status === 'done'
                                  ? <span style={{color:A.good}} title={t.md_po_error || 'PO entered and received into MechanicDesk stock'}>✓ {t.md_po_ref || 'received'}</span>
                                : t.md_po_status === 'created'
                                  ? <span style={{color:A.warn}} title={t.md_po_error || 'PO entered but not received — receive it in the MD UI'}>{t.md_po_ref || 'entered'} (receive in MD)</span>
                                : t.md_po_status === 'failed' ? <span style={{color:A.bad}} title={t.md_po_error || ''}>failed</span>
                                : t.md_po_status === 'queued' ? <span style={{color:A.warn}}>queued…</span>
                                : <span style={{color:T.text3}}>not raised</span>}
                                {t.md_po_status !== 'done' && t.md_po_status !== 'queued' && (
                                  <button onClick={()=>dispatchMdPo(t.id)} disabled={mdFiring===t.id}
                                    title="Create + receive the purchase order in MechanicDesk"
                                    className="al-press al-focus al-ghost"
                                    style={{...btnStyle('ghost','sm',mdFiring===t.id),fontSize:12,color:A.accent}}>
                                    {mdFiring===t.id ? '…' : (t.md_po_status === 'failed' ? 'Retry MD PO' : 'Raise MD PO')}
                                  </button>
                                )}
                              </div>
                            )}
                          </td>
                          <td data-label="Status" style={{padding:'7px 8px'}}>
                            <StatusPill color={t.status==='complete'?A.good:(t.status==='partial'||t.status==='awaiting_md')?A.warn:t.status==='failed'?A.bad:T.text3}>
                              {t.status==='awaiting_md'?'awaiting MD':t.status}
                            </StatusPill>
                            {t.error && <div style={{fontSize:12,color:A.bad,marginTop:3,maxWidth:300}}>{t.error}</div>}
                          </td>
                          <td data-label="" style={{padding:'7px 8px',justifyContent:'flex-end'}}>
                            <div style={{display:'flex',alignItems:'center',gap:8}}>
                              {t.status === 'partial' && (
                                <button onClick={()=>retry(t.id)} disabled={retrying===t.id}
                                  className="al-press al-focus al-ghost"
                                  style={{...btnStyle('ghost','sm',retrying===t.id),fontSize:12,color:A.warn}}>
                                  {retrying===t.id ? 'Retrying…' : 'Retry bill'}
                                </button>
                              )}
                              <button onClick={()=>removeTransfer(t.id)} disabled={deleting===t.id}
                                title="Remove from history"
                                className="al-press"
                                style={{background:'none',border:'none',color:T.text3,fontSize:15,cursor:'pointer',lineHeight:1,padding:'0 3px',fontFamily:'inherit'}}
                                onMouseEnter={e=>{e.currentTarget.style.color=A.bad}}
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
            style={{width:'100%',maxWidth:560,background:T.bg2,border:`1px solid ${T.border2}`,borderRadius:RADIUS.md,boxShadow:SHADOW.md,padding:22,fontFamily:'inherit',color:T.text}}>
            <h3 style={{margin:'0 0 12px',fontSize:16,fontWeight:600}}>Confirm stock transfer — {forward ? 'JAWS → VPS' : 'VPS → JAWS'}</h3>

            {/* Summary of stock being transferred */}
            <div style={{maxHeight:240,overflowY:'auto',border:`1px solid ${T.border}`,borderRadius:RADIUS.sm,marginBottom:12}}>
              <table style={{width:'100%',borderCollapse:'collapse',fontSize:12.5}}>
                <thead style={{position:'sticky',top:0,background:T.bg2}}>
                  <tr style={th}>
                    <th style={{textAlign:'left',padding:'6px 8px'}}>SKU</th>
                    <th style={{textAlign:'left',padding:'6px 8px'}}>Item</th>
                    <th style={{textAlign:'right',padding:'6px 8px'}}>Qty</th>
                    <th style={{textAlign:'right',padding:'6px 8px'}}>Line total</th>
                  </tr>
                </thead>
                <tbody>
                  {picked.map(i => (
                    <tr key={i.catalogue_id} style={{borderTop:`1px solid ${T.border}`}}>
                      <td style={{padding:'6px 8px',fontFamily:'monospace',fontSize:12}}>{i.sku}</td>
                      <td style={{padding:'6px 8px',color:T.text2,maxWidth:220,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{i.name}</td>
                      <td style={{padding:'6px 8px',textAlign:'right',fontFamily:'monospace',fontVariantNumeric:'tabular-nums'}}>{qtyOf(i.catalogue_id)}</td>
                      <td style={{padding:'6px 8px',textAlign:'right',fontFamily:'monospace',fontVariantNumeric:'tabular-nums'}}>{fmt$(qtyOf(i.catalogue_id) * i.avg_cost)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr style={{borderTop:`1px solid ${T.border2}`,fontWeight:600}}>
                    <td style={{padding:'6px 8px'}} colSpan={2}>{picked.length} item{picked.length===1?'':'s'} · {totalUnits} unit{totalUnits===1?'':'s'}</td>
                    <td style={{padding:'6px 8px',textAlign:'right',fontFamily:'monospace',fontVariantNumeric:'tabular-nums'}}>{totalUnits}</td>
                    <td style={{padding:'6px 8px',textAlign:'right',fontFamily:'monospace',fontVariantNumeric:'tabular-nums'}}>{fmt$(totals.ex)}</td>
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
              <Btn variant="ghost" onClick={()=>setConfirming(false)} disabled={running}>Cancel</Btn>
              <Btn onClick={execute} disabled={running}>
                {running ? 'Transferring…' : `Transfer ${picked.length} item${picked.length===1?'':'s'}`}
              </Btn>
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
    <section style={{...cardStyle(),border:`1px solid ${configured?T.border:alpha(A.warn,'55')}`,marginBottom:20}}>
      <div onClick={()=>setOpen(o=>!o)} style={{display:'flex',alignItems:'center',gap:10,cursor:'pointer'}}>
        <h2 style={{fontSize:15,fontWeight:600,margin:0}}>MYOB setup</h2>
        {configured
          ? <StatusPill color={A.good}>configured for this direction</StatusPill>
          : <StatusPill color={A.warn}>setup required</StatusPill>}
        <span style={{flex:1}}/>
        <span style={{color:T.text3,fontSize:12}}>{open ? '▲' : '▼'}</span>
      </div>
      {open && (
        <>
          <div style={{fontSize:12,fontWeight:650,color:T.text2,margin:'12px 0 6px'}}>JAWS → VPS</div>
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
          <div style={{fontSize:12,fontWeight:650,color:T.text2,margin:'14px 0 6px'}}>VPS → JAWS</div>
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
          <div style={{fontSize:12,fontWeight:650,color:T.text2,margin:'14px 0 6px'}}>MechanicDesk (JAWS → VPS auto-PO)</div>
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
    <div style={{background:T.bg3,borderRadius:RADIUS.sm,padding:13,maxWidth:420}}>
      <div style={{fontSize:12.5,fontWeight:600,marginBottom:2}}>MechanicDesk supplier id</div>
      <div style={{fontSize:12,color:T.text3,marginBottom:8,lineHeight:1.45}}>Numeric MD id of the supplier the PO is raised on (find it in the MD supplier URL). Leave blank to skip MD PO creation.</div>
      <div style={{display:'flex',gap:6}}>
        <input
          value={val} onChange={e=>{ setVal(e.target.value.replace(/[^0-9]/g,'')); setSaved(false) }}
          placeholder="e.g. 1091329"
          style={{flex:1,background:T.bg2,border:'1px solid transparent',color:T.text,borderRadius:RADIUS.sm,padding:'6px 9px',fontSize:12.5,fontFamily:'monospace',outline:'none'}}
        />
        <Btn variant="secondary" size="sm" disabled={saving}
          onClick={async ()=>{ setSaving(true); try { onSaved(await saveSetting({ md_purchase_supplier_id: val })); setSaved(true) } finally { setSaving(false) } }}>
          {saving ? '…' : saved ? '✓ Saved' : 'Save'}
        </Btn>
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
    <div style={{background:T.bg3,borderRadius:RADIUS.sm,padding:13}}>
      <div style={{fontSize:12.5,fontWeight:600,marginBottom:2}}>{label}</div>
      <div style={{fontSize:12,color:T.text3,marginBottom:8,lineHeight:1.45}}>{hint}</div>
      <div style={{fontSize:12.5,marginBottom:8,color: current?A.good:T.text3}}>
        {current ? `✓ ${current}` : 'Not set'}
      </div>
      <div style={{display:'flex',gap:6}}>
        <input
          value={q} onChange={e=>setQ(e.target.value)}
          onKeyDown={e=>{ if (e.key==='Enter') search() }}
          placeholder="Search MYOB…"
          style={{flex:1,background:T.bg2,border:'1px solid transparent',color:T.text,borderRadius:RADIUS.sm,padding:'6px 9px',fontSize:12.5,fontFamily:'inherit',outline:'none'}}
        />
        <Btn variant="secondary" size="sm" onClick={search} disabled={searching}>
          {searching ? '…' : 'Search'}
        </Btn>
      </div>
      {error && <div style={{fontSize:12,color:A.bad,marginTop:6}}>{error}</div>}
      {results !== null && (
        <div style={{marginTop:8,maxHeight:160,overflowY:'auto',border:`1px solid ${T.border}`,borderRadius:RADIUS.sm}}>
          {results.length === 0 && <div style={{fontSize:12.5,color:T.text3,padding:8}}>No matches.</div>}
          {results.map(r => (
            <button key={r.uid} disabled={saving}
              onClick={async ()=>{ setSaving(true); try { await onPick(r.uid, r.name); setResults(null); setQ('') } catch(e:any){ setError(e?.message||String(e)) } finally { setSaving(false) } }}
              className="al-press al-ghost"
              style={{display:'block',width:'100%',textAlign:'left',background:'none',border:'none',borderBottom:`1px solid ${T.border}`,color:T.text2,padding:'7px 9px',fontSize:12.5,fontFamily:'inherit',cursor:'pointer'}}>
              {r.name} {r.display_id && <span style={{color:T.text3}}>· {r.display_id}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
