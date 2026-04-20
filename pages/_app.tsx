// pages/_app.tsx
// App-level wrapper — provides user preferences context to every page
// AND sets a global dark background on html/body so pages can't flash white.
//
// IMPORTANT: If you already have a _app.tsx with other providers or setup,
// merge the PreferencesProvider wrap + Head global style into your existing
// return statement rather than replacing the whole file.

import type { AppProps } from 'next/app'
import Head from 'next/head'
import { PreferencesProvider } from '../lib/preferences'

export default function App({ Component, pageProps }: AppProps) {
  return (
    <PreferencesProvider>
      <Head>
        {/* Global dark background — prevents any white flash/leak between page sections.
            Every portal page draws on top of this, so even if a component fails to
            render a background, the user still sees the dark portal aesthetic. */}
        <style>{`
          html, body {
            background: #0d0f12;
            color: #e8eaf0;
            margin: 0;
            padding: 0;
          }
          #__next {
            background: #0d0f12;
            min-height: 100vh;
          }
          input[type="date"] {
            color-scheme: dark;
          }
        `}</style>
      </Head>
      <Component {...pageProps} />
    </PreferencesProvider>
  )
}
