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

const T = {
  bg:'#0d0f12', bg2:'#131519', bg3:'#1a1d23', bg4:'#21252d',
  border:'rgba(255,255,255,0.07)', border2:'rgba(255,255,255,0.12)',
  text:'#e8eaf0', text2:'#8b90a0', text3:'#545968',
  blue:'#4f8ef7', teal:'#2dd4bf', green:'#34c77b',
  amber:'#f5a623', red:'#f04e4e', purple:'#a78bfa', accent:'#4f8ef7',
}

interface PortalUserSSR { id: string; email: string; displayName: string | null; role: UserRole }
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
    { id: 'users',       label: 'Users',              adminOnly: true,  icon: 'team',          accent: T.blue,   desc: 'Invite, roles & tab access' },
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

function UsersTab({ currentUser }: { currentUser: PortalUserSSR }) {
  const [users, setUsers] = useState<UserRow[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [invite, setInvite] = useState({ email: '', displayName: '', role: 'viewer' as UserRole })
  // Which tabs the new invitee will see. Starts from role defaults; admin can
  // tick/untick individual tabs before submitting.
  const [inviteTabs, setInviteTabs] = useState<string[]>(() => defaultTabsForRole('viewer'))
  const [inviting, setInviting] = useState(false)

  // Edit-tabs modal state (null = closed; a user row = open for that user)
  const [editingTabsFor, setEditingTabsFor] = useState<UserRow | null>(null)
  const [editingTabs, setEditingTabs] = useState<string[]>([])
  const [savingTabs, setSavingTabs] = useState(false)

  // Whenever the role in the invite form changes, reset the tab selection to
  // that role's defaults. Admin is still free to adjust after.
  function changeInviteRole(role: UserRole) {
    setInvite(v => ({ ...v, role }))
    setInviteTabs(defaultTabsForRole(role))
  }

  function toggleInviteTab(tabId: string) {
    setInviteTabs(prev => prev.includes(tabId) ? prev.filter(t => t !== tabId) : [...prev, tabId])
  }

  function openEditTabs(u: UserRow) {
    setEditingTabsFor(u)
    // If user has a custom list, use it; otherwise seed with their role defaults
    setEditingTabs(u.visible_tabs ? [...u.visible_tabs] : defaultTabsForRole(u.role))
  }

  function toggleEditingTab(tabId: string) {
    setEditingTabs(prev => prev.includes(tabId) ? prev.filter(t => t !== tabId) : [...prev, tabId])
  }

  async function saveEditingTabs(resetToDefault = false) {
    if (!editingTabsFor) return
    setSavingTabs(true); setErr('')
    try {
      const r = await fetch(`/api/users/${editingTabsFor.id}`, {
        method:'PATCH', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ visible_tabs: resetToDefault ? null : editingTabs }),
      })
      if (!r.ok) throw new Error((await r.json()).error || 'Save failed')
      await load()
      setEditingTabsFor(null)
    } catch (e: any) { setErr(e.message) }
    finally { setSavingTabs(false) }
  }

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/users')
      if (!r.ok) throw new Error((await r.json()).error || 'Failed to load users')
      const d = await r.json()
      setUsers(d.users || [])
      setErr('')
    } catch (e: any) { setErr(e.message) }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault()
    setInviting(true); setErr('')
    try {
      const r = await fetch('/api/users', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ ...invite, visible_tabs: inviteTabs }),
      })
      if (!r.ok) throw new Error((await r.json()).error || 'Invite failed')
      const d = await r.json()
      setInvite({ email:'', displayName:'', role:'viewer' })
      setInviteTabs(defaultTabsForRole('viewer'))
      await load()
      alert(`Invited ${d.user.email}.\n${d.resetEmailSent ? 'Password setup email sent.' : 'Note: reset email failed to send — use "Resend invite" on the row.'}`)
    } catch (e: any) { setErr(e.message) }
    finally { setInviting(false) }
  }

  async function update(id: string, patch: Partial<UserRow> & { webrtc_password?: string | null }) {
    try {
      const r = await fetch(`/api/users/${id}`, {
        method:'PATCH', headers:{'Content-Type':'application/json'},
        body: JSON.stringify(patch),
      })
      if (!r.ok) throw new Error((await r.json()).error || 'Update failed')
      await load()
    } catch (e: any) { setErr(e.message) }
  }

  async function del(id: string, email: string) {
    if (!confirm(`Permanently delete ${email}? They will lose all access immediately.`)) return
    try {
      const r = await fetch(`/api/users/${id}`, { method:'DELETE' })
      if (!r.ok) throw new Error((await r.json()).error || 'Delete failed')
      await load()
    } catch (e: any) { setErr(e.message) }
  }

  async function resendInvite(id: string, email: string) {
    try {
      const r = await fetch(`/api/users/${id}/resend-invite`, { method:'POST' })
      if (!r.ok) throw new Error((await r.json()).error || 'Resend failed')
      alert(`Password reset email re-sent to ${email}.`)
    } catch (e: any) { setErr(e.message) }
  }

  return <div style={{display:'flex',flexDirection:'column',gap:16}}>
    {/* Invite form */}
    <div style={{background:T.bg2,border:`1px solid ${T.border}`,borderRadius:10,padding:16}}>
      <div style={{fontSize:13,fontWeight:600,color:T.text,marginBottom:10}}>Invite a user</div>
      <form onSubmit={handleInvite}>
        <div style={{display:'flex',gap:8,alignItems:'flex-end',flexWrap:'wrap'}}>
          <div style={{flex:1,minWidth:200}}>
            <div style={{fontSize:10,color:T.text3,marginBottom:4,textTransform:'uppercase',letterSpacing:'0.05em'}}>Email</div>
            <input type="email" required value={invite.email} onChange={e=>setInvite({...invite,email:e.target.value})}
              placeholder="user@example.com"
              style={{width:'100%',background:T.bg3,border:`1px solid ${T.border}`,color:T.text,borderRadius:4,padding:'6px 10px',fontSize:12,outline:'none',boxSizing:'border-box'}}/>
          </div>
          <div style={{flex:1,minWidth:180}}>
            <div style={{fontSize:10,color:T.text3,marginBottom:4,textTransform:'uppercase',letterSpacing:'0.05em'}}>Display name</div>
            <input value={invite.displayName} onChange={e=>setInvite({...invite,displayName:e.target.value})}
              placeholder="Optional"
              style={{width:'100%',background:T.bg3,border:`1px solid ${T.border}`,color:T.text,borderRadius:4,padding:'6px 10px',fontSize:12,outline:'none',boxSizing:'border-box'}}/>
          </div>
          <div style={{minWidth:140}}>
            <div style={{fontSize:10,color:T.text3,marginBottom:4,textTransform:'uppercase',letterSpacing:'0.05em'}}>Role (template)</div>
            <select value={invite.role} onChange={e=>changeInviteRole(e.target.value as UserRole)}
              style={{background:T.bg3,border:`1px solid ${T.border}`,color:T.text,borderRadius:4,padding:'6px 10px',fontSize:12,outline:'none',width:'100%',boxSizing:'border-box'}}>
              {Object.entries(ROLE_LABELS).map(([k,v])=><option key={k} value={k}>{v}</option>)}
            </select>
          </div>
          <button type="submit" disabled={inviting}
            style={{padding:'7px 16px',borderRadius:4,border:'none',background:inviting?T.bg4:T.blue,color:inviting?T.text3:'#fff',fontSize:12,cursor:inviting?'wait':'pointer',fontFamily:'inherit',fontWeight:600}}>
            {inviting ? 'Inviting…' : 'Invite'}
          </button>
        </div>
        <div style={{fontSize:10,color:T.text3,marginTop:8,lineHeight:1.5}}>
          {ROLE_DESCRIPTIONS[invite.role]}
        </div>

        {/* Tab allowlist — starts from role defaults, admin can tick/untick individual tabs */}
        <div style={{marginTop:14,paddingTop:14,borderTop:`1px solid ${T.border}`}}>
          <div style={{display:'flex',alignItems:'baseline',justifyContent:'space-between',marginBottom:8}}>
            <div style={{fontSize:10,color:T.text3,textTransform:'uppercase',letterSpacing:'0.05em',fontWeight:600}}>Sidebar tabs</div>
            <div style={{display:'flex',gap:10,fontSize:10}}>
              <button type="button" onClick={()=>setInviteTabs(PORTAL_TABS.map(t=>t.id))}
                style={{background:'none',border:'none',color:T.text3,cursor:'pointer',fontFamily:'inherit',padding:0}}>
                Select all
              </button>
              <button type="button" onClick={()=>setInviteTabs([])}
                style={{background:'none',border:'none',color:T.text3,cursor:'pointer',fontFamily:'inherit',padding:0}}>
                Clear
              </button>
              <button type="button" onClick={()=>setInviteTabs(defaultTabsForRole(invite.role))}
                style={{background:'none',border:'none',color:T.blue,cursor:'pointer',fontFamily:'inherit',padding:0}}>
                Reset to role defaults
              </button>
            </div>
          </div>
          <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(170px,1fr))',gap:6}}>
            {PORTAL_TABS.map(t => {
              const roleHas = roleHasPermission(invite.role, t.permission)
              const checked = inviteTabs.includes(t.id)
              return (
                <label key={t.id} style={{
                  display:'flex',alignItems:'center',gap:7,
                  padding:'6px 10px',
                  background: checked ? T.bg3 : 'transparent',
                  border:`1px solid ${checked ? T.border2 : T.border}`,
                  borderRadius:4,
                  cursor: roleHas ? 'pointer' : 'not-allowed',
                  opacity: roleHas ? 1 : 0.4,
                  fontSize:12,
                }} title={roleHas ? '' : `The ${ROLE_LABELS[invite.role]} role doesn't have permission for this tab.`}>
                  <input type="checkbox" checked={checked} disabled={!roleHas}
                    onChange={()=>toggleInviteTab(t.id)}
                    style={{margin:0}}/>
                  <span style={{color: checked ? T.text : T.text2}}>{t.label}</span>
                </label>
              )
            })}
          </div>
          <div style={{fontSize:10,color:T.text3,marginTop:8}}>
            {inviteTabs.length} of {PORTAL_TABS.length} tabs selected. Greyed-out tabs aren't permitted by the selected role.
          </div>
        </div>
      </form>
    </div>

    {err && <div style={{background:`${T.red}15`,border:`1px solid ${T.red}40`,borderRadius:7,padding:10,color:T.red,fontSize:12}}>{err}</div>}

    {/* Users list */}
    <div style={{background:T.bg2,border:`1px solid ${T.border}`,borderRadius:10,overflowX:'auto'}}>
      <div style={{padding:'14px 16px',borderBottom:`1px solid ${T.border2}`,display:'flex',alignItems:'center'}}>
        <div style={{fontSize:13,fontWeight:600,color:T.text}}>Users ({users.length})</div>
      </div>
      {loading && <div style={{padding:30,textAlign:'center',color:T.text3,fontSize:12}}>Loading…</div>}
      {!loading && (
        <table style={{width:'100%',borderCollapse:'collapse'}}>
          <thead><tr style={{borderBottom:`1px solid ${T.border}`}}>
            {['Email','Name','Role','Phone Ext','Web Ext','Web Pwd','Tabs','Active','Last sign-in','Created',''].map(h =>
              <th key={h} style={{fontSize:10,color:T.text3,padding:'10px 12px',textAlign:'left',fontWeight:500,textTransform:'uppercase',letterSpacing:'0.05em'}}>{h}</th>
            )}
          </tr></thead>
          <tbody>{users.map(u => {
            const isSelf = u.id === currentUser.id
            return <tr key={u.id} style={{borderTop:`1px solid ${T.border}`,opacity:u.is_active?1:0.5}}>
              <td style={{fontSize:12,color:T.text,padding:'8px 12px',fontFamily:'monospace'}}>{u.email}{isSelf && <span style={{color:T.blue,fontSize:10,marginLeft:6}}>(you)</span>}</td>
              <td style={{fontSize:12,color:T.text2,padding:'8px 12px'}}>{u.display_name || '—'}</td>
              <td style={{padding:'8px 12px'}}>
                <select value={u.role} disabled={isSelf} onChange={e=>update(u.id,{role:e.target.value as UserRole})}
                  style={{background:T.bg3,border:`1px solid ${T.border}`,color:isSelf?T.text3:T.text,borderRadius:3,padding:'3px 6px',fontSize:11,outline:'none',cursor:isSelf?'not-allowed':'pointer'}}>
                  {Object.entries(ROLE_LABELS).map(([k,v])=><option key={k} value={k}>{v}</option>)}
                </select>
              </td>
              <td style={{padding:'8px 12px'}}>
                <input defaultValue={u.phone_extension || ''} placeholder="—"
                  autoComplete="off" name={`phone-ext-${u.id}`} data-lpignore="true" data-1p-ignore="true" data-form-type="other"
                  title="Deskphone SIP extension — rings for &quot;Listen on Handset&quot;"
                  onBlur={e=>{ const v=e.target.value.trim(); if (v !== (u.phone_extension||'')) update(u.id,{phone_extension: v || null}) }}
                  style={{width:58,background:T.bg3,border:`1px solid ${T.border}`,color:T.text,borderRadius:3,padding:'3px 6px',fontSize:11,outline:'none',fontFamily:'monospace'}}/>
              </td>
              <td style={{padding:'8px 12px'}}>
                <input defaultValue={u.webrtc_extension || ''} placeholder="—"
                  autoComplete="off" name={`wrtc-ext-${u.id}`} data-lpignore="true" data-1p-ignore="true" data-form-type="other"
                  title="WebRTC softphone SIP extension — used for &quot;Listen on Device&quot;"
                  onBlur={e=>{ const v=e.target.value.trim(); if (v !== (u.webrtc_extension||'')) update(u.id,{webrtc_extension: v || null}) }}
                  style={{width:58,background:T.bg3,border:`1px solid ${T.border}`,color:T.text,borderRadius:3,padding:'3px 6px',fontSize:11,outline:'none',fontFamily:'monospace'}}/>
              </td>
              <td style={{padding:'8px 12px'}}>
                <input type="password" defaultValue=""
                  autoComplete="new-password" name={`wrtc-pwd-${u.id}`} data-lpignore="true" data-1p-ignore="true" data-form-type="other"
                  placeholder={u.webrtc_password_set ? '••••••' : '—'}
                  title={u.webrtc_password_set ? 'Set — leave blank to keep, type to replace' : 'WebRTC SIP digest password'}
                  onBlur={e=>{ const v=e.target.value; if (v) update(u.id,{webrtc_password: v}) }}
                  style={{width:90,background:T.bg3,border:`1px solid ${u.webrtc_password_set?T.border2:T.border}`,color:T.text,borderRadius:3,padding:'3px 6px',fontSize:11,outline:'none',fontFamily:'monospace'}}/>
              </td>
              <td style={{padding:'8px 12px',whiteSpace:'nowrap'}}>
                <button onClick={()=>openEditTabs(u)}
                  style={{padding:'3px 8px',borderRadius:3,border:`1px solid ${T.border2}`,background:'transparent',color:T.text2,fontSize:11,cursor:'pointer',fontFamily:'inherit'}}>
                  {u.visible_tabs ? `${u.visible_tabs.length} custom` : 'Role default'}
                </button>
                {u.visible_tabs && (
                  <span style={{marginLeft:6,fontSize:9,padding:'2px 5px',borderRadius:2,background:`${T.purple}22`,color:T.purple,fontWeight:500}}>CUSTOM</span>
                )}
              </td>
              <td style={{padding:'8px 12px'}}>
                <label style={{display:'inline-flex',alignItems:'center',gap:6,cursor:isSelf?'not-allowed':'pointer',opacity:isSelf?0.5:1}}>
                  <input type="checkbox" checked={u.is_active} disabled={isSelf}
                    onChange={e=>update(u.id,{is_active:e.target.checked})}/>
                  <span style={{fontSize:11,color:u.is_active?T.green:T.text3}}>{u.is_active?'Active':'Inactive'}</span>
                </label>
              </td>
              <td style={{fontSize:11,color:T.text3,padding:'8px 12px',fontFamily:'monospace'}}>
                {u.last_sign_in_at ? new Date(u.last_sign_in_at).toLocaleDateString('en-AU',{day:'2-digit',month:'short',year:'2-digit'}) : '—'}
              </td>
              <td style={{fontSize:11,color:T.text3,padding:'8px 12px',fontFamily:'monospace'}}>
                {new Date(u.created_at).toLocaleDateString('en-AU',{day:'2-digit',month:'short',year:'2-digit'})}
              </td>
              <td style={{padding:'8px 12px',textAlign:'right',whiteSpace:'nowrap'}}>
                {!isSelf && <>
                  <button onClick={()=>resendInvite(u.id,u.email)} title="Resend password setup email"
                    style={{padding:'3px 8px',borderRadius:3,border:'none',background:'transparent',color:T.amber,fontSize:11,cursor:'pointer',fontFamily:'inherit'}}>
                    Resend
                  </button>
                  <button onClick={()=>del(u.id,u.email)}
                    style={{padding:'3px 8px',borderRadius:3,border:'none',background:'transparent',color:T.red,fontSize:11,cursor:'pointer',fontFamily:'inherit'}}>
                    Delete
                  </button>
                </>}
              </td>
            </tr>
          })}</tbody>
        </table>
      )}
    </div>

    {/* Edit Tabs modal */}
    {editingTabsFor && (() => {
      const target = editingTabsFor
      const roleDefaults = defaultTabsForRole(target.role)
      return (
        <div onClick={()=>!savingTabs && setEditingTabsFor(null)} style={{
          position:'fixed',inset:0,background:'rgba(0,0,0,0.6)',zIndex:9999,
          display:'flex',alignItems:'center',justifyContent:'center',padding:16,
        }}>
          <div onClick={e=>e.stopPropagation()} style={{
            background:T.bg2,border:`1px solid ${T.border2}`,borderRadius:10,
            padding:20,width:'100%',maxWidth:560,maxHeight:'85vh',display:'flex',flexDirection:'column',
          }}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:14}}>
              <div>
                <div style={{fontSize:14,fontWeight:600,color:T.text}}>Edit sidebar tabs</div>
                <div style={{fontSize:11,color:T.text3,marginTop:3,fontFamily:'monospace'}}>{target.email}</div>
                <div style={{fontSize:10,color:T.text3,marginTop:2}}>
                  Role: <strong style={{color:T.text2}}>{ROLE_LABELS[target.role]}</strong> · {target.visible_tabs ? 'Currently: custom tab list' : 'Currently: using role defaults'}
                </div>
              </div>
              <button onClick={()=>setEditingTabsFor(null)} disabled={savingTabs}
                style={{background:'none',border:'none',color:T.text3,fontSize:18,cursor:'pointer',padding:0,lineHeight:1}}>×</button>
            </div>

            <div style={{display:'flex',gap:10,marginBottom:10,fontSize:10}}>
              <button type="button" onClick={()=>setEditingTabs(PORTAL_TABS.map(t=>t.id))}
                style={{background:'none',border:'none',color:T.text3,cursor:'pointer',fontFamily:'inherit',padding:0}}>
                Select all
              </button>
              <button type="button" onClick={()=>setEditingTabs([])}
                style={{background:'none',border:'none',color:T.text3,cursor:'pointer',fontFamily:'inherit',padding:0}}>
                Clear
              </button>
              <button type="button" onClick={()=>setEditingTabs(roleDefaults)}
                style={{background:'none',border:'none',color:T.blue,cursor:'pointer',fontFamily:'inherit',padding:0}}>
                Select role defaults
              </button>
              <div style={{marginLeft:'auto',color:T.text3}}>{editingTabs.length} of {PORTAL_TABS.length} selected</div>
            </div>

            <div style={{overflowY:'auto',flex:1,minHeight:0}}>
              <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(170px,1fr))',gap:6}}>
                {PORTAL_TABS.map(t => {
                  const roleHas = roleHasPermission(target.role, t.permission)
                  const checked = editingTabs.includes(t.id)
                  return (
                    <label key={t.id} style={{
                      display:'flex',alignItems:'center',gap:7,padding:'6px 10px',
                      background: checked ? T.bg3 : 'transparent',
                      border:`1px solid ${checked ? T.border2 : T.border}`,
                      borderRadius:4,
                      cursor: roleHas ? 'pointer' : 'not-allowed',
                      opacity: roleHas ? 1 : 0.4,
                      fontSize:12,
                    }} title={roleHas ? '' : `The ${ROLE_LABELS[target.role]} role doesn't have permission for this tab.`}>
                      <input type="checkbox" checked={checked} disabled={!roleHas || savingTabs}
                        onChange={()=>toggleEditingTab(t.id)}
                        style={{margin:0}}/>
                      <span style={{color: checked ? T.text : T.text2}}>{t.label}</span>
                    </label>
                  )
                })}
              </div>
            </div>

            <div style={{display:'flex',gap:8,marginTop:16,paddingTop:14,borderTop:`1px solid ${T.border}`,justifyContent:'space-between'}}>
              <button onClick={()=>saveEditingTabs(true)} disabled={savingTabs}
                style={{padding:'7px 14px',borderRadius:4,border:`1px solid ${T.border2}`,background:'transparent',color:T.text3,fontSize:12,cursor:savingTabs?'wait':'pointer',fontFamily:'inherit'}}>
                Reset to role defaults
              </button>
              <div style={{display:'flex',gap:8}}>
                <button onClick={()=>setEditingTabsFor(null)} disabled={savingTabs}
                  style={{padding:'7px 14px',borderRadius:4,border:`1px solid ${T.border2}`,background:'transparent',color:T.text2,fontSize:12,cursor:savingTabs?'wait':'pointer',fontFamily:'inherit'}}>
                  Cancel
                </button>
                <button onClick={()=>saveEditingTabs(false)} disabled={savingTabs}
                  style={{padding:'7px 16px',borderRadius:4,border:'none',background:savingTabs?T.bg4:T.blue,color:savingTabs?T.text3:'#fff',fontSize:12,cursor:savingTabs?'wait':'pointer',fontFamily:'inherit',fontWeight:600}}>
                  {savingTabs ? 'Saving…' : 'Save tabs'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )
    })()}
  </div>
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
    if (!confirm('Remove your authenticator? You will no longer be asked for a code at sign-in until you set one up again.')) return
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
    {loading && <div style={{padding:30,textAlign:'center',color:T.text3,fontSize:12}}>Loading…</div>}
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
