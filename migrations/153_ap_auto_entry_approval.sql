-- 153_ap_auto_entry_approval.sql
--
-- Human-in-the-loop approval for flagged AP invoices: the Slack flag card
-- carries an "Approve & post to MYOB" button; the click marks the log row
-- approved and the invoice posts immediately (soft checks bypassed — a human
-- vouched). approved_at doubles as the idempotency marker.

alter table ap_auto_entry_log
  add column if not exists approved_by text,
  add column if not exists approved_at timestamptz;
