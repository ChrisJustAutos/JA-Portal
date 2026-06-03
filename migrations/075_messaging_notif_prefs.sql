-- 075_messaging_notif_prefs.sql
-- Per-user message notification controls: an "away" status and a working-hours
-- window outside which message alerts (push + sound + desktop pop-up) are
-- silenced. The bell entry/badge is still recorded — only the active alert is
-- suppressed (Slack-style Do-Not-Disturb). Evaluated against the user's existing
-- `timezone` preference. Days: 0=Sun … 6=Sat (default Mon–Fri).

alter table public.user_preferences
  add column if not exists messages_away          boolean not null default false,
  add column if not exists messages_quiet_enabled boolean not null default false,
  add column if not exists messages_work_start     text    not null default '08:00',
  add column if not exists messages_work_end       text    not null default '17:00',
  add column if not exists messages_work_days       int[]   not null default '{1,2,3,4,5}';
