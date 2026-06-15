// components/workshop/InventoryEditor.tsx
// Right-side drawer to edit a workshop_inventory item: part number, barcode
// (+ generate), supplier, cost + RRP/Trade/Wholesale tiers, and the MYOB sale
// (income) account. Save writes to the portal; "Push to MYOB" syncs the
// MYOB-backed fields back to AccountRight. Admin only (gated server-side too).

import { useEffect, useState, useCallback } from 'react'
import { T } from '../ui'
import { useToast } from '../ui/Feedback'

const lbl: React.CSSProperties = { display: 'block', fontSize: 11, color: T.text3, fontWeight: 600, marginBottom: 5 }
const inp: React.CSSProperties = { width: '100%', padding: '7px 10px', background: T.bg3, border: `1px solid ${T.border}`, borderRadius: 6, color: T.text, fontSize: 12, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' }
const sectionTitle: React.CSSProperties = { fontSize: 11, fontWeight: 700, color: T.text3, textTransform: 'uppercase', letterSpacing: '0.05em', margin: '22px 0 10px' }

type Acct = { uid: string; name: string; displayId: string }

export default function InventoryEditor({ id, onClose, onSaved }: { id: string; onClose: () => void; onSaved: () => void }) {
  const toast = useToast()
  const [item, setItem] = useState<any>(null)
  const [form, setForm] = useState<any>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [pushing, setPushing] = useState(false)
  const [genBusy, setGenBusy] = useState(false)
  const [suppliers, setSuppliers] = useState<string[]>([])
  const [accounts, setAccounts] = useState<Acct[]>([])
  const [acctErr, setAcctErr] = useState<string | null>(null)

  const f = (k: string, v: any) => setForm((s: any) => ({ ...s, [k]: v }))

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [it, sup, acc] = await Promise.all([
        fetch(`/api/workshop/inventory/${id}`).then(r => r.json()),
        fetch('/api/workshop/suppliers').then(r => r.json()).catch(() => ({})),
        fetch('/api/workshop/myob-accounts').then(r => r.json()).catch(() => ({})),
      ])
      const i = it.item || {}
      setItem(i)
      setForm({
        sku: i.sku || '', part_name: i.part_name || '', sale_description: i.sale_description || '',
        brand: i.brand || '', category: i.category || '', barcode: i.barcode || '', supplier: i.supplier || '',
        buy_price: i.buy_price ?? '', sell_price: i.sell_price ?? '', price_level_2: i.price_level_2 ?? '', price_level_3: i.price_level_3 ?? '',
        sale_account_uid: i.sale_account_uid || '', sale_account_name: i.sale_account_name || '',
        location: i.location || '', bin: i.bin || '', alert_qty: i.alert_qty ?? '', reorder_qty: i.reorder_qty ?? '', max_qty: i.max_qty ?? '',
      })
      setSuppliers((sup.suppliers || []).map((s: any) => s.name).filter(Boolean))
      setAccounts(acc.incomeAccounts || [])
      setAcctErr(acc.error || null)
    } finally { setLoading(false) }
  }, [id])

  useEffect(() => { load() }, [load])

  async function save(): Promise<boolean> {
    setSaving(true)
    try {
      const r = await fetch(`/api/workshop/inventory/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) })
      const d = await r.json()
      if (!r.ok) { toast(d.error || 'Save failed', 'error'); return false }
      setItem(d.item)
      onSaved()
      return true
    } catch (e: any) { toast(e?.message || 'Save failed', 'error'); return false }
    finally { setSaving(false) }
  }

  async function saveAndClose() { if (await save()) { toast('Saved', 'success'); onClose() } }

  async function pushToMyob() {
    setPushing(true)
    try {
      if (!(await save())) return                       // push the on-screen values
      const r = await fetch(`/api/workshop/inventory/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'push' }) })
      const d = await r.json()
      if (!r.ok) { toast(d.error || 'MYOB push failed', 'error'); if (d.error) setItem((s: any) => ({ ...s, myob_push_error: d.error })); return }
      setItem(d.item); onSaved()
      toast('Pushed to MYOB ✓', 'success')
    } finally { setPushing(false) }
  }

  async function generateBarcode() {
    setGenBusy(true)
    try {
      const r = await fetch(`/api/workshop/inventory/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'generate_barcode' }) })
      const d = await r.json()
      if (!r.ok) { toast(d.error || 'Could not generate', 'error'); return }
      f('barcode', d.barcode); onSaved()
      toast(`Barcode ${d.barcode} assigned`, 'success')
    } finally { setGenBusy(false) }
  }

  const dirty = !!item?.myob_dirty
  const margin = (() => {
    const buy = Number(form.buy_price) || 0, sell = Number(form.sell_price) || 0
    if (!sell || !buy) return null
    return Math.round(((sell - buy) / sell) * 100)
  })()

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', justifyContent: 'flex-end', zIndex: 120 }}>
      <div onClick={e => e.stopPropagation()} style={{ width: 460, maxWidth: '94vw', height: '100%', background: T.bg2, borderLeft: `1px solid ${T.border}`, display: 'flex', flexDirection: 'column', color: T.text }}>
        <div style={{ padding: '16px 20px', borderBottom: `1px solid ${T.border}`, display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{loading ? 'Loading…' : (item?.part_name || 'Inventory item')}</div>
            <div style={{ fontSize: 11, color: T.text3, fontFamily: 'monospace' }}>{item?.sku}{item?.myob_uid ? ' · MYOB linked' : ' · not in MYOB'}</div>
          </div>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: T.text3, fontSize: 20, cursor: 'pointer', lineHeight: 1 }}>×</button>
        </div>

        {loading ? (
          <div style={{ padding: 24, color: T.text3, fontSize: 12 }}>Loading…</div>
        ) : (
          <div style={{ flex: 1, overflow: 'auto', padding: '0 20px 20px' }}>
            {/* Identity */}
            <div style={sectionTitle}>Identity</div>
            <div style={{ display: 'flex', gap: 12 }}>
              <div style={{ flex: 1 }}><label style={lbl}>Part number / SKU</label><input value={form.sku} onChange={e => f('sku', e.target.value)} style={inp} /></div>
              <div style={{ flex: 1 }}><label style={lbl}>Brand</label><input value={form.brand} onChange={e => f('brand', e.target.value)} style={inp} /></div>
            </div>
            <div style={{ marginTop: 12 }}><label style={lbl}>Part name</label><input value={form.part_name} onChange={e => f('part_name', e.target.value)} style={inp} /></div>
            <div style={{ marginTop: 12 }}><label style={lbl}>Description</label><textarea value={form.sale_description} onChange={e => f('sale_description', e.target.value)} rows={2} style={{ ...inp, resize: 'vertical' }} /></div>
            <div style={{ display: 'flex', gap: 12, marginTop: 12 }}>
              <div style={{ flex: 1 }}><label style={lbl}>Category</label><input value={form.category} onChange={e => f('category', e.target.value)} style={inp} /></div>
              <div style={{ flex: 1 }}>
                <label style={lbl}>Supplier</label>
                <select value={form.supplier || ''} onChange={e => f('supplier', e.target.value)} style={inp}>
                  <option value="">— None —</option>
                  {form.supplier && !suppliers.includes(form.supplier) && <option value={form.supplier}>{form.supplier} (unmanaged)</option>}
                  {suppliers.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
                <div style={{ fontSize: 10, color: T.text3, marginTop: 4 }}>Pick a managed supplier so its parts group onto a PO. Add suppliers in Inventory → Suppliers.</div>
              </div>
            </div>
            <div style={{ marginTop: 12 }}>
              <label style={lbl}>Barcode</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input value={form.barcode} onChange={e => f('barcode', e.target.value)} style={{ ...inp, fontFamily: 'monospace' }} placeholder="Scan, type, or generate" />
                <button onClick={generateBarcode} disabled={genBusy} style={{ padding: '0 12px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer', background: 'transparent', color: T.text2, border: `1px solid ${T.border2}`, whiteSpace: 'nowrap' }}>{genBusy ? '…' : 'Generate'}</button>
              </div>
              <div style={{ fontSize: 10, color: T.text3, marginTop: 4 }}>Used on printed labels; falls back to SKU if blank.</div>
            </div>

            {/* Pricing */}
            <div style={sectionTitle}>Pricing (ex GST)</div>
            <div style={{ display: 'flex', gap: 12 }}>
              <div style={{ flex: 1 }}><label style={lbl}>Cost (buy)</label><input type="number" step="0.01" value={form.buy_price} onChange={e => f('buy_price', e.target.value)} style={inp} /></div>
              <div style={{ flex: 1 }}>
                <label style={lbl}>Retail / RRP</label><input type="number" step="0.01" value={form.sell_price} onChange={e => f('sell_price', e.target.value)} style={inp} />
                {margin != null && <div style={{ fontSize: 10, color: T.text3, marginTop: 4 }}>{margin}% margin</div>}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 12, marginTop: 12 }}>
              <div style={{ flex: 1 }}><label style={lbl}>Trade</label><input type="number" step="0.01" value={form.price_level_2} onChange={e => f('price_level_2', e.target.value)} style={inp} /></div>
              <div style={{ flex: 1 }}><label style={lbl}>Wholesale</label><input type="number" step="0.01" value={form.price_level_3} onChange={e => f('price_level_3', e.target.value)} style={inp} /></div>
            </div>

            {/* MYOB sync */}
            <div style={sectionTitle}>MYOB</div>
            <label style={lbl}>Sale account (income)</label>
            {accounts.length > 0 ? (
              <select value={form.sale_account_uid} onChange={e => { const a = accounts.find(x => x.uid === e.target.value); f('sale_account_uid', e.target.value); f('sale_account_name', a ? `${a.displayId} ${a.name}` : '') }} style={inp}>
                <option value="">— Use workshop default —</option>
                {accounts.map(a => <option key={a.uid} value={a.uid}>{a.displayId} · {a.name}</option>)}
              </select>
            ) : (
              <div style={{ fontSize: 11, color: T.text3, padding: '7px 0' }}>{form.sale_account_name || 'Workshop default'}{acctErr ? ` — ${acctErr}` : ''}</div>
            )}
            <div style={{ marginTop: 14, padding: 12, borderRadius: 8, background: dirty ? 'rgba(240,170,60,0.10)' : T.bg3, border: `1px solid ${dirty ? 'rgba(240,170,60,0.4)' : T.border}` }}>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>{dirty ? 'Unsynced changes' : 'In sync with MYOB'}</div>
              <div style={{ fontSize: 11, color: T.text3, marginBottom: 10 }}>
                {item?.myob_push_error ? <span style={{ color: T.red }}>Last push failed: {item.myob_push_error}</span>
                  : item?.myob_pushed_at ? `Last pushed ${new Date(item.myob_pushed_at).toLocaleString('en-AU')}`
                  : 'Pushes part #, name, description, cost, retail price and sale account to the MYOB item.'}
              </div>
              <button onClick={pushToMyob} disabled={pushing || saving || !item?.myob_uid} title={item?.myob_uid ? '' : 'No MYOB link on this item'}
                style={{ padding: '7px 14px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: item?.myob_uid ? 'pointer' : 'not-allowed', background: T.accent, color: '#fff', border: 'none', opacity: item?.myob_uid ? 1 : 0.5 }}>
                {pushing ? 'Pushing…' : '⬆ Save & push to MYOB'}
              </button>
            </div>

            {/* Live stock (read-only, from MYOB) */}
            <div style={sectionTitle}>Live stock (MYOB)</div>
            <div style={{ display: 'flex', gap: 8 }}>
              {([['On hand', item?.quantity], ['Available', item?.available], ['Allocated', item?.allocated], ['On order', item?.on_order]] as const).map(([label, val]) => (
                <div key={label} style={{ flex: 1, background: T.bg3, border: `1px solid ${T.border}`, borderRadius: 8, padding: '8px 6px', textAlign: 'center' }}>
                  <div style={{ fontSize: 15, fontWeight: 700, fontFamily: 'monospace', color: label === 'Allocated' && Number(val) > 0 ? T.accent : T.text }}>{Number(val) || 0}</div>
                  <div style={{ fontSize: 9, color: T.text3, textTransform: 'uppercase', letterSpacing: '0.04em', marginTop: 2 }}>{label}</div>
                </div>
              ))}
            </div>

            {/* Stock */}
            <div style={sectionTitle}>Stock settings</div>
            <div style={{ display: 'flex', gap: 12 }}>
              <div style={{ flex: 1 }}><label style={lbl}>Location</label><input value={form.location} onChange={e => f('location', e.target.value)} style={inp} /></div>
              <div style={{ flex: 1 }}><label style={lbl}>Bin</label><input value={form.bin} onChange={e => f('bin', e.target.value)} style={inp} /></div>
            </div>
            <div style={{ display: 'flex', gap: 12, marginTop: 12 }}>
              <div style={{ flex: 1 }}><label style={lbl}>Alert qty</label><input type="number" value={form.alert_qty} onChange={e => f('alert_qty', e.target.value)} style={inp} /></div>
              <div style={{ flex: 1 }}><label style={lbl}>Reorder qty</label><input type="number" value={form.reorder_qty} onChange={e => f('reorder_qty', e.target.value)} style={inp} /></div>
              <div style={{ flex: 1 }}><label style={lbl}>Max qty</label><input type="number" value={form.max_qty} onChange={e => f('max_qty', e.target.value)} style={inp} /></div>
            </div>
            <div style={{ fontSize: 11, color: T.text3, marginTop: 10 }}>On-hand / available / on-order come from MYOB and update on sync.</div>
          </div>
        )}

        <div style={{ padding: '12px 20px', borderTop: `1px solid ${T.border}`, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button onClick={onClose} style={{ padding: '8px 16px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer', background: 'transparent', color: T.text2, border: `1px solid ${T.border2}` }}>Cancel</button>
          <button onClick={saveAndClose} disabled={saving || loading} style={{ padding: '8px 16px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer', background: T.accent, color: '#fff', border: 'none' }}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>
  )
}
