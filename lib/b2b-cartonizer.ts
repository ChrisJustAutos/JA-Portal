// lib/b2b-cartonizer.ts
// SERVER-ONLY. Packs a set of order/cart line items into shipping units
// (cartons or pallets) for a MachShip quote/booking, using the admin-configured
// standard boxes (b2b_freight_boxes) and pallet options (b2b_freight_pallets).
//
// Deterministic heuristic (NOT AI) so a freight price is reproducible:
//   1. Expand each line into individual units (qty copies).
//   2. Decide pallet vs cartons:
//        - mode 'pallet'  → always pallets
//        - mode 'cartons' → always cartons
//        - mode 'auto'    → pallets if a pallet is configured AND
//                           (any item is packaging='pallet' OR total weight
//                            exceeds freight_pallet_threshold_g); else cartons.
//   3. Pallets: the items are CARTONISED FIRST (step 4), then those cartons are
//      stacked onto pallets. Only pallets whose deck can actually take every
//      carton are considered; the pallet count is the worse of the weight bound
//      and the cube bound, so a light-but-bulky order isn't declared as one
//      pallet it physically won't fit on. A carton no pallet deck can take
//      ships loose alongside the pallets.
//   4. Cartons: first-fit-decreasing by weight into the smallest box that fits
//      the largest item; an item too big for any box ships on its own.
//        - packaging='other' means the item is ALREADY BOXED — it ships at its
//          own dimensions (one carton per unit) and is never packed into a
//          standard box, regardless of whether it would fit.
//
// Returns null when there's no usable box config (caller should fall back to
// its previous one-carton-per-line behaviour so quoting never breaks).
// All inputs are mm / grams (matching the DB); output too.

export interface PackInputItem {
  sku: string
  name: string
  qty: number
  weight_g: number | null
  length_mm: number | null
  width_mm: number | null
  height_mm: number | null
  packaging: 'box' | 'pallet' | 'other' | 'unboxed' | null
}

export interface FreightBox {
  name: string
  length_mm: number
  width_mm: number
  height_mm: number
  max_weight_g: number
}

export interface PalletSpec {
  id?: string | null
  name?: string | null
  length_mm: number | null
  width_mm: number | null
  max_height_mm: number | null
  max_weight_g: number | null
  // Order weight above which we palletise at all. A property of the ORDER, not
  // of any one pallet, so every pallet carries the same value (it comes off
  // b2b_settings) and only the first is read.
  threshold_g: number | null
}

export type PackMode = 'auto' | 'pallet' | 'cartons'

// What went into a packed unit — aggregated by SKU. Used by the pick list so
// the packer sees the exact contents of each box; MachShip ignores it.
export interface PackedContent {
  sku: string
  name: string
  qty: number
}

// A packed shipping unit in mm/grams. `quantity` is how many identical units.
export interface PackedUnit {
  itemType: 'Carton' | 'Pallet'
  name: string
  // true = the item ships in its OWN packaging at its own dims (unboxed/'other'
  // packaging, fits no configured box, or too heavy for every box) — `name` is
  // the ITEM name, not a box name. Lets the pick list label it honestly.
  ownPackaging?: boolean
  quantity: number
  weight_g: number     // per unit
  length_mm: number
  width_mm: number
  height_mm: number
  // Contents of ONE unit (for quantity>1 pallets: contents of the whole group).
  contents?: PackedContent[]
  // PALLETS ONLY: the cartons stacked on this pallet, in the order the packer
  // built them. `contents` stays the flat SKU list for this pallet so every
  // existing consumer (pick list, pack plan, admin UI) is unaffected; this adds
  // the box-level plan so the packer knows what to put in which box before it
  // goes on the deck. Empty/absent for cartons.
  boxes?: PackedBox[]
}

// One carton sitting on a pallet. Same shape as the carton PackedUnits it is
// derived from, minus the fields that only make sense at consignment level.
export interface PackedBox {
  name: string
  ownPackaging?: boolean
  weight_g: number
  length_mm: number
  width_mm: number
  height_mm: number
  contents: PackedContent[]
}

const sortedDims = (l: number, w: number, h: number) => [l, w, h].sort((a, b) => a - b)

// Aggregate individual units back into per-SKU content lines.
function aggregateContents(items: PackInputItem[]): PackedContent[] {
  const bySku = new Map<string, PackedContent>()
  for (const it of items) {
    const key = it.sku || it.name
    const cur = bySku.get(key)
    if (cur) cur.qty += 1
    else bySku.set(key, { sku: it.sku, name: it.name, qty: 1 })
  }
  return Array.from(bySku.values())
}

// Does a unit fit inside a box (compare sorted dimensions)? Missing dims → assume yes.
function fitsBox(it: PackInputItem, box: FreightBox): boolean {
  if (!it.length_mm || !it.width_mm || !it.height_mm) return true
  const a = sortedDims(it.length_mm, it.width_mm, it.height_mm)
  const b = sortedDims(box.length_mm, box.width_mm, box.height_mm)
  return a[0] <= b[0] && a[1] <= b[1] && a[2] <= b[2]
}
const boxVolume = (b: FreightBox) => b.length_mm * b.width_mm * b.height_mm

export interface PackResult {
  units: PackedUnit[]
  mode: 'pallet' | 'cartons'
  totalWeightG: number
}

// A pallet's deck sits on ~150mm of timber, so the goods only get the rest of
// the declared max height. We still DECLARE max_height_mm to the carrier (an
// under-declared pallet gets re-cubed at the depot); this is purely how much
// stack the cube bound is allowed to assume.
const PALLET_BASE_MM = 150
// You cannot hand-stack cartons to 100% of the envelope. The carton packer uses
// 0.85 inside a single box; a pallet stack is looser again, so 0.80.
const PALLET_FILL = 0.80

type Unit = { item: PackInputItem; weight_g: number }

// Can a box of these dimensions sit on this deck in ANY orientation? Tries each
// dimension as the vertical one, both ways round on the deck. A zero/missing
// dimension trivially fits (the carton packer already defaults item dims).
function fitsDeck(l: number, w: number, h: number, deckL: number, deckW: number, usableH: number): boolean {
  const dims = [l, w, h]
  for (let v = 0; v < 3; v++) {
    if (dims[v] > usableH) continue
    const f = dims.filter((_, i) => i !== v)
    if ((f[0] <= deckL && f[1] <= deckW) || (f[1] <= deckL && f[0] <= deckW)) return true
  }
  return false
}

const unitVolume = (u: PackedUnit) => u.length_mm * u.width_mm * u.height_mm

interface PalletSlot { boxes: PackedUnit[]; usedW: number; usedV: number }
interface StackPlan { pallet: PalletSpec; slots: PalletSlot[]; loose: PackedUnit[] }

/**
 * Stack already-cartonised units onto copies of ONE pallet. Cartons that no
 * orientation will put on this deck come back as `loose` — they ship beside the
 * pallets rather than disqualifying the pallet outright (MachShip takes mixed
 * Pallet + Carton items in one consignment).
 *
 * The number of slots IS the pallet count, and it falls out of the packing
 * rather than being ceil(weight/cap): a slot is capped by BOTH its weight limit
 * and its usable cube, so 2.4m3 of light parts can no longer be declared as one
 * pallet just because it sits under the weight cap.
 */
function stackOnPallet(cartons: PackedUnit[], pallet: PalletSpec): StackPlan {
  const deckL = Number(pallet.length_mm) || 0
  const deckW = Number(pallet.width_mm) || 0
  const usableH = Math.max(1, (Number(pallet.max_height_mm) || 1200) - PALLET_BASE_MM)
  const capW = Number(pallet.max_weight_g) || 0
  const capV = deckL * deckW * usableH * PALLET_FILL

  const slots: PalletSlot[] = []
  const loose: PackedUnit[] = []

  // Expand quantity>1 cartons so each physical box is placed individually.
  const singles: PackedUnit[] = []
  for (const c of cartons) {
    for (let i = 0; i < Math.max(1, c.quantity); i++) singles.push({ ...c, quantity: 1 })
  }
  // Biggest first — first-fit-decreasing, same shape as the carton packer.
  singles.sort((a, b) => unitVolume(b) - unitVolume(a))

  for (const box of singles) {
    if (!fitsDeck(box.length_mm, box.width_mm, box.height_mm, deckL, deckW, usableH)) {
      loose.push(box)
      continue
    }
    const v = unitVolume(box)
    let placed = false
    for (const slot of slots) {
      if (slot.usedW + box.weight_g <= capW && slot.usedV + v <= capV) {
        slot.usedW += box.weight_g; slot.usedV += v; slot.boxes.push(box); placed = true; break
      }
    }
    // A slot always accepts its first box, so one very large carton still
    // palletises instead of looping forever.
    if (!placed) slots.push({ boxes: [box], usedW: box.weight_g, usedV: v })
  }
  return { pallet, slots, loose }
}

/**
 * Fewest shipping units wins (pallets PLUS anything left loose); on a tie, the
 * smaller deck, because a smaller footprint is cheaper freight. Returns null
 * when no pallet is configured, which is what makes the caller use cartons.
 */
function pickStackPlan(pallets: PalletSpec[], cartons: PackedUnit[]): StackPlan | null {
  if (pallets.length === 0) return null
  const plans = pallets.map(p => stackOnPallet(cartons, p))
  plans.sort((a, b) => {
    const ua = a.slots.length + a.loose.length
    const ub = b.slots.length + b.loose.length
    const areaA = (Number(a.pallet.length_mm) || 0) * (Number(a.pallet.width_mm) || 0)
    const areaB = (Number(b.pallet.length_mm) || 0) * (Number(b.pallet.width_mm) || 0)
    return ua - ub || areaA - areaB
  })
  return plans[0]
}

/**
 * Pack expanded item units into cartons: standard boxes where they fit, own
 * packaging where they do not. Shared by the cartons path and the pallet path —
 * a palletised order is cartonised FIRST and the cartons are then stacked, so
 * the warehouse gets the same box plan either way.
 * With no boxes configured, every unit ships in its own packaging.
 */
function packCartons(units: Unit[], boxes: FreightBox[]): PackedUnit[] {
  const out: PackedUnit[] = []
  const own = (u: Unit): PackedUnit => ({
    itemType: 'Carton', name: u.item.name.slice(0, 60) || u.item.sku, ownPackaging: true, quantity: 1, weight_g: u.weight_g,
    length_mm: u.item.length_mm || 200, width_mm: u.item.width_mm || 200, height_mm: u.item.height_mm || 200,
    contents: [{ sku: u.item.sku, name: u.item.name, qty: 1 }],
  })
  if (!boxes || boxes.length === 0) return units.map(own)

  // Items that ship individually at their own dims: already-boxed items
  // (packaging='other') and unboxed/wrapped items (packaging='unboxed') always,
  // plus anything that fits no configured box.
  const shipsAlone = (u: Unit) => u.item.packaging === 'other' || u.item.packaging === 'unboxed' || !boxes.some(b => fitsBox(u.item, b))
  for (const u of units.filter(shipsAlone)) out.push(own(u))

  // Weight + VOLUME first-fit-decreasing packer. Each box (bin) is capped by its
  // max weight AND its usable volume (× FILL — you can't pack irregular parts to
  // 100%). Pack biggest items first; a new bin uses the smallest box the item
  // fits in. A bin always accepts its first item (so an item that nearly fills a
  // box still goes in); the FILL/volume check only gates ADDING more to a bin.
  const FILL = 0.85
  const itemVol = (u: { item: PackInputItem }) =>
    (u.item.length_mm || 0) * (u.item.width_mm || 0) * (u.item.height_mm || 0)

  const boxable = units.filter(u => !shipsAlone(u))
  const byVolAsc = [...boxes].sort((a, b) => boxVolume(a) - boxVolume(b))
  type Bin = { box: FreightBox; usedW: number; usedV: number; items: PackInputItem[] }
  const bins: Bin[] = []
  const desc = [...boxable].sort((a, b) => itemVol(b) - itemVol(a))
  for (const u of desc) {
    const uV = itemVol(u)
    let placed = false
    for (const bin of bins) {
      if (fitsBox(u.item, bin.box)
        && bin.usedW + u.weight_g <= bin.box.max_weight_g
        && bin.usedV + uV <= boxVolume(bin.box) * FILL) {
        bin.usedW += u.weight_g; bin.usedV += uV; bin.items.push(u.item); placed = true; break
      }
    }
    if (!placed) {
      const cand = byVolAsc.find(b => fitsBox(u.item, b) && b.max_weight_g >= u.weight_g)
      if (cand) bins.push({ box: cand, usedW: u.weight_g, usedV: uV, items: [u.item] })
      // Fits a box dimensionally but too heavy for any box's weight limit →
      // ship on its own at its own dims.
      else out.push(own(u))
    }
  }
  for (const bin of bins) {
    out.push({
      itemType: 'Carton', name: bin.box.name, quantity: 1, weight_g: Math.max(1, Math.round(bin.usedW)),
      length_mm: bin.box.length_mm, width_mm: bin.box.width_mm, height_mm: bin.box.height_mm,
      contents: aggregateContents(bin.items),
    })
  }
  return out
}

// Merge per-carton content lines into one flat per-SKU list for a pallet, so
// `contents` keeps its old meaning for every existing consumer.
function mergeBoxContents(boxes: PackedUnit[]): PackedContent[] {
  const bySku = new Map<string, PackedContent>()
  for (const b of boxes) {
    for (const cl of b.contents || []) {
      const key = cl.sku || cl.name
      const cur = bySku.get(key)
      if (cur) cur.qty += cl.qty
      else bySku.set(key, { sku: cl.sku, name: cl.name, qty: cl.qty })
    }
  }
  return Array.from(bySku.values())
}

export function packItems(
  items: PackInputItem[],
  boxes: FreightBox[],
  // One or many. More than one and we pick the one that ships the order in the
  // fewest units, breaking ties on the smaller footprint. The choice is made
  // AFTER cartonising, against the real cartons, so a deck that cannot take
  // them is never chosen.
  palletIn: PalletSpec | PalletSpec[] | null,
  opts: { mode?: PackMode; palletId?: string | null } = {},
): PackResult | null {
  // Expand to individual units.
  const units: Unit[] = []
  for (const it of items) {
    const q = Math.max(0, Math.floor(Number(it.qty) || 0))
    for (let i = 0; i < q; i++) units.push({ item: it, weight_g: Math.max(0, Number(it.weight_g) || 0) })
  }
  if (units.length === 0) return null

  const totalWeightG = units.reduce((s, u) => s + u.weight_g, 0)
  const hasPalletItem = units.some(u => u.item.packaging === 'pallet')

  const allPallets = (Array.isArray(palletIn) ? palletIn : palletIn ? [palletIn] : [])
    .filter(p => p && p.length_mm && p.width_mm && p.max_weight_g)
  // Staff can force a specific pallet from the pack plan; otherwise choose.
  const forced = opts.palletId ? allPallets.find(p => p.id === opts.palletId) : undefined
  const candidates = forced ? [forced] : allPallets
  const palletOk = candidates.length > 0
  // The threshold is an order-level setting; every row carries the same value.
  const threshold = allPallets[0]?.threshold_g != null ? Number(allPallets[0].threshold_g) : null

  const mode: PackMode = opts.mode || 'auto'
  let palletize: boolean
  if (mode === 'pallet') palletize = palletOk
  else if (mode === 'cartons') palletize = false
  else palletize = palletOk && (hasPalletItem || (threshold != null && threshold > 0 && totalWeightG > threshold))

  // ── Pallets: cartonise first, then stack those cartons on the deck ──
  if (palletize) {
    const cartons = packCartons(units, boxes)
    const plan = pickStackPlan(candidates, cartons)
    if (plan && plan.slots.length > 0) {
      const p = plan.pallet
      const out: PackedUnit[] = plan.slots.map(slot => ({
        itemType: 'Pallet' as const,
        name: p.name || 'Pallet',
        quantity: 1,
        // The real weight of what is on THIS pallet, not an even share.
        weight_g: Math.max(1, Math.round(slot.usedW)),
        length_mm: Number(p.length_mm),
        width_mm: Number(p.width_mm),
        height_mm: Number(p.max_height_mm || 1200),
        contents: mergeBoxContents(slot.boxes),
        boxes: slot.boxes.map(b => ({
          name: b.name, ownPackaging: b.ownPackaging === true, weight_g: b.weight_g,
          length_mm: b.length_mm, width_mm: b.width_mm, height_mm: b.height_mm,
          contents: b.contents || [],
        })),
      }))
      // Anything no deck would take travels beside the pallets as its own item.
      for (const l of plan.loose) out.push(l)
      return { mode: 'pallet', totalWeightG, units: out }
    }
    // Nothing stackable at all → fall through to cartons.
  }

  // ── Cartons ──
  if (!boxes || boxes.length === 0) return null  // no config → signal fallback
  const out = packCartons(units, boxes)
  if (out.length === 0) return null
  return { units: out, mode: 'cartons', totalWeightG }
}
