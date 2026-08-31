// lib/map-basemap.ts
// The dark basemap shared by both Leaflet dashboards — Reports → Distributor
// Map and Workshop → Map/Conversion.
//
// It lives here because both dashboards used to carry their own copy of one
// tile URL, so when the provider changed its terms they broke together and had
// to be fixed twice. One definition, one place.
//
// Provider: Esri "Dark Gray Canvas", which needs no API key. We were on CARTO's
// basemaps until 2026-08-31, when they began requiring one and started
// watermarking every unauthenticated tile with "API KEY REQUIRED" — stamped
// into the tile images themselves, so it appeared diagonally across both maps.
//
// Two gotchas, both load-bearing:
//   · Esri's path order is {z}/{y}/{x}. Leaflet's convention is {z}/{x}/{y},
//     so writing it the usual way silently serves the wrong part of the world.
//   · Detail stops at zoom 16. Past that Esri returns a LIGHT-GREY tile reading
//     "Map data not yet available" — which would simply be a different message
//     written across the map. maxNativeZoom makes Leaflet upscale zoom 16
//     instead, so deep zoom stays dark and legible.

const TILE = (service: string) =>
  `https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/${service}/MapServer/tile/{z}/{y}/{x}`

/** Esri's terms require this to be shown. Both maps enable Leaflet's attribution control for it. */
export const BASEMAP_ATTRIBUTION = 'Tiles &copy; Esri'

const COMMON = { maxZoom: 19, maxNativeZoom: 16 }

/**
 * Adds the base imagery, and optionally Esri's separate place-name layer. Esri
 * splits the two, unlike CARTO's combined `dark_all`, so labels are their own
 * tile layer drawn over the base.
 *
 * Pass `labels: false` where the map supplies its own — the workshop map draws
 * curated state and city labels and covers the tiles with filled land polygons,
 * so a second set of place names would just fight with them.
 */
export function addDarkBasemap(L: any, map: any, opts: { labels?: boolean; labelPane?: string } = {}): void {
  L.tileLayer(TILE('World_Dark_Gray_Base'), { ...COMMON, attribution: BASEMAP_ATTRIBUTION }).addTo(map)
  if (opts.labels === false) return
  L.tileLayer(TILE('World_Dark_Gray_Reference'), {
    ...COMMON,
    ...(opts.labelPane ? { pane: opts.labelPane } : {}),
  }).addTo(map)
}
