// pages/admin/b2b/distributors/[id].tsx
//
// Distributor detail page. Admin can:
//   - Edit distributor fields (name, ABN, contact info, notes)
//   - Add or remove "linked" MYOB customer cards (e.g. a Tuning sister card)
//   - Invite new users via Supabase magic link
//   - Update user role / deactivate / remove
//   - Toggle active status on the distributor itself
// Restyled onto the shared Alloy kit (components/b2b/ui) 2026-08-12.

import { useEffect, useState } from 'react'
import Head from 'next/head'
import { useRouter } from 'next/router'
import PortalTopBar from '../../../../lib/PortalTopBar'
import B2BAdminTabs from '../../../../components/b2b/B2BAdminTabs'
import { requirePageAuth } from '../../../../lib/authServer'
import type { UserRole } from '../../../../lib/permissions'
import { useConfirm, useToast } from '../../../../components/ui/Feedback'
import { T, alpha } from '../../../../lib/ui/theme'
import { A, Btn, btnStyle, cardStyle, StatusPill, Banner, PageTitle, inputStyle, RADIUS } from '../../../../components/b2b/ui'

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
  checkout_enabled: boolean
  notes: string | null
  freight_email: string | null
  invoice_email: string | null
  instructions_email: string | null
  tier_id: string | null
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
  const toast = useToast()
  const confirmDialog = useConfirm()
  const id = String(router.query.id || '')

  const [dist, setDist] = useState<Distributor | null>(null)
  const [users, setUsers] = useState<DistributorUser[]>([])
  const [distGroupName, setDistGroupName] = useState<string | null>(null)
  const [tiers, setTiers] = useState<{ id: string; name: string; is_active: boolean }[]>([])
  const [linkedCustomers, setLinkedCustomers] = useState<{ uid: string; display_id: string; name: string }[]>([])
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
      setTiers(j.tiers || [])
      setLinkedCustomers(j.linked_customers || [])
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

  const [deleting, setDeleting] = useState(false)
  async function deleteDist() {
    if (!dist) return
    if (!(await confirmDialog({ title: `Delete distributor "${dist.display_name}"?`, message: "This removes its users, carts and addresses. Blocked if it has any orders (deactivate instead). This can't be undone.", danger: true }))) return
    setDeleting(true)
    try {
      const r = await fetch(`/api/b2b/admin/distributors/${id}`, { method: 'DELETE', credentials: 'same-origin' })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`)
      router.push('/admin/b2b/distributors')
    } catch (e: any) { toast(e?.message || String(e), 'error'); setDeleting(false) }
  }

  return (
    <>
      <Head><title>{dist?.display_name || 'Distributor'} · B2B Portal</title></Head>
      <div style={{display:'flex',flexDirection:'column',minHeight:'100vh',background:T.bg,color:T.text,fontFamily:'system-ui,-apple-system,sans-serif'}}>
        <PortalTopBar
          activeId="b2b"
          currentUserRole={user.role}
          currentUserVisibleTabs={user.visibleTabs}
          currentUserName={user.displayName}
          currentUserEmail={user.email}
        />
        <main className="b2b-admin-main" style={{flex:1,padding:'28px 32px',width:'100%',boxSizing:'border-box'}}>
          <B2BAdminTabs active="distributors"/>

          {/* Breadcrumb + page header */}
          <div style={{fontSize:12.5,color:T.text3,marginBottom:6}}>
            <a href="/admin/b2b" style={{color:T.text3,textDecoration:'none'}}>B2B Portal</a>
            {' / '}
            <a href="/admin/b2b/distributors" style={{color:T.text3,textDecoration:'none'}}>Distributors</a>
            {' / '}
            <span style={{color:T.text2}}>{dist?.display_name || '...'}</span>
          </div>
          <PageTitle action={dist ? (
            <div style={{display:'flex',alignItems:'center',gap:14,flexWrap:'wrap'}}>
              <div style={{display:'flex',alignItems:'center',gap:10}}>
                <span style={{fontSize:12.5,color:T.text3}}>Active</span>
                <ToggleSwitch
                  on={dist.is_active}
                  onChange={v => patchDist({ is_active: v }).catch(e => toast(e?.message || String(e), 'error'))}
                />
              </div>
              <div style={{display:'flex',alignItems:'center',gap:10}} title="Off = browse-only: they can view the catalogue and fill a cart, but can't place orders">
                <span style={{fontSize:12.5,color:T.text3}}>Checkout</span>
                <ToggleSwitch
                  on={dist.checkout_enabled !== false}
                  onChange={v => patchDist({ checkout_enabled: v }).catch(e => toast(e?.message || String(e), 'error'))}
                />
              </div>
              <button onClick={deleteDist} disabled={deleting} title="Delete distributor (blocked if it has orders)"
                className="al-press al-focus"
                style={{...btnStyle('ghost','sm'), color:A.bad, border:`1px solid ${alpha(A.bad,'55')}`, cursor:deleting?'wait':'pointer'}}>
                {deleting ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          ) : undefined}>
            {dist?.display_name || 'Loading…'}
          </PageTitle>

          {error && (
            <div style={{marginBottom:14}}>
              <Banner tone="error">{error}</Banner>
            </div>
          )}

          {loading && !dist && (
            <div style={{padding:24,textAlign:'center',color:T.text3,fontSize:13}}>Loading…</div>
          )}

          {dist && (
            <>
              <DetailsSection dist={dist} onPatch={patchDist} tiers={tiers}/>
              <NotificationEmailsSection dist={dist} onPatch={patchDist}/>
              <AddressSection
                title="Shipping address"
                kind="ship"
                dist={dist}
                onPatch={patchDist}
              />
              <DeliverySitesSection distributorId={dist.id}/>
              <AddressSection
                title="Billing address"
                kind="bill"
                dist={dist}
                onPatch={patchDist}
              />
              <MyobLinksSection
                dist={dist}
                linkedCustomers={linkedCustomers}
                onChangeLinked={uids => patchDist({ myob_linked_customer_uids: uids }).catch(e => toast(e?.message || String(e), 'error'))}
              />
              <UsersSection
                distId={dist.id}
                users={users}
                onChange={load}
              />
              <TrainingSection distId={dist.id}/>
              <DistGroupSection distGroupName={distGroupName} distGroupId={dist.dist_group_id}/>
            </>
          )}
        </main>
      </div>
    </>
  )
}

// ─── Details section (editable form) ───────────────────────────────────
function DetailsSection({
  dist, onPatch, tiers,
}: {
  dist: Distributor
  onPatch: (p: Partial<Distributor>) => Promise<void>
  tiers: { id: string; name: string; is_active: boolean }[]
}) {
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
        <div style={{marginBottom:10}}>
          <Banner tone="error">{error}</Banner>
        </div>
      )}
      <FormGrid>
        <FormRow label="Display name">
          <input type="text" value={displayName} onChange={e => setDisplayName(e.target.value)}
            onBlur={() => commit('display_name', displayName.trim(), 'Display name')}
            style={inputStyle()}/>
        </FormRow>
        <FormRow label="ABN">
          <input type="text" value={abn} onChange={e => setAbn(e.target.value)}
            onBlur={() => commit('abn', abn.trim() || null, 'ABN')}
            placeholder="e.g. 12 345 678 901" style={inputStyle()}/>
        </FormRow>
        <FormRow label="Primary contact email">
          <input type="email" value={contactEmail} onChange={e => setContactEmail(e.target.value)}
            onBlur={() => commit('primary_contact_email', contactEmail.trim().toLowerCase() || null, 'Email')}
            style={inputStyle()}/>
        </FormRow>
        <FormRow label="Primary contact phone">
          <input type="tel" value={contactPhone} onChange={e => setContactPhone(e.target.value)}
            onBlur={() => commit('primary_contact_phone', contactPhone.trim() || null, 'Phone')}
            style={inputStyle()}/>
        </FormRow>
      </FormGrid>
      <FormRow label="Tier" hint="Pricing / access tier — manage tier list under B2B Settings">
        <select
          value={dist.tier_id || ''}
          onChange={e => commit('tier_id', e.target.value || null, 'Tier')}
          style={{...inputStyle(), cursor:'pointer'}}>
          <option value="">— No tier —</option>
          {tiers
            .filter(t => t.is_active || t.id === dist.tier_id)
            .map(t => (
              <option key={t.id} value={t.id}>
                {t.name}{!t.is_active ? ' (inactive)' : ''}
              </option>
            ))}
        </select>
      </FormRow>
      <FormRow label="Internal notes" hint="Only visible to staff">
        <textarea rows={3} value={notes} onChange={e => setNotes(e.target.value)}
          onBlur={() => commit('notes', notes.trim() || null, 'Notes')}
          style={{...inputStyle(),resize:'vertical',minHeight:0}}/>
      </FormRow>
      <div style={{fontSize:12,color:T.text3,marginTop:6}}>Saves automatically when you click outside a field.</div>
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
        <div style={{marginBottom:10}}>
          <Banner tone="error">{error}</Banner>
        </div>
      )}
      <FormGrid>
        <FormRow label="Freight / shipping" hint="Tracking + dispatch notifications">
          <input type="email" value={freight} onChange={e => setFreight(e.target.value)}
            onBlur={() => commit('freight_email', freight, 'Freight email')}
            placeholder="freight@example.com"
            style={inputStyle()}/>
        </FormRow>
        <FormRow label="Invoices" hint="Invoices + credit notes">
          <input type="email" value={invoice} onChange={e => setInvoice(e.target.value)}
            onBlur={() => commit('invoice_email', invoice, 'Invoice email')}
            placeholder="accounts@example.com"
            style={inputStyle()}/>
        </FormRow>
        <FormRow label="Instructions / docs" hint="Product install + use instructions">
          <input type="email" value={instructions} onChange={e => setInstructions(e.target.value)}
            onBlur={() => commit('instructions_email', instructions, 'Instructions email')}
            placeholder="warehouse@example.com"
            style={inputStyle()}/>
        </FormRow>
      </FormGrid>
      <div style={{fontSize:12,color:T.text3,marginTop:6}}>Leave blank to fall back to the primary contact email.</div>
    </Section>
  )
}

// ─── Extra delivery sites (migration 204) ──────────────────────────────
// A distributor running several stores under ONE entity — same ABN, bank
// account and MYOB card — needs the goods sent to whichever branch ordered
// them. Staff-managed on purpose: where a distributor's goods may be sent is a
// credit decision, and their portal only SELECTS from this list.
//
// The distributor's own ship_* address above stays the fallback for anything
// predating this, and was backfilled here as the default site.
interface DeliverySite {
  id: string; label: string
  line1: string | null; line2: string | null
  suburb: string | null; state: string | null; postcode: string | null
  contact_name: string | null; contact_phone: string | null
  is_default: boolean; is_active: boolean; sort_order: number
}

const SITE_FIELDS: Array<[keyof SiteDraft, string]> = [
  ['label', 'Site name (what they pick)'],
  ['line1', 'Address line 1'],
  ['line2', 'Address line 2'],
  ['suburb', 'Suburb'],
  ['state', 'State'],
  ['postcode', 'Postcode — freight is priced on this'],
  ['contact_name', 'Contact at this site'],
  ['contact_phone', 'Phone the carrier should ring'],
]

interface SiteDraft {
  label: string; line1: string; line2: string; suburb: string
  state: string; postcode: string; contact_name: string; contact_phone: string
}
const EMPTY_SITE: SiteDraft = { label: '', line1: '', line2: '', suburb: '', state: '', postcode: '', contact_name: '', contact_phone: '' }

function DeliverySitesSection({ distributorId }: { distributorId: string }) {
  const toast = useToast()
  const confirmDialog = useConfirm()
  const [sites, setSites] = useState<DeliverySite[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  // The id being edited in place. Add and edit share one draft, so only one
  // of them can be open at a time - two half-filled forms on the same card is
  // how you save the wrong address to the wrong site.
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState<SiteDraft>(EMPTY_SITE)

  const base = `/api/b2b/admin/distributors/${distributorId}/addresses`

  async function load() {
    try {
      const r = await fetch(base, { credentials: 'same-origin' })
      const j = await r.json()
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`)
      setSites(j.addresses || [])
    } catch (e: any) { setError(e?.message || String(e)) }
  }
  useEffect(() => { void load() }, [distributorId])

  async function call(method: 'POST' | 'PATCH' | 'DELETE', body?: any, query = ''): Promise<boolean> {
    setBusy(true); setError(null)
    try {
      const r = await fetch(base + query, {
        method, credentials: 'same-origin',
        ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
      })
      const j = await r.json()
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`)
      await load()
      return true
    } catch (e: any) { setError(e?.message || String(e)); return false }
    finally { setBusy(false) }
  }

  const active = (sites || []).filter(s => s.is_active)

  return (
    <Section
      title="Delivery sites"
      subtitle={active.length > 1
        ? `${active.length} sites — the distributor picks one at checkout and freight is quoted to it`
        : 'One site. Add another for a distributor running more than one store under the same entity.'}>
      {error && <div style={{marginBottom:10}}><Banner tone="error" onDismiss={() => setError(null)}>{error}</Banner></div>}
      {sites === null && <div style={{fontSize:12.5,color:T.text3}}>Loading…</div>}

      {(sites || []).map(s => (
        <div key={s.id} style={{
          display:'flex', alignItems:'flex-start', gap:10, padding:'9px 0',
          borderBottom:`1px solid ${T.border}`, opacity: s.is_active ? 1 : 0.5,
        }}>
          <div style={{flex:1, minWidth:0}}>
            {editingId === s.id ? (
              <div style={{display:'flex', flexDirection:'column', gap:8}}>
                <div style={{display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(160px,1fr))', gap:8}}>
                  {SITE_FIELDS.map(([k, ph]) => (
                    <input key={k} placeholder={ph} value={draft[k]}
                      onChange={e => setDraft(d => ({ ...d, [k]: e.target.value }))}
                      className="al-focus" style={inputStyle()}/>
                  ))}
                </div>
                <div style={{display:'flex', gap:8, flexWrap:'wrap'}}>
                  <Btn size="sm" disabled={busy || !draft.label.trim() || !draft.postcode.trim()}
                    onClick={async () => {
                      if (await call('PATCH', { address_id: s.id, ...draft })) {
                        toast(`${draft.label.trim()} saved`, 'success')
                        setEditingId(null); setDraft(EMPTY_SITE)
                      }
                    }}>
                    {busy ? 'Saving…' : 'Save changes'}
                  </Btn>
                  <Btn variant="ghost" size="sm"
                    onClick={() => { setEditingId(null); setDraft(EMPTY_SITE) }}>Cancel</Btn>
                  {s.is_default && (
                    <span style={{fontSize:12, color:T.text3, alignSelf:'center'}}>
                      This is the default site — the postcode here is what freight quotes against by default.
                    </span>
                  )}
                </div>
              </div>
            ) : (
              <>
                <div style={{fontSize:13.5, fontWeight:650, display:'flex', alignItems:'center', gap:7, flexWrap:'wrap'}}>
                  {s.label}
                  {s.is_default && <StatusPill color={A.good}>Default</StatusPill>}
                  {!s.is_active && <StatusPill color={T.text3}>Removed</StatusPill>}
                </div>
                <div style={{fontSize:12.5, color:T.text2, marginTop:2}}>
                  {[s.line1, s.line2, [s.suburb, s.state, s.postcode].filter(Boolean).join(' ')].filter(Boolean).join(', ') || '—'}
                </div>
                {(s.contact_name || s.contact_phone) && (
                  <div style={{fontSize:12, color:T.text3, marginTop:2}}>
                    {[s.contact_name, s.contact_phone].filter(Boolean).join(' · ')}
                  </div>
                )}
              </>
            )}
          </div>
          {s.is_active && editingId !== s.id && (
            <div style={{display:'flex', gap:6, flexShrink:0}}>
              <Btn variant="ghost" size="sm" disabled={busy}
                onClick={() => {
                  setEditingId(s.id)
                  setDraft({
                    label: s.label || '', line1: s.line1 || '', line2: s.line2 || '',
                    suburb: s.suburb || '', state: s.state || '', postcode: s.postcode || '',
                    contact_name: s.contact_name || '', contact_phone: s.contact_phone || '',
                  })
                  setAdding(false)
                }}>
                Edit
              </Btn>
              {!s.is_default && (
                <Btn variant="ghost" size="sm" disabled={busy}
                  onClick={() => { void call('PATCH', { address_id: s.id, is_default: true }) }}>
                  Make default
                </Btn>
              )}
              <Btn variant="ghost" size="sm" disabled={busy}
                onClick={async () => {
                  const ok = await confirmDialog({
                    title: `Remove ${s.label}?`,
                    message: 'It stops being selectable at checkout. Past orders keep the address they were shipped to.',
                    danger: true,
                  })
                  if (!ok) return
                  if (await call('DELETE', undefined, `?address_id=${encodeURIComponent(s.id)}`)) toast('Site removed', 'success')
                }}>
                Remove
              </Btn>
            </div>
          )}
        </div>
      ))}

      {!adding ? (
        <div style={{marginTop:12}}>
          <Btn variant="secondary" size="sm"
            onClick={() => { setEditingId(null); setDraft(EMPTY_SITE); setAdding(true) }}>
            Add a delivery site
          </Btn>
        </div>
      ) : (
        <div style={{marginTop:12, display:'flex', flexDirection:'column', gap:8}}>
          <div style={{display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(160px,1fr))', gap:8}}>
            {SITE_FIELDS.map(([k, ph]) => (
              <input key={k} placeholder={ph} value={draft[k]}
                onChange={e => setDraft(d => ({ ...d, [k]: e.target.value }))}
                className="al-focus" style={inputStyle()}/>
            ))}
          </div>
          <div style={{display:'flex', gap:8}}>
            <Btn size="sm" disabled={busy || !draft.label.trim() || !draft.postcode.trim()}
              onClick={async () => {
                const label = draft.label.trim()
                if (await call('POST', draft)) {
                  toast(`${label} added`, 'success')
                  setDraft(EMPTY_SITE)
                  setAdding(false)
                }
              }}>
              {busy ? 'Saving…' : 'Add site'}
            </Btn>
            <Btn variant="ghost" size="sm" onClick={() => { setDraft(EMPTY_SITE); setAdding(false) }}>Cancel</Btn>
          </div>
        </div>
      )}
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
        <div style={{marginBottom:10}}>
          <Banner tone="error">{error}</Banner>
        </div>
      )}
      {kind === 'bill' && !empty && (
        <div style={{marginBottom:12}}>
          <Btn variant="ghost" size="sm" onClick={copyFromShipping}>
            Copy from shipping
          </Btn>
        </div>
      )}
      {kind === 'bill' && empty && (
        <button
          onClick={copyFromShipping}
          className="al-press al-focus"
          style={{...btnStyle('ghost','sm'), color:A.accent, border:`1px solid ${alpha(A.accent,'55')}`, background:alpha(A.accent,'14'), marginBottom:12}}>
          Same as shipping → copy
        </button>
      )}

      <FormRow label="Address line 1" hint="Street number + name">
        <input type="text" value={line1} onChange={e => setLine1(e.target.value)}
          onBlur={() => commit(k('line1'), line1.trim() || null, 'Line 1')}
          placeholder="e.g. 12 Industrial Ave" style={inputStyle()}/>
      </FormRow>
      <FormRow label="Address line 2" hint="Unit, floor, building (optional)">
        <input type="text" value={line2} onChange={e => setLine2(e.target.value)}
          onBlur={() => commit(k('line2'), line2.trim() || null, 'Line 2')}
          style={inputStyle()}/>
      </FormRow>
      <FormGrid>
        <FormRow label="Suburb / city">
          <input type="text" value={suburb} onChange={e => setSuburb(e.target.value)}
            onBlur={() => commit(k('suburb'), suburb.trim() || null, 'Suburb')}
            style={inputStyle()}/>
        </FormRow>
        <FormRow label="State">
          <input type="text" value={state} onChange={e => setState(e.target.value)}
            onBlur={() => commit(k('state'), state.trim() || null, 'State')}
            placeholder="e.g. QLD" style={inputStyle()}/>
        </FormRow>
        <FormRow label="Postcode">
          <input type="text" inputMode="numeric" value={postcode} onChange={e => setPostcode(e.target.value)}
            onBlur={() => commit(k('postcode'), postcode.trim() || null, 'Postcode')}
            style={inputStyle()}/>
        </FormRow>
        <FormRow label="Country" hint="2-letter code, e.g. AU">
          <input type="text" value={country} onChange={e => setCountry(e.target.value.toUpperCase())}
            onBlur={() => commit(k('country'), country.trim().toUpperCase() || null, 'Country')}
            placeholder="AU" style={inputStyle()}/>
        </FormRow>
      </FormGrid>
      <div style={{fontSize:12,color:T.text3,marginTop:6}}>Saves automatically when you click outside a field.</div>
    </Section>
  )
}

// ─── MYOB links section ────────────────────────────────────────────────
function MyobLinksSection({
  dist, linkedCustomers, onChangeLinked,
}: {
  dist: Distributor
  linkedCustomers: { uid: string; display_id: string; name: string }[]
  onChangeLinked: (uids: string[]) => void
}) {
  const toast = useToast()
  const confirmDialog = useConfirm()
  const [showAdd, setShowAdd] = useState(false)
  const [linkedDetails, setLinkedDetails] = useState<MyobCustomer[]>([])
  const [primaryDetail, setPrimaryDetail] = useState<MyobCustomer | null>(null)

  // "*None" is MYOB's placeholder for a card with no Card ID — show a dash.
  const cleanId = (v: string | null | undefined) => {
    const s = String(v ?? '').trim()
    return (s === '' || s.toLowerCase() === '*none') ? '—' : s
  }

  // Linked-card names/Card IDs are resolved live from MYOB by the detail API
  // (linkedCustomers); fall back to the raw UID if a card couldn't be read.
  useEffect(() => {
    setPrimaryDetail({
      uid: dist.myob_primary_customer_uid,
      display_id: cleanId(dist.myob_primary_customer_display_id),
      name: dist.display_name,
      is_individual: false,
    })
    const byUid = new Map(linkedCustomers.map(c => [c.uid, c]))
    setLinkedDetails((dist.myob_linked_customer_uids || []).map(uid => {
      const c = byUid.get(uid)
      return { uid, display_id: c?.display_id || '', name: c?.name || '', is_individual: false }
    }))
  }, [dist.id, dist.myob_primary_customer_uid, dist.myob_linked_customer_uids, linkedCustomers])

  function addLinked(c: MyobCustomer) {
    if (c.uid === dist.myob_primary_customer_uid) {
      toast('That customer is already the primary — pick a different one.', 'error')
      return
    }
    if (dist.myob_linked_customer_uids.includes(c.uid)) {
      toast('That customer is already linked.', 'error')
      return
    }
    onChangeLinked([...dist.myob_linked_customer_uids, c.uid])
    setShowAdd(false)
  }

  async function removeLinked(uid: string) {
    if (!(await confirmDialog({ title: 'Remove this linked MYOB customer?', danger: true }))) return
    onChangeLinked(dist.myob_linked_customer_uids.filter(u => u !== uid))
  }

  return (
    <Section title="MYOB customers" subtitle="Primary card and any linked sister cards (e.g. Tuning)">
      {/* Primary */}
      <div style={{
        padding:'10px 12px',background:T.bg3,borderRadius:RADIUS.sm,
        display:'flex',alignItems:'center',justifyContent:'space-between',gap:12,marginBottom:8,
      }}>
        <div style={{flex:1,minWidth:0}}>
          <div style={{display:'flex',alignItems:'center',gap:8}}>
            <StatusPill color={A.accent}>Primary</StatusPill>
            <span style={{fontSize:13,color:T.text}}>{primaryDetail?.name || '—'}</span>
          </div>
          <div style={{fontFamily:'monospace',fontSize:12,color:T.text3,marginTop:3}}>
            {primaryDetail?.display_id} · {primaryDetail?.uid}
          </div>
        </div>
      </div>

      {/* Linked */}
      {linkedDetails.length > 0 && linkedDetails.map(c => (
        <div key={c.uid} style={{
          padding:'10px 12px',background:T.bg3,borderRadius:RADIUS.sm,
          display:'flex',alignItems:'center',justifyContent:'space-between',gap:12,marginBottom:8,
        }}>
          <div style={{flex:1,minWidth:0}}>
            <div style={{display:'flex',alignItems:'center',gap:8}}>
              <StatusPill color={T.text2}>Linked</StatusPill>
              <span style={{fontSize:13,color:T.text}}>{c.name || '(unnamed MYOB card)'}</span>
            </div>
            <div style={{fontFamily:'monospace',fontSize:12,color:T.text3,marginTop:3}}>
              {(c.display_id && c.display_id !== '—') ? `${c.display_id} · ` : ''}{c.uid}
            </div>
          </div>
          <button onClick={() => removeLinked(c.uid)}
            className="al-press al-focus al-ghost"
            style={{...btnStyle('ghost','sm'), color:A.bad}}>
            Remove
          </button>
        </div>
      ))}

      {!showAdd && (
        <button onClick={() => setShowAdd(true)}
          className="al-press al-focus"
          style={{
            marginTop:6,padding:'8px 16px',borderRadius:RADIUS.pill,minHeight:36,
            border:`1px dashed ${T.border2}`,background:'transparent',color:T.text2,
            fontSize:12.5,fontWeight:600,cursor:'pointer',fontFamily:'inherit',
          }}>
          + Link another MYOB customer
        </button>
      )}

      {showAdd && (
        <div style={{marginTop:10,padding:14,background:T.bg3,borderRadius:RADIUS.sm}}>
          <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:8}}>
            <div style={{fontSize:12.5,color:T.text2,fontWeight:650}}>Search for a MYOB customer to link</div>
            <button onClick={() => setShowAdd(false)} aria-label="Close" className="al-press"
              style={{background:'transparent',border:'none',color:T.text2,fontSize:18,cursor:'pointer',fontFamily:'inherit'}}>×</button>
          </div>
          <CustomerSearch onPick={addLinked}/>
        </div>
      )}

      <div style={{fontSize:12,color:T.text3,marginTop:10,lineHeight:1.5}}>
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
        <div style={{padding:'14px 12px',color:T.text3,fontSize:13,textAlign:'center',background:T.bg3,border:`1px dashed ${T.border}`,borderRadius:RADIUS.sm,marginBottom:10}}>
          No users yet. Invite the first one below.
        </div>
      )}

      {users.map(u => (
        <UserRow key={u.id} distId={distId} user={u} onChange={onChange}/>
      ))}

      {showInvite ? (
        <InviteForm distId={distId} onDone={() => { setShowInvite(false); onChange() }} onCancel={() => setShowInvite(false)}/>
      ) : (
        <div style={{marginTop:10}}>
          <Btn onClick={() => setShowInvite(true)}>Invite user</Btn>
        </div>
      )}
    </Section>
  )
}

function UserRow({ distId, user, onChange }: { distId: string; user: DistributorUser; onChange: () => void }) {
  const confirmDialog = useConfirm()
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

  const [resent, setResent] = useState(false)
  async function resendInvite() {
    setBusy(true)
    setError(null)
    try {
      const r = await fetch(`/api/b2b/admin/distributors/${distId}/users/${user.id}`, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'resend_invite' }),
      })
      const j = await r.json()
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`)
      setResent(true)
      setTimeout(() => setResent(false), 5000)
      onChange()
    } catch (e: any) {
      setError(e?.message || String(e))
      setTimeout(() => setError(null), 6000)
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (!(await confirmDialog({ title: `Remove ${user.email}?`, message: "They'll lose access immediately.", danger: true }))) return
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
      padding:'10px 12px',background:T.bg3,borderRadius:RADIUS.sm,
      marginBottom:6,opacity: user.is_active ? 1 : 0.55,
    }}>
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:10,flexWrap:'wrap'}}>
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
              borderRadius:RADIUS.sm,padding:'5px 8px',fontSize:12.5,fontFamily:'inherit',cursor:'pointer',
            }}>
            <option value="owner">Owner</option>
            <option value="member">Member</option>
          </select>
        ) : (
          <button onClick={() => setEditingRole(true)}
            className="al-press al-focus"
            style={{padding:'3px 11px',borderRadius:RADIUS.pill,fontSize:12,fontWeight:600,
              border:`1px solid ${T.border2}`,background:'transparent',color:T.text2,
              cursor:'pointer',fontFamily:'inherit',textTransform:'capitalize',
            }}>
            {user.role}
          </button>
        )}

        {/* Status pill */}
        <StatusPill color={status === 'logged_in' ? A.good : A.warn}>
          {status === 'logged_in' ? 'Active' : 'Invited'}
        </StatusPill>

        {/* Actions menu */}
        {/* Deactivated user: no invite. Sending one would email a sign-up
            link for an account that cannot sign in. */}
        {status === 'invited' && user.is_active && (
          <button onClick={resendInvite} disabled={busy}
            title="Email a fresh single-use sign-up link (the original gets consumed by mail scanners sometimes)"
            className="al-press al-focus"
            style={{padding:'3px 11px',borderRadius:RADIUS.pill,border:`1px solid ${resent ? alpha(A.good,'55') : T.border2}`,background:'transparent',color:resent ? A.good : A.accent,fontSize:12,fontWeight:600,cursor:'pointer',fontFamily:'inherit',whiteSpace:'nowrap'}}>
            {resent ? '✓ Sent' : busy ? 'Sending…' : 'Resend invite'}
          </button>
        )}
        <button onClick={() => patch({ is_active: !user.is_active })} disabled={busy}
          title={user.is_active ? 'Deactivate' : 'Reactivate'}
          className="al-press al-focus"
          style={{padding:'3px 11px',borderRadius:RADIUS.pill,border:`1px solid ${T.border2}`,background:'transparent',color:T.text2,fontSize:12,fontWeight:600,cursor:'pointer',fontFamily:'inherit',whiteSpace:'nowrap'}}>
          {user.is_active ? 'Deactivate' : 'Reactivate'}
        </button>
        <button onClick={remove} disabled={busy}
          className="al-press al-focus"
          style={{padding:'3px 11px',borderRadius:RADIUS.pill,border:`1px solid ${T.border2}`,background:'transparent',color:A.bad,fontSize:12,fontWeight:600,cursor:'pointer',fontFamily:'inherit',whiteSpace:'nowrap'}}>
          Remove
        </button>
      </div>
      {(user.invited_at || user.last_login_at) && (
        <div style={{fontSize:12,color:T.text3,marginTop:6}}>
          {user.last_login_at
            ? `Last login: ${new Date(user.last_login_at).toLocaleString('en-AU')}`
            : `Invited: ${user.invited_at ? new Date(user.invited_at).toLocaleString('en-AU') : '—'}`}
        </div>
      )}
      {error && (
        <div style={{marginTop:6}}>
          <Banner tone="error">{error}</Banner>
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
    <div style={{marginTop:10,padding:14,background:T.bg3,border:`1px solid ${alpha(A.accent,'40')}`,borderRadius:RADIUS.sm}}>
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:10}}>
        <div style={{fontSize:12.5,color:T.text2,fontWeight:650}}>Invite a new user</div>
        <button onClick={onCancel} aria-label="Close" className="al-press" style={{background:'transparent',border:'none',color:T.text2,fontSize:18,cursor:'pointer',fontFamily:'inherit'}}>×</button>
      </div>
      <FormGrid>
        <FormRow label="Email">
          <input type="email" value={email} onChange={e => setEmail(e.target.value)} autoFocus style={inputStyle()}/>
        </FormRow>
        <FormRow label="Full name (optional)">
          <input type="text" value={fullName} onChange={e => setFullName(e.target.value)} style={inputStyle()}/>
        </FormRow>
      </FormGrid>
      <FormRow label="Role">
        <select value={role} onChange={e => setRole(e.target.value as any)}
          style={{...inputStyle(),cursor:'pointer'}}>
          <option value="member">Member — can browse the catalogue and place orders</option>
          <option value="owner">Owner — same as Member, plus can manage their distributor's users</option>
        </select>
      </FormRow>
      {error && (
        <div style={{marginBottom:10}}>
          <Banner tone="error">{error}</Banner>
        </div>
      )}
      <div style={{display:'flex',gap:8}}>
        <div style={{flex:1}}>
          <Btn full onClick={send} disabled={busy || !email.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())}>
            {busy ? 'Sending invite…' : 'Send magic-link invite'}
          </Btn>
        </div>
        <Btn variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Btn>
      </div>
      <div style={{fontSize:12,color:T.text3,marginTop:8,lineHeight:1.5}}>
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
        <div style={{padding:'10px 12px',background:T.bg3,borderRadius:RADIUS.sm,fontSize:13,color:T.text2}}>
          Linked to: <strong style={{color:T.text}}>{distGroupName || distGroupId}</strong>
        </div>
      ) : (
        <div style={{padding:'10px 12px',background:T.bg3,border:`1px dashed ${T.border}`,borderRadius:RADIUS.sm,fontSize:12.5,color:T.text3}}>
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
        className="al-focus"
        style={{...inputStyle(), background:T.bg4, marginBottom:8}}/>
      {loading && <div style={{fontSize:12.5,color:T.text3,padding:'6px 4px'}}>Searching…</div>}
      {error && (
        <Banner tone="error">{error}</Banner>
      )}
      {results.length > 0 && (
        <div style={{maxHeight:240,overflowY:'auto',display:'flex',flexDirection:'column',gap:3}}>
          {results.map(c => (
            <button key={c.uid} onClick={() => onPick(c)}
              className="al-press al-focus"
              style={{
                textAlign:'left',padding:'8px 10px',
                background:T.bg4,border:'1px solid transparent',borderRadius:RADIUS.sm,
                color:T.text,cursor:'pointer',fontFamily:'inherit',
              }}>
              <div style={{fontSize:13,fontWeight:500}}>{c.name}</div>
              <div style={{fontFamily:'monospace',fontSize:12,color:T.text3,marginTop:2}}>{c.display_id}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Small components ──────────────────────────────────────────────────
// ─── Training section ──────────────────────────────────────────────────
// Compact read-only view of each portal user's training results (per module).
interface TrainingRow {
  user_id: string
  user_name: string | null
  user_email: string
  user_active: boolean
  module_slug: string
  module_title: string
  pass_pct: number
  attempts: number
  passed: boolean
  best_score_pct: number | null
  passed_at: string | null
  last_attempt_at: string | null
}

function TrainingSection({ distId }: { distId: string }) {
  const [rows, setRows] = useState<TrainingRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!distId) return
    fetch(`/api/b2b/admin/distributors/${distId}/training`, { credentials: 'same-origin' })
      .then(r => r.json())
      .then(j => { if (j.error) throw new Error(j.error); setRows(j.rows || []) })
      .catch(e => setError(e?.message || String(e)))
  }, [distId])

  const fmt = (iso: string | null) =>
    iso ? new Date(iso).toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' }) : ''

  return (
    <Section title="Training" subtitle="Per-user results for courses assigned to this distributor (manage assignments under B2B → Training)">
      {error && (
        <Banner tone="error">{error}</Banner>
      )}
      {rows === null && !error && <div style={{fontSize:12.5,color:T.text3,padding:'6px 0'}}>Loading…</div>}
      {rows !== null && rows.length === 0 && (
        <div style={{fontSize:12.5,color:T.text3,padding:'6px 0'}}>No training assigned to this distributor (or no portal users). Assign courses under <a href="/admin/b2b/training" style={{color:A.accent}}>B2B → Training</a>.</div>
      )}
      {(rows || []).map(r => (
        <div key={`${r.user_id}:${r.module_slug}`} style={{
          padding:'9px 12px',background:T.bg3,borderRadius:RADIUS.sm,
          display:'flex',alignItems:'center',gap:12,flexWrap:'wrap',marginBottom:8,
          opacity: r.user_active ? 1 : 0.55,
        }}>
          <div style={{flex:1,minWidth:170}}>
            <div style={{fontSize:13,color:T.text}}>{r.user_name || r.user_email}{!r.user_active && <span style={{fontSize:12,color:T.text3}}> · inactive</span>}</div>
            <div style={{fontSize:12,color:T.text3,marginTop:1}}>{r.module_title}</div>
          </div>
          {r.passed ? (
            <span style={{fontSize:12,fontWeight:700,color:A.good,whiteSpace:'nowrap'}}>
              ✓ Passed {r.best_score_pct != null ? `${Math.round(r.best_score_pct)}%` : ''}{r.passed_at ? ` on ${fmt(r.passed_at)}` : ''}
            </span>
          ) : r.attempts > 0 ? (
            <span style={{fontSize:12,fontWeight:600,color:A.warn,whiteSpace:'nowrap'}}>
              {r.attempts} attempt{r.attempts === 1 ? '' : 's'} · best {r.best_score_pct != null ? `${Math.round(r.best_score_pct)}%` : '—'} (needs {r.pass_pct}%)
            </span>
          ) : (
            <span style={{fontSize:12,color:T.text3,whiteSpace:'nowrap'}}>never attempted</span>
          )}
          {r.attempts > 0 && r.last_attempt_at && (
            <span style={{fontSize:12,color:T.text3,whiteSpace:'nowrap'}}>last {fmt(r.last_attempt_at)}</span>
          )}
        </div>
      ))}
    </Section>
  )
}

function Section({ title, subtitle, flash, children }: { title: string; subtitle?: string; flash?: string | null; children: React.ReactNode }) {
  return (
    <section style={{...cardStyle(false),padding:'18px 20px',marginBottom:14}}>
      <div style={{display:'flex',alignItems:'baseline',justifyContent:'space-between',marginBottom:14,gap:10}}>
        <div>
          <div style={{fontSize:14,fontWeight:650,color:T.text}}>{title}</div>
          {subtitle && <div style={{fontSize:12.5,color:T.text3,marginTop:2}}>{subtitle}</div>}
        </div>
        {flash && <span style={{fontSize:12,color:A.good,fontWeight:600,whiteSpace:'nowrap'}}>✓ {flash} saved</span>}
      </div>
      {children}
    </section>
  )
}

function FormGrid({ children }: { children: React.ReactNode }) {
  return <div className="b2b-col2" style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12,marginBottom:0}}>{children}</div>
}

function FormRow({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div style={{marginBottom:14}}>
      <div style={{fontSize:12,color:T.text2,marginBottom:5,fontWeight:650}}>{label}</div>
      {children}
      {hint && <div style={{fontSize:12,color:T.text3,marginTop:4}}>{hint}</div>}
    </div>
  )
}

function ToggleSwitch({ on, disabled, onChange }: { on: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => !disabled && onChange(!on)}
      disabled={disabled}
      className="al-focus"
      style={{
        width:40,height:22,borderRadius:RADIUS.pill,border:'none',padding:2,
        background: on ? A.good : T.bg4,
        cursor: disabled ? 'wait' : 'pointer',
        position:'relative',transition:'background 0.15s',
        opacity: disabled ? 0.5 : 1,
      }}>
      <div style={{
        position:'absolute',top:2,left: on ? 20 : 2,
        width:18,height:18,borderRadius:'50%',
        background:'#fff',transition:'left 0.15s ease',
      }}/>
    </button>
  )
}

export async function getServerSideProps(context: any) {
  return requirePageAuth(context, 'edit:b2b_distributors')
}
