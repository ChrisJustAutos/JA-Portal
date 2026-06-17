// components/workshop/PackagePicker.tsx
// A "+ Package" button + dropdown that lists job-type packages. Picking one
// calls onPick(packageId) — the parent applies it to the current quote or
// booking (POST /api/workshop/job-type-packages/[id]/apply). Shared by the
// quote builder and the job/invoice page.

import { useEffect, useState } from 'react'
import { T } from '../../lib/ui/theme'

export default function PackagePicker({ busy, onPick }: { busy?: boolean; onPick: (pkg: { id: string; name: string }) => void }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [packages, setPackages] = useState<any[]>([])
  useEffect(() => {
    fetch('/api/workshop/job-type-packages').then(r => r.json())
      .then(d => setPackages((d.packages || []).filter((p: any) => p.active !== false)))
      .catch(() => undefined)
  }, [])

  const needle = q.trim().toLowerCase()
  const results = (needle ? packages.filter(p => (p.name || '').toLowerCase().includes(needle)) : packages).slice(0, 60)
  const btn: React.CSSProperties = { padding: '6px 12px', borderRadius: 6, fontSize: 12, fontFamily: 'inherit', fontWeight: 600, cursor: busy ? 'wait' : 'pointer', background: 'transparent', color: T.purple, border: `1px solid ${T.purple}55` }

  if (!open) return <button onClick={() => setOpen(true)} disabled={busy} style={btn} title="Apply a package — drops in all its job types at once">{busy ? 'Adding…' : '+ Package'}</button>
  return (
    <div style={{ position: 'relative' }}>
      <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Search packages…" onBlur={() => setTimeout(() => setOpen(false), 200)}
        style={{ width: 220, padding: '6px 8px', background: T.bg3, border: `1px solid ${T.border2}`, borderRadius: 6, color: T.text, fontSize: 12, fontFamily: 'inherit', outline: 'none' }} />
      <div style={{ position: 'absolute', bottom: '100%', left: 0, width: 340, background: T.bg3, border: `1px solid ${T.border2}`, borderRadius: 6, marginBottom: 4, maxHeight: 280, overflowY: 'auto', zIndex: 10 }}>
        {results.length === 0 && <div style={{ padding: '10px 12px', fontSize: 11, color: T.text3 }}>{packages.length === 0 ? 'No packages yet — create them in Jobs → Packages.' : 'No matches.'}</div>}
        {results.map(p => {
          const items: any[] = Array.isArray(p.items) ? p.items : []
          const names = items.map(i => i.name).filter(Boolean)
          return (
            <div key={p.id} onMouseDown={() => { onPick({ id: p.id, name: p.name }); setOpen(false); setQ('') }} style={{ padding: '7px 10px', fontSize: 12, cursor: 'pointer', borderBottom: `1px solid ${T.border}` }}>
              <div style={{ color: T.text }}>{p.name}</div>
              <div style={{ fontSize: 10, color: T.text3 }}>
                {items.length} job type{items.length === 1 ? '' : 's'}{names.length ? ` · ${names.slice(0, 4).join(', ')}${names.length > 4 ? '…' : ''}` : ''}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
