// lib/useIsMobile.ts
// Tiny shared hook for breakpoint-based responsive logic.
//
// Why not just CSS media queries? Most of the portal does inline styles
// (no Tailwind, no styled-components) so we need React state to swap
// between mobile and desktop layouts. This hook keeps that pattern
// consistent across pages.
//
// SSR-safe: returns false during server render and the very first client
// render (so the markup matches), then re-renders once with the actual
// viewport width. The brief mismatch flash is invisible because the
// dark background fills before any layout draws.

import { useState, useEffect } from 'react'

export const MOBILE_BREAKPOINT_PX = 768

export function useIsMobile(breakpoint: number = MOBILE_BREAKPOINT_PX): boolean {
  const [isMobile, setIsMobile] = useState(false)
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < breakpoint)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [breakpoint])
  return isMobile
}
