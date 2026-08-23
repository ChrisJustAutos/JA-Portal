// components/settings/LeaveNotificationsTab.tsx
//
// Settings → Leave Notifications. The leave-approval emailer (a 15-minute cron
// reading the monday "Payroll & Leave Applications" board) resolves the
// applicant's address from the board's Email Address column, and falls back to
// the staff directory edited here — which is what makes it work for the rows
// managers hand-create with no address at all.
//
// Three parts: the switch + HR address, the directory, and the send log (where
// "No address" rows are the queue: add the name below and the next run sends).

import { useCallback, useEffect, useState } from 'react'
import { Card, StatusPill, inp, pbtn, miniBtn, T } from '../ui'
import { useToast, useConfirm } from '../ui/Feedback'

interface DirRow { id: string; match_name: string; match_key: string; email: string; note: string | null; updated_at: string }
interface LogRow {
  id: string; monday_item_id: string; decision: 'approved' | 'denied'
  applicant_name: string | null; email_to: string | null; email_source: string | null
  status: 'baseline' | 'sent' | 'no_address' | 'failed'; error: string | null
  leave_start: string | null; leave_end: string | null; classification: string | null
  total_days: string | null; attempts: number; sent_at: string | null; created_at: string
}
interface Settings { hr_email: string; enabled: boolean }

const STATUS: Record<LogRow['status'], { label: string; color: string }> = {
  sent:       { label: 'Sent',       color: T.green },
  no_address: { label: 'No address', color: T.amber },
  failed:     { label: 'Failed',     color: T.red },
  baseline:   { label: 'Pre-existing', color: T.text3 },
}

const lbl: React.CSSProperties = { fontSize: 10, color: T.text3, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 5 }
const th: React.CSSProperties = { textAlign: 'left', padding: '7px 10px', fontSize: 10, color: T.text3, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', borderBottom: `1px solid ${T.border}`, whiteSpace: 'nowrap' }
const td: React.CSSProperties = { padding: '7px 10px', fontSize: 12, borderBottom: `1px solid ${T.border}`, verticalAlign: 'middle' }

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso.length <= 10 ? `${iso}T00:00:00` : iso)
  if (isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: '2-digit' })
}

export default function LeaveNotificationsTab() {
  const toast = useToast()
  const confirmDialog = useConfirm()

  const [settings, setSettings] = useState<Settings>({ hr_email: '', enabled: true })
  const [directory, setDirectory] = useState<DirRow[]>([])
  const [log, setLog] = useState<LogRow[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')

  // Inline add/edit form for a directory entry.
  const [editId, setEditId] = useState<string | null>(null)
  const [fName, setFName] = useState('')
  const [fEmail, setFEmail] = useState('')
  const [fNote, setFNote] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await fetch('/api/admin/leave-notifications', { credentials: 'same-origin' })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`)
      setSettings(d.settings)
      setDirectory(d.directory || [])
      setLog(d.log || [])
    } catch (e: any) {
      toast(e?.message || 'Failed to load', 'error')
    } finally { setLoading(false) }
  }, [toast])
  useEffect(() => { load() }, [load])

  async function patchSettings(next: Partial<Settings>) {
    setBusy('settings')
    try {
      const r = await fetch('/api/admin/leave-notifications', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin', body: JSON.stringify({ settings: next }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`)
      setSettings(s => ({ ...s, ...next }))
      toast('Saved', 'success')
    } catch (e: any) { toast(e?.message || 'Save failed', 'error') }
    setBusy('')
  }

  async function post(body: any, label: string) {
    setBusy(label)
    try {
      const r = await fetch('/api/admin/leave-notifications', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin', body: JSON.stringify(body),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`)
      return d
    } finally { setBusy('') }
  }

  function startEdit(row: DirRow) {
    setEditId(row.id); setFName(row.match_name); setFEmail(row.email); setFNote(row.note || '')
  }
  function resetForm() { setEditId(null); setFName(''); setFEmail(''); setFNote('') }

  async function saveEntry() {
    try {
      await post({ action: 'save_entry', id: editId || undefined, match_name: fName, email: fEmail, note: fNote }, 'entry')
      toast(editId ? 'Entry updated' : 'Added to the directory', 'success')
      resetForm(); load()
    } catch (e: any) { toast(e?.message || 'Save failed', 'error') }
  }

  async function deleteEntry(row: DirRow) {
    if (!(await confirmDialog({ title: `Remove ${row.match_name} from the directory?`, message: 'Approvals for that name will need an address on the board instead.' }))) return
    try {
      await post({ action: 'delete_entry', id: row.id }, 'entry')
      toast('Removed', 'success'); load()
    } catch (e: any) { toast(e?.message || 'Delete failed', 'error') }
  }

  async function run(dry: boolean) {
    try {
      const d = await post({ action: dry ? 'dry_run' : 'run_now' }, dry ? 'dry' : 'run')
      const r = d.result || {}
      if (!r.enabled) { toast('Leave emails are switched off — nothing was sent', 'info'); return }
      if (r.seeded) { toast(`First run: ${r.seeded} existing applications recorded, none emailed`, 'success'); load(); return }
      const bits = [
        `${r.sent || 0} ${dry ? 'would send' : 'sent'}`,
        r.noAddress ? `${r.noAddress} without an address` : '',
        r.failed ? `${r.failed} failed` : '',
      ].filter(Boolean)
      toast(bits.join(' · ') || 'Nothing to do', r.failed ? 'error' : 'success')
      load()
    } catch (e: any) { toast(e?.message || 'Run failed', 'error') }
  }

  const unresolved = log.filter(l => l.status === 'no_address')

  if (loading) return <div style={{ padding: 30, textAlign: 'center', color: T.text3, fontSize: 12 }}>Loading…</div>

  return (
    <div>
      <Card title="Leave decision emails" pad
        hint="Every 15 minutes the portal reads the monday “Payroll & Leave Applications” board. Any application newly marked Approved or Denied emails the applicant once — copied to the address below, which is also the reply-to. Changing an application from Approved to Denied (or back) counts as a new decision and emails again.">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 20, alignItems: 'flex-end' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, cursor: 'pointer' }}>
            <input type="checkbox" checked={settings.enabled} disabled={busy === 'settings'}
              onChange={e => patchSettings({ enabled: e.target.checked })} />
            <span>{settings.enabled ? 'On — approvals and declines are emailed' : 'Off — nothing is emailed'}</span>
          </label>
          <div>
            <div style={lbl}>HR copy / reply-to</div>
            <div style={{ display: 'flex', gap: 6 }}>
              <input value={settings.hr_email} onChange={e => setSettings(s => ({ ...s, hr_email: e.target.value }))}
                style={{ ...inp, width: 280 }} placeholder="ryan@justautosmechanical.com.au" />
              <button onClick={() => patchSettings({ hr_email: settings.hr_email })} disabled={busy === 'settings'} style={pbtn(T.blue)}>Save</button>
            </div>
          </div>
          <div style={{ flex: 1 }} />
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={() => run(true)} disabled={!!busy} style={pbtn(T.text2)}>{busy === 'dry' ? 'Checking…' : 'Dry run'}</button>
            <button onClick={() => run(false)} disabled={!!busy} style={pbtn(T.green)}>{busy === 'run' ? 'Running…' : 'Run now'}</button>
          </div>
        </div>
        <div style={{ fontSize: 11, color: T.text3, marginTop: 10, lineHeight: 1.5 }}>
          A dry run resolves every decided application and reports who <em>would</em> be emailed without sending anything — the safe way to check the directory.
        </div>
      </Card>

      {unresolved.length > 0 && (
        <Card title="Waiting on an email address" count={unresolved.length}
          hint="These applications were decided but the portal couldn’t work out where to email the applicant. Add the name to the directory below (or fill in the board’s Email Address column) and the next run sends them — no need to re-approve anything.">
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><th style={th}>Applicant</th><th style={th}>Decision</th><th style={th}>Leave</th><th style={th}>Tries</th><th style={th}/></tr></thead>
            <tbody>
              {unresolved.map(l => (
                <tr key={l.id}>
                  <td style={{ ...td, fontWeight: 600 }}>{l.applicant_name || '—'}</td>
                  <td style={td}><StatusPill label={l.decision} color={l.decision === 'approved' ? T.green : T.red} /></td>
                  <td style={{ ...td, color: T.text2 }}>{fmtDate(l.leave_start)}{l.leave_end && l.leave_end !== l.leave_start ? ` → ${fmtDate(l.leave_end)}` : ''}</td>
                  <td style={{ ...td, color: T.text3 }}>{l.attempts}</td>
                  <td style={td}>
                    <button style={miniBtn(T.blue)} onClick={() => { setEditId(null); setFName(l.applicant_name || ''); setFEmail(''); setFNote('added from an unresolved approval') }}>
                      Add address
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <Card title="Staff directory" count={directory.length}
        hint="Name as it appears on the board → email. The board’s own Email Address column always wins when it holds a sensible address; this is the fallback for the rows managers create by hand. Matching ignores case and punctuation, tolerates a trailing “Sick”/“Annual Leave”, and accepts short forms like “Chris R”. A first name on its own only matches when exactly one person in the directory has it — “Matt” stays unresolved on purpose.">
        <div style={{ padding: '12px 14px', borderBottom: `1px solid ${T.border}`, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div>
            <div style={lbl}>Name on the board</div>
            <input value={fName} onChange={e => setFName(e.target.value)} style={{ ...inp, width: 200 }} placeholder="Callan O" />
          </div>
          <div>
            <div style={lbl}>Email</div>
            <input value={fEmail} onChange={e => setFEmail(e.target.value)} style={{ ...inp, width: 260 }} placeholder="callan@justautosmechanical.com.au" />
          </div>
          <div style={{ flex: 1, minWidth: 140 }}>
            <div style={lbl}>Note (optional)</div>
            <input value={fNote} onChange={e => setFNote(e.target.value)} style={{ ...inp, width: '100%' }} placeholder="workshop" />
          </div>
          <button onClick={saveEntry} disabled={busy === 'entry'} style={pbtn(T.green)}>{editId ? 'Update' : 'Add'}</button>
          {editId && <button onClick={resetForm} style={pbtn(T.text2)}>Cancel</button>}
        </div>
        <div style={{ maxHeight: 340, overflowY: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><th style={th}>Name</th><th style={th}>Email</th><th style={th}>Note</th><th style={th}/></tr></thead>
            <tbody>
              {directory.map(d => (
                <tr key={d.id} style={{ background: editId === d.id ? T.bg3 : undefined }}>
                  <td style={{ ...td, fontWeight: 600 }}>{d.match_name}</td>
                  <td style={{ ...td, color: T.text2 }}>{d.email}</td>
                  <td style={{ ...td, color: T.text3, fontSize: 11 }}>{d.note || ''}</td>
                  <td style={{ ...td, whiteSpace: 'nowrap', textAlign: 'right' }}>
                    <button style={{ ...miniBtn(T.blue), marginRight: 6 }} onClick={() => startEdit(d)}>Edit</button>
                    <button style={miniBtn(T.red)} onClick={() => deleteEntry(d)}>Remove</button>
                  </td>
                </tr>
              ))}
              {!directory.length && <tr><td colSpan={4} style={{ ...td, color: T.text3, textAlign: 'center' }}>Nobody in the directory yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Recent decisions" count={log.length}
        hint="One row per application per decision — the emailer’s own record, which is also what stops anyone being emailed twice. “Pre-existing” rows were already decided when this went live and were deliberately never emailed.">
        <div style={{ maxHeight: 420, overflowY: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>
              <th style={th}>When</th><th style={th}>Applicant</th><th style={th}>Decision</th>
              <th style={th}>Emailed</th><th style={th}>Status</th><th style={th}>Detail</th>
            </tr></thead>
            <tbody>
              {log.map(l => (
                <tr key={l.id}>
                  <td style={{ ...td, color: T.text3, whiteSpace: 'nowrap' }}>{fmtDate(l.sent_at || l.created_at)}</td>
                  <td style={{ ...td, fontWeight: 600 }}>
                    <a href={`https://just-autos.monday.com/boards/5027074711/pulses/${l.monday_item_id}`} target="_blank" rel="noreferrer" style={{ color: T.text, textDecoration: 'none' }}>
                      {l.applicant_name || '—'}
                    </a>
                  </td>
                  <td style={td}><StatusPill label={l.decision} color={l.decision === 'approved' ? T.green : T.red} /></td>
                  <td style={{ ...td, color: T.text2 }}>
                    {l.email_to || '—'}
                    {l.email_source === 'directory' && <span style={{ color: T.text3, fontSize: 10 }}> (directory)</span>}
                  </td>
                  <td style={td}><StatusPill label={STATUS[l.status].label} color={STATUS[l.status].color} /></td>
                  <td style={{ ...td, color: T.text3, fontSize: 11 }}>{l.error || (l.classification || '')}</td>
                </tr>
              ))}
              {!log.length && <tr><td colSpan={6} style={{ ...td, color: T.text3, textAlign: 'center' }}>Nothing yet — the first run records what’s already been decided without emailing anyone.</td></tr>}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}
