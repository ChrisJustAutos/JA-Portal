// pages/admin/b2b/settings.tsx
//
// B2B portal settings — staff-only.
// Layout matches the rest of /admin/b2b/* (PortalTopBar + main content).

import { useEffect, useMemo, useState } from 'react'
import Head from 'next/head'
import PortalTopBar from '../../../lib/PortalTopBar'
import B2BAdminTabs from '../../../components/b2b/B2BAdminTabs'
import { AppIcon } from '../../../lib/AppIcons'
import { requirePageAuth } from '../../../lib/authServer'
import type { UserRole } from '../../../lib/permissions'
import { getSupabase } from '../../../lib/supabaseClient'
import FreightZonesManager from '../../../components/b2b/FreightZonesManager'
import EmailTemplatesManager from '../../../components/b2b/EmailTemplatesManager'
import FreightPackagingManager from '../../../components/b2b/FreightPackagingManager'
import FreightCarriersManager from '../../../components/b2b/FreightCarriersManager'

const T = {
  bg:'#0d0f12', bg2:'#131519', bg3:'#1a1d23', bg4:'#21252d',
  border:'rgba(255,255,255,0.07)', border2:'rgba(255,255,255,0.12)',
  text:'#e8eaf0', text2:'#aab0c0', text3:'#8d93a4',
  blue:'#4f8ef7', teal:'#2dd4bf', green:'#34c77b',
  amber:'#f5a623', red:'#f04e4e', purple:'#a78bfa', accent:'#4f8ef7',
}

interface Props {
  user: {
    id: string
    email: string
    displayName: string | null
    role: UserRole
    visibleTabs: string[] | null
  }
}

// Tiles shown on the settings page. id matches each <Section id="…">.
const SETTINGS_SECTIONS: Array<{ id: string; title: string; icon: string; accent: string }> = [
  { id: 'models',            title: 'Models',                 icon: 'vehicle-sales', accent: T.green },
  { id: 'product-types',     title: 'Product Types',          icon: 'stock',         accent: T.purple },
  { id: 'tiers',             title: 'Distributor Tiers',      icon: 'distributors',  accent: T.blue },
  { id: 'invoice-numbering', title: 'Invoice Numbering',      icon: 'invoices',      accent: T.amber },
  { id: 'credit-numbering',  title: 'Credit Note Numbering',  icon: 'ap',            accent: T.red },
  { id: 'card-surcharge',    title: 'Card Surcharge',         icon: 'payables',      accent: T.teal },
  { id: 'carriers',          title: 'Freight Carriers',       icon: 'orders',        accent: T.teal },
  { id: 'freight-pricing',   title: 'Freight Pricing & Sender', icon: 'payables',    accent: T.blue },
  { id: 'freight-zones',     title: 'Freight Zones',          icon: 'stock',         accent: T.amber },
  { id: 'freight-packaging', title: 'Freight Packaging',      icon: 'stock',         accent: T.teal },
  { id: 'slack',             title: 'Slack Notifications',    icon: 'calls',         accent: T.purple },
  { id: 'order-notify',      title: 'Order Notifications',    icon: 'messages',      accent: T.green },
  { id: 'email-templates',   title: 'Email Notifications',    icon: 'messages',      accent: T.blue },
  { id: 'status',            title: 'System Status',          icon: 'reports',       accent: T.text3 },
]

interface Settings {
  card_fee_percent: number
  card_fee_fixed: number
  myob_company_file: string
  myob_jaws_gst_tax_code_uid: string | null
  myob_jaws_fre_tax_code_uid: string | null
  myob_card_fee_account_uid: string | null
  myob_card_fee_account_code: string | null
  myob_invoice_number_prefix: string
  myob_invoice_number_padding: number
  myob_invoice_number_seq: number
  myob_credit_note_number_prefix: string
  myob_credit_note_number_padding: number
  myob_credit_note_number_seq: number
  slack_new_order_webhook_url: string | null
  admin_order_notify_emails: string | null
  outbound_from_email: string | null
  email_logo_url: string | null
  freight_markup_percent: number
  machship_from_name: string | null
  machship_from_company: string | null
  machship_from_phone: string | null
  machship_from_email: string | null
  machship_from_address_line1: string | null
  machship_from_address_line2: string | null
  machship_from_suburb: string | null
  machship_from_postcode: string | null
  machship_from_state: string | null
  last_catalogue_sync_at: string | null
  last_catalogue_sync_added: number | null
  last_catalogue_sync_updated: number | null
  last_catalogue_sync_error: string | null
  updated_at: string
}

interface ApiResponse {
  settings: Settings
  next_invoice_number_preview: string | null
  next_credit_note_number_preview: string | null
  stripe_env: {
    secret_key_set: boolean
    webhook_secret_set: boolean
  }
}

export default function B2BSettingsPage({ user }: Props) {
  const [data, setData] = useState<ApiResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [savedFlash, setSavedFlash] = useState<string | null>(null)
  // Which settings section is open in the floating window (null = none).
  const [openSectionId, setOpenSectionId] = useState<string | null>(null)
  const closeSection = () => setOpenSectionId(null)

  // Local edit state
  const [prefix, setPrefix]   = useState('')
  const [padding, setPadding] = useState(6)
  const [seqInput, setSeqInput] = useState<string>('')
  const [cnPrefix, setCnPrefix]     = useState('')
  const [cnPadding, setCnPadding]   = useState(6)
  const [cnSeqInput, setCnSeqInput] = useState<string>('')
  const [feePct, setFeePct]   = useState(0)
  const [feeFixed, setFeeFixed] = useState(0)
  const [slackUrl, setSlackUrl] = useState('')
  const [adminEmails, setAdminEmails] = useState('')
  const [fromEmail, setFromEmail] = useState('')
  const [logoUrl, setLogoUrl] = useState('')
  const [logoUploading, setLogoUploading] = useState(false)
  const [logoErr, setLogoErr] = useState('')
  // Freight (MachShip): admin-settable markup % + sender pickup address
  const [freightMarkup, setFreightMarkup] = useState<number>(20)
  const [msFromName,    setMsFromName]    = useState('')
  const [msFromCompany, setMsFromCompany] = useState('')
  const [msFromPhone,   setMsFromPhone]   = useState('')
  const [msFromEmail,   setMsFromEmail]   = useState('')
  const [msFromAddr1,   setMsFromAddr1]   = useState('')
  const [msFromAddr2,   setMsFromAddr2]   = useState('')
  const [msFromSuburb,  setMsFromSuburb]  = useState('')
  const [msFromPost,    setMsFromPost]    = useState('')
  const [msFromState,   setMsFromState]   = useState('')

  async function load() {
    setLoading(true); setError(null)
    try {
      const r = await fetch('/api/b2b/admin/settings', { credentials: 'same-origin' })
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`)
      const j: ApiResponse = await r.json()
      setData(j)
      setPrefix(j.settings.myob_invoice_number_prefix || 'JA')
      setPadding(j.settings.myob_invoice_number_padding || 6)
      setSeqInput(String(j.settings.myob_invoice_number_seq ?? 0))
      setCnPrefix(j.settings.myob_credit_note_number_prefix || 'CR')
      setCnPadding(j.settings.myob_credit_note_number_padding || 6)
      setCnSeqInput(String(j.settings.myob_credit_note_number_seq ?? 0))
      setFeePct(Number(j.settings.card_fee_percent || 0.017))
      setFeeFixed(Number(j.settings.card_fee_fixed || 0.30))
      setSlackUrl(j.settings.slack_new_order_webhook_url || '')
      setAdminEmails(j.settings.admin_order_notify_emails || '')
      setFromEmail(j.settings.outbound_from_email || '')
      setLogoUrl(j.settings.email_logo_url || '')
      setFreightMarkup(Number(j.settings.freight_markup_percent ?? 20))
      setMsFromName(j.settings.machship_from_name || '')
      setMsFromCompany(j.settings.machship_from_company || '')
      setMsFromPhone(j.settings.machship_from_phone || '')
      setMsFromEmail(j.settings.machship_from_email || '')
      setMsFromAddr1(j.settings.machship_from_address_line1 || '')
      setMsFromAddr2(j.settings.machship_from_address_line2 || '')
      setMsFromSuburb(j.settings.machship_from_suburb || '')
      setMsFromPost(j.settings.machship_from_postcode || '')
      setMsFromState(j.settings.machship_from_state || '')
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [])

  // Live preview based on local edits
  const livePreview = useMemo(() => {
    const p = (prefix || '').trim()
    const seq = parseInt(seqInput || '0', 10) || 0
    const pad = padding || 6
    if (!p) return ''
    const num = String(seq + 1).padStart(pad, '0')
    return p + num
  }, [prefix, padding, seqInput])

  const livePreviewLength = livePreview.length
  const overLimit = livePreviewLength > 13

  const cnLivePreview = useMemo(() => {
    const p = (cnPrefix || '').trim()
    const seq = parseInt(cnSeqInput || '0', 10) || 0
    const pad = cnPadding || 6
    if (!p) return ''
    const num = String(seq + 1).padStart(pad, '0')
    return p + num
  }, [cnPrefix, cnPadding, cnSeqInput])

  const cnLivePreviewLength = cnLivePreview.length
  const cnOverLimit = cnLivePreviewLength > 13

  async function save(payload: Record<string, any>) {
    setSaving(true); setError(null); setSavedFlash(null)
    try {
      const r = await fetch('/api/b2b/admin/settings', {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const j = await r.json()
      if (!r.ok) {
        if (j?.issues && Array.isArray(j.issues)) {
          throw new Error(j.issues.join(' • '))
        }
        throw new Error(j?.error || `HTTP ${r.status}`)
      }
      setSavedFlash('Saved')
      setTimeout(() => setSavedFlash(null), 2000)
      await load()
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setSaving(false)
    }
  }

  // Upload an email logo to the public b2b-catalogue bucket and save its URL.
  async function uploadLogo(file: File) {
    setLogoErr('')
    if (!/^image\//.test(file.type)) { setLogoErr('Pick an image file (PNG/JPG/SVG).'); return }
    if (file.size > 5 * 1024 * 1024) { setLogoErr('Image too large (max 5MB).'); return }
    setLogoUploading(true)
    try {
      const supabase = getSupabase()
      const ext = (file.name.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '')
      const path = `email-logo/logo-${Date.now()}.${ext}`
      const { error: upErr } = await supabase.storage.from('b2b-catalogue').upload(path, file, { cacheControl: '3600', upsert: true, contentType: file.type })
      if (upErr) throw new Error(upErr.message || 'Upload failed')
      const { data: { publicUrl } } = supabase.storage.from('b2b-catalogue').getPublicUrl(path)
      setLogoUrl(publicUrl)
      await save({ email_logo_url: publicUrl })
    } catch (e: any) { setLogoErr(e?.message || 'Upload failed') }
    finally { setLogoUploading(false) }
  }

  return (
    <>
      <Head><title>B2B Settings · JA Portal</title></Head>
      <div style={{display:'flex',flexDirection:'column',minHeight:'100vh',background:T.bg,color:T.text,fontFamily:'system-ui,-apple-system,sans-serif'}}>
        <PortalTopBar
          activeId="b2b"
          currentUserRole={user.role}
          currentUserVisibleTabs={user.visibleTabs}
          currentUserName={user.displayName}
          currentUserEmail={user.email}
        />
        <main className="b2b-admin-main" style={{flex:1,padding:'28px 32px',maxWidth:1100,width:'100%',boxSizing:'border-box'}}>
          <B2BAdminTabs active="settings"/>

          {/* Breadcrumb header — same pattern as catalogue.tsx */}
          <header style={{marginBottom:18}}>
            <div style={{fontSize:12,color:T.text3,textTransform:'uppercase',letterSpacing:'0.08em',marginBottom:4}}>
              <a href="/admin/b2b" style={{color:T.text3,textDecoration:'none'}}>B2B Portal</a>
              {' / '}
              <span style={{color:T.text2}}>Settings</span>
            </div>
            <h1 style={{fontSize:22,fontWeight:600,margin:0,letterSpacing:'-0.01em'}}>B2B portal settings</h1>
            <div style={{fontSize:13,color:T.text3,marginTop:4}}>
              Configure how the distributor portal interacts with Stripe and MYOB.
            </div>
          </header>

          {/* Toasts — fixed so they stay visible above an open settings window */}
          {error && (
            <div style={{position:'fixed',top:70,left:'50%',transform:'translateX(-50%)',zIndex:1000,maxWidth:560,padding:12,background:`${T.red}1f`,border:`1px solid ${T.red}55`,borderRadius:8,color:T.red,fontSize:13,boxShadow:'0 10px 30px rgba(0,0,0,0.4)'}}>
              {error}
            </div>
          )}
          {savedFlash && (
            <div style={{position:'fixed',top:70,left:'50%',transform:'translateX(-50%)',zIndex:1000,padding:'8px 14px',background:`${T.green}1f`,border:`1px solid ${T.green}55`,borderRadius:8,color:T.green,fontSize:13,boxShadow:'0 10px 30px rgba(0,0,0,0.4)'}}>
              ✓ {savedFlash}
            </div>
          )}

          {loading && !data && (
            <div style={{padding:36,textAlign:'center',color:T.text3,fontSize:13}}>Loading…</div>
          )}

          {data && (
            <>
              {/* Icon tiles — click one to open its settings in a floating window */}
              <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill, minmax(190px, 1fr))',gap:14,marginBottom:8}}>
                {SETTINGS_SECTIONS.map(s => (
                  <button key={s.id} onClick={() => setOpenSectionId(s.id)}
                    style={{display:'flex',alignItems:'center',gap:12,padding:'15px 16px',background:T.bg2,border:`1px solid ${T.border}`,borderRadius:12,cursor:'pointer',fontFamily:'inherit',color:T.text,textAlign:'left'}}>
                    <span style={{width:42,height:42,borderRadius:11,flexShrink:0,display:'flex',alignItems:'center',justifyContent:'center',background:`${s.accent}1f`,color:s.accent,border:`1px solid ${s.accent}33`}}>
                      <AppIcon name={s.icon} size={22}/>
                    </span>
                    <span style={{fontSize:13,fontWeight:600}}>{s.title}</span>
                  </button>
                ))}
              </div>

              {/* ─── Models ─── */}
              <Section id="models" activeId={openSectionId} onClose={closeSection} title="Models"
                description="Vehicle models (or other primary attribute) used to group products on the distributor catalogue.">
                <TaxonomyEditor
                  endpoint="/api/b2b/admin/models"
                  collectionKey="models"
                  itemKey="model"
                  itemLabel="model"
                />
              </Section>

              {/* ─── Product Types ─── */}
              <Section id="product-types" activeId={openSectionId} onClose={closeSection} title="Product Types"
                description="Product categories (e.g. Brake disc, CV axle) used to group products on the distributor catalogue.">
                <TaxonomyEditor
                  endpoint="/api/b2b/admin/product-types"
                  collectionKey="product_types"
                  itemKey="product_type"
                  itemLabel="product type"
                />
              </Section>

              {/* ─── Tiers ─── */}
              <Section id="tiers" activeId={openSectionId} onClose={closeSection} title="Distributor Tiers"
                description="Pricing / access tiers (e.g. Bronze, Silver, Gold). Assign distributors to a tier from the distributor detail page. Tier-specific controls (visibility, discounts) are layered on in follow-up updates.">
                <TaxonomyEditor
                  endpoint="/api/b2b/admin/tiers"
                  collectionKey="tiers"
                  itemKey="tier"
                  itemLabel="tier"
                />
              </Section>

              {/* ─── Invoice numbering ─── */}
              <Section id="invoice-numbering" activeId={openSectionId} onClose={closeSection} title="MYOB Invoice Numbering"
                description="Each B2B order writes a Sale.Invoice to MYOB JAWS. The invoice number is portal-controlled (prefix + zero-padded sequence). MYOB caps the field at 13 characters total.">

                <div className="b2b-col2" style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:14,marginBottom:14}}>
                  <Field label="Prefix" hint="Letters/digits, no spaces. Max 8 chars.">
                    <input
                      type="text"
                      value={prefix}
                      onChange={e => setPrefix(e.target.value.replace(/\s/g, ''))}
                      maxLength={8}
                      style={inputStyle()}
                    />
                  </Field>
                  <Field label="Sequence padding" hint="Zero-pad width (4-8 digits)">
                    <input
                      type="number"
                      value={padding}
                      onChange={e => setPadding(Math.max(4, Math.min(8, parseInt(e.target.value || '6', 10) || 6)))}
                      min={4}
                      max={8}
                      style={inputStyle()}
                    />
                  </Field>
                  <Field label="Current sequence" hint="Last consumed value. Edit to skip ahead.">
                    <input
                      type="number"
                      value={seqInput}
                      onChange={e => setSeqInput(e.target.value)}
                      min={0}
                      style={inputStyle()}
                    />
                  </Field>
                </div>

                <div style={{
                  padding:'12px 14px',
                  background:T.bg3,
                  border:`1px solid ${overLimit ? T.red : T.border2}`,
                  borderRadius:6,
                  marginBottom:14,
                  display:'flex',justifyContent:'space-between',alignItems:'center',gap:12,
                }}>
                  <div>
                    <div style={{fontSize:10,color:T.text3,textTransform:'uppercase',letterSpacing:'0.06em',marginBottom:2}}>Next invoice number</div>
                    <div style={{fontSize:18,fontWeight:600,fontFamily:'monospace',color:overLimit?T.red:T.text}}>
                      {livePreview || '—'}
                    </div>
                  </div>
                  <div style={{textAlign:'right',fontSize:12,color: overLimit ? T.red : T.text3}}>
                    {livePreviewLength} / 13 chars
                    {overLimit && <div style={{fontWeight:500}}>Exceeds MYOB limit</div>}
                  </div>
                </div>

                <button
                  onClick={() => save({
                    myob_invoice_number_prefix: prefix,
                    myob_invoice_number_padding: padding,
                    myob_invoice_number_seq: parseInt(seqInput || '0', 10) || 0,
                  })}
                  disabled={saving || overLimit || !prefix.trim()}
                  style={primaryBtn(!saving && !overLimit && !!prefix.trim())}>
                  {saving ? 'Saving…' : 'Save numbering'}
                </button>
              </Section>

              {/* ─── Credit note numbering ─── */}
              <Section id="credit-numbering" activeId={openSectionId} onClose={closeSection} title="MYOB Credit Note Numbering"
                description="Refund credit notes are written to MYOB JAWS as a separate stream from order invoices. Same 13-character MYOB cap applies.">

                <div className="b2b-col2" style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:14,marginBottom:14}}>
                  <Field label="Prefix" hint="Letters/digits, no spaces. Max 8 chars.">
                    <input
                      type="text"
                      value={cnPrefix}
                      onChange={e => setCnPrefix(e.target.value.replace(/\s/g, ''))}
                      maxLength={8}
                      style={inputStyle()}
                    />
                  </Field>
                  <Field label="Sequence padding" hint="Zero-pad width (4-8 digits)">
                    <input
                      type="number"
                      value={cnPadding}
                      onChange={e => setCnPadding(Math.max(4, Math.min(8, parseInt(e.target.value || '6', 10) || 6)))}
                      min={4}
                      max={8}
                      style={inputStyle()}
                    />
                  </Field>
                  <Field label="Current sequence" hint="Last consumed value. Edit to skip ahead.">
                    <input
                      type="number"
                      value={cnSeqInput}
                      onChange={e => setCnSeqInput(e.target.value)}
                      min={0}
                      style={inputStyle()}
                    />
                  </Field>
                </div>

                <div style={{
                  padding:'12px 14px',
                  background:T.bg3,
                  border:`1px solid ${cnOverLimit ? T.red : T.border2}`,
                  borderRadius:6,
                  marginBottom:14,
                  display:'flex',justifyContent:'space-between',alignItems:'center',gap:12,
                }}>
                  <div>
                    <div style={{fontSize:10,color:T.text3,textTransform:'uppercase',letterSpacing:'0.06em',marginBottom:2}}>Next credit note number</div>
                    <div style={{fontSize:18,fontWeight:600,fontFamily:'monospace',color:cnOverLimit?T.red:T.text}}>
                      {cnLivePreview || '—'}
                    </div>
                  </div>
                  <div style={{textAlign:'right',fontSize:12,color: cnOverLimit ? T.red : T.text3}}>
                    {cnLivePreviewLength} / 13 chars
                    {cnOverLimit && <div style={{fontWeight:500}}>Exceeds MYOB limit</div>}
                  </div>
                </div>

                <button
                  onClick={() => save({
                    myob_credit_note_number_prefix: cnPrefix,
                    myob_credit_note_number_padding: cnPadding,
                    myob_credit_note_number_seq: parseInt(cnSeqInput || '0', 10) || 0,
                  })}
                  disabled={saving || cnOverLimit || !cnPrefix.trim()}
                  style={primaryBtn(!saving && !cnOverLimit && !!cnPrefix.trim())}>
                  {saving ? 'Saving…' : 'Save numbering'}
                </button>
              </Section>

              {/* ─── Card surcharge ─── */}
              <Section id="card-surcharge" activeId={openSectionId} onClose={closeSection} title="Card Surcharge"
                description="Pass-through Stripe processing fee. Applied to each order during checkout to make the JAWS payout equal the goods subtotal (inc GST) after Stripe takes its cut.">

                <div className="b2b-col2" style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:14,marginBottom:14}}>
                  <Field label="Percent" hint="Stripe AU domestic card rate (1.7% = 0.017)">
                    <input
                      type="number"
                      value={feePct}
                      onChange={e => setFeePct(Number(e.target.value || 0))}
                      step="0.001"
                      min={0} max={0.10}
                      style={inputStyle()}
                    />
                  </Field>
                  <Field label="Fixed amount ($)" hint="Stripe per-transaction fee ($0.30)">
                    <input
                      type="number"
                      value={feeFixed}
                      onChange={e => setFeeFixed(Number(e.target.value || 0))}
                      step="0.01"
                      min={0} max={5}
                      style={inputStyle()}
                    />
                  </Field>
                </div>

                <button
                  onClick={() => save({ card_fee_percent: feePct, card_fee_fixed: feeFixed })}
                  disabled={saving}
                  style={primaryBtn(!saving)}>
                  {saving ? 'Saving…' : 'Save surcharge'}
                </button>
              </Section>

              {/* ─── Carrier connections ─── */}
              <Section id="carriers" activeId={openSectionId} onClose={closeSection} title="Freight Carrier Connections"
                description="Plug in API credentials for each freight carrier we use. The MachShip token here drives live quoting and booking — the postcode zones further down are only used as a fallback when live quoting isn't available.">
                <FreightCarriersManager/>
              </Section>

              {/* ─── Freight pricing & sender (MachShip) ─── */}
              <Section id="freight-pricing" activeId={openSectionId} onClose={closeSection} title="Freight Pricing &amp; Sender Address"
                description="Markup applied to MachShip's quoted price before showing it to distributors, plus the pickup address used for every booking. Both are required for live quoting and booking to work end-to-end.">
                <Field label="Markup %" hint="Added on top of MachShip's quote (e.g. 20 = quote × 1.20). Range 0–200.">
                  <input
                    type="number"
                    min={0}
                    max={200}
                    step={0.1}
                    value={freightMarkup}
                    onChange={e => setFreightMarkup(Number(e.target.value))}
                    style={{...inputStyle(), maxWidth: 120}}
                  />
                </Field>
                <div style={{marginTop:14}}>
                  <button
                    onClick={() => save({ freight_markup_percent: freightMarkup })}
                    disabled={saving}
                    style={primaryBtn(!saving)}>
                    {saving ? 'Saving…' : 'Save markup'}
                  </button>
                </div>

                <div style={{height:24}}/>

                <div style={{fontSize:13,color:T.text2,fontWeight:500,marginBottom:8}}>Sender (pickup) address</div>
                <div className="b2b-col2" style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}}>
                  <Field label="Contact name">
                    <input type="text" value={msFromName} onChange={e => setMsFromName(e.target.value)} style={inputStyle()} placeholder="Workshop staff name"/>
                  </Field>
                  <Field label="Company">
                    <input type="text" value={msFromCompany} onChange={e => setMsFromCompany(e.target.value)} style={inputStyle()} placeholder="Just Autos Mechanical"/>
                  </Field>
                  <Field label="Phone">
                    <input type="text" value={msFromPhone} onChange={e => setMsFromPhone(e.target.value)} style={inputStyle()} placeholder="07 ..."/>
                  </Field>
                  <Field label="Email">
                    <input type="text" value={msFromEmail} onChange={e => setMsFromEmail(e.target.value)} style={inputStyle()} placeholder="dispatch@..."/>
                  </Field>
                  <Field label="Address line 1">
                    <input type="text" value={msFromAddr1} onChange={e => setMsFromAddr1(e.target.value)} style={inputStyle()}/>
                  </Field>
                  <Field label="Address line 2">
                    <input type="text" value={msFromAddr2} onChange={e => setMsFromAddr2(e.target.value)} style={inputStyle()}/>
                  </Field>
                  <Field label="Suburb">
                    <input type="text" value={msFromSuburb} onChange={e => setMsFromSuburb(e.target.value)} style={inputStyle()}/>
                  </Field>
                  <Field label="Postcode" hint="4 digits">
                    <input type="text" value={msFromPost} onChange={e => setMsFromPost(e.target.value)} style={{...inputStyle(), maxWidth: 120}} placeholder="4000"/>
                  </Field>
                  <Field label="State" hint="QLD, NSW, VIC, etc.">
                    <input type="text" value={msFromState} onChange={e => setMsFromState(e.target.value)} style={{...inputStyle(), maxWidth: 120}}/>
                  </Field>
                </div>
                <div style={{marginTop:14}}>
                  <button
                    onClick={() => save({
                      machship_from_name:          msFromName,
                      machship_from_company:       msFromCompany,
                      machship_from_phone:         msFromPhone,
                      machship_from_email:         msFromEmail,
                      machship_from_address_line1: msFromAddr1,
                      machship_from_address_line2: msFromAddr2,
                      machship_from_suburb:        msFromSuburb,
                      machship_from_postcode:      msFromPost,
                      machship_from_state:         msFromState,
                    })}
                    disabled={saving}
                    style={primaryBtn(!saving)}>
                    {saving ? 'Saving…' : 'Save sender address'}
                  </button>
                </div>
              </Section>

              {/* ─── Freight zones (manual fallback) ─── */}
              <Section id="freight-zones" activeId={openSectionId} onClose={closeSection} title="Freight Zones &amp; Rates (manual fallback)"
                description="Postcode-driven shipping rates the cart shows when no live carrier rates are available. Add a zone, paste the postcode ranges it covers, then add 1+ rates (Standard, Express, etc.).">
                <FreightZonesManager/>
              </Section>

              {/* ─── Freight packaging ─── */}
              <Section id="freight-packaging" activeId={openSectionId} onClose={closeSection} title="Freight Packaging"
                description="Your standard cartons + pallet spec + the weight at which an order ships on a pallet. Feeds the cartonizer that packs multi-item orders for MachShip quotes.">
                <FreightPackagingManager/>
              </Section>

              {/* ─── Slack ─── */}
              <Section id="slack" activeId={openSectionId} onClose={closeSection} title="Slack Notifications"
                description="Optional. If set, a message posts to the channel each time an order is paid.">

                <Field label="Incoming webhook URL" hint="Must start with https://hooks.slack.com/">
                  <input
                    type="text"
                    value={slackUrl}
                    onChange={e => setSlackUrl(e.target.value)}
                    placeholder="https://hooks.slack.com/services/..."
                    style={inputStyle()}
                  />
                </Field>

                <div style={{marginTop:14}}>
                  <button
                    onClick={() => save({ slack_new_order_webhook_url: slackUrl })}
                    disabled={saving}
                    style={primaryBtn(!saving)}>
                    {saving ? 'Saving…' : 'Save Slack URL'}
                  </button>
                </div>
              </Section>

              {/* ─── Order notifications ─── */}
              <Section id="order-notify" activeId={openSectionId} onClose={closeSection} title="Order Notifications"
                description="When an order is paid, the portal auto-raises drop-ship POs (emailing suppliers) and sends an order-placed email — with a no-login Book Freight button — to these recipients.">
                <Field label="Send emails from" hint="The mailbox ALL outbound B2B emails are sent from (invoices, confirmations, freight, supplier POs). Must be a mailbox in your Microsoft 365 tenant with Mail.Send granted.">
                  <input
                    type="email"
                    value={fromEmail}
                    onChange={e => setFromEmail(e.target.value)}
                    placeholder="accounts@justautoswholesale.com"
                    style={inputStyle()}
                  />
                </Field>
                <div style={{marginTop:14,marginBottom:20}}>
                  <button onClick={() => save({ outbound_from_email: fromEmail })} disabled={saving} style={primaryBtn(!saving)}>
                    {saving ? 'Saving…' : 'Save sender'}
                  </button>
                </div>

                <Field label="Email logo" hint="Shown in the header of every notification email. Upload an image, or paste a public image URL. Leave blank for the plain 'Just Autos' text header.">
                  {logoUrl && (
                    <div style={{marginBottom:10,padding:10,background:'#fff',borderRadius:8,display:'inline-block'}}>
                      <img src={logoUrl} alt="Email logo preview" style={{maxHeight:56,maxWidth:240,display:'block'}}/>
                    </div>
                  )}
                  <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}>
                    <input
                      type="url"
                      value={logoUrl}
                      onChange={e => setLogoUrl(e.target.value)}
                      placeholder="https://…/logo.png"
                      style={{...inputStyle(), flex:1, minWidth:220}}
                    />
                    <label style={{...primaryBtn(!logoUploading), display:'inline-block', cursor: logoUploading ? 'wait' : 'pointer'}}>
                      {logoUploading ? 'Uploading…' : 'Upload…'}
                      <input type="file" accept="image/*" disabled={logoUploading} onChange={e => { const f = e.target.files?.[0]; if (f) uploadLogo(f); e.currentTarget.value = '' }} style={{display:'none'}}/>
                    </label>
                  </div>
                  {logoErr && <div style={{fontSize:12, color:'#f04e4e', marginTop:6}}>{logoErr}</div>}
                </Field>
                <div style={{marginTop:14,marginBottom:20,display:'flex',gap:8}}>
                  <button onClick={() => save({ email_logo_url: logoUrl })} disabled={saving} style={primaryBtn(!saving)}>
                    {saving ? 'Saving…' : 'Save logo'}
                  </button>
                  {logoUrl && (
                    <button onClick={() => { setLogoUrl(''); save({ email_logo_url: '' }) }} disabled={saving} style={{padding:'9px 16px',borderRadius:7,border:'1px solid rgba(255,255,255,0.18)',background:'transparent',color:'#aab0c0',fontSize:13,fontFamily:'inherit',cursor: saving ? 'default':'pointer'}}>
                      Remove
                    </button>
                  )}
                </div>

                <Field label="Order notification emails" hint="Who gets the internal 'order placed' email. Comma-separated. Falls back to the B2B_ADMIN_NOTIFY_EMAILS env var if blank.">
                  <input
                    type="text"
                    value={adminEmails}
                    onChange={e => setAdminEmails(e.target.value)}
                    placeholder="ops@justautosmechanical.com.au, chris@justautosmechanical.com.au"
                    style={inputStyle()}
                  />
                </Field>
                <div style={{marginTop:14}}>
                  <button onClick={() => save({ admin_order_notify_emails: adminEmails })} disabled={saving} style={primaryBtn(!saving)}>
                    {saving ? 'Saving…' : 'Save recipients'}
                  </button>
                </div>
              </Section>

              {/* ─── Email templates ─── */}
              <Section id="email-templates" activeId={openSectionId} onClose={closeSection} title="Email Notifications"
                description="Edit the subject + wording (and turn on/off) every transactional email — to suppliers, distributors and your team. Structured bits drop in via {{placeholders}}.">
                <EmailTemplatesManager/>
              </Section>

              {/* ─── Read-only diagnostics ─── */}
              <Section id="status" activeId={openSectionId} onClose={closeSection} title="System Status" description="Read-only — for debugging.">
                <DiagRow label="Stripe Secret Key"     status={data.stripe_env.secret_key_set     ? 'ok' : 'missing'} value={data.stripe_env.secret_key_set     ? 'Set in env' : 'Not configured — checkout disabled'}/>
                <DiagRow label="Stripe Webhook Secret" status={data.stripe_env.webhook_secret_set ? 'ok' : 'missing'} value={data.stripe_env.webhook_secret_set ? 'Set in env' : 'Not configured — webhooks will be rejected'}/>
                <DiagRow label="MYOB GST Tax Code"     status={data.settings.myob_jaws_gst_tax_code_uid ? 'ok' : 'pending'} value={data.settings.myob_jaws_gst_tax_code_uid ? 'Resolved' : 'Will auto-resolve on first checkout'}/>
                <DiagRow label="MYOB FRE Tax Code"     status={data.settings.myob_jaws_fre_tax_code_uid ? 'ok' : 'pending'} value={data.settings.myob_jaws_fre_tax_code_uid ? 'Resolved' : 'Will auto-resolve on first checkout'}/>
                <DiagRow label="Card Fee Account"      status={data.settings.myob_card_fee_account_uid  ? 'ok' : 'missing'} value={data.settings.myob_card_fee_account_code || 'Not configured — checkout disabled'}/>
                <DiagRow label="Last Catalogue Sync"   status={data.settings.last_catalogue_sync_at     ? 'ok' : 'pending'} value={
                  data.settings.last_catalogue_sync_at
                    ? `${new Date(data.settings.last_catalogue_sync_at).toLocaleString('en-AU')} · added ${data.settings.last_catalogue_sync_added || 0}, updated ${data.settings.last_catalogue_sync_updated || 0}${data.settings.last_catalogue_sync_error ? ` · ⚠ ${data.settings.last_catalogue_sync_error}` : ''}`
                    : 'Never run'
                }/>
              </Section>
            </>
          )}

        </main>
      </div>
    </>
  )
}

// ─── UI helpers ────────────────────────────────────────────────────────
// Each settings section renders as a floating window — only when its tile
// (id) is the active one. Returns null otherwise, so its body (and any
// data fetches inside it) stays unmounted until opened.
function Section({ id, activeId, onClose, title, description, children }: {
  id: string
  activeId: string | null
  onClose: () => void
  title: string
  description?: string
  children: React.ReactNode
}) {
  const open = id === activeId
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])
  if (!open) return null
  return (
    <div onClick={onClose}
      style={{position:'fixed',inset:0,zIndex:950,background:'rgba(8,10,13,0.8)',backdropFilter:'blur(6px)',display:'flex',alignItems:'flex-start',justifyContent:'center',padding:'64px 20px 32px',overflowY:'auto'}}>
      <div onClick={e => e.stopPropagation()}
        style={{width:'100%',maxWidth:760,background:T.bg2,border:`1px solid ${T.border2}`,borderRadius:14,boxShadow:'0 24px 60px rgba(0,0,0,0.5)',overflow:'hidden'}}>
        <div style={{display:'flex',alignItems:'center',gap:10,padding:'16px 22px',borderBottom:`1px solid ${T.border}`,position:'sticky',top:0,background:T.bg2,zIndex:1}}>
          <h2 style={{fontSize:16,fontWeight:600,margin:0,letterSpacing:'-0.005em'}}>{title}</h2>
          <span style={{flex:1}}/>
          <button onClick={onClose} style={{background:'none',border:'none',color:T.text3,fontSize:24,cursor:'pointer',lineHeight:1,padding:'0 4px'}}>×</button>
        </div>
        <div style={{padding:'20px 22px'}}>
          {description && (
            <p style={{fontSize:13,color:T.text3,margin:'0 0 18px',lineHeight:1.5}}>{description}</p>
          )}
          {children}
        </div>
      </div>
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label style={{display:'flex',flexDirection:'column',gap:4}}>
      <span style={{fontSize:12,color:T.text2,fontWeight:500}}>{label}</span>
      {children}
      {hint && <span style={{fontSize:10,color:T.text3}}>{hint}</span>}
    </label>
  )
}

function inputStyle(): React.CSSProperties {
  return {
    background:T.bg3,border:`1px solid ${T.border2}`,color:T.text,
    borderRadius:5,padding:'8px 10px',fontSize:13,outline:'none',
    fontFamily:'inherit',width:'100%',boxSizing:'border-box',
  }
}

function primaryBtn(enabled: boolean): React.CSSProperties {
  return {
    padding:'9px 16px',borderRadius:6,
    border:`1px solid ${enabled ? T.blue : T.border2}`,
    background: enabled ? T.blue : T.bg3,
    color: enabled ? '#fff' : T.text3,
    fontSize:13,fontWeight:500,
    cursor: enabled ? 'pointer' : 'not-allowed',
    fontFamily:'inherit',
  }
}

// ─── Taxonomy editor (shared by Models + Product Types) ──────────────────
interface TaxonomyItem {
  id: string
  name: string
  sort_order: number
  is_active: boolean
  usage_count: number
}

function TaxonomyEditor({
  endpoint, collectionKey, itemKey, itemLabel,
}: {
  endpoint: string
  collectionKey: string   // 'models' | 'product_types'
  itemKey: string         // 'model' | 'product_type'
  itemLabel: string       // 'model' | 'product type'
}) {
  const [items, setItems] = useState<TaxonomyItem[] | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [actionErr, setActionErr] = useState<string | null>(null)
  const [newName, setNewName] = useState('')

  async function load() {
    setLoadErr(null)
    try {
      const r = await fetch(endpoint, { credentials: 'same-origin' })
      const j = await r.json()
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`)
      setItems(j[collectionKey] || [])
    } catch (e: any) {
      setLoadErr(e?.message || String(e))
    }
  }
  useEffect(() => { load() }, [])

  async function create() {
    const name = newName.trim()
    if (!name) return
    setBusy(true); setActionErr(null)
    try {
      const r = await fetch(endpoint, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      const j = await r.json()
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`)
      setNewName('')
      await load()
    } catch (e: any) {
      setActionErr(e?.message || String(e))
    } finally {
      setBusy(false)
    }
  }

  async function patch(id: string, body: Record<string, any>) {
    setBusy(true); setActionErr(null)
    try {
      const r = await fetch(`${endpoint}/${id}`, {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const j = await r.json()
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`)
      await load()
    } catch (e: any) {
      setActionErr(e?.message || String(e))
    } finally {
      setBusy(false)
    }
  }

  async function remove(item: TaxonomyItem) {
    const noun = `"${item.name}"`
    const msg = item.usage_count > 0
      ? `Delete ${itemLabel} ${noun}? It is currently linked to ${item.usage_count} product(s) — they will be un-tagged.`
      : `Delete ${itemLabel} ${noun}?`
    if (!confirm(msg)) return
    setBusy(true); setActionErr(null)
    try {
      const r = await fetch(`${endpoint}/${item.id}`, { method: 'DELETE', credentials: 'same-origin' })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`)
      await load()
    } catch (e: any) {
      setActionErr(e?.message || String(e))
    } finally {
      setBusy(false)
    }
  }

  if (loadErr) {
    return <div style={{padding:8,color:T.red,fontSize:12}}>Couldn't load: {loadErr}</div>
  }
  if (!items) {
    return <div style={{padding:8,color:T.text3,fontSize:12}}>Loading…</div>
  }

  return (
    <div>
      {actionErr && (
        <div style={{padding:8,marginBottom:10,background:`${T.red}15`,border:`1px solid ${T.red}40`,borderRadius:6,color:T.red,fontSize:12}}>
          {actionErr}
        </div>
      )}

      {items.length === 0 ? (
        <div style={{padding:'12px 0',color:T.text3,fontSize:13}}>No {itemLabel}s yet — add one below.</div>
      ) : (
        <div style={{display:'flex',flexDirection:'column',gap:1,marginBottom:14,background:T.border,borderRadius:6,overflow:'hidden'}}>
          {items.map(item => (
            <TaxonomyRow key={item.id} item={item} busy={busy}
              onRename={(name) => patch(item.id, { name })}
              onToggleActive={() => patch(item.id, { is_active: !item.is_active })}
              onDelete={() => remove(item)} />
          ))}
        </div>
      )}

      <div style={{display:'flex',gap:8}}>
        <input
          type="text"
          value={newName}
          onChange={e => setNewName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') create() }}
          placeholder={`Add a ${itemLabel}…`}
          maxLength={80}
          disabled={busy}
          style={{...inputStyle(), flex:1}}
        />
        <button
          onClick={create}
          disabled={busy || !newName.trim()}
          style={primaryBtn(!busy && !!newName.trim())}>
          Add
        </button>
      </div>
    </div>
  )
}

function TaxonomyRow({ item, busy, onRename, onToggleActive, onDelete }: {
  item: TaxonomyItem
  busy: boolean
  onRename: (name: string) => void
  onToggleActive: () => void
  onDelete: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(item.name)
  useEffect(() => { setDraft(item.name) }, [item.name])

  function commit() {
    const v = draft.trim()
    if (!v || v === item.name) { setEditing(false); setDraft(item.name); return }
    onRename(v)
    setEditing(false)
  }

  return (
    <div style={{
      display:'flex',alignItems:'center',gap:10,padding:'10px 12px',
      background:T.bg2,opacity: item.is_active ? 1 : 0.55,
    }}>
      <div style={{flex:1,minWidth:0}}>
        {editing ? (
          <input
            type="text"
            value={draft}
            autoFocus
            onChange={e => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={e => {
              if (e.key === 'Enter') commit()
              if (e.key === 'Escape') { setDraft(item.name); setEditing(false) }
            }}
            style={{...inputStyle(), padding:'4px 8px', fontSize:13}}
          />
        ) : (
          <button
            onClick={() => setEditing(true)}
            style={{
              background:'transparent',border:'none',color:T.text,fontSize:13,
              padding:0,cursor:'pointer',fontFamily:'inherit',textAlign:'left',
              maxWidth:'100%',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',
            }}>
            {item.name}
          </button>
        )}
      </div>
      <div style={{fontSize:11,color:T.text3,fontFamily:'monospace',whiteSpace:'nowrap'}}>
        {item.usage_count} product{item.usage_count === 1 ? '' : 's'}
      </div>
      <button
        onClick={onToggleActive}
        disabled={busy}
        title={item.is_active ? 'Deactivate (hide from distributors)' : 'Reactivate'}
        style={{
          padding:'4px 10px',borderRadius:4,
          border:`1px solid ${item.is_active ? T.green : T.border2}`,
          background:'transparent',
          color: item.is_active ? T.green : T.text3,
          fontSize:11,fontFamily:'inherit',cursor:'pointer',whiteSpace:'nowrap',
        }}>
        {item.is_active ? 'Active' : 'Inactive'}
      </button>
      <button
        onClick={onDelete}
        disabled={busy}
        title="Delete"
        style={{
          background:'transparent',border:'none',color:T.text3,
          fontSize:16,cursor:'pointer',padding:'0 4px',
        }}>
        ×
      </button>
    </div>
  )
}

function DiagRow({ label, status, value }: { label: string; status: 'ok'|'pending'|'missing'; value: string }) {
  const color = status === 'ok' ? T.green : status === 'pending' ? T.amber : T.red
  const dot = status === 'ok' ? '●' : status === 'pending' ? '◐' : '○'
  return (
    <div style={{display:'flex',alignItems:'center',gap:12,padding:'8px 0',borderTop:`1px solid ${T.border}`}}>
      <span style={{color, fontSize:14, width:14}}>{dot}</span>
      <span style={{fontSize:13,color:T.text2,minWidth:160}}>{label}</span>
      <span style={{fontSize:13,color:T.text3,flex:1}}>{value}</span>
    </div>
  )
}

export async function getServerSideProps(context: any) {
  return requirePageAuth(context, 'edit:b2b_distributors')
}
