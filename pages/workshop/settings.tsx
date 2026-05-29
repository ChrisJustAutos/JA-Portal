// pages/workshop/settings.tsx
// Workshop settings (admin) — the configurable heart of the workshop system so
// it can be run by anyone without code changes. Sections:
//   • Business & documents — letterhead/footer on printed + emailed PDFs
//   • Invoicing (MYOB)      — sales account + order/invoice mode
//   • SMS reminders         — provider toggle, sender, lead time
//   • Technicians & staff   — diary lanes: add/edit/remove, exclude from diary,
//                             per-lane daily capacity + colour
// All settings live in workshop_settings / workshop_technicians via gated APIs.

import { useEffect, useState, useCallback, useRef } from 'react'
import Head from 'next/head'
import Link from 'next/link'
import { useRouter } from 'next/router'
import PortalTopBar from '../../lib/PortalTopBar'
import { requirePageAuth } from '../../lib/authServer'
import { PAYMENT_TENDERS } from '../../lib/workshop'

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

type Tab = 'business' | 'invoicing' | 'accounts' | 'sms' | 'techs' | 'job-types'
// A settings saver. `silent` (used by "Save all") suppresses the per-card flash
// and throws on failure so the page can show one combined confirmation.
type SaveFn = (patch: any, opts?: { silent?: boolean }) => void | Promise<void>
type RegisterFn = (key: string, fn: ((opts?: { silent?: boolean }) => Promise<void>) | null) => void
const TABS: { id: Tab; label: string }[] = [
  { id: 'business', label: 'Business & documents' },
  { id: 'invoicing', label: 'Invoicing (MYOB)' },
  { id: 'accounts', label: 'MYOB accounts' },
  { id: 'job-types', label: 'Job types' },
  { id: 'sms', label: 'SMS reminders' },
  { id: 'techs', label: 'Technicians & staff' },
]

export default function WorkshopSettingsPage({ user }: { user: PortalUserSSR }) {
  const router = useRouter()
  const embed = router.query.embed === '1'   // rendered inside the Settings hub window
  const [tab, setTab] = useState<Tab>('business')
  const [settings, setSettings] = useState<any | null>(null)
  const [accounts, setAccounts] = useState<any[]>([])
  const [bankAccounts, setBankAccounts] = useState<any[]>([])
  const [trackingCategories, setTrackingCategories] = useState<any[]>([])
  const [accountsError, setAccountsError] = useState('')
  const [techs, setTechs] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [flash, setFlash] = useState('')
  const [savingAll, setSavingAll] = useState(false)

  // Save-all flush registry. Cards that buffer edits locally (Business,
  // Invoicing, SMS) register an async saver here so the page-level "Save all
  // settings" button can commit them in one click. Auto-save cards (MYOB
  // accounts, Job types, Technicians, Diary hours) persist on change/blur and
  // don't need to register.
  const saversRef = useRef<Record<string, (opts?: { silent?: boolean }) => Promise<void>>>({})
  const registerSaver = useCallback((key: string, fn: ((opts?: { silent?: boolean }) => Promise<void>) | null) => {
    if (fn) saversRef.current[key] = fn
    else delete saversRef.current[key]
  }, [])

  const loadSettings = useCallback(async () => {
    const r = await fetch('/api/workshop/settings')
    if (r.ok) { const d = await r.json(); setSettings(d.settings); setAccounts(d.incomeAccounts || []); setBankAccounts(d.bankAccounts || []); setTrackingCategories(d.trackingCategories || []); setAccountsError(d.accountsError || '') }
  }, [])
  const loadTechs = useCallback(async () => {
    const r = await fetch('/api/workshop/technicians')
    if (r.ok) { const d = await r.json(); setTechs(d.technicians || []) }
  }, [])
  useEffect(() => { Promise.all([loadSettings(), loadTechs()]).finally(() => setLoading(false)) }, [loadSettings, loadTechs])

  function flashSaved() { setFlash('Saved ✓'); setTimeout(() => setFlash(''), 2000) }

  // `silent` suppresses the per-save flash + throws on error, so the page-level
  // "Save all" can drive many saves and show a single combined confirmation.
  const saveSettings = useCallback(async (patch: any, opts: { silent?: boolean } = {}) => {
    const r = await fetch('/api/workshop/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) })
    if (r.ok) { const d = await r.json(); setSettings(d.settings); if (!opts.silent) { setFlash('Saved ✓'); setTimeout(() => setFlash(''), 2000) } }
    else {
      const d = await r.json().catch(() => ({}))
      if (opts.silent) throw new Error(d.error || 'Save failed')
      setFlash(d.error || 'Save failed'); setTimeout(() => setFlash(''), 3000)
    }
  }, [])

  async function saveAll() {
    setSavingAll(true)
    try {
      // Sequential so the settings PATCHes don't race each other on the row.
      for (const fn of Object.values(saversRef.current)) { await fn({ silent: true }) }
      setFlash('All settings saved ✓'); setTimeout(() => setFlash(''), 2500)
    } catch (e: any) {
      setFlash(e?.message || 'Save failed'); setTimeout(() => setFlash(''), 3500)
    } finally { setSavingAll(false) }
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
      <div style={{ display: 'flex', flexDirection: 'column', height: embed ? 'auto' : '100vh', minHeight: embed ? '100%' : undefined, overflow: embed ? 'visible' : 'hidden', fontFamily: "'DM Sans',system-ui,sans-serif", color: T.text, background: T.bg }}>
        <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet"/>
        {!embed && <PortalTopBar activeId="settings" currentUserRole={user.role} currentUserVisibleTabs={user.visibleTabs} currentUserName={user.displayName} currentUserEmail={user.email} />}

        <div style={{ flex: embed ? undefined : 1, overflow: embed ? 'visible' : 'auto', background: T.bg, padding: embed ? 4 : 20 }}>
          <div style={{ maxWidth: 1200, margin: '0 auto' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: embed ? 'flex-end' : 'space-between', marginBottom: 6, minHeight: 18 }}>
              {!embed && <Link href="/diary" style={{ fontSize: 12, color: T.text2, textDecoration: 'none' }}>‹ Back to diary</Link>}
              {flash && <span style={{ fontSize: 12, color: flash.includes('✓') || flash.startsWith('Saved') || flash.startsWith('Retired') || flash.startsWith('Removed') ? T.green : T.amber }}>{flash}</span>}
            </div>
            {!embed && <h1 style={{ fontSize: 22, fontWeight: 600, margin: '4px 0 16px' }}>Workshop settings</h1>}

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
                  {tab === 'business' && settings && <BusinessSection settings={settings} onSave={saveSettings} register={registerSaver} />}
                  {tab === 'invoicing' && settings && <InvoicingSection settings={settings} accounts={accounts} accountsError={accountsError} onSave={saveSettings} register={registerSaver} />}
                  {tab === 'accounts' && settings && <AccountsSection settings={settings} income={accounts} banks={bankAccounts} categories={trackingCategories} accountsError={accountsError} onSave={saveSettings} />}
                  {tab === 'job-types' && <JobTypesSection />}
                  {tab === 'sms' && settings && <SmsSection settings={settings} onSave={saveSettings} register={registerSaver} />}
                  {tab === 'techs' && <TechsSection techs={techs} onAdd={addTech} onPatch={patchTech} onRemove={removeTech} />}
                </div>
              </div>
            )}

            {/* Page-level Save bar — commits any in-progress edits across every
                tab and confirms. Settings still auto-save as you go; this is the
                explicit "make sure it's saved" button. */}
            {!loading && (
              <div style={{
                position: 'sticky', bottom: 0, marginTop: 18, padding: '12px 0 4px',
                display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 14,
                background: `linear-gradient(transparent, ${T.bg} 40%)`,
              }}>
                <span style={{ fontSize: 11, color: T.text3 }}>Changes auto-save as you edit — use this to save everything at once.</span>
                {flash && <span style={{ fontSize: 12, color: flash.includes('✓') || flash.startsWith('Saved') ? T.green : T.amber }}>{flash}</span>}
                <button onClick={saveAll} disabled={savingAll} style={{ ...pbtn(T.accent, true), padding: '9px 20px', fontSize: 13, opacity: savingAll ? 0.7 : 1, cursor: savingAll ? 'wait' : 'pointer' }}>
                  {savingAll ? 'Saving…' : 'Save all settings'}
                </button>
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

function BusinessSection({ settings, onSave, register }: { settings: any; onSave: SaveFn; register?: RegisterFn }) {
  const [f, setF] = useState({
    business_name: settings.business_name || '', business_abn: settings.business_abn || '',
    business_address: settings.business_address || '', business_phone: settings.business_phone || '',
    business_email: settings.business_email || '', document_footer: settings.document_footer || '',
  })
  const set = (k: string, v: string) => setF(s => ({ ...s, [k]: v }))
  const fRef = useRef(f); fRef.current = f
  useEffect(() => {
    if (!register) return
    register('business', (opts) => Promise.resolve(onSave(fRef.current, opts)))
    return () => register('business', null)
  }, [register, onSave])
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

      <div style={{ fontSize: 11, color: T.text3, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', margin: '22px 0 4px' }}>Diary hours</div>
      <div style={{ fontSize: 11, color: T.text3, marginBottom: 10 }}>The opening hours shown on the diary time grid (saves immediately).</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Field label="Opens"><input type="time" step={1800} value={minToHHMM(settings.diary_start_min ?? 420)} onChange={e => onSave({ diary_start_min: hhmmToMin(e.target.value) })} style={inp} /></Field>
        <Field label="Closes"><input type="time" step={1800} value={minToHHMM(settings.diary_end_min ?? 1080)} onChange={e => onSave({ diary_end_min: hhmmToMin(e.target.value) })} style={inp} /></Field>
      </div>
    </Card>
  )
}
const minToHHMM = (m: number) => `${String(Math.floor((Number(m) || 0) / 60)).padStart(2, '0')}:${String((Number(m) || 0) % 60).padStart(2, '0')}`
const hhmmToMin = (s: string) => { const [h, m] = String(s || '').split(':').map(Number); return (h || 0) * 60 + (m || 0) }

function InvoicingSection({ settings, accounts, accountsError, onSave, register }: { settings: any; accounts: any[]; accountsError: string; onSave: SaveFn; register?: RegisterFn }) {
  const [uid, setUid] = useState(settings.myob_sales_account_uid || '')
  const [asOrder, setAsOrder] = useState(!!settings.invoice_as_order)
  const buildPatch = () => ({ myob_sales_account_uid: uid || null, myob_sales_account_name: accounts.find(a => a.uid === uid)?.name || null, invoice_as_order: asOrder })
  const patchRef = useRef(buildPatch()); patchRef.current = buildPatch()
  useEffect(() => {
    if (!register) return
    register('invoicing', (opts) => Promise.resolve(onSave(patchRef.current, opts)))
    return () => register('invoicing', null)
  }, [register, onSave])
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

function AccountsSection({ settings, income, banks, categories, accountsError, onSave }: { settings: any; income: any[]; banks: any[]; categories: any[]; accountsError: string; onSave: (p: any) => void }) {
  const pa: Record<string, any> = settings.payment_accounts || {}
  const acctOpts = (list: any[]) => list.map((a: any) => <option key={a.uid} value={a.uid}>{a.displayId ? `${a.displayId} · ${a.name}` : a.name}</option>)
  function saveAcct(uidField: string, nameField: string, list: any[], uid: string) {
    const a = list.find((x: any) => x.uid === uid)
    onSave({ [uidField]: uid || null, [nameField]: a ? a.name : null })
  }
  function savePayment(tender: string, uid: string, method: string) {
    const a = banks.find((x: any) => x.uid === uid)
    onSave({ payment_accounts: { ...(settings.payment_accounts || {}), [tender]: { uid: uid || null, name: a ? a.name : null, method } } })
  }
  const [sync, setSync] = useState<{ busy: boolean; msg: string }>({ busy: false, msg: '' })
  async function runSync() {
    setSync({ busy: true, msg: 'Syncing from MYOB…' })
    try {
      const r = await fetch('/api/workshop/sync?what=all', { method: 'POST' })
      const d = await r.json()
      if (!r.ok || !d.ok) { setSync({ busy: false, msg: d.error || 'Sync failed' }); return }
      const parts = (d.results || []).map((x: any) => `${x.kind} ${x.upserted}/${x.scanned}`).join(' · ')
      setSync({ busy: false, msg: `Synced — ${parts}` })
    } catch (e: any) { setSync({ busy: false, msg: e?.message || 'Sync failed' }) }
  }
  return (
    <Card title="MYOB accounts (VPS)" hint="Where workshop sales, parts and payments post in MYOB — mirrors the MechanicDesk account map. Pickers load live from the VPS chart of accounts.">
      {accountsError && <div style={{ fontSize: 12, color: T.amber, marginBottom: 12 }}>{accountsError}</div>}

      {/* Pull customers + inventory from MYOB (moved here from the diary) */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', padding: '12px 14px', borderRadius: 8, marginBottom: 14, background: T.bg3, border: `1px solid ${T.border2}` }}>
        <button onClick={runSync} disabled={sync.busy} style={pbtn(T.accent, true)}>{sync.busy ? 'Syncing…' : '↻ Sync customers & stock from MYOB'}</button>
        <span style={{ fontSize: 11, color: sync.msg.startsWith('Synced') ? T.green : (sync.msg ? T.amber : T.text3) }}>{sync.msg || 'Pulls VPS customers + inventory into the portal pickers.'}</span>
      </div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '12px 14px', borderRadius: 8, marginBottom: 18, background: settings.myob_posting_enabled ? `${T.green}14` : T.bg3, border: `1px solid ${settings.myob_posting_enabled ? T.green + '55' : T.border2}` }}>
        <input type="checkbox" checked={!!settings.myob_posting_enabled} onChange={e => onSave({ myob_posting_enabled: e.target.checked })} style={{ marginTop: 2 }} />
        <div>
          <div style={{ fontSize: 13, fontWeight: 600 }}>Post workshop sales &amp; payments to MYOB</div>
          <div style={{ fontSize: 11, color: T.text3, marginTop: 2, lineHeight: 1.5 }}>Leave OFF until MechanicDesk is retired — otherwise invoices/payments would be entered in MYOB twice. When OFF, the portal still records jobs and payments locally but sends nothing to MYOB.</div>
        </div>
      </div>

      <div style={{ fontSize: 11, color: T.text3, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>Sale accounts (income)</div>
      <Field label="Default / labour sale account"><select style={inp} value={settings.myob_sales_account_uid || ''} onChange={e => saveAcct('myob_sales_account_uid', 'myob_sales_account_name', income, e.target.value)}><option value="">— none —</option>{acctOpts(income)}</select></Field>
      <Field label="Parts sale account"><select style={inp} value={settings.part_sale_account_uid || ''} onChange={e => saveAcct('part_sale_account_uid', 'part_sale_account_name', income, e.target.value)}><option value="">— same as default —</option>{acctOpts(income)}</select></Field>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Field label="Discount account"><select style={inp} value={settings.discount_account_uid || ''} onChange={e => saveAcct('discount_account_uid', 'discount_account_name', income, e.target.value)}><option value="">— none —</option>{acctOpts(income)}</select></Field>
        <Field label="Refund / credit account"><select style={inp} value={settings.refund_account_uid || ''} onChange={e => saveAcct('refund_account_uid', 'refund_account_name', income, e.target.value)}><option value="">— none —</option>{acctOpts(income)}</select></Field>
      </div>
      <Field label="Tracking category"><select style={inp} value={settings.tracking_category_uid || ''} onChange={e => saveAcct('tracking_category_uid', 'tracking_category_name', categories, e.target.value)}><option value="">— none —</option>{categories.map((c: any) => <option key={c.uid} value={c.uid}>{c.name}</option>)}</select></Field>

      <Field label="Labour / sundry MYOB item">
        <LabourItemPicker value={settings.labour_item_name || null} onPick={(uid, name) => onSave({ labour_item_uid: uid, labour_item_name: name })} onClear={() => onSave({ labour_item_uid: null, labour_item_name: null })} />
        <div style={{ fontSize: 10, color: T.text3, marginTop: 4, lineHeight: 1.5 }}>Set this to post invoices as MYOB <strong>Item</strong> sales — parts decrement stock &amp; book COGS, with labour/fees on this item (keeps the invoice editable in MYOB). Leave blank to post account lines instead.</div>
      </Field>

      <div style={{ fontSize: 11, color: T.text3, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', margin: '20px 0 4px' }}>Customer payment accounts (by tender)</div>
      <div style={{ fontSize: 11, color: T.text3, marginBottom: 10, lineHeight: 1.5 }}>Each payment type deposits into its MYOB account (e.g. cash/EFTPOS/card → Undeposited Funds; bank transfer/direct deposit → bank). Bank-type accounts only.</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        {PAYMENT_TENDERS.map(t => (
          <Field key={t.id} label={t.label}>
            <select style={inp} value={pa[t.id]?.uid || ''} onChange={e => savePayment(t.id, e.target.value, t.defaultMethod)}>
              <option value="">— not set —</option>{acctOpts(banks)}
            </select>
          </Field>
        ))}
      </div>
    </Card>
  )
}

function JobTypesSection() {
  const [types, setTypes] = useState<any[]>([])
  const [newName, setNewName] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)
  const load = useCallback(async () => { try { const r = await fetch('/api/workshop/job-types'); if (r.ok) setTypes((await r.json()).jobTypes || []) } catch { /* */ } }, [])
  useEffect(() => { load() }, [load])
  async function api(url: string, method: string, body?: any) {
    await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined })
    await load()
  }
  function addType() { const n = newName.trim(); if (!n) return; setNewName(''); api('/api/workshop/job-types', 'POST', { name: n, sort_order: (types.length + 1) * 10 }) }
  return (
    <Card title="Job types (presets)" hint="A job type is a named job with preset labour + parts. Apply it on a job card to fill the lines in one click. Importable from your MechanicDesk job-type export.">
      {types.length === 0 && <div style={{ fontSize: 12, color: T.text3, padding: '4px 0 12px' }}>No job types yet — add one below, or import from MechanicDesk.</div>}
      {types.map(t => (
        <div key={t.id} style={{ border: `1px solid ${T.border}`, borderRadius: 8, marginBottom: 8, background: T.bg3, opacity: t.active ? 1 : 0.55 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px' }}>
            <input defaultValue={t.name} onBlur={e => { const v = e.target.value.trim(); if (v && v !== t.name) api(`/api/workshop/job-types?id=${t.id}`, 'PATCH', { name: v }) }} style={{ ...cellInp, flex: 1, fontWeight: 600 }} />
            <label style={{ fontSize: 11, color: T.text2, display: 'flex', gap: 4, alignItems: 'center', cursor: 'pointer' }}><input type="checkbox" checked={!!t.active} onChange={e => api(`/api/workshop/job-types?id=${t.id}`, 'PATCH', { active: e.target.checked })} />Active</label>
            <span style={{ fontSize: 11, color: T.text3, whiteSpace: 'nowrap' }}>{(t.lines || []).length} lines</span>
            <button onClick={() => setOpenId(openId === t.id ? null : t.id)} style={pbtn(T.blue)}>{openId === t.id ? 'Close' : 'Edit lines'}</button>
            <button onClick={() => { if (confirm(`Delete job type “${t.name}”?`)) api(`/api/workshop/job-types?id=${t.id}`, 'DELETE') }} title="Delete" style={{ background: 'transparent', border: 'none', color: T.text3, cursor: 'pointer', fontSize: 16 }}>×</button>
          </div>
          {openId === t.id && (
            <div style={{ padding: '0 10px 10px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '64px 1fr 50px 80px 26px', gap: 6, padding: '4px 2px', fontSize: 9, color: T.text3, textTransform: 'uppercase', letterSpacing: '0.04em' }}><div>Type</div><div>Description</div><div style={{ textAlign: 'right' }}>Qty</div><div style={{ textAlign: 'right' }}>Unit ex</div><div /></div>
              {(t.lines || []).map((l: any) => <JobTypeLineRow key={l.id} line={l} onPatch={(p: any) => api(`/api/workshop/job-type-lines?id=${l.id}`, 'PATCH', p)} onRemove={() => api(`/api/workshop/job-type-lines?id=${l.id}`, 'DELETE')} />)}
              <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                <button onClick={() => api('/api/workshop/job-type-lines', 'POST', { job_type_id: t.id, line_type: 'labour', description: 'Labour', qty: 1, unit_price_ex_gst: 0, sort_order: (t.lines || []).length })} style={pbtn(T.blue)}>+ Labour</button>
                <button onClick={() => api('/api/workshop/job-type-lines', 'POST', { job_type_id: t.id, line_type: 'fee', description: '', qty: 1, unit_price_ex_gst: 0, sort_order: (t.lines || []).length })} style={pbtn(T.blue)}>+ Fee</button>
                <JTPartPicker onPick={(it: any) => api('/api/workshop/job-type-lines', 'POST', { job_type_id: t.id, line_type: 'part', description: it.part_name, part_number: it.sku, qty: 1, unit_price_ex_gst: Number(it.sell_price) || 0, inventory_id: it.id, sort_order: (t.lines || []).length })} />
              </div>
            </div>
          )}
        </div>
      ))}
      <div style={{ display: 'flex', gap: 8, marginTop: 12, paddingTop: 12, borderTop: `1px solid ${T.border}` }}>
        <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="New job type (e.g. Logbook Service)" style={{ ...inp, flex: 1 }} onKeyDown={e => { if (e.key === 'Enter') addType() }} />
        <button onClick={addType} style={pbtn(T.accent, true)}>+ Add</button>
      </div>
    </Card>
  )
}

function JobTypeLineRow({ line, onPatch, onRemove }: { line: any; onPatch: (p: any) => void; onRemove: () => void }) {
  const [desc, setDesc] = useState(line.description || '')
  const [qty, setQty] = useState(String(line.qty))
  const [price, setPrice] = useState(String(line.unit_price_ex_gst))
  useEffect(() => { setDesc(line.description || ''); setQty(String(line.qty)); setPrice(String(line.unit_price_ex_gst)) }, [line.id, line.description, line.qty, line.unit_price_ex_gst])
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '64px 1fr 50px 80px 26px', gap: 6, padding: '4px 2px', alignItems: 'center' }}>
      <span style={{ fontSize: 10, color: T.text3, textTransform: 'uppercase' }}>{line.line_type}</span>
      <input value={desc} onChange={e => setDesc(e.target.value)} onBlur={() => desc !== (line.description || '') && onPatch({ description: desc })} placeholder={line.part_number || 'Description'} style={cellInp} />
      <input value={qty} inputMode="decimal" onChange={e => setQty(e.target.value)} onBlur={() => Number(qty) !== Number(line.qty) && onPatch({ qty: Number(qty) || 0 })} style={{ ...cellInp, textAlign: 'right' }} />
      <input value={price} inputMode="decimal" onChange={e => setPrice(e.target.value)} onBlur={() => Number(price) !== Number(line.unit_price_ex_gst) && onPatch({ unit_price_ex_gst: Number(price) || 0 })} style={{ ...cellInp, textAlign: 'right' }} />
      <button onClick={onRemove} title="Remove" style={{ background: 'transparent', border: 'none', color: T.text3, cursor: 'pointer', fontSize: 14 }}>×</button>
    </div>
  )
}

function JTPartPicker({ onPick }: { onPick: (item: any) => void }) {
  const [open, setOpen] = useState(false); const [q, setQ] = useState(''); const [results, setResults] = useState<any[]>([])
  useEffect(() => { if (!open) return; const t = setTimeout(async () => { try { const r = await fetch(`/api/workshop/inventory?q=${encodeURIComponent(q)}`); setResults((await r.json()).items || []) } catch { /* */ } }, 250); return () => clearTimeout(t) }, [q, open])
  if (!open) return <button onClick={() => setOpen(true)} style={pbtn(T.blue)}>+ Part</button>
  return (
    <div style={{ position: 'relative' }}>
      <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Search parts…" onBlur={() => setTimeout(() => setOpen(false), 200)} style={{ ...cellInp, width: 200 }} />
      {results.length > 0 && (
        <div style={{ position: 'absolute', bottom: '100%', left: 0, width: 260, background: T.bg3, border: `1px solid ${T.border2}`, borderRadius: 6, marginBottom: 4, maxHeight: 220, overflowY: 'auto', zIndex: 10 }}>
          {results.map((it: any) => <div key={it.id} onMouseDown={() => { onPick(it); setOpen(false); setQ('') }} style={{ padding: '7px 10px', fontSize: 12, cursor: 'pointer', borderBottom: `1px solid ${T.border}` }}><div style={{ color: T.text }}>{it.part_name}</div><div style={{ fontSize: 10, color: T.text3, fontFamily: 'monospace' }}>{it.sku || ''}</div></div>)}
        </div>
      )}
    </div>
  )
}

function LabourItemPicker({ value, onPick, onClear }: { value: string | null; onPick: (uid: string, name: string) => void; onClear: () => void }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [results, setResults] = useState<any[]>([])
  useEffect(() => {
    if (!open) return
    const t = setTimeout(async () => { try { const r = await fetch(`/api/workshop/inventory?q=${encodeURIComponent(q)}`); const d = await r.json(); setResults(d.items || []) } catch { /* */ } }, 250)
    return () => clearTimeout(t)
  }, [q, open])
  if (value && !open) {
    return <div style={{ display: 'flex', gap: 8 }}><div style={{ ...inp, flex: 1 }}>{value}</div><button onClick={() => setOpen(true)} style={pbtn(T.blue)}>Change</button><button onClick={onClear} style={pbtn(T.text3)}>Clear</button></div>
  }
  return (
    <div style={{ position: 'relative' }}>
      <input value={q} onChange={e => setQ(e.target.value)} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 200)} placeholder="Search MYOB items (e.g. Labour)…" style={inp} />
      {open && results.length > 0 && (
        <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 5, background: T.bg3, border: `1px solid ${T.border2}`, borderRadius: 6, marginTop: 2, maxHeight: 220, overflowY: 'auto' }}>
          {results.map((it: any) => (
            <div key={it.id} onMouseDown={() => { if (it.myob_uid) { onPick(it.myob_uid, it.part_name); setOpen(false); setQ('') } }}
              style={{ padding: '7px 10px', fontSize: 12, cursor: it.myob_uid ? 'pointer' : 'not-allowed', opacity: it.myob_uid ? 1 : 0.5, borderBottom: `1px solid ${T.border}` }}
              title={it.myob_uid ? '' : 'Not linked to a MYOB item — can’t be used'}>
              <div style={{ color: T.text }}>{it.part_name}</div>
              <div style={{ fontSize: 10, color: T.text3, fontFamily: 'monospace' }}>{it.sku || ''}{it.myob_uid ? '' : ' · no MYOB link'}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function SmsSection({ settings, onSave, register }: { settings: any; onSave: SaveFn; register?: RegisterFn }) {
  const [enabled, setEnabled] = useState(!!settings.sms_enabled)
  const [from, setFrom] = useState(settings.sms_from || '')
  const [lead, setLead] = useState(String(settings.booking_reminder_lead_hours ?? 24))
  const buildPatch = () => ({ sms_enabled: enabled, sms_from: from, booking_reminder_lead_hours: Number(lead) || 0 })
  const patchRef = useRef(buildPatch()); patchRef.current = buildPatch()
  useEffect(() => {
    if (!register) return
    register('sms', (opts) => Promise.resolve(onSave(patchRef.current, opts)))
    return () => register('sms', null)
  }, [register, onSave])
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
