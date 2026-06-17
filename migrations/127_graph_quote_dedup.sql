-- 127_graph_quote_dedup.sql
-- Pipeline A (Outlook → quote → ActiveCampaign/Monday) was counting a single
-- quote email as multiple "contact attempts". Three overlapping causes, all
-- keyed off the volatile Graph message id / per-subscription dedup:
--   1. Each rep mailbox had TWO Graph subscriptions (Inbox-only + whole-mailbox)
--      → same email, two subscription ids → old dedup (subscription_id, message_id)
--      didn't recognise it.
--   2. An Outlook rule moving the mail into a subfolder gives it a NEW Graph
--      message id → processed again ("inbox AND the sub folder").
--   3. Graph occasionally redelivers a notification within the ~10s pipeline
--      window → the read-then-write idempotency check let both through.
--
-- Fix: dedup on the RFC 5322 internetMessageId (stable across folder moves and
-- identical for every copy/redelivery of one physical email) via an ATOMIC
-- claim — insert-on-conflict before the pipeline runs, so the race can't admit
-- two. A row here means "this email has already been counted".
create table if not exists public.graph_quote_dedup (
  dedup_key        text primary key,   -- internetMessageId (fallback: sub:msgid)
  mailbox          text,
  subscription_id  text,
  graph_message_id text,
  quote_number     text,
  claimed_at       timestamptz not null default now()
);
