// lib/b2b-cartonizer.ts
// SERVER-ONLY. Packs a set of order/cart line items into shipping units
// (cartons or pallets) for a MachShip quote/booking, using the admin-configured
// standard boxes (b2b_freight_boxes) and pallet spec (b2b_settings.freight_pallet_*).
//
// Deterministic heuristic (NOT AI) so a freight price is reproducible:
//   1. Expand each line into individual units (qty copies).
//   2. Decide pallet vs cartons:
//        - mode 'pallet'  → always pallets
//        - mode 'cartons' → always cartons
//        - mode 'auto'    → pallets if a pallet is configured AND
//                           (any item is packaging='pallet' OR total weight
//                            exceeds freight_pallet_threshold_g); else cartons.
//   3. Pallets: ceil(totalWeight / pallet.max_weight_g) pallets, weight shared.
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
  length_mm: number | null
  width_mm: number | null
  max_height_mm: number | null
  max_weight_g: number | null
  threshold_g: number | null
}

export type PackMode = 'auto' | 'pallet' | 'cartons'

// A packed shipping unit in mm/grams. `quantity` is how many identical units.
export interface PackedUnit {
  itemType: 'Carton' | 'Pallet'
  name: string
  quantity: number
  weight_g: number     // per unit
  length_mm: number
  width_mm: number
  height_mm: number
}

const sortedDims = (l: number, w: number, h: number) => [l, w, h].sort((a, b) => a - b)

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

export function packItems(
  items: PackInputItem[],
  boxes: FreightBox[],
  pallet: PalletSpec | null,
  opts: { mode?: PackMode } = {},
): PackResult | null {
  // Expand to individual units.
  type Unit = { item: PackInputItem; weight_g: number }
  const units: Unit[] = []
  for (const it of items) {
    const q = Math.max(0, Math.floor(Number(it.qty) || 0))
    for (let i = 0; i < q; i++) units.push({ item: it, weight_g: Math.max(0, Number(it.weight_g) || 0) })
  }
  if (units.length === 0) return null

  const totalWeightG = units.reduce((s, u) => s + u.weight_g, 0)
  const hasPalletItem = units.some(u => u.item.packaging === 'pallet')
  const palletOk = !!(pallet && pallet.length_mm && pallet.width_mm && pallet.max_weight_g)
  const threshold = pallet?.threshold_g != null ? Number(pallet.threshold_g) : null

  const mode: PackMode = opts.mode || 'auto'
  let palletize: boolean
  if (mode === 'pallet') palletize = palletOk
  else if (mode === 'cartons') palletize = false
  else palletize = palletOk && (hasPalletItem || (threshold != null && threshold > 0 && totalWeightG > threshold))

  // ── Pallets ──
  if (palletize && palletOk) {
    const cap = Number(pallet!.max_weight_g)
    const n = Math.max(1, Math.ceil(totalWeightG / cap))
    const per = Math.round(totalWeightG / n)
    return {
      mode: 'pallet',
      totalWeightG,
      units: [{
        itemType: 'Pallet',
        name: 'Pallet',
        quantity: n,
        weight_g: per,
        length_mm: Number(pallet!.length_mm),
        width_mm: Number(pallet!.width_mm),
        height_mm: Number(pallet!.max_height_mm || 1200),
      }],
    }
  }

  // ── Cartons ──
  if (!boxes || boxes.length === 0) return null  // no config → signal fallback

  const out: PackedUnit[] = []

  // Items that ship individually at their own dims: already-boxed items
  // (packaging='other') and unboxed/wrapped items (packaging='unboxed') always,
  // plus anything that fits no configured box.
  const shipsAlone = (u: Unit) => u.item.packaging === 'other' || u.item.packaging === 'unboxed' || !boxes.some(b => fitsBox(u.item, b))
  const oversized = units.filter(shipsAlone)
  for (const u of oversized) {
    out.push({
      itemType: 'Carton', name: u.item.name.slice(0, 60) || u.item.sku, quantity: 1, weight_g: u.weight_g,
      length_mm: u.item.length_mm || 200, width_mm: u.item.width_mm || 200, height_mm: u.item.height_mm || 200,
    })
  }

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
  type Bin = { box: FreightBox; usedW: number; usedV: number }
  const bins: Bin[] = []
  const desc = [...boxable].sort((a, b) => itemVol(b) - itemVol(a))
  for (const u of desc) {
    const uV = itemVol(u)
    let placed = false
    for (const bin of bins) {
      if (fitsBox(u.item, bin.box)
        && bin.usedW + u.weight_g <= bin.box.max_weight_g
        && bin.usedV + uV <= boxVolume(bin.box) * FILL) {
        bin.usedW += u.weight_g; bin.usedV += uV; placed = true; break
      }
    }
    if (!placed) {
      const cand = byVolAsc.find(b => fitsBox(u.item, b) && b.max_weight_g >= u.weight_g)
      if (cand) bins.push({ box: cand, usedW: u.weight_g, usedV: uV })
      else {
        // Fits a box dimensionally but too heavy for any box's weight limit →
        // ship on its own at its own dims.
        out.push({
          itemType: 'Carton', name: u.item.name.slice(0, 60) || u.item.sku, quantity: 1, weight_g: u.weight_g,
          length_mm: u.item.length_mm || 200, width_mm: u.item.width_mm || 200, height_mm: u.item.height_mm || 200,
        })
      }
    }
  }
  for (const bin of bins) {
    out.push({
      itemType: 'Carton', name: bin.box.name, quantity: 1, weight_g: Math.max(1, Math.round(bin.usedW)),
      length_mm: bin.box.length_mm, width_mm: bin.box.width_mm, height_mm: bin.box.height_mm,
    })
  }

  if (out.length === 0) return null
  return { units: out, mode: 'cartons', totalWeightG }
}
