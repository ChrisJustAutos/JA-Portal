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
            }
            html, body {
              background: var(--theme-bg);
              color: #e8eaf0;
              margin: 0;
              padding: 0;
              -webkit-text-size-adjust: 100%;
            }
            #__next {
              background: var(--theme-bg);
              min-height: 100vh;
            }
            input[type="date"] {
              color-scheme: dark;
            }
            /* Mobile — prevent horizontal overflow from wide data tables.
               Sidebar emits a 50px inline spacer so page content shifts right
               of the fixed hamburger automatically. */
            @media (max-width: 767px) {
              body { overflow-x: hidden; }
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
