// pages/admin/b2b/distributors/[id].tsx
//
// Distributor detail page. Admin can:
//   - Edit distributor fields (name, ABN, contact info, notes)
//   - Add or remove "linked" MYOB customer cards (e.g. a Tuning sister card)
//   - Invite new users via Supabase magic link
//   - Update user role / deactivate / remove
//   - Toggle active status on the distributor itself

import { useEffect, useState } from 'react'
import Head from 'next/head'
import { useRouter } from 'next/router'
import PortalSidebar from '../../../../lib/PortalSidebar'
import { requirePageAuth } from '../../../../lib/authServer'
import type { UserRole } from '../../../../lib/permissions'

const T = {
  bg:'#0d0f12', bg2:'#131519', bg3:'#1a1d23', bg4:'#21252d',
  border:'rgba(255,255,255,0.07)', border2:'rgba(255,255,255,0.12)',
  text:'#e8eaf0', text2:'#aab0c0', text3:'#8d93a4',
  blue:'#4f8ef7', teal:'#2dd4bf', green:'#34c77b',
  amber:'#f5a623', red:'#f04e4e', purple:'#a78bfa',
}

interface Props {
  user: {
    id: string
    email: string
    displayName: string | null
    role: UserRole
    visibleTabs: string[] | null
  }
}

interface Distributor {
  id: string
  display_name: string
  abn: string | null
  myob_primary_customer_uid: string
  myob_primary_customer_display_id: string | null
  myob_linked_customer_uids: string[]
  dist_group_id: number | null
  primary_contact_email: string | null
  primary_contact_phone: string | null
  is_active: boolean
  notes: string | null
  freight_email: string | null
  invoice_email: string | null
  instructions_email: string | null
  ship_line1: string | null
  ship_line2: string | null
  ship_suburb: string | null
  ship_state: string | null
  ship_postcode: string | null
  ship_country: string | null
  bill_line1: string | null
  bill_line2: string | null
  bill_suburb: string | null
  bill_state: string | null
  bill_postcode: string | null
  bill_country: string | null
  created_at: string
}

interface DistributorUser {
  id: string
  auth_user_id: string | null
  email: string
  full_name: string | null
  role: 'owner' | 'member'
  last_login_at: string | null
  invited_at: string | null
  invited_by: string | null
  is_active: boolean
  created_at: string
}

interface MyobCustomer {
  uid: string
  display_id: string
  name: string
  is_individual: boolean
}

export default function DistributorDetailPage({ user }: Props) {
  const router = useRouter()
  const id = String(router.query.id || '')

  const [dist, setDist] = useState<Distributor | null>(null)
  const [users, setUsers] = useState<DistributorUser[]>([])
  const [distGroupName, setDistGroupName] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  async function load() {
    if (!id) return
    setLoading(true)
    try {
      const r = await fetch(`/api/b2b/admin/distributors/${id}`, { credentials: 'same-origin' })
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`)
      const j = await r.json()
      setDist(j.item)
      setUsers(j.users || [])
      setDistGroupName(j.dist_group_name || null)
      setError(null)
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [id])

  async function patchDist(p: Partial<Distributor>): Promise<void> {
    const r = await fetch(`/api/b2b/admin/distributors/${id}`, {
      method: 'PATCH',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(p),
    })
    const j = await r.json()
    if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`)
    setDist(j.item)
  }

  return (
    <>
      <Head><title>{dist?.display_name || 'Distributor'} · B2B Portal</title></Head>
      <div style={{display:'flex',minHeight:'100vh',background:T.bg,color:T.text,fontFamily:'system-ui,-apple-system,sans-serif'}}>
        <PortalSidebar
          activeId="b2b"
          currentUserRole={user.role}
          currentUserVisibleTabs={user.visibleTabs}
          currentUserName={user.displayName}
          currentUserEmail={user.email}
        />
        <main style={{flex:1,padding:'28px 32px',maxWidth:1100}}>

          {/* Header */}
          <header style={{marginBottom:18}}>
            <div style={{fontSize:12,color:T.text3,textTransform:'uppercase',letterSpacing:'0.08em',marginBottom:4}}>
              <a href="/admin/b2b" style={{color:T.text3,textDecoration:'none'}}>B2B Portal</a>
              {' / '}
              <a href="/admin/b2b/distributors" style={{color:T.text3,textDecoration:'none'}}>Distributors</a>
              {' / '}
              <span style={{color:T.text2}}>{dist?.display_name || '...'}</span>
            </div>
            <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:16,flexWrap:'wrap'}}>
              <h1 style={{fontSize:22,fontWeight:600,margin:0,letterSpacing:'-0.01em'}}>
                {dist?.display_name || 'Loading…'}
              </h1>
              {dist && (
                <div style={{display:'flex',alignItems:'center',gap:10}}>
                  <span style={{fontSize:12,color:T.text3}}>Active</span>
                  <ToggleSwitch
                    on={dist.is_active}
                    onChange={v => patchDist({ is_active: v }).catch(e => alert(e?.message || String(e)))}
                  />
                </div>
              )}
            </div>
          </header>

          {error && (
            <div style={{padding:10,background:`${T.red}15`,border:`1px solid ${T.red}40`,borderRadius:7,color:T.red,fontSize:13,marginBottom:14}}>
              {error}
            </div>
          )}

          {loading && !dist && (
            <div style={{padding:24,textAlign:'center',color:T.text3,fontSize:13}}>Loading…</div>
          )}

          {dist && (
            <>
              <DetailsSection dist={dist} onPatch={patchDist}/>
              <NotificationEmailsSection dist={dist} onPatch={patchDist}/>
              <AddressSection
                title="Shipping address"
                kind="ship"
                dist={dist}
                onPatch={patchDist}
              />
              <AddressSection
                title="Billing address"
                kind="bill"
                dist={dist}
                onPatch={patchDist}
              />
              <MyobLinksSection
                dist={dist}
                onChangeLinked={uids => patchDist({ myob_linked_customer_uids: uids }).catch(e => alert(e?.message || String(e)))}
              />
              <UsersSection
                distId={dist.id}
                users={users}
                onChange={load}
              />
              <DistGroupSection distGroupName={distGroupName} distGroupId={dist.dist_group_id}/>
            </>
          )}
        </main>
      </div>
    </>
  )
}

// ─── Details section (editable form) ───────────────────────────────────
function DetailsSection({ dist, onPatch }: { dist: Distributor; onPatch: (p: Partial<Distributor>) => Promise<void> }) {
  const [displayName, setDisplayName] = useState(dist.display_name)
  const [abn, setAbn] = useState(dist.abn || '')
  const [contactEmail, setContactEmail] = useState(dist.primary_contact_email || '')
  const [contactPhone, setContactPhone] = useState(dist.primary_contact_phone || '')
  const [notes, setNotes] = useState(dist.notes || '')
  const [savingFlash, setSavingFlash] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Sync local fields when dist changes (after PATCH)
  useEffect(() => {
    setDisplayName(dist.display_name)
    setAbn(dist.abn || '')
    setContactEmail(dist.primary_contact_email || '')
    setContactPhone(dist.primary_contact_phone || '')
    setNotes(dist.notes || '')
  }, [dist.id, dist.display_name, dist.abn, dist.primary_contact_email, dist.primary_contact_phone, dist.notes])

  async function commit(field: keyof Distributor, value: any, label: string) {
    setError(null)
    if (value === (dist as any)[field]) return  // no-op
    try {
      await onPatch({ [field]: value } as any)
      setSavingFlash(label)
      setTimeout(() => setSavingFlash(null), 1500)
    } catch (e: any) {
      setError(e?.message || String(e))
    }
  }

  return (
    <Section title="Details" flash={savingFlash}>
      {error && (
        <div style={{padding:8,background:`${T.red}15`,border:`1px solid ${T.red}40`,borderRadius:5,color:T.red,fontSize:12,marginBottom:10}}>
          {error}
        </div>
      )}
      <FormGrid>
        <FormRow label="Display name">
          <input type="text" value={displayName} onChange={e => setDisplayName(e.target.value)}
            onBlur={() => commit('display_name', displayName.trim(), 'Display name')}
            style={input}/>
        </FormRow>
        <FormRow label="ABN">
          <input type="text" value={abn} onChange={e => setAbn(e.target.value)}
            onBlur={() => commit('abn', abn.trim() || null, 'ABN')}
            placeholder="e.g. 12 345 678 901" style={input}/>
        </FormRow>
        <FormRow label="Primary contact email">
          <input type="email" value={contactEmail} onChange={e => setContactEmail(e.target.value)}
            onBlur={() => commit('primary_contact_email', contactEmail.trim().toLowerCase() || null, 'Email')}
            style={input}/>
        </FormRow>
        <FormRow label="Primary contact phone">
          <input type="tel" value={contactPhone} onChange={e => setContactPhone(e.target.value)}
            onBlur={() => commit('primary_contact_phone', contactPhone.trim() || null, 'Phone')}
            style={input}/>
        </FormRow>
      </FormGrid>
      <FormRow label="Internal notes" hint="Only visible to staff">
        <textarea rows={3} value={notes} onChange={e => setNotes(e.target.value)}
          onBlur={() => commit('notes', notes.trim() || null, 'Notes')}
          style={{...input,resize:'vertical'}}/>
      </FormRow>
      <div style={{fontSize:10,color:T.text3,marginTop:6}}>Saves automatically when you click outside a field.</div>
    </Section>
  )
}

// ─── Notification emails ───────────────────────────────────────────────
// Separate from the login email on primary_contact_email — these only
// receive outbound notifications (freight updates, invoices, instructions).
function NotificationEmailsSection({
  dist, onPatch,
}: {
  dist: Distributor
  onPatch: (p: Partial<Distributor>) => Promise<void>
}) {
  const [freight, setFreight] = useState(dist.freight_email || '')
  const [invoice, setInvoice] = useState(dist.invoice_email || '')
  const [instructions, setInstructions] = useState(dist.instructions_email || '')
  const [savingFlash, setSavingFlash] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setFreight(dist.freight_email || '')
    setInvoice(dist.invoice_email || '')
    setInstructions(dist.instructions_email || '')
  }, [dist.id, dist.freight_email, dist.invoice_email, dist.instructions_email])

  async function commit(field: keyof Distributor, raw: string, label: string) {
    setError(null)
    const value = raw.trim().toLowerCase() || null
    if (value === (dist as any)[field]) return
    try {
      await onPatch({ [field]: value } as any)
      setSavingFlash(label)
      setTimeout(() => setSavingFlash(null), 1500)
    } catch (e: any) {
      setError(e?.message || String(e))
    }
  }

  return (
    <Section title="Notification emails" subtitle="Where outbound emails go (separate from the login contact)" flash={savingFlash}>
      {error && (
        <div style={{padding:8,background:`${T.red}15`,border:`1px solid ${T.red}40`,borderRadius:5,color:T.red,fontSize:12,marginBottom:10}}>
          {error}
        </div>
      )}
      <FormGrid>
        <FormRow label="Freight / shipping" hint="Tracking + dispatch notifications">
          <input type="email" value={freight} onChange={e => setFreight(e.target.value)}
            onBlur={() => commit('freight_email', freight, 'Freight email')}
            placeholder="freight@example.com"
            style={input}/>
        </FormRow>
        <FormRow label="Invoices" hint="Invoices + credit notes">
          <input type="email" value={invoice} onChange={e => setInvoice(e.target.value)}
            onBlur={() => commit('invoice_email', invoice, 'Invoice email')}
            placeholder="accounts@example.com"
            style={input}/>
        </FormRow>
        <FormRow label="Instructions / docs" hint="Product install + use instructions">
          <input type="email" value={instructions} onChange={e => setInstructions(e.target.value)}
            onBlur={() => commit('instructions_email', instructions, 'Instructions email')}
            placeholder="warehouse@example.com"
            style={input}/>
        </FormRow>
      </FormGrid>
      <div style={{fontSize:10,color:T.text3,marginTop:6}}>Leave blank to fall back to the primary contact email.</div>
    </Section>
  )
}

// ─── Shipping / billing address ────────────────────────────────────────
type AddressKind = 'ship' | 'bill'

function AddressSection({
  title, kind, dist, onPatch,
}: {
  title: string
  kind: AddressKind
  dist: Distributor
  onPatch: (p: Partial<Distributor>) => Promise<void>
}) {
  const k = (suffix: string) => `${kind}_${suffix}` as keyof Distributor

  // Local drafts so typing doesn't fight with auto-save
  const [line1, setLine1] = useState(String(dist[k('line1')] || ''))
  const [line2, setLine2] = useState(String(dist[k('line2')] || ''))
  const [suburb, setSuburb] = useState(String(dist[k('suburb')] || ''))
  const [state, setState] = useState(String(dist[k('state')] || ''))
  const [postcode, setPostcode] = useState(String(dist[k('postcode')] || ''))
  const [country, setCountry] = useState(String(dist[k('country')] || ''))
  const [savingFlash, setSavingFlash] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Sync local fields when dist changes
  useEffect(() => {
    setLine1(String(dist[k('line1')] || ''))
    setLine2(String(dist[k('line2')] || ''))
    setSuburb(String(dist[k('suburb')] || ''))
    setState(String(dist[k('state')] || ''))
    setPostcode(String(dist[k('postcode')] || ''))
    setCountry(String(dist[k('country')] || ''))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    dist.id,
    dist[k('line1')], dist[k('line2')], dist[k('suburb')],
    dist[k('state')], dist[k('postcode')], dist[k('country')],
  ])

  async function commit(field: keyof Distributor, value: string | null, label: string) {
    setError(null)
    if (value === (dist as any)[field] || (value == null && !((dist as any)[field]))) return
    try {
      await onPatch({ [field]: value } as any)
      setSavingFlash(label)
      setTimeout(() => setSavingFlash(null), 1500)
    } catch (e: any) {
      setError(e?.message || String(e))
    }
  }

  async function copyFromShipping() {
    if (kind !== 'bill') return
    setError(null)
    try {
      await onPatch({
        bill_line1:    dist.ship_line1,
        bill_line2:    dist.ship_line2,
        bill_suburb:   dist.ship_suburb,
        bill_state:    dist.ship_state,
        bill_postcode: dist.ship_postcode,
        bill_country:  dist.ship_country,
      })
      setSavingFlash('Copied from shipping')
      setTimeout(() => setSavingFlash(null), 1500)
    } catch (e: any) {
      setError(e?.message || String(e))
    }
  }

  const empty = !line1 && !line2 && !suburb && !state && !postcode && !country

  return (
    <Section title={title} flash={savingFlash}>
      {error && (
        <div style={{padding:8,background:`${T.red}15`,border:`1px solid ${T.red}40`,borderRadius:5,color:T.red,fontSize:12,marginBottom:10}}>
          {error}
        </div>
      )}
      {kind === 'bill' && !empty && (
        <button
          onClick={copyFromShipping}
          style={{
            padding:'5px 10px',borderRadius:5,
            border:`1px solid ${T.border2}`,background:'transparent',color:T.text2,
            fontSize:11,cursor:'pointer',fontFamily:'inherit',marginBottom:12,
          }}>
          Copy from shipping
        </button>
      )}
      {kind === 'bill' && empty && (
        <button
          onClick={copyFromShipping}
          style={{
            padding:'5px 10px',borderRadius:5,
            border:`1px solid ${T.blue}`,background:`${T.blue}20`,color:T.blue,
            fontSize:11,cursor:'pointer',fontFamily:'inherit',marginBottom:12,
          }}>
          Same as shipping → copy
        </button>
      )}

      <FormRow label="Address line 1" hint="Street number + name">
        <input type="text" value={line1} onChange={e => setLine1(e.target.value)}
          onBlur={() => commit(k('line1'), line1.trim() || null, 'Line 1')}
          placeholder="e.g. 12 Industrial Ave" style={input}/>
      </FormRow>
      <FormRow label="Address line 2" hint="Unit, floor, building (optional)">
        <input type="text" value={line2} onChange={e => setLine2(e.target.value)}
          onBlur={() => commit(k('line2'), line2.trim() || null, 'Line 2')}
          style={input}/>
      </FormRow>
      <FormGrid>
        <FormRow label="Suburb / city">
          <input type="text" value={suburb} onChange={e => setSuburb(e.target.value)}
            onBlur={() => commit(k('suburb'), suburb.trim() || null, 'Suburb')}
            style={input}/>
        </FormRow>
        <FormRow label="State">
          <input type="text" value={state} onChange={e => setState(e.target.value)}
            onBlur={() => commit(k('state'), state.trim() || null, 'State')}
            placeholder="e.g. QLD" style={input}/>
        </FormRow>
        <FormRow label="Postcode">
          <input type="text" inputMode="numeric" value={postcode} onChange={e => setPostcode(e.target.value)}
            onBlur={() => commit(k('postcode'), postcode.trim() || null, 'Postcode')}
            style={input}/>
        </FormRow>
        <FormRow label="Country" hint="2-letter code, e.g. AU">
          <input type="text" value={country} onChange={e => setCountry(e.target.value.toUpperCase())}
            onBlur={() => commit(k('country'), country.trim().toUpperCase() || null, 'Country')}
            placeholder="AU" style={input}/>
        </FormRow>
      </FormGrid>
      <div style={{fontSize:10,color:T.text3,marginTop:6}}>Saves automatically when you click outside a field.</div>
    </Section>
  )
}

// ─── MYOB links section ────────────────────────────────────────────────
function MyobLinksSection({
  dist, onChangeLinked,
}: {
  dist: Distributor
  onChangeLinked: (uids: string[]) => void
}) {
  const [showAdd, setShowAdd] = useState(false)
  const [linkedDetails, setLinkedDetails] = useState<MyobCustomer[]>([])
  const [primaryDetail, setPrimaryDetail] = useState<MyobCustomer | null>(null)

  // Resolve linked UIDs to names by hitting the search endpoint with the display_id.
  // Cheap-and-cheerful: for V1 we just show UIDs if details aren't easily fetchable.
  // Better resolution can come later via a dedicated /myob/customer/[uid] endpoint.
  // For now: if we have the primary's display_id from the distributor record, we
  // already show that. Linked customers show their UID until clicked.

  useEffect(() => {
    setPrimaryDetail({
      uid: dist.myob_primary_customer_uid,
      display_id: dist.myob_primary_customer_display_id || '—',
      name: dist.display_name,
      is_individual: false,
    })
    // Linked customers — for now show as UIDs.  TODO: lookup endpoint.
    setLinkedDetails((dist.myob_linked_customer_uids || []).map(uid => ({
      uid, display_id: '', name: '(MYOB UID)', is_individual: false,
    })))
  }, [dist.id, dist.myob_primary_customer_uid, dist.myob_linked_customer_uids])

  function addLinked(c: MyobCustomer) {
    if (c.uid === dist.myob_primary_customer_uid) {
      alert('That customer is already the primary — pick a different one.')
      return
    }
    if (dist.myob_linked_customer_uids.includes(c.uid)) {
      alert('That customer is already linked.')
      return
    }
    onChangeLinked([...dist.myob_linked_customer_uids, c.uid])
    setShowAdd(false)
  }

  function removeLinked(uid: string) {
    if (!confirm('Remove this linked MYOB customer?')) return
    onChangeLinked(dist.myob_linked_customer_uids.filter(u => u !== uid))
  }

  return (
    <Section title="MYOB customers" subtitle="Primary card and any linked sister cards (e.g. Tuning)">
      {/* Primary */}
      <div style={{
        padding:'10px 12px',background:T.bg3,border:`1px solid ${T.border}`,borderRadius:7,
        display:'flex',alignItems:'center',justifyContent:'space-between',gap:12,marginBottom:8,
      }}>
        <div style={{flex:1,minWidth:0}}>
          <div style={{display:'flex',alignItems:'center',gap:8}}>
            <span style={{fontSize:9,color:T.blue,textTransform:'uppercase',letterSpacing:'0.08em',fontWeight:600}}>Primary</span>
            <span style={{fontSize:13,color:T.text}}>{primaryDetail?.name || '—'}</span>
          </div>
          <div style={{fontFamily:'monospace',fontSize:10,color:T.text3,marginTop:2}}>
            {primaryDetail?.display_id} · {primaryDetail?.uid}
          </div>
        </div>
      </div>

      {/* Linked */}
      {linkedDetails.length > 0 && linkedDetails.map(c => (
        <div key={c.uid} style={{
          padding:'10px 12px',background:T.bg3,border:`1px solid ${T.border}`,borderRadius:7,
          display:'flex',alignItems:'center',justifyContent:'space-between',gap:12,marginBottom:8,
        }}>
          <div style={{flex:1,minWidth:0}}>
            <div style={{display:'flex',alignItems:'center',gap:8}}>
              <span style={{fontSize:9,color:T.purple,textTransform:'uppercase',letterSpacing:'0.08em',fontWeight:600}}>Linked</span>
              <span style={{fontFamily:'monospace',fontSize:12,color:T.text2}}>{c.uid}</span>
            </div>
          </div>
          <button onClick={() => removeLinked(c.uid)}
            style={{padding:'4px 10px',borderRadius:5,border:`1px solid ${T.border2}`,background:'transparent',color:T.red,fontSize:10,cursor:'pointer',fontFamily:'inherit'}}>
            Remove
          </button>
        </div>
      ))}

      {!showAdd && (
        <button onClick={() => setShowAdd(true)}
          style={{
            marginTop:6,padding:'8px 14px',borderRadius:5,
            border:`1px dashed ${T.border2}`,background:'transparent',color:T.text2,
            fontSize:12,cursor:'pointer',fontFamily:'inherit',
          }}>
          + Link another MYOB customer
        </button>
      )}

      {showAdd && (
        <div style={{marginTop:10,padding:14,background:T.bg3,border:`1px solid ${T.border2}`,borderRadius:7}}>
          <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:8}}>
            <div style={{fontSize:12,color:T.text2,fontWeight:500}}>Search for a MYOB customer to link</div>
            <button onClick={() => setShowAdd(false)}
              style={{background:'transparent',border:'none',color:T.text2,fontSize:18,cursor:'pointer'}}>×</button>
          </div>
          <CustomerSearch onPick={addLinked}/>
        </div>
      )}

      <div style={{fontSize:10,color:T.text3,marginTop:10,lineHeight:1.5}}>
        Order history and reporting combine all linked customers automatically.
      </div>
    </Section>
  )
}

// ─── Users section ─────────────────────────────────────────────────────
function UsersSection({
  distId, users, onChange,
}: {
  distId: string
  users: DistributorUser[]
  onChange: () => void
}) {
  const [showInvite, setShowInvite] = useState(false)

  return (
    <Section title="Users" subtitle="People who can sign in to the distributor portal for this account">
      {users.length === 0 && !showInvite && (
        <div style={{padding:'14px 12px',color:T.text3,fontSize:13,textAlign:'center',background:T.bg3,border:`1px dashed ${T.border}`,borderRadius:7,marginBottom:10}}>
          No users yet. Invite the first one below.
        </div>
      )}

      {users.map(u => (
        <UserRow key={u.id} distId={distId} user={u} onChange={onChange}/>
      ))}

      {showInvite ? (
        <InviteForm distId={distId} onDone={() => { setShowInvite(false); onChange() }} onCancel={() => setShowInvite(false)}/>
      ) : (
        <button onClick={() => setShowInvite(true)}
          style={{
            marginTop:10,padding:'9px 16px',borderRadius:6,
            border:`1px solid ${T.blue}`,background:T.blue,color:'#fff',
            fontSize:13,fontWeight:500,cursor:'pointer',fontFamily:'inherit',
          }}>
          + Invite user
        </button>
      )}
    </Section>
  )
}

function UserRow({ distId, user, onChange }: { distId: string; user: DistributorUser; onChange: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editingRole, setEditingRole] = useState(false)

  const status = user.last_login_at ? 'logged_in' : 'invited'

  async function patch(p: Partial<DistributorUser>) {
    setBusy(true)
    setError(null)
    try {
      const r = await fetch(`/api/b2b/admin/distributors/${distId}/users/${user.id}`, {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(p),
      })
      const j = await r.json()
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`)
      onChange()
    } catch (e: any) {
      setError(e?.message || String(e))
      setTimeout(() => setError(null), 4000)
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (!confirm(`Remove ${user.email}? They'll lose access immediately.`)) return
    setBusy(true)
    setError(null)
    try {
      const r = await fetch(`/api/b2b/admin/distributors/${distId}/users/${user.id}`, {
        method: 'DELETE', credentials: 'same-origin',
      })
      const j = await r.json()
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`)
      onChange()
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{
      padding:'10px 12px',background:T.bg3,border:`1px solid ${T.border}`,borderRadius:7,
      marginBottom:6,opacity: user.is_active ? 1 : 0.55,
    }}>
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:10}}>
        <div style={{flex:1,minWidth:0}}>
          <div style={{fontSize:13,color:T.text,fontWeight:500}}>
            {user.full_name || user.email}
          </div>
          {user.full_name && (
            <div style={{fontSize:12,color:T.text3,marginTop:2}}>{user.email}</div>
          )}
        </div>

        {/* Role */}
        {editingRole ? (
          <select value={user.role} disabled={busy}
            onChange={e => { setEditingRole(false); patch({ role: e.target.value as any }) }}
            onBlur={() => setEditingRole(false)}
            autoFocus
            style={{
              background:T.bg4,border:`1px solid ${T.border2}`,color:T.text,
              borderRadius:4,padding:'4px 6px',fontSize:12,fontFamily:'inherit',cursor:'pointer',
            }}>
            <option value="owner">Owner</option>
            <option value="member">Member</option>
          </select>
        ) : (
          <button onClick={() => setEditingRole(true)}
            style={{padding:'2px 8px',borderRadius:8,fontSize:10,
              border:`1px solid ${T.border2}`,background:'transparent',color:T.text2,
              cursor:'pointer',fontFamily:'inherit',textTransform:'capitalize',
            }}>
            {user.role}
          </button>
        )}

        {/* Status pill */}
        <span style={{
          display:'inline-block',padding:'2px 8px',borderRadius:8,fontSize:10,
          background: status === 'logged_in' ? `${T.green}20` : `${T.amber}20`,
          color:      status === 'logged_in' ?  T.green       :  T.amber,
        }}>
          {status === 'logged_in' ? 'Active' : 'Invited'}
        </span>

        {/* Actions menu */}
        <button onClick={() => patch({ is_active: !user.is_active })} disabled={busy}
          title={user.is_active ? 'Deactivate' : 'Reactivate'}
          style={{padding:'4px 10px',borderRadius:5,border:`1px solid ${T.border2}`,background:'transparent',color:T.text2,fontSize:10,cursor:'pointer',fontFamily:'inherit'}}>
          {user.is_active ? 'Deactivate' : 'Reactivate'}
        </button>
        <button onClick={remove} disabled={busy}
          style={{padding:'4px 10px',borderRadius:5,border:`1px solid ${T.border2}`,background:'transparent',color:T.red,fontSize:10,cursor:'pointer',fontFamily:'inherit'}}>
          Remove
        </button>
      </div>
      {(user.invited_at || user.last_login_at) && (
        <div style={{fontSize:10,color:T.text3,marginTop:6,fontFamily:'monospace'}}>
          {user.last_login_at
            ? `Last login: ${new Date(user.last_login_at).toLocaleString('en-AU')}`
            : `Invited: ${user.invited_at ? new Date(user.invited_at).toLocaleString('en-AU') : '—'}`}
        </div>
      )}
      {error && (
        <div style={{padding:6,background:`${T.red}15`,border:`1px solid ${T.red}40`,borderRadius:5,color:T.red,fontSize:10,marginTop:6}}>
          {error}
        </div>
      )}
    </div>
  )
}

function InviteForm({ distId, onDone, onCancel }: { distId: string; onDone: () => void; onCancel: () => void }) {
  const [email, setEmail] = useState('')
  const [fullName, setFullName] = useState('')
  const [role, setRole] = useState<'owner'|'member'>('member')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function send() {
    setBusy(true)
    setError(null)
    try {
      const r = await fetch(`/api/b2b/admin/distributors/${distId}/users`, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), full_name: fullName.trim() || null, role }),
      })
      const j = await r.json()
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`)
      onDone()
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{marginTop:10,padding:14,background:T.bg3,border:`1px solid ${T.blue}40`,borderRadius:7}}>
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:10}}>
        <div style={{fontSize:12,color:T.text2,fontWeight:500}}>Invite a new user</div>
        <button onClick={onCancel} style={{background:'transparent',border:'none',color:T.text2,fontSize:18,cursor:'pointer'}}>×</button>
      </div>
      <FormGrid>
        <FormRow label="Email">
          <input type="email" value={email} onChange={e => setEmail(e.target.value)} autoFocus style={input}/>
        </FormRow>
        <FormRow label="Full name (optional)">
          <input type="text" value={fullName} onChange={e => setFullName(e.target.value)} style={input}/>
        </FormRow>
      </FormGrid>
      <FormRow label="Role">
        <select value={role} onChange={e => setRole(e.target.value as any)}
          style={{...input,cursor:'pointer'}}>
          <option value="member">Member — can browse the catalogue and place orders</option>
          <option value="owner">Owner — same as Member, plus can manage their distributor's users</option>
        </select>
      </FormRow>
      {error && (
        <div style={{padding:8,background:`${T.red}15`,border:`1px solid ${T.red}40`,borderRadius:5,color:T.red,fontSize:12,marginBottom:10}}>
          {error}
        </div>
      )}
      <div style={{display:'flex',gap:8}}>
        <button onClick={send} disabled={busy || !email.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())}
          style={{
            flex:1,padding:'8px 14px',borderRadius:6,
            border:`1px solid ${busy ? T.border2 : T.blue}`,
            background: busy ? T.bg4 : T.blue, color: busy ? T.text3 : '#fff',
            fontSize:13,fontWeight:500,cursor:busy?'wait':'pointer',fontFamily:'inherit',
          }}>
          {busy ? 'Sending invite…' : 'Send magic-link invite'}
        </button>
        <button onClick={onCancel} disabled={busy}
          style={{padding:'8px 12px',borderRadius:6,border:`1px solid ${T.border2}`,background:'transparent',color:T.text2,fontSize:12,cursor:'pointer',fontFamily:'inherit'}}>
          Cancel
        </button>
      </div>
      <div style={{fontSize:10,color:T.text3,marginTop:8,lineHeight:1.5}}>
        Sends a magic link via Supabase. They click the link → land on /b2b · no password needed.
      </div>
    </div>
  )
}

// ─── Dist group section ────────────────────────────────────────────────
function DistGroupSection({ distGroupName, distGroupId }: { distGroupName: string | null; distGroupId: number | null }) {
  return (
    <Section title="Distributor group" subtitle="Used by distributor reporting and invoice rollups">
      {distGroupId ? (
        <div style={{padding:'10px 12px',background:T.bg3,border:`1px solid ${T.border}`,borderRadius:7,fontSize:13,color:T.text2}}>
          Linked to: <strong style={{color:T.text}}>{distGroupName || distGroupId}</strong>
        </div>
      ) : (
        <div style={{padding:'10px 12px',background:T.bg3,border:`1px dashed ${T.border}`,borderRadius:7,fontSize:12,color:T.text3}}>
          Not linked. To link, edit the distributor group's members on the Groups admin page.
        </div>
      )}
    </Section>
  )
}

// ─── Re-used customer search (mirrors list page version) ───────────────
function CustomerSearch({ onPick }: { onPick: (c: MyobCustomer) => void }) {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<MyobCustomer[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const handle = setTimeout(async () => {
      setLoading(true)
      setError(null)
      try {
        const r = await fetch(`/api/b2b/admin/myob/customers?q=${encodeURIComponent(q)}&limit=15`,
          { credentials: 'same-origin' })
        const j = await r.json()
        if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`)
        setResults(j.items || [])
      } catch (e: any) {
        setError(e?.message || String(e))
        setResults([])
      } finally {
        setLoading(false)
      }
    }, 250)
    return () => clearTimeout(handle)
  }, [q])

  return (
    <div>
      <input type="text" placeholder="Search MYOB JAWS customers…"
        value={q} onChange={e => setQ(e.target.value)} autoFocus
        style={{...input, marginBottom:8}}/>
      {loading && <div style={{fontSize:12,color:T.text3,padding:'6px 4px'}}>Searching…</div>}
      {error && (
        <div style={{padding:8,background:`${T.red}15`,border:`1px solid ${T.red}40`,borderRadius:5,color:T.red,fontSize:12}}>
          {error}
        </div>
      )}
      {results.length > 0 && (
        <div style={{maxHeight:240,overflowY:'auto',display:'flex',flexDirection:'column',gap:3}}>
          {results.map(c => (
            <button key={c.uid} onClick={() => onPick(c)}
              style={{
                textAlign:'left',padding:'8px 10px',
                background:T.bg4,border:`1px solid ${T.border}`,borderRadius:5,
                color:T.text,cursor:'pointer',fontFamily:'inherit',
              }}>
              <div style={{fontSize:13,fontWeight:500}}>{c.name}</div>
              <div style={{fontFamily:'monospace',fontSize:10,color:T.text3,marginTop:2}}>{c.display_id}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Small components ──────────────────────────────────────────────────
function Section({ title, subtitle, flash, children }: { title: string; subtitle?: string; flash?: string | null; children: React.ReactNode }) {
  return (
    <section style={{
      background:T.bg2,border:`1px solid ${T.border}`,borderRadius:10,
      padding:'18px 20px',marginBottom:14,
    }}>
      <div style={{display:'flex',alignItems:'baseline',justifyContent:'space-between',marginBottom:14,gap:10}}>
        <div>
          <div style={{fontSize:13,fontWeight:600,color:T.text}}>{title}</div>
          {subtitle && <div style={{fontSize:12,color:T.text3,marginTop:2}}>{subtitle}</div>}
        </div>
        {flash && <span style={{fontSize:10,color:T.green,fontWeight:500}}>✓ {flash} saved</span>}
      </div>
      {children}
    </section>
  )
}

function FormGrid({ children }: { children: React.ReactNode }) {
  return <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12,marginBottom:0}}>{children}</div>
}

function FormRow({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div style={{marginBottom:14}}>
      <div style={{fontSize:12,color:T.text2,marginBottom:4,fontWeight:500}}>{label}</div>
      {children}
      {hint && <div style={{fontSize:10,color:T.text3,marginTop:3}}>{hint}</div>}
    </div>
  )
}

function ToggleSwitch({ on, disabled, onChange }: { on: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => !disabled && onChange(!on)}
      disabled={disabled}
      style={{
        width:36,height:20,borderRadius:10,border:'none',padding:2,
        background: on ? T.green : T.bg4,
        cursor: disabled ? 'wait' : 'pointer',
        position:'relative',transition:'background 0.15s',
        opacity: disabled ? 0.5 : 1,
      }}>
      <div style={{
        position:'absolute',top:2,left: on ? 18 : 2,
        width:16,height:16,borderRadius:'50%',
        background:'#fff',transition:'left 0.15s ease',
      }}/>
    </button>
  )
}

const input: React.CSSProperties = {
  width:'100%',
  background:T.bg3,border:`1px solid ${T.border}`,color:T.text,
  borderRadius:5,padding:'8px 11px',fontSize:13,outline:'none',fontFamily:'inherit',
}

export async function getServerSideProps(context: any) {
  return requirePageAuth(context, 'edit:b2b_distributors')
}
