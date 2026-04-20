// pages/_app.tsx
// App-level wrapper — provides user preferences context to every page.
//
// IMPORTANT: If you already have a _app.tsx with other providers or setup,
// merge the PreferencesProvider wrap into your existing return statement
// rather than replacing the whole file.

import type { AppProps } from 'next/app'
import { PreferencesProvider } from '../lib/preferences'

export default function App({ Component, pageProps }: AppProps) {
  return (
    <PreferencesProvider>
      <Component {...pageProps} />
    </PreferencesProvider>
  )
}
