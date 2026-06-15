// pages/admin/b2b/suppliers.tsx
// Manage supplier logins for the B2B portal. Each supplier maps to one or more
// MYOB supplier cards (from the catalogue) and has its own login(s); when a
// supplier signs in they see only a read-only Stock Wall of those products.

import { useCallback, useEffect, useMemo, useState } from 'react'
import Head from 'next/head'
import PortalTopBar from '../../../lib/PortalTopBar'
import B2BAdminTabs from '../../../components/b2b/B2BAdminTabs'
import { requirePageAuth } from '../../../lib/authServer'
import type { UserRole } from '../../../lib/permissions'
import { roleHasPermission } from '../../../lib/permissions'
import { useToast, useConfirm } from '../../../components/ui/Feedback'

const T = {
  bg: 'var(--t-bg)', bg2: 'var(--t-bg2)', bg3: 'var(--t-bg3)', bg4: 'var(--t-bg4)',
  border: 'var(--t-border)', border2: 'var(--t-border2)',
  text: 'var(--t-text)', text2: 'var(--t-text2)', text3: 'var(--t-text3)',
  blue: '#4f8ef7', green: '#34c77b', amber: '#f5a623', red: '#f04e4e',
}
interface Supplier { id: string; name: string; myob_supplier_uids: string[]; is_active: boolean; notes: string | null; active_user_count: number; product_count: number }
interface SupUser { id: string; email: string; full_name: string | null; is_active: boolean; invited_at: string | null; last_login_at: string | null }
interface CatSupplier { uid: string; name: string; items: number }
interface Props { user: { id: string; email: string; displayName: string | null; role: UserRole; visibleTabs: string[] | null } }

const inp: React.CSSProperties = { width: '100%', padding: '8px 10px', background: T.bg3, border: `1px solid ${T.border2}`, borderRadius: 7, color: T.text, fontSize: 13, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' }
const btn = (c: string, solid?: boolean): React.CSSProperties => ({ padding: '7px 13px', borderRadius: 7, fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer', background: solid ? c : 'transparent', color: solid ? '#fff' : c, border: `1px solid ${solid ? c : c + '55'}` })
const lbl: React.CSSProperties = { fontSize: 11, color: T.text3, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', margin: '14px 0 6px' }

export default function B2BSuppliers({ user }: Props) {
  const canEdit = roleHasPermission(user.role, 'edit:b2b_distributors')
  const toast = useToast()
  const confirmDialog = useConfirm()
  const [list, setList] = useState<Supplier[]>([])
  const [catSuppliers, setCatSuppliers] = useState<CatSupplier[]>([])
  const [selId, setSelId] = useState<string | null>(null)
  const [users, setUsers] = useState<SupUser[]>([])
  const [loading, setLoading] = useState(true)
  // editable detail fields
  const [name, setName] = useState('')
  const [uids, setUids] = useState<string[]>([])
  const [notes, setNotes] = useState('')
  const [active, setActive] = useState(true)
  // create / invite
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteName, setInviteName] = useState('')

  const loadList = useCallback(async () => {
    setLoading(true)
    try {
      const [r, cs] = await Promise.all([
        fetch('/api/b2b/admin/suppliers', { credentials: 'same-origin' }).then(r => r.json()),
        fetch('/api/b2b/admin/suppliers/catalogue-suppliers', { credentials: 'same-origin' }).then(r => r.json()),
      ])
      setList(r.items || []); setCatSuppliers(cs.suppliers || [])
    } finally { setLoading(false) }
  }, [])
  useEffect(() => { loadList() }, [loadList])

  const selectSupplier = useCallback(async (id: string) => {
    setSelId(id)
    const d = await fetch(`/api/b2b/admin/suppliers/${id}`, { credentials: 'same-origin' }).then(r => r.json())
    if (d.supplier) { setName(d.supplier.name); setUids(d.supplier.myob_supplier_uids || []); setNotes(d.supplier.notes || ''); setActive(d.supplier.is_active); setUsers(d.users || []) }
  }, [])

  const selected = useMemo(() => list.find(s => s.id === selId) || null, [list, selId])
  const catName = (uid: string) => catSuppliers.find(c => c.uid === uid)?.name || uid

  async function createSupplier() {
    const n = newName.trim(); if (!n) return
    const r = await fetch('/api/b2b/admin/suppliers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: n, myob_supplier_uids: [] }) })
    const d = await r.json()
    if (r.ok) { setNewName(''); setCreating(false); await loadList(); selectSupplier(d.item.id) }
    else toast(d.error || 'Create failed', 'error')
  }
  async function saveDetail() {
    if (!selId) return
    const r = await fetch(`/api/b2b/admin/suppliers/${selId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, myob_supplier_uids: uids, notes, is_active: active }) })
    if (r.ok) { toast('Saved', 'success'); loadList() } else toast((await r.json()).error || 'Save failed', 'error')
  }
  async function invite() {
    if (!selId || !inviteEmail.trim()) return
    const r = await fetch(`/api/b2b/admin/suppliers/${selId}/users`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: inviteEmail.trim(), full_name: inviteName.trim() || null }) })
    const d = await r.json()
    if (r.ok) { toast(`Invite sent to ${inviteEmail.trim()}`, 'success'); setInviteEmail(''); setInviteName(''); selectSupplier(selId) }
    else toast(d.error || 'Invite failed', 'error')
  }
  async function toggleUser(u: SupUser) {
    if (!selId) return
    await fetch(`/api/b2b/admin/suppliers/${selId}/users`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user_id: u.id, is_active: !u.is_active }) })
    selectSupplier(selId)
  }
  async function deactivateSupplier() {
    if (!selId) return
    if (!(await confirmDialog({ title: `Deactivate "${name}"?`, message: 'Their logins will stop working. You can reactivate later.', danger: true }))) return
    await fetch(`/api/b2b/admin/suppliers/${selId}`, { method: 'DELETE' }); setActive(false); loadList()
  }

  const toggleUid = (uid: string) => setUids(p => p.includes(uid) ? p.filter(x => x !== uid) : [...p, uid])

  return (
    <>
      <Head><title>Suppliers · B2B · JA Portal</title></Head>
      <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh', background: T.bg, color: T.text, fontFamily: 'system-ui,-apple-system,sans-serif' }}>
        <PortalTopBar activeId="b2b" currentUserRole={user.role} currentUserVisibleTabs={user.visibleTabs} currentUserName={user.displayName} currentUserEmail={user.email} />
        <main className="b2b-admin-main" style={{ flex: 1, padding: '28px 32px', width: '100%', boxSizing: 'border-box' }}>
          <B2BAdminTabs active="suppliers" />

          <header style={{ marginBottom: 18, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <div>
              <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0 }}>Suppliers</h1>
              <div style={{ fontSize: 12.5, color: T.text3, marginTop: 4 }}>Give a supplier a login to watch on-hand stock of the products they make for you. They sign in at <a href="/b2b/login" style={{ color: T.blue, textDecoration: 'none' }}>/b2b/login</a> and see only their Stock Wall.</div>
            </div>
          </header>

          <div className="b2b-col2" style={{ display: 'grid', gridTemplateColumns: '300px 1fr', gap: 18, alignItems: 'start' }}>
            {/* List */}
            <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 12, overflow: 'hidden' }}>
              <div style={{ display: 'flex', alignItems: 'center', padding: '10px 12px', borderBottom: `1px solid ${T.border}` }}>
                <span style={{ fontSize: 12, fontWeight: 600 }}>{list.length} supplier{list.length === 1 ? '' : 's'}</span>
                <span style={{ flex: 1 }} />
                {canEdit && <button onClick={() => setCreating(v => !v)} style={btn(T.blue, creating)}>{creating ? 'Cancel' : '+ New'}</button>}
              </div>
              {creating && (
                <div style={{ padding: 12, borderBottom: `1px solid ${T.border}`, background: T.bg3 }}>
                  <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="Supplier name" style={inp} onKeyDown={e => { if (e.key === 'Enter') createSupplier() }} />
                  <button onClick={createSupplier} disabled={!newName.trim()} style={{ ...btn(T.blue, true), marginTop: 8, width: '100%', opacity: newName.trim() ? 1 : 0.6 }}>Create</button>
                </div>
              )}
              {loading ? <div style={{ padding: 16, color: T.text3, fontSize: 12.5 }}>Loading…</div>
                : list.length === 0 ? <div style={{ padding: 16, color: T.text3, fontSize: 12.5 }}>No suppliers yet.</div>
                : list.map(s => (
                  <button key={s.id} onClick={() => selectSupplier(s.id)} style={{ display: 'block', width: '100%', textAlign: 'left', padding: '10px 12px', border: 'none', borderBottom: `1px solid ${T.border}`, cursor: 'pointer', background: selId === s.id ? T.bg4 : 'transparent', color: T.text, fontFamily: 'inherit' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontSize: 13.5, fontWeight: 600, flex: 1 }}>{s.name}</span>
                      {!s.is_active && <span style={{ fontSize: 10, color: T.red }}>off</span>}
                    </div>
                    <div style={{ fontSize: 11, color: T.text3, marginTop: 2 }}>{s.product_count} product{s.product_count === 1 ? '' : 's'} · {s.active_user_count} login{s.active_user_count === 1 ? '' : 's'}</div>
                  </button>
                ))}
            </div>

            {/* Detail */}
            {!selected ? (
              <div style={{ background: T.bg2, border: `1px dashed ${T.border2}`, borderRadius: 12, padding: 40, textAlign: 'center', color: T.text3, fontSize: 13 }}>Select a supplier, or create one.</div>
            ) : (
              <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 12, padding: 18 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <h2 style={{ fontSize: 17, fontWeight: 600, margin: 0, flex: 1 }}>{selected.name}</h2>
                  {!active && <span style={{ fontSize: 11, color: T.red, fontWeight: 600 }}>Deactivated</span>}
                </div>

                <fieldset disabled={!canEdit} style={{ border: 'none', padding: 0, margin: 0 }}>
                  <div style={lbl}>Name</div>
                  <input value={name} onChange={e => setName(e.target.value)} style={inp} />

                  <div style={lbl}>MYOB supplier cards ({uids.length} selected)</div>
                  <div style={{ fontSize: 11.5, color: T.text3, marginBottom: 8 }}>The products on these cards are what this supplier will see.</div>
                  <div style={{ maxHeight: 220, overflowY: 'auto', border: `1px solid ${T.border}`, borderRadius: 8 }}>
                    {catSuppliers.map(cs => (
                      <label key={cs.uid} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '7px 10px', borderBottom: `1px solid ${T.border}`, cursor: canEdit ? 'pointer' : 'default', fontSize: 12.5 }}>
                        <input type="checkbox" checked={uids.includes(cs.uid)} onChange={() => toggleUid(cs.uid)} />
                        <span style={{ flex: 1 }}>{cs.name}</span>
                        <span style={{ fontSize: 11, color: T.text3, fontFamily: 'monospace' }}>{cs.items}</span>
                      </label>
                    ))}
                    {/* Any saved uid not present in the catalogue list anymore */}
                    {uids.filter(u => !catSuppliers.some(c => c.uid === u)).map(u => (
                      <label key={u} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '7px 10px', borderBottom: `1px solid ${T.border}`, fontSize: 12.5, color: T.text3 }}>
                        <input type="checkbox" checked onChange={() => toggleUid(u)} />
                        <span style={{ flex: 1 }}>{catName(u)} (no current products)</span>
                      </label>
                    ))}
                  </div>

                  <div style={lbl}>Notes</div>
                  <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} style={{ ...inp, resize: 'vertical' }} />

                  {canEdit && (
                    <div style={{ display: 'flex', gap: 8, marginTop: 14, alignItems: 'center' }}>
                      <button onClick={saveDetail} style={btn(T.blue, true)}>Save</button>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: T.text2, cursor: 'pointer' }}>
                        <input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)} /> Active
                      </label>
                      <span style={{ flex: 1 }} />
                      <button onClick={deactivateSupplier} style={btn(T.red)}>Deactivate</button>
                    </div>
                  )}
                </fieldset>

                {/* Logins */}
                <div style={{ marginTop: 22, paddingTop: 16, borderTop: `1px solid ${T.border}` }}>
                  <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Logins</div>
                  {users.length === 0 && <div style={{ fontSize: 12.5, color: T.text3, marginBottom: 10 }}>No logins yet — invite one below.</div>}
                  {users.map(u => (
                    <div key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderTop: `1px solid ${T.border}`, fontSize: 12.5 }}>
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ fontWeight: 500 }}>{u.full_name || u.email}</span>
                        {u.full_name && <span style={{ color: T.text3 }}> · {u.email}</span>}
                        <span style={{ color: T.text3, fontSize: 11 }}>{u.last_login_at ? ` · last in ${rel(u.last_login_at)}` : u.invited_at ? ' · invited, not signed in' : ''}</span>
                      </span>
                      {!u.is_active && <span style={{ fontSize: 10, color: T.red }}>disabled</span>}
                      {canEdit && <button onClick={() => toggleUser(u)} style={btn(u.is_active ? T.text2 : T.green)}>{u.is_active ? 'Disable' : 'Enable'}</button>}
                    </div>
                  ))}
                  {canEdit && (
                    <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                      <input value={inviteName} onChange={e => setInviteName(e.target.value)} placeholder="Name (optional)" style={{ ...inp, flex: '1 1 130px', width: 'auto' }} />
                      <input value={inviteEmail} onChange={e => setInviteEmail(e.target.value)} placeholder="email@supplier.com" style={{ ...inp, flex: '2 1 200px', width: 'auto' }} />
                      <button onClick={invite} disabled={!inviteEmail.trim()} style={{ ...btn(T.blue, true), opacity: inviteEmail.trim() ? 1 : 0.6 }}>Send invite</button>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </main>
      </div>
    </>
  )
}

function rel(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`
  return `${Math.floor(ms / 86_400_000)}d ago`
}

export async function getServerSideProps(context: any) {
  return requirePageAuth(context, 'view:b2b')
}
