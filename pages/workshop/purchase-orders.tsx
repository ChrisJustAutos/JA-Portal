// pages/workshop/purchase-orders.tsx — Workshop Purchase Orders (from autodesk_pro).
import React, { useState, useEffect, useCallback } from 'react'
import Head from 'next/head'
import PortalTopBar from '../../lib/PortalTopBar'
import InventoryTabs from '../../components/InventoryTabs'
import WorkshopTabs from '../../components/WorkshopTabs'
import { requirePageAuth } from '../../lib/authServer'
import type { PortalUserSSR } from '../../lib/authServer'
import { roleHasPermission } from '../../lib/permissions'
import { T } from '../../lib/ui/theme'
import { money } from '../../lib/ui/format'
import { useConfirm } from '../../components/ui/Feedback'

const inp: React.CSSProperties = { width: '100%', boxSizing: 'border-box', background: T.bg3, border: `1px solid ${T.border2}`, color: T.text, borderRadius: 6, padding: '7px 10px', fontSize: 13, fontFamily: 'inherit', outline: 'none' }
const pBtn: React.CSSProperties = { padding: '7px 14px', borderRadius: 6, fontSize: 12, fontWeight: 600, background: T.blue, color: '#fff', border: 'none', cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' }
const gBtn: React.CSSProperties = { padding: '7px 14px', borderRadius: 6, fontSize: 12, background: 'transparent', color: T.text2, border: `1px solid ${T.border2}`, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' }
const STATUS_COLOR: Record<string, string> = { draft: T.text3, sent: T.blue, received: T.green, cancelled: T.red }
const poNum = (seq: number) => `PO-${String(seq).padStart(4, '0')}`

function Overlay({ children, onClose, wide }: { children: React.ReactNode; onClose: () => void; wide?: boolean }) {
  return (<>
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(8,10,13,0.6)' }} />
    <div onClick={e => e.stopPropagation()} style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', zIndex: 1001, width: wide ? 'min(720px,96vw)' : 'min(460px,96vw)', maxHeight: '90vh', overflowY: 'auto', background: T.bg2, border: `1px solid ${T.border2}`, borderRadius: 12, padding: 20, color: T.text }}>{children}</div>
  </>)
}

export default function PurchaseOrdersPage({ user }: { user: PortalUserSSR }) {
  const canEdit = roleHasPermission(user.role, 'edit:bookings')
  const [pos, setPos] = useState<any[]>([])
  const [suppliers, setSuppliers] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [openId, setOpenId] = useState<string | null>(null)
  const [showSuppliers, setShowSuppliers] = useState(false)
  const [msg, setMsg] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [p, s] = await Promise.all([fetch('/api/workshop/purchase-orders').then(r => r.json()), fetch('/api/workshop/suppliers').then(r => r.json())])
      setPos(p.purchaseOrders || []); setSuppliers(s.suppliers || [])
    } catch { /* keep */ } finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])

  async function newPo() {
    const r = await fetch('/api/workshop/purchase-orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lines: [] }) })
    const d = await r.json(); if (r.ok) { await load(); setOpenId(d.id) }
  }
  async function generateLowStock() {
    setMsg('Scanning inventory…')
    const r = await fetch('/api/workshop/purchase-orders/generate-low-stock', { method: 'POST' })
    const d = await r.json()
    setMsg(r.ok ? (d.created ? `Created ${d.created} draft PO(s) from low stock.` : (d.message || 'Nothing low.')) : (d.error || 'Failed'))
    load()
  }

  return (
    <>
      <Head><title>Purchase Orders — Workshop · JA Portal</title></Head>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: T.bg, color: T.text, fontFamily: '"DM Sans", system-ui, sans-serif' }}>
        <PortalTopBar activeId="diary" currentUserRole={user.role} currentUserVisibleTabs={user.visibleTabs} currentUserName={user.displayName} currentUserEmail={user.email} />
        <WorkshopTabs active="inventory" role={user.role} />
        <InventoryTabs active="po" role={user.role} />
        <div style={{ flex: 1, overflowY: 'auto' }}>
          <div style={{ maxWidth: 1000, margin: '0 auto', padding: '18px 22px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
              <h1 style={{ fontSize: 19, fontWeight: 600, margin: 0 }}>Purchase Orders</h1>
              <span style={{ flex: 1 }} />
              {loading && <span style={{ color: T.text3, fontSize: 12, fontStyle: 'italic' }}>Loading…</span>}
              {canEdit && <button onClick={() => setShowSuppliers(true)} style={gBtn}>Suppliers</button>}
              {canEdit && <button onClick={generateLowStock} style={gBtn}>⤓ Generate from low stock</button>}
              {canEdit && <button onClick={newPo} style={pBtn}>+ New PO</button>}
            </div>
            {msg && <div style={{ fontSize: 12, color: T.teal, marginBottom: 10 }}>{msg}</div>}

            <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 10, overflow: 'hidden' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '90px 1.6fr 100px 110px 110px', gap: 10, padding: '9px 14px', background: T.bg3, fontSize: 10, color: T.text3, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                <div>PO</div><div>Supplier</div><div>Status</div><div style={{ textAlign: 'right' }}>Total</div><div style={{ textAlign: 'right' }}>Date</div>
              </div>
              {pos.map(p => (
                <div key={p.id} onClick={() => setOpenId(p.id)} style={{ display: 'grid', gridTemplateColumns: '90px 1.6fr 100px 110px 110px', gap: 10, padding: '11px 14px', borderTop: `1px solid ${T.border}`, fontSize: 13, cursor: 'pointer', alignItems: 'center' }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'rgba(var(--t-ink),0.03)')} onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                  <div style={{ fontFamily: 'monospace', color: T.text2 }}>{poNum(p.po_seq)}</div>
                  <div>{p.supplier_name || '—'}{p.source === 'low_stock' && <span style={{ fontSize: 9, color: T.amber, marginLeft: 6 }}>LOW STOCK</span>}{p.myob_bill_uid && <span style={{ fontSize: 9, color: T.green, marginLeft: 6 }}>MYOB ✓</span>}</div>
                  <div><span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 10, background: `${STATUS_COLOR[p.status]}22`, color: STATUS_COLOR[p.status], textTransform: 'capitalize' }}>{p.status}</span></div>
                  <div style={{ textAlign: 'right', fontFamily: 'monospace' }}>{money(p.total_inc)}</div>
                  <div style={{ textAlign: 'right', fontSize: 11, color: T.text3 }}>{new Date(p.created_at).toLocaleDateString('en-AU', { day: '2-digit', month: 'short' })}</div>
                </div>
              ))}
              {!loading && pos.length === 0 && <div style={{ padding: 24, textAlign: 'center', color: T.text3, fontSize: 13 }}>No purchase orders yet.</div>}
            </div>
          </div>
        </div>
      </div>
      {openId && <PoEditor id={openId} canEdit={canEdit} suppliers={suppliers} onClose={() => setOpenId(null)} onChanged={load} />}
      {showSuppliers && <SuppliersModal suppliers={suppliers} canEdit={canEdit} onClose={() => setShowSuppliers(false)} onChanged={load} />}
    </>
  )
}

function PoEditor({ id, canEdit, suppliers, onClose, onChanged }: { id: string; canEdit: boolean; suppliers: any[]; onClose: () => void; onChanged: () => void }) {
  const [po, setPo] = useState<any>(null)
  const [lines, setLines] = useState<any[]>([])
  const [supplierId, setSupplierId] = useState('')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false); const [msg, setMsg] = useState('')
  const confirmDialog = useConfirm()

  const load = useCallback(async () => {
    const r = await fetch(`/api/workshop/purchase-orders/${id}`); const d = await r.json()
    if (r.ok) { setPo(d.po); setLines(d.lines || []); setSupplierId(d.po.supplier_id || ''); setNotes(d.po.notes || '') }
  }, [id])
  useEffect(() => { load() }, [load])

  const editable = po && ['draft', 'sent'].includes(po.status) && canEdit
  const subtotal = lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.unit_cost_ex_gst) || 0), 0)
  function setLine(i: number, patch: any) { setLines(prev => prev.map((l, idx) => idx === i ? { ...l, ...patch } : l)) }
  function addLine() { setLines(prev => [...prev, { name: '', sku: '', qty: 1, unit_cost_ex_gst: 0 }]) }
  function rmLine(i: number) { setLines(prev => prev.filter((_, idx) => idx !== i)) }

  async function save(extra?: any) {
    setBusy(true); setMsg('')
    try {
      const body: any = { supplier_id: supplierId || null, supplier_name: suppliers.find(s => s.id === supplierId)?.name || null, notes, lines: lines.map(l => ({ name: l.name, sku: l.sku, qty: Number(l.qty) || 0, unit_cost_ex_gst: Number(l.unit_cost_ex_gst) || 0, inventory_id: l.inventory_id || null, myob_item_uid: l.myob_item_uid || null })), ...extra }
      const r = await fetch(`/api/workshop/purchase-orders/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const d = await r.json()
      if (!r.ok) { setMsg(d.error || 'Failed'); return }
      if (d.myobPush) setMsg(d.myobPush.ok ? `Received — MYOB bill created${d.myobPush.number ? ` (${d.myobPush.number})` : ''}.` : `Received locally. MYOB: ${d.myobPush.error}`)
      else setMsg('Saved.')
      await load(); onChanged()
    } finally { setBusy(false) }
  }
  async function remove() { if (!(await confirmDialog({ title: 'Delete this PO?', danger: true }))) return; await fetch(`/api/workshop/purchase-orders/${id}`, { method: 'DELETE' }); onChanged(); onClose() }

  if (!po) return <Overlay onClose={onClose}><div style={{ color: T.text3 }}>Loading…</div></Overlay>
  return (
    <Overlay onClose={onClose} wide>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <h2 style={{ fontSize: 17, fontWeight: 600, margin: 0, flex: 1 }}>{poNum(po.po_seq)}</h2>
        <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 10, background: `${STATUS_COLOR[po.status]}22`, color: STATUS_COLOR[po.status], textTransform: 'capitalize' }}>{po.status}</span>
        <button onClick={onClose} style={{ background: 'none', border: 'none', color: T.text3, fontSize: 16, cursor: 'pointer' }}>✕</button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
        <div><div style={{ fontSize: 10, color: T.text3, marginBottom: 4 }}>Supplier</div>
          <select value={supplierId} disabled={!editable} onChange={e => setSupplierId(e.target.value)} style={inp}>
            <option value="">{po.supplier_name || '— none —'}</option>
            {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}{s.myob_supplier_uid ? ' · MYOB✓' : ''}</option>)}
          </select>
        </div>
        <div><div style={{ fontSize: 10, color: T.text3, marginBottom: 4 }}>Notes</div><input value={notes} disabled={!editable} onChange={e => setNotes(e.target.value)} style={inp} /></div>
      </div>

      <div style={{ fontSize: 10, color: T.text3, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Lines</div>
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 60px 90px 70px 24px', gap: 6, fontSize: 9, color: T.text3, marginBottom: 4, padding: '0 2px' }}>
        <div>Item</div><div>SKU</div><div style={{ textAlign: 'right' }}>Qty</div><div style={{ textAlign: 'right' }}>Unit ex</div><div style={{ textAlign: 'right' }}>Total</div><div />
      </div>
      {lines.map((l, i) => (
        <div key={i} style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 60px 90px 70px 24px', gap: 6, marginBottom: 5, alignItems: 'center' }}>
          <input value={l.name || ''} disabled={!editable} onChange={e => setLine(i, { name: e.target.value })} style={{ ...inp, padding: '5px 8px' }} />
          <input value={l.sku || ''} disabled={!editable} onChange={e => setLine(i, { sku: e.target.value })} style={{ ...inp, padding: '5px 8px' }} />
          <input type="number" value={l.qty} disabled={!editable} onChange={e => setLine(i, { qty: e.target.value })} style={{ ...inp, padding: '5px 6px', textAlign: 'right' }} />
          <input type="number" value={l.unit_cost_ex_gst} disabled={!editable} onChange={e => setLine(i, { unit_cost_ex_gst: e.target.value })} style={{ ...inp, padding: '5px 6px', textAlign: 'right' }} />
          <div style={{ textAlign: 'right', fontSize: 12, fontFamily: 'monospace', color: T.text2 }}>{money((Number(l.qty) || 0) * (Number(l.unit_cost_ex_gst) || 0))}</div>
          {editable ? <button onClick={() => rmLine(i)} style={{ background: 'none', border: 'none', color: T.red, cursor: 'pointer' }}>✕</button> : <div />}
        </div>
      ))}
      {editable && <button onClick={addLine} style={{ ...gBtn, width: '100%', padding: 7, borderStyle: 'dashed', marginTop: 4 }}>+ Add line</button>}

      <div style={{ textAlign: 'right', marginTop: 10, fontSize: 13 }}>Subtotal (ex-GST): <b style={{ fontFamily: 'monospace' }}>{money(subtotal)}</b> · inc GST <b style={{ fontFamily: 'monospace' }}>{money(subtotal * 1.1)}</b></div>
      {po.myob_write_error && <div style={{ fontSize: 11, color: T.red, marginTop: 8 }}>MYOB: {po.myob_write_error}</div>}
      {msg && <div style={{ fontSize: 12, color: msg.toLowerCase().includes('fail') || msg.toLowerCase().includes('myob:') ? T.amber : T.green, marginTop: 8 }}>{msg}</div>}

      {canEdit && (
        <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
          {po.status !== 'cancelled' && po.status !== 'received' && <button onClick={() => save()} disabled={busy} style={gBtn}>Save draft</button>}
          {po.status === 'draft' && <button onClick={() => save({ status: 'sent' })} disabled={busy} style={gBtn}>Mark sent</button>}
          {(po.status === 'draft' || po.status === 'sent') && <button onClick={() => save({ status: 'received' })} disabled={busy} style={pBtn} title="Mark received — pushes a Purchase Bill to MYOB if posting is on and the supplier/items are MYOB-linked">Receive → MYOB</button>}
          <span style={{ flex: 1 }} />
          <button onClick={remove} style={{ ...gBtn, color: T.red, borderColor: 'transparent' }}>Delete</button>
        </div>
      )}
    </Overlay>
  )
}

function SuppliersModal({ suppliers, canEdit, onClose, onChanged }: { suppliers: any[]; canEdit: boolean; onClose: () => void; onChanged: () => void }) {
  const [editing, setEditing] = useState<any>(null)
  const [busy, setBusy] = useState(false)
  const confirmDialog = useConfirm()
  function blank() { return { id: '', name: '', contact_name: '', phone: '', email: '', myob_supplier_uid: '' } }
  async function save() {
    setBusy(true)
    try {
      const body = { name: editing.name, contact_name: editing.contact_name, phone: editing.phone, email: editing.email, myob_supplier_uid: editing.myob_supplier_uid }
      if (editing.id) await fetch(`/api/workshop/suppliers/${editing.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      else await fetch('/api/workshop/suppliers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      setEditing(null); onChanged()
    } finally { setBusy(false) }
  }
  async function remove(s: any) { if (!(await confirmDialog({ title: `Delete supplier "${s.name}"?`, danger: true }))) return; await fetch(`/api/workshop/suppliers/${s.id}`, { method: 'DELETE' }); onChanged() }

  return (
    <Overlay onClose={onClose}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <h2 style={{ fontSize: 17, fontWeight: 600, margin: 0, flex: 1 }}>Suppliers</h2>
        {canEdit && !editing && <button onClick={() => setEditing(blank())} style={pBtn}>+ New</button>}
        <button onClick={onClose} style={{ background: 'none', border: 'none', color: T.text3, fontSize: 16, cursor: 'pointer' }}>✕</button>
      </div>
      {editing ? (
        <>
          <div style={{ marginBottom: 8 }}><div style={{ fontSize: 10, color: T.text3, marginBottom: 4 }}>Name</div><input autoFocus value={editing.name} onChange={e => setEditing({ ...editing, name: e.target.value })} style={inp} /></div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
            <div><div style={{ fontSize: 10, color: T.text3, marginBottom: 4 }}>Contact</div><input value={editing.contact_name} onChange={e => setEditing({ ...editing, contact_name: e.target.value })} style={inp} /></div>
            <div><div style={{ fontSize: 10, color: T.text3, marginBottom: 4 }}>Phone</div><input value={editing.phone} onChange={e => setEditing({ ...editing, phone: e.target.value })} style={inp} /></div>
            <div><div style={{ fontSize: 10, color: T.text3, marginBottom: 4 }}>Email</div><input value={editing.email} onChange={e => setEditing({ ...editing, email: e.target.value })} style={inp} /></div>
            <div><div style={{ fontSize: 10, color: T.text3, marginBottom: 4 }}>MYOB supplier UID</div><input value={editing.myob_supplier_uid} onChange={e => setEditing({ ...editing, myob_supplier_uid: e.target.value })} placeholder="for MYOB push" style={inp} /></div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button onClick={() => setEditing(null)} style={gBtn}>Cancel</button>
            <button onClick={save} disabled={busy || !editing.name?.trim()} style={pBtn}>{busy ? 'Saving…' : 'Save'}</button>
          </div>
        </>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {suppliers.map(s => (
            <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 11px', background: T.bg3, borderRadius: 8 }}>
              <div style={{ flex: 1 }}><div style={{ fontSize: 13, fontWeight: 500 }}>{s.name}{s.myob_supplier_uid && <span style={{ fontSize: 9, color: T.green, marginLeft: 6 }}>MYOB✓</span>}</div>{(s.contact_name || s.phone) && <div style={{ fontSize: 11, color: T.text3 }}>{[s.contact_name, s.phone].filter(Boolean).join(' · ')}</div>}</div>
              {canEdit && <button onClick={() => setEditing({ id: s.id, name: s.name, contact_name: s.contact_name || '', phone: s.phone || '', email: s.email || '', myob_supplier_uid: s.myob_supplier_uid || '' })} style={gBtn}>Edit</button>}
              {canEdit && <button onClick={() => remove(s)} style={{ ...gBtn, color: T.red, borderColor: 'transparent' }}>Delete</button>}
            </div>
          ))}
          {suppliers.length === 0 && <div style={{ fontSize: 13, color: T.text3, fontStyle: 'italic' }}>No suppliers yet.</div>}
        </div>
      )}
    </Overlay>
  )
}

export async function getServerSideProps(context: any) {
  return requirePageAuth(context, 'view:diary')
}
