// pages/b2b/catalogue.tsx
//
// Distributor-facing catalogue browse page. Card grid with image, name,
// trade price (ex GST), stock indicator, and add-to-cart controls.
//
// Search is client-side over name/SKU. Stock comes from the API which
// pulls live (5-min cached) MYOB QuantityAvailable.

import { useEffect, useMemo, useState } from 'react'
import Head from 'next/head'
import type { GetServerSideProps } from 'next'
import B2BLayout from '../../components/b2b/B2BLayout'
import { requireB2BPageAuth } from '../../lib/b2bAuthServer'

const T = {
  bg:'#0d0f12', bg2:'#131519', bg3:'#1a1d23', bg4:'#21252d',
  border:'rgba(255,255,255,0.07)', border2:'rgba(255,255,255,0.12)',
  text:'#e8eaf0', text2:'#aab0c0', text3:'#8d93a4',
  blue:'#4f8ef7', teal:'#2dd4bf', green:'#34c77b',
  amber:'#f5a623', red:'#f04e4e',
}

interface Props {
  b2bUser: {
    id: string
    email: string
    fullName: string | null
    role: 'owner' | 'member'
    distributor: { id: string; displayName: string }
  }
}

interface TaxonomyRef {
  id: string
  name: string
}

interface CatalogueItem {
  id: string
  sku: string
  name: string
  description: string | null
  trade_price_ex_gst: number
  rrp_ex_gst: number | null
  is_taxable: boolean
  primary_image_url: string | null
  model: TaxonomyRef | null
  product_type: TaxonomyRef | null
  stock: {
    state: 'in_stock' | 'low_stock' | 'out_of_stock'
    qty_available: number | null
    is_inventoried: boolean
  }
}

type GroupBy = 'none' | 'model' | 'product_type'
type TileStep = 'model' | 'type' | 'browse'

const TILE_COLORS = ['#4f8ef7', '#2dd4bf', '#34c77b', '#f5a623', '#a78bfa', '#ec4899', '#06b6d4']

interface CartLine {
  id: string
  catalogue_id: string | null
  qty: number
}

export default function B2BCataloguePage({ b2bUser }: Props) {
  const [items, setItems] = useState<CatalogueItem[]>([])
  const [cartLines, setCartLines] = useState<CartLine[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [stockError, setStockError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [groupBy, setGroupBy] = useState<GroupBy>('none')
  const [modelFilter, setModelFilter] = useState<string>('all')         // 'all' | 'none' | <id>
  const [productTypeFilter, setProductTypeFilter] = useState<string>('all')
  const [tileStep, setTileStep] = useState<TileStep>('model')

  async function loadAll() {
    setLoading(true)
    setError(null)
    try {
      const [catRes, cartRes] = await Promise.all([
        fetch('/api/b2b/catalogue', { credentials: 'same-origin' }),
        fetch('/api/b2b/cart', { credentials: 'same-origin' }),
      ])
      if (!catRes.ok) throw new Error(`Catalogue HTTP ${catRes.status}: ${await catRes.text()}`)
      if (!cartRes.ok) throw new Error(`Cart HTTP ${cartRes.status}: ${await cartRes.text()}`)
      const catJson = await catRes.json()
      const cartJson = await cartRes.json()
      setItems(catJson.items || [])
      setStockError(catJson.stock_error || null)
      setCartLines(
        (cartJson.lines || []).map((l: any) => ({
          id: l.id,
          catalogue_id: l.catalogue_id,
          qty: l.qty,
        })),
      )
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { loadAll() }, [])

  const cartByCatalogueId = useMemo(() => {
    const m: Record<string, number> = {}
    for (const l of cartLines) {
      if (l.catalogue_id) m[l.catalogue_id] = l.qty
    }
    return m
  }, [cartLines])

  const cartItemCount = useMemo(() => cartLines.reduce((s, l) => s + l.qty, 0), [cartLines])

  // Build option lists from the loaded items (de-duped, sorted)
  const modelOptions = useMemo(() => {
    const m = new Map<string, string>()
    for (const it of items) if (it.model) m.set(it.model.id, it.model.name)
    return Array.from(m.entries()).map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name))
  }, [items])
  const productTypeOptions = useMemo(() => {
    const m = new Map<string, string>()
    for (const it of items) if (it.product_type) m.set(it.product_type.id, it.product_type.name)
    return Array.from(m.entries()).map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name))
  }, [items])

  // Items in scope for the type-step / browse-step (after model has been chosen).
  const itemsAfterModel = useMemo(() => {
    if (modelFilter === 'all')  return items
    if (modelFilter === 'none') return items.filter(i => !i.model)
    return items.filter(i => i.model?.id === modelFilter)
  }, [items, modelFilter])

  // Tile data for the model step
  const modelTiles = useMemo(() => modelOptions.map(o => ({
    id: o.id,
    name: o.name,
    count: items.filter(i => i.model?.id === o.id).length,
  })), [modelOptions, items])
  const noModelCount = useMemo(() => items.filter(i => !i.model).length, [items])

  // Tile data for the type step (scoped to chosen model)
  const typeTiles = useMemo(() => {
    const m = new Map<string, { id: string; name: string; count: number }>()
    for (const it of itemsAfterModel) {
      if (!it.product_type) continue
      const cur = m.get(it.product_type.id)
      if (cur) cur.count++
      else m.set(it.product_type.id, { id: it.product_type.id, name: it.product_type.name, count: 1 })
    }
    return Array.from(m.values()).sort((a, b) => a.name.localeCompare(b.name))
  }, [itemsAfterModel])
  const noTypeCount = useMemo(() => itemsAfterModel.filter(i => !i.product_type).length, [itemsAfterModel])

  // Resolve the current model/type label for breadcrumb purposes
  const modelLabel =
    modelFilter === 'all'  ? 'All models'
    : modelFilter === 'none' ? 'Other'
    : modelOptions.find(o => o.id === modelFilter)?.name || 'Model'
  const typeLabel =
    productTypeFilter === 'all'  ? 'All types'
    : productTypeFilter === 'none' ? 'Other'
    : productTypeOptions.find(o => o.id === productTypeFilter)?.name || 'Type'

  // Navigation helpers
  function pickModel(id: string | 'all' | 'none') {
    setModelFilter(id)
    setProductTypeFilter('all')
    setTileStep('type')
  }
  function pickType(id: string | 'all' | 'none') {
    setProductTypeFilter(id)
    setTileStep('browse')
  }
  function backToModelStep() {
    setModelFilter('all')
    setProductTypeFilter('all')
    setSearch('')
    setTileStep('model')
  }
  function backToTypeStep() {
    setProductTypeFilter('all')
    setSearch('')
    setTileStep('type')
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return items.filter(i => {
      if (modelFilter === 'none' && i.model) return false
      if (modelFilter !== 'all' && modelFilter !== 'none' && i.model?.id !== modelFilter) return false
      if (productTypeFilter === 'none' && i.product_type) return false
      if (productTypeFilter !== 'all' && productTypeFilter !== 'none' && i.product_type?.id !== productTypeFilter) return false
      if (q) {
        const hay = (i.name + ' ' + i.sku + ' ' + (i.description || '')).toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [items, search, modelFilter, productTypeFilter])

  const grouped = useMemo(() => {
    if (groupBy === 'none') return null
    const groups = new Map<string, { key: string; label: string; items: CatalogueItem[] }>()
    const UNCAT = '__uncategorised__'
    for (const it of filtered) {
      const ref = groupBy === 'model' ? it.model : it.product_type
      const key = ref?.id || UNCAT
      const label = ref?.name || (groupBy === 'model' ? 'Other models' : 'Other')
      if (!groups.has(key)) groups.set(key, { key, label, items: [] })
      groups.get(key)!.items.push(it)
    }
    // Sort: named groups by label asc, "Other"/uncategorised last
    return Array.from(groups.values()).sort((a, b) => {
      if (a.key === UNCAT) return 1
      if (b.key === UNCAT) return -1
      return a.label.localeCompare(b.label)
    })
  }, [filtered, groupBy])

  async function setQty(catalogueId: string, qty: number) {
    // Optimistic update
    setCartLines(prev => {
      const existing = prev.find(l => l.catalogue_id === catalogueId)
      if (qty === 0) {
        return prev.filter(l => l.catalogue_id !== catalogueId)
      }
      if (existing) {
        return prev.map(l => l.catalogue_id === catalogueId ? { ...l, qty } : l)
      }
      // tmp id until server returns
      return [...prev, { id: `tmp-${catalogueId}`, catalogue_id: catalogueId, qty }]
    })
    try {
      const r = await fetch('/api/b2b/cart/items', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ catalogue_id: catalogueId, qty }),
      })
      const j = await r.json()
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`)
      // Patch the temp id with the real one if we got a line back
      if (j.line && j.line.id) {
        setCartLines(prev => prev.map(l =>
          l.catalogue_id === catalogueId ? { id: j.line.id, catalogue_id: catalogueId, qty: j.line.qty } : l
        ))
      }
    } catch (e: any) {
      // Roll back: re-fetch cart to truth
      const cartRes = await fetch('/api/b2b/cart', { credentials: 'same-origin' })
      if (cartRes.ok) {
        const j = await cartRes.json()
        setCartLines((j.lines || []).map((l: any) => ({ id: l.id, catalogue_id: l.catalogue_id, qty: l.qty })))
      }
      alert(e?.message || 'Could not update cart')
    }
  }

  return (
    <>
      <Head><title>Catalogue · Just Autos B2B</title></Head>
      <B2BLayout user={b2bUser} active="catalogue" cartCount={cartItemCount}>

        {/* Header — title always; on browse step, breadcrumb sits below */}
        <header style={{marginBottom:18}}>
          <div style={{display:'flex',alignItems:'flex-end',justifyContent:'space-between',gap:16,flexWrap:'wrap'}}>
            <div>
              <h1 style={{fontSize:22,fontWeight:600,margin:0,letterSpacing:'-0.01em'}}>Catalogue</h1>
              <div style={{fontSize:13,color:T.text3,marginTop:4}}>
                {tileStep === 'model'  && 'Choose a model to begin. Pricing is ex GST.'}
                {tileStep === 'type'   && `Choose a product type within ${modelLabel}.`}
                {tileStep === 'browse' && 'Add to cart. Pricing is ex GST.'}
              </div>
            </div>
            {tileStep === 'browse' && (
              <button onClick={backToModelStep}
                style={{padding:'7px 12px',borderRadius:5,border:`1px solid ${T.border2}`,background:'transparent',color:T.text2,fontSize:12,cursor:'pointer',fontFamily:'inherit'}}>
                ← Start over
              </button>
            )}
            {tileStep === 'type' && (
              <button onClick={backToModelStep}
                style={{padding:'7px 12px',borderRadius:5,border:`1px solid ${T.border2}`,background:'transparent',color:T.text2,fontSize:12,cursor:'pointer',fontFamily:'inherit'}}>
                ← Choose different model
              </button>
            )}
          </div>

          {/* Breadcrumb (browse step) */}
          {tileStep === 'browse' && (
            <div style={{display:'flex',alignItems:'center',gap:8,marginTop:10,fontSize:12,color:T.text3,flexWrap:'wrap'}}>
              <button onClick={backToModelStep}
                style={crumbStyle(true)}>Models</button>
              <span>›</span>
              <button onClick={backToTypeStep}
                style={crumbStyle(true)}>{modelLabel}</button>
              <span>›</span>
              <span style={crumbStyle(false)}>{typeLabel}</span>
            </div>
          )}
        </header>

        {error && (
          <div style={{padding:12,background:`${T.red}15`,border:`1px solid ${T.red}40`,borderRadius:7,color:T.red,fontSize:13,marginBottom:14}}>
            {error}
          </div>
        )}

        {stockError && (
          <div style={{padding:10,background:`${T.amber}10`,border:`1px solid ${T.amber}30`,borderRadius:7,color:T.amber,fontSize:12,marginBottom:14}}>
            ⚠ Live stock unavailable right now ({stockError}). You can still browse but stock indicators may be out of date.
          </div>
        )}

        {/* Loading shell while items haven't arrived yet */}
        {loading && items.length === 0 && (
          <div style={{padding:36,textAlign:'center',color:T.text3,fontSize:13,background:T.bg2,border:`1px solid ${T.border}`,borderRadius:10}}>
            Loading…
          </div>
        )}

        {/* No products at all */}
        {!loading && items.length === 0 && (
          <div style={{padding:36,textAlign:'center',color:T.text3,fontSize:13,background:T.bg2,border:`1px solid ${T.border}`,borderRadius:10}}>
            No products available yet — check back soon.
          </div>
        )}

        {/* ─── Step: Model ─────────────────────────────────────────────── */}
        {tileStep === 'model' && items.length > 0 && (
          <div style={{
            display:'grid',
            gridTemplateColumns:'repeat(auto-fill, minmax(220px, 1fr))',
            gap:14,
          }}>
            <Tile index={0} accent={T.text2} name="View all models" subtitle={`${items.length} item${items.length===1?'':'s'}`} onClick={() => { setModelFilter('all'); setProductTypeFilter('all'); setTileStep('browse') }} />
            {modelTiles.map((m, i) => (
              <Tile key={m.id} index={i + 1} name={m.name} subtitle={`${m.count} item${m.count===1?'':'s'}`} onClick={() => pickModel(m.id)} />
            ))}
            {noModelCount > 0 && (
              <Tile index={modelTiles.length + 1} accent={T.text3} name="Other" subtitle={`${noModelCount} item${noModelCount===1?'':'s'}`} onClick={() => pickModel('none')} />
            )}
          </div>
        )}

        {/* ─── Step: Type ──────────────────────────────────────────────── */}
        {tileStep === 'type' && items.length > 0 && (
          <div style={{
            display:'grid',
            gridTemplateColumns:'repeat(auto-fill, minmax(220px, 1fr))',
            gap:14,
          }}>
            <Tile index={0} accent={T.text2} name={`All types in ${modelLabel}`} subtitle={`${itemsAfterModel.length} item${itemsAfterModel.length===1?'':'s'}`} onClick={() => pickType('all')} />
            {typeTiles.map((t, i) => (
              <Tile key={t.id} index={i + 1} name={t.name} subtitle={`${t.count} item${t.count===1?'':'s'}`} onClick={() => pickType(t.id)} />
            ))}
            {noTypeCount > 0 && (
              <Tile index={typeTiles.length + 1} accent={T.text3} name="Other" subtitle={`${noTypeCount} item${noTypeCount===1?'':'s'}`} onClick={() => pickType('none')} />
            )}
          </div>
        )}

        {/* ─── Step: Browse ────────────────────────────────────────────── */}
        {tileStep === 'browse' && items.length > 0 && (
          <>
            {/* Toolbar */}
            <div style={{display:'flex',gap:10,alignItems:'center',flexWrap:'wrap',marginBottom:14}}>
              <input
                type="text"
                placeholder="Search by name or SKU…"
                value={search}
                onChange={e => setSearch(e.target.value)}
                style={{
                  flex:1,minWidth:200,maxWidth:360,
                  background:T.bg2,border:`1px solid ${T.border2}`,color:T.text,
                  borderRadius:6,padding:'8px 12px',fontSize:13,outline:'none',fontFamily:'inherit',
                }}
              />
              <FilterSelect
                label="Model"
                value={modelFilter}
                options={modelOptions}
                onChange={setModelFilter}
              />
              <FilterSelect
                label="Type"
                value={productTypeFilter}
                options={productTypeOptions}
                onChange={setProductTypeFilter}
              />
              <div style={{display:'flex',alignItems:'center',gap:6}}>
                <span style={{fontSize:12,color:T.text3}}>Group by</span>
                <select
                  value={groupBy}
                  onChange={e => setGroupBy(e.target.value as GroupBy)}
                  style={{
                    background:T.bg2,border:`1px solid ${T.border2}`,color:T.text,
                    borderRadius:6,padding:'7px 10px',fontSize:12,outline:'none',fontFamily:'inherit',
                    cursor:'pointer',
                  }}>
                  <option value="none">None</option>
                  <option value="model">Model</option>
                  <option value="product_type">Product type</option>
                </select>
              </div>
              <button onClick={loadAll} disabled={loading}
                style={{padding:'7px 12px',borderRadius:5,border:`1px solid ${T.border2}`,background:'transparent',color:T.text2,fontSize:12,cursor:loading?'wait':'pointer',fontFamily:'inherit'}}>
                {loading ? '…' : '↻'}
              </button>
            </div>

            {!loading && filtered.length === 0 && (
              <div style={{padding:36,textAlign:'center',color:T.text3,fontSize:13,background:T.bg2,border:`1px solid ${T.border}`,borderRadius:10}}>
                No products match your search.
              </div>
            )}

            {/* Card grid (flat or grouped) */}
            {grouped ? (
              <div style={{display:'flex',flexDirection:'column',gap:24}}>
                {grouped.map(g => (
                  <section key={g.key}>
                    <h2 style={{
                      fontSize:13,fontWeight:600,margin:'0 0 10px',color:T.text2,
                      textTransform:'uppercase',letterSpacing:'0.06em',
                      paddingBottom:6,borderBottom:`1px solid ${T.border2}`,
                      display:'flex',justifyContent:'space-between',alignItems:'baseline',gap:8,
                    }}>
                      <span>{g.label}</span>
                      <span style={{fontSize:11,color:T.text3,fontWeight:400,letterSpacing:'normal',textTransform:'none'}}>
                        {g.items.length} item{g.items.length === 1 ? '' : 's'}
                      </span>
                    </h2>
                    <div style={{
                      display:'grid',
                      gridTemplateColumns:'repeat(auto-fill, minmax(240px, 1fr))',
                      gap:14,
                    }}>
                      {g.items.map(item => (
                        <CatalogueCard
                          key={item.id}
                          item={item}
                          qtyInCart={cartByCatalogueId[item.id] || 0}
                          onSetQty={qty => setQty(item.id, qty)}
                        />
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            ) : (
              <div style={{
                display:'grid',
                gridTemplateColumns:'repeat(auto-fill, minmax(240px, 1fr))',
                gap:14,
              }}>
                {filtered.map(item => (
                  <CatalogueCard
                    key={item.id}
                    item={item}
                    qtyInCart={cartByCatalogueId[item.id] || 0}
                    onSetQty={qty => setQty(item.id, qty)}
                  />
                ))}
              </div>
            )}
          </>
        )}

      </B2BLayout>
    </>
  )
}

// ─── Card ───────────────────────────────────────────────────────────────
function CatalogueCard({
  item, qtyInCart, onSetQty,
}: {
  item: CatalogueItem
  qtyInCart: number
  onSetQty: (qty: number) => void
}) {
  const stockColor = stockColorFor(item.stock.state)
  const canAdd = item.stock.state !== 'out_of_stock'

  return (
    <div style={{
      background:T.bg2,border:`1px solid ${T.border}`,borderRadius:10,
      display:'flex',flexDirection:'column',overflow:'hidden',
    }}>
      {/* Image */}
      <div style={{
        width:'100%',aspectRatio:'1 / 1',
        background:'#fff',
        display:'flex',alignItems:'center',justifyContent:'center',
      }}>
        {item.primary_image_url ? (
          <img src={item.primary_image_url} alt={item.name}
            style={{maxWidth:'100%',maxHeight:'100%',objectFit:'contain'}}
            onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
          />
        ) : (
          <span style={{fontSize:12,color:'#aaa',fontFamily:'monospace'}}>no image</span>
        )}
      </div>

      {/* Body */}
      <div style={{padding:'12px 14px 14px',display:'flex',flexDirection:'column',gap:6,flex:1}}>
        <div style={{fontSize:9,color:T.text3,fontFamily:'monospace',textTransform:'uppercase',letterSpacing:'0.04em'}}>{item.sku}</div>
        <div style={{fontSize:13,color:T.text,fontWeight:500,lineHeight:1.3,minHeight:34}}>{item.name}</div>

        {(item.model || item.product_type) && (
          <div style={{display:'flex',gap:5,flexWrap:'wrap'}}>
            {item.model && <TagChip color={T.teal}>{item.model.name}</TagChip>}
            {item.product_type && <TagChip color={T.blue}>{item.product_type.name}</TagChip>}
          </div>
        )}

        {/* Stock + price */}
        <div style={{display:'flex',alignItems:'baseline',justifyContent:'space-between',marginTop:4,gap:8}}>
          <div style={{fontSize:15,color:T.text,fontWeight:600,fontVariantNumeric:'tabular-nums'}}>
            ${item.trade_price_ex_gst.toFixed(2)}
            <span style={{fontSize:9,color:T.text3,fontWeight:400,marginLeft:4}}>ex GST</span>
          </div>
          <span style={{
            display:'inline-block',padding:'2px 8px',borderRadius:8,fontSize:10,fontWeight:500,
            background:`${stockColor}18`,color:stockColor,whiteSpace:'nowrap',
          }}>
            {stockLabel(item.stock)}
          </span>
        </div>

        {/* Add to cart / qty stepper */}
        <div style={{marginTop:8}}>
          {qtyInCart > 0 ? (
            <QtyStepper
              qty={qtyInCart}
              max={item.stock.is_inventoried ? (item.stock.qty_available ?? undefined) : undefined}
              onChange={onSetQty}
            />
          ) : (
            <button
              onClick={() => onSetQty(1)}
              disabled={!canAdd}
              style={{
                width:'100%',padding:'8px 12px',borderRadius:6,
                border:`1px solid ${canAdd ? T.blue : T.border2}`,
                background: canAdd ? T.blue : T.bg3,
                color: canAdd ? '#fff' : T.text3,
                fontSize:13,fontWeight:500,
                cursor: canAdd ? 'pointer' : 'not-allowed',
                fontFamily:'inherit',
              }}>
              {canAdd ? 'Add to cart' : 'Out of stock'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function QtyStepper({ qty, max, onChange }: { qty: number; max?: number; onChange: (q: number) => void }) {
  return (
    <div style={{
      display:'flex',alignItems:'center',
      border:`1px solid ${T.border2}`,borderRadius:6,
      background:T.bg3,
    }}>
      <button onClick={() => onChange(qty - 1)}
        style={qtyBtnStyle()}>
        −
      </button>
      <input
        type="number"
        value={qty}
        min={0}
        max={max}
        onChange={e => {
          const v = parseInt(e.target.value || '0', 10)
          if (isFinite(v) && v >= 0) onChange(v)
        }}
        style={{
          flex:1,textAlign:'center',
          background:'transparent',border:'none',color:T.text,
          fontSize:13,outline:'none',fontFamily:'inherit',
          padding:'6px 0',
          MozAppearance:'textfield' as any,
        }}
      />
      <button
        onClick={() => onChange(qty + 1)}
        disabled={max != null && qty >= max}
        style={qtyBtnStyle(max != null && qty >= max)}>
        +
      </button>
    </div>
  )
}

function Tile({
  index, name, subtitle, accent, onClick,
}: {
  index: number
  name: string
  subtitle: string
  accent?: string
  onClick: () => void
}) {
  const color = accent || TILE_COLORS[index % TILE_COLORS.length]
  return (
    <button
      onClick={onClick}
      style={{
        background:T.bg2,border:`1px solid ${T.border}`,borderRadius:10,
        padding:0,overflow:'hidden',
        display:'flex',flexDirection:'column',
        cursor:'pointer',fontFamily:'inherit',color:T.text,
        textAlign:'left',transition:'background 0.12s, border-color 0.12s',
      }}
      onMouseEnter={e => {
        e.currentTarget.style.background = T.bg3
        e.currentTarget.style.borderColor = T.border2
      }}
      onMouseLeave={e => {
        e.currentTarget.style.background = T.bg2
        e.currentTarget.style.borderColor = T.border
      }}>
      <div style={{height:5,background:color}}/>
      <div style={{padding:'18px 18px 16px',display:'flex',flexDirection:'column',gap:6,minHeight:90,justifyContent:'center'}}>
        <div style={{fontSize:15,fontWeight:600,color:T.text,lineHeight:1.25}}>{name}</div>
        <div style={{fontSize:11,color:T.text3}}>{subtitle}</div>
      </div>
    </button>
  )
}

function crumbStyle(clickable: boolean): React.CSSProperties {
  return {
    background:'transparent',border:'none',padding:0,
    color: clickable ? T.text2 : T.text,
    fontSize:12,fontWeight: clickable ? 400 : 600,
    cursor: clickable ? 'pointer' : 'default',
    fontFamily:'inherit',
    textDecoration: clickable ? 'underline dotted' : 'none',
    textUnderlineOffset:3,
  }
}

function TagChip({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span style={{
      display:'inline-block',padding:'1px 7px',borderRadius:8,fontSize:10,
      background:`${color}18`,color,border:`1px solid ${color}30`,
      whiteSpace:'nowrap',
    }}>
      {children}
    </span>
  )
}

function FilterSelect({
  label, value, options, onChange,
}: {
  label: string
  value: string
  options: { id: string; name: string }[]
  onChange: (v: string) => void
}) {
  const active = value !== 'all'
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      title={`Filter by ${label.toLowerCase()}`}
      style={{
        background: active ? `${T.blue}20` : T.bg2,
        border:`1px solid ${active ? T.blue : T.border2}`,
        color: active ? T.blue : T.text,
        borderRadius:6,padding:'7px 10px',fontSize:12,outline:'none',fontFamily:'inherit',
        cursor:'pointer',fontWeight: active ? 600 : 400,
      }}>
      <option value="all">{label}: All</option>
      <option value="none">{label}: None</option>
      {options.map(o => (
        <option key={o.id} value={o.id}>{o.name}</option>
      ))}
    </select>
  )
}

function qtyBtnStyle(disabled?: boolean): React.CSSProperties {
  return {
    width:30,height:30,
    border:'none',background:'transparent',color: disabled ? T.text3 : T.text,
    fontSize:14,cursor: disabled ? 'not-allowed' : 'pointer',
    fontFamily:'inherit',
  }
}

function stockColorFor(state: CatalogueItem['stock']['state']): string {
  switch (state) {
    case 'in_stock':      return T.green
    case 'low_stock':     return T.amber
    case 'out_of_stock':  return T.red
  }
}

function stockLabel(s: CatalogueItem['stock']): string {
  if (!s.is_inventoried) return 'In stock'
  if (s.state === 'in_stock')     return 'In stock'
  if (s.state === 'low_stock')    return s.qty_available != null ? `Low · ${s.qty_available} left` : 'Low stock'
  return 'Out of stock'
}

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  return await requireB2BPageAuth(ctx) as any
}
