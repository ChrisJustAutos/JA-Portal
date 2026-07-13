-- 159_call_concerns_channel_post.sql
-- Store the human-voice channel post so Mark-actioned can rebuild the root
-- message (✅-prefixed) without needing to read it back from Slack.
alter table call_concerns add column if not exists channel_post text;
