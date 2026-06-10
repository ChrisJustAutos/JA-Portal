// pages/messages.tsx
// Portal-native chat (channels + DMs) — Slack replacement, Phase 1.
// SSR wrapper: auth gate + top bar; the realtime experience lives in ChatApp.

import { useState } from 'react'
import Head from 'next/head'
import PortalTopBar from '../lib/PortalTopBar'
import { requirePageAuth, type PortalUserSSR } from '../lib/authServer'
import ChatApp from '../components/messages/ChatApp'

const BG = 'var(--t-bg)'

export default function MessagesPage({ user }: { user: PortalUserSSR }) {
  const [unread, setUnread] = useState(0)
  return (
    <>
      <Head><title>{unread > 0 ? `(${unread}) ` : ''}Messages — Just Autos</title><meta name="viewport" content="width=device-width,initial-scale=1"/><meta name="robots" content="noindex,nofollow"/></Head>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden', fontFamily: "'DM Sans',system-ui,sans-serif", color: 'var(--t-text)', background: BG }}>
        <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet"/>
        <PortalTopBar
          activeId="messages"
          currentUserRole={user.role}
          currentUserVisibleTabs={user.visibleTabs}
          currentUserName={user.displayName}
          currentUserEmail={user.email}
          alertCounts={{ messages: unread }}
        />
        <ChatApp user={user} onUnreadChange={setUnread} />
      </div>
    </>
  )
}

export async function getServerSideProps(context: any) {
  return requirePageAuth(context, 'view:messages')
}
