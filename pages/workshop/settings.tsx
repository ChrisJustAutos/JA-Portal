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
import type { PortalUserSSR } from '../../lib/authServer'
import { PAYMENT_TENDERS, JOB_TYPES } from '../../lib/workshop'
import { COMM_TRIGGERS, COMM_VARS, CommTemplate } from '../../lib/workshop-comm-templates'
import { T } from '../../lib/ui/theme'
import { useConfirm, useToast } from '../../components/ui/Feedback'
const inp: React.CSSProperties = { width: '100%', padding: '7px 9px', background: T.bg3, border: `1px solid ${T.border}`, borderRadius: 6, color: T.text, fontSize: 13, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box', colorScheme: 'dark' }
const cellInp: React.CSSProperties = { ...inp, padding: '5px 7px', borderRadius: 4, fontSize: 12 }
function pbtn(color: string, solid?: boolean): React.CSSProperties {
  return { padding: '7px 14px', borderRadius: 6, fontSize: 12, fontFamily: 'inherit', fontWeight: 600, cursor: 'pointer', background: solid ? color : 'transparent', color: solid ? '#fff' : color, border: `1px solid ${solid ? color : color + '55'}` }
}

type Tab = 'business' | 'invoicing' | 'accounts' | 'sms' | 'techs'
// A settings saver. `silent` (used by "Save all") suppresses the per-card flash
// and throws on failure so the page can show one combined confirmation.
type SaveFn = (patch: any, opts?: { silent?: boolean }) => void | Promise<void>
type RegisterFn = (key: string, fn: ((opts?: { silent?: boolean }) => Promise<void>) | null) => void
const TABS: { id: Tab; label: string }[] = [
  { id: 'business', label: 'Business & documents' },
  { id: 'invoicing', label: 'Invoicing (MYOB)' },
  { id: 'accounts', label: 'MYOB accounts' },
  { id: 'sms', label: 'Communications' },
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
  const [expenseAccounts, setExpenseAccounts] = useState<any[]>([])
  const [accountsError, setAccountsError] = useState('')
  const [loading, setLoading] = useState(true)
  const [flash, setFlash] = useState('')
  const [savingAll, setSavingAll] = useState(false)
  const confirmDialog = useConfirm()

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
    if (r.ok) { const d = await r.json(); setSettings(d.settings); setAccounts(d.incomeAccounts || []); setBankAccounts(d.bankAccounts || []); setTrackingCategories(d.trackingCategories || []); setExpenseAccounts(d.expenseAccounts || []); setAccountsError(d.accountsError || '') }
  }, [])
  useEffect(() => { loadSettings().finally(() => setLoading(false)) }, [loadSettings])

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
                  {tab === 'accounts' && settings && <AccountsSection settings={settings} income={accounts} banks={bankAccounts} categories={trackingCategories} expense={expenseAccounts} accountsError={accountsError} onSave={saveSettings} />}
                  {tab === 'sms' && settings && <><SmsSection settings={settings} onSave={saveSettings} register={registerSaver} /><div style={{ height: 14 }} /><CommTemplatesManager /></>}
                  {tab === 'techs' && <TechsMovedCard />}
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
    invoice_terms: settings.invoice_terms || '', quote_terms: settings.quote_terms || '', po_terms: settings.po_terms || '',
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
      <Field label="Document footer (optional)"><textarea style={{ ...inp, resize: 'vertical' }} rows={2} value={f.document_footer} onChange={e => set('document_footer', e.target.value)} placeholder="One-line footer on every document — bank details, thank-you note…" /></Field>

      <div style={{ fontSize: 11, color: T.text3, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', margin: '14px 0 4px' }}>Document terms</div>
      <div style={{ fontSize: 11, color: T.text3, marginBottom: 10 }}>Editable terms / payment-details blocks printed above the footer on each document type.</div>
      <Field label="Invoice terms / payment details"><textarea style={{ ...inp, resize: 'vertical' }} rows={3} value={f.invoice_terms} onChange={e => set('invoice_terms', e.target.value)} placeholder="e.g. Payment due on collection. EFT: BSB 000-000 Acc 00000000. Warranty: 12 months / 20,000km." /></Field>
      <Field label="Quote terms"><textarea style={{ ...inp, resize: 'vertical' }} rows={3} value={f.quote_terms} onChange={e => set('quote_terms', e.target.value)} placeholder="e.g. Quote valid for 30 days. Prices may change subject to parts availability. A deposit may be required." /></Field>
      <Field label="Purchase order terms"><textarea style={{ ...inp, resize: 'vertical' }} rows={3} value={f.po_terms} onChange={e => set('po_terms', e.target.value)} placeholder="e.g. Please confirm price + ETA. Deliver to … Quote our PO number on the invoice." /></Field>
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

function AccountsSection({ settings, income, banks, categories, expense, accountsError, onSave }: { settings: any; income: any[]; banks: any[]; categories: any[]; expense: any[]; accountsError: string; onSave: (p: any) => void }) {
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
      <Field label="Inventory adjustment account (stocktake)">
        <select style={inp} value={settings.inventory_adjust_account_uid || ''} onChange={e => saveAcct('inventory_adjust_account_uid', 'inventory_adjust_account_name', expense, e.target.value)}><option value="">— none —</option>{acctOpts(expense)}</select>
        <div style={{ fontSize: 10, color: T.text3, marginTop: 4, lineHeight: 1.5 }}>Expense / cost-of-sales account that stocktake quantity variances (shrinkage) post against in MYOB. Required before a portal stocktake can apply to MYOB.</div>
      </Field>

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
  const [dueLead, setDueLead] = useState(String(settings.service_reminder_lead_days ?? 14))
  const [reviewUrl, setReviewUrl] = useState(settings.review_url || '')
  const buildPatch = () => ({ sms_enabled: enabled, sms_from: from, booking_reminder_lead_hours: Number(lead) || 0, service_reminder_lead_days: Number(dueLead) || 0, review_url: reviewUrl || null })
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
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 150px 150px', gap: 12 }}>
        <Field label="Sender ID / number (optional)"><input style={inp} value={from} onChange={e => setFrom(e.target.value)} placeholder="JustAutos" /></Field>
        <Field label="Booking lead (hours)"><input style={inp} inputMode="numeric" value={lead} onChange={e => setLead(e.target.value)} /></Field>
        <Field label="Service-due lead (days)"><input style={inp} inputMode="numeric" value={dueLead} onChange={e => setDueLead(e.target.value)} /></Field>
      </div>
      <div style={{ marginTop: 12 }}>
        <Field label="Google review link (for the {{review_link}} placeholder)"><input style={inp} value={reviewUrl} onChange={e => setReviewUrl(e.target.value)} placeholder="https://g.page/r/…/review" /></Field>
      </div>
      <button onClick={() => onSave(buildPatch())} style={{ ...pbtn(T.accent, true), marginTop: 12 }}>Save settings</button>
    </Card>
  )
}

// Technicians moved to Settings → Users & Staff (one screen for logins +
// diary lanes, linked per person). This card is a signpost for muscle memory.
function TechsMovedCard() {
  return (
    <Card title="Technicians & staff" hint="">
      <div style={{ fontSize: 13, color: T.text2, lineHeight: 1.6, padding: '6px 0' }}>
        Staff management has moved to <strong>Settings → Users &amp; Staff</strong>, where portal
        logins and diary lanes are managed together (and linked per person).
      </div>
      <a href="/settings?tab=users" target="_top" style={{ display: 'inline-block', marginTop: 8, padding: '8px 16px', borderRadius: 6, fontSize: 12, fontWeight: 600, background: T.accent, color: '#fff', textDecoration: 'none' }}>
        Open Users &amp; Staff →
      </a>
    </Card>
  )
}

// ── Communication templates (SMS + email) ───────────────────────────────
function CommTemplatesManager() {
  const toast = useToast()
  const confirmDialog = useConfirm()
  const [tmpls, setTmpls] = useState<CommTemplate[]>([])
  const [loading, setLoading] = useState(true)
  const [openId, setOpenId] = useState<string | null>(null)

  const load = useCallback(async () => {
    try { const r = await fetch('/api/workshop/comm-templates'); if (r.ok) setTmpls((await r.json()).templates || []) }
    catch { /* keep */ } finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])

  async function patch(id: string, p: any) {
    setTmpls(ts => ts.map(t => t.id === id ? { ...t, ...p } : t))   // optimistic
    const r = await fetch(`/api/workshop/comm-templates?id=${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) })
    if (!r.ok) { toast((await r.json()).error || 'Save failed', 'error'); load() }
  }
  async function addTemplate() {
    const r = await fetch('/api/workshop/comm-templates', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trigger: 'follow_up', name: 'New template', channel: 'sms', body: 'Hi {{first_name}}, ', offset_value: 1, offset_unit: 'days', offset_dir: 'after', sort_order: tmpls.length + 1 }) })
    const d = await r.json()
    if (r.ok) { await load(); setOpenId(d.template?.id || null) } else toast(d.error || 'Add failed', 'error')
  }
  async function remove(t: CommTemplate) {
    if (!(await confirmDialog({ title: `Delete “${t.name}”?`, danger: true }))) return
    const r = await fetch(`/api/workshop/comm-templates?id=${t.id}`, { method: 'DELETE' })
    if (r.ok) { setOpenId(null); load() } else toast((await r.json()).error || 'Delete failed', 'error')
  }

  return (
    <Card title="Communication templates" hint="Editable SMS + email the workshop sends customers. Each template fires on a trigger, with its own timing and (optionally) only for certain job types. Sends still require the master toggle above to be on.">
      {loading && <div style={{ fontSize: 12, color: T.text3 }}>Loading…</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {tmpls.map(t => {
          const trig = COMM_TRIGGERS.find(x => x.value === t.trigger)
          const timing = t.trigger === 'booking_reminder' || t.trigger === 'follow_up'
            ? `${t.offset_value} ${t.offset_unit} ${t.offset_dir} ${t.trigger === 'follow_up' ? 'completion' : 'booking'}`
            : trig?.anchor || ''
          const on = openId === t.id
          return (
            <div key={t.id} style={{ border: `1px solid ${T.border}`, borderRadius: 8, background: T.bg3 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', cursor: 'pointer' }} onClick={() => setOpenId(on ? null : t.id)}>
                <span style={{ fontSize: 13 }}>{t.channel === 'email' ? '✉️' : '📱'}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: T.text }}>{t.name}</div>
                  <div style={{ fontSize: 11, color: T.text3 }}>{trig?.label} · {timing}{t.job_types.length ? ` · ${t.job_types.length} job type${t.job_types.length === 1 ? '' : 's'}` : ''}</div>
                </div>
                <span onClick={e => { e.stopPropagation(); patch(t.id, { enabled: !t.enabled }) }}
                  style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', padding: '3px 9px', borderRadius: 12, cursor: 'pointer', background: t.enabled ? `${T.green}22` : T.bg4, color: t.enabled ? T.green : T.text3, border: `1px solid ${t.enabled ? T.green + '55' : T.border2}` }}>
                  {t.enabled ? 'On' : 'Off'}
                </span>
                <span style={{ color: T.text3, fontSize: 11 }}>{on ? '▲' : '▼'}</span>
              </div>
              {on && <CommTemplateEditor t={t} onPatch={(p) => patch(t.id, p)} onRemove={() => remove(t)} />}
            </div>
          )
        })}
      </div>
      <button onClick={addTemplate} style={{ ...pbtn(T.accent), marginTop: 12 }}>+ New template</button>
    </Card>
  )
}

function CommTemplateEditor({ t, onPatch, onRemove }: { t: CommTemplate; onPatch: (p: any) => void; onRemove: () => void }) {
  const [name, setName] = useState(t.name)
  const [subject, setSubject] = useState(t.subject || '')
  const [body, setBody] = useState(t.body)
  useEffect(() => { setName(t.name); setSubject(t.subject || ''); setBody(t.body) }, [t.id])
  const showTiming = t.trigger === 'booking_reminder' || t.trigger === 'follow_up'
  const anchorWord = t.trigger === 'follow_up' ? 'after completion' : (t.offset_dir === 'before' ? 'before booking' : 'after booking')
  return (
    <div style={{ padding: '4px 12px 14px', borderTop: `1px solid ${T.border}` }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 130px 130px', gap: 10, marginBottom: 10 }}>
        <Field label="Name"><input style={inp} value={name} onChange={e => setName(e.target.value)} onBlur={() => name !== t.name && onPatch({ name })} /></Field>
        <Field label="Trigger">
          <select style={inp} value={t.trigger} onChange={e => onPatch({ trigger: e.target.value })}>
            {COMM_TRIGGERS.map(x => <option key={x.value} value={x.value}>{x.label}</option>)}
          </select>
        </Field>
        <Field label="Channel">
          <select style={inp} value={t.channel} onChange={e => onPatch({ channel: e.target.value })}>
            <option value="sms">SMS</option><option value="email">Email</option>
          </select>
        </Field>
      </div>

      {showTiming && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginBottom: 10 }}>
          <Field label="Send"><input style={{ ...inp, width: 80 }} inputMode="numeric" value={t.offset_value} onChange={e => onPatch({ offset_value: Math.max(0, Number(e.target.value) || 0) })} /></Field>
          <Field label="Unit"><select style={{ ...inp, width: 100 }} value={t.offset_unit} onChange={e => onPatch({ offset_unit: e.target.value })}><option value="hours">hours</option><option value="days">days</option></select></Field>
          {t.trigger === 'booking_reminder'
            ? <Field label="When"><select style={{ ...inp, width: 130 }} value={t.offset_dir} onChange={e => onPatch({ offset_dir: e.target.value })}><option value="before">before booking</option><option value="after">after booking</option></select></Field>
            : <div style={{ fontSize: 12, color: T.text3, paddingBottom: 8 }}>{anchorWord}</div>}
        </div>
      )}

      {t.channel === 'email' && (
        <Field label="Subject"><input style={inp} value={subject} onChange={e => setSubject(e.target.value)} onBlur={() => subject !== (t.subject || '') && onPatch({ subject })} placeholder="e.g. Your {{vehicle}} is ready" /></Field>
      )}
      <Field label="Message">
        <textarea style={{ ...inp, minHeight: 90, resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5 }} value={body} onChange={e => setBody(e.target.value)} onBlur={() => body !== t.body && onPatch({ body })} />
      </Field>
      <div style={{ fontSize: 10, color: T.text3, marginBottom: 12 }}>
        Placeholders: {COMM_VARS.map(v => <code key={v} style={{ background: T.bg4, padding: '1px 5px', borderRadius: 4, marginRight: 4, fontSize: 10 }}>{`{{${v}}}`}</code>)}
      </div>

      <Field label="Only these job types (none = all)">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {JOB_TYPES.map(jt => {
            const on = t.job_types.includes(jt.value)
            return (
              <button key={jt.value} onClick={() => onPatch({ job_types: on ? t.job_types.filter(x => x !== jt.value) : [...t.job_types, jt.value] })}
                style={{ fontSize: 11, padding: '4px 9px', borderRadius: 5, cursor: 'pointer', fontFamily: 'inherit', background: on ? `${T.accent}22` : 'transparent', color: on ? T.accent : T.text3, border: `1px solid ${on ? T.accent : T.border2}` }}>
                {jt.label}
              </button>
            )
          })}
        </div>
      </Field>

      <div style={{ marginTop: 10 }}>
        <button onClick={onRemove} style={pbtn(T.red)}>Delete template</button>
      </div>
    </div>
  )
}

export async function getServerSideProps(context: any) {
  return requirePageAuth(context, 'admin:settings')
}
