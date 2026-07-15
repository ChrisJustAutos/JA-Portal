-- 163: Slack "Create supplier" flow on AP flag cards.
-- Stores the vendor details extracted from the invoice PDF when a human clicks
-- "Create supplier" on a supplier-not-mapped flag card, so the follow-up
-- "Create supplier & post bill" approval creates exactly what was reviewed in
-- the thread (not a fresh extraction that could differ).
alter table ap_auto_entry_log
  add column if not exists proposed_supplier jsonb;

comment on column ap_auto_entry_log.proposed_supplier is
  'Vendor details proposed for MYOB supplier-card creation (name, abn, email, phone, website, address, taxCode) — reviewed + approved via the Slack thread';
