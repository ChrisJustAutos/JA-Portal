// pages/_app.tsx
// App-level wrapper — provides user preferences context to every page,
// sets a global dark background, and mounts the floating AI assistant.
//
// IMPORTANT: If you already have a _app.tsx with other providers or setup,
// merge the PreferencesProvider + ChatContextProvider wraps + Head global
// style + <GlobalChatbot /> into your existing return statement rather than
// replacing the whole file.

import type { AppProps } from 'next/app'
import Head from 'next/head'
import { PreferencesProvider } from '../lib/preferences'
import GlobalChatbot, { ChatContextProvider } from '../components/GlobalChatbot'

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
              fails to render a background, the user still sees the dark portal. */}
          <style>{`
            html, body {
              background: #0d0f12;
              color: #e8eaf0;
              margin: 0;
              padding: 0;
              -webkit-text-size-adjust: 100%;
            }
            #__next {
              background: #0d0f12;
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
        <Component {...pageProps} />
        <GlobalChatbot />
      </ChatContextProvider>
    </PreferencesProvider>
  )
}
