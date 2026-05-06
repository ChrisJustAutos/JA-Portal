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
  last_synced_from_myob_at: string | null
  created_at: string
  updated_at: string
}

interface TaxonomyOption {
  id: string
  name: string
  is_active: boolean
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

// ─── Page ───────────────────────────────────────────────────────────────
export default function CatalogueAdminPage({ user }: Props) {
  const [items, setItems] = useState<CatalogueItem[]>([])
  const [models, setModels] = useState<TaxonomyOption[]>([])
  const [productTypes, setProductTypes] = useState<TaxonomyOption[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [visibilityFilter, setVisibilityFilter] = useState<VisibilityFilter>('all')
  const [drawerItemId, setDrawerItemId] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    try {
      const [itemsRes, modelsRes, typesRes] = await Promise.all([
        fetch('/api/b2b/admin/catalogue',     { credentials: 'same-origin' }),
        fetch('/api/b2b/admin/models',        { credentials: 'same-origin' }),
        fetch('/api/b2b/admin/product-types', { credentials: 'same-origin' }),
      ])
      if (!itemsRes.ok)  throw new Error(`Catalogue HTTP ${itemsRes.status}: ${await itemsRes.text()}`)
      if (!modelsRes.ok) throw new Error(`Models HTTP ${modelsRes.status}`)
      if (!typesRes.ok)  throw new Error(`Product types HTTP ${typesRes.status}`)
      const itemsJson  = await itemsRes.json()
      const modelsJson = await modelsRes.json()
      const typesJson  = await typesRes.json()
      setItems(itemsJson.items || [])
      setModels((modelsJson.models || []).map((m: any) => ({ id: m.id, name: m.name, is_active: m.is_active })))
      setProductTypes((typesJson.product_types || []).map((t: any) => ({ id: t.id, name: t.name, is_active: t.is_active })))
      setLoadError(null)
    } catch (e: any) {
      setLoadError(e?.message || String(e))
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [])

  function patchLocalItem(id: string, patch: Partial<CatalogueItem>) {
    setItems(prev => prev.map(it => it.id === id ? { ...it, ...patch } : it))
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return items.filter(it => {
      if (visibilityFilter === 'visible' && !it.b2b_visible) return false
      if (visibilityFilter === 'hidden'  &&  it.b2b_visible) return false
      if (q) {
        const hay = (it.sku + ' ' + it.name).toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [items, search, visibilityFilter])

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
            <button onClick={load} disabled={loading}
              style={{padding:'6px 12px',borderRadius:5,border:`1px solid ${T.border2}`,background:'transparent',color:T.text2,fontSize:12,cursor:loading?'wait':'pointer',fontFamily:'inherit'}}>
              {loading ? 'Loading…' : '↻ Refresh'}
            </button>
          </div>

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
                    <th style={{...th(100),textAlign:'right'}}>RRP</th>
                    <th style={{...th(140),textAlign:'right'}}>Trade $ (ex GST)</th>
                    <th style={{...th(100),textAlign:'center'}}>Visible</th>
                    <th style={th(50)}></th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.length === 0 && !loading && (
                    <tr><td colSpan={7} style={{padding:24,textAlign:'center',color:T.text3,fontSize:13}}>
                      {items.length === 0 ? 'No items yet — run a catalogue sync from the B2B Portal page.' : 'No items match your filters.'}
                    </td></tr>
                  )}
                  {filtered.map((it, i) => (
                    <CatalogueRow
                      key={it.id}
                      item={it}
                      index={i}
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
  item, index, onPatch, onOpenDrawer,
}: {
  item: CatalogueItem
  index: number
  onPatch: (id: string, patch: Partial<CatalogueItem>) => void
  onOpenDrawer: () => void
}) {
  const [priceDraft, setPriceDraft] = useState<string>(item.trade_price_ex_gst.toFixed(2))
  const [savingField, setSavingField] = useState<'price'|'visible'|null>(null)
  const [error, setError] = useState<string | null>(null)

  // Sync local price draft when the underlying item changes (e.g. after refresh)
  useEffect(() => { setPriceDraft(item.trade_price_ex_gst.toFixed(2)) }, [item.trade_price_ex_gst])

  async function patchServer(patch: Partial<CatalogueItem>, fieldKey: 'price'|'visible') {
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

  const showWarning = item.b2b_visible && item.trade_price_ex_gst <= 0
  const showImageWarning = item.b2b_visible && !item.primary_image_url

  return (
    <tr style={{
      borderTop: index > 0 ? `1px solid ${T.border}` : 'none',
      background: error ? `${T.red}08` : 'transparent',
    }}>
      {/* Image thumb */}
      <td style={{...td(),padding:6,cursor:'pointer'}} onClick={onOpenDrawer}>
        <div style={{
          width:50,height:50,borderRadius:5,overflow:'hidden',
          background:T.bg3,border:`1px solid ${T.border}`,
          display:'flex',alignItems:'center',justifyContent:'center',
        }}>
          {item.primary_image_url ? (
            <img src={item.primary_image_url} alt="" style={{maxWidth:'100%',maxHeight:'100%',objectFit:'contain'}}
              onError={e => { (e.target as HTMLImageElement).style.display='none' }}/>
          ) : (
            <span style={{fontSize:9,color:T.text3,fontFamily:'monospace'}}>no img</span>
          )}
        </div>
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

    if (!ALLOWED_IMAGE_TYPES.includes(file.type.toLowerCase())) {
      setImageError(`File type "${file.type || 'unknown'}" not allowed. Use PNG, JPG or WEBP.`)
      return
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setImageError(`File is ${(file.size/1024/1024).toFixed(1)} MB — max 10 MB.`)
      return
    }
    if (file.size === 0) {
      setImageError('File appears to be empty.')
      return
    }

    setUploading(true)
    try {
      const supabase = getSupabase()
      const ext = fileExt(file)
      // Path: {catalogue_id}/{nanoid}.{ext}  per migration comment
      const path = `${item.id}/${nanoid()}.${ext}`
      const { error: upErr } = await supabase.storage
        .from('b2b-catalogue')
        .upload(path, file, { cacheControl: '3600', upsert: false, contentType: file.type })
      if (upErr) throw new Error(upErr.message || 'Upload failed')

      const { data: { publicUrl } } = supabase.storage.from('b2b-catalogue').getPublicUrl(path)

      // Best-effort: remove the previous primary image (other files in this
      // catalogue folder) so we don't leak storage on re-uploads.
      try {
        const { data: list } = await supabase.storage.from('b2b-catalogue').list(item.id, { limit: 50 })
        const newName = path.split('/').pop()
        if (list) {
          const toDelete = list.filter(f => f.name !== newName).map(f => `${item.id}/${f.name}`)
          if (toDelete.length > 0) await supabase.storage.from('b2b-catalogue').remove(toDelete)
        }
      } catch { /* silent — best-effort cleanup */ }

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
