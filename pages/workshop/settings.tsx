// pages/workshop/settings.tsx
// Workshop settings (admin) — the configurable heart of the workshop system so
// it can be run by anyone without code changes. Sections:
//   • Business & documents — letterhead/footer on printed + emailed PDFs
//   • Invoicing (MYOB)      — sales account + order/invoice mode
//   • SMS reminders         — provider toggle, sender, lead time
//   • Technicians & staff   — diary lanes: add/edit/remove, exclude from diary,
//                             per-lane daily capacity + colour
// All settings live in workshop_settings / workshop_technicians via gated APIs.

import { useEffect, useState, useCallback } from 'react'
import Head from 'next/head'
import Link from 'next/link'
import PortalTopBar from '../../lib/PortalTopBar'
import { requirePageAuth } from '../../lib/authServer'

interface PortalUserSSR { id: string; email: string; displayName: string | null; role: 'admin'|'manager'|'sales'|'accountant'|'viewer'; visibleTabs?: string[] | null }

const T = {
  bg: '#0d0f12', bg2: '#131519', bg3: '#1a1d23', bg4: '#21252d',
  border: 'rgba(255,255,255,0.07)', border2: 'rgba(255,255,255,0.12)',
  text: '#e8eaf0', text2: '#8b90a0', text3: '#545968',
  blue: '#4f8ef7', teal: '#2dd4bf', green: '#34c77b', amber: '#f5a623', red: '#f04e4e', purple: '#a78bfa', accent: '#4f8ef7',
}
const inp: React.CSSProperties = { width: '100%', padding: '7px 9px', background: T.bg3, border: `1px solid ${T.border}`, borderRadius: 6, color: T.text, fontSize: 13, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box', colorScheme: 'dark' }
const cellInp: React.CSSProperties = { ...inp, padding: '5px 7px', borderRadius: 4, fontSize: 12 }
function pbtn(color: string, solid?: boolean): React.CSSProperties {
  return { padding: '7px 14px', borderRadius: 6, fontSize: 12, fontFamily: 'inherit', fontWeight: 600, cursor: 'pointer', background: solid ? color : 'transparent', color: solid ? '#fff' : color, border: `1px solid ${solid ? color : color + '55'}` }
}

type Tab = 'business' | 'invoicing' | 'sms' | 'techs'
const TABS: { id: Tab; label: string }[] = [
  { id: 'business', label: 'Business & documents' },
  { id: 'invoicing', label: 'Invoicing (MYOB)' },
  { id: 'sms', label: 'SMS reminders' },
  { id: 'techs', label: 'Technicians & staff' },
]

export default function WorkshopSettingsPage({ user }: { user: PortalUserSSR }) {
  const [tab, setTab] = useState<Tab>('business')
  const [settings, setSettings] = useState<any | null>(null)
  const [accounts, setAccounts] = useState<any[]>([])
  const [accountsError, setAccountsError] = useState('')
  const [techs, setTechs] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [flash, setFlash] = useState('')

  const loadSettings = useCallback(async () => {
    const r = await fetch('/api/workshop/settings')
    if (r.ok) { const d = await r.json(); setSettings(d.settings); setAccounts(d.incomeAccounts || []); setAccountsError(d.accountsError || '') }
  }, [])
  const loadTechs = useCallback(async () => {
    const r = await fetch('/api/workshop/technicians')
    if (r.ok) { const d = await r.json(); setTechs(d.technicians || []) }
  }, [])
  useEffect(() => { Promise.all([loadSettings(), loadTechs()]).finally(() => setLoading(false)) }, [loadSettings, loadTechs])

  function flashSaved() { setFlash('Saved ✓'); setTimeout(() => setFlash(''), 2000) }

  async function saveSettings(patch: any) {
    const r = await fetch('/api/workshop/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) })
    if (r.ok) { const d = await r.json(); setSettings(d.settings); flashSaved() }
    else { const d = await r.json().catch(() => ({})); setFlash(d.error || 'Save failed'); setTimeout(() => setFlash(''), 3000) }
  }

  async function addTech(name: string) {
    const r = await fetch('/api/workshop/technicians', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, sort_order: (techs.length + 1) * 10 }) })
    if (r.ok) await loadTechs()
    else { const d = await r.json().catch(() => ({})); setFlash(d.error || 'Add failed'); setTimeout(() => setFlash(''), 3000) }
  }
  async function patchTech(id: string, patch: any) {
    const r = await fetch(`/api/workshop/technicians?id=${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) })
    if (r.ok) { setTechs(ts => ts.map(t => t.id === id ? { ...t, ...patch } : t)); flashSaved() }
    else { const d = await r.json().catch(() => ({})); setFlash(d.error || 'Save failed'); setTimeout(() => setFlash(''), 3000); await loadTechs() }
  }
  async function removeTech(id: string, name: string) {
    if (!confirm(`Remove ${name}? If they have bookings they’ll be retired (hidden) instead of deleted.`)) return
    const r = await fetch(`/api/workshop/technicians?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
    const d = await r.json().catch(() => ({}))
    if (r.ok) { setFlash(d.retired ? `Retired (${d.bookings} bookings kept)` : 'Removed'); setTimeout(() => setFlash(''), 2500); await loadTechs() }
    else { setFlash(d.error || 'Remove failed'); setTimeout(() => setFlash(''), 3000) }
  }

  return (
    <>
      <Head><title>Workshop Settings — Just Autos</title><meta name="viewport" content="width=device-width,initial-scale=1"/><meta name="robots" content="noindex,nofollow"/></Head>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden', fontFamily: "'DM Sans',system-ui,sans-serif", color: T.text }}>
        <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet"/>
        <PortalTopBar activeId="workshop-settings" currentUserRole={user.role} currentUserVisibleTabs={user.visibleTabs} currentUserName={user.displayName} currentUserEmail={user.email} />

        <div style={{ flex: 1, overflow: 'auto', background: T.bg, padding: 20 }}>
          <div style={{ maxWidth: 960, margin: '0 auto' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
              <Link href="/diary" style={{ fontSize: 12, color: T.text2, textDecoration: 'none' }}>‹ Back to diary</Link>
              {flash && <span style={{ fontSize: 12, color: flash.includes('✓') || flash.startsWith('Saved') || flash.startsWith('Retired') || flash.startsWith('Removed') ? T.green : T.amber }}>{flash}</span>}
            </div>
            <h1 style={{ fontSize: 22, fontWeight: 600, margin: '4px 0 16px' }}>Workshop settings</h1>

            {loading ? <div style={{ color: T.text3, padding: 40, textAlign: 'center' }}>Loading…</div> : (
              <div style={{ display: 'grid', gridTemplateColumns: '210px 1fr', gap: 18, alignItems: 'start' }}>
                {/* Section rail */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, position: 'sticky', top: 0 }}>
                  {TABS.map(t => (
                    <button key={t.id} onClick={() => setTab(t.id)} style={{
                      textAlign: 'left', padding: '9px 12px', borderRadius: 7, fontSize: 13, fontFamily: 'inherit', cursor: 'pointer',
                      background: tab === t.id ? T.bg3 : 'transparent', color: tab === t.id ? T.text : T.text2,
                      border: `1px solid ${tab === t.id ? T.border2 : 'transparent'}`, fontWeight: tab === t.id ? 600 : 400,
                    }}>{t.label}</button>
                  ))}
                </div>

                {/* Panel */}
                <div>
                  {tab === 'business' && settings && <BusinessSection settings={settings} onSave={saveSettings} />}
                  {tab === 'invoicing' && settings && <InvoicingSection settings={settings} accounts={accounts} accountsError={accountsError} onSave={saveSettings} />}
                  {tab === 'sms' && settings && <SmsSection settings={settings} onSave={saveSettings} />}
                  {tab === 'techs' && <TechsSection techs={techs} onAdd={addTech} onPatch={patchTech} onRemove={removeTech} />}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  )
}

function Card({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 10, padding: 18, marginBottom: 16 }}>
      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: hint ? 2 : 12 }}>{title}</div>
      {hint && <div style={{ fontSize: 12, color: T.text3, marginBottom: 12 }}>{hint}</div>}
      {children}
    </div>
  )
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label style={{ display: 'block', marginBottom: 12 }}><div style={{ fontSize: 11, color: T.text3, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>{label}</div>{children}</label>
}

function BusinessSection({ settings, onSave }: { settings: any; onSave: (p: any) => void }) {
  const [f, setF] = useState({
    business_name: settings.business_name || '', business_abn: settings.business_abn || '',
    business_address: settings.business_address || '', business_phone: settings.business_phone || '',
    business_email: settings.business_email || '', document_footer: settings.document_footer || '',
  })
  const set = (k: string, v: string) => setF(s => ({ ...s, [k]: v }))
  return (
    <Card title="Business & documents" hint="Appears as the letterhead and footer on printed and emailed quotes, invoices and job cards.">
      <Field label="Business name"><input style={inp} value={f.business_name} onChange={e => set('business_name', e.target.value)} placeholder="Vehicle Performance Solutions" /></Field>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Field label="ABN"><input style={inp} value={f.business_abn} onChange={e => set('business_abn', e.target.value)} placeholder="00 000 000 000" /></Field>
        <Field label="Phone"><input style={inp} value={f.business_phone} onChange={e => set('business_phone', e.target.value)} placeholder="(07) 0000 0000" /></Field>
      </div>
      <Field label="Email"><input style={inp} value={f.business_email} onChange={e => set('business_email', e.target.value)} placeholder="service@…" /></Field>
      <Field label="Address"><textarea style={{ ...inp, resize: 'vertical' }} rows={2} value={f.business_address} onChange={e => set('business_address', e.target.value)} placeholder="Street, suburb, state postcode" /></Field>
      <Field label="Document footer (optional)"><textarea style={{ ...inp, resize: 'vertical' }} rows={2} value={f.document_footer} onChange={e => set('document_footer', e.target.value)} placeholder="Payment terms, bank details, thank-you note…" /></Field>
      <button onClick={() => onSave(f)} style={pbtn(T.accent, true)}>Save business details</button>
    </Card>
  )
}

function InvoicingSection({ settings, accounts, accountsError, onSave }: { settings: any; accounts: any[]; accountsError: string; onSave: (p: any) => void }) {
  const [uid, setUid] = useState(settings.myob_sales_account_uid || '')
  const [asOrder, setAsOrder] = useState(!!settings.invoice_as_order)
  return (
    <Card title="Invoicing (MYOB — VPS)" hint="Workshop jobs post to MYOB as a Service sale against this income account.">
      <Field label="Sales income account">
        <select style={inp} value={uid} onChange={e => setUid(e.target.value)}>
          <option value="">— pick income account —</option>
          {accounts.map(a => <option key={a.uid} value={a.uid}>{a.displayId} · {a.name}</option>)}
        </select>
      </Field>
      {accountsError && <div style={{ fontSize: 12, color: T.amber, marginBottom: 12 }}>Could not load MYOB accounts: {accountsError}</div>}
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, marginBottom: 14, cursor: 'pointer' }}>
        <input type="checkbox" checked={asOrder} onChange={e => setAsOrder(e.target.checked)} />
        Post as a Sale <strong>Order</strong> (no GL impact — staff convert to an invoice in MYOB). Uncheck to post a Sale <strong>Invoice</strong> directly.
      </label>
      <button onClick={() => onSave({ myob_sales_account_uid: uid || null, myob_sales_account_name: accounts.find(a => a.uid === uid)?.name || null, invoice_as_order: asOrder })} style={pbtn(T.accent, true)}>Save invoicing</button>
    </Card>
  )
}

function SmsSection({ settings, onSave }: { settings: any; onSave: (p: any) => void }) {
  const [enabled, setEnabled] = useState(!!settings.sms_enabled)
  const [from, setFrom] = useState(settings.sms_from || '')
  const [lead, setLead] = useState(String(settings.booking_reminder_lead_hours ?? 24))
  return (
    <Card title="SMS reminders (ClickSend)" hint="Automated booking reminders + manual “ready for collection” texts. Needs ClickSend credentials set in the environment.">
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, marginBottom: 14, cursor: 'pointer' }}>
        <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
        Send automatic booking reminders
      </label>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 160px', gap: 12 }}>
        <Field label="Sender ID / number (optional)"><input style={inp} value={from} onChange={e => setFrom(e.target.value)} placeholder="JustAutos" /></Field>
        <Field label="Reminder lead (hours)"><input style={inp} inputMode="numeric" value={lead} onChange={e => setLead(e.target.value)} /></Field>
      </div>
      <button onClick={() => onSave({ sms_enabled: enabled, sms_from: from, booking_reminder_lead_hours: Number(lead) || 0 })} style={pbtn(T.accent, true)}>Save SMS settings</button>
    </Card>
  )
}

function TechsSection({ techs, onAdd, onPatch, onRemove }: { techs: any[]; onAdd: (name: string) => void; onPatch: (id: string, p: any) => void; onRemove: (id: string, name: string) => void }) {
  const [newName, setNewName] = useState('')
  return (
    <Card title="Technicians & staff" hint="These are the diary lanes. Untick “Diary” to keep someone on staff but off the diary; “Active” off retires someone who has left. Daily hours sets the workload bar.">
      <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr 64px 70px 56px 50px 28px', gap: 8, padding: '0 4px 6px', fontSize: 9, color: T.text3, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
        <div>Name</div><div>Role</div><div style={{ textAlign: 'center' }}>Colour</div><div style={{ textAlign: 'right' }}>Hrs/day</div><div style={{ textAlign: 'center' }}>Diary</div><div style={{ textAlign: 'center' }}>Active</div><div/>
      </div>
      {techs.length === 0 && <div style={{ padding: 16, textAlign: 'center', fontSize: 12, color: T.text3 }}>No technicians yet — add one below.</div>}
      {techs.map(t => <TechRow key={t.id} tech={t} onPatch={(p) => onPatch(t.id, p)} onRemove={() => onRemove(t.id, t.name)} />)}
      <div style={{ display: 'flex', gap: 8, marginTop: 14, paddingTop: 14, borderTop: `1px solid ${T.border}` }}>
        <input style={{ ...inp, flex: 1 }} value={newName} onChange={e => setNewName(e.target.value)} placeholder="New technician / staff name" onKeyDown={e => { if (e.key === 'Enter' && newName.trim()) { onAdd(newName.trim()); setNewName('') } }} />
        <button onClick={() => { if (newName.trim()) { onAdd(newName.trim()); setNewName('') } }} style={pbtn(T.accent, true)}>+ Add</button>
      </div>
    </Card>
  )
}

function TechRow({ tech, onPatch, onRemove }: { tech: any; onPatch: (p: any) => void; onRemove: () => void }) {
  const [name, setName] = useState(tech.name || '')
  const [role, setRole] = useState(tech.role || '')
  const [hours, setHours] = useState(String(tech.daily_hours ?? 8))
  useEffect(() => { setName(tech.name || ''); setRole(tech.role || ''); setHours(String(tech.daily_hours ?? 8)) }, [tech.id, tech.name, tech.role, tech.daily_hours])
  const dim = !tech.active ? 0.5 : 1
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr 64px 70px 56px 50px 28px', gap: 8, padding: '6px 4px', borderTop: `1px solid ${T.border}`, alignItems: 'center', opacity: dim }}>
      <input style={cellInp} value={name} onChange={e => setName(e.target.value)} onBlur={() => name !== (tech.name || '') && name.trim() && onPatch({ name })} />
      <input style={cellInp} value={role} onChange={e => setRole(e.target.value)} onBlur={() => role !== (tech.role || '') && onPatch({ role })} placeholder="Technician" />
      <input type="color" value={tech.color || '#4f8ef7'} onChange={e => onPatch({ color: e.target.value })} style={{ width: 30, height: 26, padding: 0, border: `1px solid ${T.border}`, borderRadius: 4, background: T.bg3, cursor: 'pointer', justifySelf: 'center' }} />
      <input style={{ ...cellInp, textAlign: 'right' }} inputMode="decimal" value={hours} onChange={e => setHours(e.target.value)} onBlur={() => Number(hours) !== Number(tech.daily_hours) && onPatch({ daily_hours: Number(hours) || 0 })} />
      <input type="checkbox" checked={!!tech.show_in_diary} onChange={e => onPatch({ show_in_diary: e.target.checked })} style={{ justifySelf: 'center', cursor: 'pointer' }} />
      <input type="checkbox" checked={!!tech.active} onChange={e => onPatch({ active: e.target.checked })} style={{ justifySelf: 'center', cursor: 'pointer' }} />
      <button onClick={onRemove} title="Remove" style={{ background: 'transparent', border: 'none', color: T.text3, cursor: 'pointer', fontSize: 16, justifySelf: 'center' }}>×</button>
    </div>
  )
}

export async function getServerSideProps(context: any) {
  return requirePageAuth(context, 'admin:settings')
}
