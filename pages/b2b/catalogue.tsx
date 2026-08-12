// pages/b2b/catalogue.tsx
//
// Distributor-facing catalogue browse page. Card grid with image, name,
// trade price (ex GST), stock indicator, and add-to-cart controls.
//
// Search is client-side over name/SKU. Stock comes from the API which
// pulls live (5-min cached) MYOB QuantityAvailable.
//
// Look: Alloy kit (components/b2b/ui) — calm cards, one accent, fitment as a
// sentence instead of a chip wall, promo as a single flag on the image.

import { useEffect, useMemo, useState } from 'react'
import Head from 'next/head'
import type { GetServerSideProps } from 'next'
import B2BLayout from '../../components/b2b/B2BLayout'
import { requireB2BPageAuth } from '../../lib/b2bAuthServer'
import { useToast } from '../../components/ui/Feedback'
import { SkeletonRows } from '../../components/ui'
import { T, alpha } from '../../lib/ui/theme'
import { A, RADIUS, SHADOW, Btn, Banner, Card, DotLine, EmptyState, PageTitle, Stepper } from '../../components/b2b/ui'

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

interface VolumeBreak {
  min_qty: number
  unit_price_ex_gst: number
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
  models?: TaxonomyRef[]
  product_type: TaxonomyRef | null
  unit_price_ex_gst: number
  promo_active: boolean
  has_volume_breaks: boolean
  volume_breaks: VolumeBreak[]
  is_special_order: boolean
  is_drop_ship: boolean
  instructions_url: string | null
  instructions_url_2: string | null
  max_order_qty: number | null
  stock: {
    state: 'in_stock' | 'low_stock' | 'out_of_stock'
    qty_available: number | null
    is_inventoried: boolean
    call_for_availability: boolean
  }
}

type GroupBy = 'none' | 'model' | 'product_type'
type TileStep = 'model' | 'type' | 'browse'

interface CartLine {
  id: string
  catalogue_id: string | null
  qty: number
}

export default function B2BCataloguePage({ b2bUser }: Props) {
  const toast = useToast()
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

  // A product can fit multiple models. Use the models[] array (fall back to the
  // single primary model for safety if the array is absent).
  const modelsOf = (i: CatalogueItem): TaxonomyRef[] =>
    (i.models && i.models.length ? i.models : (i.model ? [i.model] : []))

  // Build option lists from the loaded items (de-duped, sorted)
  const modelOptions = useMemo(() => {
    const m = new Map<string, string>()
    for (const it of items) for (const md of modelsOf(it)) m.set(md.id, md.name)
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
    if (modelFilter === 'none') return items.filter(i => modelsOf(i).length === 0)
    return items.filter(i => modelsOf(i).some(m => m.id === modelFilter))
  }, [items, modelFilter])

  // Tile data for the model step
  const modelTiles = useMemo(() => modelOptions.map(o => ({
    id: o.id,
    name: o.name,
    count: items.filter(i => modelsOf(i).some(m => m.id === o.id)).length,
  })), [modelOptions, items])
  const noModelCount = useMemo(() => items.filter(i => modelsOf(i).length === 0).length, [items])

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
      const ms = modelsOf(i)
      if (modelFilter === 'none' && ms.length > 0) return false
      if (modelFilter !== 'all' && modelFilter !== 'none' && !ms.some(m => m.id === modelFilter)) return false
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
    const push = (key: string, label: string, it: CatalogueItem) => {
      if (!groups.has(key)) groups.set(key, { key, label, items: [] })
      groups.get(key)!.items.push(it)
    }
    for (const it of filtered) {
      if (groupBy === 'model') {
        const ms = modelsOf(it)
        if (ms.length === 0) push(UNCAT, 'Other models', it)
        else for (const md of ms) push(md.id, md.name, it)  // appears under each model it fits
      } else {
        const ref = it.product_type
        push(ref?.id || UNCAT, ref?.name || 'Other', it)
      }
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
      toast(e?.message || 'Could not update cart', 'error')
    }
  }

  return (
    <>
      <Head><title>Shop · Just Autos B2B</title></Head>
      <B2BLayout user={b2bUser} active="catalogue" cartCount={cartItemCount}>

        <PageTitle
          sub={
            tileStep === 'model'  ? 'Choose a model to begin. Pricing is inc GST.'
            : tileStep === 'type' ? `Choose a product type within ${modelLabel}.`
            : (
              // Breadcrumb on the browse step
              <span style={{display:'inline-flex',alignItems:'center',gap:8,flexWrap:'wrap'}}>
                <button onClick={backToModelStep} style={crumbStyle(true)}>Models</button>
                <span>›</span>
                <button onClick={backToTypeStep} style={crumbStyle(true)}>{modelLabel}</button>
                <span>›</span>
                <span style={crumbStyle(false)}>{typeLabel}</span>
              </span>
            )
          }
          action={
            tileStep !== 'model' ? (
              <Btn variant="ghost" size="sm" onClick={backToModelStep}>
                ‹ {tileStep === 'browse' ? 'Start over' : 'Choose different model'}
              </Btn>
            ) : undefined
          }>
          Shop
        </PageTitle>

        {error && <div style={{marginBottom:14}}><Banner tone="error">{error}</Banner></div>}

        {stockError && (
          <div style={{marginBottom:14}}>
            <Banner tone="warn">Live stock is unavailable right now ({stockError}). You can still browse, but stock indicators may be out of date.</Banner>
          </div>
        )}

        {/* Loading shell while items haven't arrived yet */}
        {loading && items.length === 0 && (
          <Card pad={false}><SkeletonRows rows={8}/></Card>
        )}

        {/* No products at all */}
        {!loading && items.length === 0 && (
          <EmptyState title="No products available yet" sub="Check back soon."/>
        )}

        {/* ─── Step: Model ─────────────────────────────────────────────── */}
        {tileStep === 'model' && items.length > 0 && (
          <div style={tileGrid()}>
            <Tile name="View all models" subtitle={`${items.length} item${items.length===1?'':'s'}`} onClick={() => { setModelFilter('all'); setProductTypeFilter('all'); setTileStep('browse') }} />
            {modelTiles.map(m => (
              <Tile key={m.id} name={m.name} subtitle={`${m.count} item${m.count===1?'':'s'}`} icon={taxonomyIcon('models', m.name)} onClick={() => pickModel(m.id)} />
            ))}
            {noModelCount > 0 && (
              <Tile name="Other" subtitle={`${noModelCount} item${noModelCount===1?'':'s'}`} onClick={() => pickModel('none')} />
            )}
          </div>
        )}

        {/* ─── Step: Type ──────────────────────────────────────────────── */}
        {tileStep === 'type' && items.length > 0 && (
          <div style={tileGrid()}>
            <Tile name={`All types in ${modelLabel}`} subtitle={`${itemsAfterModel.length} item${itemsAfterModel.length===1?'':'s'}`} onClick={() => pickType('all')} />
            {typeTiles.map(t => (
              <Tile key={t.id} name={t.name} subtitle={`${t.count} item${t.count===1?'':'s'}`} icon={taxonomyIcon('types', t.name)} onClick={() => pickType(t.id)} />
            ))}
            {noTypeCount > 0 && (
              <Tile name="Other" subtitle={`${noTypeCount} item${noTypeCount===1?'':'s'}`} onClick={() => pickType('none')} />
            )}
          </div>
        )}

        {/* ─── Step: Browse ────────────────────────────────────────────── */}
        {tileStep === 'browse' && items.length > 0 && (
          <>
            {/* Toolbar */}
            <div style={{display:'flex',gap:10,alignItems:'center',flexWrap:'wrap',marginBottom:16}}>
              <input
                type="text"
                placeholder="Search name or SKU"
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="al-focus"
                style={{
                  flex:'1 1 200px',maxWidth:340,minHeight:44,boxSizing:'border-box',
                  background:T.bg2,border:`1px solid ${T.border}`,color:T.text,
                  borderRadius:RADIUS.pill,padding:'10px 18px',fontSize:16,outline:'none',fontFamily:'inherit',
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
              <select
                value={groupBy}
                onChange={e => setGroupBy(e.target.value as GroupBy)}
                title="Group results"
                className="al-focus"
                style={selectStyle(groupBy !== 'none')}>
                <option value="none">No grouping</option>
                <option value="model">Group by model</option>
                <option value="product_type">Group by type</option>
              </select>
              <Btn variant="ghost" size="sm" onClick={loadAll} disabled={loading} title="Reload catalogue and stock">
                {loading ? 'Loading…' : 'Reload'}
              </Btn>
            </div>

            {!loading && filtered.length === 0 && (
              <EmptyState title="No products match your search"/>
            )}

            {/* Card grid (flat or grouped) */}
            {grouped ? (
              <div style={{display:'flex',flexDirection:'column',gap:28}}>
                {grouped.map(g => (
                  <section key={g.key}>
                    <h2 style={{
                      fontSize:15,fontWeight:650,margin:'0 0 12px',color:T.text,letterSpacing:'-0.01em',
                      display:'flex',justifyContent:'space-between',alignItems:'baseline',gap:8,
                    }}>
                      <span>{g.label}</span>
                      <span style={{fontSize:12.5,color:T.text3,fontWeight:400}}>
                        {g.items.length} item{g.items.length === 1 ? '' : 's'}
                      </span>
                    </h2>
                    <div style={cardGrid()}>
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
              <div style={cardGrid()}>
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

function tileGrid(): React.CSSProperties {
  return {
    display:'grid',
    gridTemplateColumns:'repeat(auto-fill, minmax(min(50% - 8px, 220px), 1fr))',
    gap:16,
  }
}

function cardGrid(): React.CSSProperties {
  return {
    display:'grid',
    gridTemplateColumns:'repeat(auto-fill, minmax(min(50% - 8px, 240px), 1fr))',
    gap:16,
  }
}

// ─── Card ───────────────────────────────────────────────────────────────
function CatalogueCard({
  item, qtyInCart, onSetQty,
}: {
  item: CatalogueItem
  qtyInCart: number
  onSetQty: (qty: number) => void
}) {
  const dropShipNoStock = item.is_drop_ship && item.stock.state === 'out_of_stock'
  // Drop-ship items ship from the supplier — OUR stock level is irrelevant,
  // so they're always addable (SSMKTY0108 test order, Chris 2026-08-06).
  const canAdd = item.is_drop_ship
    ? true
    : item.stock.call_for_availability
    ? false  // route through "Call for availability" instead of cart
    : item.stock.state !== 'out_of_stock'
  // Stepper cap: drop-ship = max-order-qty only; otherwise prefer available
  // stock, then per-item max-order-qty.
  const stepperMax: number | undefined = (() => {
    if (item.is_drop_ship) return item.max_order_qty ?? undefined
    if (!item.stock.is_inventoried) return item.max_order_qty ?? undefined
    const avail = item.stock.qty_available
    if (avail == null) return item.max_order_qty ?? undefined
    return item.max_order_qty != null ? Math.min(avail, item.max_order_qty) : avail
  })()

  const models = item.models && item.models.length ? item.models : (item.model ? [item.model] : [])
  const priceInc = incGst(item.unit_price_ex_gst, item.is_taxable)
  const wasInc   = incGst(item.trade_price_ex_gst, item.is_taxable)
  const promo    = item.promo_active && item.unit_price_ex_gst < item.trade_price_ex_gst
  const savePct  = promo ? Math.round((1 - item.unit_price_ex_gst / item.trade_price_ex_gst) * 100) : 0
  const pdfs     = [item.instructions_url, item.instructions_url_2].filter(Boolean) as string[]

  // Quiet exceptions line — only what's true, as words, not chips.
  const notes: string[] = []
  if (item.is_special_order) notes.push('Special order')
  if (item.is_drop_ship && !dropShipNoStock) notes.push('Ships from the supplier')
  if (item.has_volume_breaks && item.volume_breaks.length > 0) notes.push(`Volume pricing from ${Math.min(...item.volume_breaks.map(b => b.min_qty))}+`)

  return (
    <div className="al-raise" style={{
      background:T.bg2, border:`1px solid ${T.border}`, borderRadius:RADIUS.md,
      boxShadow:SHADOW.sm,
      display:'flex', flexDirection:'column', overflow:'hidden',
    }}>
      {/* Image */}
      <div style={{
        width:'100%', aspectRatio:'1 / 1',
        background:'#fff', position:'relative',
        display:'flex', alignItems:'center', justifyContent:'center',
      }}>
        {item.primary_image_url ? (
          <img src={item.primary_image_url} alt={item.name}
            style={{maxWidth:'100%',maxHeight:'100%',objectFit:'contain'}}
            onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
          />
        ) : (
          <span style={{fontSize:12,color:'#a7adb8'}}>No photo yet</span>
        )}
        {promo && (
          <span style={{
            position:'absolute', top:10, left:10,
            fontSize:11.5, fontWeight:650, padding:'4px 10px', borderRadius:RADIUS.pill,
            background:A.good, color:'#fff', letterSpacing:'0.01em',
          }}>
            {savePct >= 1 ? `Save ${savePct}%` : 'Promo'}
          </span>
        )}
      </div>

      {/* Body */}
      <div style={{padding:'13px 15px 15px',display:'flex',flexDirection:'column',gap:7,flex:1}}>
        <div style={{fontSize:15,color:T.text,fontWeight:600,lineHeight:1.3,letterSpacing:'-0.005em',minHeight:39}}>{item.name}</div>

        <div style={{fontSize:12.5,color:T.text3,display:'flex',gap:6,flexWrap:'wrap',alignItems:'baseline'}}>
          <span style={{fontVariantNumeric:'tabular-nums'}}>{item.sku}</span>
          {models.length > 0 && <span>· Fits {models.map(m => m.name).join(' · ')}</span>}
        </div>

        <StockLine item={item} dropShipNoStock={dropShipNoStock}/>

        {(notes.length > 0 || pdfs.length > 0) && (
          <div style={{fontSize:12,color:T.text3,display:'flex',gap:6,flexWrap:'wrap',alignItems:'baseline'}}>
            {notes.length > 0 && <span>{notes.join(' · ')}</span>}
            {pdfs.map((url, i) => (
              <a key={i} href={url} target="_blank" rel="noopener noreferrer"
                style={{color:A.accent,textDecoration:'none',fontWeight:550}}>
                Fitting guide{pdfs.length > 1 ? ` ${i + 1}` : ''} (PDF)
              </a>
            ))}
          </div>
        )}

        {/* Price */}
        <div style={{display:'flex',alignItems:'baseline',gap:8,marginTop:'auto',paddingTop:4,flexWrap:'wrap'}}>
          <span style={{fontSize:19,color:T.text,fontWeight:650,letterSpacing:'-0.02em',fontVariantNumeric:'tabular-nums'}}>
            ${priceInc.toFixed(2)}
          </span>
          {promo && (
            <span style={{fontSize:12.5,color:T.text3,textDecoration:'line-through',fontVariantNumeric:'tabular-nums'}}>
              ${wasInc.toFixed(2)}
            </span>
          )}
          <span style={{fontSize:12,color:T.text3}}>inc GST</span>
        </div>

        {/* Add to cart / qty stepper */}
        <div style={{marginTop:6}}>
          {item.stock.call_for_availability ? (
            <a
              href={`mailto:orders@justautoswholesale.com?subject=${encodeURIComponent('Availability enquiry — ' + item.sku)}&body=${encodeURIComponent('Hi,\n\nCould you let me know availability and lead time for ' + item.name + ' (SKU ' + item.sku + ')?\n\nThanks')}`}
              className="al-press"
              style={{
                display:'flex',alignItems:'center',justifyContent:'center',
                width:'100%',minHeight:44,padding:'10px 14px',borderRadius:RADIUS.pill,
                border:`1px solid ${alpha(A.warn, '66')}`,background:alpha(A.warn, '14'),color:A.warn,
                fontSize:14,fontWeight:600,fontFamily:'inherit',
                textDecoration:'none',boxSizing:'border-box',
              }}>
              Call for availability
            </a>
          ) : qtyInCart > 0 ? (
            <div style={{display:'flex',justifyContent:'center'}}>
              <Stepper qty={qtyInCart} max={stepperMax ?? null} onChange={onSetQty}/>
            </div>
          ) : (
            <Btn full disabled={!canAdd} onClick={() => onSetQty(1)}>
              {canAdd ? 'Add to Cart' : 'Out of stock'}
            </Btn>
          )}
        </div>
      </div>
    </div>
  )
}

// Stock as a dot + plain sentence (the design retires tinted stock chips).
function StockLine({ item, dropShipNoStock }: { item: CatalogueItem; dropShipNoStock: boolean }) {
  if (dropShipNoStock)                  return <DotLine color={T.text3} halo={false}>Ships from supplier</DotLine>
  if (item.stock.call_for_availability) return <DotLine color={A.warn}>Call for availability</DotLine>
  if (!item.stock.is_inventoried)       return <DotLine color={A.good}>In stock</DotLine>
  if (item.stock.state === 'in_stock')  return <DotLine color={A.good}>In stock</DotLine>
  if (item.stock.state === 'low_stock') {
    return <DotLine color={A.warn}>{item.stock.qty_available != null ? `Only ${item.stock.qty_available} left` : 'Low stock'}</DotLine>
  }
  return <DotLine color={A.bad}>Out of stock</DotLine>
}

// Category icons live in /public/icons/b2b/{models,types}/<slug>.svg. The DB
// model names are MYOB codes, so map the ones we have friendly art for; anything
// else falls back to a slug of the name, then to the generic placeholder.
const PLACEHOLDER_ICON = '/icons/b2b/placeholder.svg'
const MODEL_ICON_SLUG: Record<string, string> = {
  'VDJ200': '200-series',
  'VDJ70*': '79-series', 'GDJ70*': '79-series',
  'FJA300': '300-series',
  'GDJ250': '250-series',
  'GUN126r': 'hilux',
  'OTHER': 'other',
}
const TYPE_ICON_SLUG: Record<string, string> = {
  'Air Box': 'airbox', 'Cooling': 'cooling', 'Exhaust': 'exhaust', 'Induction': 'induction', 'Other': 'other',
}
function slugifyName(s: string): string { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') }
function taxonomyIcon(kind: 'models' | 'types', name: string): string {
  const map = kind === 'models' ? MODEL_ICON_SLUG : TYPE_ICON_SLUG
  return `/icons/b2b/${kind}/${map[name] || slugifyName(name)}.svg`
}

// Neutral tile — the rainbow accent stripes are gone; the icon and label
// carry it, hover does the inviting.
function Tile({
  name, subtitle, icon, onClick,
}: {
  name: string
  subtitle: string
  icon?: string
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className="al-raise al-focus"
      style={{
        background:T.bg2, border:`1px solid ${T.border}`, borderRadius:RADIUS.md,
        boxShadow:SHADOW.sm,
        padding:'20px 20px 18px',
        display:'flex', flexDirection:'column', gap:6, minHeight:112, justifyContent:'center',
        cursor:'pointer', fontFamily:'inherit', color:T.text,
        textAlign:'left',
      }}>
      {icon && (
        <img src={icon} alt="" width={40} height={40} loading="lazy"
          onError={e => { const t = e.currentTarget; if (t.dataset.fb !== '1') { t.dataset.fb = '1'; t.src = PLACEHOLDER_ICON } else { t.style.display = 'none' } }}
          style={{display:'block',marginBottom:4,opacity:0.92}}/>
      )}
      <div style={{fontSize:15,fontWeight:600,color:T.text,lineHeight:1.25,letterSpacing:'-0.005em'}}>{name}</div>
      <div style={{fontSize:12.5,color:T.text3}}>{subtitle}</div>
    </button>
  )
}

// GST-inclusive display price. Portal shows prices inc GST; taxable items get
// +10%, non-taxable (FRE) items are shown as-is.
function incGst(ex: number, taxable: boolean): number {
  return taxable ? Math.round(ex * 1.10 * 100) / 100 : ex
}

function crumbStyle(clickable: boolean): React.CSSProperties {
  return {
    background:'transparent',border:'none',padding:0,
    color: clickable ? T.text2 : T.text,
    fontSize:13,fontWeight: clickable ? 450 : 600,
    cursor: clickable ? 'pointer' : 'default',
    fontFamily:'inherit',
    textDecoration: clickable ? 'underline dotted' : 'none',
    textUnderlineOffset:3,
  }
}

function selectStyle(active: boolean): React.CSSProperties {
  return {
    background: active ? alpha(A.accent, '1c') : T.bg2,
    border:`1px solid ${active ? alpha(A.accent, '66') : T.border}`,
    color: active ? A.accent : T.text,
    borderRadius:RADIUS.pill,padding:'9px 14px',minHeight:44,fontSize:13,outline:'none',fontFamily:'inherit',
    cursor:'pointer',fontWeight: active ? 600 : 450,
  }
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
      className="al-focus"
      style={selectStyle(active)}>
      <option value="all">{label}: All</option>
      <option value="none">{label}: None</option>
      {options.map(o => (
        <option key={o.id} value={o.id}>{o.name}</option>
      ))}
    </select>
  )
}

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  return await requireB2BPageAuth(ctx) as any
}
