// pages/b2b/team.tsx
//
// Distributor self-service team page.
//
// Members: read-only view of the team.
// Owners: invite new users (member or owner), toggle active, change role,
// remove. Server-side guards (see /api/b2b/team/users/[id]) prevent
// removing or demoting the last active owner and self-edits that would
// lock the caller out.

import { useEffect, useState } from 'react'
import Head from 'next/head'
import type { GetServerSideProps } from 'next'
import B2BLayout from '../../components/b2b/B2BLayout'
import { requireB2BPageAuth } from '../../lib/b2bAuthServer'

const T = {
  bg:'#0d0f12', bg2:'#131519', bg3:'#1a1d23', bg4:'#21252d',
  border:'rgba(255,255,255,0.07)', border2:'rgba(255,255,255,0.12)',
  text:'#e8eaf0', text2:'#aab0c0', text3:'#8d93a4',
  blue:'#4f8ef7', teal:'#2dd4bf', green:'#34c77b',
  amber:'#f5a623', red:'#f04e4e',
}

interface Props {
  b2bUser: {
    id: string
    email: string
    fullName: string | null
    role: 'owner' | 'member'
    distributor: { id: string; displayName: string }
  }
}

interface TeamUser {
  id: string
  auth_user_id: string | null
  email: string
  full_name: string | null
  role: 'owner' | 'member'
  last_login_at: string | null
  invited_at: string | null
  is_active: boolean
  created_at: string
}

export default function B2BTeamPage({ b2bUser }: Props) {
  const [users, setUsers] = useState<TeamUser[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyUserId, setBusyUserId] = useState<string | null>(null)

  // Invite form
  const [inviteOpen, setInviteOpen] = useState(false)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteName, setInviteName] = useState('')
  const [inviteRole, setInviteRole] = useState<'owner' | 'member'>('member')
  const [inviting, setInviting] = useState(false)
  const [inviteError, setInviteError] = useState<string | null>(null)
  const [inviteFlash, setInviteFlash] = useState<string | null>(null)

  const isOwner = b2bUser.role === 'owner'

  async function load() {
    setLoading(true)
    try {
      const r = await fetch('/api/b2b/team/users', { credentials: 'same-origin' })
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`)
      const j = await r.json()
      setUsers(j.users || [])
      setError(null)
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [])

  async function patchUser(id: string, patch: Partial<TeamUser>) {
    setBusyUserId(id)
    try {
      const r = await fetch(`/api/b2b/team/users/${id}`, {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      const j = await r.json()
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`)
      setUsers(prev => prev.map(u => u.id === id ? { ...u, ...(j.user || patch) } : u))
    } catch (e: any) {
      alert(e?.message || 'Update failed')
    } finally {
      setBusyUserId(null)
    }
  }

  async function removeUser(u: TeamUser) {
    if (!confirm(`Remove ${u.full_name || u.email} from your team? They'll lose access immediately.`)) return
    setBusyUserId(u.id)
    try {
      const r = await fetch(`/api/b2b/team/users/${u.id}`, { method: 'DELETE', credentials: 'same-origin' })
      const j = await r.json()
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`)
      setUsers(prev => prev.filter(x => x.id !== u.id))
    } catch (e: any) {
      alert(e?.message || 'Remove failed')
    } finally {
      setBusyUserId(null)
    }
  }

  async function sendInvite() {
    setInviting(true)
    setInviteError(null)
    setInviteFlash(null)
    try {
      const r = await fetch('/api/b2b/team/users', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: inviteEmail,
          full_name: inviteName.trim() || undefined,
          role: inviteRole,
        }),
      })
      const j = await r.json()
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`)
      setInviteFlash(`Invite sent to ${j.invite_sent_to}`)
      setInviteEmail('')
      setInviteName('')
      setInviteRole('member')
      await load()
      setTimeout(() => setInviteFlash(null), 4000)
    } catch (e: any) {
      setInviteError(e?.message || String(e))
    } finally {
      setInviting(false)
    }
  }

  return (
    <>
      <Head><title>Team · Just Autos B2B</title></Head>
      <B2BLayout user={b2bUser} active="team">
        <header style={{display:'flex',alignItems:'flex-end',justifyContent:'space-between',gap:16,flexWrap:'wrap',marginBottom:18}}>
          <div>
            <h1 style={{fontSize:22,fontWeight:600,margin:0,letterSpacing:'-0.01em'}}>Team</h1>
            <div style={{fontSize:13,color:T.text3,marginTop:4}}>
              {isOwner
                ? 'Invite your team or change their roles. Owners can manage; members can browse.'
                : 'Read-only — only owners can invite or change roles.'}
            </div>
          </div>
          {isOwner && !inviteOpen && (
            <button onClick={() => setInviteOpen(true)}
              style={{padding:'9px 14px',borderRadius:6,border:`1px solid ${T.blue}`,background:T.blue,color:'#fff',fontSize:13,fontWeight:500,cursor:'pointer',fontFamily:'inherit'}}>
              + Invite user
            </button>
          )}
        </header>

        {error && (
          <div style={{padding:12,background:`${T.red}15`,border:`1px solid ${T.red}40`,borderRadius:7,color:T.red,fontSize:13,marginBottom:14}}>
            {error}
          </div>
        )}

        {/* Invite form */}
        {isOwner && inviteOpen && (
          <div style={{
            background:T.bg2,border:`1px solid ${T.border}`,borderRadius:10,
            padding:'16px 18px',marginBottom:16,
          }}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10}}>
              <div style={{fontSize:13,fontWeight:600}}>Invite a new user</div>
              <button onClick={() => { setInviteOpen(false); setInviteError(null) }}
                style={{background:'transparent',border:'none',color:T.text3,fontSize:18,cursor:'pointer'}}>×</button>
            </div>
            <div style={{display:'grid',gridTemplateColumns:'2fr 2fr 1fr auto',gap:10,alignItems:'end'}}>
              <label style={{display:'flex',flexDirection:'column',gap:4}}>
                <span style={{fontSize:11,color:T.text2,fontWeight:500}}>Email</span>
                <input type="email" value={inviteEmail} onChange={e => setInviteEmail(e.target.value)}
                  placeholder="them@example.com"
                  style={inputStyle()}/>
              </label>
              <label style={{display:'flex',flexDirection:'column',gap:4}}>
                <span style={{fontSize:11,color:T.text2,fontWeight:500}}>Full name (optional)</span>
                <input type="text" value={inviteName} onChange={e => setInviteName(e.target.value)}
                  style={inputStyle()}/>
              </label>
              <label style={{display:'flex',flexDirection:'column',gap:4}}>
                <span style={{fontSize:11,color:T.text2,fontWeight:500}}>Role</span>
                <select value={inviteRole} onChange={e => setInviteRole(e.target.value as 'owner' | 'member')}
                  style={inputStyle()}>
                  <option value="member">Member</option>
                  <option value="owner">Owner</option>
                </select>
              </label>
              <button onClick={sendInvite} disabled={inviting || !inviteEmail.trim()}
                style={{
                  padding:'8px 14px',borderRadius:6,
                  border:`1px solid ${T.blue}`,background:T.blue,color:'#fff',
                  fontSize:13,fontWeight:500,fontFamily:'inherit',
                  cursor: inviting || !inviteEmail.trim() ? 'not-allowed' : 'pointer',
                  opacity: inviting || !inviteEmail.trim() ? 0.6 : 1,
                  height: 36,
                }}>
                {inviting ? 'Sending…' : 'Send invite'}
              </button>
            </div>
            <div style={{fontSize:10,color:T.text3,marginTop:8,lineHeight:1.5}}>
              They'll receive a magic-link email. Members can browse / order on your behalf; owners can also manage the team.
            </div>
            {inviteError && (
              <div style={{marginTop:8,padding:8,background:`${T.red}15`,border:`1px solid ${T.red}40`,borderRadius:5,color:T.red,fontSize:12}}>
                {inviteError}
              </div>
            )}
            {inviteFlash && (
              <div style={{marginTop:8,padding:8,background:`${T.green}15`,border:`1px solid ${T.green}40`,borderRadius:5,color:T.green,fontSize:12}}>
                {inviteFlash}
              </div>
            )}
          </div>
        )}

        {/* Users table */}
        {!loading && users.length === 0 && (
          <div style={{padding:36,textAlign:'center',color:T.text3,fontSize:13,background:T.bg2,border:`1px solid ${T.border}`,borderRadius:10}}>
            No users yet.
          </div>
        )}

        {users.length > 0 && (
          <div style={{
            background:T.bg2,border:`1px solid ${T.border}`,borderRadius:10,overflow:'hidden',
          }}>
            <table style={{width:'100%',borderCollapse:'collapse',fontSize:13}}>
              <thead>
                <tr style={{borderBottom:`1px solid ${T.border2}`}}>
                  <th style={th()}>User</th>
                  <th style={th(140)}>Role</th>
                  <th style={th(140)}>Last login</th>
                  <th style={{...th(100),textAlign:'center'}}>Active</th>
                  {isOwner && <th style={th(60)}></th>}
                </tr>
              </thead>
              <tbody>
                {users.map((u, i) => {
                  const isMe = u.id === b2bUser.id
                  const busy = busyUserId === u.id
                  return (
                    <tr key={u.id} style={{
                      borderTop: i > 0 ? `1px solid ${T.border}` : 'none',
                      opacity: busy ? 0.6 : 1,
                    }}>
                      <td style={td()}>
                        <div style={{fontSize:13,color:T.text}}>
                          {u.full_name || <span style={{color:T.text3,fontStyle:'italic'}}>no name</span>}
                          {isMe && <span style={{marginLeft:6,fontSize:10,color:T.blue}}>· you</span>}
                        </div>
                        <div style={{fontSize:11,color:T.text3,fontFamily:'monospace',marginTop:2}}>{u.email}</div>
                        {u.last_login_at == null && u.invited_at && (
                          <div style={{fontSize:10,color:T.amber,marginTop:3}}>⏳ Invite sent — not yet accepted</div>
                        )}
                      </td>
                      <td style={td()}>
                        {isOwner ? (
                          <select
                            value={u.role}
                            disabled={busy || isMe}
                            onChange={e => patchUser(u.id, { role: e.target.value as 'owner' | 'member' })}
                            style={{
                              ...inputStyle(),
                              padding:'5px 8px',fontSize:12,
                              opacity: isMe ? 0.6 : 1,
                              cursor: isMe ? 'not-allowed' : 'pointer',
                            }}>
                            <option value="member">Member</option>
                            <option value="owner">Owner</option>
                          </select>
                        ) : (
                          <span style={{fontSize:12,color: u.role === 'owner' ? T.blue : T.text2}}>
                            {u.role === 'owner' ? 'Owner' : 'Member'}
                          </span>
                        )}
                      </td>
                      <td style={td()}>
                        <span style={{fontSize:11,color:T.text3,fontFamily:'monospace'}}>
                          {u.last_login_at ? new Date(u.last_login_at).toLocaleDateString('en-AU') : '—'}
                        </span>
                      </td>
                      <td style={{...td(),textAlign:'center'}}>
                        {isOwner && !isMe ? (
                          <ToggleSwitch
                            on={u.is_active}
                            disabled={busy}
                            onChange={v => patchUser(u.id, { is_active: v })}
                          />
                        ) : (
                          <span style={{
                            display:'inline-block',padding:'2px 8px',borderRadius:8,fontSize:10,
                            background: u.is_active ? `${T.green}18` : `${T.text3}18`,
                            color: u.is_active ? T.green : T.text3,
                          }}>
                            {u.is_active ? 'Active' : 'Inactive'}
                          </span>
                        )}
                      </td>
                      {isOwner && (
                        <td style={{...td(),textAlign:'right'}}>
                          {!isMe && (
                            <button onClick={() => removeUser(u)} disabled={busy}
                              style={{padding:'4px 8px',background:'transparent',border:'none',color:T.red,fontSize:11,cursor:'pointer',fontFamily:'inherit'}}>
                              Remove
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </B2BLayout>
    </>
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

function th(width?: number): React.CSSProperties {
  return {
    fontSize:10,color:T.text3,padding:'10px 12px',
    textAlign:'left',fontWeight:500,
    textTransform:'uppercase',letterSpacing:'0.05em',
    width,whiteSpace:'nowrap',background:T.bg2,
  }
}
function td(): React.CSSProperties {
  return { padding:'12px',verticalAlign:'middle' }
}
function inputStyle(): React.CSSProperties {
  return {
    background:T.bg3,border:`1px solid ${T.border2}`,color:T.text,
    borderRadius:5,padding:'7px 10px',fontSize:13,outline:'none',fontFamily:'inherit',
  }
}

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  return await requireB2BPageAuth(ctx) as any
}
