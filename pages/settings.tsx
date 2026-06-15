// pages/settings.tsx
// Unified Settings hub. An icon launcher of tiles; tapping a tile opens that
// area in a floating window (?tab= deep-links straight into one). Sections:
//   - General             (any user)   — display/behaviour preferences
//   - Distributor Report  (admin only) — customers (groups/aliases) + revenue categories
//   - VIN Codes           (admin only) — VIN prefix → model code rules
//   - Users               (admin only) — invite, edit role, deactivate, delete
//   - Audit log           (admin only) — recent user-management events
//   - Profile             (any user)   — change own display name & password

import { useEffect, useState, useCallback } from 'react'
import Head from 'next/head'
import { useRouter } from 'next/router'
import PortalTopBar from '../lib/PortalTopBar'
import { AppIcon } from '../lib/AppIcons'
import { getSupabase } from '../lib/supabaseClient'
import { ROLE_LABELS, ROLE_DESCRIPTIONS, UserRole, roleHasPermission, PORTAL_TABS, defaultTabsForRole } from '../lib/permissions'
import { requirePageAuth } from '../lib/authServer'
import GeneralTab from '../components/settings/GeneralTab'
import DistributorTab from '../components/settings/DistributorTab'
import ConnectionsHubTab from '../components/settings/ConnectionsHubTab'
import DataImportsTab from '../components/settings/DataImportsTab'
import type { PortalUserSSR } from '../lib/authServer'
import { T } from '../lib/ui/theme'
import { SkeletonRows } from '../components/ui'
import { useToast, useConfirm } from '../components/ui/Feedback'
type SettingsTab = 'general'|'vin-codes'|'backfill'|'dist-report'|'connections'|'data-imports'|'users'|'audit'|'profile'|'workshop'|'md-imports'

export default function SettingsPage({ user }: { user: PortalUserSSR }) {
  const router = useRouter()
  const isAdmin = user.role === 'admin'

  // Read ?tab= from query string for direct linking to a tab.
  // Legacy: ?tab=groups → dist-report (Customers sub-tab).
  // Legacy: ?tab=myob   → connections (MYOB sub-tab).
  const qTab = (router.query.tab as string) || 'general'
  const initialTab: SettingsTab =
    qTab === 'general' ? 'general' :
    qTab === 'vin-codes' ? 'vin-codes' :
    qTab === 'backfill' ? 'backfill' :
    qTab === 'dist-report' ? 'dist-report' :
    qTab === 'connections' ? 'connections' :
    qTab === 'data-imports' ? 'data-imports' :
    qTab === 'users' ? 'users' :
    qTab === 'audit' ? 'audit' :
    qTab === 'profile' ? 'profile' :
    qTab === 'workshop' ? 'workshop' :
    qTab === 'groups' ? 'dist-report' :
    qTab === 'myob' ? 'connections' :
    'general'
  // null = show the tile launcher; a section id = that section's floating window is open.
  // A ?tab= deep-link opens straight into the matching window.
  const hasTabParam = !!router.query.tab
  const [openId, setOpenId] = useState<SettingsTab | null>(hasTabParam ? initialTab : null)

  // Sub-tab for the merged Distributor Report tab. ?tab=groups → 'customers'.
  const initialDistSub: 'customers' | 'categories' =
    qTab === 'groups' ? 'customers' :
    (router.query.sub === 'categories' ? 'categories' : 'customers')

  // Sub-tab for the merged Connections tab. ?tab=myob → 'myob' for backwards
  // compat; explicit ?sub=health|myob also honoured.
  const initialConnSub: 'health' | 'myob' =
    qTab === 'myob' ? 'myob' :
    (router.query.sub === 'myob' ? 'myob' : 'health')

  const SECTIONS: {id: SettingsTab; label: string; adminOnly: boolean; icon: string; accent: string; desc: string}[] = [
    { id: 'general',     label: 'General',            adminOnly: false, icon: 'settings',      accent: T.blue,   desc: 'Display & behaviour preferences' },
    { id: 'dist-report', label: 'Distributor Report', adminOnly: true,  icon: 'reports',       accent: T.green,  desc: 'Customers, groups & revenue categories' },
    { id: 'connections', label: 'Connections',        adminOnly: true,  icon: 'stripe-myob',   accent: T.teal,   desc: 'Integration health & MYOB' },
    { id: 'data-imports',label: 'Data Imports',       adminOnly: true,  icon: 'stocktake',     accent: T.purple, desc: 'Bulk imports & uploads' },
    { id: 'workshop',    label: 'Workshop',           adminOnly: true,  icon: 'diary',         accent: T.teal,   desc: 'Technicians, documents, invoicing & SMS' },
    { id: 'md-imports',  label: 'Imports',            adminOnly: true,  icon: 'stocktake',     accent: T.amber,  desc: 'Upload customers, job types, vehicles, inventory, quotes & invoices from a spreadsheet' },
    { id: 'vin-codes',   label: 'VIN Codes',          adminOnly: true,  icon: 'vehicle-sales', accent: T.amber,  desc: 'VIN prefix → model code rules' },
    { id: 'backfill',    label: 'Backfill',           adminOnly: true,  icon: 'jobs',          accent: T.teal,   desc: 'Orders ↔ quotes backfill' },
    { id: 'users',       label: 'Users & Staff',      adminOnly: true,  icon: 'team',          accent: T.blue,   desc: 'Logins, roles, tabs + workshop diary lanes' },
    { id: 'audit',       label: 'Audit Log',          adminOnly: true,  icon: 'todos',         accent: T.text2,  desc: 'Recent user-management events' },
    { id: 'profile',     label: 'My Profile',         adminOnly: false, icon: 'distributors',  accent: T.purple, desc: 'Your name & password' },
  ]
  const visibleSections = SECTIONS.filter(s => !s.adminOnly || isAdmin)
  const active = SECTIONS.find(s => s.id === openId) || null
  // Heavy sections (tables / iframes) get a wider window.
  const WIDE: SettingsTab[] = ['dist-report','connections','data-imports','vin-codes','backfill','users','workshop','md-imports']

  function openSection(t: SettingsTab) {
    setOpenId(t)
    router.replace({ pathname: '/settings', query: { tab: t } }, undefined, { shallow: true })
  }
  function closeSection() {
    setOpenId(null)
    router.replace({ pathname: '/settings' }, undefined, { shallow: true })
  }

  // Escape closes the open window.
  useEffect(() => {
    if (!openId) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeSection() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openId])

  return (
    <>
      <Head><title>Settings — Just Autos</title><meta name="robots" content="noindex,nofollow"/></Head>
      <div style={{display:'flex',flexDirection:'column',height:'100vh',overflow:'hidden',fontFamily:"'DM Sans',system-ui,sans-serif",color:T.text}}>
        <PortalTopBar activeId="settings" currentUserRole={user.role} currentUserVisibleTabs={(user as any).visibleTabs} currentUserName={(user as any).displayName} currentUserEmail={(user as any).email}/>
        <div style={{flex:1,display:'flex',flexDirection:'column',overflow:'hidden',background:T.bg}}>
          <div style={{height:52,background:T.bg2,borderBottom:`1px solid ${T.border}`,display:'flex',alignItems:'center',padding:'0 20px',gap:12,flexShrink:0}}>
            <div style={{fontSize:14,fontWeight:600}}>Settings</div>
            <span style={{fontSize:10,fontFamily:'monospace',padding:'2px 8px',borderRadius:4,background:'rgba(167,139,250,0.12)',color:T.purple,border:'1px solid rgba(167,139,250,0.2)'}}>
              {ROLE_LABELS[user.role]}
            </span>
            <div style={{flex:1}}/>
            <span style={{fontSize:11,color:T.text3}}>Signed in as {user.displayName || user.email}</span>
          </div>

          {/* Icon launcher — tap a tile to open that area in a floating window. */}
          <div style={{flex:1,overflowY:'auto',padding:'28px 20px'}}>
            <div style={{maxWidth:1000,margin:'0 auto'}}>
              <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(200px,1fr))',gap:14}}>
                {visibleSections.map(s => (
                  <button key={s.id} onClick={()=>openSection(s.id)}
                    onMouseEnter={e=>{ e.currentTarget.style.borderColor = s.accent }}
                    onMouseLeave={e=>{ e.currentTarget.style.borderColor = T.border }}
                    style={{
                      display:'flex',flexDirection:'column',gap:12,alignItems:'flex-start',
                      textAlign:'left',padding:16,borderRadius:14,
                      background:T.bg2,border:`1px solid ${T.border}`,
                      cursor:'pointer',fontFamily:'inherit',color:T.text,
                      transition:'border-color .12s',
                    }}>
                    <span style={{
                      width:46,height:46,borderRadius:12,flexShrink:0,
                      display:'flex',alignItems:'center',justifyContent:'center',
                      background:`${s.accent}1f`,color:s.accent,
                    }}>
                      <AppIcon name={s.icon} size={24}/>
                    </span>
                    <span>
                      <span style={{display:'block',fontSize:13,fontWeight:600}}>{s.label}</span>
                      <span style={{display:'block',fontSize:11,color:T.text3,marginTop:3,lineHeight:1.4}}>{s.desc}</span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Floating section window — closes only via the × button or Esc.
              The overlay itself doesn't close on click so accidental clicks
              don't kill an in-progress upload / form. */}
          {active && (
            <div style={{
              position:'fixed',inset:0,zIndex:950,
              background:'rgba(8,10,13,0.8)',backdropFilter:'blur(6px)',
              display:'flex',alignItems:'flex-start',justifyContent:'center',
              padding:'40px 20px',overflowY:'auto',
            }}>
              <div style={{
                width:'100%',maxWidth: WIDE.includes(active.id) ? 1500 : 760,
                background:T.bg2,border:`1px solid ${T.border2}`,borderRadius:14,
                display:'flex',flexDirection:'column',maxHeight:'calc(100vh - 80px)',
                boxShadow:'0 24px 60px rgba(0,0,0,0.5)',
              }}>
                <div style={{
                  display:'flex',alignItems:'center',gap:10,
                  padding:'14px 18px',borderBottom:`1px solid ${T.border}`,
                  position:'sticky',top:0,background:T.bg2,
                  borderTopLeftRadius:14,borderTopRightRadius:14,zIndex:1,flexShrink:0,
                }}>
                  <span style={{
                    width:30,height:30,borderRadius:8,flexShrink:0,
                    display:'flex',alignItems:'center',justifyContent:'center',
                    background:`${active.accent}1f`,color:active.accent,
                  }}>
                    <AppIcon name={active.icon} size={17}/>
                  </span>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontSize:14,fontWeight:600}}>{active.label}</div>
                    <div style={{fontSize:11,color:T.text3}}>{active.desc}</div>
                  </div>
                  <button onClick={closeSection} aria-label="Close"
                    style={{background:'none',border:'none',color:T.text2,fontSize:22,cursor:'pointer',lineHeight:1,padding:'0 4px'}}>×</button>
                </div>
                <div style={{padding:18,overflowY:'auto'}}>
                  {active.id === 'general'                && <GeneralTab/>}
                  {active.id === 'dist-report' && isAdmin && <DistributorTab initialSubTab={initialDistSub}/>}
                  {active.id === 'connections' && isAdmin && <ConnectionsHubTab initialSubTab={initialConnSub}/>}
                  {active.id === 'data-imports'&& isAdmin && <DataImportsTab/>}
                  {active.id === 'vin-codes'   && isAdmin && <VinCodesTab/>}
                  {active.id === 'workshop'    && isAdmin && <WorkshopSettingsEmbed/>}
                  {active.id === 'md-imports'  && isAdmin && <MdImportsEmbed/>}
                  {active.id === 'backfill'    && isAdmin && <BackfillTab/>}
                  {active.id === 'users'       && isAdmin && <UsersTab currentUser={user}/>}
                  {active.id === 'audit'       && isAdmin && <AuditTab/>}
                  {active.id === 'profile'                && <ProfileTab user={user}/>}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  )
}

// ═══════════════════════════════════════════════════════════════════
// USERS TAB
// ═══════════════════════════════════════════════════════════════════
interface UserRow {
  id: string; email: string; display_name: string | null; role: UserRole
  is_active: boolean; created_at: string; last_sign_in_at: string | null
  visible_tabs: string[] | null
  phone_extension: string | null
  webrtc_extension: string | null
  webrtc_password_set: boolean
}

interface TechRow {
  id: string; name: string; code: string; role: string | null; color: string | null
  phone_ext: string | null; daily_hours: number; show_in_diary: boolean; active: boolean; user_id: string | null
}

// One combined Users & Staff screen: every login on the left, the selected
// person's full settings (role, tabs, telephony, diary lane) on the right.
function UsersTab({ currentUser }: { currentUser: PortalUserSSR }) {
  const toast = useToast()
  const confirmDialog = useConfirm()
  const [users, setUsers] = useState<UserRow[]>([])
  const [techs, setTechs] = useState<TechRow[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [q, setQ] = useState('')
  const [sel, setSel] = useState<{ kind: 'user' | 'tech' | 'invite'; id?: string } | null>(null)
  const [newLane, setNewLane] = useState('')
  const [invite, setInvite] = useState({ email: '', displayName: '', role: 'viewer' as UserRole })
  const [inviteTabs, setInviteTabs] = useState<string[]>(() => defaultTabsForRole('viewer'))
  const [inviting, setInviting] = useState(false)

  const lbl: React.CSSProperties = { fontSize: 10, color: T.text3, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 5, fontWeight: 600 }
  const fld: React.CSSProperties = { width: '100%', background: T.bg3, border: `1px solid ${T.border}`, color: T.text, borderRadius: 5, padding: '7px 10px', fontSize: 12.5, outline: 'none', boxSizing: 'border-box', fontFamily: 'inherit' }
  const sectionLbl: React.CSSProperties = { fontSize: 10, color: T.text3, textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 700, margin: '20px 0 8px' }
  const panel: React.CSSProperties = { background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 10, padding: 14, boxSizing: 'border-box' }
  const btn = (c: string, solid?: boolean): React.CSSProperties => ({ padding: '7px 14px', borderRadius: 6, fontSize: 12, fontFamily: 'inherit', fontWeight: 600, cursor: 'pointer', background: solid ? c : 'transparent', color: solid ? '#fff' : c, border: `1px solid ${solid ? c : c + '55'}` })

  const load = useCallback(async () => {
    try {
      const [ur, tr] = await Promise.all([fetch('/api/users'), fetch('/api/workshop/technicians')])
      if (!ur.ok) throw new Error((await ur.json()).error || 'Failed to load users')
      setUsers((await ur.json()).users || [])
      if (tr.ok) setTechs((await tr.json()).technicians || [])
      setErr('')
    } catch (e: any) { setErr(e.message) } finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])

  // ── User ops ──
  async function updateUser(id: string, patch: any) {
    setUsers(prev => prev.map(u => u.id === id ? { ...u, ...patch } : u))   // optimistic
    try {
      const r = await fetch(`/api/users/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) })
      if (!r.ok) throw new Error((await r.json()).error || 'Update failed')
      await load()
    } catch (e: any) { toast(e.message, 'error'); await load() }
  }
  async function delUser(u: UserRow) {
    if (!(await confirmDialog({ title: `Permanently delete ${u.email}?`, message: 'They lose all access immediately. Their diary lane (if any) stays as history.', danger: true }))) return
    const r = await fetch(`/api/users/${u.id}`, { method: 'DELETE' })
    if (!r.ok) { toast((await r.json()).error || 'Delete failed', 'error'); return }
    setSel(null); await load()
  }
  async function resendInvite(u: UserRow) {
    const r = await fetch(`/api/users/${u.id}/resend-invite`, { method: 'POST' })
    toast(r.ok ? `Password setup email re-sent to ${u.email}.` : ((await r.json()).error || 'Resend failed'), r.ok ? 'success' : 'error')
  }
  async function handleInvite(e: React.FormEvent) {
    e.preventDefault(); setInviting(true); setErr('')
    try {
      const r = await fetch('/api/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...invite, visible_tabs: inviteTabs }) })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || 'Invite failed')
      setInvite({ email: '', displayName: '', role: 'viewer' }); setInviteTabs(defaultTabsForRole('viewer'))
      await load()
      setSel({ kind: 'user', id: d.user?.id })
      toast(`Invited ${d.user.email}. ${d.resetEmailSent ? 'Password setup email sent.' : 'Reset email failed — use Resend.'}`, d.resetEmailSent ? 'success' : 'error')
    } catch (e: any) { setErr(e.message) } finally { setInviting(false) }
  }

  // ── Diary-lane (technician) ops ──
  async function patchTech(id: string, p: any) {
    setTechs(prev => prev.map(t => t.id === id ? { ...t, ...p } : t))   // optimistic
    const r = await fetch(`/api/workshop/technicians?id=${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) })
    if (!r.ok) toast((await r.json()).error || 'Save failed', 'error')
    await load()
  }
  async function addTechForUser(u: UserRow) {
    const r = await fetch('/api/workshop/technicians', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: u.display_name || u.email, user_id: u.id, phone_ext: u.phone_extension || null }) })
    if (!r.ok) toast((await r.json()).error || 'Failed', 'error')
    await load()
  }
  async function addLaneNoLogin() {
    const name = newLane.trim(); if (!name) return
    setNewLane('')
    const r = await fetch('/api/workshop/technicians', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) })
    const d = await r.json().catch(() => ({}))
    if (!r.ok) { toast(d.error || 'Failed', 'error'); return }
    await load()
    if (d.technician?.id) setSel({ kind: 'tech', id: d.technician.id })
  }
  async function removeTech(t: TechRow) {
    if (!(await confirmDialog({ title: `Remove ${t.name} from the diary?`, message: 'With bookings it’s retired (history kept); otherwise deleted. Any portal login is unaffected.', confirmLabel: 'Remove', danger: true }))) return
    const r = await fetch(`/api/workshop/technicians?id=${encodeURIComponent(t.id)}`, { method: 'DELETE' })
    if (!r.ok) toast((await r.json()).error || 'Remove failed', 'error')
    if (sel?.kind === 'tech' && sel.id === t.id) setSel(null)
    await load()
  }

  const techByUser = new Map(techs.filter(t => t.user_id).map(t => [t.user_id as string, t]))
  const laneOnly = techs.filter(t => !t.user_id)
  const needle = q.trim().toLowerCase()
  const shownUsers = needle ? users.filter(u => `${u.display_name || ''} ${u.email} ${u.role}`.toLowerCase().includes(needle)) : users
  const selUser = sel?.kind === 'user' ? users.find(u => u.id === sel.id) || null : null
  const selUserTech = selUser ? techByUser.get(selUser.id) || null : null
  const selTech = sel?.kind === 'tech' ? techs.find(t => t.id === sel.id) || null : null

  function rowBtn(active: boolean): React.CSSProperties {
    return { display: 'block', width: '100%', textAlign: 'left', padding: '8px 10px', borderRadius: 8, marginBottom: 3, cursor: 'pointer', fontFamily: 'inherit', background: active ? `${T.blue}1f` : 'transparent', border: `1px solid ${active ? T.blue : 'transparent'}` }
  }

  // Inline tab allowlist editor (used by invite + user editor).
  function TabPicker({ role, value, onChange }: { role: UserRole; value: string[]; onChange: (next: string[]) => void }) {
    return (
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(160px,1fr))', gap: 6 }}>
        {PORTAL_TABS.map(t => {
          const roleHas = roleHasPermission(role, t.permission)
          const checked = value.includes(t.id)
          return (
            <label key={t.id} title={roleHas ? '' : `The ${ROLE_LABELS[role]} role can't access this tab.`} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '6px 9px', background: checked ? T.bg3 : 'transparent', border: `1px solid ${checked ? T.border2 : T.border}`, borderRadius: 5, cursor: roleHas ? 'pointer' : 'not-allowed', opacity: roleHas ? 1 : 0.4, fontSize: 12 }}>
              <input type="checkbox" checked={checked} disabled={!roleHas} onChange={() => onChange(value.includes(t.id) ? value.filter(x => x !== t.id) : [...value, t.id])} style={{ margin: 0 }} />
              <span style={{ color: checked ? T.text : T.text2 }}>{t.label}</span>
            </label>
          )
        })}
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
      {/* ── Left: people list ── */}
      <div style={{ flex: '0 0 320px', maxWidth: '100%', ...panel }}>
        <button onClick={() => setSel({ kind: 'invite' })} style={{ ...btn(T.blue, true), width: '100%', marginBottom: 10 }}>+ Invite user</button>
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search users…" style={{ ...fld, marginBottom: 10 }} />
        <div style={{ maxHeight: 520, overflowY: 'auto', margin: '0 -4px', padding: '0 4px' }}>
          {loading && <SkeletonRows rows={6} />}
          {!loading && shownUsers.map(u => {
            const on = sel?.kind === 'user' && sel.id === u.id
            const lane = techByUser.get(u.id)
            return (
              <button key={u.id} onClick={() => setSel({ kind: 'user', id: u.id })} style={{ ...rowBtn(on), opacity: u.is_active ? 1 : 0.5 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: T.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.display_name || u.email}</span>
                  {u.id === currentUser.id && <span style={{ fontSize: 9, color: T.blue }}>(you)</span>}
                  {lane && <span title="Has a diary lane" style={{ width: 8, height: 8, borderRadius: '50%', background: lane.color || T.teal, flexShrink: 0, marginLeft: 'auto' }} />}
                </div>
                <div style={{ fontSize: 10.5, color: T.text3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ROLE_LABELS[u.role]}{u.is_active ? '' : ' · inactive'}</div>
              </button>
            )
          })}

          <div style={{ fontSize: 10, color: T.text3, textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 700, margin: '14px 0 6px' }}>Diary lanes (no login)</div>
          {laneOnly.map(t => {
            const on = sel?.kind === 'tech' && sel.id === t.id
            return (
              <button key={t.id} onClick={() => setSel({ kind: 'tech', id: t.id })} style={{ ...rowBtn(on), opacity: t.active ? 1 : 0.5 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: t.color || T.teal, flexShrink: 0 }} />
                  <span style={{ fontSize: 13, fontWeight: 600, color: T.text }}>{t.name}</span>
                </div>
                <div style={{ fontSize: 10.5, color: T.text3 }}>{t.role || 'Diary lane'}{t.active ? '' : ' · retired'}</div>
              </button>
            )
          })}
          {laneOnly.length === 0 && <div style={{ fontSize: 11, color: T.text3, padding: '2px 4px 6px' }}>None — staff who never log in can be added here.</div>}
          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
            <input value={newLane} onChange={e => setNewLane(e.target.value)} placeholder="New lane name…" style={{ ...fld, flex: 1 }} onKeyDown={e => { if (e.key === 'Enter') addLaneNoLogin() }} />
            <button onClick={addLaneNoLogin} style={btn(T.text2)}>Add</button>
          </div>
        </div>
      </div>

      {/* ── Right: detail ── */}
      <div style={{ flex: '1 1 560px', minWidth: 420, ...panel }}>
        {err && <div style={{ background: `${T.red}15`, border: `1px solid ${T.red}40`, borderRadius: 7, padding: 10, color: T.red, fontSize: 12, marginBottom: 12 }}>{err}</div>}

        {sel?.kind === 'invite' ? (
          <form onSubmit={handleInvite}>
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 14 }}>Invite a user</div>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 200 }}><div style={lbl}>Email</div><input type="email" required value={invite.email} onChange={e => setInvite({ ...invite, email: e.target.value })} placeholder="user@example.com" style={fld} /></div>
              <div style={{ flex: 1, minWidth: 180 }}><div style={lbl}>Display name</div><input value={invite.displayName} onChange={e => setInvite({ ...invite, displayName: e.target.value })} placeholder="Optional" style={fld} /></div>
            </div>
            <div style={{ marginTop: 12, maxWidth: 280 }}><div style={lbl}>Role</div>
              <select value={invite.role} onChange={e => { const role = e.target.value as UserRole; setInvite(v => ({ ...v, role })); setInviteTabs(defaultTabsForRole(role)) }} style={fld}>
                {Object.entries(ROLE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
              <div style={{ fontSize: 10.5, color: T.text3, marginTop: 6, lineHeight: 1.5 }}>{ROLE_DESCRIPTIONS[invite.role]}</div>
            </div>
            <div style={{ ...sectionLbl, display: 'flex', justifyContent: 'space-between' }}>
              <span>Sidebar tabs</span>
              <button type="button" onClick={() => setInviteTabs(defaultTabsForRole(invite.role))} style={{ background: 'none', border: 'none', color: T.blue, cursor: 'pointer', fontFamily: 'inherit', fontSize: 10, textTransform: 'none', letterSpacing: 0 }}>Reset to role defaults</button>
            </div>
            <TabPicker role={invite.role} value={inviteTabs} onChange={setInviteTabs} />
            <div style={{ display: 'flex', gap: 8, marginTop: 18 }}>
              <button type="button" onClick={() => setSel(null)} style={btn(T.text2)}>Cancel</button>
              <button type="submit" disabled={inviting} style={btn(T.blue, true)}>{inviting ? 'Inviting…' : 'Send invite'}</button>
            </div>
          </form>
        ) : selUser ? (() => {
          const u = selUser
          const isSelf = u.id === currentUser.id
          const tabs = u.visible_tabs ?? defaultTabsForRole(u.role)
          return (
            <div key={u.id}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 16, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.display_name || u.email}</div>
                  <div style={{ fontSize: 11, color: T.text3, fontFamily: 'monospace' }}>{u.email}{isSelf ? ' · this is you' : ''}</div>
                </div>
                {!isSelf && <button onClick={() => resendInvite(u)} style={btn(T.amber)}>Resend invite</button>}
                {!isSelf && <button onClick={() => delUser(u)} style={btn(T.red)}>Delete</button>}
              </div>

              <div style={sectionLbl}>Identity & access</div>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 180 }}><div style={lbl}>Display name</div><input defaultValue={u.display_name || ''} onBlur={e => { const v = e.target.value.trim(); if (v !== (u.display_name || '')) updateUser(u.id, { display_name: v || null }) }} style={fld} /></div>
                <div style={{ flex: 1, minWidth: 160 }}><div style={lbl}>Role</div>
                  <select value={u.role} disabled={isSelf} onChange={e => updateUser(u.id, { role: e.target.value as UserRole })} style={{ ...fld, cursor: isSelf ? 'not-allowed' : 'pointer' }}>
                    {Object.entries(ROLE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                </div>
              </div>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 7, marginTop: 12, cursor: isSelf ? 'not-allowed' : 'pointer', opacity: isSelf ? 0.5 : 1, fontSize: 12.5, color: T.text }}>
                <input type="checkbox" checked={u.is_active} disabled={isSelf} onChange={e => updateUser(u.id, { is_active: e.target.checked })} />
                Active login {u.is_active ? '' : '— deactivated'}
              </label>
              <div style={{ fontSize: 10.5, color: T.text3, marginTop: 6 }}>{ROLE_DESCRIPTIONS[u.role]}</div>

              <div style={sectionLbl}>Telephony</div>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                <div style={{ width: 120 }}><div style={lbl}>Deskphone ext</div><input defaultValue={u.phone_extension || ''} placeholder="—" autoComplete="off" data-1p-ignore="true" onBlur={e => { const v = e.target.value.trim(); if (v !== (u.phone_extension || '')) updateUser(u.id, { phone_extension: v || null }) }} style={{ ...fld, fontFamily: 'monospace' }} /></div>
                <div style={{ width: 120 }}><div style={lbl}>Softphone ext</div><input defaultValue={u.webrtc_extension || ''} placeholder="—" autoComplete="off" data-1p-ignore="true" onBlur={e => { const v = e.target.value.trim(); if (v !== (u.webrtc_extension || '')) updateUser(u.id, { webrtc_extension: v || null }) }} style={{ ...fld, fontFamily: 'monospace' }} /></div>
                <div style={{ width: 150 }}><div style={lbl}>Softphone password</div><input type="password" defaultValue="" autoComplete="new-password" data-1p-ignore="true" placeholder={u.webrtc_password_set ? '•••••• (set)' : '—'} onBlur={e => { if (e.target.value) updateUser(u.id, { webrtc_password: e.target.value }) }} style={{ ...fld, fontFamily: 'monospace' }} /></div>
              </div>

              <div style={{ ...sectionLbl, display: 'flex', justifyContent: 'space-between' }}>
                <span>Sidebar tabs {u.visible_tabs ? '(custom)' : '(role default)'}</span>
                {u.visible_tabs && <button onClick={() => updateUser(u.id, { visible_tabs: null })} style={{ background: 'none', border: 'none', color: T.blue, cursor: 'pointer', fontFamily: 'inherit', fontSize: 10, textTransform: 'none', letterSpacing: 0 }}>Reset to role defaults</button>}
              </div>
              <TabPicker role={u.role} value={tabs} onChange={next => updateUser(u.id, { visible_tabs: next })} />

              <div style={sectionLbl}>Workshop diary lane</div>
              {selUserTech ? (
                <LaneEditor tech={selUserTech} fld={fld} lbl={lbl} btn={btn} onPatch={patchTech} onRemove={() => removeTech(selUserTech)} />
              ) : (
                <div style={{ fontSize: 12, color: T.text3 }}>Not on the workshop diary. <button onClick={() => addTechForUser(u)} style={{ ...btn(T.teal), marginLeft: 8 }}>+ Add diary lane</button></div>
              )}
            </div>
          )
        })() : selTech ? (
          <div key={selTech.id}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 16, fontWeight: 600 }}>{selTech.name}</div>
                <div style={{ fontSize: 11, color: T.text3 }}>Diary lane — no portal login</div>
              </div>
              <button onClick={() => removeTech(selTech)} style={btn(T.red)}>Remove</button>
            </div>
            <div style={sectionLbl}>Lane settings</div>
            <LaneEditor tech={selTech} fld={fld} lbl={lbl} btn={btn} onPatch={patchTech} showName />
            <div style={sectionLbl}>Link to a login</div>
            <div style={{ fontSize: 12, color: T.text3, marginBottom: 6 }}>Connect this lane to a portal user so their diary lane is managed from their profile.</div>
            <select value="" onChange={e => { if (e.target.value) { patchTech(selTech.id, { user_id: e.target.value }); setSel({ kind: 'user', id: e.target.value }) } }} style={{ ...fld, maxWidth: 320 }}>
              <option value="">Link to user…</option>
              {users.filter(u => !techByUser.has(u.id)).map(u => <option key={u.id} value={u.id}>{u.display_name || u.email}</option>)}
            </select>
          </div>
        ) : (
          <div style={{ padding: '50px 8px', textAlign: 'center', color: T.text3, fontSize: 13 }}>Select a user on the left to edit their role, tabs, phone and diary lane — or invite a new one.</div>
        )}
      </div>
    </div>
  )
}

function LaneEditor({ tech, fld, lbl, btn, onPatch, onRemove, showName }: {
  tech: TechRow; fld: React.CSSProperties; lbl: React.CSSProperties; btn: (c: string, solid?: boolean) => React.CSSProperties
  onPatch: (id: string, p: any) => void; onRemove?: () => void; showName?: boolean
}) {
  return (
    <div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        {showName && <div style={{ flex: 1, minWidth: 160 }}><div style={lbl}>Lane name</div><input defaultValue={tech.name} onBlur={e => { const v = e.target.value.trim(); if (v && v !== tech.name) onPatch(tech.id, { name: v }) }} style={fld} /></div>}
        <div style={{ flex: 1, minWidth: 140 }}><div style={lbl}>Role</div><input defaultValue={tech.role || ''} placeholder="Technician / Advisor" onBlur={e => { const v = e.target.value.trim(); if (v !== (tech.role || '')) onPatch(tech.id, { role: v || null }) }} style={fld} /></div>
        <div style={{ width: 70 }}><div style={lbl}>Colour</div><input type="color" defaultValue={tech.color || '#4f8ef7'} onBlur={e => { if (e.target.value !== tech.color) onPatch(tech.id, { color: e.target.value }) }} style={{ ...fld, padding: 2, height: 34, cursor: 'pointer' }} /></div>
        <div style={{ width: 90 }}><div style={lbl}>Hrs/day</div><input type="number" min={0} step="0.5" defaultValue={tech.daily_hours} onBlur={e => { const v = Math.max(0, Number(e.target.value) || 0); if (v !== Number(tech.daily_hours)) onPatch(tech.id, { daily_hours: v }) }} style={fld} /></div>
      </div>
      <div style={{ display: 'flex', gap: 18, marginTop: 12, flexWrap: 'wrap' }}>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 7, cursor: 'pointer', fontSize: 12.5, color: T.text }}><input type="checkbox" checked={tech.show_in_diary} onChange={e => onPatch(tech.id, { show_in_diary: e.target.checked })} />Show in diary</label>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 7, cursor: 'pointer', fontSize: 12.5, color: T.text }}><input type="checkbox" checked={tech.active} onChange={e => onPatch(tech.id, { active: e.target.checked })} />Active{tech.active ? '' : ' (retired)'}</label>
        {onRemove && <button onClick={onRemove} style={{ ...btn(T.red), marginLeft: 'auto' }}>Remove from diary</button>}
      </div>
    </div>
  )
}


// ═══════════════════════════════════════════════════════════════════
// PROFILE TAB
// ═══════════════════════════════════════════════════════════════════
function ProfileTab({ user }: { user: PortalUserSSR }) {
  const [password, setPassword] = useState('')
  const [password2, setPassword2] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')

  async function changePassword(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setErr(''); setMsg('')
    try {
      if (password !== password2) throw new Error('Passwords do not match')
      if (password.length < 8) throw new Error('Password must be at least 8 characters')

      const supabase = getSupabase()
      // Must have a fresh session — if null, sign-in prompt would be needed
      const { data: sess } = await supabase.auth.getSession()
      if (!sess.session) throw new Error('Session expired — please sign out and back in')

      const { error } = await supabase.auth.updateUser({ password })
      if (error) throw error
      setMsg('Password updated.')
      setPassword(''); setPassword2('')
    } catch (e: any) { setErr(e.message) }
    finally { setBusy(false) }
  }

  return <div style={{display:'flex',flexDirection:'column',gap:16,maxWidth:540}}>
    <div style={{background:T.bg2,border:`1px solid ${T.border}`,borderRadius:10,padding:18}}>
      <div style={{fontSize:13,fontWeight:600,color:T.text,marginBottom:14}}>Account</div>
      <div style={{display:'grid',gridTemplateColumns:'110px 1fr',gap:'8px 14px',fontSize:12}}>
        <div style={{color:T.text3}}>Email</div>          <div style={{color:T.text,fontFamily:'monospace'}}>{user.email}</div>
        <div style={{color:T.text3}}>Display name</div>   <div style={{color:T.text}}>{user.displayName || <span style={{color:T.text3}}>(not set)</span>}</div>
        <div style={{color:T.text3}}>Role</div>           <div style={{color:T.text}}>{ROLE_LABELS[user.role]} <span style={{color:T.text3,fontSize:11,marginLeft:6}}>{ROLE_DESCRIPTIONS[user.role]}</span></div>
      </div>
    </div>

    <div style={{background:T.bg2,border:`1px solid ${T.border}`,borderRadius:10,padding:18}}>
      <div style={{fontSize:13,fontWeight:600,color:T.text,marginBottom:14}}>Change password</div>
      <form onSubmit={changePassword}>
        <div style={{marginBottom:10}}>
          <div style={{fontSize:10,color:T.text3,marginBottom:4,textTransform:'uppercase',letterSpacing:'0.05em'}}>New password</div>
          <input type="password" required minLength={8} value={password} onChange={e=>setPassword(e.target.value)}
            style={{width:'100%',background:T.bg3,border:`1px solid ${T.border}`,color:T.text,borderRadius:4,padding:'7px 10px',fontSize:12,outline:'none',boxSizing:'border-box'}}/>
        </div>
        <div style={{marginBottom:12}}>
          <div style={{fontSize:10,color:T.text3,marginBottom:4,textTransform:'uppercase',letterSpacing:'0.05em'}}>Confirm</div>
          <input type="password" required value={password2} onChange={e=>setPassword2(e.target.value)}
            style={{width:'100%',background:T.bg3,border:`1px solid ${T.border}`,color:T.text,borderRadius:4,padding:'7px 10px',fontSize:12,outline:'none',boxSizing:'border-box'}}/>
        </div>
        {err && <div style={{color:T.red,fontSize:12,marginBottom:10}}>{err}</div>}
        {msg && <div style={{color:T.green,fontSize:12,marginBottom:10}}>{msg}</div>}
        <button type="submit" disabled={busy}
          style={{padding:'7px 18px',borderRadius:4,border:'none',background:busy?T.bg4:T.blue,color:busy?T.text3:'#fff',fontSize:12,cursor:busy?'wait':'pointer',fontFamily:'inherit',fontWeight:600}}>
          {busy ? 'Saving…' : 'Update password'}
        </button>
      </form>
    </div>

    <TwoFactorCard/>
  </div>
}

// ═══════════════════════════════════════════════════════════════════
// TWO-FACTOR AUTHENTICATION (Supabase native TOTP) — lives in My Profile
// ═══════════════════════════════════════════════════════════════════
function TwoFactorCard() {
  const confirmDialog = useConfirm()
  const [loading, setLoading] = useState(true)
  const [enrolled, setEnrolled] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')
  const [enrolling, setEnrolling] = useState(false)
  const [qr, setQr] = useState('')
  const [secret, setSecret] = useState('')
  const [factorId, setFactorId] = useState('')
  const [code, setCode] = useState('')

  const refresh = useCallback(async () => {
    setError('')
    try {
      const { data, error } = await getSupabase().auth.mfa.listFactors()
      if (error) throw error
      setEnrolled((data?.totp?.length || 0) > 0)
    } catch (e: any) { setError(e?.message || 'Could not load 2FA status') }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { refresh() }, [refresh])

  async function startEnrol() {
    setBusy(true); setError(''); setInfo('')
    try {
      const supabase = getSupabase()
      const { data: existing } = await supabase.auth.mfa.listFactors()
      for (const f of (existing?.all || [])) { if ((f as any).status !== 'verified') { try { await supabase.auth.mfa.unenroll({ factorId: f.id }) } catch {} } }
      const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Authenticator' })
      if (error) throw error
      setQr(data.totp.qr_code); setSecret(data.totp.secret); setFactorId(data.id); setCode(''); setEnrolling(true)
    } catch (e: any) { setError(e?.message || 'Could not start enrolment') }
    finally { setBusy(false) }
  }

  async function confirmEnrol(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setError('')
    try {
      const { error } = await getSupabase().auth.mfa.challengeAndVerify({ factorId, code: code.replace(/\s/g, '') })
      if (error) throw error
      setEnrolling(false); setQr(''); setSecret(''); setFactorId(''); setCode('')
      setInfo('Authenticator enabled. You’ll be asked for a code next time you sign in.')
      await refresh()
    } catch (e: any) { setError(e?.message || 'Invalid code — check your device clock and try again') }
    finally { setBusy(false) }
  }

  async function removeAll() {
    if (!(await confirmDialog({ title: 'Remove your authenticator?', message: 'You will no longer be asked for a code at sign-in until you set one up again.', danger: true }))) return
    setBusy(true); setError(''); setInfo('')
    try {
      const supabase = getSupabase()
      const { data } = await supabase.auth.mfa.listFactors()
      for (const f of (data?.all || [])) { try { await supabase.auth.mfa.unenroll({ factorId: f.id }) } catch {} }
      setInfo('Authenticator removed.'); await refresh()
    } catch (e: any) { setError(e?.message || 'Could not remove authenticator') }
    finally { setBusy(false) }
  }

  const inp: React.CSSProperties = { width:'100%', background:T.bg3, border:`1px solid ${T.border2}`, color:T.text, borderRadius:6, padding:'10px 12px', fontSize:18, outline:'none', boxSizing:'border-box', letterSpacing:'0.3em', textAlign:'center' }
  const btn = (bg: string, on = true): React.CSSProperties => ({ padding:'7px 16px', borderRadius:4, border:'none', background: on ? bg : T.bg4, color: on ? '#fff' : T.text3, fontSize:12, fontWeight:600, cursor: on ? 'pointer' : 'default', fontFamily:'inherit' })

  return (
    <div style={{background:T.bg2,border:`1px solid ${T.border}`,borderRadius:10,padding:18}}>
      <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:6}}>
        <div style={{fontSize:13,fontWeight:600,color:T.text}}>Two-factor authentication</div>
        {loading ? <span style={{fontSize:10,color:T.text3}}>checking…</span>
          : enrolled ? <span style={{fontSize:10,padding:'2px 8px',borderRadius:10,background:`${T.green}22`,color:T.green,border:`1px solid ${T.green}55`}}>● Active</span>
          : <span style={{fontSize:10,padding:'2px 8px',borderRadius:10,background:`${T.amber}22`,color:T.amber,border:`1px solid ${T.amber}55`}}>Not set up</span>}
      </div>
      <div style={{fontSize:11.5,color:T.text3,marginBottom:14,lineHeight:1.5}}>A 6-digit code from an authenticator app (Google/Microsoft Authenticator, 1Password, Authy…) on top of your password.</div>

      {info && <div style={{fontSize:12,color:T.green,marginBottom:10}}>{info}</div>}
      {error && <div style={{fontSize:12,color:T.red,marginBottom:10}}>{error}</div>}

      {!enrolling && !enrolled && !loading && (
        <button onClick={startEnrol} disabled={busy} style={btn(T.blue, !busy)}>{busy ? 'Starting…' : 'Set up authenticator'}</button>
      )}
      {!enrolling && enrolled && (
        <button onClick={removeAll} disabled={busy} style={{...btn(T.bg4), color:T.red, border:`1px solid ${T.red}40`}}>{busy ? 'Working…' : 'Remove authenticator'}</button>
      )}
      {enrolling && (
        <form onSubmit={confirmEnrol}>
          <div style={{fontSize:12,color:T.text2,marginBottom:10}}>1. Scan this QR code in your authenticator app:</div>
          {qr && <div style={{background:'#fff',padding:12,borderRadius:10,display:'inline-block',marginBottom:12}}><img src={qr} alt="2FA QR" width={170} height={170} style={{display:'block'}}/></div>}
          {secret && <div style={{fontSize:11,color:T.text3,marginBottom:12}}>Can’t scan? Key: <span style={{fontFamily:'monospace',color:T.text,userSelect:'all',wordBreak:'break-all'}}>{secret}</span></div>}
          <div style={{fontSize:10,color:T.text3,textTransform:'uppercase',letterSpacing:'0.05em',marginBottom:6}}>2. Enter the 6-digit code</div>
          <input type="text" inputMode="numeric" autoComplete="one-time-code" autoFocus value={code}
            onChange={e => setCode(e.target.value.replace(/[^\d]/g, '').slice(0, 6))} placeholder="123456" style={inp}/>
          <div style={{display:'flex',gap:8,marginTop:12}}>
            <button type="submit" disabled={busy || code.length !== 6} style={btn(T.green, !busy && code.length === 6)}>{busy ? 'Verifying…' : 'Verify & enable'}</button>
            <button type="button" onClick={() => { setEnrolling(false); setError('') }} disabled={busy} style={{...btn(T.bg4), color:T.text2}}>Cancel</button>
          </div>
        </form>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════
// AUDIT LOG TAB
// ═══════════════════════════════════════════════════════════════════
function AuditTab() {
  const [rows, setRows] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch('/api/users/audit')
        if (!r.ok) throw new Error((await r.json()).error || 'Failed')
        const d = await r.json()
        setRows(d.rows || [])
      } catch (e: any) { setErr(e.message) }
      finally { setLoading(false) }
    })()
  }, [])

  return <div style={{background:T.bg2,border:`1px solid ${T.border}`,borderRadius:10,overflowX:'auto'}}>
    <div style={{padding:'14px 16px',borderBottom:`1px solid ${T.border2}`}}>
      <div style={{fontSize:13,fontWeight:600}}>Audit Log</div>
      <div style={{fontSize:11,color:T.text3,marginTop:2}}>Recent user-management events</div>
    </div>
    {loading && <SkeletonRows rows={8}/>}
    {err && <div style={{padding:20,color:T.red,fontSize:12}}>{err}</div>}
    {!loading && !err && (
      <table style={{width:'100%',borderCollapse:'collapse'}}>
        <thead><tr style={{borderBottom:`1px solid ${T.border}`}}>
          {['When','Actor','Action','Target','Details'].map(h =>
            <th key={h} style={{fontSize:10,color:T.text3,padding:'10px 12px',textAlign:'left',fontWeight:500,textTransform:'uppercase',letterSpacing:'0.05em'}}>{h}</th>
          )}
        </tr></thead>
        <tbody>{rows.map(r => (
          <tr key={r.id} style={{borderTop:`1px solid ${T.border}`}}>
            <td style={{fontSize:11,color:T.text3,padding:'8px 12px',fontFamily:'monospace',whiteSpace:'nowrap'}}>
              {new Date(r.created_at).toLocaleString('en-AU',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'})}
            </td>
            <td style={{fontSize:12,color:T.text2,padding:'8px 12px',fontFamily:'monospace'}}>{r.actor_email || '—'}</td>
            <td style={{fontSize:12,color:T.blue,padding:'8px 12px'}}>{r.action}</td>
            <td style={{fontSize:12,color:T.text2,padding:'8px 12px',fontFamily:'monospace'}}>{r.target_email || '—'}</td>
            <td style={{fontSize:11,color:T.text3,padding:'8px 12px',fontFamily:'monospace',maxWidth:300,overflow:'hidden',textOverflow:'ellipsis'}}>
              {r.details ? JSON.stringify(r.details).slice(0,100) : ''}
            </td>
          </tr>
        ))}
        {rows.length === 0 && <tr><td colSpan={5} style={{padding:24,textAlign:'center',color:T.text3,fontSize:12}}>No audit events yet.</td></tr>}
        </tbody>
      </table>
    )}
  </div>
}

// ═══════════════════════════════════════════════════════════════════
// VIN CODES & BACKFILL TABS — thin wrappers around the existing admin UIs
// ═══════════════════════════════════════════════════════════════════
// These embed the existing /admin/vin-codes and /admin/backfill pages as
// iframes. That keeps the code as-is without extraction/refactor. The nav
// inside those pages hides when rendered in an iframe (we check window !== top).
// (Distributor customers admin lives in DistributorTab and is also iframed.)
function VinCodesTab() {
  return <div style={{background:T.bg2,border:`1px solid ${T.border}`,borderRadius:10,overflow:'hidden',height:'calc(100vh - 200px)',minHeight:600}}>
    <iframe src="/admin/vin-codes?embed=1" style={{width:'100%',height:'100%',border:'none',display:'block'}} title="VIN codes admin"/>
  </div>
}
function BackfillTab() {
  return <div style={{background:T.bg2,border:`1px solid ${T.border}`,borderRadius:10,overflow:'hidden',height:'calc(100vh - 200px)',minHeight:600}}>
    <iframe src="/admin/backfill?embed=1" style={{width:'100%',height:'100%',border:'none',display:'block'}} title="Orders ↔ Quotes backfill"/>
  </div>
}
function WorkshopSettingsEmbed() {
  return <div style={{background:T.bg2,border:`1px solid ${T.border}`,borderRadius:10,overflow:'hidden',height:'calc(100vh - 200px)',minHeight:600}}>
    <iframe src="/workshop/settings?embed=1" style={{width:'100%',height:'100%',border:'none',display:'block'}} title="Workshop settings"/>
  </div>
}
function MdImportsEmbed() {
  return <div style={{background:T.bg2,border:`1px solid ${T.border}`,borderRadius:10,overflow:'hidden',height:'calc(100vh - 200px)',minHeight:600}}>
    <iframe src="/imports?embed=1" style={{width:'100%',height:'100%',border:'none',display:'block'}} title="MD Imports"/>
  </div>
}

export async function getServerSideProps(context: any) {
  return requirePageAuth(context, null)  // any authenticated user can see this page; individual tabs gate themselves
}
