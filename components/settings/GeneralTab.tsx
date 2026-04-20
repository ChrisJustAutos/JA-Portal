// components/settings/GeneralTab.tsx
// General preferences tab for the Settings hub.
// Renders inside /settings when the "General" tab is active.

import { useState } from 'react'
import {
  usePreferences,
  DATE_RANGE_LABELS,
  REFRESH_LABELS,
  TIMEZONE_OPTIONS,
  LOCALE_OPTIONS,
  type DateRangeKey,
  type GstDisplay,
  type Theme,
} from '../../lib/preferences'

const T = {
  bg:'#0d0f12', bg2:'#131519', bg3:'#1a1d23', bg4:'#21252d',
  border:'rgba(255,255,255,0.07)', border2:'rgba(255,255,255,0.12)',
  text:'#e8eaf0', text2:'#8b90a0', text3:'#545968',
  blue:'#4f8ef7', green:'#34c77b', amber:'#f5a623', red:'#f04e4e', purple:'#a78bfa',
}

export default function GeneralTab() {
  const { prefs, loading, update } = usePreferences()
  const [saving, setSaving] = useState<string | null>(null)  // which field is saving
  const [err, setErr] = useState('')
  const [savedFlash, setSavedFlash] = useState<string | null>(null)

  async function save(patch: Partial<typeof prefs>, fieldKey: string) {
    setSaving(fieldKey)
    setErr('')
    try {
      await update(patch)
      setSavedFlash(fieldKey)
      setTimeout(() => setSavedFlash(null), 1500)
    } catch (e: any) {
      setErr(e?.message || 'Save failed')
    } finally {
      setSaving(null)
    }
  }

  if (loading) {
    return <div style={{ color: T.text3, padding: 30, textAlign: 'center', fontSize: 13 }}>Loading preferences…</div>
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 720 }}>
      {err && (
        <div style={{
          padding: '10px 14px', borderRadius: 8,
          background: `${T.red}15`, border: `1px solid ${T.red}40`, color: T.red, fontSize: 12,
        }}>
          {err}
        </div>
      )}

      {/* ── DISPLAY ───────────────────────────────────────────────────── */}
      <SettingsCard title="Display" description="How numbers and dates are shown across the portal.">

        <Field
          label="GST display"
          help="Portal data is stored ex-GST. Choose how amounts are shown on screen."
          saving={saving === 'gst_display'}
          saved={savedFlash === 'gst_display'}
        >
          <ButtonGroup
            value={prefs.gst_display}
            options={[
              { value: 'ex', label: 'Ex-GST', hint: 'Recommended for management & accounting' },
              { value: 'inc', label: 'Inc-GST', hint: 'Shows gross-to-customer amounts' },
            ]}
            onChange={v => save({ gst_display: v as GstDisplay }, 'gst_display')}
          />
        </Field>

        <Field
          label="Decimal precision"
          help="Whole dollars hide cents for cleaner dashboards; 2 decimals shows precise amounts."
          saving={saving === 'decimal_precision'}
          saved={savedFlash === 'decimal_precision'}
        >
          <ButtonGroup
            value={String(prefs.decimal_precision)}
            options={[
              { value: '0', label: 'Whole $', hint: '$51,233' },
              { value: '2', label: '2 decimals', hint: '$51,233.45' },
            ]}
            onChange={v => save({ decimal_precision: Number(v) as 0 | 2 }, 'decimal_precision')}
          />
        </Field>

        <Field
          label="Number format locale"
          help="Controls thousand separators and the decimal point."
          saving={saving === 'locale'}
          saved={savedFlash === 'locale'}
        >
          <Select
            value={prefs.locale}
            options={LOCALE_OPTIONS.map(o => ({ value: o.value, label: o.label }))}
            onChange={v => save({ locale: v }, 'locale')}
          />
        </Field>

        <Field
          label="Timezone"
          help="Dates and times are displayed in this timezone."
          saving={saving === 'timezone'}
          saved={savedFlash === 'timezone'}
        >
          <Select
            value={prefs.timezone}
            options={TIMEZONE_OPTIONS.map(tz => ({ value: tz, label: tz.replace('_', ' ') }))}
            onChange={v => save({ timezone: v }, 'timezone')}
          />
        </Field>

        <Field
          label="Theme"
          help="Light mode is coming soon."
        >
          <ButtonGroup
            value={prefs.theme}
            options={[
              { value: 'dark', label: 'Dark' },
              { value: 'light', label: 'Light (soon)', disabled: true },
              { value: 'auto', label: 'Auto (soon)', disabled: true },
            ]}
            onChange={v => save({ theme: v as Theme }, 'theme')}
          />
        </Field>
      </SettingsCard>

      {/* ── BEHAVIOUR ─────────────────────────────────────────────────── */}
      <SettingsCard title="Dashboard behaviour" description="Defaults applied when you open pages.">

        <Field
          label="Default date range"
          help="Applied when you open a dashboard or report without selecting a custom range."
          saving={saving === 'default_date_range'}
          saved={savedFlash === 'default_date_range'}
        >
          <Select
            value={prefs.default_date_range}
            options={Object.entries(DATE_RANGE_LABELS).map(([k, v]) => ({ value: k, label: v }))}
            onChange={v => save({ default_date_range: v as DateRangeKey }, 'default_date_range')}
          />
        </Field>

        <Field
          label="Auto-refresh"
          help="How often dashboards fetch fresh data from MYOB automatically."
          saving={saving === 'auto_refresh_seconds'}
          saved={savedFlash === 'auto_refresh_seconds'}
        >
          <Select
            value={String(prefs.auto_refresh_seconds)}
            options={[0, 300, 900, 3600].map(s => ({
              value: String(s),
              label: REFRESH_LABELS[s],
            }))}
            onChange={v => save({ auto_refresh_seconds: Number(v) as 0 | 300 | 900 | 3600 }, 'auto_refresh_seconds')}
          />
        </Field>
      </SettingsCard>

      {/* ── BRANDING ──────────────────────────────────────────────────── */}
      <SettingsCard title="Branding" description="Customise the look for exported reports and printouts.">
        <Field
          label="Company logo URL"
          help="Paste a public URL to a PNG or SVG. Upload support coming soon."
          saving={saving === 'company_logo_url'}
          saved={savedFlash === 'company_logo_url'}
        >
          <TextInput
            value={prefs.company_logo_url || ''}
            placeholder="https://…"
            onSave={v => save({ company_logo_url: v || null }, 'company_logo_url')}
          />
        </Field>
      </SettingsCard>

      {/* ── FIXED INFO ────────────────────────────────────────────────── */}
      <SettingsCard title="Fixed for now" description="These apply to all users and aren't configurable.">
        <Row label="Currency" value="Australian Dollar (AUD)"/>
        <Row label="Financial year" value="1 July – 30 June (Australian)"/>
      </SettingsCard>
    </div>
  )
}

// ── UI building blocks ─────────────────────────────────────────────────

function SettingsCard({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 10, padding: 18 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: T.text }}>{title}</div>
      {description && <div style={{ fontSize: 12, color: T.text3, marginTop: 3, lineHeight: 1.5 }}>{description}</div>}
      <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 16 }}>{children}</div>
    </div>
  )
}

function Field({ label, help, saving, saved, children }: { label: string; help?: string; saving?: boolean; saved?: boolean; children: React.ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '200px 1fr', gap: 16, alignItems: 'start' }}>
      <div>
        <div style={{ fontSize: 12, color: T.text, fontWeight: 500, display: 'flex', alignItems: 'center', gap: 6 }}>
          {label}
          {saving && <span style={{ fontSize: 10, color: T.text3 }}>saving…</span>}
          {saved && <span style={{ fontSize: 10, color: T.green }}>✓ saved</span>}
        </div>
        {help && <div style={{ fontSize: 10, color: T.text3, marginTop: 3, lineHeight: 1.5 }}>{help}</div>}
      </div>
      <div>{children}</div>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '200px 1fr', gap: 16, fontSize: 12 }}>
      <div style={{ color: T.text3 }}>{label}</div>
      <div style={{ color: T.text }}>{value}</div>
    </div>
  )
}

interface ButtonGroupOption { value: string; label: string; hint?: string; disabled?: boolean }
function ButtonGroup({ value, options, onChange }: { value: string; options: ButtonGroupOption[]; onChange: (v: string) => void }) {
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {options.map(opt => {
        const active = opt.value === value
        return (
          <button key={opt.value} disabled={opt.disabled} onClick={() => !opt.disabled && onChange(opt.value)}
            style={{
              padding: '7px 12px', borderRadius: 6,
              border: `1px solid ${active ? T.blue : T.border2}`,
              background: active ? `${T.blue}20` : T.bg3,
              color: opt.disabled ? T.text3 : (active ? T.blue : T.text),
              fontSize: 12, cursor: opt.disabled ? 'not-allowed' : 'pointer',
              fontFamily: 'inherit', fontWeight: active ? 600 : 400,
              opacity: opt.disabled ? 0.4 : 1,
              display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2,
              minWidth: 120, textAlign: 'left',
            }}>
            <span>{opt.label}</span>
            {opt.hint && <span style={{ fontSize: 10, color: T.text3, fontWeight: 400 }}>{opt.hint}</span>}
          </button>
        )
      })}
    </div>
  )
}

function Select({ value, options, onChange }: { value: string; options: { value: string; label: string }[]; onChange: (v: string) => void }) {
  return (
    <select value={value} onChange={e => onChange(e.target.value)}
      style={{
        background: T.bg3, border: `1px solid ${T.border2}`, color: T.text,
        borderRadius: 6, padding: '7px 10px', fontSize: 12, outline: 'none',
        fontFamily: 'inherit', minWidth: 280,
      }}>
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  )
}

function TextInput({ value: initial, placeholder, onSave }: { value: string; placeholder?: string; onSave: (v: string) => void }) {
  const [value, setValue] = useState(initial)
  const [focused, setFocused] = useState(false)
  const changed = value !== initial
  return (
    <div style={{ display: 'flex', gap: 6 }}>
      <input value={value} onChange={e => setValue(e.target.value)} placeholder={placeholder}
        onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
        style={{
          flex: 1, background: T.bg3, border: `1px solid ${focused ? T.blue : T.border2}`,
          color: T.text, borderRadius: 6, padding: '7px 10px', fontSize: 12,
          outline: 'none', fontFamily: 'inherit',
        }}/>
      {changed && (
        <button onClick={() => onSave(value.trim())}
          style={{
            padding: '7px 14px', borderRadius: 6, border: 'none', background: T.blue,
            color: '#fff', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600,
          }}>
          Save
        </button>
      )}
    </div>
  )
}
