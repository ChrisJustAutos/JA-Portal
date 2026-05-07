// pages/_app.tsx
// App-level wrapper — provides user preferences context to every page,
// sets a global dark background, and mounts the floating AI assistant.
//
// IMPORTANT: If you already have a _app.tsx with other providers or setup,
// merge the PreferencesProvider + ChatContextProvider wraps + Head global
// style + <GlobalChatbot /> into your existing return statement rather than
// replacing the whole file.

import { useEffect } from 'react'
import type { AppProps } from 'next/app'
import Head from 'next/head'
import { PreferencesProvider, usePreferences, ACCENT_HEX, THEME_PRESETS } from '../lib/preferences'
import GlobalChatbot, { ChatContextProvider } from '../components/GlobalChatbot'

// Reads the user's accent_color + theme_preset and exposes them as CSS
// custom properties on <html>. Components can opt in to the live values via
// var(--accent) / var(--theme-bg) — existing inline palettes (the local `T = {…}`
// blocks) keep working unchanged.
function ThemeVarsBridge() {
  const { prefs, loading } = usePreferences()
  useEffect(() => {
    if (loading || typeof document === 'undefined') return
    const accent = ACCENT_HEX[prefs.accent_color] || ACCENT_HEX.blue
    const preset = THEME_PRESETS[prefs.theme_preset] || THEME_PRESETS.midnight
    const root = document.documentElement
    root.style.setProperty('--accent', accent)
    root.style.setProperty('--theme-bg', preset.bg)
    root.style.setProperty('--theme-bg2', preset.bg2)
  }, [prefs.accent_color, prefs.theme_preset, loading])
  return null
}

export default function App({ Component, pageProps }: AppProps) {
  return (
    <PreferencesProvider>
      <ChatContextProvider>
        <Head>
          {/* Mobile viewport — without this, Chrome/Safari on phones renders at 980px
              virtual width and zooms out, making the portal unreadable on a phone. */}
          <meta name="viewport" content="width=device-width,initial-scale=1"/>
          <meta name="theme-color" content="#0d0f12"/>
          {/* Global dark background — prevents any white flash/leak.
              Every portal page draws on top of this, so even if a component
              fails to render a background, the user still sees the dark portal.
              `--theme-bg` is overridden per user by ThemeVarsBridge once prefs load. */}
          <style>{`
            :root {
              --theme-bg: #0d0f12;
              --theme-bg2: #131519;
              --accent: #4f8ef7;
              /* Safe-area insets for iOS notch / home indicator. Pages can
                 use env(safe-area-inset-bottom) directly, or the
                 --safe-bottom var below as a friendly alias. */
              --safe-top:    env(safe-area-inset-top, 0px);
              --safe-bottom: env(safe-area-inset-bottom, 0px);
              --safe-left:   env(safe-area-inset-left, 0px);
              --safe-right:  env(safe-area-inset-right, 0px);
            }
            html, body {
              background: var(--theme-bg);
              color: #e8eaf0;
              margin: 0;
              padding: 0;
              -webkit-text-size-adjust: 100%;
              /* Native-feeling momentum scroll on iOS for the whole page */
              -webkit-overflow-scrolling: touch;
              /* Subtle tap highlight instead of the default flash */
              -webkit-tap-highlight-color: rgba(79, 142, 247, 0.2);
              font-family: 'DM Sans', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            }
            #__next {
              background: var(--theme-bg);
              min-height: 100vh;
              min-height: 100dvh;  /* dynamic viewport — accounts for mobile URL bar */
            }
            input[type="date"] {
              color-scheme: dark;
            }
            /* iOS Safari zooms in on focused inputs whose font-size is < 16px.
               Force 16px+ on every text-like control to suppress the zoom
               while keeping a tighter visual look elsewhere via line-height. */
            @media (max-width: 767px) {
              body { overflow-x: hidden; }
              input[type="text"], input[type="email"], input[type="password"],
              input[type="number"], input[type="tel"], input[type="url"],
              input[type="search"], input[type="date"], input[type="time"],
              input[type="datetime-local"], textarea, select {
                font-size: 16px !important;
              }
              /* Touch-friendly minimum tap target on all buttons + links
                 that look like buttons. 44px is the iOS HIG recommendation.
                 We don't bump every <a> because text links shouldn't be huge. */
              button, [role="button"] {
                min-height: 40px;
              }
              /* Modals / overlays on mobile: edge-to-edge, no padding */
              dialog, [role="dialog"] {
                margin: 0;
              }
            }
            /* Smooth scroll behaviour for in-page anchors (used by some
               admin pages that link to sections) — feels less jarring */
            html { scroll-behavior: smooth; }
            /* Custom scrollbar — desktop only (mobile uses native). Keeps
               the dark theme consistent in tables / overflow areas. */
            @media (min-width: 768px) {
              ::-webkit-scrollbar { width: 10px; height: 10px; }
              ::-webkit-scrollbar-track { background: transparent; }
              ::-webkit-scrollbar-thumb {
                background: rgba(255,255,255,0.08);
                border-radius: 8px;
              }
              ::-webkit-scrollbar-thumb:hover {
                background: rgba(255,255,255,0.15);
              }
            }
            /* Disable the iOS tap-flash on interactive elements but keep
               our custom highlight colour (defined above). */
            button, a, input, select, textarea, [role="button"] {
              -webkit-tap-highlight-color: transparent;
            }
          `}</style>
        </Head>
        <ThemeVarsBridge/>
        <Component {...pageProps} />
        <GlobalChatbot />
      </ChatContextProvider>
    </PreferencesProvider>
  )
}
