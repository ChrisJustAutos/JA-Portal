-- 149_slack_ephemeral_messages.sql
--
-- Auto-delete queue for the parts bot. To keep the parts channel clear, every
-- bot answer is enqueued here with a delete_at (default now + 5 min); a cron
-- (/api/cron/slack-cleanup, every minute) chat.delete's the due ones. Serverless
-- can't sleep for 5 min, so a small queue + cron is the reliable way.

create table if not exists slack_ephemeral_messages (
  id         uuid primary key default gen_random_uuid(),
  channel    text not null,
  ts         text not null,
  delete_at  timestamptz not null,
  deleted    boolean not null default false,
  created_at timestamptz not null default now()
);

-- Fast "what's due and not yet deleted" scan for the sweeper.
create index if not exists slack_ephemeral_due_idx
  on slack_ephemeral_messages (delete_at) where not deleted;

alter table slack_ephemeral_messages enable row level security;
