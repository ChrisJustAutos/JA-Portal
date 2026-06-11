// components/crm/UserFilter.tsx
// Per-person scope pills for the Leads and Tasks boards: Everyone · Me · one
// pill per staff member (first name + initial avatar), so a manager can flip
// between each salesperson's board instead of just mine/everyone.

import { T } from './CrmShell'

export interface FilterUser { id: string; display_name: string | null; email: string }

export default function UserFilter({ users, value, currentUserId, onChange }: {
  users: FilterUser[]
  value: string            // 'all' | 'me' | <user id>
  currentUserId: string
  onChange: (v: string) => void
}) {
  const firstName = (u: FilterUser) => (u.display_name || u.email).split(/[\s@]/)[0]
  const others = users.filter(u => u.id !== currentUserId)
  const pill = (key: string, label: string, initial?: string) => {
    const on = value === key
    return (
      <button key={key} onClick={() => onChange(key)} style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        background: on ? T.bg4 : 'transparent', border: `1px solid ${on ? T.border2 : 'transparent'}`,
        cursor: 'pointer', color: on ? T.text : T.text2, fontSize: 12, fontFamily: 'inherit',
        padding: '5px 12px', borderRadius: 6, whiteSpace: 'nowrap', fontWeight: on ? 600 : 400,
      }}>
        {initial && (
          <span style={{ width: 16, height: 16, borderRadius: '50%', background: on ? T.accent : T.bg4, color: on ? '#fff' : T.text2, fontSize: 9, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700 }}>
            {initial}
          </span>
        )}
        {label}
      </button>
    )
  }
  return (
    <div style={{ display: 'flex', background: T.bg3, borderRadius: 7, padding: 2, gap: 2, overflowX: 'auto', maxWidth: '100%' }}>
      {pill('all', 'Everyone')}
      {pill('me', 'Mine')}
      {others.map(u => pill(u.id, firstName(u), firstName(u).charAt(0).toUpperCase()))}
    </div>
  )
}
