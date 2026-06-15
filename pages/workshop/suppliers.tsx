// pages/workshop/suppliers.tsx
// Supplier manager (Inventory → Suppliers). Master-detail: supplier list on the
// left, the selected supplier's details on the right (contact, email used to
// send purchase orders, address, MYOB link, active). Talks to
// /api/workshop/suppliers (+ [id]). Edit gated edit:bookings.

import { useCallback, useEffect, useState } from 'react'
import Head from 'next/head'
import PortalTopBar from '../../lib/PortalTopBar'
import WorkshopTabs from '../../components/WorkshopTabs'
import InventoryTabs from '../../components/InventoryTabs'
import { requirePageAuth } from '../../lib/authServer'
import type { PortalUserSSR } from '../../lib/authServer'
import { roleHasPermission } from '../../lib/permissions'
import { T } from '../../components/ui'
import { useToast, useConfirm } from '../../components/ui/Feedback'

interface Supplier {
  id: string; name: string; contact_name: string | null; phone: string | null; email: string | null
  address: string | null; notes: string | null; is_active: boolean
  myob_supplier_uid: string | null; myob_supplier_name: string | null
}

const lbl: React.CSSProperties = { display: 'block', fontSize: 10, color: T.text3, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 5 }
const fld: React.CSSProperties = { width: '100%', padding: '8px 10px', background: T.bg3, border: `1px solid ${T.border}`, borderRadius: 6, color: T.text, fontSize: 13, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' }
const btn = (c: string, solid?: boolean): React.CSSProperties => ({ padding: '7px 14px', borderRadius: 6, fontSize: 12, fontFamily: 'inherit', fontWeight: 600, cursor: 'pointer', background: solid ? c : 'transparent', color: solid ? '#fff' : c, border: `1px solid ${solid ? c : c + '55'}` })

export default function SuppliersPage({ user }: { user: PortalUserSSR }) {
  const canEdit = roleHasPermission(user.role, 'edit:bookings')
  const toast = useToast()
  const confirmDialog = useConfirm()
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [loading, setLoading] = useState(true)
  const [q, setQ] = useState('')
  const [selId, setSelId] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await fetch('/api/workshop/suppliers')
      if (r.ok) setSuppliers((await r.json()).suppliers || [])
      setLastRefresh(new Date())
    } catch { /* keep prior */ } finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])
  useEffect(() => { if (!selId && suppliers.length) setSelId(suppliers[0].id) }, [suppliers, selId])

  async function patch(id: string, p: any) {
    setSuppliers(prev => prev.map(s => s.id === id ? { ...s, ...p } : s))   // optimistic
    const r = await fetch(`/api/workshop/suppliers/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) })
    if (!r.ok) { toast((await r.json()).error || 'Save failed', 'error'); await load() }
  }
  async function addSupplier() {
    const name = newName.trim(); if (!name) return
    setNewName('')
    const r = await fetch('/api/workshop/suppliers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) })
    const d = await r.json().catch(() => ({}))
    if (!r.ok) { toast(d.error || 'Add failed', 'error'); return }
    await load()
    if (d.supplier?.id) setSelId(d.supplier.id)
  }
  async function remove(s: Supplier) {
    if (!(await confirmDialog({ title: `Delete supplier “${s.name}”?`, message: 'Removes it from the supplier list. Inventory items keep their supplier name.', danger: true }))) return
    const r = await fetch(`/api/workshop/suppliers/${s.id}`, { method: 'DELETE' })
    if (!r.ok) { toast((await r.json()).error || 'Delete failed', 'error'); return }
    setSelId(null); await load()
  }

  const needle = q.trim().toLowerCase()
  const shown = needle ? suppliers.filter(s => `${s.name} ${s.contact_name || ''} ${s.email || ''}`.toLowerCase().includes(needle)) : suppliers
  const sel = suppliers.find(s => s.id === selId) || null

  return (
    <>
      <Head><title>Suppliers — Just Autos</title><meta name="viewport" content="width=device-width,initial-scale=1" /><meta name="robots" content="noindex,nofollow" /></Head>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden', fontFamily: "'DM Sans',system-ui,sans-serif", color: T.text }}>
        <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet" />
        <PortalTopBar activeId="diary" lastRefresh={lastRefresh} onRefresh={load} refreshing={loading}
          currentUserRole={user.role} currentUserVisibleTabs={user.visibleTabs} currentUserName={user.displayName} currentUserEmail={user.email} />
        <WorkshopTabs active="inventory" role={user.role} />
        <InventoryTabs active="suppliers" role={user.role} />

        <div style={{ flex: 1, overflow: 'auto', background: T.bg, padding: '20px 28px' }}>
          <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            {/* Left list */}
            <div style={{ flex: '0 0 320px', maxWidth: '100%', background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 10, padding: 14, boxSizing: 'border-box' }}>
              <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search suppliers…" style={{ ...fld, marginBottom: 10 }} />
              <div style={{ maxHeight: 540, overflowY: 'auto', margin: '0 -4px', padding: '0 4px' }}>
                {loading && suppliers.length === 0 && <div style={{ fontSize: 12, color: T.text3, padding: 8 }}>Loading…</div>}
                {shown.map(s => {
                  const on = s.id === selId
                  return (
                    <button key={s.id} onClick={() => setSelId(s.id)} style={{ display: 'block', width: '100%', textAlign: 'left', padding: '9px 11px', borderRadius: 8, marginBottom: 3, cursor: 'pointer', fontFamily: 'inherit', background: on ? `${T.accent}1f` : 'transparent', border: `1px solid ${on ? T.accent : 'transparent'}`, opacity: s.is_active ? 1 : 0.5 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: T.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</div>
                      <div style={{ fontSize: 10.5, color: T.text3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.email || s.contact_name || 'No email set'}{s.is_active ? '' : ' · inactive'}</div>
                    </button>
                  )
                })}
                {!loading && shown.length === 0 && <div style={{ fontSize: 12, color: T.text3, padding: 8 }}>{suppliers.length === 0 ? 'No suppliers yet — add one below.' : `No match for “${q}”.`}</div>}
              </div>
              {canEdit && (
                <div style={{ display: 'flex', gap: 6, marginTop: 10, paddingTop: 10, borderTop: `1px solid ${T.border}` }}>
                  <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="New supplier…" style={{ ...fld, flex: 1 }} onKeyDown={e => { if (e.key === 'Enter') addSupplier() }} />
                  <button onClick={addSupplier} style={btn(T.accent, true)}>+ Add</button>
                </div>
              )}
            </div>

            {/* Right detail */}
            <div style={{ flex: '1 1 480px', minWidth: 340, background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 10, padding: 20, boxSizing: 'border-box' }}>
              {!sel ? (
                <div style={{ padding: '50px 8px', textAlign: 'center', color: T.text3, fontSize: 13 }}>Select a supplier, or add one. Their email is used to send purchase orders.</div>
              ) : (
                <div key={sel.id}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
                    <input defaultValue={sel.name} disabled={!canEdit} onBlur={e => { const v = e.target.value.trim(); if (v && v !== sel.name) patch(sel.id, { name: v }) }} style={{ ...fld, flex: 1, fontWeight: 600, fontSize: 15 }} />
                    <label style={{ fontSize: 12, color: T.text2, display: 'flex', gap: 5, alignItems: 'center', cursor: 'pointer', whiteSpace: 'nowrap' }}><input type="checkbox" checked={sel.is_active} disabled={!canEdit} onChange={e => patch(sel.id, { is_active: e.target.checked })} />Active</label>
                    {canEdit && <button onClick={() => remove(sel)} style={btn(T.red)}>Delete</button>}
                  </div>

                  <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                    <div style={{ flex: 1, minWidth: 200 }}><div style={lbl}>Contact name</div><input defaultValue={sel.contact_name || ''} disabled={!canEdit} onBlur={e => { const v = e.target.value.trim(); if (v !== (sel.contact_name || '')) patch(sel.id, { contact_name: v || null }) }} style={fld} /></div>
                    <div style={{ flex: 1, minWidth: 160 }}><div style={lbl}>Phone</div><input defaultValue={sel.phone || ''} disabled={!canEdit} onBlur={e => { const v = e.target.value.trim(); if (v !== (sel.phone || '')) patch(sel.id, { phone: v || null }) }} style={fld} /></div>
                  </div>
                  <div style={{ marginTop: 12 }}><div style={lbl}>Email (purchase orders are sent here)</div><input type="email" defaultValue={sel.email || ''} disabled={!canEdit} onBlur={e => { const v = e.target.value.trim(); if (v !== (sel.email || '')) patch(sel.id, { email: v || null }) }} placeholder="orders@supplier.com" style={fld} /></div>
                  <div style={{ marginTop: 12 }}><div style={lbl}>Address</div><textarea defaultValue={sel.address || ''} disabled={!canEdit} rows={2} onBlur={e => { const v = e.target.value.trim(); if (v !== (sel.address || '')) patch(sel.id, { address: v || null }) }} style={{ ...fld, resize: 'vertical' }} /></div>
                  <div style={{ marginTop: 12 }}><div style={lbl}>Notes</div><textarea defaultValue={sel.notes || ''} disabled={!canEdit} rows={2} onBlur={e => { const v = e.target.value.trim(); if (v !== (sel.notes || '')) patch(sel.id, { notes: v || null }) }} style={{ ...fld, resize: 'vertical' }} /></div>

                  <div style={{ ...lbl, marginTop: 18 }}>MYOB supplier card</div>
                  <MyobLinkPicker sel={sel} canEdit={canEdit}
                    onLink={r => patch(sel.id, { myob_supplier_uid: r.uid, myob_supplier_name: r.name })}
                    onUnlink={() => patch(sel.id, { myob_supplier_uid: null, myob_supplier_name: null })} />
                  <div style={{ marginTop: 12, fontSize: 11, color: T.text3 }}>
                    Tip: set this supplier on inventory items (Inventory → click a part) so their parts group onto a PO automatically.
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

function MyobLinkPicker({ sel, canEdit, onLink, onUnlink }: {
  sel: Supplier; canEdit: boolean; onLink: (r: { uid: string; name: string }) => void; onUnlink: () => void
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [results, setResults] = useState<Array<{ uid: string; name: string; displayId: string | null }>>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
    if (!open) return
    setBusy(true); setErr('')
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/workshop/myob-suppliers?q=${encodeURIComponent(q)}`)
        const d = await r.json()
        setResults(d.suppliers || []); if (d.error) setErr(d.error)
      } catch { setErr('MYOB lookup failed') } finally { setBusy(false) }
    }, 300)
    return () => clearTimeout(t)
  }, [q, open])

  if (sel.myob_supplier_uid) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5, color: T.text }}>
        <span style={{ color: T.green }}>✓ Linked{sel.myob_supplier_name ? `: ${sel.myob_supplier_name}` : ''}</span>
        {canEdit && <button onClick={onUnlink} style={btn(T.text3)}>Unlink</button>}
      </div>
    )
  }
  if (!canEdit) return <div style={{ fontSize: 12, color: T.text3 }}>Not linked to MYOB.</div>
  if (!open) return <button onClick={() => setOpen(true)} style={btn(T.blue)}>Link to MYOB supplier…</button>
  return (
    <div>
      <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Search MYOB suppliers…" style={fld} />
      <div style={{ fontSize: 11, color: err ? T.red : T.text3, margin: '6px 0' }}>{busy ? 'Searching…' : err || `${results.length} match${results.length === 1 ? '' : 'es'}`}</div>
      <div style={{ maxHeight: 220, overflowY: 'auto', border: results.length ? `1px solid ${T.border}` : 'none', borderRadius: 6 }}>
        {results.map(r => (
          <div key={r.uid} onClick={() => { onLink(r); setOpen(false) }} style={{ padding: '8px 10px', fontSize: 12.5, cursor: 'pointer', borderBottom: `1px solid ${T.border}`, color: T.text }}>
            {r.name}{r.displayId ? <span style={{ color: T.text3, fontFamily: 'monospace', marginLeft: 6 }}>{r.displayId}</span> : null}
          </div>
        ))}
      </div>
      <button onClick={() => { setOpen(false); setQ('') }} style={{ ...btn(T.text3), marginTop: 8 }}>Cancel</button>
    </div>
  )
}

export async function getServerSideProps(context: any) {
  return requirePageAuth(context, 'view:diary')
}
