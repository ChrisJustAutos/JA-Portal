-- 153_workshop_map_display_numbers.sql
--
-- md_invoices/md_quotes primary keys are MD internal ids (the human invoice/
-- quote numbers can collide across MD's POS vs workshop numbering series);
-- keep the human-facing number separately for display in popups.

alter table md_invoices add column if not exists display_number text;
alter table md_quotes   add column if not exists display_number text;
