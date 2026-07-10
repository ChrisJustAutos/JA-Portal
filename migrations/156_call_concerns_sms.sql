-- 156_call_concerns_sms.sql
-- Human-approved acknowledgement SMS on concern cards: an "Approve text to
-- customer" button on the Slack card sends a ClickSend SMS once, on click.
alter table call_concerns add column if not exists sms_sent_at timestamptz;
alter table call_concerns add column if not exists sms_approved_by text;
alter table call_concerns add column if not exists sms_message_id text;
