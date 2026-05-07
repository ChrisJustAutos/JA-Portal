// pages/admin/b2b/catalogue.tsx
// Catalogue management grid for the B2B portal admin.
//
// Layout: dense table with inline-editable trade price + visibility, plus
// a slide-in drawer (click the row body) for fuller edits — image upload,
// description, longer fields.
//
// Image upload uses the existing LogoUpload pattern: client-side direct
// upload to Supabase Storage (b2b-catalogue bucket) using the user's auth
// session, with RLS enforcing the b2b_is_portal_admin() check.

import { useEffect, useState, useMemo, useRef, useCallback } from 'react'
import Head from 'next/head'
import PortalSidebar from '../../../lib/PortalSidebar'
import { requirePageAuth } from '../../../lib/authServer'
import { getSupabase } from '../../../lib/supabaseClient'
import type { UserRole } from '../../../lib/permissions'

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

type FreightPackaging = 'box' | 'pallet' | 'other'

interface VolumeBreak {
  min_qty: number
  unit_price_ex_gst: number
}

interface CatalogueItem {
  id: string
  myob_item_uid: string | null
  sku: string
  name: string
  description: string | null
  model_id: string | null
  product_type_id: string | null
  trade_price_ex_gst: number
  rrp_ex_gst: number | null
  is_taxable: boolean
  primary_image_url: string | null
  b2b_visible: boolean
  barcode: string | null
  max_order_qty: number | null
  freight_length_mm: number | null
  freight_width_mm: number | null
  freight_height_mm: number | null
  freight_weight_g: number | null
  freight_packaging: FreightPackaging | null
  is_special_order: boolean
  is_drop_ship: boolean
  call_for_availability_below_qty: number | null
  call_for_availability_when_zero: boolean
  instructions_url: string | null
  cost_price_ex_gst: number | null
  volume_breaks: VolumeBreak[]
  promo_price_ex_gst: number | null
  promo_starts_at: string | null
  promo_ends_at: string | null
  last_synced_from_myob_at: string | null
  created_at: string
  updated_at: string
}

interface TaxonomyOption {
  id: string
  name: string
  is_active: boolean
}

interface DistributorOption {
  id: string
  display_name: string
  is_active: boolean
  active_user_count: number
}

type VisibilityFilter = 'all' | 'visible' | 'hidden'

const ALLOWED_IMAGE_TYPES = ['image/png','image/jpeg','image/jpg','image/webp']
const MAX_IMAGE_BYTES = 10 * 1024 * 1024  // 10 MB

function fmtMoney(n: number | null): string {
  if (n == null) return '—'
  return '$' + n.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function nanoid(len: number = 12): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let out = ''
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)]
  return out
}

function fileExt(file: File): string {
  const fromName = file.name.split('.').pop()?.toLowerCase()
  if (fromName && ['png','jpg','jpeg','webp'].includes(fromName)) {
    return fromName === 'jpeg' ? 'jpg' : fromName
  }
  if (file.type === 'image/png')  return 'png'
  if (file.type === 'image/webp') return 'webp'
  return 'jpg'
}

const PDF_MAX_BYTES = 10 * 1024 * 1024

// Validates + uploads an instructions PDF to the b2b-catalogue-pdfs bucket and
// returns its public URL. Best-effort cleans the {itemId}/ folder so we don't
// leak storage on re-uploads.
async function uploadCatalogueInstructionsPdf(itemId: string, file: File): Promise<string> {
  const type = (file.type || '').toLowerCase()
  if (type !== 'application/pdf') {
    throw new Error(`File must be a PDF (got "${file.type || 'unknown'}").`)
  }
  if (file.size > PDF_MAX_BYTES) {
    throw new Error(`File is ${(file.size/1024/1024).toFixed(1)} MB — max 10 MB.`)
  }
  if (file.size === 0) {
    throw new Error('File appears to be empty.')
  }
  const supabase = getSupabase()
  const path = `${itemId}/${nanoid()}.pdf`
  const { error: upErr } = await supabase.storage
    .from('b2b-catalogue-pdfs')
    .upload(path, file, { cacheControl: '3600', upsert: false, contentType: 'application/pdf' })
  if (upErr) throw new Error(upErr.message || 'Upload failed')
  const { data: { publicUrl } } = supabase.storage.from('b2b-catalogue-pdfs').getPublicUrl(path)
  try {
    const { data: list } = await supabase.storage.from('b2b-catalogue-pdfs').list(itemId, { limit: 50 })
    const newName = path.split('/').pop()
    if (list) {
      const toDelete = list.filter(f => f.name !== newName).map(f => `${itemId}/${f.name}`)
      if (toDelete.length > 0) await supabase.storage.from('b2b-catalogue-pdfs').remove(toDelete)
    }
  } catch { /* silent */ }
  return publicUrl
}

async function removeCatalogueInstructionsPdf(itemId: string): Promise<void> {
  const supabase = getSupabase()
  try {
    const { data: list } = await supabase.storage.from('b2b-catalogue-pdfs').list(itemId, { limit: 50 })
    if (list && list.length > 0) {
      await supabase.storage.from('b2b-catalogue-pdfs').remove(list.map(f => `${itemId}/${f.name}`))
    }
  } catch { /* silent */ }
}

// Validates + uploads a catalogue image and returns its public URL. Best-effort
// removes prior files in the same {itemId}/ folder so we don't leak storage on
// re-uploads. Throws on validation or upload error. Shared by the inline row
// thumbnail uploader and the drawer's "Replace image" button.
async function uploadCatalogueImage(itemId: string, file: File): Promise<string> {
  if (!ALLOWED_IMAGE_TYPES.includes(file.type.toLowerCase())) {
    throw new Error(`File type "${file.type || 'unknown'}" not allowed. Use PNG, JPG or WEBP.`)
  }
  if (file.size > MAX_IMAGE_BYTES) {
    throw new Error(`File is ${(file.size/1024/1024).toFixed(1)} MB — max 10 MB.`)
  }
  if (file.size === 0) {
    throw new Error('File appears to be empty.')
  }

  const supabase = getSupabase()
  const ext = fileExt(file)
  const path = `${itemId}/${nanoid()}.${ext}`
  const { error: upErr } = await supabase.storage
    .from('b2b-catalogue')
    .upload(path, file, { cacheControl: '3600', upsert: false, contentType: file.type })
  if (upErr) throw new Error(upErr.message || 'Upload failed')

  const { data: { publicUrl } } = supabase.storage.from('b2b-catalogue').getPublicUrl(path)

  // Best-effort cleanup of previous files in this catalogue folder
  try {
    const { data: list } = await supabase.storage.from('b2b-catalogue').list(itemId, { limit: 50 })
    const newName = path.split('/').pop()
    if (list) {
      const toDelete = list.filter(f => f.name !== newName).map(f => `${itemId}/${f.name}`)
      if (toDelete.length > 0) await supabase.storage.from('b2b-catalogue').remove(toDelete)
    }
  } catch { /* silent — best-effort cleanup */ }

  return publicUrl
}

// ─── Page ───────────────────────────────────────────────────────────────
export default function CatalogueAdminPage({ user }: Props) {
  const [items, setItems] = useState<CatalogueItem[]>([])
  const [models, setModels] = useState<TaxonomyOption[]>([])
  const [productTypes, setProductTypes] = useState<TaxonomyOption[]>([])
  const [distributors, setDistributors] = useState<DistributorOption[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [visibilityFilter, setVisibilityFilter] = useState<VisibilityFilter>('all')
  const [modelFilter, setModelFilter] = useState<string>('all')         // 'all' | 'none' | <id>
  const [productTypeFilter, setProductTypeFilter] = useState<string>('all')
  const [drawerItemId, setDrawerItemId] = useState<string | null>(null)
  const [previewMenuOpen, setPreviewMenuOpen] = useState(false)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    try {
      const [itemsRes, modelsRes, typesRes, distRes] = await Promise.all([
        fetch('/api/b2b/admin/catalogue',     { credentials: 'same-origin' }),
        fetch('/api/b2b/admin/models',        { credentials: 'same-origin' }),
        fetch('/api/b2b/admin/product-types', { credentials: 'same-origin' }),
        fetch('/api/b2b/admin/distributors',  { credentials: 'same-origin' }),
      ])
      if (!itemsRes.ok)  throw new Error(`Catalogue HTTP ${itemsRes.status}: ${await itemsRes.text()}`)
      if (!modelsRes.ok) throw new Error(`Models HTTP ${modelsRes.status}`)
      if (!typesRes.ok)  throw new Error(`Product types HTTP ${typesRes.status}`)
      // Distributors list is non-critical for the page; failure here just
      // disables the Preview button.
      const itemsJson  = await itemsRes.json()
      const modelsJson = await modelsRes.json()
      const typesJson  = await typesRes.json()
      const distJson   = distRes.ok ? await distRes.json() : { items: [] }
      setItems(itemsJson.items || [])
      setModels((modelsJson.models || []).map((m: any) => ({ id: m.id, name: m.name, is_active: m.is_active })))
      setProductTypes((typesJson.product_types || []).map((t: any) => ({ id: t.id, name: t.name, is_active: t.is_active })))
      setDistributors((distJson.items || []).map((d: any) => ({
        id: d.id, display_name: d.display_name, is_active: d.is_active, active_user_count: d.active_user_count || 0,
      })))
      setLoadError(null)
    } catch (e: any) {
      setLoadError(e?.message || String(e))
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [])

  async function startPreview(distributorId: string) {
    setPreviewLoading(true)
    setPreviewError(null)
    try {
      const r = await fetch('/api/b2b/admin/preview-link', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ distributor_id: distributorId }),
      })
      const j = await r.json()
      if (!r.ok || !j.link) throw new Error(j?.error || `HTTP ${r.status}`)
      setPreviewMenuOpen(false)
      window.open(j.link, '_blank', 'noopener')
    } catch (e: any) {
      setPreviewError(e?.message || String(e))
      setTimeout(() => setPreviewError(null), 6000)
    } finally {
      setPreviewLoading(false)
    }
  }

  function patchLocalItem(id: string, patch: Partial<CatalogueItem>) {
    setItems(prev => prev.map(it => it.id === id ? { ...it, ...patch } : it))
  }

  // Create a new model/product type from an inline row dropdown.
  // Returns the new id on success so the caller can immediately PATCH the
  // catalogue item with it.
  async function createModel(name: string): Promise<string> {
    const r = await fetch('/api/b2b/admin/models', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    const j = await r.json()
    if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`)
    const m = j.model
    setModels(prev => [...prev, { id: m.id, name: m.name, is_active: m.is_active !== false }]
      .sort((a, b) => a.name.localeCompare(b.name)))
    return m.id
  }
  async function createProductType(name: string): Promise<string> {
    const r = await fetch('/api/b2b/admin/product-types', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    const j = await r.json()
    if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`)
    const t = j.product_type
    setProductTypes(prev => [...prev, { id: t.id, name: t.name, is_active: t.is_active !== false }]
      .sort((a, b) => a.name.localeCompare(b.name)))
    return t.id
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return items.filter(it => {
      if (visibilityFilter === 'visible' && !it.b2b_visible) return false
      if (visibilityFilter === 'hidden'  &&  it.b2b_visible) return false
      if (modelFilter === 'none' && it.model_id) return false
      if (modelFilter !== 'all' && modelFilter !== 'none' && it.model_id !== modelFilter) return false
      if (productTypeFilter === 'none' && it.product_type_id) return false
      if (productTypeFilter !== 'all' && productTypeFilter !== 'none' && it.product_type_id !== productTypeFilter) return false
      if (q) {
        const hay = (it.sku + ' ' + it.name).toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [items, search, visibilityFilter, modelFilter, productTypeFilter])


  const stats = useMemo(() => {
    const total       = items.length
    const visible     = items.filter(i => i.b2b_visible).length
    const withImage   = items.filter(i => i.primary_image_url).length
    const withPrice   = items.filter(i => i.trade_price_ex_gst > 0).length
    const liveReady   = items.filter(i => i.b2b_visible && i.primary_image_url && i.trade_price_ex_gst > 0).length
    const visibleNoP  = items.filter(i => i.b2b_visible && i.trade_price_ex_gst <= 0).length
    return { total, visible, withImage, withPrice, liveReady, visibleNoP }
  }, [items])

  const drawerItem = items.find(i => i.id === drawerItemId) || null

  return (
    <>
      <Head><title>B2B Catalogue · JA Portal</title></Head>
      <div style={{display:'flex',minHeight:'100vh',background:T.bg,color:T.text,fontFamily:'system-ui,-apple-system,sans-serif'}}>
        <PortalSidebar
          activeId="b2b"
          currentUserRole={user.role}
          currentUserVisibleTabs={user.visibleTabs}
          currentUserName={user.displayName}
          currentUserEmail={user.email}
        />
        <main style={{flex:1,padding:'28px 32px',maxWidth:1400}}>

          {/* Header */}
          <header style={{marginBottom:18,display:'flex',alignItems:'flex-end',justifyContent:'space-between',gap:16,flexWrap:'wrap'}}>
            <div>
              <div style={{fontSize:12,color:T.text3,textTransform:'uppercase',letterSpacing:'0.08em',marginBottom:4}}>
                <a href="/admin/b2b" style={{color:T.text3,textDecoration:'none'}}>B2B Portal</a>
                {' / '}
                <span style={{color:T.text2}}>Catalogue</span>
              </div>
              <h1 style={{fontSize:22,fontWeight:600,margin:0,letterSpacing:'-0.01em'}}>
                Catalogue management
              </h1>
            </div>
            <div style={{display:'flex',gap:18,alignItems:'baseline'}}>
              <Stat n={stats.total}      label="items"/>
              <Stat n={stats.visible}    label="visible"  color={T.green}/>
              <Stat n={stats.withImage}  label="w/ image" color={T.teal}/>
              <Stat n={stats.liveReady}  label="ready"    color={T.blue}/>
              {stats.visibleNoP > 0 && <Stat n={stats.visibleNoP} label="visible · $0" color={T.amber}/>}
            </div>
          </header>

          {/* Toolbar */}
          <div style={{
            display:'flex',gap:10,alignItems:'center',flexWrap:'wrap',
            padding:'10px 12px',background:T.bg2,border:`1px solid ${T.border}`,
            borderRadius:8,marginBottom:14,
          }}>
            <input
              type="text"
              placeholder="Search SKU or name…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              style={{
                flex:1,minWidth:200,
                background:T.bg3,border:`1px solid ${T.border}`,color:T.text,
                borderRadius:5,padding:'7px 11px',fontSize:13,outline:'none',
                fontFamily:'inherit',
              }}
            />
            <FilterPill active={visibilityFilter==='all'}     onClick={()=>setVisibilityFilter('all')}>All ({items.length})</FilterPill>
            <FilterPill active={visibilityFilter==='visible'} onClick={()=>setVisibilityFilter('visible')} color={T.green}>Visible ({stats.visible})</FilterPill>
            <FilterPill active={visibilityFilter==='hidden'}  onClick={()=>setVisibilityFilter('hidden')}  color={T.text3}>Hidden ({items.length - stats.visible})</FilterPill>
            <TaxonomyFilterDropdown
              label="Model"
              value={modelFilter}
              options={models}
              onChange={setModelFilter}
            />
            <TaxonomyFilterDropdown
              label="Type"
              value={productTypeFilter}
              options={productTypes}
              onChange={setProductTypeFilter}
            />
            <button onClick={load} disabled={loading}
              style={{padding:'6px 12px',borderRadius:5,border:`1px solid ${T.border2}`,background:'transparent',color:T.text2,fontSize:12,cursor:loading?'wait':'pointer',fontFamily:'inherit'}}>
              {loading ? 'Loading…' : '↻ Refresh'}
            </button>
            <PreviewMenu
              distributors={distributors}
              open={previewMenuOpen}
              loading={previewLoading}
              onToggle={() => setPreviewMenuOpen(v => !v)}
              onClose={() => setPreviewMenuOpen(false)}
              onPick={startPreview}
            />
          </div>
          {previewError && (
            <div style={{padding:8,marginTop:8,background:`${T.red}15`,border:`1px solid ${T.red}40`,borderRadius:6,color:T.red,fontSize:12}}>
              Preview failed: {previewError}
            </div>
          )}

          {/* Errors */}
          {loadError && (
            <div style={{padding:10,background:`${T.red}15`,border:`1px solid ${T.red}40`,borderRadius:7,color:T.red,fontSize:13,marginBottom:10}}>
              Couldn't load catalogue: {loadError}
            </div>
          )}

          {/* Table */}
          <div style={{
            background:T.bg2,border:`1px solid ${T.border}`,borderRadius:10,
            overflow:'hidden',
          }}>
            <div style={{overflowX:'auto'}}>
              <table style={{width:'100%',borderCollapse:'collapse',fontSize:13}}>
                <thead>
                  <tr style={{borderBottom:`1px solid ${T.border2}`}}>
                    <th style={th(70)}></th>
                    <th style={th(140)}>SKU</th>
                    <th style={th()}>Name</th>
                    <th style={th(150)}>Model</th>
                    <th style={th(150)}>Type</th>
                    <th style={{...th(100),textAlign:'right'}}>RRP</th>
                    <th style={{...th(140),textAlign:'right'}}>Trade $ (ex GST)</th>
                    <th style={{...th(100),textAlign:'center'}}>Visible</th>
                    <th style={th(50)}></th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.length === 0 && !loading && (
                    <tr><td colSpan={9} style={{padding:24,textAlign:'center',color:T.text3,fontSize:13}}>
                      {items.length === 0 ? 'No items yet — run a catalogue sync from the B2B Portal page.' : 'No items match your filters.'}
                    </td></tr>
                  )}
                  {filtered.map((it, i) => (
                    <CatalogueRow
                      key={it.id}
                      item={it}
                      index={i}
                      models={models}
                      productTypes={productTypes}
                      onCreateModel={createModel}
                      onCreateProductType={createProductType}
                      onPatch={patchLocalItem}
                      onOpenDrawer={() => setDrawerItemId(it.id)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </div>

        </main>

        {/* Drawer */}
        {drawerItem && (
          <EditDrawer
            item={drawerItem}
            models={models}
            productTypes={productTypes}
            onClose={() => setDrawerItemId(null)}
            onPatch={patchLocalItem}
          />
        )}
      </div>
    </>
  )
}

// ─── Row component ──────────────────────────────────────────────────────
function CatalogueRow({
  item, index, models, productTypes,
  onCreateModel, onCreateProductType,
  onPatch, onOpenDrawer,
}: {
  item: CatalogueItem
  index: number
  models: TaxonomyOption[]
  productTypes: TaxonomyOption[]
  onCreateModel: (name: string) => Promise<string>
  onCreateProductType: (name: string) => Promise<string>
  onPatch: (id: string, patch: Partial<CatalogueItem>) => void
  onOpenDrawer: () => void
}) {
  const [priceDraft, setPriceDraft] = useState<string>(item.trade_price_ex_gst.toFixed(2))
  const [savingField, setSavingField] = useState<'price'|'visible'|'model'|'type'|null>(null)
  const [error, setError] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Sync local price draft when the underlying item changes (e.g. after refresh)
  useEffect(() => { setPriceDraft(item.trade_price_ex_gst.toFixed(2)) }, [item.trade_price_ex_gst])

  async function patchServer(patch: Partial<CatalogueItem>, fieldKey: 'price'|'visible'|'model'|'type') {
    setSavingField(fieldKey)
    setError(null)
    try {
      const r = await fetch(`/api/b2b/admin/catalogue/${item.id}`, {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      const j = await r.json()
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`)
      onPatch(item.id, j.item || patch)
    } catch (e: any) {
      setError(e?.message || String(e))
      setTimeout(() => setError(null), 4000)
    } finally {
      setSavingField(null)
    }
  }

  async function handleModelChange(v: string | null | '__add__') {
    if (v === '__add__') {
      const name = window.prompt('New model name:')?.trim()
      if (!name) return
      try {
        setSavingField('model')
        const newId = await onCreateModel(name)
        await patchServer({ model_id: newId }, 'model')
      } catch (e: any) {
        setError(e?.message || String(e))
        setTimeout(() => setError(null), 4000)
        setSavingField(null)
      }
      return
    }
    patchServer({ model_id: v || null }, 'model')
  }

  async function handleTypeChange(v: string | null | '__add__') {
    if (v === '__add__') {
      const name = window.prompt('New product type name:')?.trim()
      if (!name) return
      try {
        setSavingField('type')
        const newId = await onCreateProductType(name)
        await patchServer({ product_type_id: newId }, 'type')
      } catch (e: any) {
        setError(e?.message || String(e))
        setTimeout(() => setError(null), 4000)
        setSavingField(null)
      }
      return
    }
    patchServer({ product_type_id: v || null }, 'type')
  }

  function commitPrice() {
    const n = parseFloat(priceDraft)
    if (!isFinite(n) || n < 0) {
      setPriceDraft(item.trade_price_ex_gst.toFixed(2))
      setError('Invalid price')
      setTimeout(() => setError(null), 3000)
      return
    }
    if (Math.abs(n - item.trade_price_ex_gst) < 0.005) return  // no-op
    patchServer({ trade_price_ex_gst: n }, 'price')
  }

  async function handleImageFile(file: File) {
    setError(null)
    setUploading(true)
    try {
      const publicUrl = await uploadCatalogueImage(item.id, file)
      const r = await fetch(`/api/b2b/admin/catalogue/${item.id}`, {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ primary_image_url: publicUrl }),
      })
      const j = await r.json()
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`)
      onPatch(item.id, j.item || { primary_image_url: publicUrl })
    } catch (e: any) {
      setError(e?.message || String(e))
      setTimeout(() => setError(null), 5000)
    } finally {
      setUploading(false)
    }
  }

  const showWarning = item.b2b_visible && item.trade_price_ex_gst <= 0
  const showImageWarning = item.b2b_visible && !item.primary_image_url

  return (
    <tr style={{
      borderTop: index > 0 ? `1px solid ${T.border}` : 'none',
      background: error ? `${T.red}08` : 'transparent',
    }}>
      {/* Image thumb — click to upload/replace; drawer reachable via SKU/Name/chevron */}
      <td style={{...td(),padding:6}}>
        <div
          onClick={() => !uploading && fileInputRef.current?.click()}
          title={item.primary_image_url ? 'Click to replace image' : 'Click to upload image'}
          style={{
            width:50,height:50,borderRadius:5,overflow:'hidden',
            background:T.bg3,border:`1px solid ${T.border}`,
            display:'flex',alignItems:'center',justifyContent:'center',
            cursor: uploading ? 'wait' : 'pointer',
            position:'relative',
          }}>
          {item.primary_image_url ? (
            <img src={item.primary_image_url} alt="" style={{maxWidth:'100%',maxHeight:'100%',objectFit:'contain'}}
              onError={e => { (e.target as HTMLImageElement).style.display='none' }}/>
          ) : (
            <span style={{fontSize:9,color:T.text3,fontFamily:'monospace'}}>+ img</span>
          )}
          {uploading && (
            <div style={{
              position:'absolute',inset:0,
              background:'rgba(0,0,0,0.6)',
              display:'flex',alignItems:'center',justifyContent:'center',
              fontSize:9,color:'#fff',fontFamily:'monospace',
            }}>
              …
            </div>
          )}
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/jpg,image/webp"
          onChange={e => {
            const f = e.target.files?.[0]
            if (f) handleImageFile(f)
            if (fileInputRef.current) fileInputRef.current.value = ''
          }}
          style={{display:'none'}}
        />
      </td>

      {/* SKU */}
      <td style={{...td(),cursor:'pointer'}} onClick={onOpenDrawer}>
        <div style={{fontFamily:'monospace',fontSize:12,color:T.text2}}>{item.sku}</div>
      </td>

      {/* Name */}
      <td style={{...td(),cursor:'pointer'}} onClick={onOpenDrawer}>
        <div style={{color:T.text}}>{item.name}</div>
        {(showWarning || showImageWarning) && (
          <div style={{fontSize:10,color:T.amber,marginTop:2,fontFamily:'monospace'}}>
            ⚠ {[
              showWarning && 'visible without trade price',
              showImageWarning && 'visible without image',
            ].filter(Boolean).join(' · ')}
          </div>
        )}
      </td>

      {/* Model (inline editable, only when item is visible) */}
      <td style={td()}>
        {item.b2b_visible ? (
          <InlineTaxonomySelect
            value={item.model_id}
            options={models}
            saving={savingField === 'model'}
            addLabel="+ Add model…"
            onChange={handleModelChange}
          />
        ) : (
          <span style={{color:T.text3,fontSize:11}}>—</span>
        )}
      </td>

      {/* Product type (inline editable, only when item is visible) */}
      <td style={td()}>
        {item.b2b_visible ? (
          <InlineTaxonomySelect
            value={item.product_type_id}
            options={productTypes}
            saving={savingField === 'type'}
            addLabel="+ Add type…"
            onChange={handleTypeChange}
          />
        ) : (
          <span style={{color:T.text3,fontSize:11}}>—</span>
        )}
      </td>

      {/* RRP */}
      <td style={{...td(),textAlign:'right',color:T.text3,fontFamily:'monospace'}}>
        {fmtMoney(item.rrp_ex_gst)}
      </td>

      {/* Trade price input */}
      <td style={{...td(),textAlign:'right',padding:'6px 10px'}}>
        <div style={{display:'flex',alignItems:'center',justifyContent:'flex-end',gap:4}}>
          <span style={{fontSize:12,color:T.text3}}>$</span>
          <input
            type="text"
            inputMode="decimal"
            value={priceDraft}
            disabled={savingField === 'price'}
            onChange={e => setPriceDraft(e.target.value)}
            onBlur={commitPrice}
            onKeyDown={e => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              if (e.key === 'Escape') {
                setPriceDraft(item.trade_price_ex_gst.toFixed(2))
                ;(e.target as HTMLInputElement).blur()
              }
            }}
            style={{
              width:80,textAlign:'right',
              background:T.bg3,border:`1px solid ${T.border}`,color:T.text,
              borderRadius:4,padding:'5px 8px',fontSize:13,outline:'none',
              fontFamily:'monospace',
              opacity: savingField === 'price' ? 0.5 : 1,
            }}
          />
        </div>
      </td>

      {/* Visibility toggle */}
      <td style={{...td(),textAlign:'center'}}>
        <ToggleSwitch
          on={item.b2b_visible}
          disabled={savingField === 'visible'}
          onChange={v => patchServer({ b2b_visible: v }, 'visible')}
        />
      </td>

      {/* Edit chevron */}
      <td style={{...td(),textAlign:'right',cursor:'pointer'}} onClick={onOpenDrawer}>
        <span style={{color:T.text3,fontSize:14}}>›</span>
      </td>
    </tr>
  )
}

// ─── Drawer ─────────────────────────────────────────────────────────────
function EditDrawer({
  item, models, productTypes, onClose, onPatch,
}: {
  item: CatalogueItem
  models: TaxonomyOption[]
  productTypes: TaxonomyOption[]
  onClose: () => void
  onPatch: (id: string, patch: Partial<CatalogueItem>) => void
}) {
  const [description, setDescription] = useState(item.description || '')
  const [savingDesc, setSavingDesc] = useState(false)
  const [imageError, setImageError] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [descError, setDescError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Reset draft when switching between items
  useEffect(() => { setDescription(item.description || '') }, [item.id, item.description])

  async function patch(p: Partial<CatalogueItem>): Promise<boolean> {
    try {
      const r = await fetch(`/api/b2b/admin/catalogue/${item.id}`, {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(p),
      })
      const j = await r.json()
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`)
      onPatch(item.id, j.item || p)
      return true
    } catch (e: any) {
      throw e
    }
  }

  async function saveDescription() {
    if (description === (item.description || '')) return
    setSavingDesc(true)
    setDescError(null)
    try {
      await patch({ description: description || null })
    } catch (e: any) {
      setDescError(e?.message || String(e))
    } finally {
      setSavingDesc(false)
    }
  }

  const handleFile = useCallback(async (file: File) => {
    setImageError(null)
    setUploading(true)
    try {
      const publicUrl = await uploadCatalogueImage(item.id, file)
      await patch({ primary_image_url: publicUrl })
    } catch (e: any) {
      setImageError(e?.message || String(e))
    } finally {
      setUploading(false)
    }
  }, [item.id])

  async function removeImage() {
    if (!item.primary_image_url) return
    setImageError(null)
    setUploading(true)
    try {
      // Best-effort cleanup
      try {
        const supabase = getSupabase()
        const { data: list } = await supabase.storage.from('b2b-catalogue').list(item.id, { limit: 50 })
        if (list && list.length > 0) {
          const toDelete = list.map(f => `${item.id}/${f.name}`)
          await supabase.storage.from('b2b-catalogue').remove(toDelete)
        }
      } catch { /* silent */ }
      await patch({ primary_image_url: null })
    } catch (e: any) {
      setImageError(e?.message || String(e))
    } finally {
      setUploading(false)
    }
  }

  return (
    <>
      {/* Overlay */}
      <div onClick={onClose} style={{
        position:'fixed',inset:0,background:'rgba(0,0,0,0.55)',zIndex:1000,
      }}/>
      {/* Drawer panel */}
      <div style={{
        position:'fixed',top:0,right:0,bottom:0,width:520,maxWidth:'92vw',
        background:T.bg2,borderLeft:`1px solid ${T.border2}`,
        display:'flex',flexDirection:'column',zIndex:1001,
        boxShadow:'-12px 0 32px rgba(0,0,0,0.3)',
      }}>

        {/* Header */}
        <div style={{padding:'16px 20px',borderBottom:`1px solid ${T.border}`,display:'flex',alignItems:'center',justifyContent:'space-between',gap:12}}>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontFamily:'monospace',fontSize:12,color:T.text3,marginBottom:2}}>{item.sku}</div>
            <div style={{fontSize:14,fontWeight:600,color:T.text,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{item.name}</div>
          </div>
          <button onClick={onClose}
            style={{background:'transparent',border:'none',color:T.text2,fontSize:20,cursor:'pointer',padding:'0 4px'}}>×</button>
        </div>

        {/* Body */}
        <div style={{flex:1,overflowY:'auto',padding:20}}>

          {/* Image section */}
          <Section title="Image">
            {item.primary_image_url && (
              <div style={{
                background:'#fff',borderRadius:6,padding:8,marginBottom:10,
                display:'flex',alignItems:'center',justifyContent:'center',
                minHeight:160,
              }}>
                <img src={item.primary_image_url} alt={item.name}
                  style={{maxWidth:'100%',maxHeight:240,objectFit:'contain'}}
                  onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
                />
              </div>
            )}
            <div style={{display:'flex',gap:8}}>
              <button
                onClick={() => !uploading && fileInputRef.current?.click()}
                disabled={uploading}
                style={{
                  flex:1,padding:'9px 14px',borderRadius:6,
                  border:`1px solid ${T.blue}`,background:T.blue,color:'#fff',
                  fontSize:13,fontWeight:500,fontFamily:'inherit',
                  cursor: uploading ? 'wait' : 'pointer',
                }}>
                {uploading ? 'Uploading…' : (item.primary_image_url ? 'Replace image' : 'Upload image')}
              </button>
              {item.primary_image_url && (
                <button
                  onClick={removeImage}
                  disabled={uploading}
                  style={{
                    padding:'9px 14px',borderRadius:6,
                    border:`1px solid ${T.border2}`,background:'transparent',color:T.red,
                    fontSize:13,fontFamily:'inherit',cursor:'pointer',
                  }}>
                  Remove
                </button>
              )}
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/jpg,image/webp"
              onChange={e => {
                const f = e.target.files?.[0]
                if (f) handleFile(f)
                if (fileInputRef.current) fileInputRef.current.value = ''
              }}
              style={{display:'none'}}
            />
            <div style={{fontSize:10,color:T.text3,marginTop:6}}>
              PNG, JPG or WEBP · Max 10 MB · Stored at <code style={{fontFamily:'monospace'}}>b2b-catalogue/{item.id}/...</code>
            </div>
            {imageError && (
              <div style={{marginTop:8,padding:8,background:`${T.red}15`,border:`1px solid ${T.red}40`,borderRadius:5,color:T.red,fontSize:12}}>
                {imageError}
              </div>
            )}
          </Section>

          {/* Description */}
          <Section title="Description">
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              onBlur={saveDescription}
              placeholder="Marketing copy shown on the distributor catalogue page."
              rows={6}
              style={{
                width:'100%',background:T.bg3,border:`1px solid ${T.border}`,color:T.text,
                borderRadius:6,padding:'10px 12px',fontSize:13,fontFamily:'inherit',outline:'none',
                resize:'vertical',
              }}
            />
            <div style={{fontSize:10,color:T.text3,marginTop:4}}>
              {savingDesc ? 'Saving…' : 'Saves automatically when you click outside'}
            </div>
            {descError && (
              <div style={{marginTop:6,padding:6,background:`${T.red}15`,border:`1px solid ${T.red}40`,borderRadius:5,color:T.red,fontSize:12}}>
                {descError}
              </div>
            )}
          </Section>

          {/* Pricing */}
          <PricingSection item={item} onPatch={async p => { try { await patch(p) } catch {} }}/>

          {/* Tags (model + product type) */}
          <Section title="Tags" subtitle="Used to group products on the distributor catalogue">
            <TaxonomySelect
              label="Model"
              value={item.model_id}
              options={models}
              onChange={async (v) => { try { await patch({ model_id: v }) } catch {} }}
            />
            <div style={{height:10}}/>
            <TaxonomySelect
              label="Product type"
              value={item.product_type_id}
              options={productTypes}
              onChange={async (v) => { try { await patch({ product_type_id: v }) } catch {} }}
            />
            <div style={{fontSize:10,color:T.text3,marginTop:6}}>
              Manage the available options under <a href="/admin/b2b/settings" style={{color:T.text2}}>B2B Settings</a>.
            </div>
          </Section>

          {/* Identity */}
          <Section title="Identity">
            <FieldText
              label="Barcode"
              placeholder="EAN/UPC — admin-entered, not from MYOB"
              value={item.barcode}
              onSave={async v => { try { await patch({ barcode: v }) } catch {} }}
            />
          </Section>

          {/* Stock & availability */}
          <Section title="Stock & availability" subtitle="How stock is presented to distributors">
            <BoolRow
              label="Special order"
              hint="Extended lead times — supplier-sourced"
              value={item.is_special_order}
              onChange={v => { patch({ is_special_order: v }).catch(() => {}) }}
            />
            <BoolRow
              label="Drop ship"
              hint="Ships direct from supplier"
              value={item.is_drop_ship}
              onChange={v => { patch({ is_drop_ship: v }).catch(() => {}) }}
            />
            <BoolRow
              label="Show 'Call for availability' when out of stock"
              hint="Replaces the 'Out of stock' badge"
              value={item.call_for_availability_when_zero}
              onChange={v => { patch({ call_for_availability_when_zero: v }).catch(() => {}) }}
            />
            <FieldInt
              label="Show 'Call for availability' when stock is at or below"
              hint="Leave blank to use the default Low / In-stock badges"
              suffix="units"
              min={0}
              value={item.call_for_availability_below_qty}
              onSave={async v => { try { await patch({ call_for_availability_below_qty: v }) } catch {} }}
            />
          </Section>

          {/* Order limits */}
          <Section title="Order limits">
            <FieldInt
              label="Max qty per order"
              hint="Leave blank for no cap"
              suffix="units"
              min={1}
              value={item.max_order_qty}
              onSave={async v => { try { await patch({ max_order_qty: v }) } catch {} }}
            />
          </Section>

          {/* Freight & packaging */}
          <Section title="Freight & packaging" subtitle="Used by future shipping calculators">
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:8}}>
              <FieldInt
                label="Length"
                suffix="mm"
                value={item.freight_length_mm}
                onSave={async v => { try { await patch({ freight_length_mm: v }) } catch {} }}
              />
              <FieldInt
                label="Width"
                suffix="mm"
                value={item.freight_width_mm}
                onSave={async v => { try { await patch({ freight_width_mm: v }) } catch {} }}
              />
              <FieldInt
                label="Height"
                suffix="mm"
                value={item.freight_height_mm}
                onSave={async v => { try { await patch({ freight_height_mm: v }) } catch {} }}
              />
            </div>
            <div style={{height:10}}/>
            <FieldInt
              label="Weight"
              suffix="g"
              value={item.freight_weight_g}
              onSave={async v => { try { await patch({ freight_weight_g: v }) } catch {} }}
            />
            <div style={{height:10}}/>
            <PackagingSelect
              value={item.freight_packaging}
              onChange={async v => { try { await patch({ freight_packaging: v }) } catch {} }}
            />
          </Section>

          {/* Resources */}
          <Section title="Resources" subtitle="Installation / use instructions">
            <InstructionsPdfField
              itemId={item.id}
              value={item.instructions_url}
              onPatch={async v => { try { await patch({ instructions_url: v }) } catch {} }}
            />
          </Section>

          {/* Read-only MYOB info */}
          <Section title="From MYOB" subtitle="Refreshed on every catalogue sync">
            <KV label="MYOB UID"      value={item.myob_item_uid || '—'} mono/>
            <KV label="RRP (ex GST)"  value={fmtMoney(item.rrp_ex_gst)} mono/>
            <KV label="Tax code"      value={item.is_taxable ? 'GST' : 'Not taxable'}/>
            <KV label="Last synced"   value={item.last_synced_from_myob_at ? new Date(item.last_synced_from_myob_at).toLocaleString('en-AU') : 'Never'} mono/>
          </Section>

          {/* Live status */}
          <Section title="Live status">
            <KV label="Visible to distributors" value={item.b2b_visible ? 'Yes' : 'No'} valueColor={item.b2b_visible ? T.green : T.text3}/>
            <KV label="Trade price (ex GST)"    value={fmtMoney(item.trade_price_ex_gst)} mono valueColor={item.trade_price_ex_gst > 0 ? T.text : T.amber}/>
            <KV label="Has image"               value={item.primary_image_url ? 'Yes' : 'No'} valueColor={item.primary_image_url ? T.green : T.amber}/>
          </Section>

        </div>
      </div>
    </>
  )
}

// ─── Small components ───────────────────────────────────────────────────

function Stat({ n, label, color }: { n: number; label: string; color?: string }) {
  return (
    <div style={{display:'flex',alignItems:'baseline',gap:5}}>
      <span style={{fontSize:18,fontWeight:600,color: color || T.text,fontVariantNumeric:'tabular-nums'}}>{n}</span>
      <span style={{fontSize:10,color:T.text3,textTransform:'uppercase',letterSpacing:'0.05em'}}>{label}</span>
    </div>
  )
}

function PreviewMenu({
  distributors, open, loading, onToggle, onClose, onPick,
}: {
  distributors: DistributorOption[]
  open: boolean
  loading: boolean
  onToggle: () => void
  onClose: () => void
  onPick: (id: string) => void
}) {
  const eligible = distributors
    .filter(d => d.is_active && d.active_user_count > 0)
    .sort((a, b) => a.display_name.localeCompare(b.display_name))
  const disabled = loading

  return (
    <div style={{position:'relative'}}>
      <button
        onClick={onToggle}
        disabled={disabled}
        title="Open the distributor catalogue in a new tab as a chosen distributor — no email magic-link round-trip."
        style={{
          padding:'6px 12px',borderRadius:5,
          border:`1px solid ${T.blue}`,background:`${T.blue}20`,color:T.blue,
          fontSize:12,fontWeight:500,cursor: disabled ? 'wait' : 'pointer',
          fontFamily:'inherit',whiteSpace:'nowrap',
        }}>
        {loading ? 'Opening…' : '👁 Preview as ▾'}
      </button>
      {open && (
        <>
          <div onClick={onClose} style={{position:'fixed',inset:0,zIndex:50}}/>
          <div style={{
            position:'absolute',top:'calc(100% + 4px)',right:0,
            minWidth:220,maxWidth:320,maxHeight:340,overflowY:'auto',
            background:T.bg2,border:`1px solid ${T.border2}`,borderRadius:6,
            boxShadow:'0 12px 28px rgba(0,0,0,0.4)',
            padding:6,zIndex:51,
          }}>
            <div style={{fontSize:10,color:T.text3,padding:'6px 10px',textTransform:'uppercase',letterSpacing:'0.06em'}}>
              Open as distributor
            </div>
            {eligible.length === 0 && (
              <div style={{padding:'10px 12px',fontSize:12,color:T.text3}}>
                No active distributors with users yet. Create one in <a href="/admin/b2b/distributors" style={{color:T.text2}}>Distributors</a>.
              </div>
            )}
            {eligible.map(d => (
              <button
                key={d.id}
                onClick={() => onPick(d.id)}
                style={{
                  display:'block',width:'100%',textAlign:'left',
                  padding:'8px 10px',borderRadius:4,
                  background:'transparent',border:'none',color:T.text,
                  fontSize:13,cursor:'pointer',fontFamily:'inherit',
                }}
                onMouseEnter={e => { e.currentTarget.style.background = T.bg3 }}
                onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}>
                <div style={{fontWeight:500}}>{d.display_name}</div>
                <div style={{fontSize:10,color:T.text3,marginTop:2}}>
                  {d.active_user_count} user{d.active_user_count===1?'':'s'}
                </div>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function InlineTaxonomySelect({
  value, options, saving, addLabel, onChange,
}: {
  value: string | null
  options: TaxonomyOption[]
  saving: boolean
  addLabel: string
  onChange: (v: string | null | '__add__') => void
}) {
  // Hide inactive options unless one is currently selected (so the displayed
  // value is preserved). Sort active options first, alphabetically.
  const visible = options.filter(o => o.is_active || o.id === value)
  return (
    <select
      value={value || ''}
      disabled={saving}
      onChange={e => {
        const v = e.target.value
        if (v === '__add__') onChange('__add__')
        else onChange(v || null)
      }}
      style={{
        width:'100%',
        background:T.bg3,border:`1px solid ${T.border}`,color:T.text,
        borderRadius:5,padding:'6px 8px',fontSize:12,outline:'none',
        fontFamily:'inherit',cursor: saving ? 'wait' : 'pointer',
        opacity: saving ? 0.5 : 1,
      }}>
      <option value="">— None —</option>
      {visible.map(o => (
        <option key={o.id} value={o.id}>{o.name}{!o.is_active ? ' (inactive)' : ''}</option>
      ))}
      <option value="__add__">{addLabel}</option>
    </select>
  )
}

function TaxonomyFilterDropdown({
  label, value, options, onChange,
}: {
  label: string
  value: string
  options: TaxonomyOption[]
  onChange: (v: string) => void
}) {
  const active = value !== 'all'
  // Show inactive options only if currently selected
  const visible = options.filter(o => o.is_active || o.id === value)
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      title={`Filter by ${label.toLowerCase()}`}
      style={{
        padding:'6px 10px',borderRadius:5,
        border:`1px solid ${active ? T.blue : T.border2}`,
        background: active ? `${T.blue}20` : 'transparent',
        color: active ? T.blue : T.text2,
        fontSize:12,fontWeight: active ? 600 : 400,
        cursor:'pointer',fontFamily:'inherit',outline:'none',
      }}>
      <option value="all">{label}: All</option>
      <option value="none">{label}: None</option>
      {visible.map(o => (
        <option key={o.id} value={o.id}>{o.name}{!o.is_active ? ' (inactive)' : ''}</option>
      ))}
    </select>
  )
}

function FilterPill({ active, onClick, color, children }: { active: boolean; onClick: () => void; color?: string; children: React.ReactNode }) {
  return (
    <button onClick={onClick}
      style={{
        padding:'6px 12px',borderRadius:5,
        border:`1px solid ${active ? (color || T.blue) : T.border2}`,
        background: active ? `${color || T.blue}20` : 'transparent',
        color: active ? (color || T.blue) : T.text2,
        fontSize:12,fontWeight: active ? 600 : 400,
        cursor:'pointer',fontFamily:'inherit',whiteSpace:'nowrap',
      }}>
      {children}
    </button>
  )
}

function ToggleSwitch({ on, disabled, onChange }: { on: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => !disabled && onChange(!on)}
      disabled={disabled}
      style={{
        width:36,height:20,borderRadius:10,
        border:'none',padding:2,
        background: on ? T.green : T.bg4,
        cursor: disabled ? 'wait' : 'pointer',
        position:'relative',transition:'background 0.15s',
        opacity: disabled ? 0.5 : 1,
      }}>
      <div style={{
        position:'absolute',top:2,left: on ? 18 : 2,
        width:16,height:16,borderRadius:'50%',
        background:'#fff',transition:'left 0.15s ease',
      }}/>
    </button>
  )
}

// ─── Instructions PDF upload ───────────────────────────────────────────
function InstructionsPdfField({
  itemId, value, onPatch,
}: {
  itemId: string
  value: string | null
  onPatch: (v: string | null) => Promise<void>
}) {
  const [busy, setBusy] = useState<'upload'|'remove'|null>(null)
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  async function handleFile(file: File) {
    setError(null); setBusy('upload')
    try {
      const url = await uploadCatalogueInstructionsPdf(itemId, file)
      await onPatch(url)
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setBusy(null)
    }
  }
  async function handleRemove() {
    if (!value) return
    setError(null); setBusy('remove')
    try {
      await removeCatalogueInstructionsPdf(itemId)
      await onPatch(null)
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setBusy(null)
    }
  }
  return (
    <div>
      {value && (
        <div style={{
          background:T.bg3,border:`1px solid ${T.border2}`,borderRadius:6,
          padding:'10px 12px',marginBottom:10,
          display:'flex',alignItems:'center',justifyContent:'space-between',gap:10,
        }}>
          <div style={{display:'flex',alignItems:'center',gap:10,minWidth:0}}>
            <span style={{fontSize:18}}>📄</span>
            <a href={value} target="_blank" rel="noopener noreferrer"
              style={{fontSize:12,color:T.blue,textDecoration:'underline',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>
              View current PDF
            </a>
          </div>
          <span style={{fontSize:9,color:T.text3,fontFamily:'monospace'}}>uploaded</span>
        </div>
      )}
      <div style={{display:'flex',gap:8}}>
        <button
          onClick={() => !busy && fileRef.current?.click()}
          disabled={!!busy}
          style={{
            flex:1,padding:'9px 14px',borderRadius:6,
            border:`1px solid ${T.blue}`,background:T.blue,color:'#fff',
            fontSize:13,fontWeight:500,fontFamily:'inherit',
            cursor: busy ? 'wait' : 'pointer',
          }}>
          {busy === 'upload' ? 'Uploading…' : (value ? 'Replace PDF' : 'Upload PDF')}
        </button>
        {value && (
          <button
            onClick={handleRemove}
            disabled={!!busy}
            style={{
              padding:'9px 14px',borderRadius:6,
              border:`1px solid ${T.border2}`,background:'transparent',color:T.red,
              fontSize:13,fontFamily:'inherit',cursor: busy ? 'wait' : 'pointer',
            }}>
            {busy === 'remove' ? 'Removing…' : 'Remove'}
          </button>
        )}
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="application/pdf,.pdf"
        onChange={e => {
          const f = e.target.files?.[0]
          if (f) handleFile(f)
          if (fileRef.current) fileRef.current.value = ''
        }}
        style={{display:'none'}}
      />
      <div style={{fontSize:10,color:T.text3,marginTop:6}}>
        PDF only · Max 10 MB · Stored at <code style={{fontFamily:'monospace'}}>b2b-catalogue-pdfs/{itemId}/...</code>
      </div>
      {error && (
        <div style={{marginTop:8,padding:8,background:`${T.red}15`,border:`1px solid ${T.red}40`,borderRadius:5,color:T.red,fontSize:12}}>
          {error}
        </div>
      )}
    </div>
  )
}

// ─── Pricing section (drawer) ──────────────────────────────────────────
function PricingSection({
  item, onPatch,
}: {
  item: CatalogueItem
  onPatch: (p: Partial<CatalogueItem>) => Promise<void>
}) {
  const margin =
    item.cost_price_ex_gst != null && item.trade_price_ex_gst > 0
      ? ((item.trade_price_ex_gst - item.cost_price_ex_gst) / item.trade_price_ex_gst) * 100
      : null

  // Promo "active right now" indicator
  const now = Date.now()
  const promoActive =
    item.promo_price_ex_gst != null &&
    (item.promo_starts_at == null || Date.parse(item.promo_starts_at) <= now) &&
    (item.promo_ends_at   == null || Date.parse(item.promo_ends_at)   >  now)

  return (
    <Section title="Pricing" subtitle="Cost is admin-only. Volume breaks and promos apply on the distributor side.">
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:8}}>
        <FieldNumber
          label="Cost (ex GST)"
          prefix="$"
          value={item.cost_price_ex_gst}
          onSave={v => onPatch({ cost_price_ex_gst: v })}
        />
        <FieldNumber
          label="Trade (ex GST)"
          prefix="$"
          value={item.trade_price_ex_gst}
          required
          onSave={v => { if (v != null) onPatch({ trade_price_ex_gst: v }) }}
        />
      </div>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'5px 0',borderBottom:`1px solid ${T.border}`,fontSize:13}}>
        <span style={{color:T.text3}}>Margin</span>
        <span style={{color: margin == null ? T.text3 : (margin > 30 ? T.green : margin > 10 ? T.amber : T.red),fontFamily:'monospace',fontSize:12}}>
          {margin == null ? '—' : `${margin.toFixed(1)}%`}
        </span>
      </div>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'5px 0',borderBottom:`1px solid ${T.border}`,fontSize:13,marginBottom:14}}>
        <span style={{color:T.text3}}>RRP (ex GST)</span>
        <span style={{color:T.text2,fontFamily:'monospace',fontSize:11}}>{fmtMoney(item.rrp_ex_gst)}</span>
      </div>

      {/* Promo */}
      <div style={{fontSize:11,color:T.text2,fontWeight:500,marginBottom:6,display:'flex',alignItems:'center',gap:8}}>
        Promo price
        {promoActive && (
          <span style={{
            display:'inline-block',padding:'1px 7px',borderRadius:8,fontSize:9,
            background:`${T.green}18`,color:T.green,
          }}>
            ACTIVE
          </span>
        )}
      </div>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:8,marginBottom:14}}>
        <FieldNumber
          label="Price"
          prefix="$"
          value={item.promo_price_ex_gst}
          onSave={v => onPatch({ promo_price_ex_gst: v })}
        />
        <FieldDateTime
          label="Starts"
          value={item.promo_starts_at}
          onSave={v => onPatch({ promo_starts_at: v })}
        />
        <FieldDateTime
          label="Ends"
          value={item.promo_ends_at}
          onSave={v => onPatch({ promo_ends_at: v })}
        />
      </div>

      {/* Volume breaks */}
      <VolumeBreaksEditor
        breaks={item.volume_breaks || []}
        tradePrice={item.trade_price_ex_gst}
        onSave={breaks => onPatch({ volume_breaks: breaks })}
      />
    </Section>
  )
}

// ─── Pricing helpers ───────────────────────────────────────────────────
// Decimal-friendly auto-save number field. NULL when blank.
function FieldNumber({
  label, prefix, value, required, onSave,
}: {
  label: string
  prefix?: string
  value: number | null
  required?: boolean
  onSave: (v: number | null) => Promise<void> | void
}) {
  const [draft, setDraft] = useState<string>(value != null ? value.toFixed(2) : '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { setDraft(value != null ? value.toFixed(2) : '') }, [value])
  async function commit() {
    const trimmed = draft.trim()
    let next: number | null = null
    if (trimmed !== '') {
      const n = Number(trimmed)
      if (!isFinite(n) || n < 0) {
        setError('Must be a non-negative number')
        setTimeout(() => setError(null), 3500)
        setDraft(value != null ? value.toFixed(2) : '')
        return
      }
      next = Math.round(n * 100) / 100
    } else if (required) {
      setError('Required')
      setTimeout(() => setError(null), 3500)
      setDraft(value != null ? value.toFixed(2) : '')
      return
    }
    if (next === value) return
    setSaving(true); setError(null)
    try { await onSave(next) } catch (e: any) {
      setError(e?.message || String(e))
      setTimeout(() => setError(null), 4000)
    } finally { setSaving(false) }
  }
  return (
    <label style={{display:'flex',flexDirection:'column',gap:4}}>
      <span style={{fontSize:11,color:T.text2,fontWeight:500}}>{label}</span>
      <div style={{display:'flex',alignItems:'center',gap:4,
        background:T.bg3,border:`1px solid ${T.border2}`,borderRadius:5,
        padding:'2px 6px 2px 8px',
      }}>
        {prefix && <span style={{fontSize:11,color:T.text3}}>{prefix}</span>}
        <input
          type="text"
          inputMode="decimal"
          value={draft}
          placeholder="—"
          onChange={e => setDraft(e.target.value.replace(/[^\d.]/g, ''))}
          onBlur={commit}
          onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
          style={{
            flex:1,minWidth:0,
            background:'transparent',border:'none',color:T.text,
            padding:'6px 0',fontSize:13,outline:'none',fontFamily:'monospace',
            opacity: saving ? 0.5 : 1,
          }}
        />
      </div>
      {error && <span style={{fontSize:10,color:T.red}}>{error}</span>}
    </label>
  )
}

function FieldDateTime({
  label, value, onSave,
}: {
  label: string
  value: string | null
  onSave: (v: string | null) => Promise<void> | void
}) {
  // Convert ISO → datetime-local format (YYYY-MM-DDTHH:mm) and back
  const toLocal = (iso: string | null): string => {
    if (!iso) return ''
    const d = new Date(iso)
    if (isNaN(d.getTime())) return ''
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
  }
  const [draft, setDraft] = useState<string>(toLocal(value))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { setDraft(toLocal(value)) }, [value])
  async function commit() {
    const next = draft ? new Date(draft).toISOString() : null
    if ((next || null) === (value || null)) return
    setSaving(true); setError(null)
    try { await onSave(next) } catch (e: any) {
      setError(e?.message || String(e))
      setTimeout(() => setError(null), 4000)
    } finally { setSaving(false) }
  }
  return (
    <label style={{display:'flex',flexDirection:'column',gap:4}}>
      <span style={{fontSize:11,color:T.text2,fontWeight:500}}>{label}</span>
      <input
        type="datetime-local"
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        style={{
          background:T.bg3,border:`1px solid ${T.border2}`,color:T.text,
          borderRadius:5,padding:'7px 8px',fontSize:12,outline:'none',fontFamily:'inherit',
          opacity: saving ? 0.5 : 1,
        }}
      />
      {error && <span style={{fontSize:10,color:T.red}}>{error}</span>}
    </label>
  )
}

function VolumeBreaksEditor({
  breaks, tradePrice, onSave,
}: {
  breaks: VolumeBreak[]
  tradePrice: number
  onSave: (next: VolumeBreak[]) => Promise<void> | void
}) {
  const [rows, setRows] = useState<VolumeBreak[]>(breaks)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { setRows(breaks) }, [breaks])

  function patchRow(i: number, p: Partial<VolumeBreak>) {
    setRows(prev => prev.map((r, idx) => idx === i ? { ...r, ...p } : r))
  }
  function removeRow(i: number) {
    const next = rows.filter((_, idx) => idx !== i)
    setRows(next)
    commit(next)
  }
  function addRow() {
    const lastQty = rows.length > 0 ? rows[rows.length - 1].min_qty : 1
    setRows([...rows, { min_qty: lastQty + 10, unit_price_ex_gst: tradePrice }])
  }
  async function commit(next: VolumeBreak[] = rows) {
    // Skip if any row is invalid; surface error
    for (const r of next) {
      if (!Number.isInteger(r.min_qty) || r.min_qty < 1) {
        setError('Each break needs a qty ≥ 1')
        setTimeout(() => setError(null), 3500)
        return
      }
      if (!isFinite(r.unit_price_ex_gst) || r.unit_price_ex_gst < 0) {
        setError('Each break needs a non-negative price')
        setTimeout(() => setError(null), 3500)
        return
      }
    }
    const sorted = [...next].sort((a, b) => a.min_qty - b.min_qty)
    setSaving(true); setError(null)
    try { await onSave(sorted) } catch (e: any) {
      setError(e?.message || String(e))
      setTimeout(() => setError(null), 4000)
    } finally { setSaving(false) }
  }

  return (
    <div>
      <div style={{fontSize:11,color:T.text2,fontWeight:500,marginBottom:6}}>Volume breaks</div>
      {rows.length === 0 && (
        <div style={{fontSize:11,color:T.text3,padding:'6px 0'}}>None — distributor pays trade price at every qty.</div>
      )}
      {rows.map((r, i) => (
        <div key={i} style={{display:'grid',gridTemplateColumns:'auto 1fr 1fr auto',gap:8,alignItems:'end',marginBottom:6}}>
          <span style={{fontSize:11,color:T.text3,paddingBottom:8}}>Qty ≥</span>
          <input
            type="text"
            inputMode="numeric"
            value={String(r.min_qty)}
            onChange={e => patchRow(i, { min_qty: parseInt(e.target.value.replace(/[^\d]/g, '') || '0', 10) })}
            onBlur={() => commit()}
            style={{
              background:T.bg3,border:`1px solid ${T.border2}`,color:T.text,
              borderRadius:5,padding:'7px 8px',fontSize:13,outline:'none',fontFamily:'monospace',
            }}
          />
          <div style={{display:'flex',alignItems:'center',gap:4,
            background:T.bg3,border:`1px solid ${T.border2}`,borderRadius:5,padding:'2px 6px 2px 8px',
          }}>
            <span style={{fontSize:11,color:T.text3}}>$</span>
            <input
              type="text"
              inputMode="decimal"
              value={r.unit_price_ex_gst.toFixed(2)}
              onChange={e => patchRow(i, { unit_price_ex_gst: Number(e.target.value.replace(/[^\d.]/g, '')) || 0 })}
              onBlur={() => commit()}
              style={{
                flex:1,minWidth:0,
                background:'transparent',border:'none',color:T.text,
                padding:'6px 0',fontSize:13,outline:'none',fontFamily:'monospace',
              }}
            />
          </div>
          <button
            onClick={() => removeRow(i)}
            disabled={saving}
            style={{
              background:'transparent',border:'none',color:T.text3,
              padding:'6px 8px',fontSize:14,cursor:'pointer',fontFamily:'inherit',
            }}>
            ×
          </button>
        </div>
      ))}
      <button
        onClick={addRow}
        disabled={saving}
        style={{
          padding:'6px 12px',borderRadius:5,marginTop:4,
          border:`1px dashed ${T.border2}`,background:'transparent',color:T.text2,
          fontSize:11,cursor:'pointer',fontFamily:'inherit',
        }}>
        + Add break
      </button>
      {error && <div style={{fontSize:10,color:T.red,marginTop:6}}>{error}</div>}
    </div>
  )
}

// Auto-saving text field — saves on blur if value differs from prop. Empty input
// becomes null on save (keeps the column clean and matches the API behavior).
function FieldText({
  label, placeholder, value, onSave,
}: {
  label: string
  placeholder?: string
  value: string | null
  onSave: (v: string | null) => Promise<void>
}) {
  const [draft, setDraft] = useState<string>(value || '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { setDraft(value || '') }, [value])

  async function commit() {
    const next = draft.trim() || null
    if ((next || '') === (value || '')) return
    setSaving(true); setError(null)
    try {
      await onSave(next)
    } catch (e: any) {
      setError(e?.message || String(e))
      setTimeout(() => setError(null), 4000)
    } finally {
      setSaving(false)
    }
  }
  return (
    <label style={{display:'flex',flexDirection:'column',gap:4}}>
      <span style={{fontSize:11,color:T.text2,fontWeight:500}}>{label}</span>
      <input
        type="text"
        value={draft}
        placeholder={placeholder}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
        style={{
          background:T.bg3,border:`1px solid ${T.border2}`,color:T.text,
          borderRadius:5,padding:'8px 10px',fontSize:13,outline:'none',fontFamily:'inherit',
          opacity: saving ? 0.5 : 1,
        }}
      />
      {error && <span style={{fontSize:10,color:T.red}}>{error}</span>}
    </label>
  )
}

// Auto-saving integer field. Empty input → null. Validates min on blur.
function FieldInt({
  label, hint, suffix, min, value, onSave,
}: {
  label: string
  hint?: string
  suffix?: string
  min?: number
  value: number | null
  onSave: (v: number | null) => Promise<void>
}) {
  const [draft, setDraft] = useState<string>(value != null ? String(value) : '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { setDraft(value != null ? String(value) : '') }, [value])

  async function commit() {
    const trimmed = draft.trim()
    let next: number | null = null
    if (trimmed !== '') {
      const n = Number(trimmed)
      if (!Number.isInteger(n) || n < (min ?? 0)) {
        setError(`Must be a whole number${min != null ? ` ≥ ${min}` : ''}`)
        setTimeout(() => setError(null), 4000)
        setDraft(value != null ? String(value) : '')
        return
      }
      next = n
    }
    if (next === value) return
    setSaving(true); setError(null)
    try {
      await onSave(next)
    } catch (e: any) {
      setError(e?.message || String(e))
      setTimeout(() => setError(null), 4000)
    } finally {
      setSaving(false)
    }
  }
  return (
    <label style={{display:'flex',flexDirection:'column',gap:4}}>
      <span style={{fontSize:11,color:T.text2,fontWeight:500}}>{label}</span>
      <div style={{display:'flex',alignItems:'center',gap:6}}>
        <input
          type="text"
          inputMode="numeric"
          value={draft}
          onChange={e => setDraft(e.target.value.replace(/[^\d]/g, ''))}
          onBlur={commit}
          onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
          placeholder="—"
          style={{
            flex:1,
            background:T.bg3,border:`1px solid ${T.border2}`,color:T.text,
            borderRadius:5,padding:'8px 10px',fontSize:13,outline:'none',
            fontFamily:'monospace',
            opacity: saving ? 0.5 : 1,
          }}
        />
        {suffix && <span style={{fontSize:11,color:T.text3}}>{suffix}</span>}
      </div>
      {hint && <span style={{fontSize:10,color:T.text3}}>{hint}</span>}
      {error && <span style={{fontSize:10,color:T.red}}>{error}</span>}
    </label>
  )
}

function BoolRow({
  label, hint, value, onChange,
}: {
  label: string
  hint?: string
  value: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <div style={{
      display:'flex',alignItems:'center',justifyContent:'space-between',gap:12,
      padding:'8px 0',borderBottom:`1px solid ${T.border}`,
    }}>
      <div style={{flex:1,minWidth:0}}>
        <div style={{fontSize:13,color:T.text}}>{label}</div>
        {hint && <div style={{fontSize:10,color:T.text3,marginTop:2}}>{hint}</div>}
      </div>
      <ToggleSwitch on={value} onChange={onChange}/>
    </div>
  )
}

function PackagingSelect({
  value, onChange,
}: {
  value: FreightPackaging | null
  onChange: (v: FreightPackaging | null) => void
}) {
  return (
    <label style={{display:'flex',flexDirection:'column',gap:4}}>
      <span style={{fontSize:11,color:T.text2,fontWeight:500}}>Packaging</span>
      <select
        value={value || ''}
        onChange={e => onChange((e.target.value || null) as FreightPackaging | null)}
        style={{
          background:T.bg3,border:`1px solid ${T.border2}`,color:T.text,
          borderRadius:5,padding:'8px 10px',fontSize:13,outline:'none',fontFamily:'inherit',
        }}>
        <option value="">— Not specified —</option>
        <option value="box">Box</option>
        <option value="pallet">Pallet</option>
        <option value="other">Other</option>
      </select>
    </label>
  )
}

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div style={{marginBottom:24}}>
      <div style={{fontSize:10,color:T.text3,textTransform:'uppercase',letterSpacing:'0.08em',marginBottom:8}}>
        {title}
        {subtitle && <span style={{textTransform:'none',letterSpacing:0,marginLeft:8,color:T.text3}}>· {subtitle}</span>}
      </div>
      {children}
    </div>
  )
}

function TaxonomySelect({
  label, value, options, onChange,
}: {
  label: string
  value: string | null
  options: TaxonomyOption[]
  onChange: (v: string | null) => void
}) {
  // Show inactive options only if currently selected (so the value is preserved
  // visually); otherwise hide them from the picker.
  const visible = options.filter(o => o.is_active || o.id === value)
  return (
    <label style={{display:'flex',flexDirection:'column',gap:4}}>
      <span style={{fontSize:11,color:T.text2,fontWeight:500}}>{label}</span>
      <select
        value={value || ''}
        onChange={e => onChange(e.target.value || null)}
        style={{
          background:T.bg3,border:`1px solid ${T.border2}`,color:T.text,
          borderRadius:5,padding:'8px 10px',fontSize:13,outline:'none',
          fontFamily:'inherit',width:'100%',
        }}>
        <option value="">— None —</option>
        {visible.map(o => (
          <option key={o.id} value={o.id}>{o.name}{!o.is_active ? ' (inactive)' : ''}</option>
        ))}
      </select>
    </label>
  )
}

function KV({ label, value, mono, valueColor }: { label: string; value: string; mono?: boolean; valueColor?: string }) {
  return (
    <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'5px 0',borderBottom:`1px solid ${T.border}`,fontSize:13}}>
      <span style={{color:T.text3}}>{label}</span>
      <span style={{color: valueColor || T.text2, fontFamily: mono ? 'monospace' : 'inherit', fontSize: mono ? 11 : 12}}>{value}</span>
    </div>
  )
}

function th(width?: number): React.CSSProperties {
  return {
    fontSize:10,color:T.text3,padding:'10px 12px',
    textAlign:'left',fontWeight:500,
    textTransform:'uppercase',letterSpacing:'0.05em',
    width,whiteSpace:'nowrap',
    background:T.bg2,
  }
}
function td(): React.CSSProperties {
  return { padding:'10px 12px',verticalAlign:'middle' }
}

// ─── Auth gate ─────────────────────────────────────────────────────────
export async function getServerSideProps(context: any) {
  return requirePageAuth(context, 'edit:b2b_catalogue')
}
