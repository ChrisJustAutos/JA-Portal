-- ═══════════════════════════════════════════════════════════════════
-- 046_messaging_core.sql
-- Status: apply to Supabase project qtiscbvhlvdvafwtdtcd, then this file
-- is kept here for reference / disaster recovery.
--
-- Foundation for the portal-native chat platform (replaces Slack) + the
-- omnichannel customer inbox (WhatsApp / Messenger / Instagram). ONE messaging
-- core serves both: internal conversations (channel/dm/group) and external
-- customer conversations (type='customer', source=<provider>).
--
-- Security model:
--   • Clients read via the anon key + their user JWT — so RLS SELECT policies
--     are the boundary and ALSO gate Supabase Realtime delivery.
--   • All WRITES go through service-role API routes (validation + external
--     fan-out), so there are deliberately NO insert/update policies for
--     authenticated — service_role bypasses RLS.
--   • Recursion-safe membership checks via SECURITY DEFINER helpers.
-- ═══════════════════════════════════════════════════════════════════

-- ── Tables ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS conversations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type            TEXT NOT NULL CHECK (type IN ('channel','dm','group','customer')),
  name            TEXT,                 -- channels/groups; null for dm
  topic           TEXT,
  is_private      BOOLEAN NOT NULL DEFAULT FALSE,
  source          TEXT CHECK (source IN ('whatsapp','messenger','instagram')),  -- customer convos only
  external_thread_id TEXT,              -- provider conversation/sender id
  customer_id     UUID,                 -- optional link to workshop_customers
  assigned_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  last_message_at TIMESTAMPTZ DEFAULT NOW(),
  created_by      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  archived_at     TIMESTAMPTZ
);
-- One external thread per provider.
CREATE UNIQUE INDEX IF NOT EXISTS conversations_external_uidx
  ON conversations(source, external_thread_id) WHERE external_thread_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS conversations_type_idx ON conversations(type, last_message_at DESC);

CREATE TABLE IF NOT EXISTS conversation_participants (
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role            TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member','admin')),
  last_read_at    TIMESTAMPTZ DEFAULT NOW(),
  muted           BOOLEAN NOT NULL DEFAULT FALSE,
  joined_at       TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX IF NOT EXISTS conv_participants_user_idx ON conversation_participants(user_id);

CREATE TABLE IF NOT EXISTS conversation_messages (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id   UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_user_id    UUID REFERENCES auth.users(id) ON DELETE SET NULL,  -- null = system/external
  parent_message_id UUID REFERENCES conversation_messages(id) ON DELETE CASCADE,  -- threads
  body              TEXT NOT NULL DEFAULT '',
  message_type      TEXT NOT NULL DEFAULT 'user' CHECK (message_type IN ('user','system','external')),
  direction         TEXT CHECK (direction IN ('in','out')),   -- external only
  external_message_id TEXT,                                    -- provider message id / wamid
  edited_at         TIMESTAMPTZ,
  deleted_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS conv_messages_conv_idx ON conversation_messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS conv_messages_parent_idx ON conversation_messages(parent_message_id) WHERE parent_message_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS message_reactions (
  message_id UUID NOT NULL REFERENCES conversation_messages(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  emoji      TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (message_id, user_id, emoji)
);

CREATE TABLE IF NOT EXISTS message_attachments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id    UUID NOT NULL REFERENCES conversation_messages(id) ON DELETE CASCADE,
  storage_path  TEXT NOT NULL,
  filename      TEXT,
  content_type  TEXT,
  size_bytes    BIGINT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS message_attachments_msg_idx ON message_attachments(message_id);

CREATE TABLE IF NOT EXISTS message_mentions (
  message_id         UUID NOT NULL REFERENCES conversation_messages(id) ON DELETE CASCADE,
  mentioned_user_id  UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  PRIMARY KEY (message_id, mentioned_user_id)
);
CREATE INDEX IF NOT EXISTS message_mentions_user_idx ON message_mentions(mentioned_user_id);

-- Per-integration tokens/config (Meta page/IG/WhatsApp). Service-role only.
CREATE TABLE IF NOT EXISTS external_accounts (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider            TEXT NOT NULL CHECK (provider IN ('whatsapp','messenger','instagram')),
  label               TEXT,
  page_id             TEXT,
  ig_account_id       TEXT,
  waba_id             TEXT,
  phone_number_id     TEXT,
  access_token        TEXT,
  webhook_verify_token TEXT,
  status              TEXT NOT NULL DEFAULT 'active',
  expires_at          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

-- Bump conversations.last_message_at on new message (keeps list ordering live).
CREATE OR REPLACE FUNCTION touch_conversation_last_message()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE conversations SET last_message_at = NEW.created_at WHERE id = NEW.conversation_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_msg_touches_conversation ON conversation_messages;
CREATE TRIGGER trg_msg_touches_conversation
  AFTER INSERT ON conversation_messages
  FOR EACH ROW EXECUTE FUNCTION touch_conversation_last_message();

-- ── Recursion-safe membership / visibility helpers (SECURITY DEFINER) ──

CREATE OR REPLACE FUNCTION public.is_conversation_member(conv UUID, uid UUID)
RETURNS BOOLEAN LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM conversation_participants p
    WHERE p.conversation_id = conv AND p.user_id = uid
  );
$$;

CREATE OR REPLACE FUNCTION public.can_see_conversation(conv UUID, uid UUID)
RETURNS BOOLEAN LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM conversations c WHERE c.id = conv AND (
      (c.type = 'channel' AND c.is_private = FALSE)
      OR public.is_conversation_member(conv, uid)
      OR (c.type = 'customer' AND EXISTS (
            SELECT 1 FROM user_profiles up WHERE up.id = uid AND up.role IN ('admin','manager','sales')
         ))
    )
  );
$$;

-- ── RLS (SELECT-only for authenticated; writes via service-role) ──────

ALTER TABLE conversations            ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_messages    ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_reactions        ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_attachments      ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_mentions         ENABLE ROW LEVEL SECURITY;
ALTER TABLE external_accounts        ENABLE ROW LEVEL SECURITY;  -- no policy = service-role only

DROP POLICY IF EXISTS conv_select ON conversations;
CREATE POLICY conv_select ON conversations FOR SELECT TO authenticated
  USING (public.can_see_conversation(id, auth.uid()));

DROP POLICY IF EXISTS conv_part_select ON conversation_participants;
CREATE POLICY conv_part_select ON conversation_participants FOR SELECT TO authenticated
  USING (public.can_see_conversation(conversation_id, auth.uid()));

DROP POLICY IF EXISTS conv_msg_select ON conversation_messages;
CREATE POLICY conv_msg_select ON conversation_messages FOR SELECT TO authenticated
  USING (public.can_see_conversation(conversation_id, auth.uid()));

DROP POLICY IF EXISTS msg_react_select ON message_reactions;
CREATE POLICY msg_react_select ON message_reactions FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM conversation_messages m
                 WHERE m.id = message_id AND public.can_see_conversation(m.conversation_id, auth.uid())));

DROP POLICY IF EXISTS msg_attach_select ON message_attachments;
CREATE POLICY msg_attach_select ON message_attachments FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM conversation_messages m
                 WHERE m.id = message_id AND public.can_see_conversation(m.conversation_id, auth.uid())));

DROP POLICY IF EXISTS msg_mention_select ON message_mentions;
CREATE POLICY msg_mention_select ON message_mentions FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM conversation_messages m
                 WHERE m.id = message_id AND public.can_see_conversation(m.conversation_id, auth.uid())));

-- ── Realtime: deliver inserts/updates to subscribed authenticated clients.
--    RLS above is enforced per-subscriber. REPLICA IDENTITY FULL so update
--    payloads carry the full row (edits, deletes, read-state). Idempotent.

ALTER TABLE conversations         REPLICA IDENTITY FULL;
ALTER TABLE conversation_messages REPLICA IDENTITY FULL;
ALTER TABLE message_reactions     REPLICA IDENTITY FULL;
ALTER TABLE conversation_participants REPLICA IDENTITY FULL;

DO $$
DECLARE t TEXT;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    FOREACH t IN ARRAY ARRAY['conversations','conversation_messages','message_reactions','conversation_participants'] LOOP
      IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename=t
      ) THEN
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
      END IF;
    END LOOP;
  END IF;
END $$;

-- ── Storage bucket for attachments (private; staff-only access) ───────

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('chat-attachments', 'chat-attachments', false, 26214400, NULL)  -- 25 MB, any type
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit;

DROP POLICY IF EXISTS chat_attach_read   ON storage.objects;
DROP POLICY IF EXISTS chat_attach_write  ON storage.objects;
DROP POLICY IF EXISTS chat_attach_delete ON storage.objects;

-- Authenticated staff can read (for createSignedUrl) and upload. Paths are
-- unguessable UUIDs under conversation-id folders. (Customer-data hardening
-- to signed-url-only is a later phase.)
CREATE POLICY chat_attach_read ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'chat-attachments');
CREATE POLICY chat_attach_write ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'chat-attachments');
CREATE POLICY chat_attach_delete ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'chat-attachments');
