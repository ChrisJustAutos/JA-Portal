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
import { LIGHT_PALETTE } from '../lib/ui/theme'
import GlobalChatbot, { ChatContextProvider } from '../components/GlobalChatbot'
import DesktopNotifier from '../components/DesktopNotifier'
import { FeedbackProvider } from '../components/ui/Feedback'
// React Flow base styles (the CRM automation canvas) — node_modules CSS can
// only be imported here in the pages router. ~2kb, used by /crm/automations/[id].
import 'reactflow/dist/style.css'

// Applies the user's theme prefs to <html>:
//   - data-theme="dark" | "light" — drives the --t-* palette in globals.css,
//     which every page consumes via the shared T tokens (lib/ui/theme.ts)
//   - 'auto' follows the OS (prefers-color-scheme) live
//   - theme presets (midnight/ocean/forest/slate) tint the dark surfaces only;
//     light mode uses the single light palette
//   - keeps the PWA theme-color meta in sync so the title bar matches
// A pre-paint inline script in _document.tsx applies the same logic from the
// localStorage prefs cache so the first paint has no theme flash.
function ThemeVarsBridge() {
  const { prefs, loading } = usePreferences()
  useEffect(() => {
    if (loading || typeof document === 'undefined') return
    const root = document.documentElement
    const apply = () => {
      const resolved: 'dark' | 'light' =
        prefs.theme === 'light' ? 'light'
        : prefs.theme === 'auto' ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
        : 'dark'
      root.setAttribute('data-theme', resolved)
      root.style.setProperty('--accent', ACCENT_HEX[prefs.accent_color] || ACCENT_HEX.blue)
      const preset = THEME_PRESETS[prefs.theme_preset] || THEME_PRESETS.midnight
      if (resolved === 'dark') {
        root.style.setProperty('--t-bg', preset.bg)
        root.style.setProperty('--t-bg2', preset.bg2)
      } else {
        root.style.removeProperty('--t-bg')
        root.style.removeProperty('--t-bg2')
      }
      document.querySelector('meta[name="theme-color"]')
        ?.setAttribute('content', resolved === 'dark' ? preset.bg : LIGHT_PALETTE.bg)
    }
    apply()
    if (prefs.theme === 'auto') {
      const mq = window.matchMedia('(prefers-color-scheme: light)')
      mq.addEventListener('change', apply)
      return () => mq.removeEventListener('change', apply)
    }
  }, [prefs.accent_color, prefs.theme_preset, prefs.theme, loading])
  return null
}

// Registers the PWA service worker (public/sw.js) so the portal is
// installable as a desktop/mobile app. Production only — keeps `next dev`
// free of stale-cache surprises during development.
function ServiceWorkerRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
    navigator.serviceWorker.register('/sw.js').catch(() => { /* non-fatal */ })
  }, [])
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
          {/* Global background — prevents any flash/leak of the wrong theme.
              Every portal page draws on top of this, so even if a component
              fails to render a background, the user still sees the portal
              surface.

              THE THEME PALETTES LIVE HERE (this is the app's only global
              stylesheet — styles/globals.css is NOT imported). The shared T
              tokens in lib/ui/theme.ts are var(--t-*) references that resolve
              against these blocks. Dark is the default on :root; light
              overrides under html[data-theme="light"] (attribute set pre-paint
              by _document.tsx and kept in sync by ThemeVarsBridge, which also
              overlays the dark preset tints per user). --t-ink is an RGB
              TRIPLET for theme-aware washes: rgba(var(--t-ink), 0.05).

              dangerouslySetInnerHTML is REQUIRED here: React HTML-escapes
              plain string children of <style>, turning quoted selectors like
              html[data-theme="light"] into html[data-theme=&quot;light&quot;]
              — an invalid selector the browser drops. */}
          <style dangerouslySetInnerHTML={{ __html: `
            :root {
              --t-bg:      #0d0f12;
              --t-bg2:     #131519;
              --t-bg3:     #1a1d23;
              --t-bg4:     #21252d;
              --t-border:  rgba(255,255,255,0.07);
              --t-border2: rgba(255,255,255,0.12);
              --t-text:    #e8eaf0;
              --t-text2:   #8b90a0;
              --t-text3:   #545968;
              --t-ink:     255,255,255;
              color-scheme: dark;
            }
            html[data-theme="light"] {
              --t-bg:      #f3f4f6;
              --t-bg2:     #ffffff;
              --t-bg3:     #eceef2;
              --t-bg4:     #e2e5ea;
              --t-border:  rgba(16,24,40,0.10);
              --t-border2: rgba(16,24,40,0.18);
              --t-text:    #171a21;
              --t-text2:   #5b6271;
              --t-text3:   #9097a6;
              --t-ink:     16,24,40;
              color-scheme: light;
            }
            :root {
              --theme-bg: var(--t-bg);
              --theme-bg2: var(--t-bg2);
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
              color: var(--t-text);
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
               the theme consistent in tables / overflow areas. */
            @media (min-width: 768px) {
              ::-webkit-scrollbar { width: 10px; height: 10px; }
              ::-webkit-scrollbar-track { background: transparent; }
              ::-webkit-scrollbar-thumb {
                background: rgba(var(--t-ink),0.08);
                border-radius: 8px;
              }
              ::-webkit-scrollbar-thumb:hover {
                background: rgba(var(--t-ink),0.15);
              }
            }
            /* Disable the iOS tap-flash on interactive elements but keep
               our custom highlight colour (defined above). */
            button, a, input, select, textarea, [role="button"] {
              -webkit-tap-highlight-color: transparent;
            }
          ` }} />
        </Head>
        <ThemeVarsBridge/>
        <ServiceWorkerRegister/>
        <DesktopNotifier/>
        <FeedbackProvider>
          <Component {...pageProps} />
          <GlobalChatbot />
        </FeedbackProvider>
      </ChatContextProvider>
    </PreferencesProvider>
  )
}
