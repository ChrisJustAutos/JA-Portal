-- ═══════════════════════════════════════════════════════════════════
-- 064_messaging_perf.sql
-- Status: apply to Supabase project qtiscbvhlvdvafwtdtcd, then this file
-- is kept here for reference / disaster recovery.
--
-- Messaging performance pass:
--   1. messaging_unread_counts(): one GROUP BY query replacing the
--      one-count-query-per-conversation N+1 in /api/conversations and
--      /api/messages/unread (the latter is polled by the top bar on every
--      portal page every 30s, so this is the hottest query in the platform).
--   2. message_reactions.conversation_id: denormalised so the client's
--      Realtime subscription can filter reactions to the open conversation
--      instead of receiving every reaction in the workspace. Backfilled and
--      kept current by a BEFORE INSERT trigger (API code unchanged).
-- ═══════════════════════════════════════════════════════════════════

-- ── 1. Unread counts in a single query ───────────────────────────────
-- Per-conversation unread for one user: non-own, non-deleted messages after
-- last_read_at. Matches the previous API semantics exactly — note
-- `sender_user_id <> p_user_id` is NULL (excluded) for system/external
-- messages, same as PostgREST .neq(). Conversations with zero unread are
-- simply absent from the result. Called with the service-role key.
CREATE OR REPLACE FUNCTION public.messaging_unread_counts(p_user_id UUID)
RETURNS TABLE (conversation_id UUID, muted BOOLEAN, unread BIGINT)
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT p.conversation_id, p.muted, COUNT(m.id)::BIGINT AS unread
  FROM conversation_participants p
  JOIN conversation_messages m
    ON m.conversation_id = p.conversation_id
   AND m.deleted_at IS NULL
   AND m.sender_user_id <> p_user_id
   AND (p.last_read_at IS NULL OR m.created_at > p.last_read_at)
  WHERE p.user_id = p_user_id
  GROUP BY p.conversation_id, p.muted;
$$;

-- ── 2. Reaction events filterable per conversation ───────────────────
ALTER TABLE message_reactions ADD COLUMN IF NOT EXISTS conversation_id UUID;

UPDATE message_reactions r
SET conversation_id = m.conversation_id
FROM conversation_messages m
WHERE m.id = r.message_id AND r.conversation_id IS NULL;

CREATE OR REPLACE FUNCTION public.set_reaction_conversation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.conversation_id IS NULL THEN
    SELECT conversation_id INTO NEW.conversation_id
    FROM conversation_messages WHERE id = NEW.message_id;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_reaction_conversation ON message_reactions;
CREATE TRIGGER trg_reaction_conversation
  BEFORE INSERT ON message_reactions
  FOR EACH ROW EXECUTE FUNCTION public.set_reaction_conversation();
