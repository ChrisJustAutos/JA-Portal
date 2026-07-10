-- 155_call_concerns.sql
-- Negative-call automation: a second analysis pass flags complaint / concern /
-- support calls, posts them (with MD job history) to the negative Slack
-- channel, and a follow-up sweep nudges the advisor + emails Matt if the
-- customer hasn't been contacted within CONCERN_FOLLOWUP_DAYS (default 3).
--
--   • calls.concern_checked_at — stamp so every transcribed call is examined
--     exactly once (rows with no concern get the stamp and nothing else).
--   • call_concerns — one row per flagged call; drives the Slack card and the
--     follow-up state machine.

alter table calls add column if not exists concern_checked_at timestamptz;

create table if not exists call_concerns (
  id                      uuid primary key default gen_random_uuid(),
  call_id                 uuid not null unique references calls(id) on delete cascade,
  category                text not null check (category in ('complaint','concern','support')),
  severity                text not null default 'medium' check (severity in ('low','medium','high')),
  summary                 text not null,
  action_items            jsonb not null default '[]'::jsonb,
  -- caller → customer linkage (best-effort; null when no match)
  customer_phone          text,
  customer_name           text,
  customer_email          text,
  workshop_customer_id    uuid,
  md_customer_id          text,
  -- who took the call (for the nudge tag)
  advisor_name            text,
  advisor_slack_user_id   text,
  -- Slack card
  slack_channel           text,
  slack_ts                text,
  -- follow-up state machine
  followup_due_at         timestamptz not null,
  followup_status         text not null default 'pending'
                          check (followup_status in ('pending','contact_detected','nudging','actioned','dismissed')),
  followup_note           text,
  last_nudge_at           timestamptz,
  matt_emailed_at         timestamptz,
  actioned_by             text,
  actioned_at             timestamptz,
  detected_at             timestamptz not null default now(),
  created_at              timestamptz not null default now()
);

create index if not exists call_concerns_followup on call_concerns (followup_status, followup_due_at);
create index if not exists call_concerns_detected on call_concerns (detected_at desc);

comment on table call_concerns is 'Complaint/concern/support calls flagged by the concern sweep (lib/call-concerns.ts); Slack card in the negative channel + 3-day follow-up nudges.';
