// pages/_document.tsx
// Custom document for PWA + iOS home-screen install support.
//
// What this enables:
//   - "Add to Home Screen" on iOS produces a real-looking app:
//     · standalone display mode (no Safari chrome)
//     · dark status bar matching the portal background
//     · the apple-touch-icon shows up as the tile
//   - On Android Chrome, the manifest + icons make the app installable
//     and gives it a proper home-screen tile
//
// Why a custom document: the <Head> here is the only way to inject
// <link rel="manifest"> and the apple-touch-icon outside _app.tsx, which
// re-renders on every navigation. _document.tsx renders once on the
// server and the head stays stable.
//
// _app.tsx already sets the viewport meta tag, theme-color, and the global
// dark CSS — those don't need to be duplicated here.

import { Html, Head, Main, NextScript } from 'next/document'

export default function Document() {
  return (
    <Html lang="en">
      <Head>
        {/* PWA manifest */}
        <link rel="manifest" href="/manifest.json" />

        {/* Apple home-screen icon (180x180 PNG, opaque, no rounding —
            iOS adds the rounding/shine automatically) */}
        <link rel="apple-touch-icon" sizes="180x180" href="/icons/apple-touch-icon.png" />

        {/* Favicons for desktop browser tabs */}
        <link rel="icon" type="image/png" sizes="192x192" href="/icons/icon-192.png" />
        <link rel="icon" type="image/png" sizes="32x32"  href="/icons/favicon-32.png" />

        {/* iOS web-app behaviour: standalone (no Safari chrome) + dark
            status bar that blends into the navy portal background.
            "black-translucent" lets the page draw under the status bar;
            we want a solid dark bar so use "black" instead. */}
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black" />
        <meta name="apple-mobile-web-app-title" content="JA Portal" />

        {/* Generic mobile-web-app-capable for Android Chrome */}
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="application-name" content="JA Portal" />

        {/* Disable phone-number auto-detection (would underline numbers
            in invoice metadata and turn them into tel: links) */}
        <meta name="format-detection" content="telephone=no" />
      </Head>
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  )
}
