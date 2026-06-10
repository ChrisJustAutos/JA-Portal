// components/messages/ChatApp.tsx
// Realtime chat experience. Phase 1: channels/DMs, live thread, composer with
// @mentions + attachments, typing, unread. Phase 2 (Slack parity): emoji
// reactions, edit/delete, threaded replies, message search, markdown rendering,
// desktop notifications. Phase 2.5 (fluency): optimistic send w/ sending/failed
// ticks + smart scroll (no yank-to-bottom, "new messages" pill, load-older on
// scroll-up), presence (online dots / "Active now"), read receipts ("Seen"),
// avatars + message grouping + date separators + a "new messages" divider, and
// composer polish (draft persistence, emoji picker, paste/drag-drop, ↑-to-edit).
// Reads live via Supabase Realtime (lib/realtime.ts); writes via /api routes.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { getSupabase } from '../../lib/supabaseClient'
import { subscribeToConversation, subscribeToConversationList, subscribeToAllMessages, joinTyping, joinPresence, type TypingChannel } from '../../lib/realtime'
import type { UserRole } from '../../lib/permissions'
import { playSound } from '../../lib/notificationSounds'
import { useIsMobile } from '../../lib/useIsMobile'
import { usePreferences, messageNotificationsMuted, type UserPreferences } from '../../lib/preferences'

const useIsoEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect

const T = {
  bg: 'var(--t-bg)', bg2: 'var(--t-bg2)', bg3: 'var(--t-bg3)', bg4: 'var(--t-bg4)',
  border: 'var(--t-border)', border2: 'var(--t-border2)',
  text: 'var(--t-text)', text2: 'var(--t-text2)', text3: 'var(--t-text3)',
  blue: '#4f8ef7', teal: '#2dd4bf', green: '#34c77b', amber: '#f5a623', red: '#f04e4e', purple: '#a78bfa', accent: '#4f8ef7',
}
const QUICK_EMOJI = ['👍', '❤️', '😂', '🎉', '✅', '👀', '🙏', '🔥']
const AVATAR_COLORS = ['#4f8ef7', '#2dd4bf', '#34c77b', '#f5a623', '#a78bfa', '#f04e4e', '#e879a6', '#38bdf8', '#fb923c', '#a3e635']

interface SSRUser { id: string; email: string; displayName: string | null; role: UserRole }
interface Conversation {
  id: string; type: 'channel' | 'dm' | 'group' | 'customer'; name: string | null; displayName: string | null
  topic: string | null; is_private: boolean; source: string | null; status: string
  last_message_at: string | null; isMember: boolean; muted: boolean; unread: number; memberIds: string[]; memberNames: string[]
  myLastReadAt: string | null; readState: Record<string, string | null>
}
interface Reaction { emoji: string; count: number; mine: boolean }
interface Attachment { id?: string; storage_path: string; filename: string | null; content_type: string | null; size_bytes: number | null; localUrl?: string }
interface Message {
  id: string; conversation_id: string; sender_user_id: string | null; senderName: string; body: string
  message_type: string; created_at: string; edited_at?: string | null; deleted_at?: string | null
  attachments: Attachment[]; mentions: string[]; reactions: Reaction[]; replyCount: number
  clientId?: string; status?: 'sending' | 'failed'   // optimistic state; absent = confirmed
}
interface DirUser { id: string; name: string; email: string; role: string }

const ATTACH_BUCKET = 'chat-attachments'

export default function ChatApp({ user, onUnreadChange }: { user: SSRUser; onUnreadChange?: (n: number) => void }) {
  const isMobile = useIsMobile()
  const meName = user.displayName || user.email
  const { prefs, update: updatePrefs } = usePreferences()
  const prefsRef = useRef<UserPreferences>(prefs); prefsRef.current = prefs
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [dir, setDir] = useState<DirUser[]>([])
  const [loadingConvs, setLoadingConvs] = useState(true)
  const [loadingMsgs, setLoadingMsgs] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [modal, setModal] = useState<null | 'channel' | 'dm'>(null)
  const [typers, setTypers] = useState<{ id: string; name: string }[]>([])
  const [threadParent, setThreadParent] = useState<Message | null>(null)
  const [threadMessages, setThreadMessages] = useState<Message[]>([])
  const [search, setSearch] = useState('')
  const [searchResults, setSearchResults] = useState<any[] | null>(null)
  const [online, setOnline] = useState<Set<string>>(new Set())
  const [awayIds, setAwayIds] = useState<Set<string>>(new Set())
  const [dividerTs, setDividerTs] = useState<string | null>(null)

  const activeIdRef = useRef<string | null>(null); activeIdRef.current = activeId
  const dirRef = useRef<DirUser[]>([]); dirRef.current = dir
  const conversationsRef = useRef<Conversation[]>([]); conversationsRef.current = conversations
  const threadParentRef = useRef<Message | null>(null); threadParentRef.current = threadParent
  // Message ids already applied to state (own sends + realtime echoes) so the
  // same insert is never double-counted.
  const seenMsgIds = useRef<Set<string>>(new Set())
  // Per-conversation message cache — switching back to a channel is instant.
  const msgCache = useRef<Record<string, Message[]>>({})
  // hasMore per conversation (for load-older); pending sends keyed by clientId.
  const hasMoreRef = useRef<Record<string, boolean>>({})
  const pending = useRef<Record<string, { body: string; mentionIds: string[]; files: File[]; parentMessageId?: string }>>({})
  const active = useMemo(() => conversations.find(c => c.id === activeId) || null, [conversations, activeId])

  // Deep-link: a notification (or push) opens /messages?c=<id> — select that
  // conversation once the list has loaded. Runs once.
  const deepLinkApplied = useRef(false)
  useEffect(() => {
    if (deepLinkApplied.current || activeId || conversations.length === 0) return
    if (typeof window === 'undefined') return
    const c = new URLSearchParams(window.location.search).get('c')
    if (c && conversations.some(cv => cv.id === c)) { deepLinkApplied.current = true; setActiveId(c) }
  }, [conversations, activeId])
  const totalUnread = useMemo(() => conversations.reduce((s, c) => s + (c.muted ? 0 : c.unread), 0), [conversations])
  useEffect(() => { onUnreadChange?.(totalUnread) }, [totalUnread, onUnreadChange])

  const markSeen = useCallback((id: string) => {
    seenMsgIds.current.add(id)
    if (seenMsgIds.current.size > 600) seenMsgIds.current = new Set(Array.from(seenMsgIds.current).slice(-300))
  }, [])
  const sortConvs = (cs: Conversation[]) => [...cs].sort((a, b) => (b.last_message_at || '').localeCompare(a.last_message_at || ''))

  // ── Loaders ───────────────────────────────────────────────────────
  const loadConversations = useCallback(async () => {
    const r = await fetch('/api/conversations')
    if (r.ok) { const d = await r.json(); setConversations(d.conversations || []) }
    setLoadingConvs(false)
  }, [])
  // Single write-path for a conversation's messages: updates the cache, and the
  // visible list when that conversation is open.
  const setConvMessages = useCallback((conversationId: string, updater: (prev: Message[]) => Message[]) => {
    msgCache.current[conversationId] = updater(msgCache.current[conversationId] || [])
    if (activeIdRef.current === conversationId) setMessages(msgCache.current[conversationId])
  }, [])
  const loadMessages = useCallback(async (conversationId: string, opts: { quiet?: boolean } = {}) => {
    if (!opts.quiet) setLoadingMsgs(true)
    const r = await fetch(`/api/messages?conversationId=${conversationId}`)
    if (r.ok) {
      const d = await r.json()
      // Preserve any optimistic (sending/failed) messages not yet persisted.
      setConvMessages(conversationId, prev => {
        const pendingMsgs = prev.filter(m => m.status)
        const server: Message[] = d.messages || []
        const ids = new Set(server.map(m => m.id))
        return [...server, ...pendingMsgs.filter(m => !ids.has(m.id))]
      })
      hasMoreRef.current[conversationId] = !!d.hasMore
      if (activeIdRef.current === conversationId) setHasMore(!!d.hasMore)
    }
    setLoadingMsgs(false)
  }, [setConvMessages])
  // Reverse pagination — prepend older messages, preserving scroll (the list
  // records its scrollHeight just before calling this).
  const loadOlder = useCallback(async (conversationId: string) => {
    const cur = msgCache.current[conversationId] || []
    const oldest = cur.find(m => !m.status)   // skip optimistic rows
    if (!oldest || loadingOlder) return
    setLoadingOlder(true)
    try {
      const r = await fetch(`/api/messages?conversationId=${conversationId}&before=${encodeURIComponent(oldest.created_at)}`)
      if (r.ok) {
        const d = await r.json()
        const older: Message[] = d.messages || []
        setConvMessages(conversationId, prev => {
          const have = new Set(prev.map(m => m.id))
          return [...older.filter(m => !have.has(m.id)), ...prev]
        })
        hasMoreRef.current[conversationId] = !!d.hasMore
        if (activeIdRef.current === conversationId) setHasMore(!!d.hasMore)
      }
    } finally { setLoadingOlder(false) }
  }, [loadingOlder, setConvMessages])
  const loadThread = useCallback(async (conversationId: string, parentId: string) => {
    const r = await fetch(`/api/messages?conversationId=${conversationId}&parentId=${parentId}`)
    if (r.ok) { const d = await r.json(); setThreadMessages(d.messages || []) }
  }, [])
  const markRead = useCallback(async (conversationId: string) => {
    const nowIso = new Date().toISOString()
    setConversations(cs => cs.map(c => c.id === conversationId ? { ...c, unread: 0, myLastReadAt: nowIso } : c))
    await fetch(`/api/conversations/${conversationId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'read' }) }).catch(() => {})
  }, [])

  useEffect(() => { loadConversations(); fetch('/api/messages/directory').then(r => r.ok ? r.json() : { users: [] }).then(d => setDir(d.users || [])) }, [loadConversations])

  // Workspace presence — who's online, and who's away. Re-tracks when my own
  // away status changes so others see it live.
  useEffect(() => {
    const p = joinPresence({ id: user.id, name: meName, away: !!prefs.messages_away }, entries => {
      setOnline(new Set(entries.map(e => e.id)))
      setAwayIds(new Set(entries.filter(e => e.away).map(e => e.id)))
    })
    return () => p.leave()
  }, [user.id, meName, prefs.messages_away])

  // Tab regained focus: reconcile quietly in case realtime events were missed
  // while asleep (incremental updates below otherwise never refetch).
  useEffect(() => {
    const onVis = () => {
      if (typeof document === 'undefined' || document.hidden) return
      loadConversations()
      if (activeIdRef.current) loadMessages(activeIdRef.current, { quiet: true })
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [loadConversations, loadMessages])

  // ── Incremental realtime appliers (no refetch per event) ──────────
  const enrichRow = useCallback((row: any): Message => {
    const sender = row.sender_user_id === user.id
      ? { name: meName }
      : dirRef.current.find(u => u.id === row.sender_user_id)
    return {
      ...row,
      senderName: row.sender_user_id ? (sender?.name || 'Unknown') : (row.message_type === 'external' ? 'Customer' : 'System'),
      attachments: [], mentions: [], reactions: [], replyCount: 0,
    }
  }, [user.id, meName])

  // Realtime message rows don't carry attachments (separate table, inserted
  // just after) — reconcile with one cheap RLS-scoped lookup shortly after.
  const reconcileAttachments = useCallback((conversationId: string, messageId: string) => {
    setTimeout(async () => {
      try {
        const { data } = await getSupabase().from('message_attachments')
          .select('id, message_id, storage_path, filename, content_type, size_bytes').eq('message_id', messageId)
        if (!data?.length) return
        const apply = (m: Message) => m.id === messageId ? { ...m, attachments: data } : m
        setConvMessages(conversationId, ms => ms.map(apply))
        setThreadMessages(ms => ms.map(apply))
      } catch {}
    }, 700)
  }, [setConvMessages])

  const handleMessageInsert = useCallback((row: any) => {
    // Own messages are applied via the POST response (optimistic path), so we
    // ignore their realtime echo — this also prevents a duplicate bubble racing
    // the POST. (Trade-off: a message you send on another device appears here
    // on the next quiet refetch rather than instantly.)
    if (!row?.id || row.sender_user_id === user.id || seenMsgIds.current.has(row.id)) return
    markSeen(row.id)
    const convId = row.conversation_id
    if (row.parent_message_id) {
      setConvMessages(convId, ms => ms.map(m => m.id === row.parent_message_id ? { ...m, replyCount: (m.replyCount || 0) + 1 } : m))
      const tp = threadParentRef.current
      if (tp && tp.id === row.parent_message_id) {
        const msg = enrichRow(row)
        setThreadMessages(ms => ms.some(m => m.id === row.id) ? ms : [...ms, msg])
      }
    } else {
      const msg = enrichRow(row)
      setConvMessages(convId, ms => ms.some(m => m.id === row.id) ? ms : [...ms, msg])
    }
    reconcileAttachments(convId, row.id)
    if (activeIdRef.current === convId && typeof document !== 'undefined' && !document.hidden) markRead(convId)
  }, [enrichRow, markSeen, markRead, reconcileAttachments, setConvMessages, user.id])

  const handleMessageUpdate = useCallback((row: any) => {
    if (!row?.id) return
    const apply = (m: Message) => m.id === row.id ? { ...m, body: row.body, edited_at: row.edited_at, deleted_at: row.deleted_at } : m
    setConvMessages(row.conversation_id, ms => ms.map(apply))
    setThreadMessages(ms => ms.map(apply))
    setThreadParent(tp => tp && tp.id === row.id ? apply(tp) : tp)
  }, [setConvMessages])

  // Idempotent reaction patch — safe against the realtime echo of our own
  // optimistic toggle (mine already set → skip).
  const handleReaction = useCallback((row: any, eventType: 'INSERT' | 'UPDATE' | 'DELETE') => {
    if (!row?.message_id || !row.emoji || eventType === 'UPDATE') return
    const mineEvent = row.user_id === user.id
    const apply = (m: Message): Message => {
      if (m.id !== row.message_id) return m
      const rs = [...(m.reactions || [])]
      const i = rs.findIndex(r => r.emoji === row.emoji)
      if (eventType === 'INSERT') {
        if (i === -1) rs.push({ emoji: row.emoji, count: 1, mine: mineEvent })
        else {
          if (mineEvent && rs[i].mine) return m
          rs[i] = { ...rs[i], count: rs[i].count + 1, mine: rs[i].mine || mineEvent }
        }
      } else {
        if (i === -1) return m
        if (mineEvent && !rs[i].mine) return m
        const count = rs[i].count - 1
        if (count <= 0) rs.splice(i, 1)
        else rs[i] = { ...rs[i], count, mine: rs[i].mine && !mineEvent }
      }
      return { ...m, reactions: rs }
    }
    if (row.conversation_id) setConvMessages(row.conversation_id, ms => ms.map(apply))
    setThreadMessages(ms => ms.map(apply))
    setThreadParent(tp => tp ? apply(tp) : tp)
  }, [setConvMessages, user.id])

  // Live conversation-list updates — patch the list in place; only refetch for
  // events we can't apply locally (new conversation, my membership changed).
  useEffect(() => {
    let t: any
    const scheduleReload = () => { clearTimeout(t); t = setTimeout(loadConversations, 400) }
    const off = subscribeToConversationList({
      onConversation: (row, type) => {
        if (!row?.id) return
        if (type === 'DELETE') { setConversations(cs => cs.filter(c => c.id !== row.id)); return }
        if (type === 'INSERT') { scheduleReload(); return }
        const existing = conversationsRef.current.find(c => c.id === row.id)
        if (!existing) { scheduleReload(); return }
        if (row.archived_at) { setConversations(cs => cs.filter(c => c.id !== row.id)); return }
        setConversations(cs => sortConvs(cs.map(c => c.id === row.id
          ? { ...c, name: row.name, topic: row.topic, is_private: row.is_private, status: row.status, last_message_at: row.last_message_at }
          : c)))
      },
      onParticipant: (row, type) => {
        if (!row?.conversation_id) return
        if (row.user_id === user.id) {
          if (type === 'UPDATE') {
            // My read/mute state changed (e.g. read in another tab) — patch.
            setConversations(cs => cs.map(c => c.id === row.conversation_id
              ? { ...c, muted: !!row.muted, myLastReadAt: row.last_read_at, unread: row.last_read_at && (!c.last_message_at || row.last_read_at >= c.last_message_at) ? 0 : c.unread }
              : c))
          } else scheduleReload() // joined/left a conversation
          return
        }
        // Another participant read the conversation → update their read marker
        // so 'Seen' receipts go live.
        if (type === 'UPDATE') {
          setConversations(cs => cs.map(c => c.id === row.conversation_id
            ? { ...c, readState: { ...c.readState, [row.user_id]: row.last_read_at } } : c))
          return
        }
        // Membership change — patch the member lists locally.
        setConversations(cs => cs.map(c => {
          if (c.id !== row.conversation_id) return c
          const ids = type === 'INSERT'
            ? (c.memberIds.includes(row.user_id) ? c.memberIds : [...c.memberIds, row.user_id])
            : c.memberIds.filter(id => id !== row.user_id)
          return { ...c, memberIds: ids, memberNames: ids.map(id => dirRef.current.find(u => u.id === id)?.name).filter(Boolean) as string[] }
        }))
      },
    })
    return () => { clearTimeout(t); off() }
  }, [loadConversations, user.id])

  // Any incoming message (RLS-filtered): bump the sidebar unread/recency
  // locally, and desktop-notify while the tab is hidden.
  useEffect(() => {
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') { try { Notification.requestPermission() } catch {} }
    const off = subscribeToAllMessages((row) => {
      if (!row || row.sender_user_id === user.id) return
      if (typeof document !== 'undefined' && !document.hidden && row.conversation_id === activeIdRef.current) return
      setConversations(cs => {
        const i = cs.findIndex(c => c.id === row.conversation_id)
        if (i === -1) return cs // a new conversation — the conv INSERT event reloads the list
        const next = [...cs]
        next[i] = { ...next[i], unread: next[i].unread + 1, last_message_at: row.created_at }
        return sortConvs(next)
      })
      // Away / outside working hours → keep the unread badge but silence the
      // active alert (sound + desktop pop-up).
      if (messageNotificationsMuted(prefsRef.current)) return
      try { playSound() } catch {}
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        try { new Notification('New message', { body: String(row.body || '').slice(0, 120) || 'Attachment', tag: row.conversation_id }) } catch {}
      }
    })
    return () => off()
  }, [user.id])

  // Open a conversation: cached history shows instantly (refreshed quietly),
  // mark read, then live events patch state in place — no refetch per event.
  useEffect(() => {
    if (!activeId) return
    const conv = conversationsRef.current.find(c => c.id === activeId)
    setDividerTs(conv?.myLastReadAt || null)   // snapshot for the "new messages" line
    setHasMore(!!hasMoreRef.current[activeId])
    const cached = msgCache.current[activeId]
    if (cached) { setMessages(cached); loadMessages(activeId, { quiet: true }) }
    else { setMessages([]); loadMessages(activeId) }
    markRead(activeId)
    const off = subscribeToConversation(activeId, {
      onMessageInsert: handleMessageInsert,
      onMessageUpdate: handleMessageUpdate,
      onReaction: handleReaction,
    })
    return () => off()
  }, [activeId, loadMessages, markRead, handleMessageInsert, handleMessageUpdate, handleReaction])

  // Typing channel.
  const typingRef = useRef<TypingChannel | null>(null)
  useEffect(() => {
    setTypers([]); setThreadParent(null)
    if (!activeId) return
    const ch = joinTyping(activeId, { id: user.id, name: meName }, setTypers)
    typingRef.current = ch
    return () => { ch.leave(); typingRef.current = null }
  }, [activeId, user.id, meName])

  // Search (debounced).
  useEffect(() => {
    if (search.trim().length < 2) { setSearchResults(null); return }
    const t = setTimeout(async () => {
      const r = await fetch(`/api/messages/search?q=${encodeURIComponent(search.trim())}`)
      if (r.ok) { const d = await r.json(); setSearchResults(d.results || []) }
    }, 300)
    return () => clearTimeout(t)
  }, [search])

  // ── Actions (optimistic — patch local state, then call the API) ────
  const patchEverywhere = useCallback((conversationId: string | null, apply: (m: Message) => Message) => {
    if (conversationId) setConvMessages(conversationId, ms => ms.map(apply))
    setThreadMessages(ms => ms.map(apply))
    setThreadParent(tp => tp ? apply(tp) : tp)
  }, [setConvMessages])

  // Optimistic send: show the bubble instantly (status 'sending'), upload any
  // files, POST, then swap in the real message — or mark it 'failed' for retry.
  const doSendInternal = useCallback(async (clientId: string, body: string, mentionIds: string[], files: File[], parentMessageId?: string) => {
    const convId = activeIdRef.current
    if (!convId) return
    const tempId = 'temp-' + clientId
    const localAtts: Attachment[] = files.map(f => ({
      storage_path: '', filename: f.name, content_type: f.type, size_bytes: f.size,
      localUrl: f.type.startsWith('image/') ? URL.createObjectURL(f) : undefined,
    }))
    const temp: Message = {
      id: tempId, clientId, conversation_id: convId, sender_user_id: user.id, senderName: meName,
      body, message_type: 'user', created_at: new Date().toISOString(),
      attachments: localAtts, mentions: mentionIds, reactions: [], replyCount: 0, status: 'sending',
    }
    markSeen(tempId)
    if (parentMessageId) {
      setThreadMessages(ms => [...ms, temp])
      setConvMessages(convId, ms => ms.map(m => m.id === parentMessageId ? { ...m, replyCount: (m.replyCount || 0) + 1 } : m))
    } else {
      setConvMessages(convId, ms => [...ms, temp])
    }
    pending.current[clientId] = { body, mentionIds, files, parentMessageId }
    try {
      const sb = getSupabase()
      const attachments: any[] = []
      for (const f of files) {
        const path = `${crypto.randomUUID()}-${f.name.replace(/[^\w.-]/g, '_')}`
        const { error } = await sb.storage.from(ATTACH_BUCKET).upload(path, f, { contentType: f.type, upsert: false })
        if (error) throw error
        attachments.push({ storagePath: path, filename: f.name, contentType: f.type, sizeBytes: f.size })
      }
      const r = await fetch('/api/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationId: convId, body, mentionIds, attachments, parentMessageId }) })
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || 'Could not send') }
      const d = await r.json()
      if (!d.message) throw new Error('No message returned')
      markSeen(d.message.id)
      const real: Message = {
        ...d.message, status: undefined, clientId, reactions: [], replyCount: 0,
        mentions: d.message.mentions || mentionIds,
        attachments: (d.message.attachments || []).map((a: any) => ({ storage_path: a.storagePath, filename: a.filename, content_type: a.contentType, size_bytes: a.sizeBytes })),
      }
      const swap = (m: Message) => (m.clientId === clientId || m.id === tempId) ? { ...real, replyCount: m.replyCount, reactions: m.reactions } : m
      if (parentMessageId) setThreadMessages(ms => ms.map(swap))
      setConvMessages(convId, ms => ms.map(swap))
      delete pending.current[clientId]
      localAtts.forEach(a => a.localUrl && URL.revokeObjectURL(a.localUrl))
    } catch (e: any) {
      const fail = (m: Message) => (m.clientId === clientId || m.id === tempId) ? { ...m, status: 'failed' as const } : m
      if (parentMessageId) setThreadMessages(ms => ms.map(fail))
      setConvMessages(convId, ms => ms.map(fail))
    }
  }, [user.id, meName, markSeen, setConvMessages])

  const sendMessage = useCallback((body: string, mentionIds: string[], files: File[], parentMessageId?: string) => {
    doSendInternal(crypto.randomUUID(), body, mentionIds, files, parentMessageId)
  }, [doSendInternal])

  const retrySend = useCallback((clientId: string) => {
    const p = pending.current[clientId]
    if (!p) return
    const drop = (ms: Message[]) => ms.filter(m => m.clientId !== clientId)
    if (activeIdRef.current) setConvMessages(activeIdRef.current, drop)
    setThreadMessages(drop)
    delete pending.current[clientId]
    doSendInternal(crypto.randomUUID(), p.body, p.mentionIds, p.files, p.parentMessageId)
  }, [doSendInternal, setConvMessages])

  const toggleReaction = useCallback(async (messageId: string, emoji: string) => {
    if (messageId.startsWith('temp-')) return // not yet persisted
    patchEverywhere(activeIdRef.current, (m) => {
      if (m.id !== messageId) return m
      const rs = [...(m.reactions || [])]
      const i = rs.findIndex(r => r.emoji === emoji)
      if (i === -1) rs.push({ emoji, count: 1, mine: true })
      else if (rs[i].mine) { const c = rs[i].count - 1; if (c <= 0) rs.splice(i, 1); else rs[i] = { ...rs[i], count: c, mine: false } }
      else rs[i] = { ...rs[i], count: rs[i].count + 1, mine: true }
      return { ...m, reactions: rs }
    })
    const r = await fetch(`/api/messages/${messageId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ emoji }) }).catch(() => null)
    if (!r?.ok && activeIdRef.current) loadMessages(activeIdRef.current, { quiet: true })
  }, [patchEverywhere, loadMessages])

  const editMessage = useCallback(async (messageId: string, body: string) => {
    if (!body || messageId.startsWith('temp-')) return
    patchEverywhere(activeIdRef.current, (m) => m.id === messageId ? { ...m, body, edited_at: new Date().toISOString() } : m)
    const r = await fetch(`/api/messages/${messageId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body }) }).catch(() => null)
    if (!r?.ok && activeIdRef.current) loadMessages(activeIdRef.current, { quiet: true })
  }, [patchEverywhere, loadMessages])

  const deleteMessage = useCallback(async (messageId: string) => {
    if (!confirm('Delete this message?')) return
    patchEverywhere(activeIdRef.current, (m) => m.id === messageId ? { ...m, body: '', deleted_at: new Date().toISOString() } : m)
    const r = await fetch(`/api/messages/${messageId}`, { method: 'DELETE' }).catch(() => null)
    if (!r?.ok && activeIdRef.current) loadMessages(activeIdRef.current, { quiet: true })
  }, [patchEverywhere, loadMessages])

  const openThread = useCallback((m: Message) => { setThreadParent(m); if (activeId) loadThread(activeId, m.id) }, [activeId, loadThread])

  const createConversation = useCallback(async (payload: any) => {
    const r = await fetch('/api/conversations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
    if (r.ok) { const d = await r.json(); await loadConversations(); setActiveId(d.conversationId); setModal(null) }
    else { const d = await r.json().catch(() => ({})); alert(d.error || 'Could not create') }
  }, [loadConversations])

  const channels = conversations.filter(c => c.type === 'channel' || c.type === 'group')
  const dms = conversations.filter(c => c.type === 'dm')
  const inbox = conversations.filter(c => c.type === 'customer')
  const nameById = useMemo(() => Object.fromEntries(dir.map(u => [u.id, u.name])), [dir])
  // Last own message in the open conversation — used by ↑-to-edit in the composer.
  const lastOwnMessage = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) { const m = messages[i]; if (m.sender_user_id === user.id && !m.deleted_at && !m.status) return { id: m.id, body: m.body } }
    return null
  }, [messages, user.id])
  // Deleted thread replies vanish too.
  const visibleThread = useMemo(() => threadMessages.filter(m => !m.deleted_at), [threadMessages])

  return (
    <div style={{ flex: 1, display: 'flex', overflow: 'hidden', background: T.bg }}>
      {/* Sidebar — full-width on mobile, hidden once a conversation is open */}
      <div style={{ width: isMobile ? '100%' : 270, flexShrink: 0, background: T.bg2, borderRight: isMobile ? 'none' : `1px solid ${T.border}`, display: (isMobile && active) ? 'none' : 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '12px 14px', borderBottom: `1px solid ${T.border}` }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <span style={{ fontSize: 14, fontWeight: 600 }}>Messages</span>
            {totalUnread > 0 && <span style={{ fontSize: 11, fontFamily: 'monospace', background: T.red, color: '#fff', borderRadius: 10, padding: '1px 7px' }}>{totalUnread}</span>}
          </div>
          <StatusControl prefs={prefs} onUpdate={updatePrefs} />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search messages…"
            style={{ width: '100%', padding: '6px 9px', background: T.bg3, border: `1px solid ${T.border}`, borderRadius: 6, color: T.text, fontSize: 12, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' }} />
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
          {searchResults !== null ? (
            <div style={{ padding: '4px 0' }}>
              <div style={{ padding: '4px 16px', fontSize: 10, color: T.text3, textTransform: 'uppercase', letterSpacing: '0.08em' }}>{searchResults.length} result{searchResults.length === 1 ? '' : 's'}</div>
              {searchResults.map(r => (
                <button key={r.id} onClick={() => { setActiveId(r.conversationId); setSearch(''); setSearchResults(null) }} style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 16px', border: 'none', background: 'transparent', cursor: 'pointer', fontFamily: 'inherit' }}>
                  <div style={{ fontSize: 11, color: T.text3 }}>{r.conversationName} · {r.senderName}</div>
                  <div style={{ fontSize: 12, color: T.text2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.body}</div>
                </button>
              ))}
            </div>
          ) : loadingConvs ? <div style={{ padding: 20, color: T.text3, fontSize: 12 }}>Loading…</div> : (
            <>
              <SidebarSection title="Channels" onAdd={() => setModal('channel')}>
                {channels.length === 0 && <Hint>No channels yet</Hint>}
                {channels.map(c => <ConvRow key={c.id} c={c} meId={user.id} online={online} awayIds={awayIds} active={c.id === activeId} onClick={() => setActiveId(c.id)} />)}
              </SidebarSection>
              <SidebarSection title="Direct messages" onAdd={() => setModal('dm')}>
                {dms.length === 0 && <Hint>No direct messages</Hint>}
                {dms.map(c => <ConvRow key={c.id} c={c} meId={user.id} online={online} awayIds={awayIds} active={c.id === activeId} onClick={() => setActiveId(c.id)} />)}
              </SidebarSection>
              {inbox.length > 0 && (
                <SidebarSection title="Customer inbox">
                  {inbox.map(c => <ConvRow key={c.id} c={c} meId={user.id} online={online} awayIds={awayIds} active={c.id === activeId} onClick={() => setActiveId(c.id)} />)}
                </SidebarSection>
              )}
            </>
          )}
        </div>
      </div>

      {/* Thread/main — on mobile shown only when a conversation is open */}
      <div style={{ flex: 1, display: (isMobile && !active) ? 'none' : 'flex', overflow: 'hidden' }}>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {!active ? (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: T.text3, fontSize: 13 }}>Select a conversation, or start a new one.</div>
          ) : (
            <>
              <div style={{ height: 52, flexShrink: 0, borderBottom: `1px solid ${T.border}`, display: 'flex', alignItems: 'center', padding: isMobile ? '0 12px' : '0 18px', gap: 8 }}>
                {isMobile && (
                  <button onClick={() => setActiveId(null)} aria-label="Back to conversations"
                    style={{ background: 'none', border: 'none', color: T.text2, fontSize: 22, lineHeight: 1, cursor: 'pointer', padding: '4px 6px 4px 0', marginLeft: -2 }}>‹</button>
                )}
                <span style={{ color: T.text3 }}>{convGlyph(active)}</span>
                <span style={{ fontSize: 14, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{convTitle(active)}</span>
                {headerPresence(active, user.id, online, awayIds)}
                {active.topic && <span style={{ fontSize: 12, color: T.text3, marginLeft: 8, borderLeft: `1px solid ${T.border}`, paddingLeft: 8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{active.topic}</span>}
                {active.type !== 'dm' && <span style={{ marginLeft: 'auto', fontSize: 11, color: T.text3, flexShrink: 0 }}>{active.memberIds.length} member{active.memberIds.length === 1 ? '' : 's'}</span>}
              </div>
              <MessageList key={active.id} messages={messages} loading={loadingMsgs} meId={user.id} nameById={nameById}
                conv={active} online={online} awayIds={awayIds} dividerTs={dividerTs} hasMore={hasMore} loadingOlder={loadingOlder}
                onLoadOlder={() => loadOlder(active.id)} onRetry={retrySend}
                onReact={toggleReaction} onEdit={editMessage} onDelete={deleteMessage} onOpenThread={openThread} />
              {typers.length > 0 && <TypingLine names={typers.map(t => t.name)} />}
              <Composer key={active.id} draftKey={active.id} dir={dir.filter(u => u.id !== user.id)} onSend={(b, m, f) => sendMessage(b, m, f)} onTyping={() => typingRef.current?.setTyping(true)} placeholder={`Message ${convTitle(active)}`} lastOwnMessage={lastOwnMessage} onEditSubmit={editMessage} />
            </>
          )}
        </div>

        {/* Thread panel — side panel on desktop, full-screen overlay on mobile */}
        {threadParent && active && (
          <div style={isMobile
            ? { position: 'fixed', inset: 0, zIndex: 950, background: T.bg2, display: 'flex', flexDirection: 'column' }
            : { width: 380, flexShrink: 0, borderLeft: `1px solid ${T.border}`, background: T.bg2, display: 'flex', flexDirection: 'column' }}>
            <div style={{ height: 52, flexShrink: 0, borderBottom: `1px solid ${T.border}`, display: 'flex', alignItems: 'center', padding: '0 14px', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>Thread</span>
              <button onClick={() => setThreadParent(null)} style={{ background: 'none', border: 'none', color: T.text2, fontSize: 18, cursor: 'pointer' }}>×</button>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 12 }}>
              <MessageRow m={threadParent} mine={threadParent.sender_user_id === user.id} meId={user.id} nameById={nameById} online={online} awayIds={awayIds} onReact={toggleReaction} onEdit={editMessage} onDelete={deleteMessage} onRetry={retrySend} compact />
              <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: 8, fontSize: 10, color: T.text3 }}>{visibleThread.length} repl{visibleThread.length === 1 ? 'y' : 'ies'}</div>
              {visibleThread.map(m => <MessageRow key={m.id} m={m} mine={m.sender_user_id === user.id} meId={user.id} nameById={nameById} online={online} awayIds={awayIds} onReact={toggleReaction} onEdit={editMessage} onDelete={deleteMessage} onRetry={retrySend} compact />)}
            </div>
            <Composer key={'thread-' + threadParent.id} draftKey={'thread:' + threadParent.id} dir={dir.filter(u => u.id !== user.id)} onSend={(b, m, f) => sendMessage(b, m, f, threadParent.id)} onTyping={() => {}} placeholder="Reply…" />
          </div>
        )}
      </div>

      {modal && <NewConversationModal kind={modal} dir={dir.filter(u => u.id !== user.id)} onClose={() => setModal(null)} onCreate={createConversation} />}
    </div>
  )
}

// ── Sidebar pieces ───────────────────────────────────────────────────
function SidebarSection({ title, onAdd, children }: { title: string; onAdd?: () => void; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 16px' }}>
        <span style={{ fontSize: 10, color: T.text3, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em' }}>{title}</span>
        {onAdd && <button onClick={onAdd} title={`New ${title}`} style={{ background: 'none', border: 'none', color: T.text3, cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: 0 }}>+</button>}
      </div>
      {children}
    </div>
  )
}
function Hint({ children }: { children: React.ReactNode }) { return <div style={{ padding: '4px 16px', fontSize: 11, color: T.text3, fontStyle: 'italic' }}>{children}</div> }
function convGlyph(c: Conversation) { return c.type === 'dm' ? '@' : c.type === 'customer' ? '☎' : c.is_private || c.type === 'group' ? '🔒' : '#' }
function convTitle(c: Conversation) { return c.displayName || c.name || (c.type === 'dm' ? 'Direct message' : 'Untitled') }
// The other member of a 1:1 DM (for presence dots / "Active now").
function dmOtherId(c: Conversation, meId: string): string | null { return c.type === 'dm' ? (c.memberIds.find(id => id !== meId) || null) : null }
function headerPresence(c: Conversation, meId: string, online: Set<string>, awayIds: Set<string>) {
  const other = dmOtherId(c, meId)
  if (other && online.has(other)) {
    const away = awayIds.has(other)
    return <span style={{ fontSize: 11, color: away ? T.amber : T.green, marginLeft: 8, display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}><Dot on away={away} /> {away ? 'Away' : 'Active now'}</span>
  }
  return null
}
function Dot({ on, away }: { on?: boolean; away?: boolean }) { return <span style={{ width: 7, height: 7, borderRadius: '50%', background: on ? (away ? T.amber : T.green) : T.text3, display: 'inline-block', flexShrink: 0 }} /> }

function ConvRow({ c, active, meId, online, awayIds, onClick }: { c: Conversation; active: boolean; meId: string; online: Set<string>; awayIds: Set<string>; onClick: () => void }) {
  const other = dmOtherId(c, meId)
  const isOnline = !!other && online.has(other)
  const isAway = !!other && awayIds.has(other)
  return (
    <button onClick={onClick} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', padding: '6px 16px', border: 'none', cursor: 'pointer', fontFamily: 'inherit', background: active ? 'rgba(79,142,247,0.12)' : 'transparent', color: active ? T.text : (c.unread ? T.text : T.text2) }}>
      {c.type === 'dm'
        ? <span style={{ position: 'relative', width: 12, display: 'flex', justifyContent: 'center', flexShrink: 0 }}><Dot on={isOnline} away={isAway} /></span>
        : <span style={{ color: T.text3, width: 12, textAlign: 'center', fontSize: 12, flexShrink: 0 }}>{convGlyph(c)}</span>}
      <span style={{ flex: 1, fontSize: 13, fontWeight: c.unread ? 600 : 400, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{convTitle(c)}</span>
      {c.unread > 0 && <span style={{ fontSize: 10, fontFamily: 'monospace', background: T.red, color: '#fff', borderRadius: 10, padding: '0 6px' }}>{c.unread}</span>}
    </button>
  )
}

// Availability + working-hours control. Sets your "away" status (which others
// see as an amber dot) and an optional working-hours window; outside it, message
// alerts are silenced — you still get the bell badge, just no push/sound/pop-up.
const DAY_CHIPS: { d: number; label: string }[] = [
  { d: 1, label: 'M' }, { d: 2, label: 'T' }, { d: 3, label: 'W' }, { d: 4, label: 'T' }, { d: 5, label: 'F' }, { d: 6, label: 'S' }, { d: 0, label: 'S' },
]
function StatusControl({ prefs, onUpdate }: { prefs: UserPreferences; onUpdate: (patch: Partial<UserPreferences>) => Promise<void> }) {
  const [open, setOpen] = useState(false)
  const away = !!prefs.messages_away
  const quiet = !!prefs.messages_quiet_enabled
  const days = prefs.messages_work_days || [1, 2, 3, 4, 5]
  const set = (patch: Partial<UserPreferences>) => { onUpdate(patch).catch(() => {}) }
  const toggleDay = (d: number) => set({ messages_work_days: days.includes(d) ? days.filter(x => x !== d) : [...days, d].sort((a, b) => a - b) })
  const tInp: React.CSSProperties = { background: T.bg2, border: `1px solid ${T.border2}`, borderRadius: 6, color: T.text, fontSize: 12, fontFamily: 'inherit', padding: '5px 7px', outline: 'none', colorScheme: 'dark' }

  return (
    <div style={{ position: 'relative', marginBottom: 8 }}>
      <button onClick={() => setOpen(o => !o)} style={{ display: 'flex', alignItems: 'center', gap: 7, width: '100%', padding: '6px 9px', background: T.bg3, border: `1px solid ${T.border}`, borderRadius: 6, color: T.text2, fontSize: 12, fontFamily: 'inherit', cursor: 'pointer' }}>
        <Dot on away={away} />
        <span style={{ color: T.text }}>{away ? 'Away' : 'Active'}</span>
        {quiet && !away && <span style={{ fontSize: 10, color: T.text3 }}>· work hours only</span>}
        <span style={{ marginLeft: 'auto', color: T.text3, fontSize: 10 }}>▾</span>
      </button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
          <div style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 41, background: T.bg4, border: `1px solid ${T.border2}`, borderRadius: 10, padding: 12, boxShadow: '0 12px 34px rgba(0,0,0,0.5)' }}>
            <div style={{ fontSize: 10, color: T.text3, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>Availability</div>
            <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
              {[{ k: false, label: 'Active', c: T.green }, { k: true, label: 'Away', c: T.amber }].map(o => (
                <button key={String(o.k)} onClick={() => set({ messages_away: o.k })}
                  style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '7px 0', borderRadius: 7, cursor: 'pointer', fontSize: 12, fontFamily: 'inherit', fontWeight: 600, border: `1px solid ${away === o.k ? o.c : T.border2}`, background: away === o.k ? `${o.c}22` : 'transparent', color: away === o.k ? o.c : T.text2 }}>
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: o.c }} />{o.label}
                </button>
              ))}
            </div>
            {away && <div style={{ fontSize: 11, color: T.text3, marginBottom: 10, lineHeight: 1.5 }}>You won’t get message pop-ups, sounds or push while away. Messages still arrive — you’ll see the unread badge.</div>}

            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: T.text, cursor: 'pointer', marginBottom: quiet ? 10 : 0 }}>
              <input type="checkbox" checked={quiet} onChange={e => set({ messages_quiet_enabled: e.target.checked })} />
              Only notify during work hours
            </label>
            {quiet && (
              <div style={{ paddingLeft: 2 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                  <span style={{ fontSize: 11, color: T.text3 }}>From</span>
                  <input type="time" value={prefs.messages_work_start} onChange={e => set({ messages_work_start: e.target.value })} style={tInp} />
                  <span style={{ fontSize: 11, color: T.text3 }}>to</span>
                  <input type="time" value={prefs.messages_work_end} onChange={e => set({ messages_work_end: e.target.value })} style={tInp} />
                </div>
                <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
                  {DAY_CHIPS.map(c => {
                    const on = days.includes(c.d)
                    return <button key={c.d} onClick={() => toggleDay(c.d)} title={['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][c.d]}
                      style={{ flex: 1, padding: '6px 0', borderRadius: 6, cursor: 'pointer', fontSize: 11, fontWeight: 600, fontFamily: 'inherit', border: `1px solid ${on ? T.blue : T.border2}`, background: on ? 'rgba(79,142,247,0.18)' : 'transparent', color: on ? T.blue : T.text3 }}>{c.label}</button>
                  })}
                </div>
                <div style={{ fontSize: 11, color: T.text3, lineHeight: 1.5 }}>Outside these hours, message alerts are silenced (using your {prefs.timezone} time). You’ll still see unread badges.</div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function TypingLine({ names }: { names: string[] }) {
  return (
    <div style={{ padding: '2px 18px 4px', fontSize: 11, color: T.text3, fontStyle: 'italic', display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{ display: 'inline-flex', gap: 2 }}>
        {[0, 1, 2].map(i => <span key={i} style={{ width: 4, height: 4, borderRadius: '50%', background: T.text3, animation: `chatDot 1s ${i * 0.15}s infinite ease-in-out` }} />)}
      </span>
      {names.join(', ')} {names.length === 1 ? 'is' : 'are'} typing…
      <style>{`@keyframes chatDot{0%,80%,100%{opacity:.25;transform:translateY(0)}40%{opacity:1;transform:translateY(-2px)}}`}</style>
    </div>
  )
}

// ── Avatars ─────────────────────────────────────────────────────────
function initials(name: string): string {
  const parts = (name || '?').trim().split(/\s+/)
  return ((parts[0]?.[0] || '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() || '?'
}
function colorFor(id: string | null): string {
  let h = 0; for (const ch of (id || 'x')) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return AVATAR_COLORS[h % AVATAR_COLORS.length]
}
function Avatar({ id, name, online, away, size = 28 }: { id: string | null; name: string; online?: boolean; away?: boolean; size?: number }) {
  return (
    <span style={{ position: 'relative', flexShrink: 0, width: size, height: size }}>
      <span style={{ width: size, height: size, borderRadius: '50%', background: colorFor(id), color: '#fff', fontSize: size * 0.38, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{initials(name)}</span>
      {online && <span style={{ position: 'absolute', bottom: -1, right: -1, width: 9, height: 9, borderRadius: '50%', background: away ? T.amber : T.green, border: `2px solid ${T.bg}` }} />}
    </span>
  )
}

// ── Message list + row ───────────────────────────────────────────────
interface RowActions {
  onReact: (id: string, emoji: string) => void
  onEdit: (id: string, body: string) => void
  onDelete: (id: string) => void
  onRetry?: (clientId: string) => void
  onOpenThread?: (m: Message) => void
}
function dayKey(iso: string) { const d = new Date(iso); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}` }
function dayLabel(iso: string) {
  const d = new Date(iso); const now = new Date()
  const ymd = (x: Date) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`
  const yest = new Date(now); yest.setDate(now.getDate() - 1)
  if (ymd(d) === ymd(now)) return 'Today'
  if (ymd(d) === ymd(yest)) return 'Yesterday'
  return d.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' })
}

function MessageList({ messages: messagesRaw, loading, meId, nameById, conv, online, awayIds, dividerTs, hasMore, loadingOlder, onLoadOlder, onReact, onEdit, onDelete, onRetry, onOpenThread }: { messages: Message[]; loading: boolean; meId: string; nameById: Record<string, string>; conv: Conversation; online: Set<string>; awayIds: Set<string>; dividerTs: string | null; hasMore: boolean; loadingOlder: boolean; onLoadOlder: () => void } & RowActions) {
  // Deleted messages vanish entirely (no tombstone). Memoised so scroll/effects
  // keep a stable array reference between unrelated renders.
  const messages = useMemo(() => messagesRaw.filter(m => !m.deleted_at), [messagesRaw])
  const ref = useRef<HTMLDivElement | null>(null)
  const atBottom = useRef(true)
  const meta = useRef<{ firstId?: string; lastId?: string; len: number }>({ len: 0 })
  const prependFrom = useRef<number | null>(null)   // scrollHeight captured before load-older
  const [newCount, setNewCount] = useState(0)

  const onScroll = useCallback(() => {
    const el = ref.current; if (!el) return
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    if (atBottom.current && newCount) setNewCount(0)
    if (el.scrollTop < 80 && hasMore && !loadingOlder) { prependFrom.current = el.scrollHeight; onLoadOlder() }
  }, [hasMore, loadingOlder, onLoadOlder, newCount])

  useIsoEffect(() => {
    const el = ref.current; if (!el) return
    const firstId = messages[0]?.id
    const lastMsg = messages[messages.length - 1]
    const prev = meta.current
    meta.current = { firstId, lastId: lastMsg?.id, len: messages.length }
    if (prev.len === 0) { el.scrollTop = el.scrollHeight; return }  // first paint
    // Older messages prepended → keep the viewport anchored where it was.
    if (prependFrom.current != null && prev.firstId !== firstId && messages.length > prev.len) {
      el.scrollTop = el.scrollHeight - prependFrom.current; prependFrom.current = null; return
    }
    // New message at the bottom.
    if (lastMsg && lastMsg.id !== prev.lastId) {
      if (lastMsg.sender_user_id === meId || atBottom.current) { el.scrollTop = el.scrollHeight; setNewCount(0) }
      else setNewCount(c => c + 1)
    } else if (atBottom.current) {
      el.scrollTop = el.scrollHeight   // height grew while pinned (e.g. image loaded / edit)
    }
  }, [messages, meId])

  // Read receipt on my last confirmed message.
  const receipt = useMemo(() => {
    let last: Message | null = null
    for (let i = messages.length - 1; i >= 0; i--) { const m = messages[i]; if (m.sender_user_id === meId && !m.deleted_at && !m.status) { last = m; break } }
    if (!last) return null
    const others = conv.memberIds.filter(id => id !== meId)
    const seenBy = others.filter(id => { const r = conv.readState[id]; return r && r >= last!.created_at })
    if (conv.type === 'dm') return { id: last.id, text: seenBy.length ? 'Seen' : 'Sent' }
    if (seenBy.length) return { id: last.id, text: `Seen by ${seenBy.length}` }
    return { id: last.id, text: 'Sent' }
  }, [messages, meId, conv])

  if (loading && messages.length === 0) return <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: T.text3, fontSize: 12 }}>Loading messages…</div>

  let lastDay = ''
  let newLineShown = false
  let prev: Message | null = null
  return (
    <div style={{ position: 'relative', flex: 1, overflow: 'hidden', display: 'flex' }}>
      <div ref={ref} onScroll={onScroll} style={{ flex: 1, overflowY: 'auto', padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: 2 }}>
        {loadingOlder && <div style={{ textAlign: 'center', fontSize: 11, color: T.text3, padding: 6 }}>Loading earlier messages…</div>}
        {messages.length === 0 && <div style={{ color: T.text3, fontSize: 12, textAlign: 'center', marginTop: 30 }}>No messages yet — say hello.</div>}
        {messages.map(m => {
          const dk = dayKey(m.created_at)
          const showDay = dk !== lastDay; lastDay = dk
          const showNew = !newLineShown && !!dividerTs && m.created_at > dividerTs && m.sender_user_id !== meId
          if (showNew) newLineShown = true
          const continued = !showDay && !showNew && !!prev && prev.sender_user_id === m.sender_user_id && !!m.sender_user_id
            && (new Date(m.created_at).getTime() - new Date(prev.created_at).getTime() < 5 * 60 * 1000)
          prev = m
          return (
            <div key={m.id}>
              {showDay && <DayDivider label={dayLabel(m.created_at)} />}
              {showNew && <NewDivider />}
              <MessageRow m={m} mine={m.sender_user_id === meId} meId={meId} nameById={nameById} online={online} awayIds={awayIds} grouped={continued}
                receipt={receipt && receipt.id === m.id ? receipt.text : undefined}
                onReact={onReact} onEdit={onEdit} onDelete={onDelete} onRetry={onRetry} onOpenThread={onOpenThread} />
            </div>
          )
        })}
      </div>
      {newCount > 0 && (
        <button onClick={() => { const el = ref.current; if (el) el.scrollTop = el.scrollHeight; setNewCount(0) }}
          style={{ position: 'absolute', bottom: 12, left: '50%', transform: 'translateX(-50%)', background: T.blue, color: '#fff', border: 'none', borderRadius: 16, padding: '6px 14px', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', boxShadow: '0 4px 14px rgba(0,0,0,0.4)', zIndex: 5 }}>
          ↓ {newCount} new message{newCount === 1 ? '' : 's'}
        </button>
      )}
    </div>
  )
}

function DayDivider({ label }: { label: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '12px 0 8px' }}>
      <span style={{ flex: 1, height: 1, background: T.border }} />
      <span style={{ fontSize: 10.5, color: T.text3, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</span>
      <span style={{ flex: 1, height: 1, background: T.border }} />
    </div>
  )
}
function NewDivider() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '8px 0' }}>
      <span style={{ flex: 1, height: 1, background: `${T.red}66` }} />
      <span style={{ fontSize: 10, color: T.red, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>New</span>
      <span style={{ flex: 1, height: 1, background: `${T.red}66` }} />
    </div>
  )
}

function MessageRow({ m, mine, meId, nameById, online, awayIds, grouped, receipt, onReact, onEdit, onDelete, onRetry, onOpenThread, compact }: { m: Message; mine: boolean; meId: string; nameById: Record<string, string>; online: Set<string>; awayIds?: Set<string>; grouped?: boolean; receipt?: string; compact?: boolean } & RowActions) {
  const isMobile = useIsMobile()
  const [hover, setHover] = useState(false)
  const [picker, setPicker] = useState<false | 'quick' | 'full'>(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(m.body)
  useEffect(() => { setDraft(m.body) }, [m.body])
  const deleted = !!m.deleted_at
  const isOnline = !!m.sender_user_id && online.has(m.sender_user_id)
  const isAway = !!m.sender_user_id && !!awayIds?.has(m.sender_user_id)
  const showHeader = !grouped && !compact
  const time = new Date(m.created_at).toLocaleString('en-AU', { hour: '2-digit', minute: '2-digit' })

  return (
    <div
      onMouseEnter={() => { if (!isMobile) setHover(true) }}
      onMouseLeave={() => { if (!isMobile) { setHover(false); setPicker(false) } }}
      style={{ display: 'flex', flexDirection: mine ? 'row-reverse' : 'row', gap: 8, alignItems: 'flex-end', marginTop: grouped ? 1 : (compact ? 0 : 8), opacity: m.status === 'sending' ? 0.7 : 1 }}>
      {/* Avatar gutter — only for others, only on the first of a group */}
      {!mine && !compact && (showHeader
        ? <Avatar id={m.sender_user_id} name={m.senderName} online={isOnline} away={isAway} />
        : <span style={{ width: 28, flexShrink: 0 }} />)}

      <div style={{ position: 'relative', maxWidth: compact ? '100%' : '78%', display: 'flex', flexDirection: 'column', alignItems: mine ? 'flex-end' : 'flex-start' }}>
        {showHeader && (
          <div style={{ fontSize: 10, color: T.text3, marginBottom: 3 }}>
            <span style={{ color: mine ? T.blue : T.teal, fontWeight: 600 }}>{mine ? 'You' : m.senderName}</span>
            <span style={{ marginLeft: 6 }}>{time}</span>
            {m.edited_at && !deleted && <span style={{ marginLeft: 6, fontStyle: 'italic' }}>(edited)</span>}
          </div>
        )}

        <div style={{ position: 'relative' }}>
          {/* Hover toolbar */}
          {hover && !deleted && !editing && !m.status && (
            <div style={{ position: 'absolute', top: -14, [mine ? 'right' : 'left']: 0, display: 'flex', gap: 2, background: T.bg4, border: `1px solid ${T.border2}`, borderRadius: 6, padding: 2, zIndex: 3 } as any}>
              <IconBtn title="React" onClick={() => setPicker(p => p ? false : 'quick')}>🙂</IconBtn>
              {onOpenThread && <IconBtn title="Reply in thread" onClick={() => onOpenThread(m)}>↳</IconBtn>}
              {mine && <IconBtn title="Edit" onClick={() => setEditing(true)}>✎</IconBtn>}
              {mine && <IconBtn title="Delete" onClick={() => onDelete(m.id)}>🗑</IconBtn>}
            </div>
          )}
          {picker === 'quick' && (
            <div style={{ position: 'absolute', top: -40, [mine ? 'right' : 'left']: 0, display: 'flex', gap: 2, background: T.bg4, border: `1px solid ${T.border2}`, borderRadius: 8, padding: 4, zIndex: 4, alignItems: 'center' } as any}>
              {QUICK_EMOJI.map(e => <button key={e} onClick={() => { onReact(m.id, e); setPicker(false) }} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, padding: 2 }}>{e}</button>)}
              <button onClick={() => setPicker('full')} title="More…" style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, padding: '2px 4px', color: T.text2 }}>＋</button>
            </div>
          )}
          {picker === 'full' && (
            <div style={{ position: 'absolute', top: -8, [mine ? 'right' : 'left']: 0, transform: 'translateY(-100%)', zIndex: 6 } as any}>
              <EmojiPicker onPick={(e) => { onReact(m.id, e); setPicker(false) }} onClose={() => setPicker(false)} />
            </div>
          )}

          <div
            onClick={() => { if (isMobile && !editing && !deleted && !m.status) setHover(h => !h) }}
            style={{ background: mine ? 'rgba(79,142,247,0.16)' : T.bg3, border: `1px solid ${mine ? 'rgba(79,142,247,0.3)' : T.border}`, borderRadius: 10, padding: '8px 12px', fontSize: 13, lineHeight: 1.5, color: T.text, wordBreak: 'break-word', cursor: isMobile && !editing && !deleted ? 'pointer' : 'default' }}>
            {deleted ? <span style={{ color: T.text3, fontStyle: 'italic' }}>message deleted</span> : editing ? (
              <div>
                <textarea value={draft} onChange={e => setDraft(e.target.value)} rows={2} autoFocus
                  onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onEdit(m.id, draft.trim()); setEditing(false) } if (e.key === 'Escape') { setEditing(false); setDraft(m.body) } }}
                  style={{ width: 260, maxWidth: '100%', background: T.bg2, border: `1px solid ${T.border2}`, borderRadius: 6, color: T.text, fontSize: 13, fontFamily: 'inherit', padding: 6, boxSizing: 'border-box' }} />
                <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                  <button onClick={() => { onEdit(m.id, draft.trim()); setEditing(false) }} style={miniBtn(T.blue, true)}>Save</button>
                  <button onClick={() => { setEditing(false); setDraft(m.body) }} style={miniBtn(T.text3)}>Cancel</button>
                </div>
              </div>
            ) : <span dangerouslySetInnerHTML={{ __html: mdToHtml(m.body, nameById) }} />}
            {m.attachments?.map((a, i) => <AttachmentView key={a.id || a.storage_path || i} att={a} sending={m.status === 'sending'} />)}
          </div>

          {/* Reactions */}
          {m.reactions?.length > 0 && (
            <div style={{ display: 'flex', gap: 4, marginTop: 4, flexWrap: 'wrap', justifyContent: mine ? 'flex-end' : 'flex-start' }}>
              {m.reactions.map(r => (
                <button key={r.emoji} onClick={() => onReact(m.id, r.emoji)} style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 11, padding: '1px 7px', borderRadius: 10, cursor: 'pointer', fontFamily: 'inherit', background: r.mine ? 'rgba(79,142,247,0.18)' : T.bg3, border: `1px solid ${r.mine ? T.blue : T.border}`, color: T.text2 }}>
                  <span>{r.emoji}</span><span style={{ fontFamily: 'monospace' }}>{r.count}</span>
                </button>
              ))}
            </div>
          )}

          {/* Thread affordance */}
          {!compact && onOpenThread && m.replyCount > 0 && (
            <button onClick={() => onOpenThread(m)} style={{ marginTop: 4, background: 'none', border: 'none', color: T.blue, fontSize: 11, cursor: 'pointer', fontFamily: 'inherit', alignSelf: mine ? 'flex-end' : 'flex-start' }}>
              ↳ {m.replyCount} repl{m.replyCount === 1 ? 'y' : 'ies'}
            </button>
          )}

          {/* Status / receipt (own messages) */}
          {mine && m.status === 'sending' && <span style={{ fontSize: 9.5, color: T.text3, marginTop: 2, alignSelf: 'flex-end' }}>Sending…</span>}
          {mine && m.status === 'failed' && (
            <span style={{ fontSize: 9.5, color: T.red, marginTop: 2, alignSelf: 'flex-end' }}>
              Failed · {onRetry && m.clientId ? <button onClick={() => onRetry(m.clientId!)} style={{ background: 'none', border: 'none', color: T.red, textDecoration: 'underline', cursor: 'pointer', fontSize: 9.5, padding: 0, fontFamily: 'inherit' }}>Retry</button> : 'tap to retry'}
            </span>
          )}
          {mine && !m.status && receipt && <span style={{ fontSize: 9.5, color: receipt.startsWith('Seen') ? T.blue : T.text3, marginTop: 2, alignSelf: 'flex-end' }}>{receipt}</span>}
        </div>
      </div>
    </div>
  )
}

function IconBtn({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return <button title={title} onClick={onClick} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, padding: '2px 5px', color: T.text2 }}>{children}</button>
}
function miniBtn(color: string, solid?: boolean): React.CSSProperties { return { padding: '3px 10px', borderRadius: 5, fontSize: 11, fontFamily: 'inherit', fontWeight: 600, cursor: 'pointer', border: 'none', background: solid ? color : 'transparent', color: solid ? '#fff' : color } }

// Markdown-ish → HTML (escaped). Handles links, **bold**, *italic*, `code`, @mention.
function mdToHtml(text: string, nameById: Record<string, string>): string {
  let s = (text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  s = s.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noreferrer" style="color:#4f8ef7">$1</a>')
  s = s.replace(/`([^`]+)`/g, '<code style="background:var(--t-bg4);padding:1px 4px;border-radius:3px;font-family:monospace">$1</code>')
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
  s = s.replace(/(^|[\s(])_([^_\n]+)_/g, '$1<em>$2</em>')
  const names = Object.values(nameById)
  if (names.length) {
    const alt = names.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).sort((a, b) => b.length - a.length).join('|')
    s = s.replace(new RegExp(`@(${alt})`, 'g'), '<span style="color:#4f8ef7;background:rgba(79,142,247,0.12);border-radius:3px;padding:0 2px">@$1</span>')
  }
  return s.replace(/\n/g, '<br/>')
}

function AttachmentView({ att, sending }: { att: Attachment; sending?: boolean }) {
  const [url, setUrl] = useState<string | null>(att.localUrl || null)
  useEffect(() => {
    if (att.localUrl || !att.storage_path) return
    let live = true
    getSupabase().storage.from(ATTACH_BUCKET).createSignedUrl(att.storage_path, 3600).then(({ data }) => { if (live && data?.signedUrl) setUrl(data.signedUrl) })
    return () => { live = false }
  }, [att.storage_path, att.localUrl])
  const isImage = (att.content_type || '').startsWith('image/')
  if (!url) return <div style={{ marginTop: 6, fontSize: 11, color: T.text3 }}>📎 {att.filename || 'attachment'}{sending ? ' · uploading…' : ''}</div>
  if (isImage) return <a href={sending ? undefined : url} target="_blank" rel="noreferrer"><img src={url} alt={att.filename || ''} style={{ marginTop: 6, maxWidth: 280, maxHeight: 240, borderRadius: 6, display: 'block', opacity: sending ? 0.6 : 1 }} /></a>
  return <a href={url} target="_blank" rel="noreferrer" style={{ marginTop: 6, display: 'inline-block', fontSize: 12, color: T.blue }}>📎 {att.filename || 'Download attachment'}</a>
}

// ── Emoji picker ─────────────────────────────────────────────────────
// Curated set with keywords for search — enough for everyday reactions and
// composing without pulling in a heavyweight emoji dependency.
const EMOJI: { e: string; k: string }[] = [
  { e: '👍', k: 'thumbs up yes like approve' }, { e: '👎', k: 'thumbs down no dislike' }, { e: '❤️', k: 'heart love red' }, { e: '🔥', k: 'fire lit hot' },
  { e: '🎉', k: 'party tada celebrate' }, { e: '✅', k: 'check tick done yes' }, { e: '❌', k: 'cross no wrong' }, { e: '👀', k: 'eyes looking watch' },
  { e: '🙏', k: 'pray thanks please' }, { e: '💯', k: 'hundred perfect' }, { e: '😂', k: 'laugh joy lol haha' }, { e: '🤣', k: 'rofl laughing' },
  { e: '😅', k: 'sweat smile nervous' }, { e: '😊', k: 'smile happy blush' }, { e: '😍', k: 'love heart eyes' }, { e: '😎', k: 'cool sunglasses' },
  { e: '🤔', k: 'thinking hmm' }, { e: '😐', k: 'neutral meh' }, { e: '😬', k: 'grimace yikes' }, { e: '😢', k: 'cry sad tear' },
  { e: '😭', k: 'sob crying' }, { e: '😤', k: 'frustrated angry steam' }, { e: '😡', k: 'angry mad rage' }, { e: '🥳', k: 'party celebrate' },
  { e: '🤯', k: 'mind blown' }, { e: '😴', k: 'sleep tired zzz' }, { e: '🤝', k: 'handshake deal agree' }, { e: '👏', k: 'clap applause' },
  { e: '🙌', k: 'raised hands praise' }, { e: '💪', k: 'muscle strong flex' }, { e: '🤞', k: 'fingers crossed luck' }, { e: '👌', k: 'ok perfect' },
  { e: '✌️', k: 'peace victory' }, { e: '🫡', k: 'salute yes sir' }, { e: '🙋', k: 'raising hand question' }, { e: '👋', k: 'wave hello hi bye' },
  { e: '💔', k: 'broken heart' }, { e: '💙', k: 'blue heart' }, { e: '💚', k: 'green heart' }, { e: '💛', k: 'yellow heart' },
  { e: '🧡', k: 'orange heart' }, { e: '💜', k: 'purple heart' }, { e: '⭐', k: 'star favourite' }, { e: '🌟', k: 'star glowing' },
  { e: '⚡', k: 'lightning fast bolt' }, { e: '💡', k: 'idea bulb light' }, { e: '✨', k: 'sparkles shiny' }, { e: '🚀', k: 'rocket launch ship' },
  { e: '🎯', k: 'target bullseye goal' }, { e: '📌', k: 'pin important' }, { e: '📎', k: 'paperclip attach' }, { e: '📝', k: 'memo note write' },
  { e: '✔️', k: 'check done' }, { e: '⏰', k: 'alarm clock time' }, { e: '⏳', k: 'hourglass wait' }, { e: '🔔', k: 'bell notify alert' },
  { e: '💰', k: 'money bag cash' }, { e: '💸', k: 'money flying spend' }, { e: '🛠️', k: 'tools fix workshop' }, { e: '🔧', k: 'wrench fix' },
  { e: '🚗', k: 'car auto' }, { e: '🚙', k: 'suv car' }, { e: '🛻', k: 'ute truck pickup' }, { e: '📦', k: 'box package parcel ship' },
  { e: '☕', k: 'coffee break' }, { e: '🍺', k: 'beer drink' }, { e: '🎂', k: 'cake birthday' },
  { e: '🥲', k: 'tear smile' }, { e: '😉', k: 'wink' }, { e: '😇', k: 'angel innocent' }, { e: '🤩', k: 'star struck wow' },
  { e: '😏', k: 'smirk' }, { e: '🙄', k: 'eye roll' }, { e: '😱', k: 'scream shock' }, { e: '🤗', k: 'hug' },
  { e: '🤷', k: 'shrug dunno' }, { e: '🫶', k: 'heart hands love' }, { e: '👑', k: 'crown king best' }, { e: '🏆', k: 'trophy win' },
].filter(x => x.k !== '')

function EmojiPicker({ onPick, onClose }: { onPick: (e: string) => void; onClose: () => void }) {
  const [q, setQ] = useState('')
  const list = q.trim() ? EMOJI.filter(x => x.k.includes(q.trim().toLowerCase())) : EMOJI
  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 1 }} />
      <div onClick={e => e.stopPropagation()} style={{ position: 'relative', zIndex: 2, width: 256, background: T.bg4, border: `1px solid ${T.border2}`, borderRadius: 10, padding: 8, boxShadow: '0 10px 30px rgba(0,0,0,0.5)' }}>
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search emoji…" autoFocus
          style={{ width: '100%', boxSizing: 'border-box', padding: '6px 8px', marginBottom: 6, background: T.bg2, border: `1px solid ${T.border2}`, borderRadius: 6, color: T.text, fontSize: 12, fontFamily: 'inherit', outline: 'none' }} />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2, maxHeight: 168, overflowY: 'auto' }}>
          {list.map(x => <button key={x.e} title={x.k} onClick={() => onPick(x.e)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, padding: 3, borderRadius: 6 }}>{x.e}</button>)}
          {list.length === 0 && <span style={{ gridColumn: '1 / -1', fontSize: 11, color: T.text3, padding: 8 }}>No matches.</span>}
        </div>
      </div>
    </>
  )
}

// ── Composer ─────────────────────────────────────────────────────────
function Composer({ dir, onSend, onTyping, placeholder, draftKey, lastOwnMessage, onEditSubmit }: { dir: DirUser[]; onSend: (body: string, mentionIds: string[], files: File[]) => void; onTyping: () => void; placeholder?: string; draftKey?: string; lastOwnMessage?: { id: string; body: string } | null; onEditSubmit?: (id: string, body: string) => void }) {
  const isMobile = useIsMobile()
  const draftLS = draftKey ? `chatdraft:${draftKey}` : null
  const [text, setText] = useState(() => { try { return draftLS && typeof localStorage !== 'undefined' ? (localStorage.getItem(draftLS) || '') : '' } catch { return '' } })
  const [files, setFiles] = useState<File[]>([])
  const [mentionPick, setMentionPick] = useState<{ query: string } | null>(null)
  const [picked, setPicked] = useState<DirUser[]>([])
  const [emoji, setEmoji] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)   // ↑-to-edit
  const taRef = useRef<HTMLTextAreaElement | null>(null)
  const lastTyping = useRef(0)

  // Persist the draft (debounced via effect) and auto-grow the textarea.
  useEffect(() => { try { if (draftLS) { if (text) localStorage.setItem(draftLS, text); else localStorage.removeItem(draftLS) } } catch {} }, [text, draftLS])
  useEffect(() => { const ta = taRef.current; if (ta) { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 140) + 'px' } }, [text])

  function onChange(v: string) {
    setText(v)
    const now = Date.now(); if (now - lastTyping.current > 1500) { lastTyping.current = now; onTyping() }
    const m = v.match(/@([\w' .-]*)$/)
    setMentionPick(m ? { query: m[1].toLowerCase() } : null)
  }
  function pickMention(u: DirUser) {
    setText(t => t.replace(/@([\w' .-]*)$/, `@${u.name} `))
    setPicked(p => p.some(x => x.id === u.id) ? p : [...p, u]); setMentionPick(null); taRef.current?.focus()
  }
  function insertEmoji(e: string) { setText(t => t + e); taRef.current?.focus() }
  function startEditLast() {
    if (!lastOwnMessage || !onEditSubmit) return
    setEditingId(lastOwnMessage.id); setText(lastOwnMessage.body); setTimeout(() => taRef.current?.focus(), 0)
  }
  function cancelEdit() { setEditingId(null); setText('') }

  function submit() {
    const body = text.trim()
    if (editingId) {
      if (body && onEditSubmit) onEditSubmit(editingId, body)
      setEditingId(null); setText(''); return
    }
    if (!body && files.length === 0) return
    const mentionIds = picked.filter(u => body.includes(`@${u.name}`)).map(u => u.id)
    onSend(body, mentionIds, files)       // optimistic — don't await; clear instantly
    setText(''); setFiles([]); setPicked([])
  }

  function addFiles(list: FileList | File[] | null) { if (list) setFiles(fs => [...fs, ...Array.from(list)]) }
  function onPaste(e: React.ClipboardEvent) {
    const imgs = Array.from(e.clipboardData?.items || []).filter(i => i.kind === 'file').map(i => i.getAsFile()).filter(Boolean) as File[]
    if (imgs.length) { e.preventDefault(); addFiles(imgs) }
  }

  const matches = mentionPick ? dir.filter(u => u.name.toLowerCase().includes(mentionPick.query)).slice(0, 6) : []

  return (
    <div
      onDragOver={e => { e.preventDefault() }}
      onDrop={e => { e.preventDefault(); addFiles(e.dataTransfer?.files || null) }}
      style={{ flexShrink: 0, borderTop: `1px solid ${T.border}`, padding: 12, paddingBottom: isMobile ? 'calc(12px + env(safe-area-inset-bottom))' : 12, position: 'relative', background: T.bg }}>
      {editingId && (
        <div style={{ fontSize: 11, color: T.amber, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
          ✎ Editing message <button onClick={cancelEdit} style={{ background: 'none', border: 'none', color: T.text3, cursor: 'pointer', fontSize: 11, fontFamily: 'inherit', textDecoration: 'underline', padding: 0 }}>cancel (esc)</button>
        </div>
      )}
      {matches.length > 0 && (
        <div style={{ position: 'absolute', bottom: '100%', left: 12, background: T.bg3, border: `1px solid ${T.border2}`, borderRadius: 8, marginBottom: 6, minWidth: 200, overflow: 'hidden', zIndex: 5 }}>
          {matches.map(u => <div key={u.id} onMouseDown={e => { e.preventDefault(); pickMention(u) }} style={{ padding: '7px 12px', fontSize: 13, cursor: 'pointer', color: T.text }}>@{u.name}</div>)}
        </div>
      )}
      {emoji && (
        <div style={{ position: 'absolute', bottom: '100%', left: 12, marginBottom: 6, zIndex: 6 }}>
          <EmojiPicker onPick={insertEmoji} onClose={() => setEmoji(false)} />
        </div>
      )}
      {files.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
          {files.map((f, i) => <span key={i} style={{ fontSize: 11, background: T.bg3, border: `1px solid ${T.border}`, borderRadius: 6, padding: '3px 8px', color: T.text2 }}>📎 {f.name} <button onClick={() => setFiles(fs => fs.filter((_, j) => j !== i))} style={{ background: 'none', border: 'none', color: T.text3, cursor: 'pointer' }}>×</button></span>)}
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        <label title="Attach files" style={{
          cursor: 'pointer', color: T.text3, fontSize: 20, flexShrink: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          width: isMobile ? 42 : 36, height: isMobile ? 42 : 36, borderRadius: 8,
          border: isMobile ? `1px solid ${T.border2}` : 'none', background: isMobile ? T.bg3 : 'transparent',
        }}>
          📎<input type="file" multiple style={{ display: 'none' }} onChange={e => { addFiles(e.target.files); e.target.value = '' }} />
        </label>
        <button title="Emoji" onClick={() => setEmoji(v => !v)} style={{
          cursor: 'pointer', color: T.text3, fontSize: 18, flexShrink: 0, background: isMobile ? T.bg3 : 'transparent',
          border: isMobile ? `1px solid ${T.border2}` : 'none', borderRadius: 8,
          width: isMobile ? 42 : 36, height: isMobile ? 42 : 36, display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>🙂</button>
        <textarea ref={taRef} value={text} onChange={e => onChange(e.target.value)} onPaste={onPaste}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() }
            else if (e.key === 'Escape' && editingId) { e.preventDefault(); cancelEdit() }
            else if (e.key === 'ArrowUp' && !text && !editingId && lastOwnMessage) { e.preventDefault(); startEditLast() }
          }}
          placeholder={placeholder || 'Write a message…'} rows={1}
          style={{ flex: 1, minWidth: 0, resize: 'none', maxHeight: 140, background: T.bg3, border: `1px solid ${editingId ? T.amber : T.border2}`, borderRadius: 8, color: T.text, fontSize: isMobile ? 16 : 13, fontFamily: 'inherit', padding: isMobile ? '11px 12px' : '9px 12px', outline: 'none', lineHeight: 1.5, boxSizing: 'border-box' }} />
        <button onClick={submit} style={{ flexShrink: 0, padding: isMobile ? '11px 16px' : '9px 16px', minHeight: isMobile ? 42 : undefined, borderRadius: 8, border: 'none', background: T.blue, color: '#fff', fontSize: isMobile ? 14 : 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>{editingId ? 'Save' : 'Send'}</button>
      </div>
    </div>
  )
}

// ── New conversation modal ───────────────────────────────────────────
function NewConversationModal({ kind, dir, onClose, onCreate }: { kind: 'channel' | 'dm'; dir: DirUser[]; onClose: () => void; onCreate: (payload: any) => void }) {
  const [name, setName] = useState('')
  const [isPrivate, setIsPrivate] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [q, setQ] = useState('')
  const filtered = dir.filter(u => u.name.toLowerCase().includes(q.toLowerCase()))
  const toggle = (id: string) => setSelected(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id])
  function submit() {
    if (kind === 'channel') { if (!name.trim()) return; onCreate({ type: 'channel', name, isPrivate, memberIds: selected }) }
    else { if (selected.length === 0) return; if (selected.length === 1) onCreate({ type: 'dm', dmUserId: selected[0] }); else onCreate({ type: 'group', name: name.trim() || null, memberIds: selected }) }
  }
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div onClick={e => e.stopPropagation()} style={{ width: '100%', maxWidth: 420, background: T.bg2, border: `1px solid ${T.border2}`, borderRadius: 12, padding: 20, maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 14 }}>{kind === 'channel' ? 'New channel' : 'New direct message'}</div>
        {kind === 'channel' && (
          <>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="Channel name (e.g. parts-team)" style={inp} autoFocus />
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, color: T.text2, margin: '10px 0 14px', cursor: 'pointer' }}>
              <input type="checkbox" checked={isPrivate} onChange={e => setIsPrivate(e.target.checked)} /> Private (invite-only)
            </label>
          </>
        )}
        <input value={q} onChange={e => setQ(e.target.value)} placeholder={kind === 'channel' ? 'Add members…' : 'Search people…'} style={{ ...inp, marginBottom: 8 }} autoFocus={kind === 'dm'} />
        <div style={{ flex: 1, overflowY: 'auto', border: `1px solid ${T.border}`, borderRadius: 8, maxHeight: 260 }}>
          {filtered.length === 0 && <div style={{ padding: 14, fontSize: 12, color: T.text3 }}>No matches.</div>}
          {filtered.map(u => (
            <label key={u.id} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '8px 12px', cursor: 'pointer', fontSize: 13, borderBottom: `1px solid ${T.border}` }}>
              <input type="checkbox" checked={selected.includes(u.id)} onChange={() => toggle(u.id)} />
              <Avatar id={u.id} name={u.name} size={22} />
              <span style={{ color: T.text }}>{u.name}</span>
              <span style={{ marginLeft: 'auto', fontSize: 10, color: T.text3 }}>{u.role}</span>
            </label>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
          <button onClick={onClose} style={{ padding: '8px 14px', borderRadius: 6, border: `1px solid ${T.border2}`, background: 'transparent', color: T.text2, fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' }}>Cancel</button>
          <button onClick={submit} style={{ padding: '8px 16px', borderRadius: 6, border: 'none', background: T.blue, color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
            {kind === 'channel' ? 'Create channel' : selected.length > 1 ? 'Create group' : 'Start DM'}
          </button>
        </div>
      </div>
    </div>
  )
}

const inp: React.CSSProperties = { width: '100%', padding: '8px 11px', background: T.bg3, border: `1px solid ${T.border2}`, borderRadius: 7, color: T.text, fontSize: 13, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' }
