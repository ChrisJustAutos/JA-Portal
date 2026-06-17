// components/workshop/AddressAutocomplete.tsx
// A text input with optional Google Places address autocomplete (AU-restricted).
//
// If NEXT_PUBLIC_GOOGLE_PLACES_API_KEY is set, the Google Maps JS Places library
// is loaded once and attached to the input; selecting a suggestion fills the
// line-1 address and reports the parsed suburb / state / postcode via onResolved.
// If the key is NOT set (or Google fails to load), it degrades to a plain text
// input — manual entry still works, nothing breaks.

import { useEffect, useRef } from 'react'

export interface ResolvedAddress {
  line1: string
  suburb: string
  state: string
  postcode: string
}

// Module-level loader so the script is injected at most once per page load.
let loaderPromise: Promise<void> | null = null
function loadPlaces(apiKey: string): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve()
  if ((window as any).google?.maps?.places) return Promise.resolve()
  if (loaderPromise) return loaderPromise
  loaderPromise = new Promise<void>((resolve, reject) => {
    const s = document.createElement('script')
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&libraries=places`
    s.async = true
    s.defer = true
    s.onload = () => resolve()
    s.onerror = () => { loaderPromise = null; reject(new Error('Google Maps failed to load')) }
    document.head.appendChild(s)
  })
  return loaderPromise
}

export default function AddressAutocomplete({
  value, onChange, onResolved, placeholder, style, disabled,
}: {
  value: string
  onChange: (v: string) => void
  onResolved: (a: ResolvedAddress) => void
  placeholder?: string
  style?: React.CSSProperties
  disabled?: boolean
}) {
  const ref = useRef<HTMLInputElement>(null)
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_PLACES_API_KEY || ''

  useEffect(() => {
    if (!apiKey || !ref.current) return
    let cancelled = false
    loadPlaces(apiKey).then(() => {
      if (cancelled || !ref.current) return
      const g = (window as any).google
      if (!g?.maps?.places?.Autocomplete) return
      const ac = new g.maps.places.Autocomplete(ref.current, {
        types: ['address'],
        componentRestrictions: { country: 'au' },
        fields: ['address_components', 'formatted_address'],
      })
      ac.addListener('place_changed', () => {
        const place = ac.getPlace()
        const comps: any[] = place.address_components || []
        const get = (type: string, short = false) => {
          const c = comps.find(x => (x.types || []).includes(type))
          return c ? (short ? c.short_name : c.long_name) : ''
        }
        const line1 = [get('street_number'), get('route')].filter(Boolean).join(' ').trim()
        const suburb = get('locality') || get('postal_town') || get('sublocality') || ''
        const state = get('administrative_area_level_1', true)
        const postcode = get('postal_code')
        const resolved: ResolvedAddress = {
          line1: line1 || place.formatted_address || '',
          suburb, state, postcode,
        }
        onChange(resolved.line1)
        onResolved(resolved)
      })
    }).catch(() => { /* fall back to manual entry */ })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey])

  return (
    <>
      {/* Google's suggestion dropdown (.pac-container) is appended to <body>;
          bump its z-index so it sits above the booking modal (z-index 1000). */}
      <style jsx global>{`.pac-container{z-index:100000 !important}`}</style>
      <input
        ref={ref}
        value={value}
        disabled={disabled}
        autoComplete="off"
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder || (apiKey ? 'Start typing address…' : 'Address')}
        style={style}
      />
    </>
  )
}
