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
import { useConfirm, useToast } from '../../components/ui/Feedback'
import { T } from '../../lib/ui/theme'
import { A, Banner, Btn, Card, EmptyState, Field, PageTitle, StatusPill, btnStyle, inputStyle } from '../../components/b2b/ui'

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
  const toast = useToast()
  const confirmDialog = useConfirm()
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
      toast(e?.message || 'Update failed', 'error')
    } finally {
      setBusyUserId(null)
    }
  }

  async function removeUser(u: TeamUser) {
    if (!(await confirmDialog({ title: `Remove ${u.full_name || u.email} from your team?`, message: "They'll lose access immediately.", danger: true }))) return
    setBusyUserId(u.id)
    try {
      const r = await fetch(`/api/b2b/team/users/${u.id}`, { method: 'DELETE', credentials: 'same-origin' })
      const j = await r.json()
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`)
      setUsers(prev => prev.filter(x => x.id !== u.id))
    } catch (e: any) {
      toast(e?.message || 'Remove failed', 'error')
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
        <PageTitle
          sub={isOwner
            ? 'Invite your team or change their roles. Owners can manage; members can browse.'
            : 'Read-only — only owners can invite or change roles.'}
          action={isOwner && !inviteOpen
            ? <Btn onClick={() => setInviteOpen(true)}>Invite user</Btn>
            : undefined}>
          Team
        </PageTitle>

        {error && <div style={{ marginBottom: 14 }}><Banner tone="error">{error}</Banner></div>}

        {/* Invite form */}
        {isOwner && inviteOpen && (
          <Card style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <div style={{ fontSize: 14, fontWeight: 650 }}>Invite a new user</div>
              <button onClick={() => { setInviteOpen(false); setInviteError(null) }} aria-label="Close" className="al-press"
                style={{ background: 'transparent', border: 'none', color: T.text3, fontSize: 18, cursor: 'pointer', padding: '0 2px', fontFamily: 'inherit', lineHeight: 1 }}>×</button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
              <Field label="Email">
                <input type="email" value={inviteEmail} onChange={e => setInviteEmail(e.target.value)}
                  placeholder="them@example.com" style={inputStyle()}/>
              </Field>
              <Field label="Full name (optional)">
                <input type="text" value={inviteName} onChange={e => setInviteName(e.target.value)} style={inputStyle()}/>
              </Field>
              <Field label="Role">
                <select value={inviteRole} onChange={e => setInviteRole(e.target.value as 'owner' | 'member')}
                  style={{ ...inputStyle(), cursor: 'pointer' }}>
                  <option value="member">Member</option>
                  <option value="owner">Owner</option>
                </select>
              </Field>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 14, flexWrap: 'wrap' }}>
              <Btn onClick={sendInvite} disabled={inviting || !inviteEmail.trim()}>
                {inviting ? 'Sending…' : 'Send invite'}
              </Btn>
              <div style={{ fontSize: 12.5, color: T.text3, lineHeight: 1.5, flex: 1, minWidth: 200 }}>
                They'll receive a magic-link email. Members can browse / order on your behalf; owners can also manage the team.
              </div>
            </div>
            {inviteError && <div style={{ marginTop: 12 }}><Banner tone="error">{inviteError}</Banner></div>}
            {inviteFlash && <div style={{ marginTop: 12 }}><Banner tone="success">{inviteFlash}</Banner></div>}
          </Card>
        )}

        {/* Users table */}
        {!loading && users.length === 0 && (
          <EmptyState title="No users yet" />
        )}

        {users.length > 0 && (
          <Card pad={false}>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 560 }}>
                <thead>
                  <tr style={{ borderBottom: `1px solid ${T.border2}` }}>
                    <th style={th()}>User</th>
                    <th style={th(140)}>Role</th>
                    <th style={th(140)}>Last login</th>
                    <th style={{ ...th(100), textAlign: 'center' }}>Active</th>
                    {isOwner && <th style={th(90)}></th>}
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
                          <div style={{ fontSize: 13.5, color: T.text, fontWeight: 550 }}>
                            {u.full_name || <span style={{ color: T.text3, fontStyle: 'italic' }}>no name</span>}
                            {isMe && <span style={{ marginLeft: 6, fontSize: 12, color: A.accent }}>· you</span>}
                          </div>
                          <div style={{ fontSize: 12.5, color: T.text3, marginTop: 2 }}>{u.email}</div>
                          {u.last_login_at == null && u.invited_at && (
                            <div style={{ fontSize: 12, color: A.warn, marginTop: 3 }}>Invite sent — not yet accepted</div>
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
                                opacity: isMe ? 0.6 : 1,
                                cursor: isMe ? 'not-allowed' : 'pointer',
                              }}>
                              <option value="member">Member</option>
                              <option value="owner">Owner</option>
                            </select>
                          ) : (
                            <span style={{ fontSize: 13, color: u.role === 'owner' ? A.accent : T.text2 }}>
                              {u.role === 'owner' ? 'Owner' : 'Member'}
                            </span>
                          )}
                        </td>
                        <td style={td()}>
                          <span style={{ fontSize: 12.5, color: T.text3, fontVariantNumeric: 'tabular-nums' }}>
                            {u.last_login_at ? new Date(u.last_login_at).toLocaleDateString('en-AU') : '—'}
                          </span>
                        </td>
                        <td style={{ ...td(), textAlign: 'center' }}>
                          {isOwner && !isMe ? (
                            <ToggleSwitch
                              on={u.is_active}
                              disabled={busy}
                              onChange={v => patchUser(u.id, { is_active: v })}
                            />
                          ) : (
                            <StatusPill color={u.is_active ? A.good : T.text3}>
                              {u.is_active ? 'Active' : 'Inactive'}
                            </StatusPill>
                          )}
                        </td>
                        {isOwner && (
                          <td style={{ ...td(), textAlign: 'right' }}>
                            {!isMe && (
                              <button onClick={() => removeUser(u)} disabled={busy} className="al-press al-focus"
                                style={{ ...btnStyle('ghost', 'sm', busy), color: A.bad }}>
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
          </Card>
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
      className="al-press al-focus"
      aria-label={on ? 'Deactivate' : 'Activate'}
      style={{
        width: 44, height: 24, borderRadius: 12, border: 'none', padding: 2,
        background: on ? A.good : T.bg4,
        cursor: disabled ? 'wait' : 'pointer',
        position: 'relative', transition: 'background 0.15s',
        opacity: disabled ? 0.5 : 1,
      }}>
      <div style={{
        position: 'absolute', top: 2, left: on ? 22 : 2,
        width: 20, height: 20, borderRadius: '50%',
        background: '#fff', transition: 'left 0.15s ease',
      }}/>
    </button>
  )
}

function th(width?: number): React.CSSProperties {
  return {
    fontSize: 12, color: T.text3, padding: '13px 14px',
    textAlign: 'left', fontWeight: 600,
    width, whiteSpace: 'nowrap', background: T.bg2,
  }
}
function td(): React.CSSProperties {
  return { padding: '13px 14px', verticalAlign: 'middle' }
}

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  return await requireB2BPageAuth(ctx) as any
}
