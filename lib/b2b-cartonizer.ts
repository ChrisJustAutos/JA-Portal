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
//      stacked onto pallets in LAYERS (tallest carton sets each layer's height,
//      footprints fill the deck to AREA_FILL). A pallet is full when the stack
//      reaches its usable height or its weight cap, so a light-but-bulky order
//      is no longer declared as one pallet it won't fit on. The SAME layer
//      model gives the height we declare to the carrier, so a pallet is never
//      accepted on one measure and billed on another. A carton no deck can take
//      in any orientation ships loose alongside the pallets.
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

// A pallet's deck sits on ~150mm of timber, which is part of the height the
// carrier measures but none of the height the goods get.
const PALLET_BASE_MM = 150
// You cannot tile a deck to its last square millimetre, so each layer of a
// stack only gets this much of the deck area.
const AREA_FILL = 0.85

type Unit = { item: PackInputItem; weight_g: number }

// How a carton sits on the deck: `h` is its vertical dimension, `area` the
// footprint it occupies. NATURAL ORIENTATION FIRST (length × width down, height
// up) because cartons have a this-way-up; we only lie one on its side when
// upright will not fit. Returns null when no orientation works at all, which is
// what makes the carton ship loose beside the pallets.
function chooseOrientation(
  l: number, w: number, h: number, deckL: number, deckW: number, usableH: number,
): { h: number; area: number } | null {
  const onDeck = (a: number, b: number) => (a <= deckL && b <= deckW) || (b <= deckL && a <= deckW)
  // Natural first, then the two tip-overs, in increasing disruption.
  const tries: Array<[number, number, number]> = [[l, w, h], [l, h, w], [h, w, l]]
  for (const [a, b, v] of tries) {
    if (v <= usableH && onDeck(a, b)) return { h: v, area: a * b }
  }
  return null
}

// ONE geometric predicate: a carton fits a deck exactly when some orientation
// does. Derived from chooseOrientation so the two can never disagree — if this
// says yes, the layer builder below is guaranteed an orientation to use.
function fitsDeck(l: number, w: number, h: number, deckL: number, deckW: number, usableH: number): boolean {
  return chooseOrientation(l, w, h, deckL, deckW, usableH) !== null
}

/**
 * How tall this set of cartons actually stacks on this deck, in mm, excluding
 * the pallet base. Builds layers: the tallest remaining carton sets the layer
 * height, then cartons are added to that layer while their footprints fit the
 * usable deck area. A layer always accepts its first carton, so a footprint
 * larger than deck × AREA_FILL still gets a layer of its own rather than
 * looping.
 *
 * This is a layer model, not a full 3D pack — layers do not interlock and a
 * short carton in a tall layer wastes the difference. That is deliberate: it
 * is deterministic, and it errs toward MORE height rather than less, which is
 * the safe direction when the number is what the carrier bills.
 */
function stackHeightMm(cartons: PackedUnit[], deckL: number, deckW: number, usableH: number): number {
  const oriented: Array<{ h: number; area: number }> = []
  for (const c of cartons) {
    const o = chooseOrientation(c.length_mm, c.width_mm, c.height_mm, deckL, deckW, usableH)
    if (o) oriented.push(o)
  }
  // Tallest first, so each layer's height is set by its tallest member.
  oriented.sort((a, b) => b.h - a.h)

  const areaCap = deckL * deckW * AREA_FILL
  let total = 0
  let remaining = oriented
  while (remaining.length > 0) {
    const layerH = remaining[0].h
    let used = 0
    const spill: Array<{ h: number; area: number }> = []
    for (const o of remaining) {
      if (used === 0 || used + o.area <= areaCap) used += o.area
      else spill.push(o)
    }
    total += layerH
    remaining = spill
  }
  return total
}

const unitVolume = (u: PackedUnit) => u.length_mm * u.width_mm * u.height_mm

interface PalletSlot { boxes: PackedUnit[]; usedW: number; stackH: number }
interface StackPlan { pallet: PalletSpec; slots: PalletSlot[]; loose: PackedUnit[] }

/**
 * Stack already-cartonised units onto copies of ONE pallet. Cartons that no
 * orientation will put on this deck come back as `loose` — they ship beside the
 * pallets rather than disqualifying the pallet outright (MachShip takes mixed
 * Pallet + Carton items in one consignment).
 *
 * The number of slots IS the pallet count, and it falls out of the packing
 * rather than being ceil(weight/cap): a slot is capped by BOTH its weight limit
 * and the height its cartons actually stack to. Capacity and the height we
 * later DECLARE come from the same layer model on purpose — a slot accepted by
 * one measure and declared by another is exactly how a pallet ends up
 * overflowing the height it was quoted at.
 */
function stackOnPallet(cartons: PackedUnit[], pallet: PalletSpec): StackPlan {
  const deckL = Number(pallet.length_mm) || 0
  const deckW = Number(pallet.width_mm) || 0
  const usableH = Math.max(1, (Number(pallet.max_height_mm) || 1200) - PALLET_BASE_MM)
  const capW = Number(pallet.max_weight_g) || 0

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
    let placed = false
    for (const slot of slots) {
      if (slot.usedW + box.weight_g > capW) continue
      const h = stackHeightMm([...slot.boxes, box], deckL, deckW, usableH)
      if (h <= usableH) {
        slot.usedW += box.weight_g; slot.stackH = h; slot.boxes.push(box); placed = true; break
      }
    }
    // A slot always accepts its first box (fitsDeck already proved it will go
    // on the deck), so one very large carton still palletises.
    if (!placed) {
      slots.push({
        boxes: [box], usedW: box.weight_g,
        stackH: stackHeightMm([box], deckL, deckW, usableH),
      })
    }
  }
  return { pallet, slots: balanceSlots(slots, deckL, deckW, usableH, capW), loose }
}

/**
 * Spread the cartons more evenly across the pallets FFD already decided on.
 *
 * FFD fills pallet 1 to its height limit and dumps the remainder on pallet 2,
 * which is why Hunter's order came out 258.5 kg / 1320 mm against 30.5 kg /
 * 450 mm. Because deck area is fixed, declared cube is proportional to the SUM
 * of the stack heights, and two evener stacks quantise into fewer wasted layers
 * than one full and one nearly empty — so balancing is usually cheaper freight
 * as well as a more sensible thing to hand the warehouse.
 *
 * Longest-processing-time first: biggest carton to the shortest stack that will
 * take it. The slot COUNT is never allowed to grow — that is FFD's decision and
 * re-deciding it here would let a cheaper-looking balance add a pallet. If any
 * carton cannot be placed within those slots (layer packing is order-dependent,
 * so this is possible), the original FFD layout is kept untouched.
 */
function balanceSlots(
  slots: PalletSlot[], deckL: number, deckW: number, usableH: number, capW: number,
): PalletSlot[] {
  if (slots.length < 2) return slots   // nothing to balance

  const all = slots.flatMap(s => s.boxes)
  const fresh: PalletSlot[] = slots.map(() => ({ boxes: [], usedW: 0, stackH: 0 }))
  // Biggest first, so the awkward items are placed while every slot is empty.
  const desc = [...all].sort((a, b) => unitVolume(b) - unitVolume(a))

  for (const box of desc) {
    // Shortest stack first, then lightest, so weight evens out on ties (a
    // 1470mm/259kg + 600mm/31kg split is legal but nobody wants to lift it).
    const order = fresh
      .map((slot, i) => ({ slot, i }))
      .sort((a, b) => a.slot.stackH - b.slot.stackH || a.slot.usedW - b.slot.usedW)
    let placed = false
    for (const { slot } of order) {
      if (slot.usedW + box.weight_g > capW) continue
      const h = stackHeightMm([...slot.boxes, box], deckL, deckW, usableH)
      if (h <= usableH) {
        slot.boxes.push(box); slot.usedW += box.weight_g; slot.stackH = h; placed = true; break
      }
    }
    if (!placed) return slots          // balance failed — FFD's layout stands
  }
  // An empty slot would mean FFD over-counted; keep its result rather than
  // silently shipping fewer pallets than were quoted geometrically.
  if (fresh.some(s => s.boxes.length === 0)) return slots

  const before = slots.reduce((n, s) => n + s.stackH, 0)
  const after  = fresh.reduce((n, s) => n + s.stackH, 0)
  return after <= before ? fresh : slots
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
 * The height to DECLARE for a loaded pallet: the timber base plus what the
 * cartons actually stack to, rounded UP to the next centimetre (MachShip takes
 * cm) and never above the pallet's configured maximum. Reporting the maximum
 * regardless — which is what this did until 2026-08-27 — overcharges every
 * order that does not fill the deck, because cube is what the carrier bills.
 */
function declaredPalletHeightMm(stackH: number, maxHeightMm: number): number {
  const rounded = Math.ceil((PALLET_BASE_MM + Math.max(0, stackH)) / 10) * 10
  return Math.min(maxHeightMm, Math.max(PALLET_BASE_MM, rounded))
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

// Turn a stacking plan into shipping units: one Pallet per slot, carrying its
// real weight, the height it actually stands at and the boxes on its deck, plus
// any carton no deck would take travelling beside them as its own item.
function palletUnitsFrom(plan: StackPlan): PackedUnit[] {
  const p = plan.pallet
  const out: PackedUnit[] = plan.slots.map(slot => ({
    itemType: 'Pallet' as const,
    name: p.name || 'Pallet',
    quantity: 1,
    // The real weight of what is on THIS pallet, not an even share.
    weight_g: Math.max(1, Math.round(slot.usedW)),
    length_mm: Number(p.length_mm),
    width_mm: Number(p.width_mm),
    // The height it actually stands at, not the pallet's ceiling.
    height_mm: declaredPalletHeightMm(slot.stackH, Number(p.max_height_mm || 1200)),
    contents: mergeBoxContents(slot.boxes),
    boxes: slot.boxes.map(b => ({
      name: b.name, ownPackaging: b.ownPackaging === true, weight_g: b.weight_g,
      length_mm: b.length_mm, width_mm: b.width_mm, height_mm: b.height_mm,
      contents: b.contents || [],
    })),
  }))
  for (const l of plan.loose) out.push(l)
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
      return { mode: 'pallet', totalWeightG, units: palletUnitsFrom(plan) }
    }
    // Nothing stackable at all → fall through to cartons.
  }

  // ── Cartons ──
  if (!boxes || boxes.length === 0) return null  // no config → signal fallback
  const out = packCartons(units, boxes)
  if (out.length === 0) return null
  return { units: out, mode: 'cartons', totalWeightG }
}

// ── Candidate plans ────────────────────────────────────────────────
// One order can be shipped several legitimate ways, and which is CHEAPEST is a
// question only the carrier can answer — a 36-parcel consignment can beat two
// pallets, and palletising just the bulky items while the neat boxes travel as
// parcels can beat both. Geometry cannot decide it, so the packer stops trying:
// it hands the quoter every sensible plan and the quoter prices them all.
//
// Deliberately a SMALL fixed set. Each candidate is one extra MachShip routes
// call on every quote, so this is not the place for a search space.

export type PackCandidateKey = 'pallet' | 'hybrid' | 'cartons'

export interface PackCandidate {
  key: PackCandidateKey
  label: string
  result: PackResult
}

/**
 * Palletise only what wants a pallet, and let the standard boxes travel as
 * parcels. "Wants a pallet" = a carton in its own packaging (too big or too
 * heavy for any configured box, or flagged unboxed/already-boxed) plus anything
 * whose catalogue packaging is 'pallet'. Returns null when that split is
 * degenerate — nothing to palletise, or nothing left over — because then it is
 * just the all-pallet or all-cartons candidate under a different name.
 */
function packHybrid(units: Unit[], boxes: FreightBox[], pallets: PalletSpec[]): PackResult | null {
  const mustPalletise = new Set(
    units.filter(u => u.item.packaging === 'pallet').map(u => u.item.sku || u.item.name),
  )
  const cartons = packCartons(units, boxes)
  const onDeck: PackedUnit[] = []
  const asParcels: PackedUnit[] = []
  for (const c of cartons) {
    const forced = (c.contents || []).some(cl => mustPalletise.has(cl.sku || cl.name))
    if (c.ownPackaging === true || forced) onDeck.push(c)
    else asParcels.push(c)
  }
  if (onDeck.length === 0 || asParcels.length === 0) return null

  const plan = pickStackPlan(pallets, onDeck)
  if (!plan || plan.slots.length === 0) return null

  const totalWeightG = units.reduce((s, u) => s + u.weight_g, 0)
  return {
    mode: 'pallet',
    totalWeightG,
    units: [...palletUnitsFrom(plan), ...asParcels],
  }
}

/**
 * Every plan worth pricing for this order, cheapest-looking first is NOT
 * implied — the caller prices them. An explicit pack mode short-circuits the
 * whole thing: if staff have said "cartons", we do not quietly quote pallets.
 */
export function packCandidates(
  items: PackInputItem[],
  boxes: FreightBox[],
  palletIn: PalletSpec | PalletSpec[] | null,
  opts: { mode?: PackMode; palletId?: string | null } = {},
): PackCandidate[] {
  const mode: PackMode = opts.mode || 'auto'
  const base = packItems(items, boxes, palletIn, opts)
  if (!base) return []
  // Staff forced a mode, or the order was never going to palletise — one plan.
  if (mode !== 'auto' || base.mode !== 'pallet') {
    return [{ key: base.mode === 'pallet' ? 'pallet' : 'cartons', label: base.mode === 'pallet' ? 'Pallets' : 'Cartons', result: base }]
  }

  const out: PackCandidate[] = [{ key: 'pallet', label: 'Pallets', result: base }]

  const units: Unit[] = []
  for (const it of items) {
    const q = Math.max(0, Math.floor(Number(it.qty) || 0))
    for (let i = 0; i < q; i++) units.push({ item: it, weight_g: Math.max(0, Number(it.weight_g) || 0) })
  }
  const pallets = (Array.isArray(palletIn) ? palletIn : palletIn ? [palletIn] : [])
    .filter(p => p && p.length_mm && p.width_mm && p.max_weight_g)

  const hybrid = packHybrid(units, boxes, pallets)
  if (hybrid) out.push({ key: 'hybrid', label: 'Bulky items on a pallet, boxes as parcels', result: hybrid })

  // All-cartons is only offered when nothing MUST go on a pallet.
  const hasPalletItem = units.some(u => u.item.packaging === 'pallet')
  if (!hasPalletItem) {
    const cartons = packItems(items, boxes, palletIn, { ...opts, mode: 'cartons' })
    if (cartons) out.push({ key: 'cartons', label: 'All cartons, no pallet', result: cartons })
  }
  return out
}
